import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { WorkflowStore } from "../src/config/store.js";
import type { AgentDriver, AgentEvent, AgentRunContext, Issue, Tracker } from "../src/domain.js";
import { createLogger, type AppLogger } from "../src/log.js";
import { Orchestrator } from "../src/orchestrator.js";
import { MemoryTracker } from "../src/trackers/memory.js";
import { workspaceKey } from "../src/workspace/manager.js";

const logger = createLogger("silent");
const previousTrackerToken = process.env.TRACKER_TOKEN;
process.env.TRACKER_TOKEN = "orchestrator-test-token";
afterAll(() => {
  if (previousTrackerToken === undefined) delete process.env.TRACKER_TOKEN;
  else process.env.TRACKER_TOKEN = previousTrackerToken;
});

test("dispatches by priority without duplicate claims and accumulates absolute usage by delta", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-orchestrator-"));
  const issues = [
    rawIssue("low", "LOW-1", 4, "2025-01-01T00:00:00Z"),
    rawIssue("high", "HIGH-1", 1, "2025-02-01T00:00:00Z"),
  ];
  const tracker = new MemoryTracker({ issues });
  const seen: string[] = [];
  const workspaces: string[] = [];
  const driver = new FakeDriver(async function* (context) {
    seen.push(context.issue.id);
    workspaces.push(context.workspacePath);
    yield event("session_started", { sessionId: `session-${context.issue.id}` });
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      totalTokens: 18,
      costUsd: 0.01,
    };
    yield event("usage_updated", { usage });
    yield event("usage_updated", { usage });
    tracker.setIssueState(context.issue.id, "Done");
    yield event("turn_completed", { sessionId: `session-${context.issue.id}` });
  });
  const workflowPath = await writeWorkflow(directory, issues, { maxConcurrentAgents: 1 });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await Promise.all([orchestrator.pollOnce(), orchestrator.pollOnce()]);
  assert.equal(orchestrator.snapshot().running.length, 1);
  await orchestrator.waitForCurrentRuns();
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(seen, ["high", "low"]);
  assert.equal(new Set(seen).size, 2);
  const canonicalRoot = await realpath(path.join(directory, "workspaces"));
  assert.ok(workspaces.every((workspace) => workspace.startsWith(canonicalRoot)));
  const { secondsRunning, ...totals } = orchestrator.snapshot().totals;
  assert.deepEqual(totals, {
    inputTokens: 20,
    outputTokens: 10,
    cacheReadInputTokens: 4,
    cacheCreationInputTokens: 2,
    totalTokens: 36,
    costUsd: 0.02,
  });
  assert.ok(secondsRunning >= 0);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("snapshots live per-run metrics and scopes session ids to known lifecycle logs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-orchestrator-metrics-"));
  const issueUrl = "https://tracker.example/issues/METRICS-1";
  const issue = { ...rawIssue("metrics", "METRICS-1", 1, "2025-01-01T00:00:00Z"), url: issueUrl };
  const tracker = new MemoryTracker({ issues: [issue] });
  const secondTurnActive = deferred<void>();
  const finishSecondTurn = deferred<void>();
  const logs: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const metricsLogger = {
    info(bindings: Record<string, unknown>, message: string) {
      logs.push({ bindings, message });
    },
  } as unknown as AppLogger;
  let turn = 0;
  const driver = new FakeDriver(async function* () {
    turn += 1;
    yield event("session_started", { sessionId: "metrics-session" });
    yield event("usage_updated", {
      usage: turn === 1
        ? {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
            totalTokens: 18,
            costUsd: 1,
          }
        : {
            inputTokens: 7,
            outputTokens: 3,
            cacheReadInputTokens: 1,
            cacheCreationInputTokens: 0,
            totalTokens: 11,
            costUsd: 2,
          },
    });
    if (turn === 1) {
      yield event("turn_completed", { sessionId: "metrics-session" });
      return;
    }
    yield event("activity", { sessionId: "metrics-session" });
    secondTurnActive.resolve();
    await finishSecondTurn.promise;
    yield event("turn_completed", { sessionId: "metrics-session" });
  });
  const workflowPath = await writeWorkflow(directory, [issue], { maxTurns: 2 });
  let now = Date.UTC(2026, 0, 1);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, metricsLogger), metricsLogger, {
    tracker,
    driver,
    now: () => now,
    continuationDelayMs: 60_000,
  });

  await orchestrator.pollOnce();
  await secondTurnActive.promise;
  now += 2_500;

  const running = orchestrator.snapshot();
  const active = running.running[0];
  assert.deepEqual({
    issueUrl: active?.issueUrl,
    turnCount: active?.turnCount,
    secondsRunning: active?.secondsRunning,
    lastEvent: active?.lastEvent,
  }, {
    issueUrl,
    turnCount: 2,
    secondsRunning: 2.5,
    lastEvent: "activity",
  });
  assert.deepEqual(active?.usage, {
    inputTokens: 17,
    outputTokens: 8,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 1,
    totalTokens: 29,
    costUsd: 3,
  });
  assert.equal(running.totals.secondsRunning, 2.5);
  assert.equal(
    Object.hasOwn(logs.find((entry) => entry.message === "Agent run started")?.bindings ?? {}, "session_id"),
    false,
  );

  finishSecondTurn.resolve();
  await orchestrator.waitForCurrentRuns();

  const completed = orchestrator.snapshot();
  assert.equal(completed.running.length, 0);
  assert.equal(completed.retrying[0]?.issueUrl, issueUrl);
  assert.equal(completed.totals.secondsRunning, 2.5);
  assert.equal(
    logs.find((entry) => entry.message === "Continuation scheduled")?.bindings.session_id,
    "metrics-session",
  );
  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

