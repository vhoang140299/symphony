import { randomUUID } from "node:crypto";
import type { WorkflowConfig } from "./config/schema.js";
import { WorkflowStore } from "./config/store.js";
import { renderPrompt, type WorkflowDefinition } from "./config/workflow.js";
import { parseAgentCompletion } from "./completion.js";
import type {
  AgentCompletion,
  AgentDriver,
  AgentEvent,
  AgentUsage,
  Issue,
  PublishChangeInput,
  Tracker,
} from "./domain.js";
import { isTerminalAgentEvent, normalizeState } from "./domain.js";
import type { AppLogger } from "./log.js";
import { createAgentDriver } from "./agents/registry.js";
import { createTracker } from "./trackers/registry.js";
import { WorkspaceManager } from "./workspace/manager.js";

const continuationPrompt =
  "Continue working on the same issue. Inspect the current workspace, finish any remaining work, and verify the result.";

const zeroUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
});

type StopKind =
  | "shutdown"
  | "terminal"
  | "missing"
  | "non_active"
  | "unroutable"
  | "stalled"
  | "turn_timeout"
  | "blocked";

interface StopReason {
  kind: StopKind;
  summary: string;
}

interface SessionConfig {
  workflow: WorkflowDefinition;
  tracker: Tracker;
  driver: AgentDriver;
}

interface PendingDelivery {
  completion: AgentCompletion;
  idempotencyKey: string;
}

interface RunningEntry extends SessionConfig {
  issue: Issue;
  attempt: number | null;
  continuation: number;
  controller: AbortController;
  startedAtMs: number;
  lastActivityAtMs: number;
  sessionId: string | undefined;
  workspacePath: string | undefined;
  stopReason: StopReason | undefined;
  lastUsage: AgentUsage;
  pendingDelivery?: PendingDelivery;
  done: Promise<void>;
}

interface RetryEntry extends SessionConfig {
  issue: Issue;
  attempt: number;
  continuation: number;
  sessionId: string | undefined;
  dueAtMs: number;
  reason: "continuation" | "failure";
  pendingDelivery?: PendingDelivery;
}

interface BlockedEntry extends SessionConfig {
  issue: Issue;
  attempt: number | null;
  continuation: number;
  sessionId: string | undefined;
  blockedAtMs: number;
  summary: string;
}

type RunOutcome =
  | { kind: "terminal" }
  | { kind: "release"; summary: string }
  | { kind: "continuation" }
  | { kind: "blocked"; summary: string }
  | { kind: "delivery_failure"; error: unknown; pendingDelivery: PendingDelivery }
  | { kind: "failure"; error: unknown };

export interface OrchestratorDependencies {
  tracker?: Tracker;
  driver?: AgentDriver;
  workspaceManager?: WorkspaceManager;
  now?: () => number;
  continuationDelayMs?: number;
  failureBaseDelayMs?: number;
  shutdownGraceMs?: number;
}

export interface OrchestratorSnapshot {
  startedAt: string | null;
  lastPollAt: string | null;
  running: Array<{
    issueId: string;
    identifier: string;
    state: string;
    attempt: number | null;
    continuation: number;
    startedAt: string;
    lastActivityAt: string;
    sessionId?: string;
    workspacePath?: string;
  }>;
  retrying: Array<{
    issueId: string;
    identifier: string;
    attempt: number;
    dueAt: string;
    reason: "continuation" | "failure";
  }>;
  blocked: Array<{
    issueId: string;
    identifier: string;
    blockedAt: string;
    summary: string;
  }>;
  totals: AgentUsage;
  latestRateLimits: unknown;
}

export class Orchestrator {
  readonly #workflowStore: WorkflowStore;
  readonly #logger: AppLogger;
  readonly #trackerOverride: Tracker | undefined;
  readonly #driverOverride: AgentDriver | undefined;
  readonly #workspaceManager: WorkspaceManager;
  readonly #now: () => number;
  readonly #continuationDelayMs: number;
  readonly #failureBaseDelayMs: number;
  readonly #shutdownGraceMs: number | undefined;
  readonly #running = new Map<string, RunningEntry>();
  readonly #retrying = new Map<string, RetryEntry>();
  readonly #blocked = new Map<string, BlockedEntry>();
  readonly #claimed = new Set<string>();
  readonly #shutdownController = new AbortController();

  #workflow: WorkflowDefinition | undefined;
  #tracker: Tracker | undefined;
  #driver: AgentDriver | undefined;
  #timer: NodeJS.Timeout | undefined;
  #pollPromise: Promise<void> | undefined;
  #started = false;
  #shuttingDown = false;
  #startedAtMs: number | undefined;
  #lastPollAtMs: number | undefined;
  #totals = zeroUsage();
  #latestRateLimits: unknown = null;

