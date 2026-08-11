import assert from "node:assert/strict";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, onTestFinished, test } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { WorkflowStore } from "@ai-symphony/core/config/store.js";
import type { WorkflowDefinition } from "@ai-symphony/core/config/workflow.js";
import type { AgentDriver, AgentEvent, AgentRunContext, Issue, Tracker } from "@ai-symphony/core/domain.js";
import { createLogger } from "@ai-symphony/core/log.js";
import { Orchestrator, workflowScopeHash } from "../src/orchestrator.js";
import { RunStateStore, type PersistedClaim } from "@ai-symphony/core/state/store.js";
import { MemoryTracker } from "@ai-symphony/trackers/memory.js";
import { WorkspaceManager } from "@ai-symphony/core/workspace/manager.js";

const logger = createLogger("silent");
const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const completion = {
  status: "ready" as const,
  summary: "Implemented the requested fix.",
  verification: ["pnpm test"],
};
const posixTest = process.platform === "win32" ? test.skip : test;
const previousTrackerToken = process.env.RECOVERY_TRACKER_TOKEN;
process.env.RECOVERY_TRACKER_TOKEN = "recovery-test-token";
afterAll(() => {
  if (previousTrackerToken === undefined) delete process.env.RECOVERY_TRACKER_TOKEN;
  else process.env.RECOVERY_TRACKER_TOKEN = previousTrackerToken;
});

posixTest("reports a runtime checkpoint failure through readiness without dispatching work", async () => {
  const root = await fixture("symphony-recovery-fatal-");
  const raw = { ...rawIssue("fatal", "FATAL-1"), state: "Backlog" };
  const memory = new MemoryTracker({ issues: [raw] });
  const activeFetchStarted = deferred<void>();
  let rejectActiveFetch!: (reason?: unknown) => void;
  const activeFetch = new Promise<Issue[]>((_resolve, reject) => {
    rejectActiveFetch = reject;
  });
  let failActiveFetch = true;
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      if (failActiveFetch && states.includes("Todo")) {
        failActiveFetch = false;
        activeFetchStarted.resolve();
        return activeFetch;
      }
      return memory.fetchIssuesByStates(states);
    },
    async fetchIssuesByIds(ids) {
      return memory.fetchIssuesByIds(ids);
    },
  };
  let driverRuns = 0;
  const workflowPath = await writeMemoryWorkflow(root, [raw]);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver: driverFrom(async function* () {
      driverRuns += 1;
      yield event("turn_failed");
    }),
  });
  const fatalError = orchestrator.waitForFatalError();

  assert.equal(orchestrator.isReady(), false);
  const starting = orchestrator.start();
  await activeFetchStarted.promise;
  assert.equal(orchestrator.isReady(), false);
  rejectActiveFetch(new Error("transient tracker failure"));
  await starting;
  assert.equal(orchestrator.isReady(), true);

  await writeFile(path.join(root, "runs.json"), "not json\n", { mode: 0o600 });
  memory.setIssueState(raw.id, "Todo");
  let pollError: Error | undefined;
  await assert.rejects(orchestrator.pollOnce(), (error: unknown) => {
    assert.ok(error instanceof Error);
    pollError = error;
    return true;
  });

  assert.ok(pollError);
  assert.strictEqual(await fatalError, pollError);
  assert.strictEqual(await orchestrator.waitForFatalError(), pollError);
  assert.equal(orchestrator.isReady(), false);
  assert.equal(driverRuns, 0);

  await orchestrator.stop();
  assert.equal(orchestrator.isReady(), false);
});

posixTest("does not retain a fatal signal after a repaired checkpoint initialization failure", async () => {
  const root = await fixture("symphony-recovery-repaired-");
  const workflowPath = await writeMemoryWorkflow(root, []);
  const statePath = path.join(root, "runs.json");
  await writeFile(statePath, "not json\n", { mode: 0o600 });
  let driverRuns = 0;
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: new MemoryTracker(),
    driver: driverFrom(async function* () {
      driverRuns += 1;
      yield event("turn_failed");
    }),
  });
  const fatalError = orchestrator.waitForFatalError();

  await assert.rejects(orchestrator.start(), /Durable run state persistence failed/);
  assert.equal(orchestrator.isReady(), false);

  await rm(statePath);
  const replacement = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: new MemoryTracker(),
    driver: driverFrom(async function* () {
      yield event("turn_failed");
    }),
  });
  await replacement.initialize();
  await replacement.stop();

  await orchestrator.start();
  assert.equal(orchestrator.isReady(), true);
  assert.equal(driverRuns, 0);

  let fatalResolved = false;
  void fatalError.then(() => {
    fatalResolved = true;
  });
  await Promise.resolve();
  assert.equal(fatalResolved, false);

  await orchestrator.stop();
});