test("binds provider operations to the current issue and owned workspace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-mutate-current-"));
  const issue = rawIssue("bound", "BOUND-1", 1, "2025-01-01T00:00:00Z");
  const backing = new MemoryTracker({ issues: [issue] });
  const publishLogs: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const operationLogger = {
    debug() {},
    info() {},
    warn() {},
    error(bindings: Record<string, unknown>, message: string) {
      publishLogs.push({ bindings, message });
    },
  } as unknown as AppLogger;
  let labels = ["symphony"];
  const mutations: Array<{ issueId: string; label: string }> = [];
  const publications: Array<{ issueId: string; workspacePath: string; title: string }> = [];
  const tracker: Tracker = {
    issueStateMutationMode: "named",
    async fetchIssuesByStates(states) {
      return (await backing.fetchIssuesByStates(states)).map((candidate) => ({ ...candidate, labels }));
    },
    async fetchIssuesByIds(ids) {
      return (await backing.fetchIssuesByIds(ids)).map((candidate) => ({ ...candidate, labels }));
    },
    async mutateIssue(target, mutation, signal) {
      assert.equal(signal.aborted, false);
      assert.equal(mutation.kind, "remove_label");
      if (mutation.kind !== "remove_label") throw new Error("unexpected mutation");
      mutations.push({ issueId: target.id, label: mutation.label });
      labels = labels.filter((label) => label !== mutation.label);
    },
    async publishIssueChange(target, workspacePath, input, signal) {
      assert.equal(signal.aborted, false);
      if (input.pullRequestTitle === "Provider failure") {
        throw new Error("GitHub git publishing failed");
      }
      publications.push({ issueId: target.id, workspacePath, title: input.pullRequestTitle });
      return {
        url: "https://github.example/acme/widget/pull/7",
        number: 7,
        branch: "symphony/issue-1",
      };
    },
  };
  const driver = new FakeDriver(async function* (context) {
    assert.ok(context.mutateCurrentIssue);
    assert.ok(context.publishCurrentChange);
    assert.equal(context.issueStateMutationMode, "named");
    await context.publishCurrentChange(
      {
        commitMessage: "Fix BOUND-1",
        pullRequestTitle: "Fix BOUND-1",
        pullRequestBody: "Verified.",
      },
      context.signal,
    );
    const markerPath = path.join(context.workspacePath, ".symphony-workspace.json");
    const marker = await readFile(markerPath, "utf8");
    await unlink(markerPath);
    await assert.rejects(
      context.publishCurrentChange(
        {
          commitMessage: "Must not publish",
          pullRequestTitle: "Must not publish",
          pullRequestBody: "Marker is missing.",
        },
        context.signal,
      ),
      /ownership marker is missing/,
    );
    await writeFile(markerPath, marker, { mode: 0o600 });
    await assert.rejects(
      context.publishCurrentChange(
        {
          commitMessage: "Provider failure",
          pullRequestTitle: "Provider failure",
          pullRequestBody: "Provider failure.",
        },
        context.signal,
      ),
      /GitHub git publishing failed/,
    );
    await context.mutateCurrentIssue({ kind: "remove_label", label: "symphony" }, context.signal);
    yield event("turn_completed");
  });
  const workflowPath = await writeWorkflow(directory, [issue], { maxTurns: 3 });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, operationLogger), operationLogger, {
    tracker,
    driver,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(mutations, [{ issueId: "bound", label: "symphony" }]);
  assert.equal(publications.length, 1);
  assert.equal(publications[0]?.issueId, "bound");
  assert.equal(publications[0]?.title, "Fix BOUND-1");
  assert.equal(
    publications[0]?.workspacePath,
    path.join(await realpath(directory), "workspaces", workspaceKey("BOUND-1")),
  );
  assert.equal(publishLogs.length, 2);
  assert.equal(publishLogs[0]?.message, "Current issue change publication failed");
  assert.equal(publishLogs[0]?.bindings.operation, "publish_current_change");
  assert.equal(publishLogs[0]?.bindings.publish_stage, "workspace_validation");
  assert.equal(publishLogs[0]?.bindings.issue_id, "bound");
  assert.equal(publishLogs[0]?.bindings.issue_identifier, "BOUND-1");
  assert.match((publishLogs[0]?.bindings.error as Error).message, /ownership marker is missing/);
  assert.equal(publishLogs[1]?.bindings.publish_stage, "tracker_publish");
  assert.equal((publishLogs[1]?.bindings.error as Error).message, "GitHub git publishing failed");
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await access(path.join(directory, "workspaces", workspaceKey("BOUND-1")));
  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

for (const runtimeKind of ["claude", "codex"] as const) {
  test(`host delivery publishes and hands off one ${runtimeKind} completion exactly once`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), `symphony-delivery-${runtimeKind}-`));
    let current = githubIssue();
    let driverRuns = 0;
    let streamClosed = false;
    const operations: string[] = [];
    const tracker: Tracker = {
      async fetchIssuesByStates(states) {
        return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
      },
      async fetchIssuesByIds(ids) {
        return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
      },
      async publishIssueChange(target, workspacePath, input, signal) {
        assert.equal(streamClosed, true);
        assert.equal(signal.aborted, false);
        assert.equal(target.id, current.id);
        assert.equal(workspacePath, path.join(await realpath(directory), "workspaces", workspaceKey(current.identifier)));
        assert.equal(input.commitMessage, "acme/widget#7: Fix the widget");
        assert.match(input.pullRequestBody, /pnpm test/);
        operations.push("publish");
        return { url: "https://github.com/acme/widget/pull/11", number: 11, branch: "symphony/issue-7" };
      },
      async mutateIssue(target, mutation, signal) {
        assert.equal(signal.aborted, false);
        assert.equal(target.id, current.id);
        if (mutation.kind === "add_label") {
          operations.push(`add:${mutation.label}`);
          current = { ...current, labels: [...new Set([...current.labels, mutation.label])] };
        } else if (mutation.kind === "comment") {
          assert.match(
            mutation.idempotencyKey ?? "",
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
          operations.push("comment:uuid");
          assert.match(mutation.body, /https:\/\/github\.com\/acme\/widget\/pull\/11/);
          assert.match(mutation.body, /pnpm test/);
        } else if (mutation.kind === "remove_label") {
          operations.push(`remove:${mutation.label}`);
          current = { ...current, labels: current.labels.filter((label) => label !== mutation.label) };
        } else {
          throw new Error(`Unexpected mutation ${mutation.kind}`);
        }
      },
    };
    const driver = new FakeDriver(async function* (context) {
      driverRuns += 1;
      assert.equal(context.completionMode, "publish_change");
      assert.deepEqual(context.sensitiveEnvNames, ["GITHUB_TOKEN", "TRACKER_TOKEN"]);
      assert.equal(context.publishCurrentChange, undefined);
      assert.equal(context.mutateCurrentIssue, undefined);
      try {
        yield event("turn_completed", {
          sessionId: `${runtimeKind}-delivery-session`,
          completion: {
            status: "ready",
            summary: "Implemented the requested fix.",
            verification: ["pnpm test"],
          },
        });
      } finally {
        streamClosed = true;
      }
    }, runtimeKind);
    const workflowPath = await writeDeliveryWorkflow(directory, runtimeKind);
    const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();

    assert.deepEqual(operations, [
      "publish",
      "comment:uuid",
      "add:human-review",
      "remove:symphony",
    ]);
    assert.equal(driverRuns, 1);
    assert.deepEqual(current.labels, ["human-review"]);
    assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
    await access(path.join(directory, "workspaces", workspaceKey(current.identifier)));

    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();
    assert.equal(driverRuns, 1);
    assert.equal(operations.filter((operation) => operation === "publish").length, 1);

    await orchestrator.stop();
    await rm(directory, { recursive: true, force: true });
  });
}