  constructor(workflowStore: WorkflowStore, logger: AppLogger, dependencies: OrchestratorDependencies = {}) {
    this.#workflowStore = workflowStore;
    this.#logger = logger;
    this.#trackerOverride = dependencies.tracker;
    this.#driverOverride = dependencies.driver;
    this.#workspaceManager = dependencies.workspaceManager ?? new WorkspaceManager(logger);
    this.#now = dependencies.now ?? Date.now;
    this.#continuationDelayMs = dependencies.continuationDelayMs ?? 1_000;
    this.#failureBaseDelayMs = dependencies.failureBaseDelayMs ?? 10_000;
    this.#shutdownGraceMs = dependencies.shutdownGraceMs;
  }

  async initialize(): Promise<void> {
    if (this.#workflow) return;
    const workflow = await this.#workflowStore.initialize();
    this.#applyWorkflow(workflow);
    this.#startedAtMs = this.#now();
    await this.#cleanupTerminalWorkspaces();
  }

  async start(): Promise<void> {
    if (this.#shuttingDown) throw new Error("A stopped orchestrator cannot be restarted");
    await this.initialize();
    if (this.#started) return;
    this.#started = true;
    await this.pollOnce();
    this.#scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#shuttingDown = true;
    this.#shutdownController.abort(new Error("Orchestrator is shutting down"));
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;

    for (const entry of this.#running.values()) {
      this.#requestStop(entry, "shutdown", "Orchestrator is shutting down");
    }
    const graceMs =
      this.#shutdownGraceMs ?? Math.max(30_000, (this.#workflow?.config.hooks.timeoutMs ?? 0) + 1_000);
    const deadlineMs = Date.now() + graceMs;
    if (this.#pollPromise && !(await settlesWithin(this.#pollPromise, graceMs))) {
      this.#logger.error({ grace_ms: graceMs }, "Shutdown timed out waiting for the active poll");
    }
    for (const entry of this.#running.values()) {
      this.#requestStop(entry, "shutdown", "Orchestrator is shutting down");
    }
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    const runs = Promise.allSettled([...this.#running.values()].map((entry) => entry.done));
    if (!(await settlesWithin(runs, remainingMs))) {
      this.#logger.error({ grace_ms: graceMs }, "Shutdown timed out waiting for agent runs");
    }

    this.#running.clear();
    this.#retrying.clear();
    this.#blocked.clear();
    this.#claimed.clear();
  }

  async pollOnce(options: { failOnTrackerError?: boolean } = {}): Promise<void> {
    if (this.#pollPromise) return this.#pollPromise;
    const poll = this.#poll(options.failOnTrackerError ?? false);
    this.#pollPromise = poll;
    try {
      await poll;
    } finally {
      if (this.#pollPromise === poll) this.#pollPromise = undefined;
    }
  }

  async waitForCurrentRuns(): Promise<void> {
    const results = await Promise.allSettled([...this.#running.values()].map((entry) => entry.done));
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejection) throw rejection.reason;
  }

  retryBlocked(issueIdOrIdentifier: string): boolean {
    const found = [...this.#blocked.entries()].find(
      ([issueId, entry]) => issueId === issueIdOrIdentifier || entry.issue.identifier === issueIdOrIdentifier,
    );
    if (!found) return false;

    const [issueId, entry] = found;
    this.#blocked.delete(issueId);
    this.#retrying.set(issueId, {
      issue: entry.issue,
      workflow: entry.workflow,
      tracker: entry.tracker,
      driver: entry.driver,
      attempt: (entry.attempt ?? 0) + 1,
      continuation: entry.continuation,
      sessionId: entry.sessionId,
      dueAtMs: this.#now(),
      reason: "continuation",
    });
    this.#wakeForRetry();
    this.#assertClaimInvariant();
    return true;
  }

  snapshot(): OrchestratorSnapshot {
    return {
      startedAt: this.#startedAtMs === undefined ? null : iso(this.#startedAtMs),
      lastPollAt: this.#lastPollAtMs === undefined ? null : iso(this.#lastPollAtMs),
      running: [...this.#running.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        state: entry.issue.state,
        attempt: entry.attempt,
        continuation: entry.continuation,
        startedAt: iso(entry.startedAtMs),
        lastActivityAt: iso(entry.lastActivityAtMs),
        ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
        ...(entry.workspacePath === undefined ? {} : { workspacePath: entry.workspacePath }),
      })),
      retrying: [...this.#retrying.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        attempt: entry.attempt,
        dueAt: iso(entry.dueAtMs),
        reason: entry.reason,
      })),
      blocked: [...this.#blocked.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        blockedAt: iso(entry.blockedAtMs),
        summary: entry.summary,
      })),
      totals: { ...this.#totals },
      latestRateLimits: this.#latestRateLimits,
    };
  }

  async #poll(failOnTrackerError: boolean): Promise<void> {
    await this.initialize();
    if (this.#shuttingDown) return;
    const refreshed = await this.#workflowStore.refresh();
    if (refreshed !== this.#workflow) {
      try {
        this.#applyWorkflow(refreshed);
      } catch (error) {
        this.#logger.error({ error }, "Workflow adapter reload failed; retaining active configuration");
      }
    }

    if (this.#shuttingDown) return;
    await this.#reconcile();
    if (this.#shuttingDown) return;
    await this.#dispatchDueRetries();
    if (this.#shuttingDown) return;
    await this.#dispatchCandidates(failOnTrackerError);
    this.#lastPollAtMs = this.#now();
    this.#assertClaimInvariant();
  }

  #applyWorkflow(workflow: WorkflowDefinition): void {
    const tracker = this.#trackerOverride ?? createTracker(workflow.config.tracker.kind, workflow.config.tracker.provider);
    const driver = this.#driverOverride ?? createAgentDriver(workflow.config.runtime.kind);
    if (driver.kind !== workflow.config.runtime.kind) {
      throw new Error(`Runtime driver ${driver.kind} does not match configured kind ${workflow.config.runtime.kind}`);
    }
    if (
      workflow.config.delivery !== undefined &&
      (tracker.publishIssueChange === undefined || tracker.mutateIssue === undefined)
    ) {
      throw new Error("Configured host delivery requires tracker publishing and mutation support");
    }
    this.#workflow = workflow;
    this.#tracker = tracker;
    this.#driver = driver;
  }

  async #cleanupTerminalWorkspaces(): Promise<void> {
    const workflow = this.#requireWorkflow();
    const tracker = this.#requireTracker();
    let terminalIssues: Issue[];
    try {
      terminalIssues = await tracker.fetchIssuesByStates(workflow.config.tracker.terminalStates);
    } catch (error) {
      this.#logger.warn({ error }, "Unable to inspect terminal issues during startup cleanup");
      return;
    }
    for (const issue of terminalIssues) await this.#removeWorkspace(issue, workflow.config);
  }

  async #reconcile(): Promise<void> {
    const now = this.#now();
    for (const entry of [...this.#running.values()]) {
      const stallTimeoutMs = entry.workflow.config.runtime.stallTimeoutMs;
      if (stallTimeoutMs > 0 && now - entry.lastActivityAtMs > stallTimeoutMs) {
        this.#requestStop(entry, "stalled", `No agent activity for ${stallTimeoutMs}ms`);
        continue;
      }

      let refreshed: Issue | undefined;
      try {
        [refreshed] = await entry.tracker.fetchIssuesByIds([entry.issue.id]);
      } catch (error) {
        this.#logger.warn(
          { error, issue_id: entry.issue.id, issue_identifier: entry.issue.identifier },
          "Running issue reconciliation failed; worker retained",
        );
        continue;
      }
      if (!refreshed) {
        this.#requestStop(entry, "missing", "Issue disappeared from the tracker");
        continue;
      }
      entry.issue = refreshed;
      const classification = classifyIssue(refreshed, entry.workflow.config);
      if (classification === "terminal") this.#requestStop(entry, "terminal", "Issue entered a terminal state");
      if (classification === "non_active") this.#requestStop(entry, "non_active", "Issue left active states");
      if (classification === "unroutable") this.#requestStop(entry, "unroutable", "Issue is no longer dispatchable");
    }

    for (const [issueId, entry] of [...this.#blocked.entries()]) {
      let refreshed: Issue | undefined;
      try {
        [refreshed] = await entry.tracker.fetchIssuesByIds([issueId]);
      } catch (error) {
        this.#logger.warn({ error, issue_id: issueId }, "Blocked issue reconciliation failed");
        continue;
      }
      if (!refreshed) {
        this.#release(issueId);
        continue;
      }
      entry.issue = refreshed;
      const classification = classifyIssue(refreshed, entry.workflow.config);
      if (classification === "terminal") {
        await this.#removeWorkspace(refreshed, entry.workflow.config);
        this.#release(issueId);
      } else if (classification !== "routable") {
        this.#release(issueId);
      }
    }
  }

  async #dispatchDueRetries(): Promise<void> {
    const due = [...this.#retrying.entries()]
      .filter(([, entry]) => entry.dueAtMs <= this.#now())
      .sort(([, left], [, right]) => left.dueAtMs - right.dueAtMs);

    for (const [issueId, retry] of due) {
      if (this.#shuttingDown) return;
      let issue: Issue | undefined;
      try {
        [issue] = await retry.tracker.fetchIssuesByIds([issueId]);
      } catch (error) {
        this.#logger.warn({ error, issue_id: issueId }, "Retry refresh failed; retaining retry claim");
        retry.dueAtMs = this.#now() + retry.workflow.config.polling.intervalMs;
        continue;
      }
      if (!issue) {
        this.#release(issueId);
        continue;
      }
      retry.issue = issue;
      const classification = classifyIssue(issue, retry.workflow.config);
      if (classification === "terminal") {
        await this.#removeWorkspace(issue, retry.workflow.config);
        this.#release(issueId);
        continue;
      }
      if (classification !== "routable") {
        this.#release(issueId);
        continue;
      }
      if (!this.#hasCapacity(issue, retry.workflow.config)) {
        retry.dueAtMs = this.#now() + Math.min(1_000, retry.workflow.config.polling.intervalMs);
        continue;
      }

      this.#retrying.delete(issueId);
      this.#spawn({
        ...retry,
        issue,
      });
    }
  }

  async #dispatchCandidates(failOnTrackerError: boolean): Promise<void> {
    const workflow = this.#requireWorkflow();
    const tracker = this.#requireTracker();
    const driver = this.#requireDriver();
    let candidates: Issue[];
    try {
      candidates = await tracker.fetchIssuesByStates(workflow.config.tracker.activeStates);
    } catch (error) {
      this.#logger.error({ error }, "Tracker candidate fetch failed");
      if (failOnTrackerError) throw error;
      return;
    }

    const unique = new Map(candidates.map((issue) => [issue.id, issue]));
    for (const candidate of [...unique.values()].filter((issue) => isRoutable(issue, workflow.config)).sort(compareIssues)) {
      if (this.#shuttingDown) return;
      if (this.#claimed.has(candidate.id)) continue;
      if (!this.#hasCapacity(candidate, workflow.config)) continue;

      let issue: Issue | undefined;
      try {
        [issue] = await tracker.fetchIssuesByIds([candidate.id]);
      } catch (error) {
        this.#logger.warn({ error, issue_id: candidate.id }, "Final issue refresh failed; dispatch skipped");
        if (failOnTrackerError) throw error;
        continue;
      }
      if (this.#shuttingDown) return;
      if (!issue || !isRoutable(issue, workflow.config) || !this.#hasCapacity(issue, workflow.config)) continue;

      this.#claimed.add(issue.id);
      this.#spawn({
        issue,
        workflow,
        tracker,
        driver,
        attempt: null,
        continuation: 0,
        sessionId: undefined,
        dueAtMs: this.#now(),
        reason: "continuation",
      });
    }
  }

  #spawn(source: Omit<RetryEntry, "attempt"> & { attempt: number | null }): void {
    if (this.#shuttingDown) {
      this.#release(source.issue.id);
      return;
    }
    const now = this.#now();
    const entry: RunningEntry = {
      issue: source.issue,
      workflow: source.workflow,
      tracker: source.tracker,
      driver: source.driver,
      attempt: source.attempt,
      continuation: source.continuation,
      controller: new AbortController(),
      startedAtMs: now,
      lastActivityAtMs: now,
      sessionId: source.sessionId,
      workspacePath: undefined,
      stopReason: undefined,
      lastUsage: zeroUsage(),
      ...(source.pendingDelivery === undefined ? {} : { pendingDelivery: source.pendingDelivery }),
      done: Promise.resolve(),
    };
    this.#running.set(entry.issue.id, entry);
    this.#claimed.add(entry.issue.id);
    entry.done = this.#run(entry);
    this.#logger.info(
      {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        attempt: entry.attempt,
        runtime: entry.driver.kind,
      },
      entry.pendingDelivery === undefined ? "Agent run started" : "Host delivery retry started",
    );
  }

  async #run(entry: RunningEntry): Promise<void> {
    let outcome: RunOutcome;
    const runLifecycleHooks = entry.pendingDelivery === undefined;
    try {
      const workspace = await this.#workspaceManager.createForIssue(
        entry.issue,
        entry.workflow.config,
        entry.controller.signal,
      );
      entry.workspacePath = workspace.path;
      if (entry.pendingDelivery === undefined) {
        await this.#workspaceManager.beforeRun(
          workspace.path,
          entry.issue,
          entry.workflow.config,
          entry.controller.signal,
        );
        outcome = await this.#runTurns(entry);
      } else {
        outcome = await this.#retryDelivery(entry, entry.pendingDelivery);
      }
    } catch (error) {
      outcome = entry.stopReason
        ? entry.pendingDelivery === undefined
          ? this.#outcomeForStop(entry.stopReason)
          : this.#outcomeForDeliveryStop(entry.stopReason, entry.pendingDelivery)
        : entry.pendingDelivery === undefined
          ? { kind: "failure", error }
          : { kind: "delivery_failure", error, pendingDelivery: entry.pendingDelivery };
    } finally {
      if (runLifecycleHooks && entry.workspacePath) {
        await this.#workspaceManager.afterRun(
          entry.workspacePath,
          entry.issue,
          entry.workflow.config,
          this.#shutdownController.signal,
        );
      }
    }
    await this.#finish(entry, outcome);
  }

  async #runTurns(entry: RunningEntry): Promise<RunOutcome> {
    for (let turn = 0; turn < entry.workflow.config.agent.maxTurns; turn += 1) {
      if (entry.stopReason) return this.#outcomeForStop(entry.stopReason);
      const prompt = entry.sessionId
        ? continuationPrompt
        : await renderPrompt(entry.workflow, entry.issue, entry.attempt);
      const terminal = await this.#consumeTurn(entry, prompt);
      if (entry.stopReason) return this.#outcomeForStop(entry.stopReason);
      if (terminal.type === "turn_failed") {
        return { kind: "failure", error: new Error(terminal.summary ?? "Agent turn failed") };
      }

      let refreshed: Issue | undefined;
      try {
        [refreshed] = await entry.tracker.fetchIssuesByIds([entry.issue.id]);
      } catch (error) {
        return { kind: "failure", error };
      }
      if (!refreshed) return { kind: "release", summary: "Issue disappeared after agent turn" };
      entry.issue = refreshed;
      const classification = classifyIssue(refreshed, entry.workflow.config);
      if (classification === "terminal") return { kind: "terminal" };
      if (classification !== "routable") return { kind: "release", summary: `Issue became ${classification}` };

      if (entry.workflow.config.delivery !== undefined) {
        const completion = parseAgentCompletion(terminal.completion);
        if (completion === undefined) {
          return { kind: "failure", error: new Error("Agent returned an invalid delivery completion") };
        }
        if (completion.status === "blocked") {
          return { kind: "blocked", summary: completion.summary };
        }
        const pendingDelivery = { completion, idempotencyKey: randomUUID() };
        try {
          await this.#deliverCompletion(entry, pendingDelivery);
        } catch (error) {
          if (entry.stopReason) return this.#outcomeForDeliveryStop(entry.stopReason, pendingDelivery);
          return { kind: "delivery_failure", error, pendingDelivery };
        }
        return { kind: "release", summary: "Change published for human review" };
      }
      entry.continuation += 1;
    }
    return { kind: "continuation" };
  }

  async #consumeTurn(entry: RunningEntry, prompt: string): Promise<AgentEvent> {
    entry.lastUsage = zeroUsage();
    let terminal: AgentEvent | undefined;
    let terminalCount = 0;
    const timeoutMs = entry.workflow.config.runtime.turnTimeoutMs;
    let timeout: NodeJS.Timeout | undefined;
    const resetTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        this.#requestStop(entry, "turn_timeout", `No agent stream activity for ${timeoutMs}ms`);
      }, timeoutMs);
    };
    resetTimeout();

    const boundIssue = entry.issue;
    const workspacePath = requireValue(entry.workspacePath, "Workspace is not initialized");
    const mutateIssue = entry.tracker.mutateIssue?.bind(entry.tracker);
    const publishIssueChange = entry.tracker.publishIssueChange?.bind(entry.tracker);
    const hostDelivery = entry.workflow.config.delivery !== undefined;

    try {
      for await (const event of entry.driver.run({
        issue: boundIssue,
        workspacePath,
        prompt,
        attempt: entry.attempt,
        continuation: entry.continuation,
        signal: entry.controller.signal,
        runtimeOptions: entry.workflow.config.runtime.options,
        ...(hostDelivery
          ? {
              completionMode: "publish_change" as const,
              sensitiveEnvNames: deliveryCredentialNames(entry.workflow.config),
            }
          : {}),
        ...(hostDelivery || mutateIssue === undefined
          ? {}
          : {
              mutateCurrentIssue: (mutation, signal) => mutateIssue(boundIssue, mutation, signal),
            }),
        ...(hostDelivery || publishIssueChange === undefined
          ? {}
          : {
              publishCurrentChange: async (input, signal) => {
                let publishStage = "workspace_validation";
                try {
                  const validatedPath = await this.#workspaceManager.validateForIssue(
                    workspacePath,
                    boundIssue,
                    entry.workflow.config,
                  );
                  publishStage = "tracker_publish";
                  return await publishIssueChange(boundIssue, validatedPath, input, signal);
                } catch (error) {
                  this.#logger.error(
                    {
                      operation: "publish_current_change",
                      publish_stage: publishStage,
                      issue_id: boundIssue.id,
                      issue_identifier: boundIssue.identifier,
                      error,
                    },
                    "Current issue change publication failed",
                  );
                  throw error;
                }
              },
            }),
        ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      })) {
        resetTimeout();
        entry.lastActivityAtMs = this.#now();
        if (event.sessionId) entry.sessionId = event.sessionId;
        if (event.type === "usage_updated" && event.usage) this.#addUsage(entry, event.usage);
        if (event.type === "rate_limit_updated") this.#latestRateLimits = event.rateLimits ?? null;
        if (event.type === "approval_required" || event.type === "input_required") {
          this.#requestStop(
            entry,
            "blocked",
            event.summary ?? (event.type === "approval_required" ? "Agent needs approval" : "Agent needs input"),
          );
        }
        if (isTerminalAgentEvent(event)) {
          terminal = event;
          terminalCount += 1;
        }
        if (event.summary) {
          this.#logger.debug(
            {
              issue_id: entry.issue.id,
              issue_identifier: entry.issue.identifier,
              session_id: entry.sessionId,
              event_type: event.type,
              summary: event.summary,
            },
            "Agent event",
          );
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (entry.stopReason) {
      return terminal ?? {
        type: "turn_failed",
        timestamp: iso(this.#now()),
        summary: entry.stopReason.summary,
      };
    }
    if (terminalCount !== 1 || !terminal) {
      return {
        type: "turn_failed",
        timestamp: iso(this.#now()),
        summary: `Agent driver emitted ${terminalCount} terminal events; expected exactly one`,
      };
    }
    return terminal;
  }

  async #retryDelivery(entry: RunningEntry, pendingDelivery: PendingDelivery): Promise<RunOutcome> {
    let refreshed: Issue | undefined;
    try {
      [refreshed] = await entry.tracker.fetchIssuesByIds([entry.issue.id]);
    } catch (error) {
      return { kind: "delivery_failure", error, pendingDelivery };
    }
    if (!refreshed) return { kind: "release", summary: "Issue disappeared before delivery retry" };
    entry.issue = refreshed;
    const classification = classifyIssue(refreshed, entry.workflow.config);
    if (classification === "terminal") return { kind: "terminal" };
    if (classification !== "routable") {
      return { kind: "release", summary: `Issue became ${classification} before delivery retry` };
    }
    try {
      await this.#deliverCompletion(entry, pendingDelivery);
      return { kind: "release", summary: "Change published for human review" };
    } catch (error) {
      if (entry.stopReason) return this.#outcomeForDeliveryStop(entry.stopReason, pendingDelivery);
      return { kind: "delivery_failure", error, pendingDelivery };
    }
  }

  async #deliverCompletion(entry: RunningEntry, pendingDelivery: PendingDelivery): Promise<void> {
    const { completion, idempotencyKey } = pendingDelivery;
    const delivery = requireValue(entry.workflow.config.delivery, "Host delivery is not configured");
    const workspacePath = requireValue(entry.workspacePath, "Workspace is not initialized");
    const publishIssueChange = entry.tracker.publishIssueChange?.bind(entry.tracker);
    const mutateIssue = entry.tracker.mutateIssue?.bind(entry.tracker);
    if (publishIssueChange === undefined || mutateIssue === undefined) {
      throw new Error("Configured host delivery requires tracker publishing and mutation support");
    }

    let stage = "workspace_validation";
    try {
      const validatedPath = await this.#workspaceManager.validateForIssue(
        workspacePath,
        entry.issue,
        entry.workflow.config,
      );
      stage = "tracker_publish";
      const published = await publishIssueChange(
        entry.issue,
        validatedPath,
        publishInputFor(entry.issue, completion),
        entry.controller.signal,
      );
      stage = "handoff_comment";
      await mutateIssue(
        entry.issue,
        {
          kind: "comment",
          idempotencyKey,
          body: handoffComment(published.url, completion),
        },
        entry.controller.signal,
      );
      stage = "review_label";
      await mutateIssue(
        entry.issue,
        { kind: "add_label", label: delivery.reviewLabel },
        entry.controller.signal,
      );
      stage = "queue_release";
      await mutateIssue(
        entry.issue,
        { kind: "remove_label", label: delivery.queueLabel },
        entry.controller.signal,
      );
    } catch (error) {
      this.#logger.error(
        {
          operation: "host_delivery",
          delivery_stage: stage,
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          error,
        },
        "Host delivery failed",
      );
      throw error;
    }
  }

  #addUsage(entry: RunningEntry, current: AgentUsage): void {
    for (const key of usageKeys) {
      const value = finiteNonNegative(current[key]);
      const previous = finiteNonNegative(entry.lastUsage[key]);
      this.#totals[key] += Math.max(0, value - previous);
    }
    entry.lastUsage = { ...current };
  }

  async #finish(entry: RunningEntry, outcome: RunOutcome): Promise<void> {
    if (this.#running.get(entry.issue.id) !== entry) return;
    this.#running.delete(entry.issue.id);

    if (this.#shuttingDown) outcome = { kind: "release", summary: "Orchestrator stopped" };
    if (outcome.kind === "terminal") {
      await this.#removeWorkspace(entry.issue, entry.workflow.config);
      this.#claimed.delete(entry.issue.id);
    } else if (outcome.kind === "release") {
      this.#claimed.delete(entry.issue.id);
      this.#logger.info(
        { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, reason: outcome.summary },
        "Issue claim released",
      );
    } else if (outcome.kind === "blocked") {
      this.#blocked.set(entry.issue.id, {
        issue: entry.issue,
        workflow: entry.workflow,
        tracker: entry.tracker,
        driver: entry.driver,
        attempt: entry.attempt,
        continuation: entry.continuation,
        sessionId: entry.sessionId,
        blockedAtMs: this.#now(),
        summary: outcome.summary,
      });
      this.#logger.warn(
        { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, reason: outcome.summary },
        "Agent run blocked; manual retry required",
      );
    } else {
      const isDeliveryFailure = outcome.kind === "delivery_failure";
      const isFailure = outcome.kind === "failure" || isDeliveryFailure;
      const nextAttempt = (entry.attempt ?? 0) + 1;
      const delayMs = isFailure
        ? Math.min(
            this.#failureBaseDelayMs * 2 ** Math.max(0, nextAttempt - 1),
            entry.workflow.config.agent.maxRetryBackoffMs,
          )
        : this.#continuationDelayMs;
      this.#retrying.set(entry.issue.id, {
        issue: entry.issue,
        workflow: entry.workflow,
        tracker: entry.tracker,
        driver: entry.driver,
        attempt: nextAttempt,
        continuation: entry.continuation,
        sessionId: isFailure ? undefined : entry.sessionId,
        dueAtMs: this.#now() + delayMs,
        reason: isFailure ? "failure" : "continuation",
        ...(outcome.kind === "delivery_failure" ? { pendingDelivery: outcome.pendingDelivery } : {}),
      });
      this.#wakeForRetry();
      this.#logger[isFailure ? "error" : "info"](
        {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          delay_ms: delayMs,
          error:
            outcome.kind === "failure" || outcome.kind === "delivery_failure"
              ? outcome.error
              : undefined,
        },
        isDeliveryFailure
          ? "Host delivery failed; retry scheduled"
          : isFailure
            ? "Agent run failed; retry scheduled"
            : "Continuation scheduled",
      );
    }
    this.#assertClaimInvariant();
  }

  #outcomeForStop(reason: StopReason): RunOutcome {
    if (reason.kind === "terminal") return { kind: "terminal" };
    if (reason.kind === "stalled" || reason.kind === "turn_timeout") {
      return { kind: "failure", error: new Error(reason.summary) };
    }
    if (reason.kind === "blocked") return { kind: "blocked", summary: reason.summary };
    return { kind: "release", summary: reason.summary };
  }

  #outcomeForDeliveryStop(reason: StopReason, pendingDelivery: PendingDelivery): RunOutcome {
    if (reason.kind === "stalled" || reason.kind === "turn_timeout") {
      return { kind: "delivery_failure", error: new Error(reason.summary), pendingDelivery };
    }
    return this.#outcomeForStop(reason);
  }

  #requestStop(entry: RunningEntry, kind: StopKind, summary: string): void {
    if (entry.stopReason) return;
    entry.stopReason = { kind, summary };
    entry.controller.abort(new Error(summary));
  }

  #release(issueId: string): void {
    this.#retrying.delete(issueId);
    this.#blocked.delete(issueId);
    this.#claimed.delete(issueId);
  }

  async #removeWorkspace(issue: Issue, config: WorkflowConfig): Promise<void> {
    try {
      await this.#workspaceManager.removeForIssue(issue, config, this.#shutdownController.signal);
    } catch (error) {
      this.#logger.error(
        { error, issue_id: issue.id, issue_identifier: issue.identifier },
        "Workspace cleanup failed",
      );
    }
  }

  #hasCapacity(issue: Issue, config: WorkflowConfig): boolean {
    if (this.#running.size >= config.agent.maxConcurrentAgents) return false;
    const state = normalizeState(issue.state);
    const stateLimit = config.agent.maxConcurrentAgentsByState[state];
    if (stateLimit === undefined) return true;
    let stateCount = 0;
    for (const entry of this.#running.values()) {
      if (normalizeState(entry.issue.state) === state) stateCount += 1;
    }
    return stateCount < stateLimit;
  }

  #scheduleNextPoll(): void {
    if (!this.#started || this.#shuttingDown) return;
    if (this.#timer) clearTimeout(this.#timer);
    const intervalMs = this.#requireWorkflow().config.polling.intervalMs;
    const nextRetryAt = Math.min(...[...this.#retrying.values()].map((entry) => entry.dueAtMs));
    const retryDelayMs = Number.isFinite(nextRetryAt) ? Math.max(0, nextRetryAt - this.#now()) : intervalMs;
    const delayMs = Math.min(intervalMs, retryDelayMs);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.pollOnce()
        .catch((error: unknown) => this.#logger.error({ error }, "Poll cycle failed"))
        .finally(() => this.#scheduleNextPoll());
    }, delayMs);
  }

  #wakeForRetry(): void {
    if (this.#started) this.#scheduleNextPoll();
  }

  #assertClaimInvariant(): void {
    const expected = new Set([...this.#running.keys(), ...this.#retrying.keys(), ...this.#blocked.keys()]);
    if (expected.size !== this.#claimed.size || [...expected].some((id) => !this.#claimed.has(id))) {
      throw new Error("Claim invariant violated: claimed must equal running + retrying + blocked");
    }
  }

  #requireWorkflow(): WorkflowDefinition {
    return requireValue(this.#workflow, "Orchestrator is not initialized");
  }

  #requireTracker(): Tracker {
    return requireValue(this.#tracker, "Tracker is not initialized");
  }

  #requireDriver(): AgentDriver {
    return requireValue(this.#driver, "Agent driver is not initialized");
  }
}

const usageKeys: ReadonlyArray<keyof AgentUsage> = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "totalTokens",
  "costUsd",
];

function classifyIssue(issue: Issue, config: WorkflowConfig): "routable" | "terminal" | "non_active" | "unroutable" {
  const state = normalizeState(issue.state);
  if (config.tracker.terminalStates.some((terminal) => normalizeState(terminal) === state)) return "terminal";
  if (!config.tracker.activeStates.some((active) => normalizeState(active) === state)) return "non_active";
  return isRoutable(issue, config) ? "routable" : "unroutable";
}

function isRoutable(issue: Issue, config: WorkflowConfig): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state || !issue.dispatchable) return false;
  const state = normalizeState(issue.state);
  if (!config.tracker.activeStates.some((active) => normalizeState(active) === state)) return false;
  if (config.tracker.terminalStates.some((terminal) => normalizeState(terminal) === state)) return false;
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()).filter(Boolean));
  return config.tracker.requiredLabels.every((label) => labels.has(label));
}

