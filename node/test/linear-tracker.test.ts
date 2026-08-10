import assert from "node:assert/strict";
import { test } from "vitest";
import type { LinearClientOptions } from "@linear/sdk";
import {
  LinearTracker,
  type LinearClientLike,
  type LinearTrackerDependencies,
  validateLinearProvider,
} from "../src/trackers/linear.js";
import type { Issue, IssueMutation } from "../src/domain.js";
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
  mutationClient: Partial<Omit<LinearClientLike, "client">> = {},
) {
  const requests: CapturedRequest[] = [];
  const clientOptions: LinearClientOptions[] = [];
  const dependencies: LinearTrackerDependencies = {
    clientFactory: (options) => {
      clientOptions.push(options);
      const unexpectedMutation = async (): Promise<never> => {
        assert.fail("unexpected Linear mutation SDK call");
      };
      return {
        client: {
          rawRequest: async (query, variables = {}) => {
            requests.push({ query, variables });
            return handler(query, variables);
          },
        },
        issue: unexpectedMutation,
        comments: unexpectedMutation,
        workflowStates: unexpectedMutation,
        issueLabels: unexpectedMutation,
        createComment: unexpectedMutation,
        updateComment: unexpectedMutation,
        updateIssue: unexpectedMutation,
        issueAddLabel: unexpectedMutation,
        issueRemoveLabel: unexpectedMutation,
        ...mutationClient,
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

function boundIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    nativeRef: null,
    identifier: "SYM-1",
    title: "Issue 1",
    description: "Description 1",
    priority: 2,
    state: "Todo",
    branchName: "sym-1",
    url: "https://linear.app/acme/issue/SYM-1",
    assigneeId: "worker-1",
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function currentLinearIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "SYM-1",
    archivedAt: null,
    trashed: false,
    assigneeId: "worker-1",
    labelIds: ["label-existing"],
    projectId: "project-1",
    stateId: "state-todo",
    teamId: "team-1",
    project: Promise.resolve({ id: "project-1", slugId: "symphony" }),
    ...overrides,
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
    assert.deepEqual(runtime.requests[0]?.variables.assigneeFilter, {});
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
    const tracker = createRegisteredTracker("linear", provider, { terminalStates: ["Released"] });
    assert.ok(tracker instanceof LinearTracker);
    assert.equal(tracker.issueStateMutationMode, "named");
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

test("maps bound issue mutations to typed Linear SDK methods", async () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const commentKey = "018f5f1b-0d2e-4c3a-8b7d-9e6f5a4b3c2d";
  const { tracker, clientOptions } = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async (id) => {
        calls.push({ name: "issue", args: [id] });
        return currentLinearIssue();
      },
      comments: async (variables) => {
        calls.push({ name: "comments", args: [variables] });
        return { nodes: [], pageInfo: { hasNextPage: false } };
      },
      workflowStates: async (variables) => {
        calls.push({ name: "workflowStates", args: [variables] });
        return {
          nodes: [{ id: "state-review", name: "Human Review", teamId: "team-1", archivedAt: null }],
          pageInfo: { hasNextPage: false },
        };
      },
      issueLabels: async (variables) => {
        calls.push({ name: "issueLabels", args: [variables] });
        const filter = variables.filter as { name: { eqIgnoreCase: string } };
        const suffix = filter.name.eqIgnoreCase.toLowerCase();
        return {
          nodes: [{ id: `label-${suffix}`, name: filter.name.eqIgnoreCase, isGroup: false }],
          pageInfo: { hasNextPage: false },
        };
      },
      createComment: async (input) => {
        calls.push({ name: "createComment", args: [input] });
        return { success: true, commentId: typeof input.id === "string" ? input.id : "comment-1" };
      },
      updateIssue: async (id, input) => {
        calls.push({ name: "updateIssue", args: [id, input] });
        return { success: true, issueId: id };
      },
      issueAddLabel: async (id, labelId) => {
        calls.push({ name: "issueAddLabel", args: [id, labelId] });
        return { success: true, issueId: id };
      },
      issueRemoveLabel: async (id, labelId) => {
        calls.push({ name: "issueRemoveLabel", args: [id, labelId] });
        return { success: true, issueId: id };
      },
    },
  );
  const issue = boundIssue();
  const signal = new AbortController().signal;

  await tracker.mutateIssue(issue, { kind: "comment", body: "Verified manually" }, signal);
  await tracker.mutateIssue(
    issue,
    { kind: "comment", body: "Durable handoff", idempotencyKey: commentKey },
    signal,
  );
  await tracker.mutateIssue(issue, { kind: "set_state", state: " Human Review " }, signal);
  await tracker.mutateIssue(issue, { kind: "add_label", label: " Review " }, signal);
  await tracker.mutateIssue(issue, { kind: "remove_label", label: " Existing " }, signal);

  assert.equal(clientOptions.length, 5);
  assert.ok(clientOptions.every(({ signal: operationSignal }) => operationSignal instanceof AbortSignal));
  assert.deepEqual(calls.filter(({ name }) => name === "issue").map(({ args }) => args), [
    ["issue-1"], ["issue-1"], ["issue-1"], ["issue-1"], ["issue-1"],
  ]);
  assert.deepEqual(calls.filter(({ name }) => name === "createComment").map(({ args }) => args), [
    [{ issueId: "issue-1", body: "Verified manually" }],
    [{ issueId: "issue-1", body: "Durable handoff", id: commentKey }],
  ]);
  assert.deepEqual(calls.find(({ name }) => name === "comments")?.args, [{
    first: 2,
    includeArchived: true,
    filter: { id: { eq: commentKey } },
  }]);
  assert.deepEqual(calls.find(({ name }) => name === "workflowStates")?.args, [{
    first: 2,
    includeArchived: false,
    filter: {
      name: { eqIgnoreCase: "Human Review" },
      team: { id: { eq: "team-1" } },
    },
  }]);
  assert.deepEqual(calls.find(({ name }) => name === "updateIssue")?.args, [
    "issue-1",
    { stateId: "state-review" },
  ]);
  assert.deepEqual(calls.filter(({ name }) => name === "issueLabels").length, 2);
  assert.deepEqual(calls.find(({ name }) => name === "issueAddLabel")?.args, ["issue-1", "label-review"]);
  assert.deepEqual(calls.find(({ name }) => name === "issueRemoveLabel")?.args, ["issue-1", "label-existing"]);
});

test("rejects malformed Linear mutation payloads before creating an SDK client", async () => {
  const { tracker, clientOptions } = createTracker(
    () => assert.fail("invalid mutations must not make a Linear request"),
  );
  const invalid = [
    { kind: "comment", body: "   " },
    { kind: "comment", body: "safe", idempotencyKey: "not-a-uuid" },
    { kind: "add_label", label: "x".repeat(51) },
    { kind: "set_state", state: " " },
    { kind: "comment", body: "safe", issueId: "issue-2" },
  ] as unknown as IssueMutation[];
  for (const mutation of invalid) {
    await assert.rejects(
      tracker.mutateIssue(boundIssue(), mutation, new AbortController().signal),
      /Invalid Linear issue mutation/,
    );
  }
  assert.equal(clientOptions.length, 0);
});

test("makes typed Linear mutations convergent and fails closed on ambiguous targets", async () => {
  const commentKey = "018f5f1b-0d2e-4c3a-8b7d-9e6f5a4b3c2d";
  const writes: string[] = [];
  let existingBody = "already current";
  const { tracker } = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => currentLinearIssue({ stateId: "state-review" }),
      comments: async () => ({
        nodes: [{ id: commentKey, issueId: "issue-1", body: existingBody }],
        pageInfo: { hasNextPage: false },
      }),
      workflowStates: async () => ({
        nodes: [{ id: "state-review", name: "Review", teamId: "team-1", archivedAt: null }],
        pageInfo: { hasNextPage: false },
      }),
      issueLabels: async (variables) => {
        const filter = variables.filter as { name: { eqIgnoreCase: string } };
        const id = filter.name.eqIgnoreCase === "Existing" ? "label-existing" : "label-absent";
        return {
          nodes: [{ id, name: filter.name.eqIgnoreCase, isGroup: false, teamId: "team-1" }],
          pageInfo: { hasNextPage: false },
        };
      },
      updateComment: async (id, input) => {
        writes.push(`comment:${String(input.body)}`);
        return { success: true, commentId: id };
      },
      updateIssue: async () => {
        writes.push("state");
        return { success: true, issueId: "issue-1" };
      },
      issueAddLabel: async () => {
        writes.push("add");
        return { success: true, issueId: "issue-1" };
      },
      issueRemoveLabel: async () => {
        writes.push("remove");
        return { success: true, issueId: "issue-1" };
      },
    },
  );
  const signal = new AbortController().signal;
  await tracker.mutateIssue(boundIssue(), {
    kind: "comment",
    body: "already current",
    idempotencyKey: commentKey,
  }, signal);
  existingBody = "stale";
  await tracker.mutateIssue(boundIssue(), {
    kind: "comment",
    body: "replacement",
    idempotencyKey: commentKey,
  }, signal);
  await tracker.mutateIssue(boundIssue(), { kind: "set_state", state: "Review" }, signal);
  await tracker.mutateIssue(boundIssue(), { kind: "add_label", label: "Existing" }, signal);
  await tracker.mutateIssue(boundIssue(), { kind: "remove_label", label: "Absent" }, signal);
  assert.deepEqual(writes, ["comment:replacement"]);

  const ambiguous = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => currentLinearIssue(),
      workflowStates: async () => ({
        nodes: [
          { id: "state-1", name: "Review", teamId: "team-1" },
          { id: "state-2", name: "Review", teamId: "team-1" },
        ],
        pageInfo: { hasNextPage: false },
      }),
    },
  ).tracker;
  await assert.rejects(
    ambiguous.mutateIssue(boundIssue(), { kind: "set_state", state: "Review" }, signal),
    /Linear issue mutation failed/,
  );
});