posixTest("holds one durable state lease until clean shutdown", async () => {
  const root = await fixture("symphony-recovery-exclusive-lease-");
  const workflowPath = await writeMemoryWorkflow(root, []);
  const first = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: new MemoryTracker(),
    driver: driverFrom(async function* () {
      assert.fail("the driver must not run during initialization");
    }),
  });
  await first.initialize();

  let trackerCalls = 0;
  let driverCalls = 0;
  const second = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: {
      async fetchIssuesByStates() {
        trackerCalls += 1;
        return [];
      },
      async fetchIssuesByIds() {
        trackerCalls += 1;
        return [];
      },
    },
    driver: driverFrom(async function* () {
      driverCalls += 1;
      yield event("turn_failed");
    }),
  });

  await assert.rejects(second.initialize(), /lease/i);
  assert.equal(trackerCalls, 0);
  assert.equal(driverCalls, 0);
  await assert.rejects(access(path.join(root, "workspaces")), isMissing);

  await Promise.all([first.stop(), first.stop()]);
  await second.initialize();
  assert.equal(trackerCalls, 1);
  assert.equal(driverCalls, 0);
  await second.stop();
});

posixTest("does not acquire a durable state lease from a poll after shutdown", async () => {
  const root = await fixture("symphony-recovery-stopped-poll-");
  const workflowPath = await writeMemoryWorkflow(root, []);
  let trackerCalls = 0;
  const stopped = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: {
      async fetchIssuesByStates() {
        trackerCalls += 1;
        return [];
      },
      async fetchIssuesByIds() {
        trackerCalls += 1;
        return [];
      },
    },
    driver: driverFrom(async function* () {
      assert.fail("the driver must not run after shutdown");
    }),
  });

  const stopping = stopped.stop();
  await stopped.pollOnce();
  await stopping;
  assert.equal(trackerCalls, 0);

  const next = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: new MemoryTracker(),
    driver: driverFrom(async function* () {
      yield event("turn_failed");
    }),
  });
  await next.initialize();
  await next.stop();
});

posixTest("restores interrupted and exhausted model work as durable blocked claims", async () => {
  const root = await fixture("symphony-recovery-blocked-");
  const issues = [
    rawIssue("crashed", "CRASHED-1"),
    rawIssue("exhausted", "EXHAUSTED-1"),
  ];
  const workflowPath = await writeMemoryWorkflow(root, issues, { maxAttempts: 2 });
  const { workflowStore, store } = await durableStore(workflowPath);
  await seedState(store, [
    { kind: "running", issueId: "crashed", attempt: 1, continuation: 0 },
    {
      kind: "blocked",
      issueId: "exhausted",
      attempt: 1,
      continuation: 0,
      blockedAtMs: 1,
      summary: "Agent retry budget exhausted after 2 dispatched runs (max_attempts=2); manual retry required",
    },
  ]);

  const contexts: AgentRunContext[] = [];
  const driver = driverFrom(async function* (context) {
    contexts.push(context);
    yield event("turn_failed", { summary: "still failing" });
  });
  const tracker = new MemoryTracker({ issues });
  const orchestrator = new Orchestrator(workflowStore, logger, { tracker, driver, failureBaseDelayMs: 0 });

  await orchestrator.initialize();
  assert.equal(contexts.length, 0);
  assert.deepEqual(orchestrator.snapshot().blocked.map(({ issueId }) => issueId).sort(), ["crashed", "exhausted"]);
  assert.deepEqual(
    Object.fromEntries(orchestrator.snapshot().blocked.map(({ issueId, reasonCode }) => [issueId, reasonCode])),
    { crashed: "run_interrupted", exhausted: "unknown" },
  );
  assert.deepEqual((await store.load()).map(({ kind }) => kind), ["blocked", "blocked"]);

  await orchestrator.pollOnce();
  assert.equal(contexts.length, 0);
  assert.equal(await orchestrator.retryBlocked("crashed"), true);
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.sessionId, undefined);
  await orchestrator.stop();

  const restartedRuns: AgentRunContext[] = [];
  const restarted = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver: driverFrom(async function* (context) {
      restartedRuns.push(context);
      yield event("turn_failed");
    }),
  });
  await restarted.initialize();
  assert.equal(restartedRuns.length, 0);
  assert.deepEqual(restarted.snapshot().blocked.map(({ issueId }) => issueId).sort(), ["crashed", "exhausted"]);
  await restarted.stop();
});

