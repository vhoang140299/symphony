import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { createTracker } from "../src/registry.js";

const enabled = process.env.SYMPHONY_RUN_GITHUB_LIVE_E2E === "1";
const codexEnabled = process.env.SYMPHONY_RUN_GITHUB_CODEX_LIVE_E2E === "1";
const execFileAsync = promisify(execFile);
const nodeRoot = fileURLToPath(new URL("../../../", import.meta.url));

test.skipIf(!enabled)("round-trips a real disposable GitHub issue", { timeout: 120_000 }, async () => {
  const { owner, repo } = parseRepository(requiredEnv("SYMPHONY_LIVE_GITHUB_REPO"));
  const token = requiredEnv("GITHUB_TOKEN");
  const runId = randomUUID();
  let issueId: string | undefined;

  try {
    const created = await githubObjectRequest(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      token,
      {
        title: `Symphony Node live E2E ${runId}`,
        body: `Disposable issue created by the Symphony Node GitHub live E2E test.\n\nrun_id=${runId}`,
      },
    );
    assert.equal(typeof created.number, "number");
    issueId = String(created.number);

    const tracker = createTracker("github", {
      owner,
      repo,
      token: "$GITHUB_TOKEN",
    });
    let issue = (await tracker.fetchIssuesByStates(["open"])).find(({ id }) => id === issueId);
    for (let attempt = 1; attempt < 20 && issue === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      issue = (await tracker.fetchIssuesByStates(["open"])).find(({ id }) => id === issueId);
    }
    assert.ok(issue);
    assert.equal(issue.identifier, `${owner}/${repo}#${issueId}`);
    assert.deepEqual((await tracker.fetchIssuesByIds([issueId])).map(({ id }) => id), [issueId]);

    const mutateIssue = tracker.mutateIssue?.bind(tracker);
    assert.ok(mutateIssue);
    await mutateIssue(issue, { kind: "set_state", state: "closed" }, AbortSignal.timeout(30_000));
    const [closed] = await tracker.fetchIssuesByIds([issueId]);
    assert.equal(closed?.state, "closed");
  } finally {
    if (issueId !== undefined) {
      await githubObjectRequest(
        "PATCH",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueId}`,
        token,
        { state: "closed" },
      );
    }
  }
});

test.skipIf(!codexEnabled)(
  "completes a real GitHub issue with Codex",
  { timeout: 900_000 },
  async () => {
    const { owner, repo } = parseRepository(requiredEnv("SYMPHONY_LIVE_GITHUB_REPO"));
    const token = requiredEnv("GITHUB_TOKEN");
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const runId = randomUUID();
    const issueTitle = `Symphony Node Codex live E2E ${runId}`;
    const queueLabel = `symphony-live-${runId.slice(0, 8)}`;
    const reviewLabel = `symphony-review-${runId.slice(0, 8)}`;
    const fileName = `SYMPHONY_LIVE_${runId.replaceAll("-", "_")}.txt`;
    const marker = `symphony-node-codex-live-e2e:${runId}\n`;
    const tempRoot = await mkdtemp(path.join(tmpdir(), "symphony-github-codex-live-"));
    let issueNumber: number | undefined;
    let branchName: string | undefined;
    let branchOwned = false;
    const createdLabels: string[] = [];
    let pullRequestNumber: number | undefined;
    let publishedHeadSha: string | undefined;
    let initialMainSha: string | undefined;
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];

    try {
      const repository = await githubObjectRequest("GET", repositoryPath, token);
      assert.equal(repository.private, true, "live Codex E2E requires a private disposable repository");
      const defaultBranch = requiredStringField(repository, "default_branch");
      assert.equal(defaultBranch, "main", "live Codex E2E requires the disposable repository's main branch");
      initialMainSha = await fetchCommitSha(repositoryPath, defaultBranch, token);

      const codexHome = path.join(tempRoot, "codex-home");
      await copyCodexAuthentication(codexHome);
      const codexExecutable = path.join(nodeRoot, "packages/agents/node_modules/.bin/codex");
      const login = await execFileAsync(codexExecutable, ["login", "status"], {
        encoding: "utf8",
        env: commandEnvironment(codexHome),
        timeout: 30_000,
      });
      assert.match(`${login.stdout}${login.stderr}`, /^Logged in using /mu);

      await githubObjectRequest("POST", `${repositoryPath}/labels`, token, {
        name: queueLabel,
        color: "5319e7",
        description: "Temporary Symphony Node live E2E queue",
      });
      createdLabels.push(queueLabel);
      await githubObjectRequest("POST", `${repositoryPath}/labels`, token, {
        name: reviewLabel,
        color: "0e8a16",
        description: "Temporary Symphony Node live E2E review",
      });
      createdLabels.push(reviewLabel);

      const created = await githubObjectRequest("POST", `${repositoryPath}/issues`, token, {
        title: issueTitle,
        body: [
          `Create exactly one UTF-8 text file at the repository root named \`${fileName}\`.`,
          "The file must contain exactly one line and end with exactly one LF newline. Its complete content is:",
          `\`\`\`text\n${marker}\`\`\``,
          "Do not modify any other file. Run `git diff --check` and verify the file's exact content.",
        ].join("\n\n"),
      });
      issueNumber = requiredNumberField(created, "number");
      branchName = `symphony/issue-${issueNumber}`;
      const branchPath = branchName.split("/").map(encodeURIComponent).join("/");
      assert.equal(
        await githubOptionalObjectRequest("GET", `${repositoryPath}/git/ref/heads/${branchPath}`, token),
        undefined,
        "the deterministic live-test branch must not already exist",
      );
      branchOwned = true;
      const queued = await githubObjectRequest("PATCH", `${repositoryPath}/issues/${issueNumber}`, token, {
        labels: [queueLabel],
      });
      assert.ok(githubLabels(queued.labels).map((label) => label.toLowerCase()).includes(queueLabel));
      const tracker = createTracker("github", { owner, repo, token: "$GITHUB_TOKEN" });
      let candidate = (await tracker.fetchIssuesByStates(["open"])).find(({ id }) => id === String(issueNumber));
      for (let attempt = 1; attempt < 30 && candidate === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        candidate = (await tracker.fetchIssuesByStates(["open"])).find(({ id }) => id === String(issueNumber));
      }
      assert.ok(candidate, "the production state-list read must observe the queued live-test issue");
      assert.ok(candidate.labels.includes(queueLabel));

      const workflowPath = path.join(tempRoot, "WORKFLOW.md");
      await writeFile(
        workflowPath,
        githubCodexWorkflow({
          owner,
          repo,
          defaultBranch,
          queueLabel,
          reviewLabel,
          workspaceRoot: path.join(tempRoot, "workspaces"),
        }),
        { mode: 0o600 },
      );

      const cliPath = path.join(nodeRoot, "packages/cli/dist/cli.js");
      let stdout: string;
      try {
        const result = await execFileAsync(process.execPath, [cliPath, "--once", workflowPath], {
          cwd: nodeRoot,
          encoding: "utf8",
          env: commandEnvironment(codexHome, token),
          maxBuffer: 10 * 1024 * 1024,
          timeout: 420_000,
        });
        stdout = result.stdout;
      } catch (error) {
        throw new Error(`Symphony Node live Codex run failed${childStderr(error, token)}`);
      }
      const snapshot = parseJsonObject(stdout.trim(), "Symphony Node live Codex output");
      assert.deepEqual(
        { running: snapshot.running, retrying: snapshot.retrying, blocked: snapshot.blocked },
        { running: 0, retrying: 0, blocked: 0 },
      );

      const pulls = await waitForPullRequest(repositoryPath, owner, branchName, defaultBranch, token);
      assert.equal(pulls.length, 1, "the live Codex run must publish exactly one pull request");
      const pullRequest = pulls[0];
      assert.ok(pullRequest);
      pullRequestNumber = requiredNumberField(pullRequest, "number");
      const pullRequestDetail = await githubObjectRequest(
        "GET",
        `${repositoryPath}/pulls/${pullRequestNumber}`,
        token,
      );
      const pullRequestUrl = requiredStringField(pullRequestDetail, "html_url");
      const pullRequestHead = requiredRecordField(pullRequestDetail, "head");
      const pullRequestBase = requiredRecordField(pullRequestDetail, "base");
      publishedHeadSha = requiredStringField(pullRequestHead, "sha");
      assert.equal(pullRequestDetail.state, "open");
      assert.equal(pullRequestDetail.merged, false);
      assert.equal(pullRequestDetail.title, `${owner}/${repo}#${issueNumber}: ${issueTitle}`);
      assert.match(requiredStringField(pullRequestDetail, "body"), /## Summary[\s\S]+## Verification/u);
      assert.equal(pullRequestHead.ref, branchName);
      assert.equal(pullRequestBase.ref, defaultBranch);
      assert.equal(pullRequestBase.sha, initialMainSha);

      const publishedBranchPath = branchName.split("/").map(encodeURIComponent).join("/");
      const publishedRef = await githubObjectRequest(
        "GET",
        `${repositoryPath}/git/ref/heads/${publishedBranchPath}`,
        token,
      );
      assert.equal(requiredRecordField(publishedRef, "object").sha, publishedHeadSha);
      const comparison = await githubObjectRequest(
        "GET",
        `${repositoryPath}/compare/${initialMainSha}...${publishedHeadSha}`,
        token,
      );
      assert.equal(comparison.behind_by, 0);
      assert.equal(comparison.ahead_by, 1);
      const files = requiredRecordArrayField(comparison, "files");
      assert.equal(files.length, 1);
      assert.equal(files[0]?.filename, fileName);
      assert.equal(files[0]?.status, "added");

      const content = await githubObjectRequest(
        "GET",
        `${repositoryPath}/contents/${encodeURIComponent(fileName)}?ref=${encodeURIComponent(branchName)}`,
        token,
      );
      assert.equal(content.encoding, "base64");
      assert.equal(Buffer.from(requiredStringField(content, "content").replaceAll("\n", ""), "base64").toString(), marker);

      const issue = await githubObjectRequest("GET", `${repositoryPath}/issues/${issueNumber}`, token);
      const labels = githubLabels(issue.labels).map((label) => label.toLowerCase());
      assert.ok(labels.includes(reviewLabel));
      assert.ok(!labels.includes(queueLabel));
      const comments = await githubArrayRequest("GET", `${repositoryPath}/issues/${issueNumber}/comments`, token);
      const handoffComments = comments.filter(
        ({ body }) => typeof body === "string" && body.includes(pullRequestUrl),
      );
      assert.equal(handoffComments.length, 1, "the host must write exactly one handoff comment");
      assert.match(requiredStringField(handoffComments[0] ?? {}, "body"), /<!-- symphony-comment:[0-9a-f]{64} -->/u);
      assert.equal(await fetchCommitSha(repositoryPath, defaultBranch, token), initialMainSha);
    } catch (error) {
      primaryError = error;
    } finally {
      if (issueNumber !== undefined) {
        await cleanupStep(cleanupErrors, async () => {
          await githubObjectRequest("PATCH", `${repositoryPath}/issues/${issueNumber}`, token, {
            state: "closed",
            labels: [],
          });
        });
      }
      for (const label of createdLabels) {
        await cleanupStep(cleanupErrors, async () => {
          await githubRequest(
            "DELETE",
            `${repositoryPath}/labels/${encodeURIComponent(label)}`,
            token,
            undefined,
            true,
          );
        });
      }
      let mayDeleteBranch = false;
      if (branchName !== undefined && pullRequestNumber === undefined) {
        const ownedBranchName = branchName;
        const discovered = await cleanupStep(cleanupErrors, async () => {
          const pulls = await findPullRequests(repositoryPath, owner, ownedBranchName, "main", token);
          const pullRequest = pulls[0];
          if (pullRequest === undefined) return;
          pullRequestNumber = requiredNumberField(pullRequest, "number");
          publishedHeadSha ??= requiredStringField(requiredRecordField(pullRequest, "head"), "sha");
        });
        mayDeleteBranch = discovered && pullRequestNumber === undefined;
      }
      if (pullRequestNumber !== undefined) {
        mayDeleteBranch = await cleanupStep(cleanupErrors, async () => {
          await githubObjectRequest("PATCH", `${repositoryPath}/pulls/${pullRequestNumber}`, token, {
            state: "closed",
          });
        });
      }
      if (branchOwned && branchName !== undefined && mayDeleteBranch) {
        const ownedBranchName = branchName;
        await cleanupStep(cleanupErrors, async () => {
          const branchPath = ownedBranchName.split("/").map(encodeURIComponent).join("/");
          const currentRef = await githubOptionalObjectRequest(
            "GET",
            `${repositoryPath}/git/ref/heads/${branchPath}`,
            token,
          );
          if (currentRef === undefined) return;
          if (publishedHeadSha !== undefined) {
            assert.equal(requiredRecordField(currentRef, "object").sha, publishedHeadSha);
          }
          await githubRequest("DELETE", `${repositoryPath}/git/refs/heads/${branchPath}`, token, undefined, true);
        });
      }
      await cleanupStep(cleanupErrors, async () => rm(tempRoot, { recursive: true, force: true }));
      if (initialMainSha !== undefined) {
        await cleanupStep(cleanupErrors, async () => {
          assert.equal(await fetchCommitSha(repositoryPath, "main", token), initialMainSha);
        });
      }
    }

    const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
    if (errors.length > 0) throw new AggregateError(errors, "GitHub Codex live E2E failed");
  },
);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required for the GitHub live E2E test`);
  return value;
}

function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(value);
  if (match === null) throw new Error("SYMPHONY_LIVE_GITHUB_REPO must use owner/repo form");
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

async function githubObjectRequest(
  method: GitHubMethod,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = await githubRequest(method, path, token, body);
  if (!isRecord(payload)) throw new Error(`GitHub live E2E ${method} ${path} returned an invalid object`);
  return payload;
}

async function githubOptionalObjectRequest(
  method: GitHubMethod,
  path: string,
  token: string,
): Promise<Record<string, unknown> | undefined> {
  const payload = await githubRequest(method, path, token, undefined, true);
  if (payload === undefined) return undefined;
  if (!isRecord(payload)) throw new Error(`GitHub live E2E ${method} ${path} returned an invalid object`);
  return payload;
}

async function githubArrayRequest(
  method: GitHubMethod,
  path: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  const payload = await githubRequest(method, path, token);
  if (!Array.isArray(payload) || !payload.every(isRecord)) {
    throw new Error(`GitHub live E2E ${method} ${path} returned an invalid array`);
  }
  return payload;
}

type GitHubMethod = "GET" | "POST" | "PATCH" | "DELETE";

async function githubRequest(
  method: GitHubMethod,
  path: string,
  token: string,
  body?: Record<string, unknown>,
  allowNotFound = false,
): Promise<unknown | undefined> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ai-symphony-node-live-e2e",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`GitHub live E2E ${method} ${path} failed before a response`);
  }
  if (allowNotFound && response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`GitHub live E2E ${method} ${path} failed with HTTP ${response.status}`);
  }
  if (response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub live E2E ${method} ${path} returned invalid JSON`);
  }
}