function publishInputFor(issue: Issue, completion: AgentCompletion): PublishChangeInput {
  const title = `${issue.identifier}: ${issue.title}`.replace(/[\0\s]+/gu, " ").trim();
  const verification = completion.verification.map((item) => `- ${item}`).join("\n");
  return {
    commitMessage: truncate(title, 200),
    pullRequestTitle: truncate(title, 256),
    pullRequestBody: `## Summary\n\n${completion.summary}\n\n## Verification\n\n${verification}`,
  };
}

function handoffComment(pullRequestUrl: string, completion: AgentCompletion): string {
  const verification = completion.verification.map((item) => `- ${item}`).join("\n");
  return `Pull request ready for human review: ${pullRequestUrl}\n\n${completion.summary}\n\nVerification:\n${verification}`;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength).trimEnd();
}

function deliveryCredentialNames(config: WorkflowConfig): string[] {
  const tokenReference = config.tracker.provider.token;
  const matched = typeof tokenReference === "string"
    ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(tokenReference.trim())?.[1]
    : undefined;
  return matched === undefined ? ["GITHUB_TOKEN"] : ["GITHUB_TOKEN", matched];
}

function compareIssues(left: Issue, right: Issue): number {
  const priorityDifference = priorityRank(left.priority) - priorityRank(right.priority);
  if (priorityDifference !== 0) return priorityDifference;
  const createdDifference = dateRank(left.createdAt) - dateRank(right.createdAt);
  if (createdDifference !== 0) return createdDifference;
  return left.identifier.localeCompare(right.identifier);
}

function priorityRank(priority: number | null): number {
  return priority !== null && priority >= 1 && priority <= 4 ? priority : Number.MAX_SAFE_INTEGER;
}

function dateRank(value: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
    );
  });
}