posixTest("restores an already-admitted manual retry even when its attempt is at the current limit", async () => {
  const root = await fixture("symphony-recovery-admitted-retry-");
  const issue = rawIssue("manual", "MANUAL-1");
  const workflowPath = await writeMemoryWorkflow(root, [issue], { maxAttempts: 2 });
  const { workflowStore, store } = await durableStore(workflowPath);
  await seedState(store, [
    {
      kind: "retrying",
      issueId: issue.id,
      attempt: 2,
      continuation: 0,
      dueAtMs: 0,
      reason: "continuation",
      error: null,
    },
  ]);
  const contexts: AgentRunContext[] = [];
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker: new MemoryTracker({ issues: [issue] }),
    driver: driverFrom(async function* (context) {
      contexts.push(context);
      yield event("turn_failed", { summary: "manual run failed" });
    }),
  });

  await orchestrator.initialize();
  assert.equal(orchestrator.snapshot().retrying[0]?.error, null);
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.attempt, 2);
  assert.equal(contexts[0]?.sessionId, undefined);
  assert.equal(orchestrator.snapshot().blocked.length, 1);
  await orchestrator.stop();
});

posixTest("batches recovery and retries from the beginning after invalid refreshes", async () => {
  const root = await fixture("symphony-recovery-retry-init-");
  const rawIssues = [rawIssue("first", "FIRST-1"), rawIssue("second", "SECOND-1")];
  const memory = new MemoryTracker({ issues: rawIssues });
  const issues = await memory.fetchIssuesByIds(["first", "second"]);
  const firstIssue = issues.find(({ id }) => id === "first");
  const secondIssue = issues.find(({ id }) => id === "second");
  assert.ok(firstIssue);
  assert.ok(secondIssue);
  const workflowPath = await writeMemoryWorkflow(root, rawIssues);
  const { workflowStore, store } = await durableStore(workflowPath);
  const persisted: PersistedClaim[] = [
    { kind: "running", issueId: "first", attempt: null, continuation: 0 },
    {
      kind: "blocked",
      issueId: "second",
      attempt: 1,
      continuation: 0,
      blockedAtMs: 1,
      summary: "waiting",
    },
  ];
  await seedState(store, persisted);
  const refreshes: string[][] = [];
  let refreshAttempt = 0;
  let failBlockedRefresh = false;
  const tracker: Tracker = {
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssuesByIds(ids) {
      refreshes.push([...ids]);
      refreshAttempt += 1;
      if (failBlockedRefresh) throw new Error("blocked reconciliation failed");
      if (refreshAttempt === 1) throw new Error("transient tracker failure");
      if (refreshAttempt === 2) return [firstIssue, { ...secondIssue, id: "rogue" }];
      if (refreshAttempt === 3) return [firstIssue, firstIssue];
      return [secondIssue, firstIssue];
    },
  };
  let modelCalls = 0;
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker,
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
  });

  for (const expectedError of [
    /Unable to refresh persisted issues/,
    /unexpected issue rogue/,
    /duplicate issue first/,
  ]) {
    await assert.rejects(orchestrator.initialize(), expectedError);
    assert.deepEqual(orchestrator.snapshot().blocked, []);
    assert.deepEqual(await store.load(), persisted);
  }
  await orchestrator.initialize();

  assert.equal(refreshes.length, 4);
  for (const ids of refreshes) assert.deepEqual([...ids].sort(), ["first", "second"]);
  assert.equal(modelCalls, 0);
  assert.deepEqual(orchestrator.snapshot().blocked.map(({ issueId }) => issueId).sort(), ["first", "second"]);
  assert.deepEqual(
    Object.fromEntries(orchestrator.snapshot().blocked.map(({ issueId, reasonCode }) => [issueId, reasonCode])),
    { first: "run_interrupted", second: "unknown" },
  );
  const recoveredClaims = await store.load();
  const recoveredBlocked = orchestrator.snapshot().blocked;
  assert.deepEqual(recoveredClaims.map(({ kind }) => kind), ["blocked", "blocked"]);

  refreshes.length = 0;
  failBlockedRefresh = true;
  await orchestrator.pollOnce();
  assert.deepEqual(refreshes.map((ids) => [...ids].sort()), [["first", "second"]]);
  assert.deepEqual(orchestrator.snapshot().blocked, recoveredBlocked);
  assert.deepEqual(await store.load(), recoveredClaims);

  refreshes.length = 0;
  failBlockedRefresh = false;
  await orchestrator.pollOnce();
  assert.deepEqual(refreshes.map((ids) => [...ids].sort()), [["first", "second"]]);
  assert.deepEqual(
    Object.fromEntries(orchestrator.snapshot().blocked.map(({ issueId, reasonCode }) => [issueId, reasonCode])),
    { first: "run_interrupted", second: "unknown" },
  );
  assert.deepEqual(await store.load(), recoveredClaims);
  await orchestrator.stop();
});