test("revalidates guarded Linear state mutations immediately before writing", async () => {
  const finalIssue = (overrides: Record<string, unknown> = {}) => rawIssue("issue-1", {
    identifier: "SYM-1",
    labels: { nodes: [] },
    ...overrides,
  });
  const mutationClient = (
    write: () => void,
    stateId = "state-todo",
  ): Partial<Omit<LinearClientLike, "client">> => ({
    issue: async () => currentLinearIssue({ stateId }),
    workflowStates: async () => ({
      nodes: [{ id: "state-review", name: "Review", teamId: "team-1" }],
      pageInfo: { hasNextPage: false },
    }),
    updateIssue: async () => {
      write();
      return { success: true, issueId: "issue-1" };
    },
  });

  let writes = 0;
  const matching = createTracker(
    () => issuePage([finalIssue()]),
    {},
    undefined,
    mutationClient(() => { writes += 1; }, "state-review"),
  );
  await matching.tracker.mutateIssue(
    boundIssue(),
    { kind: "set_state", state: "Review" },
    new AbortController().signal,
    { requireUnchanged: true },
  );
  assert.equal(writes, 1);
  assert.equal(matching.requests.length, 1);
  assert.equal(matching.clientOptions.length, 2);
  assert.equal(matching.clientOptions[0]?.signal, matching.clientOptions[1]?.signal);

  const activeBlocker = {
    type: "blocks",
    issue: { id: "blocker-1", identifier: "SYM-9", state: { name: "In Progress" } },
  };
  const drifted = [
    { issue: finalIssue({ state: { name: "Done" } }) },
    { issue: finalIssue({ labels: { nodes: [{ name: "backend" }] } }) },
    { issue: finalIssue({ inverseRelations: { nodes: [activeBlocker], pageInfo: { hasNextPage: false } } }) },
    { issue: finalIssue({ updatedAt: "2026-01-03T00:00:00Z" }) },
    { issue: finalIssue({ state: { name: "Done" } }), sdkStateId: "state-review" },
  ];
  for (const { issue: current, sdkStateId } of drifted) {
    const guarded = createTracker(
      () => issuePage([current]),
      {},
      undefined,
      mutationClient(() => { writes += 1; }, sdkStateId),
    ).tracker;
    await assert.rejects(
      guarded.mutateIssue(
        boundIssue(),
        { kind: "set_state", state: "Review" },
        new AbortController().signal,
        { requireUnchanged: true },
      ),
      /Linear issue mutation failed/,
    );
  }
  assert.equal(writes, 1, "routing drift must never reach updateIssue");
});

