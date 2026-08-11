import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import type { Issue, IssueMutation } from "@ai-symphony/core/domain.js";
import { GitHubTracker } from "../src/github.js";
import { createTracker, validateTrackerProvider } from "../src/registry.js";
import { trackerError } from "./assertions.js";

const TEST_IDEMPOTENCY_KEY = "123e4567-e89b-42d3-a456-426614174000";

function rawIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: "open",
    html_url: `https://github.example/acme/widget/issues/${number}`,
    assignee: { login: "octocat" },
    labels: [{ name: " Bug " }, "READY", { name: "bug" }, { name: null }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function issue(number = 7, overrides: Partial<Issue> = {}): Issue {
  return {
    id: String(number),
    nativeRef: { owner: "acme", repo: "widget", number },
    identifier: `acme/widget#${number}`,
    title: `Issue ${number}`,
    description: null,
    priority: null,
    state: "open",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

test("fetches every state page, ignores pull requests, and normalizes issues", async () => {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    index === 99 ? rawIssue(100, { pull_request: {} }) : rawIssue(index + 1),
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    return Response.json(url.searchParams.get("page") === "1" ? firstPage : [rawIssue(101, { state: "closed" })]);
  };

  const previousToken = process.env.SYMPHONY_GITHUB_TEST_TOKEN;
  process.env.SYMPHONY_GITHUB_TEST_TOKEN = "top-secret";
  try {
    const tracker = new GitHubTracker(
      {
        owner: "acme",
        repo: "widget",
        endpoint: "https://github.example/api/v3/",
        token: "$SYMPHONY_GITHUB_TEST_TOKEN",
      },
      fetchImpl,
    );
    const issues = await tracker.fetchIssuesByStates([" OPEN ", "closed"]);

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url.pathname, "/api/v3/repos/acme/widget/issues");
    assert.equal(requests[0]?.url.searchParams.get("state"), "all");
    assert.equal(requests[0]?.url.searchParams.get("per_page"), "100");
    assert.equal(requests[1]?.url.searchParams.get("page"), "2");
    assert.deepEqual(requests.map(({ authorization }) => authorization), ["Bearer top-secret", "Bearer top-secret"]);
    assert.equal(issues.length, 100);
    assert.equal(issues.some(({ id }) => id === "100"), false);
    assert.deepEqual(issues.at(-1), {
      id: "101",
      nativeRef: { owner: "acme", repo: "widget", number: 101 },
      identifier: "acme/widget#101",
      title: "Issue 101",
      description: "Body 101",
      priority: null,
      state: "closed",
      branchName: null,
      url: "https://github.example/acme/widget/issues/101",
      assigneeId: "octocat",
      labels: ["bug", "ready"],
      blockedBy: [],
      dispatchable: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  } finally {
    if (previousToken === undefined) delete process.env.SYMPHONY_GITHUB_TEST_TOKEN;
    else process.env.SYMPHONY_GITHUB_TEST_TOKEN = previousToken;
  }
});

test("follows a validated next Link even when the current page is short", async () => {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url);
    if (urls.length === 1) {
      const next = "https://github.example/api/v3/repos/acme/widget/issues?state=all&per_page=100&page=2";
      return Response.json([rawIssue(1)], { headers: { Link: `<${next}>; rel="next"` } });
    }
    return Response.json([rawIssue(2, { state: "closed" })]);
  };
  const tracker = new GitHubTracker(
    { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
    fetchImpl,
  );

  const issues = await tracker.fetchIssuesByStates(["all"]);
  assert.deepEqual(issues.map(({ id }) => id), ["1", "2"]);
  assert.equal(urls.length, 2);
  assert.equal(urls[1]?.searchParams.get("page"), "2");
});

test("rejects unsafe pagination Links and detects loops", async () => {
  const cases = [
    {
      link: "https://evil.example/api/v3/repos/acme/widget/issues?page=2",
      error: /must use the configured API origin/,
    },
    {
      link: "https://github.example/api/v3/repos/acme/other/issues?page=2",
      error: /must use the configured repository issues path/,
    },
    {
      link: "https://user:password@github.example/api/v3/repos/acme/widget/issues?page=2",
      error: /must not contain credentials/,
    },
  ];

  for (const { link, error } of cases) {
    const tracker = new GitHubTracker(
      { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
      async () => Response.json([rawIssue(1)], { headers: { Link: `<${link}>; rel="next"` } }),
    );
    await assert.rejects(
      tracker.fetchIssuesByStates(["open"]),
      trackerError("tracker_pagination", error),
    );
  }

  let requests = 0;
  const looping = new GitHubTracker(
    { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
    async (input) => {
      requests += 1;
      const url = input instanceof Request ? input.url : input.toString();
      return Response.json([rawIssue(1)], { headers: { Link: `<${url}>; rel="next"` } });
    },
  );
  await assert.rejects(
    looping.fetchIssuesByStates(["open"]),
    trackerError("tracker_pagination", /pagination Link loop detected/),
  );
  assert.equal(requests, 1);
});

test("bounds issue pagination when every page advertises a next Link", async () => {
  let requests = 0;
  const tracker = new GitHubTracker(
    { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
    async (input) => {
      requests += 1;
      const next = new URL(input instanceof Request ? input.url : input.toString());
      next.searchParams.set("page", String(requests + 1));
      return Response.json([], { headers: { Link: `<${next.href}>; rel="next"` } });
    },
  );

  await assert.rejects(tracker.fetchIssuesByStates(["open"]), /pagination exceeded 1000 pages/);
  assert.equal(requests, 1_000);
});

test("deduplicates exact issue fetches, skips missing issues and pull requests", async () => {
  const paths: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    paths.push(url.pathname);
    if (url.pathname.endsWith("/2")) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/3")) return Response.json(rawIssue(3, { pull_request: {} }));
    return Response.json(rawIssue(1));
  };
  const tracker = new GitHubTracker({ owner: "acme", repo: "widget" }, fetchImpl);

  const issues = await tracker.fetchIssuesByIds(["1", "2", "1", "3"]);
  assert.deepEqual(paths, [
    "/repos/acme/widget/issues/1",
    "/repos/acme/widget/issues/2",
    "/repos/acme/widget/issues/3",
  ]);
  assert.deepEqual(issues.map(({ id }) => id), ["1"]);
});

test("validates configuration, states, ids, payloads, and redacts tokens from errors", async () => {
  assert.throws(
    () => new GitHubTracker({ repo: "widget" }),
    trackerError("invalid_tracker_config", /provider\.owner must be a non-empty string/),
  );
  assert.throws(
    () => new GitHubTracker({ owner: "acme/team", repo: "widget" }),
    /provider\.owner must contain only letters/,
  );
  assert.throws(
    () => new GitHubTracker({ owner: "acme", repo: "widget", token: "literal-secret" }),
    /provider\.token must be an environment reference/,
  );
  assert.throws(
    () => new GitHubTracker({ owner: "acme", repo: "widget", extra: true }),
    /Unsupported GitHub tracker provider option\(s\): extra/,
  );

  const token = "must-not-appear";
  const previousToken = process.env.SYMPHONY_GITHUB_TEST_TOKEN;
  process.env.SYMPHONY_GITHUB_TEST_TOKEN = token;
  try {
    const tracker = new GitHubTracker(
      { owner: "acme", repo: "widget", token: "$SYMPHONY_GITHUB_TEST_TOKEN" },
      async () => new Response("nope", { status: 401 }),
    );
    await assert.rejects(tracker.fetchIssuesByStates(["todo"]), /Unsupported GitHub issue state: todo/);
    await assert.rejects(tracker.fetchIssuesByIds(["1", "01"]), /id at index 1 must be a positive decimal/);
    await assert.rejects(tracker.fetchIssuesByStates(["open"]), (error: unknown) => {
      assert.ok(error instanceof Error && "category" in error);
      assert.equal(error.category, "tracker_status");
      assert.match(error.message, /failed with HTTP 401/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    });
  } finally {
    if (previousToken === undefined) delete process.env.SYMPHONY_GITHUB_TEST_TOKEN;
    else process.env.SYMPHONY_GITHUB_TEST_TOKEN = previousToken;
  }

  const malformed = new GitHubTracker(
    { owner: "acme", repo: "widget" },
    async () => Response.json([{ number: 1, title: "", state: "open" }]),
  );
  await assert.rejects(
    malformed.fetchIssuesByStates(["open"]),
    trackerError("tracker_response", /returned an invalid issue: title:/),
  );
});

test("validates GitHub provider syntax without resolving authentication", () => {
  const variable = "SYMPHONY_GITHUB_UNSET_VALIDATION_TOKEN";
  const previous = process.env[variable];
  delete process.env[variable];
  const provider = { owner: "acme", repo: "widget", token: `$${variable}` };
  try {
    assert.doesNotThrow(() => validateTrackerProvider("github", provider));
    assert.throws(
      () => new GitHubTracker(provider),
      trackerError("missing_tracker_secret", /token environment variable .* is not set/),
    );
    assert.throws(
      () => validateTrackerProvider("github", { ...provider, token: "literal-secret" }),
      /provider\.token must be an environment reference/,
    );
    assert.throws(
      () => validateTrackerProvider("github", { ...provider, endpoint: "http://github.example" }),
      /refuses to send a token over a non-HTTPS endpoint/,
    );
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("uses GITHUB_TOKEN fallback and registry creates the GitHub tracker", async () => {
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "fallback-token";
  try {
    let authorization: string | null = null;
    const tracker = new GitHubTracker({ owner: "acme", repo: "widget" }, async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json([]);
    });
    assert.deepEqual(await tracker.fetchIssuesByStates(["all"]), []);
    assert.equal(authorization, "Bearer fallback-token");
    assert.ok(createTracker("github", { owner: "acme", repo: "widget" }) instanceof GitHubTracker);
    assert.throws(
      () => createTracker("unsupported", {}),
      trackerError("unsupported_tracker_kind", /Unsupported tracker kind: unsupported/),
    );
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("maps GitHub read failures to portable tracker categories", async () => {
  const provider = { owner: "acme", repo: "widget" };
  const cases: Array<{
    category: "tracker_request" | "tracker_status" | "tracker_response" | "tracker_rate_limited";
    fetchImpl: typeof fetch;
  }> = [
    {
      category: "tracker_request",
      fetchImpl: async () => { throw new Error("provider detail must stay hidden"); },
    },
    {
      category: "tracker_status",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    },
    {
      category: "tracker_response",
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    },
    {
      category: "tracker_rate_limited",
      fetchImpl: async () => new Response("slow down", { status: 429 }),
    },
    {
      category: "tracker_rate_limited",
      fetchImpl: async () => new Response("slow down", {
        status: 403,
        headers: { "Retry-After": "60" },
      }),
    },
    {
      category: "tracker_rate_limited",
      fetchImpl: async () => new Response("slow down", {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0" },
      }),
    },
    {
      category: "tracker_status",
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    },
  ];

  for (const { category, fetchImpl } of cases) {
    await assert.rejects(
      new GitHubTracker(provider, fetchImpl).fetchIssuesByStates(["open"]),
      trackerError(category, /GitHub API GET/),
    );
  }

  const hiddenDetail = "body-stream-detail-must-stay-hidden";
  const interruptedBody = new ReadableStream({
    start(controller) {
      controller.error(new TypeError(hiddenDetail));
    },
  });
  await assert.rejects(
    new GitHubTracker(provider, async () => new Response(interruptedBody))
      .fetchIssuesByStates(["open"]),
    (error: unknown) => {
      trackerError("tracker_request", /GitHub API GET .* failed$/)(error);
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(hiddenDetail));
      return true;
    },
  );
});

test("scopes implicit tokens to api.github.com and rejects tokens over HTTP", async () => {
  const previousFallback = process.env.GITHUB_TOKEN;
  const previousExplicit = process.env.SYMPHONY_GITHUB_TEST_TOKEN;
  process.env.GITHUB_TOKEN = "implicit-token";
  process.env.SYMPHONY_GITHUB_TEST_TOKEN = "explicit-token";
  try {
    let authorization: string | null = "not-called";
    const custom = new GitHubTracker(
      { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
      async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json([]);
      },
    );
    await custom.fetchIssuesByStates(["open"]);
    assert.equal(authorization, null);

    assert.throws(
      () =>
        new GitHubTracker({
          owner: "acme",
          repo: "widget",
          endpoint: "http://github.example/api/v3",
          token: "$SYMPHONY_GITHUB_TEST_TOKEN",
        }),
      /refuses to send a token over a non-HTTPS endpoint/,
    );
  } finally {
    if (previousFallback === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousFallback;
    if (previousExplicit === undefined) delete process.env.SYMPHONY_GITHUB_TEST_TOKEN;
    else process.env.SYMPHONY_GITHUB_TEST_TOKEN = previousExplicit;
  }
});

test("adds a 30 second AbortSignal to each request", async () => {
  let signal: AbortSignal | null | undefined;
  const tracker = new GitHubTracker(
    { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
    async (_input, init) => {
      signal = init?.signal;
      return Response.json([]);
    },
  );

  await tracker.fetchIssuesByStates(["open"]);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("comments, adds and removes labels, and changes GitHub issue state", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_MUTATION_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "mutation-token";
  const calls: Array<{
    url: URL;
    method: string | undefined;
    body: string | undefined;
    authorization: string | null;
    contentType: string | null;
    redirect: RequestRedirect | undefined;
    signal: AbortSignal | null | undefined;
  }> = [];

  try {
    const tracker = new GitHubTracker(
      {
        owner: "acme",
        repo: "widget",
        endpoint: "https://github.example/api/v3",
        token: `$${tokenVariable}`,
      },
      async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: new URL(input instanceof Request ? input.url : input.toString()),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
          authorization: headers.get("authorization"),
          contentType: headers.get("content-type"),
          redirect: init?.redirect,
          signal: init?.signal,
        });
        return new Response(null, { status: 204 });
      },
    );
    const callerSignal = new AbortController().signal;
    const mutations: IssueMutation[] = [
      { kind: "comment", body: "Implemented and verified." },
      { kind: "add_label", label: " ready " },
      { kind: "remove_label", label: "needs triage/QA" },
      { kind: "set_state", state: " CLOSED " },
    ];

    for (const mutation of mutations) {
      await tracker.mutateIssue(issue(), mutation, callerSignal);
    }

    assert.deepEqual(
      calls.map(({ url, method, body }) => ({ path: url.pathname, method, body })),
      [
        {
          path: "/api/v3/repos/acme/widget/issues/7/comments",
          method: "POST",
          body: JSON.stringify({ body: "Implemented and verified." }),
        },
        {
          path: "/api/v3/repos/acme/widget/issues/7/labels",
          method: "POST",
          body: JSON.stringify({ labels: ["ready"] }),
        },
        {
          path: "/api/v3/repos/acme/widget/issues/7/labels/needs%20triage%2FQA",
          method: "DELETE",
          body: undefined,
        },
        {
          path: "/api/v3/repos/acme/widget/issues/7",
          method: "PATCH",
          body: JSON.stringify({ state: "closed" }),
        },
      ],
    );
    assert.deepEqual(calls.map(({ authorization }) => authorization), Array(4).fill("Bearer mutation-token"));
    assert.deepEqual(calls.map(({ redirect }) => redirect), Array(4).fill("error"));
    assert.deepEqual(calls.map(({ contentType }) => contentType), [
      "application/json",
      "application/json",
      null,
      "application/json",
    ]);
    assert.ok(calls.every(({ signal }) => signal instanceof AbortSignal && signal !== callerSignal));
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("creates an idempotent comment once, then updates the exact existing comment", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_IDEMPOTENT_COMMENT_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "mutation-token";
  const calls: Array<{ url: URL; method: string | undefined; body: string | undefined; signal: AbortSignal | null | undefined }> = [];
  let storedBody: string | undefined;
  const quotedMarkerBody = "Published pull request 12 with quoted <!-- symphony-comment:issue-text -->.";

  try {
    const tracker = new GitHubTracker(
      { owner: "acme", repo: "widget", token: `$${tokenVariable}` },
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, method: init?.method, body, signal: init?.signal });
        if (init?.method === "POST" || init?.method === "PATCH") {
          storedBody = (JSON.parse(body ?? "{}") as { body?: string }).body;
          return new Response(null, { status: init.method === "POST" ? 201 : 200 });
        }
        return Response.json(
          storedBody === undefined ? [] : [{ id: 91, body: storedBody }],
        );
      },
    );
    const signal = new AbortController().signal;

    await tracker.mutateIssue(
      issue(),
      { kind: "comment", body: quotedMarkerBody, idempotencyKey: TEST_IDEMPOTENCY_KEY },
      signal,
    );
    const createdBody = storedBody;
    await tracker.mutateIssue(
      issue(),
      { kind: "comment", body: "Updated pull request 12.", idempotencyKey: TEST_IDEMPOTENCY_KEY },
      signal,
    );

    assert.ok(createdBody?.startsWith(`${quotedMarkerBody}\n\n`));
    assert.match(createdBody ?? "", /<!-- symphony-comment:[a-f0-9]{64} -->$/);
    assert.equal(
      storedBody?.match(/<!-- symphony-comment:[a-f0-9]{64} -->$/)?.[0],
      createdBody?.match(/<!-- symphony-comment:[a-f0-9]{64} -->$/)?.[0],
    );
    assert.deepEqual(
      calls.map(({ url, method }) => ({ path: url.pathname, method })),
      [
        { path: "/repos/acme/widget/issues/7/comments", method: "GET" },
        { path: "/repos/acme/widget/issues/7/comments", method: "POST" },
        { path: "/repos/acme/widget/issues/7/comments", method: "GET" },
        { path: "/repos/acme/widget/issues/comments/91", method: "PATCH" },
      ],
    );
    assert.deepEqual(
      calls.filter(({ method }) => method === "GET").map(({ url }) => Object.fromEntries(url.searchParams)),
      Array(2).fill({ per_page: "100", page: "1" }),
    );
    assert.ok(calls.every(({ signal: requestSignal }) => requestSignal instanceof AbortSignal && requestSignal !== signal));
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("scans every validated comment page before updating a marker match", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_IDEMPOTENT_COMMENT_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "mutation-token";
  const key = TEST_IDEMPOTENCY_KEY;
  const marker = `<!-- symphony-comment:${createHash("sha256").update(key).digest("hex")} -->`;
  const calls: Array<{ url: URL; method: string | undefined }> = [];

  try {
    const tracker = new GitHubTracker(
      {
        owner: "acme",
        repo: "widget",
        endpoint: "https://github.example/api/v3",
        token: `$${tokenVariable}`,
      },
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        calls.push({ url, method: init?.method });
        if (init?.method === "PATCH") return new Response(null, { status: 200 });
        if (url.searchParams.get("page") === "1") {
          const next = "https://github.example/api/v3/repos/acme/widget/issues/7/comments?per_page=100&page=2";
          return Response.json(
            Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `Comment ${index + 1}` })),
            { headers: { Link: `<${next}>; rel=\"next\"` } },
          );
        }
        return Response.json([
          { id: 502, body: `Copied marker twice\n\n${marker}\n${marker}` },
          { id: 501, body: `Previous result\n\n${marker}` },
        ]);
      },
    );

    await tracker.mutateIssue(
      issue(),
      { kind: "comment", body: "Current result", idempotencyKey: key },
      new AbortController().signal,
    );

    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "PATCH"]);
    assert.equal(calls[1]?.url.searchParams.get("page"), "2");
    assert.equal(calls[2]?.url.pathname, "/api/v3/repos/acme/widget/issues/comments/501");
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("rejects unsafe, malformed, and unbounded idempotent comment scans", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_IDEMPOTENT_COMMENT_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "mutation-token";
  const provider = {
    owner: "acme",
    repo: "widget",
    endpoint: "https://github.example/api/v3",
    token: `$${tokenVariable}`,
  };
  const key = TEST_IDEMPOTENCY_KEY;
  const mutation: IssueMutation = { kind: "comment", body: "Current result", idempotencyKey: key };

  try {
    const invalidLinks = [
      ["https://evil.example/api/v3/repos/acme/widget/issues/7/comments?per_page=100&page=2", /configured API origin/],
      ["https://github.example/api/v3/repos/acme/widget/issues/8/comments?per_page=100&page=2", /issue comments path/],
      ["https://user:password@github.example/api/v3/repos/acme/widget/issues/7/comments?per_page=100&page=2", /must not contain credentials/],
      ["https://github.example/api/v3/repos/acme/widget/issues/7/comments?per_page=100&page=3", /advance by one/],
      ["https://github.example/api/v3/repos/acme/widget/issues/7/comments?per_page=99&page=2", /advance by one/],
    ] as const;
    for (const [link, error] of invalidLinks) {
      const tracker = new GitHubTracker(
        provider,
        async () => Response.json([], { headers: { Link: `<${link}>; rel=\"next\"` } }),
      );
      await assert.rejects(
        tracker.mutateIssue(issue(), mutation, new AbortController().signal),
        error,
      );
    }

    for (const [payload, error] of [
      [{ comments: [] }, /non-array issue comment list/],
      [[{ id: 0, body: "invalid" }], /invalid issue comment/],
    ] as const) {
      const tracker = new GitHubTracker(provider, async () => Response.json(payload));
      await assert.rejects(
        tracker.mutateIssue(issue(), mutation, new AbortController().signal),
        error,
      );
    }

    let pages = 0;
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "Other" }));
    const unbounded = new GitHubTracker(provider, async () => {
      pages += 1;
      return Response.json(fullPage);
    });
    await assert.rejects(
      unbounded.mutateIssue(issue(), mutation, new AbortController().signal),
      /pagination exceeded 100 pages/,
    );
    assert.equal(pages, 100);
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("requires authentication and validates issue binding and mutation payloads", async () => {
  const signal = new AbortController().signal;
  const unauthenticated = new GitHubTracker(
    { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
    async () => {
      throw new Error("must not call fetch");
    },
  );
  await assert.rejects(
    unauthenticated.mutateIssue(issue(), { kind: "set_state", state: "closed" }, signal),
    /mutations require an authentication token/,
  );

  const tokenVariable = "SYMPHONY_GITHUB_MUTATION_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "mutation-token";
  try {
    const tracker = new GitHubTracker(
      { owner: "acme", repo: "widget", token: `$${tokenVariable}` },
      async () => {
        throw new Error("must not call fetch");
      },
    );
    const invalidIssues = [
      issue(7, { id: "07" }),
      issue(7, { nativeRef: null }),
      issue(7, { nativeRef: { owner: "other", repo: "widget", number: 7 } }),
      issue(7, { nativeRef: { owner: "acme", repo: "widget", number: 8 } }),
    ];
    for (const invalidIssue of invalidIssues) {
      await assert.rejects(
        tracker.mutateIssue(invalidIssue, { kind: "set_state", state: "closed" }, signal),
        /GitHub mutation issue/,
      );
    }

    const invalidMutations: unknown[] = [
      null,
      { kind: "comment", body: " " },
      { kind: "comment", body: "x".repeat(65_537) },
      { kind: "comment", body: "valid", idempotencyKey: " unsafe" },
      { kind: "comment", body: "valid", idempotencyKey: "<raw-marker>" },
      { kind: "comment", body: "valid", idempotencyKey: "123e4567-e89b-32d3-a456-426614174000" },
      { kind: "comment", body: "x".repeat(65_536), idempotencyKey: TEST_IDEMPOTENCY_KEY },
      { kind: "add_label", label: " " },
      { kind: "remove_label", label: "x".repeat(51) },
      { kind: "set_state", state: "merged" },
      { kind: "delete_issue" },
    ];
    for (const mutation of invalidMutations) {
      await assert.rejects(
        tracker.mutateIssue(issue(), mutation as IssueMutation, signal),
        /GitHub issue|GitHub mutation|Unsupported GitHub/,
      );
    }
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("combines caller aborts with its timeout and redacts failed mutation details", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_MUTATION_TEST_TOKEN";
  const token = "mutation-token-must-not-appear";
  const body = "comment-body-must-not-appear";
  const idempotencyKey = TEST_IDEMPOTENCY_KEY;
  const rawResponse = "raw-response-must-not-appear";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = token;
  const provider = { owner: "acme", repo: "widget", token: `$${tokenVariable}` };

  try {
    const failed = new GitHubTracker(provider, async () => {
      throw new Error(`${token} ${body}`);
    });
    await assert.rejects(
      failed.mutateIssue(issue(), { kind: "comment", body }, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GitHub API POST .* failed$/);
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, new RegExp(body));
        return true;
      },
    );

    const failedUpsert = new GitHubTracker(provider, async () => {
      throw new Error(`${token} ${body} ${idempotencyKey}`);
    });
    await assert.rejects(
      failedUpsert.mutateIssue(
        issue(),
        { kind: "comment", body, idempotencyKey },
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GitHub API GET .* failed$/);
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, new RegExp(body));
        assert.doesNotMatch(error.message, new RegExp(idempotencyKey));
        return true;
      },
    );

    const rejected = new GitHubTracker(
      provider,
      async () => new Response(rawResponse, { status: 422 }),
    );
    await assert.rejects(
      rejected.mutateIssue(issue(), { kind: "comment", body }, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed with HTTP 422/);
        assert.doesNotMatch(error.message, new RegExp(rawResponse));
        assert.doesNotMatch(error.message, new RegExp(body));
        return true;
      },
    );

    let preAbortedFetchCalled = false;
    const preAborted = new GitHubTracker(provider, async () => {
      preAbortedFetchCalled = true;
      return new Response(null, { status: 204 });
    });
    const preAbortedController = new AbortController();
    preAbortedController.abort(new Error(`${token} ${body}`));
    await assert.rejects(
      preAborted.mutateIssue(issue(), { kind: "comment", body }, preAbortedController.signal),
      /was aborted$/,
    );
    assert.equal(preAbortedFetchCalled, false);

    let requestSignal: AbortSignal | null | undefined;
    const waiting = new GitHubTracker(
      provider,
      (_input, init) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (requestSignal?.aborted) reject(requestSignal.reason);
          else requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        });
      },
    );
    const controller = new AbortController();
    const pending = waiting.mutateIssue(issue(), { kind: "comment", body }, controller.signal);
    controller.abort(new Error(`${token} ${body}`));
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /was aborted$/);
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.doesNotMatch(error.message, new RegExp(body));
      return true;
    });
    assert.ok(requestSignal instanceof AbortSignal);
    assert.notEqual(requestSignal, controller.signal);
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("publishes a deterministic branch and creates a GitHub pull request", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_PUBLISH_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "publish-token";
  const calls: Array<{ url: URL; method: string | undefined; body: string | undefined }> = [];
  let publisherOptions: unknown;

  try {
    const tracker = new GitHubTracker(
      {
        owner: "acme",
        repo: "widget",
        token: `$${tokenVariable}`,
        base_branch: "main",
      },
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return init?.method === "POST"
          ? Response.json({ number: 12, html_url: "https://github.com/acme/widget/pull/12" }, { status: 201 })
          : Response.json([]);
      },
      async (options) => {
        publisherOptions = options;
        return {
          branch: options.branch,
          baseBranch: options.baseBranch ?? "unexpected",
          commitSha: "0123456789012345678901234567890123456789",
        };
      },
    );
    const signal = new AbortController().signal;
    const result = await tracker.publishIssueChange(
      issue(),
      "/private/workspace/issue-7",
      {
        commitMessage: "Implement issue 7",
        pullRequestTitle: "Implement issue 7",
        pullRequestBody: "Closes #7",
      },
      signal,
    );

    assert.deepEqual(publisherOptions, {
      workspacePath: "/private/workspace/issue-7",
      expectedOwner: "acme",
      expectedRepo: "widget",
      expectedHost: "github.com",
      pushUrl: "https://github.com/acme/widget.git",
      token: "publish-token",
      branch: "symphony/issue-7",
      baseBranch: "main",
      commitMessage: "Implement issue 7",
      signal,
    });
    assert.deepEqual(result, {
      url: "https://github.com/acme/widget/pull/12",
      number: 12,
      branch: "symphony/issue-7",
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url.pathname, "/repos/acme/widget/pulls");
    assert.deepEqual(Object.fromEntries(calls[0]?.url.searchParams ?? []), {
      state: "open",
      head: "acme:symphony/issue-7",
      base: "main",
      per_page: "100",
    });
    assert.deepEqual(
      { method: calls[1]?.method, path: calls[1]?.url.pathname, body: calls[1]?.body },
      {
        method: "POST",
        path: "/repos/acme/widget/pulls",
        body: JSON.stringify({
          title: "Implement issue 7",
          body: "Closes #7",
          head: "symphony/issue-7",
          base: "main",
        }),
      },
    );
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("uses an explicit enterprise git URL and updates the exact existing pull request", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_PUBLISH_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "publish-token";
  const calls: Array<{ url: URL; method: string | undefined; body: string | undefined }> = [];
  let publisherOptions: unknown;

  try {
    const tracker = new GitHubTracker(
      {
        owner: "acme",
        repo: "widget",
        endpoint: "https://api.github.example/api/v3",
        git_url: "https://git.github.example:8443/acme/widget.git",
        token: `$${tokenVariable}`,
      },
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return init?.method === "PATCH"
          ? Response.json({ number: 41, html_url: "https://git.github.example:8443/acme/widget/pull/41" })
          : Response.json([{ number: 41, html_url: "https://git.github.example:8443/acme/widget/pull/41" }]);
      },
      async (options) => {
        publisherOptions = options;
        return {
          branch: options.branch,
          baseBranch: "develop",
          commitSha: "0123456789012345678901234567890123456789",
        };
      },
    );
    const signal = new AbortController().signal;
    const result = await tracker.publishIssueChange(
      issue(),
      "/private/workspace/issue-7",
      {
        commitMessage: "Refresh issue 7",
        pullRequestTitle: "Updated title",
        pullRequestBody: "Updated body",
      },
      signal,
    );

    assert.deepEqual(publisherOptions, {
      workspacePath: "/private/workspace/issue-7",
      expectedOwner: "acme",
      expectedRepo: "widget",
      expectedHost: "git.github.example:8443",
      pushUrl: "https://git.github.example:8443/acme/widget.git",
      token: "publish-token",
      branch: "symphony/issue-7",
      commitMessage: "Refresh issue 7",
      signal,
    });
    assert.deepEqual(result, {
      url: "https://git.github.example:8443/acme/widget/pull/41",
      number: 41,
      branch: "symphony/issue-7",
    });
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH"]);
    assert.equal(calls[0]?.url.searchParams.get("head"), "acme:symphony/issue-7");
    assert.equal(calls[0]?.url.searchParams.get("base"), "develop");
    assert.deepEqual(
      { path: calls[1]?.url.pathname, body: calls[1]?.body },
      {
        path: "/api/v3/repos/acme/widget/pulls/41",
        body: JSON.stringify({ title: "Updated title", body: "Updated body" }),
      },
    );
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("recovers a create race by re-querying once and updating the winner", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_PUBLISH_TEST_TOKEN";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = "publish-token";
  let request = 0;
  const methods: Array<string | undefined> = [];

  try {
    const tracker = new GitHubTracker(
      { owner: "acme", repo: "widget", token: `$${tokenVariable}` },
      async (_input, init) => {
        request += 1;
        methods.push(init?.method);
        if (request === 1) return Response.json([]);
        if (request === 2) return new Response("validation details", { status: 422 });
        if (request === 3) {
          return Response.json([{ number: 9, html_url: "https://github.com/acme/widget/pull/9" }]);
        }
        return Response.json({ number: 9, html_url: "https://github.com/acme/widget/pull/9" });
      },
      async (options) => ({
        branch: options.branch,
        baseBranch: "main",
        commitSha: "0123456789012345678901234567890123456789",
      }),
    );
    const result = await tracker.publishIssueChange(
      issue(),
      "/private/workspace/issue-7",
      { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: "Body" },
      new AbortController().signal,
    );

    assert.deepEqual(methods, ["GET", "POST", "GET", "PATCH"]);
    assert.deepEqual(result, {
      url: "https://github.com/acme/widget/pull/9",
      number: 9,
      branch: "symphony/issue-7",
    });
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("validates and redacts GitHub publishing boundaries", async () => {
  const tokenVariable = "SYMPHONY_GITHUB_PUBLISH_TEST_TOKEN";
  const token = "publish-token-must-not-appear";
  const body = "pull-body-must-not-appear";
  const rawResponse = "raw-response-must-not-appear";
  const previousToken = process.env[tokenVariable];
  process.env[tokenVariable] = token;

  try {
    const invalidGitUrls = [
      "http://github.example/acme/widget.git",
      "https://user:password@github.example/acme/widget.git",
      "https://github.example/acme/widget.git?token=secret",
      "https://github.example/acme/other.git",
      "https://github.example/api/v3/acme/widget.git",
    ];
    for (const gitUrl of invalidGitUrls) {
      assert.throws(
        () => new GitHubTracker({ owner: "acme", repo: "widget", git_url: gitUrl }),
        /provider\.git_url must be a safe HTTPS repository URL/,
      );
    }

    const provider = { owner: "acme", repo: "widget", token: `$${tokenVariable}` };
    const neverFetch: typeof fetch = async () => {
      throw new Error("must not call fetch");
    };
    const successfulPublisher: NonNullable<ConstructorParameters<typeof GitHubTracker>[2]> = async (options) => ({
      branch: options.branch,
      baseBranch: "main",
      commitSha: "0123456789012345678901234567890123456789",
    });
    const tracker = new GitHubTracker(provider, neverFetch, successfulPublisher);
    const signal = new AbortController().signal;
    await assert.rejects(
      tracker.publishIssueChange(
        issue(7, { nativeRef: { owner: "other", repo: "widget", number: 7 } }),
        "/workspace",
        { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: body },
        signal,
      ),
      /GitHub mutation issue/,
    );
    await assert.rejects(
      tracker.publishIssueChange(
        issue(),
        "/workspace",
        { commitMessage: " ", pullRequestTitle: "Title", pullRequestBody: body },
        signal,
      ),
      /commit message must be 1-200 characters/,
    );
    await assert.rejects(
      tracker.publishIssueChange(
        issue(),
        "/workspace",
        { commitMessage: "Publish", pullRequestTitle: "x".repeat(257), pullRequestBody: body },
        signal,
      ),
      /pull request title must be 1-256 characters/,
    );

    const customWithoutGitUrl = new GitHubTracker(
      {
        owner: "acme",
        repo: "widget",
        endpoint: "https://github.example/api/v3",
        token: `$${tokenVariable}`,
      },
      neverFetch,
      successfulPublisher,
    );
    await assert.rejects(
      customWithoutGitUrl.publishIssueChange(
        issue(),
        "/workspace",
        { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: body },
        signal,
      ),
      /custom API endpoint requires provider\.git_url/,
    );

    const noToken = new GitHubTracker(
      {
        owner: "acme",
        repo: "widget",
        endpoint: "https://github.example/api/v3",
        git_url: "https://github.example/acme/widget.git",
      },
      neverFetch,
      successfulPublisher,
    );
    await assert.rejects(
      noToken.publishIssueChange(
        issue(),
        "/workspace",
        { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: body },
        signal,
      ),
      /publishing requires an authentication token/,
    );

    const publisherFailure = new GitHubTracker(provider, neverFetch, async () => {
      throw new Error(`${token} ${body}`);
    });
    await assert.rejects(
      publisherFailure.publishIssueChange(
        issue(),
        "/workspace",
        { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: body },
        signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "GitHub git publishing failed");
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, new RegExp(body));
        return true;
      },
    );

    let preAbortedPublisherCalled = false;
    const preAborted = new GitHubTracker(provider, neverFetch, async (options) => {
      preAbortedPublisherCalled = true;
      return {
        branch: options.branch,
        baseBranch: "main",
        commitSha: "0123456789012345678901234567890123456789",
      };
    });
    const controller = new AbortController();
    controller.abort(new Error(`${token} ${body}`));
    await assert.rejects(
      preAborted.publishIssueChange(
        issue(),
        "/workspace",
        { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: body },
        controller.signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "GitHub git publishing was aborted");
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, new RegExp(body));
        return true;
      },
    );
    assert.equal(preAbortedPublisherCalled, false);

    let restFailureCalls = 0;
    const restFailure = new GitHubTracker(
      provider,
      async () => {
        restFailureCalls += 1;
        return restFailureCalls === 1
          ? Response.json([])
          : new Response(rawResponse, { status: 500 });
      },
      successfulPublisher,
    );
    await assert.rejects(
      restFailure.publishIssueChange(
        issue(),
        "/workspace",
        { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: body },
        signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GitHub API POST .* failed with HTTP 500/);
        assert.doesNotMatch(error.message, new RegExp(token));
        assert.doesNotMatch(error.message, new RegExp(body));
        assert.doesNotMatch(error.message, new RegExp(rawResponse));
        return true;
      },
    );
    assert.equal(restFailureCalls, 2);

    for (const invalidPull of [
      { number: 0, html_url: "https://github.com/acme/widget/pull/0" },
      { number: 3, html_url: "javascript:alert(1)" },
      { number: 3, html_url: "https://evil.example/acme/widget/pull/3" },
    ]) {
      let calls = 0;
      const invalidResponse = new GitHubTracker(
        provider,
        async () => {
          calls += 1;
          return calls === 1 ? Response.json([]) : Response.json(invalidPull);
        },
        successfulPublisher,
      );
      await assert.rejects(
        invalidResponse.publishIssueChange(
          issue(),
          "/workspace",
          { commitMessage: "Publish", pullRequestTitle: "Title", pullRequestBody: body },
          signal,
        ),
        /returned an invalid pull request/,
      );
    }
  } finally {
    if (previousToken === undefined) delete process.env[tokenVariable];
    else process.env[tokenVariable] = previousToken;
  }
});

test("reads the Link relation from its parameters, not from the target URL", async () => {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url);
    if (urls.length === 1) {
      const next =
        "https://github.example/api/v3/repos/acme/widget/issues?state=all&per_page=100&page=2&x=a;rel=prev";
      return Response.json([rawIssue(1)], { headers: { Link: `<${next}>; rel="next"` } });
    }
    return Response.json([rawIssue(2)]);
  };
  const tracker = new GitHubTracker(
    { owner: "acme", repo: "widget", endpoint: "https://github.example/api/v3" },
    fetchImpl,
  );

  const issues = await tracker.fetchIssuesByStates(["all"]);

  assert.deepEqual(issues.map(({ id }) => id), ["1", "2"]);
  assert.equal(urls.length, 2);
  assert.equal(urls[1]?.searchParams.get("page"), "2");
});