posixTest("persists a partial delivery and resumes it with the same comment key without rerunning the model", async () => {
  const root = await fixture("symphony-recovery-delivery-");
  const issue = githubIssue();
  const workflowPath = await writeGithubWorkflow(root);
  const { workflowStore, store } = await durableStore(workflowPath);

  let current = issue;
  let modelCalls = 0;
  let publishCalls = 0;
  let loseFirstCommentResponse = true;
  const commentKeys: string[] = [];
  const checkpointKeys: string[] = [];
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.some((state) => state.toLowerCase() === current.state) ? [current] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [current] : [];
    },
    async publishIssueChange() {
      publishCalls += 1;
      const [checkpoint] = await store.load();
      assert.equal(checkpoint?.kind, "running");
      const checkpointKey = checkpoint !== undefined && "pendingDelivery" in checkpoint
        ? checkpoint.pendingDelivery?.idempotencyKey
        : undefined;
      assert.ok(checkpointKey);
      checkpointKeys.push(checkpointKey);
      return { url: "https://github.com/acme/widget/pull/11", number: 11, branch: "symphony/issue-7" };
    },
    async mutateIssue(_target, mutation) {
      if (mutation.kind === "comment") {
        commentKeys.push(mutation.idempotencyKey ?? "missing");
        if (loseFirstCommentResponse) {
          loseFirstCommentResponse = false;
          throw new Error("simulated lost comment response");
        }
      }
      if (mutation.kind === "add_label") {
        current = { ...current, labels: [...new Set([...current.labels, mutation.label])] };
      }
      if (mutation.kind === "remove_label") {
        current = { ...current, labels: current.labels.filter((label) => label !== mutation.label) };
      }
    },
  };
  const driver = driverFrom(async function* () {
    modelCalls += 1;
    yield event("turn_completed", { completion });
  });
  let now = Date.UTC(2026, 0, 1);
  const first = new Orchestrator(workflowStore, logger, {
    tracker,
    driver,
    now: () => now,
    failureBaseDelayMs: 10,
  });

  await first.pollOnce();
  await first.waitForCurrentRuns();

  assert.equal(modelCalls, 1);
  assert.equal(publishCalls, 1);
  assert.equal(commentKeys.length, 1);
  assert.deepEqual(checkpointKeys, commentKeys);
  const [pendingRetry] = await store.load();
  assert.equal(pendingRetry?.kind, "retrying");
  assert.equal(pendingRetry?.kind === "retrying" ? pendingRetry.error : undefined, "Host delivery failed");
  assert.equal(
    pendingRetry !== undefined && "pendingDelivery" in pendingRetry
      ? pendingRetry.pendingDelivery?.idempotencyKey
      : undefined,
    commentKeys[0],
  );
  await first.stop();

  now += 10;
  const restarted = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver,
    now: () => now,
    failureBaseDelayMs: 10,
  });
  await restarted.pollOnce();
  await restarted.waitForCurrentRuns();

  assert.equal(modelCalls, 1);
  assert.equal(publishCalls, 2);
  assert.deepEqual(commentKeys, [commentKeys[0], commentKeys[0]]);
  assert.deepEqual(checkpointKeys, [commentKeys[0], commentKeys[0]]);
  assert.deepEqual(await store.load(), []);
  await restarted.stop();
});