function githubCodexWorkflow(input: {
  owner: string;
  repo: string;
  defaultBranch: string;
  queueLabel: string;
  reviewLabel: string;
  workspaceRoot: string;
}): string {
  return `---
tracker:
  kind: github
  provider:
    owner: ${JSON.stringify(input.owner)}
    repo: ${JSON.stringify(input.repo)}
    token: $GITHUB_TOKEN
    base_branch: ${JSON.stringify(input.defaultBranch)}
  required_labels: [${JSON.stringify(input.queueLabel)}]
  active_states: [open]
  terminal_states: [closed]

delivery:
  queue_label: ${JSON.stringify(input.queueLabel)}
  review_label: ${JSON.stringify(input.reviewLabel)}

polling:
  interval_ms: 1000

workspace:
  root: ${JSON.stringify(input.workspaceRoot)}

hooks:
  after_create: |
    gh repo clone https://github.com/${input.owner}/${input.repo}.git . --no-upstream -- --branch ${input.defaultBranch} --single-branch
  timeout_ms: 120000

agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_attempts: 1
  max_retry_backoff_ms: 1000

runtime:
  kind: codex
  turn_timeout_ms: 360000
  stall_timeout_ms: 120000
  options:
    model_reasoning_effort: low
    read_timeout_ms: 60000
---

Implement GitHub issue {{ issue.identifier }} in its dedicated workspace.

Title: {{ issue.title }}

Description:
{{ issue.description }}

Follow the description exactly. Make no unrelated changes. Verify the requested result before
completing.

Return \`status: ready\` only when the edit and verification are complete. Put a concise summary in
\`summary\` and list every check actually run in \`verification\`. Symphony handles commits, pull
requests, issue comments, and labels after the run.
`;
}

