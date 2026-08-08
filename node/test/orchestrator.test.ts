import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { WorkflowStore } from "../src/config/store.js";
import type { AgentDriver, AgentEvent, AgentRunContext, Tracker } from "../src/domain.js";
import { createLogger, type AppLogger } from "../src/log.js";
import { Orchestrator } from "../src/orchestrator.js";
import { MemoryTracker } from "../src/trackers/memory.js";
import { workspaceKey } from "../src/workspace/manager.js";

const logger = createLogger("silent");

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
  assert.deepEqual(orchestrator.snapshot().totals, {
    inputTokens: 20,
    outputTokens: 10,
    cacheReadInputTokens: 4,
    cacheCreationInputTokens: 2,
    totalTokens: 36,
    costUsd: 0.02,
  });
  assert.deepEqual(compactState(orchestrator), { running: 0, retrying: 0, blocked: 0 });
  await orchestrator.stop();
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

  assert.equal(orchestrator.retryBlocked("OLD-1"), true);
  await orchestrator.pollOnce();
  await orchestrator.waitForCurrentRuns();

  assert.deepEqual(seen, ["OLD-1", "OLD-1"]);
  assert.equal(orchestrator.snapshot().blocked[0]?.identifier, "OLD-1");
  await orchestrator.stop();
});

class FakeDriver implements AgentDriver {
  readonly kind = "claude";
  readonly #script: (context: AgentRunContext) => AsyncIterable<AgentEvent>;

  constructor(script: (context: AgentRunContext) => AsyncIterable<AgentEvent>) {
    this.#script = script;
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

async function writeWorkflow(
  directory: string,
  issues: Array<Record<string, unknown>>,
  options: {
    maxConcurrentAgents?: number;
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