posixTest("recovers a durable Linear handoff through its owned workspace without publisher or model", async () => {
  const root = await fixture("symphony-recovery-linear-delivery-");
  let current = linearIssue();
  const workflowPath = await writeLinearDeliveryWorkflow(root);
  const { workflowStore, definition, store } = await durableStore(workflowPath);
  await seedState(store, [
    {
      kind: "running",
      issueId: current.id,
      attempt: null,
      continuation: 0,
      pendingDelivery: { completion, idempotencyKey },
    },
  ]);
  const workspace = await new WorkspaceManager(logger).createForIssue(current, definition.config);

  let modelCalls = 0;
  const operations: string[] = [];
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue(_target, mutation) {
      if (mutation.kind === "comment") {
        assert.equal(mutation.idempotencyKey, idempotencyKey);
        assert.match(mutation.body, /Implemented the requested fix/);
        operations.push(`comment:${mutation.idempotencyKey}`);
        return;
      }
      if (mutation.kind === "set_state") {
        operations.push(`state:${mutation.state}`);
        current = { ...current, state: mutation.state };
        return;
      }
      assert.fail(`Unexpected mutation ${mutation.kind}`);
    },
  };
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker,
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(modelCalls, 0);
  assert.deepEqual(operations, [`comment:${idempotencyKey}`, "state:Human Review"]);
  assert.equal(current.state, "Human Review");
  await access(workspace.path);
  assert.deepEqual(await store.load(), []);
  await orchestrator.stop();
});

posixTest("keeps a recovered Linear handoff pending when its owned workspace is missing", async () => {
  const root = await fixture("symphony-recovery-linear-missing-workspace-");
  const issue = linearIssue();
  const workflowPath = await writeLinearDeliveryWorkflow(root);
  const { workflowStore, definition, store } = await durableStore(workflowPath);
  await seedState(store, [
    {
      kind: "running",
      issueId: issue.id,
      attempt: null,
      continuation: 0,
      pendingDelivery: { completion, idempotencyKey },
    },
  ]);

  let modelCalls = 0;
  let mutationCalls = 0;
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(issue.state) ? [issue] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(issue.id) ? [issue] : [];
    },
    async mutateIssue() {
      mutationCalls += 1;
    },
  };
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker,
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
    failureBaseDelayMs: 60_000,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(modelCalls, 0);
  assert.equal(mutationCalls, 0);
  await assert.rejects(access(definition.config.workspace.root), isMissing);
  const [retry] = await store.load();
  assert.equal(retry?.kind, "retrying");
  assert.equal(
    retry !== undefined && "pendingDelivery" in retry ? retry.pendingDelivery?.idempotencyKey : undefined,
    idempotencyKey,
  );
  await orchestrator.stop();
});

posixTest("fails Linear pending-delivery recovery when mutation support is missing", async () => {
  const root = await fixture("symphony-recovery-linear-missing-mutate-");
  const issue = linearIssue();
  const workflowPath = await writeLinearDeliveryWorkflow(root);
  const { workflowStore, definition, store } = await durableStore(workflowPath);
  await seedState(store, [
    {
      kind: "running",
      issueId: issue.id,
      attempt: null,
      continuation: 0,
      pendingDelivery: { completion, idempotencyKey },
    },
  ]);
  let trackerCalls = 0;
  let modelCalls = 0;
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker: {
      async fetchIssuesByStates() {
        trackerCalls += 1;
        return [issue];
      },
      async fetchIssuesByIds() {
        trackerCalls += 1;
        return [issue];
      },
    },
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
  });

  await assert.rejects(
    orchestrator.initialize(),
    /Configured host delivery requires the tracker capabilities for its delivery kind/,
  );
  assert.equal(trackerCalls, 0);
  assert.equal(modelCalls, 0);
  await assert.rejects(access(definition.config.workspace.root), isMissing);
  assert.equal((await store.load()).length, 1);
});