async function copyCodexAuthentication(targetHome: string): Promise<void> {
  const configuredHome = process.env.CODEX_HOME?.trim();
  const sourceHome = configuredHome === undefined || configuredHome === ""
    ? path.join(homedir(), ".codex")
    : configuredHome;
  const sourceAuth = path.join(sourceHome, "auth.json");
  const stat = await lstat(sourceAuth);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Codex auth cache must be a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("Codex auth cache must not be accessible by group or other users");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Codex auth cache must be owned by the current user");
  }
  await mkdir(targetHome, { mode: 0o700 });
  await chmod(targetHome, 0o700);
  const targetAuth = path.join(targetHome, "auth.json");
  await copyFile(sourceAuth, targetAuth);
  await chmod(targetAuth, 0o600);
}

function commandEnvironment(codexHome: string, githubToken?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    HOME: codexHome,
    ...(githubToken === undefined ? {} : { GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken }),
  };
  for (const name of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function fetchCommitSha(repositoryPath: string, branch: string, token: string): Promise<string> {
  const commit = await githubObjectRequest(
    "GET",
    `${repositoryPath}/commits/${encodeURIComponent(branch)}`,
    token,
  );
  return requiredStringField(commit, "sha");
}

async function findPullRequests(
  repositoryPath: string,
  owner: string,
  branch: string,
  base: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  return githubArrayRequest(
    "GET",
    `${repositoryPath}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&per_page=10`,
    token,
  );
}

async function waitForPullRequest(
  repositoryPath: string,
  owner: string,
  branch: string,
  base: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const pulls = await findPullRequests(repositoryPath, owner, branch, base, token);
    if (pulls.length > 0) return pulls;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return [];
}

function githubLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => isRecord(label) && typeof label.name === "string" ? [label.name] : []);
}

function requiredStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new Error(`GitHub live E2E response is missing ${key}`);
  return value;
}

function requiredNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`GitHub live E2E response is missing ${key}`);
  }
  return value as number;
}

function requiredRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`GitHub live E2E response is missing ${key}`);
  return value;
}

function requiredRecordArrayField(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`GitHub live E2E response is missing ${key}`);
  }
  return value;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Use the fixed error below so child output cannot leak credentials.
  }
  throw new Error(`${label} was not a JSON object`);
}

function childStderr(error: unknown, token: string): string {
  if (!isRecord(error) || typeof error.stderr !== "string") return "";
  const redacted = error.stderr.replaceAll(token, "[REDACTED]").trim();
  return redacted === "" ? "" : `: ${redacted.slice(-4_000)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cleanupStep(errors: unknown[], action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    errors.push(error);
    return false;
  }
}
