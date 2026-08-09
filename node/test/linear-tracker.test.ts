import assert from "node:assert/strict";
import { test } from "vitest";
import type { LinearClientOptions } from "@linear/sdk";
import {
  LinearTracker,
  type LinearTrackerDependencies,
  validateLinearProvider,
} from "../src/trackers/linear.js";
import { createTracker as createRegisteredTracker, validateTrackerProvider } from "../src/trackers/registry.js";

interface CapturedRequest {
  query: string;
  variables: Record<string, unknown>;
}

type RequestHandler = (query: string, variables: Record<string, unknown>) => unknown | Promise<unknown>;
const TEST_KEY_ENVIRONMENT = "SYMPHONY_LINEAR_UNIT_TEST_KEY";

function createTracker(
  handler: RequestHandler,
  provider: Record<string, unknown> = {},
  terminalStates?: string[],
) {
  const requests: CapturedRequest[] = [];
  const clientOptions: LinearClientOptions[] = [];
  const dependencies: LinearTrackerDependencies = {
    clientFactory: (options) => {
      clientOptions.push(options);
      return {
        client: {
          rawRequest: async (query, variables = {}) => {
            requests.push({ query, variables });
            return handler(query, variables);
          },
        },
      };
    },
  };
  if (terminalStates !== undefined) dependencies.terminalStates = terminalStates;

  const previousApiKey = process.env[TEST_KEY_ENVIRONMENT];
  process.env[TEST_KEY_ENVIRONMENT] = "test-secret";
  try {
    const tracker = new LinearTracker(
      { api_key: `$${TEST_KEY_ENVIRONMENT}`, project_slug: "symphony", ...provider },
      dependencies,
    );
    return { tracker, requests, clientOptions };
  } finally {
    if (previousApiKey === undefined) delete process.env[TEST_KEY_ENVIRONMENT];
    else process.env[TEST_KEY_ENVIRONMENT] = previousApiKey;
  }
}

function rawIssue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    identifier: `SYM-${id}`,
    title: `Issue ${id}`,
    description: `Description ${id}`,
    priority: 2,
    state: { name: "Todo" },
    branchName: `sym-${id}`,
    url: `https://linear.app/acme/issue/SYM-${id}`,
    assignee: { id: "worker-1", isMe: false },
    labels: { nodes: [{ name: " Backend " }, { name: "backend" }, { name: " " }] },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00+00:00",
    ...overrides,
  };
}

function issuePage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