posixTest("does not create a workspace or invoke the model for an undeliverable recovered result", async () => {
  const root = await fixture("symphony-recovery-missing-workspace-");
  const issue = githubIssue();
  const workflowPath = await writeGithubWorkflow(root);
  const { workflowStore, definition, store } = await durableStore(workflowPath);
  await seedState(store, [
    {
      kind: "running",
      issueId: issue.id,
      attempt: null,
      continuation: 0,
      pendingDelivery: { completion, idempotencyKey },
    },
  ]);

  let modelCalls = 0;
  let publishCalls = 0;
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(issue.state) ? [issue] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(issue.id) ? [issue] : [];
    },
    async publishIssueChange() {
      publishCalls += 1;
      return { url: "https://github.com/acme/widget/pull/11", number: 11, branch: "symphony/issue-7" };
    },
    async mutateIssue() {},
  };
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker,
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
    failureBaseDelayMs: 10,
  });

  await orchestrator.initialize();
  assert.equal(orchestrator.snapshot().retrying[0]?.error, "Host delivery failed");
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(modelCalls, 0);
  assert.equal(publishCalls, 0);
  await assert.rejects(access(definition.config.workspace.root), isMissing);
  const [retry] = await store.load();
  assert.equal(retry?.kind, "retrying");
  assert.equal(retry?.attempt, 0);
  assert.equal(retry !== undefined && "pendingDelivery" in retry ? retry.pendingDelivery?.idempotencyKey : undefined, idempotencyKey);
  await orchestrator.stop();
});

posixTest("retains recovered delivery while host-delivery support is unavailable", async () => {
  const root = await fixture("symphony-recovery-delivery-disabled-");
  const issue = githubIssue();
  const workflowPath = await writeGithubWorkflow(root);
  const { store } = await durableStore(workflowPath);
  await seedState(store, [
    {
      kind: "running",
      issueId: issue.id,
      attempt: null,
      continuation: 0,
      pendingDelivery: { completion, idempotencyKey },
    },
  ]);
  await writeGithubWorkflow(root, { delivery: false });
  let modelCalls = 0;
  const tracker: Tracker = {
    async fetchIssuesByStates() {
      return [issue];
    },
    async fetchIssuesByIds() {
      return [issue];
    },
    async publishIssueChange() {
      throw new Error("must not publish");
    },
    async mutateIssue() {},
  };
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
  });

  await orchestrator.initialize();
  const snapshot = orchestrator.snapshot();
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.retrying.length, 1);
  assert.equal(snapshot.blocked.length, 0);
  assert.equal(snapshot.retrying[0]?.error, "Host delivery failed");
  await orchestrator.pollOnce();

  assert.equal(modelCalls, 0);
  const [retry] = await store.load();
  assert.equal(retry?.kind, "retrying");
  assert.equal(
    retry !== undefined && "pendingDelivery" in retry
      ? retry.pendingDelivery?.idempotencyKey
      : undefined,
    idempotencyKey,
  );
  await orchestrator.stop();
});

posixTest("prunes missing, terminal, and unroutable persisted claims before scheduling", async () => {
  const root = await fixture("symphony-recovery-prune-");
  const terminal = { ...rawIssue("terminal", "TERMINAL-1"), state: "Done" };
  const unroutable = { ...rawIssue("unroutable", "UNROUTABLE-1"), dispatchable: false };
  const issues = [terminal, unroutable];
  const workflowPath = await writeMemoryWorkflow(root, issues);
  const { workflowStore, store } = await durableStore(workflowPath);
  await seedState(store, [
    { kind: "running", issueId: terminal.id, attempt: null, continuation: 0 },
    {
      kind: "blocked",
      issueId: unroutable.id,
      attempt: 1,
      continuation: 0,
      blockedAtMs: 1,
      summary: "waiting",
    },
    {
      kind: "blocked",
      issueId: "missing",
      attempt: 1,
      continuation: 0,
      blockedAtMs: 1,
      summary: "waiting",
    },
  ]);
  let modelCalls = 0;
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker: new MemoryTracker({ issues }),
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
  });

  await orchestrator.initialize();

  assert.equal(modelCalls, 0);
  assert.deepEqual(orchestrator.snapshot().blocked, []);
  assert.deepEqual(await store.load(), []);
  await orchestrator.stop();
});