test("rejects stale, aborted, and invalid Linear mutation results without leaking provider data", async () => {
  const secret = "linear-secret-body";
  let writes = 0;
  const moved = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => currentLinearIssue({
        project: Promise.resolve({ id: "project-2", slugId: "other-project" }),
      }),
      createComment: async () => {
        writes += 1;
        return { success: true, commentId: "comment-1" };
      },
    },
  ).tracker;
  await assert.rejects(
    moved.mutateIssue(boundIssue(), { kind: "comment", body: secret }, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Linear issue mutation failed");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.equal(writes, 0);

  const wrongTarget = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => currentLinearIssue({ id: "issue-2", identifier: "SYM-2" }),
      createComment: async () => {
        writes += 1;
        return { success: true, commentId: "comment-2" };
      },
    },
  ).tracker;
  await assert.rejects(
    wrongTarget.mutateIssue(boundIssue(), { kind: "comment", body: "safe" }, new AbortController().signal),
    /Linear issue mutation failed/,
  );
  assert.equal(writes, 0, "a mismatched SDK issue must never reach a write");

  const controller = new AbortController();
  const aborted = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => {
        controller.abort(new Error(secret));
        throw new Error(secret);
      },
    },
  ).tracker;
  await assert.rejects(
    aborted.mutateIssue(boundIssue(), { kind: "comment", body: "safe" }, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Linear issue mutation was aborted");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  const invalidPayload = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => currentLinearIssue(),
      workflowStates: async () => ({
        nodes: [{ id: "state-review", name: "Review", teamId: "team-1" }],
        pageInfo: { hasNextPage: false },
      }),
      updateIssue: async () => ({ success: true, issueId: "issue-2" }),
    },
  ).tracker;
  await assert.rejects(
    invalidPayload.mutateIssue(boundIssue(), { kind: "set_state", state: "Review" }, new AbortController().signal),
    /Linear issue mutation failed/,
  );

  const wrongTeam = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => currentLinearIssue(),
      workflowStates: async () => ({
        nodes: [{ id: "state-review", name: "Review", teamId: "team-2" }],
        pageInfo: { hasNextPage: false },
      }),
      updateIssue: async () => {
        writes += 1;
        return { success: true, issueId: "issue-1" };
      },
    },
  ).tracker;
  await assert.rejects(
    wrongTeam.mutateIssue(boundIssue(), { kind: "set_state", state: "Review" }, new AbortController().signal),
    /Linear issue mutation failed/,
  );
  assert.equal(writes, 0, "a state from another team must never reach a write");

  const lookupAbort = new AbortController();
  const abortedAfterLookup = createTracker(
    () => assert.fail("mutations must not use raw GraphQL"),
    {},
    undefined,
    {
      issue: async () => currentLinearIssue(),
      workflowStates: async () => {
        lookupAbort.abort(new Error(secret));
        return {
          nodes: [{ id: "state-review", name: "Review", teamId: "team-1" }],
          pageInfo: { hasNextPage: false },
        };
      },
      updateIssue: async () => {
        writes += 1;
        return { success: true, issueId: "issue-1" };
      },
    },
  ).tracker;
  await assert.rejects(
    abortedAfterLookup.mutateIssue(boundIssue(), { kind: "set_state", state: "Review" }, lookupAbort.signal),
    /Linear issue mutation was aborted/,
  );
  assert.equal(writes, 0, "an aborted lookup must never reach a write");

  await assert.rejects(
    moved.mutateIssue(
      boundIssue({ nativeRef: { owner: "other" } }),
      { kind: "comment", body: "safe" },
      new AbortController().signal,
    ),
    /not bound to this Linear tracker/,
  );
});