test("hands off one Linear Codex completion without exposing tracker tools", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-linear-delivery-"));
  let current = linearIssue();
  let modelRuns = 0;
  const operations: string[] = [];
  const tracker: Tracker = {
    issueStateMutationMode: "named",
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue(target, mutation, signal) {
      assert.equal(signal.aborted, false);
      assert.equal(target.id, current.id);
      if (mutation.kind === "comment") {
        assert.match(
          mutation.idempotencyKey ?? "",
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        );
        assert.match(mutation.body, /Implemented the Linear fix/);
        assert.match(mutation.body, /pnpm test/);
        operations.push("comment:uuid");
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
  const driver = new FakeDriver(async function* (context) {
    modelRuns += 1;
    assert.equal(context.completionMode, "publish_change");
    assert.deepEqual(context.sensitiveEnvNames, ["LINEAR_API_KEY", "TRACKER_TOKEN"]);
    assert.equal(context.publishCurrentChange, undefined);
    assert.equal(context.mutateCurrentIssue, undefined);
    assert.equal(context.issueStateMutationMode, undefined);
    yield event("turn_completed", {
      completion: {
        status: "ready",
        summary: "Implemented the Linear fix.",
        verification: ["pnpm test"],
      },
    });
  }, "codex");
  const workflowPath = await writeLinearDeliveryWorkflow(directory);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(modelRuns, 1);
  assert.deepEqual(operations, ["comment:uuid", "state:Human Review"]);
  assert.equal(current.state, "Human Review");
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(modelRuns, 1);
  assert.deepEqual(operations, ["comment:uuid", "state:Human Review"]);

  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

test("does not write a Linear handoff for a blocked Codex completion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-linear-blocked-"));
  const issue = linearIssue();
  let modelRuns = 0;
  let writes = 0;
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(issue.state) ? [issue] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(issue.id) ? [issue] : [];
    },
    async mutateIssue() {
      writes += 1;
    },
  };
  const driver = new FakeDriver(async function* (context) {
    modelRuns += 1;
    assert.equal(context.publishCurrentChange, undefined);
    assert.equal(context.mutateCurrentIssue, undefined);
    yield event("turn_completed", {
      completion: {
        status: "blocked",
        summary: "Needs a product decision.",
        verification: ["pnpm test: blocked"],
      },
    });
  }, "codex");
  const workflowPath = await writeLinearDeliveryWorkflow(directory);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(modelRuns, 1);
  assert.equal(writes, 0);
  assert.equal(issue.state, "Todo");
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

test("does not overwrite a Linear issue that leaves active state after the handoff comment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-linear-comment-refresh-"));
  let current = linearIssue();
  let modelRuns = 0;
  const operations: string[] = [];
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [current] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [current] : [];
    },
    async mutateIssue(_target, mutation) {
      if (mutation.kind === "comment") {
        operations.push("comment");
        current = { ...current, state: "Paused" };
        return;
      }
      if (mutation.kind === "set_state") operations.push(`state:${mutation.state}`);
    },
  };
  const driver = new FakeDriver(async function* () {
    modelRuns += 1;
    yield event("turn_completed", {
      completion: { status: "ready", summary: "Fixed.", verification: ["pnpm test"] },
    });
  }, "codex");
  const workflowPath = await writeLinearDeliveryWorkflow(directory);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(modelRuns, 1);
  assert.equal(current.state, "Paused");
  assert.deepEqual(operations, ["comment"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

test("guards the final Linear state handoff against terminal, state, and required-label drift", async () => {
  const scenarios: Array<{ name: string; drift: (issue: Issue) => Issue }> = [
    { name: "terminal", drift: (issue) => ({ ...issue, state: "Done" }) },
    { name: "state", drift: (issue) => ({ ...issue, state: "Paused" }) },
    { name: "required-label", drift: (issue) => ({ ...issue, labels: [] }) },
  ];

  for (const scenario of scenarios) {
    const directory = await mkdtemp(path.join(tmpdir(), `symphony-linear-final-guard-${scenario.name}-`));
    let current = linearIssue();
    let modelRuns = 0;
    let commentWrites = 0;
    let stateAttempts = 0;
    let stateWrites = 0;
    const tracker: Tracker = {
      async fetchIssuesByStates(states) {
        return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
      },
      async fetchIssuesByIds(ids) {
        return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
      },
      async mutateIssue(target, mutation, _signal, options) {
        if (mutation.kind === "comment") {
          commentWrites += 1;
          current = { ...current, title: "Latest Linear issue" };
          return;
        }
        assert.equal(mutation.kind, "set_state");
        assert.deepEqual(options, { requireUnchanged: true }, scenario.name);
        assert.deepEqual(target, current, `${scenario.name}: guard must use the latest refreshed issue`);
        stateAttempts += 1;
        current = scenario.drift(current);
        const unchanged = current.state === target.state
          && current.labels.join("\0") === target.labels.join("\0");
        if (!unchanged) throw new Error("simulated Linear state guard conflict");
        stateWrites += 1;
        current = { ...current, state: mutation.state };
      },
    };
    const driver = new FakeDriver(async function* () {
      modelRuns += 1;
      yield event("turn_completed", {
        completion: { status: "ready", summary: "Fixed.", verification: ["pnpm test"] },
      });
    }, "codex");
    const workflowPath = await writeLinearDeliveryWorkflow(directory);
    let now = Date.UTC(2026, 0, 1);
    const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
      tracker,
      driver,
      now: () => now,
      failureBaseDelayMs: 1_000,
    });

    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();

    assert.equal(modelRuns, 1, scenario.name);
    assert.equal(commentWrites, 1, scenario.name);
    assert.equal(stateAttempts, 1, scenario.name);
    assert.equal(stateWrites, 0, scenario.name);
    assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 1, blocked: 0 }, scenario.name);

    now += 1_000;
    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();

    assert.equal(modelRuns, 1, scenario.name);
    assert.equal(commentWrites, 1, scenario.name);
    assert.equal(stateAttempts, 1, scenario.name);
    assert.equal(stateWrites, 0, scenario.name);
    assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 }, scenario.name);
    await orchestrator.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries or safely releases a Linear handoff after a lost state response", async () => {
  const scenarios = [
    { name: "before-commit", commitBeforeThrow: false, commentCalls: 2, stateCalls: 2 },
    { name: "after-commit", commitBeforeThrow: true, commentCalls: 1, stateCalls: 1 },
  ] as const;

  for (const scenario of scenarios) {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), `symphony-linear-lost-state-${scenario.name}-`)),
    );
    let current = linearIssue();
    let modelRuns = 0;
    let loseStateResponse = true;
    let stateCalls = 0;
    const commentKeys: string[] = [];
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
          const key = mutation.idempotencyKey ?? "missing";
          commentKeys.push(key);
          operations.push(`comment:${key}`);
          return;
        }
        if (mutation.kind === "set_state") {
          stateCalls += 1;
          operations.push(`state:${mutation.state}`);
          if (loseStateResponse) {
            loseStateResponse = false;
            if (scenario.commitBeforeThrow) current = { ...current, state: mutation.state };
            throw new Error("simulated lost state response");
          }
          current = { ...current, state: mutation.state };
          return;
        }
        assert.fail(`Unexpected mutation ${mutation.kind}`);
      },
    };
    const driver = new FakeDriver(async function* () {
      modelRuns += 1;
      yield event("turn_completed", {
        completion: { status: "ready", summary: "Fixed.", verification: ["pnpm test"] },
      });
    }, "codex");
    const workflowPath = await writeLinearDeliveryWorkflow(directory, { durable: true });
    let now = Date.UTC(2026, 0, 1);
    const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
      tracker,
      driver,
      now: () => now,
      failureBaseDelayMs: 60_000,
    });

    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();

    const [commentKey] = commentKeys;
    assert.match(
      commentKey ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    assert.equal(modelRuns, 1, scenario.name);
    assert.equal(current.state, scenario.commitBeforeThrow ? "Human Review" : "Todo", scenario.name);
    assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 1, blocked: 0 }, scenario.name);
    const checkpoint = JSON.parse(await readFile(path.join(directory, "runs.json"), "utf8")) as {
      claims?: Array<{ pendingDelivery?: { idempotencyKey?: string } }>;
    };
    assert.equal(checkpoint.claims?.[0]?.pendingDelivery?.idempotencyKey, commentKey, scenario.name);

    now += 60_000;
    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();

    assert.equal(modelRuns, 1, scenario.name);
    assert.equal(commentKeys.length, scenario.commentCalls, scenario.name);
    assert.ok(commentKeys.every((key) => key === commentKey), scenario.name);
    assert.equal(stateCalls, scenario.stateCalls, scenario.name);
    assert.equal(current.state, "Human Review", scenario.name);
    assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 }, scenario.name);
    const released = JSON.parse(await readFile(path.join(directory, "runs.json"), "utf8")) as { claims?: unknown[] };
    assert.deepEqual(released.claims, [], scenario.name);

    await orchestrator.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps Linear credentials host-side while retry control admits one manual run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-linear-credentials-"));
  let issue: Issue = {
    ...githubIssue(),
    id: "linear-issue-1",
    nativeRef: null,
    identifier: "LIN-1",
    state: "Todo",
    labels: ["symphony"],
    url: "https://linear.app/acme/issue/LIN-1",
  };
  const operations: string[] = [];
  const tracker: Tracker = {
    issueStateMutationMode: "named",
    async fetchIssuesByStates(states) {
      return states.includes(issue.state) ? [{ ...issue, labels: [...issue.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(issue.id) ? [{ ...issue, labels: [...issue.labels] }] : [];
    },
    async mutateIssue(target, mutation, signal) {
      assert.equal(signal.aborted, false);
      assert.equal(target.id, issue.id);
      assert.equal(target.identifier, issue.identifier);
      assert.equal(mutation.kind, "remove_label");
      if (mutation.kind !== "remove_label") throw new Error("unexpected mutation");
      operations.push(`remove:${mutation.label}`);
      issue = {
        ...issue,
        labels: issue.labels.filter((label) => label.toLowerCase() !== mutation.label.toLowerCase()),
      };
    },
  };
  const driver = new FakeDriver(async function* (context) {
    assert.deepEqual(context.sensitiveEnvNames, ["LINEAR_API_KEY", "CUSTOM_LINEAR_TOKEN"]);
    operations.push(`run:${context.attempt ?? "initial"}`);
    yield event("turn_failed", { summary: "expected test failure" });
  });
  const workflowPath = path.join(directory, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---\ntracker:\n  kind: linear\n  provider:\n    project_slug: project\n    api_key: $CUSTOM_LINEAR_TOKEN\n  required_labels: [symphony]\n  active_states: [Todo]\n  terminal_states: [Done]\ncontrol:\n  retry_label: retry-me\nworkspace:\n  root: ./workspaces\nagent:\n  max_attempts: 1\nruntime:\n  kind: claude\n---\nWork on {{ issue.identifier }}.\n`,
  );
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(operations, ["run:initial"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  issue = { ...issue, labels: [...issue.labels, "ReTrY-Me"] };
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(operations, ["run:initial", "remove:retry-me", "run:1"]);
  assert.deepEqual(issue.labels, ["symphony"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(operations, ["run:initial", "remove:retry-me", "run:1"]);
  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

test("a partial host-delivery failure retries host work at the agent-attempt limit without rerunning the agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-delivery-retry-"));
  let current = githubIssue();
  let driverRuns = 0;
  let publicationCalls = 0;
  let loseFirstCommentResponse = true;
  const pullRequests = new Set<number>();
  const commits = new Set<string>();
  const comments = new Map<string, string>();
  const commentKeys: string[] = [];
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async publishIssueChange(_target, _workspacePath, input) {
      publicationCalls += 1;
      commits.add(input.commitMessage);
      pullRequests.add(11);
      return { url: "https://github.com/acme/widget/pull/11", number: 11, branch: "symphony/issue-7" };
    },
    async mutateIssue(_target, mutation) {
      if (mutation.kind === "add_label") {
        current = { ...current, labels: [...new Set([...current.labels, mutation.label])] };
        return;
      }
      if (mutation.kind === "comment") {
        const key = mutation.idempotencyKey ?? "ordinary";
        commentKeys.push(key);
        comments.set(key, mutation.body);
        if (loseFirstCommentResponse) {
          loseFirstCommentResponse = false;
          throw new Error("simulated lost response");
        }
        return;
      }
      if (mutation.kind === "remove_label") {
        current = { ...current, labels: current.labels.filter((label) => label !== mutation.label) };
      }
    },
  };
  const driver = new FakeDriver(async function* () {
    driverRuns += 1;
    yield event("turn_completed", {
      completion: { status: "ready", summary: "Fixed.", verification: ["pnpm test"] },
    });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", { maxAttempts: 1 });
  let now = Date.UTC(2026, 0, 1);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver,
    now: () => now,
    failureBaseDelayMs: 10,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 1, blocked: 0 });
  const [deliveryKey] = commentKeys;
  assert.match(
    deliveryKey ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.doesNotMatch(JSON.stringify(orchestrator.snapshot()), new RegExp(deliveryKey ?? "never-match"));

  now += 10;
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(driverRuns, 1);
  assert.equal(publicationCalls, 2);
  assert.equal(commits.size, 1);
  assert.equal(pullRequests.size, 1);
  assert.equal(comments.size, 1);
  assert.deepEqual(commentKeys, [deliveryKey, deliveryKey]);
  assert.deepEqual(current.labels, ["human-review"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });

  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

test("a stalled host delivery preserves its completion for a host-only retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-delivery-stall-"));
  const publishStarted = deferred<void>();
  let current = githubIssue();
  let driverRuns = 0;
  let publicationCalls = 0;
  const tracker: Tracker = {
    async fetchIssuesByStates() {
      return [{ ...current, labels: [...current.labels] }];
    },
    async fetchIssuesByIds() {
      return [{ ...current, labels: [...current.labels] }];
    },
    async publishIssueChange(_target, _workspacePath, _input, signal) {
      publicationCalls += 1;
      if (publicationCalls === 1) {
        publishStarted.resolve();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      return { url: "https://github.com/acme/widget/pull/11", number: 11, branch: "symphony/issue-7" };
    },
    async mutateIssue(_target, mutation) {
      if (mutation.kind === "add_label") {
        current = { ...current, labels: [...new Set([...current.labels, mutation.label])] };
      } else if (mutation.kind === "remove_label") {
        current = { ...current, labels: current.labels.filter((label) => label !== mutation.label) };
      }
    },
  };
  const driver = new FakeDriver(async function* () {
    driverRuns += 1;
    yield event("turn_completed", {
      completion: { status: "ready", summary: "Fixed.", verification: ["pnpm test"] },
    });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", { stallTimeoutMs: 10 });
  let now = Date.UTC(2026, 0, 1);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver,
    now: () => now,
    failureBaseDelayMs: 10,
  });

  await orchestrator.pollOnce();
  await publishStarted.promise;
  now += 11;
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 1, blocked: 0 });

  now += 10;
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(driverRuns, 1);
  assert.equal(publicationCalls, 2);
  assert.deepEqual(current.labels, ["human-review"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });

  await orchestrator.stop();
  await rm(directory, { recursive: true, force: true });
});

test("host delivery does not publish blocked, stale, or failed completions", async () => {
  const cases = [
    {
      name: "blocked",
      mutateBeforeTerminal: false,
      terminal: event("turn_completed", {
        completion: { status: "blocked", summary: "Needs an API fixture.", verification: ["pnpm test: blocked"] },
      }),
      expected: { running: 0, retrying: 0, blocked: 1 },
    },
    {
      name: "stale",
      mutateBeforeTerminal: true,
      terminal: event("turn_completed", {
        completion: { status: "ready", summary: "Done.", verification: ["pnpm test"] },
      }),
      expected: { running: 0, retrying: 0, blocked: 0 },
    },
    {
      name: "missing",
      mutateBeforeTerminal: false,
      terminal: event("turn_completed"),
      expected: { running: 0, retrying: 1, blocked: 0 },
    },
    {
      name: "invalid",
      mutateBeforeTerminal: false,
      terminal: event("turn_completed", {
        completion: { status: "ready", summary: "", verification: [] },
      }),
      expected: { running: 0, retrying: 1, blocked: 0 },
    },
  ] as const;

  for (const scenario of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), `symphony-delivery-${scenario.name}-`));
    let current = githubIssue();
    let publications = 0;
    const tracker: Tracker = {
      async fetchIssuesByStates() {
        return [{ ...current, labels: [...current.labels] }];
      },
      async fetchIssuesByIds() {
        return [{ ...current, labels: [...current.labels] }];
      },
      async publishIssueChange() {
        publications += 1;
        return { url: "https://github.com/acme/widget/pull/11", number: 11, branch: "symphony/issue-7" };
      },
      async mutateIssue() {},
    };
    const driver = new FakeDriver(async function* () {
      if (scenario.mutateBeforeTerminal) current = { ...current, labels: [] };
      yield scenario.terminal;
    });
    const workflowPath = await writeDeliveryWorkflow(directory, "claude");
    const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();

    assert.equal(publications, 0, scenario.name);
    assert.deepEqual(compactState(orchestrator), scenario.expected, scenario.name);
    await orchestrator.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes before exponential retries and starts fresh sessions after failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-retry-"));
  const issues = [rawIssue("retry", "RETRY-1", 1, "2025-01-01T00:00:00Z")];
  const tracker = new MemoryTracker({ issues });
  const contexts: AgentRunContext[] = [];
  let call = 0;
  const driver = new FakeDriver(async function* (context) {
    contexts.push(context);
    call += 1;
    yield event("session_started", { sessionId: "resume-me" });
    if (call <= 2) {
      yield event("turn_failed", { sessionId: "resume-me", summary: "transient" });
      return;
    }
    tracker.setIssueState(context.issue.id, "Done");
    yield event("turn_completed", { sessionId: "resume-me" });
  });
  const workflowPath = await writeWorkflow(directory, issues);
  let now = Date.UTC(2026, 0, 1);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver,
    now: () => now,
    failureBaseDelayMs: 100,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  const retry = orchestrator.snapshot().retrying[0];
  assert.equal(retry?.attempt, 1);
  assert.equal(retry?.dueAt, new Date(now + 100).toISOString());

  now += 99;
  await orchestrator.pollOnce();
  assert.equal(contexts.length, 1);
  now += 1;
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  const secondRetry = orchestrator.snapshot().retrying[0];
  assert.equal(secondRetry?.attempt, 2);
  assert.equal(secondRetry?.dueAt, new Date(now + 200).toISOString());
  now += 200;
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(contexts.length, 3);
  assert.equal(contexts[0]?.attempt, null);
  assert.equal(contexts[1]?.attempt, 1);
  assert.equal(contexts[1]?.sessionId, undefined);
  assert.equal(contexts[2]?.attempt, 2);
  assert.equal(contexts[2]?.sessionId, undefined);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("blocks after exactly max_attempts dispatched runs and starts a fresh session on manual retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-max-attempts-"));
  const issue = rawIssue("limited", "LIMITED-1", 1, "2025-01-01T00:00:00Z");
  const tracker = new MemoryTracker({ issues: [issue] });
  const contexts: AgentRunContext[] = [];
  const errors: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const retryLogger = {
    debug() {},
    info() {},
    warn() {},
    error(bindings: Record<string, unknown>, message: string) {
      errors.push({ bindings, message });
    },
  } as unknown as AppLogger;
  const driver = new FakeDriver(async function* (context) {
    contexts.push(context);
    yield event("session_started", { sessionId: `limited-session-${contexts.length}` });
    yield event("turn_failed", { summary: `transient-${contexts.length}` });
  });
  const workflowPath = await writeWorkflow(directory, [issue], { maxAttempts: 2 });
  let now = Date.UTC(2026, 0, 1);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, retryLogger), retryLogger, {
    tracker,
    driver,
    now: () => now,
    failureBaseDelayMs: 10,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 1, blocked: 0 });

  now += 10;
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(contexts.map(({ attempt }) => attempt), [null, 1]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });
  assert.match(orchestrator.snapshot().blocked[0]?.summary ?? "", /after 2 dispatched runs \(max_attempts=2\)/);
  const exhaustion = errors.find(({ message }) => message === "Agent run failed; retry budget exhausted");
  assert.equal((exhaustion?.bindings.error as Error | undefined)?.message, "transient-2");

  assert.equal(await orchestrator.retryBlocked(issue.id), true);
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(contexts.length, 3);
  assert.equal(contexts[2]?.sessionId, undefined);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(contexts.length, 3);
  await orchestrator.stop();
});

test("max_attempts blocks continuations while manual retry preserves the session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-max-continuations-"));
  const issue = rawIssue("continued", "CONTINUED-1", 1, "2025-01-01T00:00:00Z");
  const tracker = new MemoryTracker({ issues: [issue] });
  const contexts: AgentRunContext[] = [];
  const driver = new FakeDriver(async function* (context) {
    contexts.push(context);
    yield event("session_started", { sessionId: "continued-session" });
    yield event("turn_completed", { sessionId: "continued-session" });
  });
  const workflowPath = await writeWorkflow(directory, [issue], { maxAttempts: 2 });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver,
    continuationDelayMs: 0,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(contexts.map(({ attempt }) => attempt), [null, 1]);
  assert.equal(contexts[1]?.sessionId, "continued-session");
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  assert.equal(await orchestrator.retryBlocked(issue.id), true);
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(contexts[2]?.sessionId, "continued-session");
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });
  await orchestrator.stop();
});

test("manual retry refreshes a blocked issue without requiring its configured retry label", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-manual-retry-no-label-"));
  const current = githubIssue();
  let idRefreshes = 0;
  let pauseRefresh = false;
  let mutationCalls = 0;
  let runs = 0;
  const refreshStarted = deferred<void>();
  const releaseRefresh = deferred<void>();
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      idRefreshes += 1;
      if (pauseRefresh) {
        pauseRefresh = false;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue() {
      mutationCalls += 1;
    },
  };
  const driver = new FakeDriver(async function* () {
    runs += 1;
    yield event("turn_failed", { summary: "failed" });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    maxAttempts: 1,
    retryLabel: "retry-me",
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });
  idRefreshes = 0;

  pauseRefresh = true;
  const poll = orchestrator.pollOnce();
  await refreshStarted.promise;
  const manualRetry = orchestrator.requestBlockedRetry(current.identifier);
  releaseRefresh.resolve();

  assert.equal(await manualRetry, true);
  await poll;
  await orchestrator.waitForCurrentRuns();
  assert.equal(idRefreshes, 3);
  assert.equal(mutationCalls, 0);
  assert.equal(runs, 2);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });
  await orchestrator.stop();
});

test("reconciliation and manual retry consume one retry label and schedule one run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-manual-retry-race-"));
  let current = githubIssue();
  let pauseRefresh = false;
  let mutationCalls = 0;
  let runs = 0;
  const refreshStarted = deferred<void>();
  const releaseRefresh = deferred<void>();
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      if (pauseRefresh) {
        pauseRefresh = false;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue(_target, mutation) {
      assert.equal(mutation.kind, "remove_label");
      if (mutation.kind !== "remove_label") throw new Error("unexpected mutation");
      mutationCalls += 1;
      current = {
        ...current,
        labels: current.labels.filter((label) => label.trim().toLowerCase() !== mutation.label.trim().toLowerCase()),
      };
    },
  };
  const driver = new FakeDriver(async function* () {
    runs += 1;
    yield event("turn_failed", { summary: `failed-${runs}` });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    maxAttempts: 1,
    retryLabel: "retry-me",
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  current = { ...current, labels: [...current.labels, "ReTrY-Me"] };
  pauseRefresh = true;
  const manualRetry = orchestrator.requestBlockedRetry(current.identifier);
  await refreshStarted.promise;
  const poll = orchestrator.pollOnce();
  releaseRefresh.resolve();

  assert.equal(await manualRetry, true);
  await poll;
  await orchestrator.waitForCurrentRuns();
  assert.equal(mutationCalls, 1);
  assert.equal(runs, 2);
  assert.deepEqual(current.labels, ["symphony"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(mutationCalls, 1);
  assert.equal(runs, 2);
  await orchestrator.stop();
});

test("manual retry releases stale blocked issues and only cleans terminal workspaces", async () => {
  const scenarios = [
    { name: "missing", update: () => undefined, workspaceRemoved: false },
    { name: "unroutable", update: (issue: Issue) => ({ ...issue, dispatchable: false }), workspaceRemoved: false },
    { name: "terminal", update: (issue: Issue) => ({ ...issue, state: "closed" }), workspaceRemoved: true },
  ] as const;

  for (const scenario of scenarios) {
    const directory = await mkdtemp(path.join(tmpdir(), `symphony-manual-retry-${scenario.name}-`));
    let current: Issue | undefined = githubIssue();
    let runs = 0;
    const tracker: Tracker = {
      async fetchIssuesByStates(states) {
        return current !== undefined && states.includes(current.state)
          ? [{ ...current, labels: [...current.labels] }]
          : [];
      },
      async fetchIssuesByIds(ids) {
        return current !== undefined && ids.includes(current.id)
          ? [{ ...current, labels: [...current.labels] }]
          : [];
      },
      async mutateIssue() {},
    };
    const driver = new FakeDriver(async function* () {
      runs += 1;
      yield event("turn_failed", { summary: "failed" });
    });
    const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
      delivery: false,
      maxAttempts: 1,
      retryLabel: "retry-me",
    });
    const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

    await orchestrator.pollOnce();
    await orchestrator.waitForCurrentRuns();
    const issue = current;
    assert.ok(issue);
    const workspacePath = path.join(directory, "workspaces", workspaceKey(issue.identifier));
    await access(workspacePath);
    current = scenario.update(issue);

    assert.equal(await orchestrator.requestBlockedRetry(issue.identifier), false, scenario.name);
    assert.equal(runs, 1, scenario.name);
    assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 }, scenario.name);
    if (scenario.workspaceRemoved) await assert.rejects(access(workspacePath));
    else await access(workspacePath);
    await orchestrator.stop();
  }
});

test("stop waits for a public blocked transition and prevents post-shutdown cleanup or scheduling", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "symphony-manual-retry-stop-")));
  let current = githubIssue();
  let pauseRefresh = false;
  let runs = 0;
  const refreshStarted = deferred<void>();
  const releaseRefresh = deferred<void>();
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      if (pauseRefresh) {
        pauseRefresh = false;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue() {
      throw new Error("retry label must not be consumed during shutdown");
    },
  };
  const driver = new FakeDriver(async function* () {
    runs += 1;
    yield event("turn_failed", { summary: "failed" });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    durable: true,
    maxAttempts: 1,
    retryLabel: "retry-me",
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  const workspacePath = path.join(directory, "workspaces", workspaceKey(current.identifier));
  current = { ...current, state: "closed", labels: [...current.labels, "retry-me"] };
  pauseRefresh = true;
  const retry = orchestrator.requestBlockedRetry(current.identifier);
  await refreshStarted.promise;
  let stopped = false;
  const stop = orchestrator.stop().then(() => {
    stopped = true;
  });
  await delay(0);
  assert.equal(stopped, false);
  releaseRefresh.resolve();

  assert.equal(await retry, false);
  await stop;
  assert.equal(stopped, true);
  assert.equal(runs, 1);
  await access(workspacePath);
  const checkpoint = JSON.parse(await readFile(path.join(directory, "runs.json"), "utf8")) as {
    claims: Array<{ kind: string; issueId: string }>;
  };
  assert.deepEqual(checkpoint.claims.map(({ kind, issueId }) => ({ kind, issueId })), [
    { kind: "blocked", issueId: current.id },
  ]);
});

test("a blocked retry label is consumed once before a captured-config manual run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-control-retry-"));
  let current = githubIssue();
  const operations: string[] = [];
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue(_target, mutation, signal) {
      assert.equal(signal.aborted, false);
      assert.equal(mutation.kind, "remove_label");
      if (mutation.kind !== "remove_label") throw new Error("unexpected mutation");
      operations.push(`remove:${mutation.label}`);
      current = {
        ...current,
        labels: current.labels.filter((label) => label.toLowerCase() !== mutation.label.toLowerCase()),
      };
    },
  };
  let runs = 0;
  const driver = new FakeDriver(async function* () {
    runs += 1;
    operations.push(`run:${runs}`);
    yield event("turn_failed", { summary: `failed-${runs}` });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    maxAttempts: 1,
    retryLabel: "retry-me",
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  current = { ...current, labels: [...current.labels, "ReTrY-Me"] };
  await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    maxAttempts: 1,
    retryLabel: "replacement-label",
  });
  const later = new Date(Date.now() + 2_000);
  await utimes(workflowPath, later, later);
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(operations, ["run:1", "remove:retry-me", "run:2"]);
  assert.deepEqual(current.labels, ["symphony"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(runs, 2);
  assert.equal(operations.filter((operation) => operation === "remove:retry-me").length, 1);
  await orchestrator.stop();
});

test("a failed retry-label removal retains the blocked claim without leaking the provider error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-control-retry-failure-"));
  let current = githubIssue();
  let mutationCalls = 0;
  const warnings: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const retryLogger = {
    debug() {},
    info() {},
    warn(bindings: Record<string, unknown>, message: string) {
      warnings.push({ bindings, message });
    },
    error() {},
  } as unknown as AppLogger;
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue(_target, mutation) {
      mutationCalls += 1;
      if (mutation.kind === "remove_label") {
        current = { ...current, labels: current.labels.filter((label) => label !== mutation.label) };
      }
      throw new Error("secret-provider-response");
    },
  };
  let runs = 0;
  const driver = new FakeDriver(async function* () {
    runs += 1;
    yield event("turn_failed", { summary: "failed" });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    maxAttempts: 1,
    retryLabel: "retry-me",
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, retryLogger), retryLogger, {
    tracker,
    driver,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  current = { ...current, labels: [...current.labels, "retry-me"] };
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(runs, 1);
  assert.equal(mutationCalls, 1);
  assert.deepEqual(current.labels, ["symphony"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 1 });
  assert.equal(warnings.at(-1)?.message, "Blocked retry label removal failed; claim retained");
  assert.doesNotMatch(JSON.stringify(warnings), /secret-provider-response/);
  await orchestrator.stop();
});

test("shutdown does not consume a blocked retry label", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-control-retry-shutdown-"));
  let current = githubIssue();
  let pauseRefresh = false;
  let mutationCalls = 0;
  let runs = 0;
  const refreshStarted = deferred<void>();
  const releaseRefresh = deferred<void>();
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      if (pauseRefresh) {
        pauseRefresh = false;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue() {
      mutationCalls += 1;
    },
  };
  const driver = new FakeDriver(async function* () {
    runs += 1;
    yield event("turn_failed", { summary: "failed" });
  });
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    maxAttempts: 1,
    retryLabel: "retry-me",
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  current = { ...current, labels: [...current.labels, "retry-me"] };
  pauseRefresh = true;
  const poll = orchestrator.pollOnce();
  await refreshStarted.promise;
  const stop = orchestrator.stop();
  releaseRefresh.resolve();
  await Promise.all([poll, stop]);

  assert.equal(runs, 1);
  assert.equal(mutationCalls, 0);
  assert.deepEqual(current.labels, ["symphony", "retry-me"]);
});

test("control retry labels require host mutation support and cannot be mutated by the agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-control-retry-boundary-"));
  let current = githubIssue();
  const workflowPath = await writeDeliveryWorkflow(directory, "claude", {
    delivery: false,
    retryLabel: "retry-me",
  });
  const unsupported = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker: {
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssuesByIds() {
        return [];
      },
    },
    driver: new FakeDriver(async function* () {
      assert.fail("unsupported control configuration must not dispatch");
    }),
  });
  await assert.rejects(unsupported.initialize(), /control labels require tracker mutation support/);

  const mutations: string[] = [];
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      return states.includes(current.state) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async fetchIssuesByIds(ids) {
      return ids.includes(current.id) ? [{ ...current, labels: [...current.labels] }] : [];
    },
    async mutateIssue(_target, mutation) {
      mutations.push(mutation.kind);
    },
  };
  const driver = new FakeDriver(async function* (context) {
    assert.ok(context.mutateCurrentIssue);
    await assert.rejects(
      async () => context.mutateCurrentIssue?.({ kind: "add_label", label: "RETRY-ME" }, context.signal),
      /cannot mutate the configured control retry label/,
    );
    await assert.rejects(
      async () => context.mutateCurrentIssue?.({ kind: "remove_label", label: "retry-me" }, context.signal),
      /cannot mutate the configured control retry label/,
    );
    await context.mutateCurrentIssue({ kind: "comment", body: "ordinary mutation" }, context.signal);
    current = { ...current, state: "closed" };
    yield event("turn_completed");
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(mutations, ["comment"]);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("reconciliation aborts a terminal issue, runs after_run, then removes its workspace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-reconcile-"));
  const issue = rawIssue("slow", "SLOW-1", 1, "2025-01-01T00:00:00Z");
  const tracker = new MemoryTracker({ issues: [issue] });
  const started = deferred<void>();
  const driver = new FakeDriver(async function* (context) {
    yield event("session_started", { sessionId: "slow-session" });
    started.resolve();
    if (!context.signal.aborted) {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    yield event("turn_failed", { sessionId: "slow-session", summary: "aborted" });
  });
  const lifecyclePath = path.join(directory, "lifecycle.log");
  const workflowPath = await writeWorkflow(directory, [issue], {
    hooks: {
      after_run: `printf 'after_run\\n' >> ${shellQuote(lifecyclePath)}`,
      before_remove: `printf 'before_remove\\n' >> ${shellQuote(lifecyclePath)}`,
    },
  });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await started.promise;
  tracker.setIssueState(issue.id, "Done");
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  const workspacePath = path.join(directory, "workspaces", workspaceKey(issue.identifier));
  await assert.rejects(access(workspacePath));
  assert.equal(await readFile(lifecyclePath, "utf8"), "after_run\nbefore_remove\n");
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("an early continuation retry wakes the scheduler before the regular poll interval", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-wake-retry-"));
  const issue = rawIssue("wake", "WAKE-1", 1, "2025-01-01T00:00:00Z");
  const tracker = new MemoryTracker({ issues: [issue] });
  const secondRun = deferred<void>();
  let runs = 0;
  let resumedSession: string | undefined;
  const driver = new FakeDriver(async function* (context) {
    runs += 1;
    yield event("session_started", { sessionId: "wake-session" });
    if (runs === 2) {
      resumedSession = context.sessionId;
      tracker.setIssueState(context.issue.id, "Done");
      secondRun.resolve();
    }
    yield event("turn_completed", { sessionId: "wake-session" });
  });
  const workflowPath = await writeWorkflow(directory, [issue], { pollIntervalMs: 60_000 });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver,
    continuationDelayMs: 30,
  });

  await orchestrator.start();
  await withTimeout(secondRun.promise, 1_000);
  await orchestrator.waitForCurrentRuns();

  assert.equal(runs, 2);
  assert.equal(resumedSession, "wake-session");
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("turn timeout measures stream silence instead of total runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-silence-timeout-"));
  const issue = rawIssue("active", "ACTIVE-1", 1, "2025-01-01T00:00:00Z");
  const tracker = new MemoryTracker({ issues: [issue] });
  const driver = new FakeDriver(async function* (context) {
    yield event("session_started", { sessionId: "active-session" });
    for (let index = 0; index < 6; index += 1) {
      await delay(20);
      if (context.signal.aborted) return;
      yield event("activity", { summary: `activity-${index}` });
    }
    tracker.setIssueState(context.issue.id, "Done");
    yield event("turn_completed", { sessionId: "active-session" });
  });
  const workflowPath = await writeWorkflow(directory, [issue], { turnTimeoutMs: 80 });
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("shutdown waits for an in-progress poll and prevents a late dispatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-stop-race-"));
  const issue = rawIssue("late", "LATE-1", 1, "2025-01-01T00:00:00Z");
  const backing = new MemoryTracker({ issues: [issue] });
  const candidateFetchStarted = deferred<void>();
  const releaseCandidateFetch = deferred<void>();
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      if (states.includes("Done")) return [];
      candidateFetchStarted.resolve();
      await releaseCandidateFetch.promise;
      return backing.fetchIssuesByStates(states);
    },
    fetchIssuesByIds(ids) {
      return backing.fetchIssuesByIds(ids);
    },
  };
  let driverRuns = 0;
  const driver = new FakeDriver(async function* () {
    driverRuns += 1;
    yield event("turn_completed");
  });
  const workflowPath = await writeWorkflow(directory, [issue]);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  const poll = orchestrator.pollOnce();
  await candidateFetchStarted.promise;
  const stop = orchestrator.stop();
  releaseCandidateFetch.resolve();
  await Promise.all([poll, stop]);

  assert.equal(driverRuns, 0);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
});

test("strict one-shot polling surfaces tracker candidate failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-strict-poll-"));
  const tracker: Tracker = {
    async fetchIssuesByStates(states) {
      if (states.includes("Done")) return [];
      throw new Error("tracker offline");
    },
    async fetchIssuesByIds() {
      return [];
    },
  };
  const driver = new FakeDriver(async function* () {
    assert.fail("the agent must not run when the tracker poll fails");
  });
  const workflowPath = await writeWorkflow(directory, []);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  try {
    await assert.rejects(orchestrator.pollOnce({ failOnTrackerError: true }), /tracker offline/);
    assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  } finally {
    await orchestrator.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("hot reload preserves an in-flight session config until release", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-reload-running-"));
  const issue = rawIssue("reload", "RELOAD-1", 1, "2025-01-01T00:00:00Z");
  const tracker = new MemoryTracker({ issues: [issue] });
  const started = deferred<void>();
  let aborted = false;
  const driver = new FakeDriver(async function* (context) {
    yield event("session_started", { sessionId: "reload-session" });
    started.resolve();
    if (!context.signal.aborted) {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    aborted = context.signal.aborted;
    yield event("turn_failed", { summary: "reloaded" });
  });
  const workflowPath = await writeWorkflow(directory, [issue]);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { tracker, driver });

  await orchestrator.pollOnce();
  await started.promise;
  await writeWorkflow(directory, [issue], { requiredLabels: ["new-required-label"] });
  const later = new Date(Date.now() + 2_000);
  await utimes(workflowPath, later, later);
  await orchestrator.pollOnce();

  assert.equal(aborted, false);
  tracker.setIssueState(issue.id, "Done");
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.equal(aborted, true);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("hot reload preserves a queued retry's session config until release", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-reload-retry-"));
  const issue = rawIssue("queued", "QUEUED-1", 1, "2025-01-01T00:00:00Z");
  const tracker = new MemoryTracker({ issues: [issue] });
  let runs = 0;
  const driver = new FakeDriver(async function* (context) {
    runs += 1;
    if (runs === 1) {
      yield event("turn_failed", { summary: "queue a retry" });
      return;
    }
    tracker.setIssueState(context.issue.id, "Done");
    yield event("turn_completed");
  });
  const workflowPath = await writeWorkflow(directory, [issue]);
  let now = Date.UTC(2026, 0, 1);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, {
    tracker,
    driver,
    now: () => now,
    failureBaseDelayMs: 100,
  });

  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();
  assert.equal(orchestrator.snapshot().retrying.length, 1);

  await writeWorkflow(directory, [issue], { requiredLabels: ["new-required-label"] });
  const later = new Date(Date.now() + 2_000);
  await utimes(workflowPath, later, later);
  now += 100;
  await orchestrator.pollOnce();

  await orchestrator.waitForCurrentRuns();

  assert.equal(runs, 2);
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
});

test("tracker reload cannot retarget running, blocked, or retried work with a repo-local id", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-reload-tracker-scope-"));
  const oldIssue = rawIssue("1", "OLD-1", 1, "2025-01-01T00:00:00Z");
  const newIssue = rawIssue("1", "NEW-1", 1, "2025-01-01T00:00:00Z");
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const seen: string[] = [];
  let runs = 0;
  const driver = new FakeDriver(async function* (context) {
    runs += 1;
    seen.push(context.issue.identifier);
    yield event("session_started", { sessionId: `scope-${runs}` });
    if (runs === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    yield event("approval_required", { summary: "pause this session" });
    yield event("turn_failed", { summary: "paused" });
  });
  const workflowPath = await writeWorkflow(directory, [oldIssue]);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger, { driver });

  await orchestrator.pollOnce();
  await firstStarted.promise;
  await writeWorkflow(directory, [newIssue]);
  const later = new Date(Date.now() + 2_000);
  await utimes(workflowPath, later, later);
  await orchestrator.pollOnce();

  assert.equal(orchestrator.snapshot().running[0]?.identifier, "OLD-1");
  releaseFirst.resolve();
  await orchestrator.waitForCurrentRuns();
  await orchestrator.pollOnce();
  assert.equal(orchestrator.snapshot().blocked[0]?.identifier, "OLD-1");

  assert.equal(await orchestrator.retryBlocked("OLD-1"), true);
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(seen, ["OLD-1", "OLD-1"]);
  assert.equal(orchestrator.snapshot().blocked[0]?.identifier, "OLD-1");
  await orchestrator.stop();
});

class FakeDriver implements AgentDriver {
  readonly kind: string;
  readonly #script: (context: AgentRunContext) => AsyncIterable<AgentEvent>;

  constructor(script: (context: AgentRunContext) => AsyncIterable<AgentEvent>, kind = "claude") {
    this.#script = script;
    this.kind = kind;
  }

  run(context: AgentRunContext): AsyncIterable<AgentEvent> {
    return this.#script(context);
  }
}

function event(type: AgentEvent["type"], fields: Omit<AgentEvent, "type" | "timestamp"> = {}): AgentEvent {
  return { type, timestamp: new Date().toISOString(), ...fields };
}

function rawIssue(
  id: string,
  identifier: string,
  priority: number,
  createdAt: string,
): Record<string, unknown> & { id: string; identifier: string } {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    description: "Test issue",
    state: "Todo",
    priority,
    labels: ["symphony"],
    dispatchable: true,
    created_at: createdAt,
  };
}

function githubIssue(): Issue {
  return {
    id: "7",
    nativeRef: { owner: "acme", repo: "widget", number: 7 },
    identifier: "acme/widget#7",
    title: "Fix\n\0the\twidget",
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

async function writeLinearDeliveryWorkflow(
  directory: string,
  options: { durable?: boolean } = {},
): Promise<string> {
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const config = {
    tracker: {
      kind: "linear",
      provider: { project_slug: "project", api_key: "$TRACKER_TOKEN" },
      required_labels: ["symphony"],
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    delivery: { review_state: "Human Review" },
    polling: { interval_ms: 60_000 },
    workspace: { root: "./workspaces" },
    hooks: { timeout_ms: 1_000 },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_attempts: 1, max_retry_backoff_ms: 1_000 },
    runtime: { kind: "codex", turn_timeout_ms: 10_000, stall_timeout_ms: 0, options: {} },
    ...(options.durable === true ? { state: { path: "./runs.json" } } : {}),
  };
  await writeFile(workflowPath, `---\n${stringifyYaml(config)}---\nWork on {{ issue.identifier }}.\n`);
  return workflowPath;
}

async function writeDeliveryWorkflow(
  directory: string,
  runtimeKind: "claude" | "codex",
  options: {
    delivery?: boolean;
    durable?: boolean;
    maxAttempts?: number;
    retryLabel?: string;
    stallTimeoutMs?: number;
  } = {},
): Promise<string> {
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const config = {
    tracker: {
      kind: "github",
      provider: { owner: "acme", repo: "widget", token: "$TRACKER_TOKEN" },
      required_labels: ["symphony"],
      active_states: ["open"],
      terminal_states: ["closed"],
    },
    ...(options.delivery === false ? {} : { delivery: { queue_label: "symphony", review_label: "human-review" } }),
    ...(options.retryLabel === undefined ? {} : { control: { retry_label: options.retryLabel } }),
    polling: { interval_ms: 60_000 },
    workspace: { root: "./workspaces" },
    hooks: { timeout_ms: 1_000 },
    ...(options.durable === true ? { state: { path: "./runs.json" } } : {}),
    agent: {
      max_concurrent_agents: 1,
      max_turns: 1,
      ...(options.maxAttempts === undefined ? {} : { max_attempts: options.maxAttempts }),
      max_retry_backoff_ms: 1_000,
    },
    runtime: {
      kind: runtimeKind,
      turn_timeout_ms: 10_000,
      stall_timeout_ms: options.stallTimeoutMs ?? 0,
      options: {},
    },
  };
  await writeFile(workflowPath, `---\n${stringifyYaml(config)}---\nWork on {{ issue.identifier }}.\n`);
  return workflowPath;
}

async function writeWorkflow(
  directory: string,
  issues: Array<Record<string, unknown>>,
  options: {
    maxConcurrentAgents?: number;
    maxAttempts?: number;
    hooks?: Record<string, string>;
    maxTurns?: number;
    pollIntervalMs?: number;
    requiredLabels?: string[];
    turnTimeoutMs?: number;
  } = {},
): Promise<string> {
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const config = {
    tracker: {
      kind: "memory",
      provider: { issues },
      required_labels: options.requiredLabels ?? ["symphony"],
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: options.pollIntervalMs ?? 60_000 },
    workspace: { root: "./workspaces" },
    hooks: { timeout_ms: 1_000, ...options.hooks },
    agent: {
      max_concurrent_agents: options.maxConcurrentAgents ?? 1,
      max_turns: options.maxTurns ?? 1,
      ...(options.maxAttempts === undefined ? {} : { max_attempts: options.maxAttempts }),
      max_retry_backoff_ms: 1_000,
    },
    runtime: {
      kind: "claude",
      turn_timeout_ms: options.turnTimeoutMs ?? 10_000,
      stall_timeout_ms: 0,
      options: {},
    },
  };
  await writeFile(workflowPath, `---\n${stringifyYaml(config)}---\nWork on {{ issue.identifier }}.\n`);
  return workflowPath;
}

function compactState(orchestrator: Orchestrator): { running: number; retrying: number; blocked: number } {
  const snapshot = orchestrator.snapshot();
  return {
    running: snapshot.running.length,
    retrying: snapshot.retrying.length,
    blocked: snapshot.blocked.length,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