posixTest("freezes state writes after the final shutdown checkpoint", async () => {
  const root = await fixture("symphony-recovery-shutdown-race-");
  const raw = rawIssue("blocked", "BLOCKED-1");
  const memory = new MemoryTracker({ issues: [raw] });
  const [issue] = await memory.fetchIssuesByIds([raw.id]);
  assert.ok(issue);
  const workflowPath = await writeMemoryWorkflow(root, [raw]);
  const { workflowStore, store } = await durableStore(workflowPath);
  const persisted: PersistedClaim = {
    kind: "blocked",
    issueId: issue.id,
    attempt: null,
    continuation: 0,
    blockedAtMs: 1,
    summary: "operator input required",
  };
  await seedState(store, [persisted]);

  const refreshStarted = deferred<void>();
  const refreshResult = deferred<Issue[]>();
  let fetchCount = 0;
  const tracker: Tracker = {
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssuesByIds() {
      fetchCount += 1;
      if (fetchCount === 1) return [issue];
      refreshStarted.resolve();
      return refreshResult.promise;
    },
  };
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker,
    driver: driverFrom(async function* () {
      yield event("turn_failed");
    }),
    shutdownGraceMs: 1,
  });
  await orchestrator.initialize();

  const poll = orchestrator.pollOnce();
  await refreshStarted.promise;
  await orchestrator.stop();
  const contender = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: memory,
    driver: driverFrom(async function* () {
      assert.fail("the driver must not run while shutdown retains the lease");
    }),
  });
  await assert.rejects(contender.initialize(), /lease/i);
  refreshResult.resolve([]);
  await poll;
  await initializeEventually(contender);

  assert.deepEqual(await store.load(), [persisted]);
  await contender.stop();
});

posixTest("does not overwrite durable claims when shutdown times out during recovery", async () => {
  const root = await fixture("symphony-recovery-init-shutdown-");
  const raw = rawIssue("blocked", "BLOCKED-1");
  const memory = new MemoryTracker({ issues: [raw] });
  const [issue] = await memory.fetchIssuesByIds([raw.id]);
  assert.ok(issue);
  const workflowPath = await writeMemoryWorkflow(root, [raw]);
  const { workflowStore, store } = await durableStore(workflowPath);
  const persisted: PersistedClaim = {
    kind: "blocked",
    issueId: issue.id,
    attempt: null,
    continuation: 0,
    blockedAtMs: 1,
    summary: "operator input required",
  };
  await seedState(store, [persisted]);
  const refreshStarted = deferred<void>();
  const refreshResult = deferred<Issue[]>();
  const tracker: Tracker = {
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssuesByIds() {
      refreshStarted.resolve();
      return refreshResult.promise;
    },
  };
  let modelCalls = 0;
  const orchestrator = new Orchestrator(workflowStore, logger, {
    tracker,
    driver: driverFrom(async function* () {
      modelCalls += 1;
      yield event("turn_failed");
    }),
    shutdownGraceMs: 1,
  });

  const starting = orchestrator.start();
  await refreshStarted.promise;
  await orchestrator.stop();
  assert.deepEqual(await store.load(), [persisted]);
  const contender = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: memory,
    driver: driverFrom(async function* () {
      assert.fail("the driver must not run while recovery retains the lease");
    }),
  });
  await assert.rejects(contender.initialize(), /lease/i);
  refreshResult.resolve([issue]);
  await assert.rejects(starting, /stopped orchestrator/);
  await initializeEventually(contender);

  assert.equal(modelCalls, 0);
  assert.deepEqual(await store.load(), [persisted]);
  await contender.stop();
});

posixTest("binds durable memory state to stable issue identities", async () => {
  const root = await fixture("symphony-recovery-memory-scope-");
  const workflowPath = await writeMemoryWorkflow(root, [rawIssue("shared", "OLD-1")]);
  const oldDefinition = await new WorkflowStore(workflowPath, logger).initialize();
  await writeMemoryWorkflow(root, [rawIssue("shared", "NEW-1")]);
  const newDefinition = await new WorkflowStore(workflowPath, logger).initialize();

  assert.notEqual(workflowScopeHash(oldDefinition), workflowScopeHash(newDefinition));
});

async function durableStore(workflowPath: string): Promise<{
  workflowStore: WorkflowStore;
  definition: WorkflowDefinition;
  store: RunStateStore;
}> {
  const workflowStore = new WorkflowStore(workflowPath, logger);
  const definition = await workflowStore.initialize();
  const statePath = definition.config.state?.path;
  assert.ok(statePath);
  return {
    workflowStore,
    definition,
    store: new RunStateStore(statePath, workflowScopeHash(definition)),
  };
}