test("uses the real Linear SDK contract for typed state mutation payloads", async () => {
  const environmentName = "SYMPHONY_LINEAR_MUTATION_SDK_TEST_KEY";
  const previousApiKey = process.env[environmentName];
  const originalFetch = globalThis.fetch;
  const operations: string[] = [];
  process.env[environmentName] = "test-secret";
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /\b(?:query|mutation)\s+(\w+)/u.exec(request.query)?.[1];
    assert.ok(operation);
    operations.push(operation);
    let data: Record<string, unknown>;
    if (operation === "issue") {
      data = {
        issue: {
          __typename: "Issue",
          id: "issue-1",
          identifier: "SYM-1",
          labelIds: [],
          archivedAt: null,
          trashed: false,
          team: { id: "team-1" },
          project: { id: "project-1" },
          assignee: { id: "worker-1" },
          state: { id: "state-todo" },
          sharedAccess: {
            isShared: false,
            sharedWithCount: 0,
            viewerHasOnlySharedAccess: false,
            disallowedIssueFields: [],
            sharedWithUsers: [],
          },
          reactions: [],
        },
      };
    } else if (operation === "project") {
      data = { project: { __typename: "Project", id: "project-1", slugId: "symphony" } };
    } else if (operation === "workflowStates") {
      data = {
        workflowStates: {
          nodes: [{
            __typename: "WorkflowState",
            id: "state-review",
            name: "Review",
            team: { id: "team-1" },
            archivedAt: null,
          }],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
          },
        },
      };
    } else if (operation === "updateIssue") {
      assert.deepEqual(request.variables, {
        id: "issue-1",
        input: { stateId: "state-review" },
      });
      data = {
        issueUpdate: {
          __typename: "IssuePayload",
          lastSyncId: 1,
          success: true,
          issue: { id: "issue-1" },
        },
      };
    } else {
      assert.fail(`unexpected Linear SDK operation ${operation}`);
    }
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const tracker = new LinearTracker({
      api_key: `$${environmentName}`,
      endpoint: "https://linear.invalid/graphql",
      project_slug: "symphony",
      assignee: "worker-1",
    });
    await tracker.mutateIssue(
      boundIssue(),
      { kind: "set_state", state: "Review" },
      new AbortController().signal,
    );
    assert.deepEqual(operations, ["issue", "project", "workflowStates", "updateIssue"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousApiKey === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previousApiKey;
  }
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