test("validates provider settings offline, resolves env keys at runtime, and skips empty reads", async () => {
  const environmentName = "SYMPHONY_LINEAR_TRACKER_TEST_KEY";
  const previous = process.env[environmentName];
  const previousDefault = process.env.LINEAR_API_KEY;
  delete process.env[environmentName];
  delete process.env.LINEAR_API_KEY;
  try {
    assert.doesNotThrow(() => validateLinearProvider({ api_key: `$${environmentName}`, project_slug: "project" }));
    assert.doesNotThrow(() => validateLinearProvider({ project_slug: "project" }));
    assert.throws(
      () => new LinearTracker({ project_slug: "project" }),
      /LINEAR_API_KEY is not set/,
    );
    assert.throws(
      () => new LinearTracker({ api_key: `$${environmentName}`, project_slug: "project" }),
      new RegExp(`${environmentName} is not set`),
    );

    process.env[environmentName] = " resolved-secret ";
    const { tracker, requests, clientOptions } = createTracker(
      () => assert.fail("empty reads must not make a Linear request"),
      { api_key: `$${environmentName}`, project_slug: " project ", assignee: "me" },
    );
    assert.deepEqual(await tracker.fetchIssuesByStates([]), []);
    assert.deepEqual(await tracker.fetchIssuesByIds([]), []);
    assert.equal(requests.length, 0);
    assert.equal(clientOptions.length, 0);

    const runtime = createTracker(
      () => issuePage([]),
      { api_key: `$${environmentName}`, project_slug: " project " },
    );
    assert.deepEqual(await runtime.tracker.fetchIssuesByStates(["Todo"]), []);
    assert.equal(runtime.clientOptions[0]?.apiKey, "resolved-secret");
    assert.equal(runtime.clientOptions[0]?.apiUrl, "https://api.linear.app/graphql");
    assert.ok(runtime.clientOptions[0]?.signal instanceof AbortSignal);
    assert.equal(runtime.clientOptions[0]?.signal?.aborted, false);
  } finally {
    if (previous === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previous;
    if (previousDefault === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = previousDefault;
  }

  assert.throws(
    () => validateLinearProvider({ api_key: "$LINEAR_API_KEY", project_slug: " " }),
    /provider\.project_slug/,
  );
  assert.throws(
    () => validateLinearProvider({ api_key: "$BAD-NAME", project_slug: "project" }),
    /must be an environment reference/,
  );
  assert.throws(
    () => validateLinearProvider({ api_key: "literal-key", project_slug: "project" }),
    /must be an environment reference/,
  );
  assert.throws(
    () => validateLinearProvider({ api_key: "$LINEAR_API_KEY", project_slug: "project", endpoint: "http://linear.test/graphql" }),
    /HTTPS URL/,
  );
  assert.throws(
    () => validateLinearProvider({ api_key: "key", project_slug: "project", extra: true }),
    /Unsupported Linear tracker provider option\(s\): extra/,
  );
});

test("registers Linear tracker construction and offline provider validation", () => {
  const previous = process.env[TEST_KEY_ENVIRONMENT];
  process.env[TEST_KEY_ENVIRONMENT] = "test-secret";
  const provider = { api_key: `$${TEST_KEY_ENVIRONMENT}`, project_slug: "symphony" };
  try {
    assert.doesNotThrow(() => validateTrackerProvider("linear", provider));
    assert.ok(createRegisteredTracker("linear", provider, { terminalStates: ["Released"] }) instanceof LinearTracker);
  } finally {
    if (previous === undefined) delete process.env[TEST_KEY_ENVIRONMENT];
    else process.env[TEST_KEY_ENVIRONMENT] = previous;
  }
});

test("paginates project states and produces complete normalized issues", async () => {
  const activeBlocker = {
    type: " blocks ",
    issue: { id: "blocker-1", identifier: "SYM-90", state: { name: "In Progress" } },
  };
  const terminalBlocker = {
    type: "blocks",
    issue: { id: "blocker-2", identifier: "SYM-91", state: { name: "Released" } },
  };
  const { tracker, requests, clientOptions } = createTracker(
    (_query, variables) => variables.after === null
      ? issuePage([
          rawIssue("1", {
            inverseRelations: {
              nodes: [activeBlocker, { type: "relatesTo", issue: { id: "ignored" } }],
              pageInfo: { hasNextPage: false },
            },
          }),
          rawIssue("bad", { title: " " }),
          rawIssue("done", { state: { name: "Done" } }),
        ], true, "cursor-1")
      : issuePage([
          rawIssue("2", {
            inverseRelations: { nodes: [terminalBlocker], pageInfo: { hasNextPage: false } },
            updatedAt: "not-a-timestamp",
          }),
          rawIssue("3", {
            inverseRelations: { nodes: [], pageInfo: { hasNextPage: true } },
          }),
          rawIssue("5", { inverseRelations: undefined }),
          rawIssue("6", {
            inverseRelations: {
              nodes: [{ type: "blocks", issue: null }],
              pageInfo: { hasNextPage: false },
            },
          }),
        ]),
    { assignee: " worker-1 " },
    ["Released"],
  );

  const issues = await tracker.fetchIssuesByStates([" Todo ", "todo", "In Progress"]);

  assert.deepEqual(issues.map(({ id }) => id), ["1", "2", "3", "5", "6"]);
  assert.deepEqual(issues[0], {
    id: "1",
    nativeRef: null,
    identifier: "SYM-1",
    title: "Issue 1",
    description: "Description 1",
    priority: 2,
    state: "Todo",
    branchName: "sym-1",
    url: "https://linear.app/acme/issue/SYM-1",
    assigneeId: "worker-1",
    labels: ["backend"],
    blockedBy: [{ id: "blocker-1", identifier: "SYM-90", state: "In Progress" }],
    dispatchable: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00+00:00",
  });
  assert.equal(issues[1]?.dispatchable, true, "terminal blockers do not block Todo");
  assert.equal(issues[1]?.updatedAt, null);
  assert.equal(issues[2]?.dispatchable, false, "a truncated blocker connection is conservative");
  assert.equal(issues[3]?.dispatchable, false, "missing blocker metadata is conservative");
  assert.equal(issues[4]?.dispatchable, false, "malformed blocks relations are conservative");
  assert.equal(requests.length, 2);
  assert.equal(clientOptions.length, 2);
  assert.notEqual(clientOptions[0]?.signal, clientOptions[1]?.signal);
  assert.match(requests[0]?.query ?? "", /SymphonyLinearPoll/);
  assert.match(requests[0]?.query ?? "", /inverseRelations[\s\S]*pageInfo/);
  assert.deepEqual(requests.map(({ variables }) => variables), [
    {
      projectSlug: "symphony",
      stateNames: ["Todo", "In Progress"],
      assigneeFilter: { id: { eq: "worker-1" } },
      first: 50,
      relationFirst: 50,
      after: null,
    },
    {
      projectSlug: "symphony",
      stateNames: ["Todo", "In Progress"],
      assigneeFilter: { id: { eq: "worker-1" } },
      first: 50,
      relationFirst: 50,
      after: "cursor-1",
    },
  ]);
});

test("pushes case-insensitive assignee 'me' routing into the Linear query", async () => {
  const { tracker, requests } = createTracker(() => issuePage([
    rawIssue("1", { assignee: { id: "viewer-1", isMe: true } }),
  ]), { assignee: " ME " });

  const issues = await tracker.fetchIssuesByStates(["Todo"]);
  assert.deepEqual(issues.map(({ dispatchable }) => dispatchable), [true]);
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.query ?? "", /SymphonyLinearPoll/);
  assert.deepEqual(requests[0]?.variables.assigneeFilter, { isMe: { eq: true } });

  const refresh = createTracker(() => ({
    data: { issues: { nodes: [rawIssue("1", { assignee: null, state: { name: "Done" } })] } },
  }), { assignee: "me" });
  const [unassigned] = await refresh.tracker.fetchIssuesByIds(["1"]);
  assert.equal(unassigned?.state, "Done");
  assert.equal(unassigned?.dispatchable, false);
  assert.equal(refresh.requests[0]?.variables.assigneeFilter, undefined);
});

test("batches opaque ID refreshes, deduplicates requests, and restores requested order", async () => {
  const ids = Array.from({ length: 55 }, (_, index) => `issue-${index + 1}`);
  const { tracker, requests } = createTracker((_query, variables) => ({
    data: {
      issues: {
        nodes: [...(variables.ids as string[])].reverse().map((id) => rawIssue(id)),
      },
    },
  }));

  const issues = await tracker.fetchIssuesByIds([...ids, ids[0] ?? ""]);
  assert.deepEqual(issues.map(({ id }) => id), ids);
  assert.equal(requests.length, 2);
  assert.match(requests[0]?.query ?? "", /SymphonyLinearIssuesById/);
  assert.deepEqual(requests[0]?.variables.ids, ids.slice(0, 50));
  assert.equal(requests[0]?.variables.first, 50);
  assert.deepEqual(requests[1]?.variables.ids, ids.slice(50));
  assert.equal(requests[1]?.variables.first, 5);

  const malformed = createTracker(() => ({
    data: { issues: { nodes: [rawIssue("issue-1", { identifier: " " })] } },
  })).tracker;
  await assert.rejects(malformed.fetchIssuesByIds(["issue-1"]), /malformed issue during ID refresh/);
});

test("rejects malformed or looping cursors and SDK failures without leaking the API key", async () => {
  const missing = createTracker(() => issuePage([], true, null)).tracker;
  await assert.rejects(missing.fetchIssuesByStates(["Todo"]), /missing endCursor/);

  let loopRequests = 0;
  const looping = createTracker(() => {
    loopRequests += 1;
    return issuePage([], true, "same-cursor");
  }).tracker;
  await assert.rejects(looping.fetchIssuesByStates(["Todo"]), /cursor loop detected/);
  assert.equal(loopRequests, 2);

  let pageRequests = 0;
  const endless = createTracker(() => {
    pageRequests += 1;
    return issuePage([], true, `cursor-${pageRequests}`);
  }).tracker;
  await assert.rejects(endless.fetchIssuesByStates(["Todo"]), /exceeded 1000 pages/);
  assert.equal(pageRequests, 1_000);

  const secret = "test-secret";
  const failed = createTracker(() => { throw new Error(`request Authorization=${secret}`); }).tracker;
  await assert.rejects(failed.fetchIssuesByStates(["Todo"]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Linear GraphQL request failed");
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });

  const environmentName = "SYMPHONY_LINEAR_REAL_SDK_TEST_KEY";
  const previousApiKey = process.env[environmentName];
  const originalFetch = globalThis.fetch;
  process.env[environmentName] = secret;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ errors: [{ message: `denied Authorization=${secret}` }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    const sdkTracker = new LinearTracker({
      api_key: `$${environmentName}`,
      endpoint: "https://linear.invalid/graphql",
      project_slug: "symphony",
    });
    await assert.rejects(sdkTracker.fetchIssuesByStates(["Todo"]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Linear GraphQL request failed");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiKey === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previousApiKey;
  }
});
