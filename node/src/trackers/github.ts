import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Issue,
  IssueMutation,
  PublishedChange,
  PublishChangeInput,
  Tracker,
} from "../domain.js";
import { publishGitBranch } from "../publish/git.js";

const DEFAULT_ENDPOINT = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const ISSUE_NUMBER = /^[1-9]\d*$/;
const MAX_COMMENT_LENGTH = 65_536;
const MAX_LABEL_LENGTH = 50;
const MAX_COMMIT_MESSAGE_LENGTH = 200;
const MAX_PULL_REQUEST_TITLE_LENGTH = 256;
const MAX_PULL_REQUEST_BODY_LENGTH = 65_536;
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMENT_MARKER_PREFIX = "<!-- symphony-comment:";

const githubIssueSchema = z
  .object({
    number: z.number().int().positive().safe(),
    title: z.string().trim().min(1),
    body: z.string().nullable().optional(),
    state: z.enum(["open", "closed"]),
    html_url: z.string().url().nullable().optional(),
    assignee: z
      .object({ login: z.string().trim().min(1) })
      .passthrough()
      .nullable()
      .optional(),
    labels: z
      .array(
        z.union([
          z.string(),
          z.object({ name: z.string().nullable().optional() }).passthrough(),
        ]),
      )
      .optional(),
    created_at: z.string().datetime({ offset: true }).nullable().optional(),
    updated_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .passthrough();

const githubPullRequestSchema = z
  .object({
    number: z.number().int().positive().safe(),
    html_url: z.string().url(),
  })
  .passthrough();

const githubCommentSchema = z
  .object({
    id: z.number().int().positive().safe(),
    body: z.string(),
  })
  .passthrough();

type FetchLike = typeof globalThis.fetch;
type GitPublisher = typeof publishGitBranch;
type GitHubState = "open" | "closed";

interface GitHubSettings {
  owner: string;
  repo: string;
  endpoint: string;
  token: string | undefined;
  baseBranch: string | undefined;
  gitUrl: string | undefined;
}

interface GitHubResponse {
  payload: unknown;
  link: string | null;
  status: number;
}

interface GitHubRequestOptions {
  method?: "POST" | "PATCH" | "DELETE";
  payload?: Record<string, unknown>;
  signal?: AbortSignal;
  parseResponse?: boolean;
  allowStatus?: number;
}

interface GitHubRestMutationRequest {
  kind: "request";
  method: "POST" | "PATCH" | "DELETE";
  suffix: string;
  payload?: Record<string, unknown>;
}

interface GitHubIdempotentCommentRequest {
  kind: "idempotent_comment";
  body: string;
  marker: string;
}

type GitHubMutationRequest = GitHubRestMutationRequest | GitHubIdempotentCommentRequest;

interface ValidPublishInput {
  commitMessage: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export class GitHubTracker implements Tracker {
  readonly #settings: GitHubSettings;
  readonly #fetch: FetchLike;
  readonly #publishGitBranch: GitPublisher;

  constructor(
    provider: Record<string, unknown>,
    fetchImpl: FetchLike = globalThis.fetch,
    gitPublisher: GitPublisher = publishGitBranch,
  ) {
    this.#settings = parseSettings(provider);
    this.#fetch = fetchImpl;
    this.#publishGitBranch = gitPublisher;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const requested = normalizeStates(states);
    if (requested.size === 0) return [];

    const state = requested.size === 2 ? "all" : [...requested][0];
    const issues: Issue[] = [];
    const expectedUrl = this.#issuesUrl();
    const visited = new Set<string>();
    let url = pageUrl(expectedUrl, state ?? "all", 1);

    for (;;) {
      if (visited.has(url.href)) {
        throw new Error(`GitHub pagination Link loop detected for GET ${url.pathname}`);
      }
      visited.add(url.href);

      const response = await this.#request(url, false);
      const payload = response.payload;
      if (!Array.isArray(payload)) {
        throw new Error(`GitHub API GET ${url.pathname} returned a non-array issue list`);
      }

      for (const raw of payload) {
        const issue = normalizeIssue(raw, this.#settings, url.pathname);
        if (issue && requested.has(issue.state as GitHubState)) issues.push(issue);
      }

      const linkedPage = nextPageUrl(response.link, url, expectedUrl);
      if (linkedPage !== null) {
        url = linkedPage;
        continue;
      }

      const fallbackPage = response.link === null && payload.length === PAGE_SIZE
        ? incrementPage(url)
        : null;
      if (fallbackPage === null) return issues;
      url = fallbackPage;
    }
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const uniqueIds = validateIssueIds(ids);
    const issues: Issue[] = [];

    for (const id of uniqueIds) {
      const url = this.#issuesUrl(id);
      const response = await this.#request(url, true);
      if (response === undefined) continue;

      const issue = normalizeIssue(response.payload, this.#settings, url.pathname);
      if (!issue) continue;
      if (issue.id !== id) {
        throw new Error(`GitHub API GET ${url.pathname} returned issue ${issue.id} instead of ${id}`);
      }
      issues.push(issue);
    }

    return issues;
  }

  async mutateIssue(issue: Issue, mutation: IssueMutation, signal: AbortSignal): Promise<void> {
    const issueNumber = bindIssue(issue, this.#settings);
    const request = mutationRequest(mutation);
    if (this.#settings.token === undefined) {
      throw new Error("GitHub issue mutations require an authentication token");
    }

    if (request.kind === "idempotent_comment") {
      await this.#upsertIssueComment(issueNumber, request.body, request.marker, signal);
      return;
    }

    const issueUrl = this.#issuesUrl(issueNumber);
    const url = new URL(`${issueUrl.href}${request.suffix}`);
    await this.#request(url, false, {
      method: request.method,
      ...(request.payload === undefined ? {} : { payload: request.payload }),
      signal,
      parseResponse: false,
    });
  }

  async #upsertIssueComment(
    issueNumber: string,
    body: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<void> {
    const commentsUrl = this.#commentsUrl(issueNumber);
    const visited = new Set<string>();
    let url = commentPageUrl(commentsUrl, 1);
    let match: number | null = null;

    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      if (visited.has(url.href)) {
        throw new Error(`GitHub issue comment pagination Link loop detected for GET ${url.pathname}`);
      }
      visited.add(url.href);

      const response = await this.#request(url, false, { signal });
      if (!Array.isArray(response.payload)) {
        throw new Error(`GitHub API GET ${url.pathname} returned a non-array issue comment list`);
      }

      for (const raw of response.payload) {
        const parsed = githubCommentSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`GitHub API GET ${url.pathname} returned an invalid issue comment`);
        }
        const comment = parsed.data;
        if (!comment.body.includes(marker)) continue;
        match = match === null ? comment.id : Math.min(match, comment.id);
      }

      const linkedPage = nextPageUrl(
        response.link,
        url,
        commentsUrl,
        "repository issue comments",
      );
      const next = linkedPage === null
        ? response.link === null && response.payload.length === PAGE_SIZE
          ? incrementPage(url)
          : null
        : validateNextCommentPage(linkedPage, url);
      if (next === null) break;
      if (page === MAX_COMMENT_PAGES) {
        throw new Error(`GitHub issue comment pagination exceeded ${MAX_COMMENT_PAGES} pages`);
      }
      url = next;
    }

    const target = match === null ? commentsUrl : this.#commentUrl(match);
    await this.#request(target, false, {
      method: match === null ? "POST" : "PATCH",
      payload: { body },
      signal,
      parseResponse: false,
    });
  }

  async publishIssueChange(
    issue: Issue,
    workspacePath: string,
    input: PublishChangeInput,
    signal: AbortSignal,
  ): Promise<PublishedChange> {
    const issueNumber = bindIssue(issue, this.#settings);
    const publishInput = validatePublishInput(input);
    if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
      throw new Error("GitHub publishing requires a workspace path");
    }
    const token = this.#settings.token;
    if (token === undefined) {
      throw new Error("GitHub publishing requires an authentication token");
    }

    const branch = `symphony/issue-${issueNumber}`;
    const pushUrl = repositoryGitUrl(this.#settings);
    const pullRequestHost = new URL(pushUrl).hostname;
    if (signal.aborted) throw new Error("GitHub git publishing was aborted");
    let published: Awaited<ReturnType<GitPublisher>>;
    try {
      published = await this.#publishGitBranch({
        workspacePath,
        expectedOwner: this.#settings.owner,
        expectedRepo: this.#settings.repo,
        expectedHost: new URL(pushUrl).host,
        pushUrl,
        token,
        branch,
        ...(this.#settings.baseBranch === undefined
          ? {}
          : { baseBranch: this.#settings.baseBranch }),
        commitMessage: publishInput.commitMessage,
        signal,
      });
    } catch {
      if (signal.aborted) throw new Error("GitHub git publishing was aborted");
      throw new Error("GitHub git publishing failed");
    }
    const baseBranch = publishedBaseBranch(published, branch);

    const pullPayload = {
      title: publishInput.pullRequestTitle,
      body: publishInput.pullRequestBody,
    };
    const updatePull = async (number: number): Promise<PublishedChange> => {
      const url = this.#pullsUrl(number);
      const response = await this.#request(url, false, {
        method: "PATCH",
        payload: pullPayload,
        signal,
      });
      const pull = parsePullRequest(response.payload, "PATCH", url.pathname, pullRequestHost);
      if (pull.number !== number) {
        throw new Error(`GitHub API PATCH ${url.pathname} returned a different pull request`);
      }
      return { ...pull, branch };
    };

    const existing = await this.#findOpenPull(branch, baseBranch, pullRequestHost, signal);
    if (existing !== null) return updatePull(existing.number);

    const url = this.#pullsUrl();
    const created = await this.#request(url, false, {
      method: "POST",
      payload: { ...pullPayload, head: branch, base: baseBranch },
      signal,
      allowStatus: 422,
    });
    if (created.status === 422) {
      const raced = await this.#findOpenPull(branch, baseBranch, pullRequestHost, signal);
      if (raced === null) {
        throw new Error(`GitHub API POST ${url.pathname} failed with HTTP 422`);
      }
      return updatePull(raced.number);
    }

    const pull = parsePullRequest(created.payload, "POST", url.pathname, pullRequestHost);
    return { ...pull, branch };
  }

  #issuesUrl(issueNumber?: string): URL {
    const { endpoint, owner, repo } = this.#settings;
    const suffix = issueNumber === undefined ? "" : `/${issueNumber}`;
    return new URL(
      `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${suffix}`,
    );
  }

  #pullsUrl(pullNumber?: number): URL {
    const { endpoint, owner, repo } = this.#settings;
    const suffix = pullNumber === undefined ? "" : `/${pullNumber}`;
    return new URL(
      `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${suffix}`,
    );
  }

  #commentsUrl(issueNumber: string): URL {
    return new URL(`${this.#issuesUrl(issueNumber).href}/comments`);
  }

  #commentUrl(commentId: number): URL {
    const { endpoint, owner, repo } = this.#settings;
    return new URL(
      `${endpoint}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
    );
  }

  async #findOpenPull(
    branch: string,
    baseBranch: string,
    pullRequestHost: string,
    signal: AbortSignal,
  ): Promise<{ number: number; url: string } | null> {
    const url = this.#pullsUrl();
    url.search = new URLSearchParams({
      state: "open",
      head: `${this.#settings.owner}:${branch}`,
      base: baseBranch,
      per_page: String(PAGE_SIZE),
    }).toString();
    const response = await this.#request(url, false, { signal });
    if (!Array.isArray(response.payload)) {
      throw new Error(`GitHub API GET ${url.pathname} returned a non-array pull request list`);
    }
    if (response.payload.length > 1) {
      throw new Error(`GitHub API GET ${url.pathname} returned multiple matching pull requests`);
    }
    return response.payload.length === 0
      ? null
      : parsePullRequest(response.payload[0], "GET", url.pathname, pullRequestHost);
  }

  #request(url: URL, allowNotFound: false, options?: GitHubRequestOptions): Promise<GitHubResponse>;
  #request(url: URL, allowNotFound: true, options?: GitHubRequestOptions): Promise<GitHubResponse | undefined>;
  async #request(
    url: URL,
    allowNotFound: boolean,
    options: GitHubRequestOptions = {},
  ): Promise<GitHubResponse | undefined> {
    const method = options.method ?? "GET";
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
    if (options.signal?.aborted) {
      throw new Error(`GitHub API ${method} ${url.pathname} was aborted`);
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        redirect: "error",
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ai-symphony-node",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(options.payload === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.#settings.token === undefined
            ? {}
            : { Authorization: `Bearer ${this.#settings.token}` }),
        },
        ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
      });
    } catch {
      if (options.signal?.aborted) {
        throw new Error(`GitHub API ${method} ${url.pathname} was aborted`);
      }
      if (timeoutSignal.aborted) {
        throw new Error(`GitHub API ${method} ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new Error(`GitHub API ${method} ${url.pathname} failed`);
    }

    if (allowNotFound && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (options.allowStatus === response.status) {
      await response.body?.cancel().catch(() => undefined);
      return { payload: null, link: null, status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub API ${method} ${url.pathname} failed with HTTP ${response.status}`);
    }
    if (options.parseResponse === false) {
      await response.body?.cancel().catch(() => undefined);
      return { payload: null, link: null, status: response.status };
    }

    try {
      return {
        payload: await response.json(),
        link: nonBlank(response.headers.get("link") ?? undefined) ?? null,
        status: response.status,
      };
    } catch {
      if (options.signal?.aborted) {
        throw new Error(`GitHub API ${method} ${url.pathname} was aborted`);
      }
      if (timeoutSignal.aborted) {
        throw new Error(`GitHub API ${method} ${url.pathname} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new Error(`GitHub API ${method} ${url.pathname} returned invalid JSON`);
    }
  }
}

function bindIssue(issue: Issue, settings: GitHubSettings): string {
  const candidate: unknown = issue;
  if (!isRecord(candidate) || typeof candidate.id !== "string" || !ISSUE_NUMBER.test(candidate.id)) {
    throw new Error("GitHub mutation issue must have a positive decimal id");
  }

  const nativeRef = candidate.nativeRef;
  if (
    !isRecord(nativeRef) ||
    nativeRef.owner !== settings.owner ||
    nativeRef.repo !== settings.repo ||
    typeof nativeRef.number !== "number" ||
    !Number.isSafeInteger(nativeRef.number) ||
    nativeRef.number <= 0 ||
    String(nativeRef.number) !== candidate.id
  ) {
    throw new Error("GitHub mutation issue is not bound to the configured repository and issue id");
  }
  return candidate.id;
}

function mutationRequest(mutation: IssueMutation): GitHubMutationRequest {
  const candidate: unknown = mutation;
  if (!isRecord(candidate) || typeof candidate.kind !== "string") {
    throw new Error("Invalid GitHub issue mutation");
  }

  switch (candidate.kind) {
    case "comment": {
      if (
        typeof candidate.body !== "string" ||
        candidate.body.trim() === "" ||
        candidate.body.length > MAX_COMMENT_LENGTH
      ) {
        throw new Error(`GitHub issue comment must be 1-${MAX_COMMENT_LENGTH} characters`);
      }
      if (candidate.idempotencyKey === undefined) {
        return {
          kind: "request",
          method: "POST",
          suffix: "/comments",
          payload: { body: candidate.body },
        };
      }
      if (
        typeof candidate.idempotencyKey !== "string" ||
        !IDEMPOTENCY_KEY.test(candidate.idempotencyKey)
      ) {
        throw new Error("GitHub issue comment idempotency key must be a random UUID");
      }
      const digest = createHash("sha256").update(candidate.idempotencyKey).digest("hex");
      const marker = `${COMMENT_MARKER_PREFIX}${digest} -->`;
      const body = `${candidate.body}\n\n${marker}`;
      if (body.length > MAX_COMMENT_LENGTH) {
        throw new Error(
          `GitHub issue comment including its idempotency marker must be at most ${MAX_COMMENT_LENGTH} characters`,
        );
      }
      return { kind: "idempotent_comment", body, marker };
    }
    case "add_label":
    case "remove_label": {
      if (
        typeof candidate.label !== "string" ||
        candidate.label.trim() === "" ||
        candidate.label.trim().length > MAX_LABEL_LENGTH
      ) {
        throw new Error(`GitHub issue label must be 1-${MAX_LABEL_LENGTH} characters`);
      }
      const label = candidate.label.trim();
      return candidate.kind === "add_label"
        ? { kind: "request", method: "POST", suffix: "/labels", payload: { labels: [label] } }
        : { kind: "request", method: "DELETE", suffix: `/labels/${encodeURIComponent(label)}` };
    }
    case "set_state": {
      if (typeof candidate.state !== "string") {
        throw new Error("GitHub issue state must be open or closed");
      }
      const state = candidate.state.trim().toLowerCase();
      if (state !== "open" && state !== "closed") {
        throw new Error("GitHub issue state must be open or closed");
      }
      return { kind: "request", method: "PATCH", suffix: "", payload: { state } };
    }
    default:
      throw new Error("Unsupported GitHub issue mutation");
  }
}

function validatePublishInput(input: PublishChangeInput): ValidPublishInput {
  const candidate: unknown = input;
  if (
    !isRecord(candidate) ||
    typeof candidate.commitMessage !== "string" ||
    candidate.commitMessage.trim() === "" ||
    candidate.commitMessage.trim().length > MAX_COMMIT_MESSAGE_LENGTH
  ) {
    throw new Error(`GitHub publish commit message must be 1-${MAX_COMMIT_MESSAGE_LENGTH} characters`);
  }
  if (
    typeof candidate.pullRequestTitle !== "string" ||
    candidate.pullRequestTitle.trim() === "" ||
    candidate.pullRequestTitle.trim().length > MAX_PULL_REQUEST_TITLE_LENGTH
  ) {
    throw new Error(`GitHub pull request title must be 1-${MAX_PULL_REQUEST_TITLE_LENGTH} characters`);
  }
  if (
    typeof candidate.pullRequestBody !== "string" ||
    candidate.pullRequestBody.length > MAX_PULL_REQUEST_BODY_LENGTH
  ) {
    throw new Error(`GitHub pull request body must be at most ${MAX_PULL_REQUEST_BODY_LENGTH} characters`);
  }
  return {
    commitMessage: candidate.commitMessage.trim(),
    pullRequestTitle: candidate.pullRequestTitle.trim(),
    pullRequestBody: candidate.pullRequestBody,
  };
}

function parsePullRequest(
  raw: unknown,
  method: string,
  path: string,
  expectedHost: string,
): { number: number; url: string } {
  const parsed = githubPullRequestSchema.safeParse(raw);
  if (!parsed.success || !isExpectedPullRequestUrl(parsed.data.html_url, expectedHost)) {
    throw new Error(`GitHub API ${method} ${path} returned an invalid pull request`);
  }
  return { number: parsed.data.number, url: parsed.data.html_url };
}

function isExpectedPullRequestUrl(value: string, expectedHost: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === expectedHost.toLowerCase() &&
    url.username === "" &&
    url.password === ""
  );
}

function repositoryGitUrl(settings: GitHubSettings): string {
  if (settings.gitUrl !== undefined) return settings.gitUrl;
  if (settings.endpoint !== DEFAULT_ENDPOINT) {
    throw new Error("GitHub publishing with a custom API endpoint requires provider.git_url");
  }
  return `https://github.com/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}.git`;
}

function publishedBaseBranch(
  published: Awaited<ReturnType<GitPublisher>>,
  expectedBranch: string,
): string {
  if (
    !isRecord(published) ||
    published.branch !== expectedBranch ||
    typeof published.baseBranch !== "string" ||
    published.baseBranch.trim() === "" ||
    published.baseBranch.length > 255 ||
    /[\0-\x20\x7f]/.test(published.baseBranch)
  ) {
    throw new Error("Git publisher returned an invalid branch result");
  }
  return published.baseBranch;
}

function parseSettings(provider: Record<string, unknown>): GitHubSettings {
  const unknownKeys = Object.keys(provider).filter(
    (key) => !["owner", "repo", "endpoint", "token", "base_branch", "git_url"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported GitHub tracker provider option(s): ${unknownKeys.sort().join(", ")}`);
  }

  const owner = repositorySegment(provider.owner, "owner");
  const repo = repositorySegment(provider.repo, "repo");
  const endpoint = normalizeEndpoint(provider.endpoint);
  const token = resolveToken(provider.token, endpoint);
  const baseBranch = optionalBranch(provider.base_branch);
  const gitUrl = optionalGitUrl(provider.git_url, owner, repo);
  if (token !== undefined && new URL(endpoint).protocol !== "https:") {
    throw new Error("GitHub tracker refuses to send a token over a non-HTTPS endpoint");
  }
  return { owner, repo, endpoint, token, baseBranch, gitUrl };
}

function optionalBranch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("GitHub tracker provider.base_branch must be a non-empty branch name");
  }
  const branch = value.trim();
  if (branch === "" || branch.length > 255 || /[\0-\x20\x7f]/.test(branch)) {
    throw new Error("GitHub tracker provider.base_branch must be a non-empty branch name");
  }
  return branch;
}

function optionalGitUrl(value: unknown, owner: string, repo: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("GitHub tracker provider.git_url must be a safe HTTPS repository URL");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("GitHub tracker provider.git_url must be a safe HTTPS repository URL");
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("GitHub tracker provider.git_url must be a safe HTTPS repository URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (path !== `/${owner}/${repo}` && path !== `/${owner}/${repo}.git`)
  ) {
    throw new Error("GitHub tracker provider.git_url must be a safe HTTPS repository URL for the configured repository");
  }
  return url.href;
}

function repositorySegment(value: unknown, name: "owner" | "repo"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`GitHub tracker provider.${name} must be a non-empty string`);
  }
  const segment = value.trim();
  if (!REPOSITORY_SEGMENT.test(segment)) {
    throw new Error(`GitHub tracker provider.${name} must contain only letters, numbers, '.', '_', or '-'`);
  }
  return segment;
}

function normalizeEndpoint(value: unknown): string {
  const raw = value ?? DEFAULT_ENDPOINT;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("GitHub tracker provider.endpoint must be an HTTP(S) URL");
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("GitHub tracker provider.endpoint must be an HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("GitHub tracker provider.endpoint must be an HTTP(S) URL without credentials, query, or fragment");
  }

  return url.toString().replace(/\/+$/, "");
}

function resolveToken(value: unknown, endpoint: string): string | undefined {
  if (value === undefined) {
    return endpoint === DEFAULT_ENDPOINT ? nonBlank(process.env.GITHUB_TOKEN) : undefined;
  }
  if (typeof value !== "string") {
    throw new Error("GitHub tracker provider.token must be an environment reference such as $GITHUB_TOKEN");
  }

  const match = ENV_REFERENCE.exec(value.trim());
  if (!match?.[1]) {
    throw new Error("GitHub tracker provider.token must be an environment reference such as $GITHUB_TOKEN");
  }
  const token = nonBlank(process.env[match[1]]);
  if (token === undefined) {
    throw new Error(`GitHub token environment variable ${match[1]} is not set`);
  }
  return token;
}

function pageUrl(base: URL, state: "open" | "closed" | "all", page: number): URL {
  const url = new URL(base);
  url.search = new URLSearchParams({
    state,
    per_page: String(PAGE_SIZE),
    page: String(page),
    sort: "created",
    direction: "asc",
  }).toString();
  return url;
}

function commentPageUrl(base: URL, page: number): URL {
  const url = new URL(base);
  url.search = new URLSearchParams({
    per_page: String(PAGE_SIZE),
    page: String(page),
  }).toString();
  return url;
}

function validateNextCommentPage(next: URL, current: URL): URL {
  const pages = next.searchParams.getAll("page");
  const pageSizes = next.searchParams.getAll("per_page");
  const keys = [...next.searchParams.keys()];
  const currentPage = current.searchParams.get("page");
  if (
    pages.length !== 1 ||
    pageSizes.length !== 1 ||
    keys.some((key) => key !== "page" && key !== "per_page") ||
    !ISSUE_NUMBER.test(pages[0] ?? "") ||
    pageSizes[0] !== String(PAGE_SIZE) ||
    currentPage === null ||
    Number(pages[0]) !== Number(currentPage) + 1
  ) {
    throw new Error("GitHub issue comment pagination Link must advance by one 100-comment page");
  }
  return next;
}

function incrementPage(current: URL): URL | null {
  const page = current.searchParams.get("page");
  if (page === null || !ISSUE_NUMBER.test(page)) return null;
  const number = Number(page);
  if (!Number.isSafeInteger(number) || number === Number.MAX_SAFE_INTEGER) return null;

  const next = new URL(current);
  next.searchParams.set("page", String(number + 1));
  return next;
}

function nextPageUrl(
  link: string | null,
  current: URL,
  expected: URL,
  resource = "repository issues",
): URL | null {
  if (link === null) return null;

  let next: URL | null = null;
  for (const part of splitLinkHeader(link)) {
    const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(part);
    const relations = (rel?.[1] ?? rel?.[2] ?? "").split(/\s+/);
    if (!relations.includes("next")) continue;

    const target = /^\s*<([^>]*)>/.exec(part)?.[1];
    if (!target) throw new Error("GitHub API returned an invalid pagination Link for rel=next");
    if (next !== null) throw new Error("GitHub API returned multiple pagination Links for rel=next");

    try {
      next = new URL(target, current);
    } catch {
      throw new Error("GitHub API returned an invalid pagination Link for rel=next");
    }
  }

  if (next === null) return null;
  if (next.username !== "" || next.password !== "") {
    throw new Error("GitHub pagination Link must not contain credentials");
  }
  if (next.origin !== expected.origin) {
    throw new Error("GitHub pagination Link must use the configured API origin");
  }
  if (next.pathname !== expected.pathname) {
    throw new Error(`GitHub pagination Link must use the configured ${resource} path`);
  }
  if (next.hash !== "") {
    throw new Error("GitHub pagination Link must not contain a fragment");
  }
  return next;
}

function splitLinkHeader(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angle = false;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (!angle && character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "<") {
      angle = true;
    } else if (!quoted && character === ">") {
      angle = false;
    } else if (!angle && !quoted && character === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStates(states: string[]): Set<GitHubState> {
  const requested = new Set<GitHubState>();
  states.forEach((state, index) => {
    if (typeof state !== "string") {
      throw new Error(`GitHub tracker state at index ${index} must be open, closed, or all`);
    }
    const normalized = state.trim().toLowerCase();
    if (normalized === "all") {
      requested.add("open");
      requested.add("closed");
    } else if (normalized === "open" || normalized === "closed") {
      requested.add(normalized);
    } else {
      throw new Error(`Unsupported GitHub issue state: ${state}`);
    }
  });
  return requested;
}

function validateIssueIds(ids: string[]): string[] {
  const unique = new Set<string>();
  ids.forEach((id, index) => {
    if (typeof id !== "string" || !ISSUE_NUMBER.test(id)) {
      throw new Error(`GitHub issue id at index ${index} must be a positive decimal issue number`);
    }
    unique.add(id);
  });
  return [...unique];
}

function normalizeIssue(raw: unknown, settings: GitHubSettings, path: string): Issue | null {
  if (isRecord(raw) && "pull_request" in raw) return null;

  const parsed = githubIssueSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
      .join("; ");
    throw new Error(`GitHub API GET ${path} returned an invalid issue: ${details}`);
  }

  const issue = parsed.data;
  const labels = (issue.labels ?? []).flatMap((label) =>
    typeof label === "string" ? [label] : typeof label.name === "string" ? [label.name] : [],
  );

  return {
    id: String(issue.number),
    nativeRef: { owner: settings.owner, repo: settings.repo, number: issue.number },
    identifier: `${settings.owner}/${settings.repo}#${issue.number}`,
    title: issue.title,
    description: issue.body ?? null,
    priority: null,
    state: issue.state,
    branchName: null,
    url: issue.html_url ?? null,
    assigneeId: issue.assignee?.login ?? null,
    labels: [...new Set(labels.map((label) => label.trim().toLowerCase()).filter(Boolean))],
    blockedBy: [],
    dispatchable: true,
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