async function seedState(store: RunStateStore, claims: readonly PersistedClaim[]): Promise<void> {
  await store.acquireLease();
  try {
    await store.save(claims);
  } finally {
    await store.releaseLease();
  }
}

async function writeMemoryWorkflow(
  root: string,
  issues: Array<Record<string, unknown> & { id: string; identifier: string }>,
  options: { maxAttempts?: number } = {},
): Promise<string> {
  return writeWorkflow(root, {
    tracker: {
      kind: "memory",
      provider: { issues },
      required_labels: ["symphony"],
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 60_000 },
    workspace: { root: "./workspaces" },
    hooks: { timeout_ms: 1_000 },
    agent: {
      max_concurrent_agents: 1,
      max_turns: 1,
      ...(options.maxAttempts === undefined ? {} : { max_attempts: options.maxAttempts }),
      max_retry_backoff_ms: 1_000,
    },
    runtime: { kind: "claude", turn_timeout_ms: 10_000, stall_timeout_ms: 0, options: {} },
    state: { path: "./runs.json" },
  });
}

async function writeGithubWorkflow(root: string, options: { delivery?: boolean } = {}): Promise<string> {
  return writeWorkflow(root, {
    tracker: {
      kind: "github",
      provider: { owner: "acme", repo: "widget", token: "$RECOVERY_TRACKER_TOKEN" },
      required_labels: ["symphony"],
      active_states: ["open"],
      terminal_states: ["closed"],
    },
    ...(options.delivery === false
      ? {}
      : { delivery: { queue_label: "symphony", review_label: "human-review" } }),
    polling: { interval_ms: 60_000 },
    workspace: { root: "./workspaces" },
    hooks: { timeout_ms: 1_000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1_000 },
    runtime: { kind: "claude", turn_timeout_ms: 10_000, stall_timeout_ms: 0, options: {} },
    state: { path: "./runs.json" },
  });
}

async function writeLinearDeliveryWorkflow(root: string): Promise<string> {
  return writeWorkflow(root, {
    tracker: {
      kind: "linear",
      provider: { project_slug: "project", api_key: "$RECOVERY_TRACKER_TOKEN" },
      required_labels: ["symphony"],
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    delivery: { review_state: "Human Review" },
    polling: { interval_ms: 60_000 },
    workspace: { root: "./workspaces" },
    hooks: { timeout_ms: 1_000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_retry_backoff_ms: 1_000 },
    runtime: { kind: "claude", turn_timeout_ms: 10_000, stall_timeout_ms: 0, options: {} },
    state: { path: "./runs.json" },
  });
}

async function writeWorkflow(root: string, config: Record<string, unknown>): Promise<string> {
  const workflowPath = path.join(root, "WORKFLOW.md");
  await writeFile(workflowPath, `---\n${stringifyYaml(config)}---\nWork on {{ issue.identifier }}.\n`);
  return workflowPath;
}

function rawIssue(id: string, identifier: string): Record<string, unknown> & { id: string; identifier: string } {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: "Test issue",
    state: "Todo",
    priority: 1,
    labels: ["symphony"],
    dispatchable: true,
    created_at: "2025-01-01T00:00:00Z",
  };
}

function githubIssue(): Issue {
  return {
    id: "7",
    nativeRef: { owner: "acme", repo: "widget", number: 7 },
    identifier: "acme/widget#7",
    title: "Fix the widget",
    description: "Test issue",
    priority: 1,
    state: "open",
    branchName: null,
    url: "https://github.com/acme/widget/issues/7",
    assigneeId: null,
    labels: ["symphony"],
    blockedBy: [],
    dispatchable: true,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

function linearIssue(): Issue {
  return {
    ...githubIssue(),
    id: "linear-issue-1",
    nativeRef: null,
    identifier: "LIN-1",
    state: "Todo",
    url: "https://linear.app/acme/issue/LIN-1",
  };
}

function driverFrom(script: (context: AgentRunContext) => AsyncIterable<AgentEvent>): AgentDriver {
  return { kind: "claude", run: script };
}

function event(type: AgentEvent["type"], fields: Omit<AgentEvent, "type" | "timestamp"> = {}): AgentEvent {
  return { type, timestamp: new Date().toISOString(), ...fields };
}

async function fixture(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function initializeEventually(orchestrator: Orchestrator): Promise<void> {
  let leaseError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await orchestrator.initialize();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/lease/iu.test(error.message)) throw error;
      leaseError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw leaseError;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
