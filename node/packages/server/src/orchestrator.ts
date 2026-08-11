import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkflowConfig } from "@ai-symphony/core/config/schema.js";
import { WorkflowStore } from "@ai-symphony/core/config/store.js";
import { renderPrompt, type WorkflowDefinition } from "@ai-symphony/core/config/workflow.js";
import { parseAgentCompletion } from "@ai-symphony/core/completion.js";
import type {
  AgentCompletion,
  AgentDriver,
  AgentEvent,
  AgentRateLimit,
  AgentUsage,
  BlockedReasonCode,
  Issue,
  PublishChangeInput,
  RetryError,
  Tracker,
} from "@ai-symphony/core/domain.js";
import { isTerminalAgentEvent, normalizeAgentRateLimit, normalizeRetryError, normalizeState } from "@ai-symphony/core/domain.js";
import type { AppLogger } from "@ai-symphony/core/log.js";
import { classifyIssue, isRoutable, selectRoutableIssues } from "@ai-symphony/core/routing.js";
import { RunStateStore, type PersistedClaim } from "@ai-symphony/core/state/store.js";
import { workflowScopeHash, workflowTrackerScopeHash } from "@ai-symphony/core/state/scope.js";
import { createAgentDriver } from "@ai-symphony/agents/registry.js";
import { createTracker } from "@ai-symphony/trackers/registry.js";
import { WorkspaceManager, workspaceKey } from "@ai-symphony/core/workspace/manager.js";

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
  blockedReasonCode?: BlockedReasonCode;
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
  turnCount: number;
  controller: AbortController;
  startedAtMs: number;
  lastActivityAtMs: number;
  sessionId: string | undefined;
  workspacePath: string | undefined;
  stopReason: StopReason | undefined;
  usage: AgentUsage;
  lastUsage: AgentUsage;
  lastEvent: AgentEvent["type"] | null;
  pendingDelivery?: PendingDelivery;
  done: Promise<void>;
}

interface DeferredEntry {
  issue: Issue;
  attempt: number | null;
  continuation: number;
  sessionId: string | undefined;
  sessionDriverKind: string;
  trackerScopeHash: string;
}

interface RetryEntry extends DeferredEntry {
  attempt: number;
  dueAtMs: number;
  reason: "continuation" | "failure";
  error: RetryError | null;
  pendingDelivery?: PendingDelivery;
}

interface BlockedEntry extends DeferredEntry {
  blockedAtMs: number;
  summary: string;
  reasonCode: BlockedReasonCode;
}

type RunOutcome =
  | { kind: "terminal" }
  | { kind: "release"; summary: string }
  | { kind: "continuation" }
  | { kind: "blocked"; summary: string; reasonCode: BlockedReasonCode }
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
  dispatchPaused: boolean;
  running: Array<{
    issueId: string;
    identifier: string;
    issueUrl: string | null;
    state: string;
    attempt: number | null;
    continuation: number;
    turnCount: number;
    startedAt: string;
    lastActivityAt: string;
    secondsRunning: number;
    usage: AgentUsage;
    lastEvent: AgentEvent["type"] | null;
    sessionId?: string;
    workspacePath?: string;
  }>;
  retrying: Array<{
    issueId: string;
    identifier: string;
    issueUrl: string | null;
    attempt: number;
    dueAt: string;
    reason: "continuation" | "failure";
    error: RetryError | null;
  }>;
  blocked: Array<{
    issueId: string;
    identifier: string;
    issueUrl: string | null;
    blockedAt: string;
    summary: string;
    reasonCode: BlockedReasonCode;
  }>;
  totals: AgentUsage & { secondsRunning: number };
  latestRateLimits: AgentRateLimit | null;
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
  readonly #blockedTransitions = new Map<string, Promise<boolean>>();
  readonly #claimed = new Set<string>();
  readonly #shutdownController = new AbortController();

  #workflow: WorkflowDefinition | undefined;
  #tracker: Tracker | undefined;
  #driver: AgentDriver | undefined;
  #stateStore: RunStateStore | undefined;
  #statePath: string | undefined;
  #scopeHash: string | undefined;
  #persistenceFailure: Error | undefined;
  #resolveFatalError: ((error: Error) => void) | undefined;
  readonly #fatalErrorPromise = new Promise<Error>((resolve) => {
    this.#resolveFatalError = resolve;
  });
  #stateWritesFrozen = false;
  #timer: NodeJS.Timeout | undefined;
  #initializationPromise: Promise<void> | undefined;
  #pollPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #started = false;
  #startupComplete = false;
  #shuttingDown = false;
  #startedAtMs: number | undefined;
  #lastPollAtMs: number | undefined;
  #dispatchPaused = false;
  #totals = zeroUsage();
  #completedRuntimeMs = 0;
  #latestRateLimits: AgentRateLimit | null = null;

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
    if (this.#initializationPromise) return this.#initializationPromise;
    if (this.#workflow) return;
    const initialization = this.#initializeWorkflow();
    this.#initializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.#initializationPromise === initialization) this.#initializationPromise = undefined;
    }
  }

  async start(): Promise<void> {
    if (this.#shuttingDown) throw new Error("A stopped orchestrator cannot be restarted");
    await this.initialize();
    if (this.#shuttingDown) throw new Error("A stopped orchestrator cannot be restarted");
    if (this.#started) return;
    this.#started = true;
    this.#startupComplete = false;
    try {
      await this.pollOnce();
      this.#requirePersistenceHealthy();
      if (this.#shuttingDown) throw new Error("A stopped orchestrator cannot be restarted");
      this.#startupComplete = true;
      this.#scheduleNextPoll();
    } catch (error) {
      this.#started = false;
      this.#startupComplete = false;
      throw error;
    }
  }

  isReady(): boolean {
    return this.#started && this.#startupComplete && !this.#shuttingDown && this.#persistenceFailure === undefined;
  }

  waitForFatalError(): Promise<Error> {
    return this.#fatalErrorPromise;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#started = false;
    this.#startupComplete = false;
    this.#shuttingDown = true;
    this.#stopPromise = Promise.resolve().then(() => this.#finishStop());
    this.#shutdownController.abort(new Error("Orchestrator is shutting down"));
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#stopPromise;
  }

  async #finishStop(): Promise<void> {
    for (const entry of this.#running.values()) {
      this.#requestStop(entry, "shutdown", "Orchestrator is shutting down");
    }
    const graceMs = this.#shutdownGraceMs ?? 30_000 + (this.#workflow?.config.hooks.timeoutMs ?? 0);
    const deadlineMs = Date.now() + graceMs;
    let checkpointSafe = true;
    let timedOut = false;
    const outstanding: Promise<unknown>[] = [];
    const initialization = this.#initializationPromise;
    if (initialization) outstanding.push(initialization);
    if (initialization && !(await settlesWithin(initialization, graceMs))) {
      checkpointSafe = false;
      timedOut = true;
      this.#stateWritesFrozen = true;
      this.#logger.error({ grace_ms: graceMs }, "Shutdown timed out waiting for initialization");
    } else if (initialization && this.#workflow === undefined) {
      checkpointSafe = false;
      this.#stateWritesFrozen = true;
    }
    const pollWaitMs = Math.max(0, deadlineMs - Date.now());
    const poll = this.#pollPromise;
    if (poll) outstanding.push(poll);
    if (poll && !(await settlesWithin(poll, pollWaitMs))) {
      timedOut = true;
      this.#logger.error({ grace_ms: graceMs }, "Shutdown timed out waiting for the active poll");
    }
    const blockedTransitions = Promise.allSettled([...this.#blockedTransitions.values()]);
    outstanding.push(blockedTransitions);
    const transitionWaitMs = Math.max(0, deadlineMs - Date.now());
    if (!(await settlesWithin(blockedTransitions, transitionWaitMs))) {
      checkpointSafe = false;
      timedOut = true;
      this.#stateWritesFrozen = true;
      this.#logger.error({ grace_ms: graceMs }, "Shutdown timed out waiting for blocked retry transitions");
    }
    for (const entry of this.#running.values()) {
      this.#requestStop(entry, "shutdown", "Orchestrator is shutting down");
    }
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    const runs = Promise.allSettled([...this.#running.values()].map((entry) => entry.done));
    outstanding.push(runs);
    if (!(await settlesWithin(runs, remainingMs))) {
      timedOut = true;
      this.#logger.error({ grace_ms: graceMs }, "Shutdown timed out waiting for agent runs");
    }

    let stopError: unknown;
    try {
      if (checkpointSafe) await this.#checkpointInterruptedRuns();
    } catch (error) {
      stopError = error;
    }

    for (const entry of this.#running.values()) this.#recordRuntime(entry);
    this.#running.clear();
    this.#retrying.clear();
    this.#blocked.clear();
    this.#claimed.clear();

    if (timedOut) {
      void Promise.allSettled(outstanding)
        .then(() => this.#releaseStateLease())
        .catch((error: unknown) => this.#logger.error({ error }, "Run state lease release failed"));
    } else {
      try {
        await this.#releaseStateLease();
      } catch (error) {
        if (stopError === undefined) stopError = error;
        else this.#logger.error({ error }, "Run state lease release failed");
      }
    }
    if (stopError !== undefined) throw stopError;
  }

  async #initializeWorkflow(): Promise<void> {
    try {
      const workflow = await this.#workflowStore.initialize();
      if (this.#shuttingDown) throw new Error("A stopped orchestrator cannot be restarted");
      this.#applyWorkflow(workflow);
      if (this.#shuttingDown) throw new Error("A stopped orchestrator cannot be restarted");
      if (this.#stateStore !== undefined) {
        await this.#stateStore.acquireLease();
      }
      if (this.#shuttingDown) throw new Error("A stopped orchestrator cannot be restarted");
      this.#startedAtMs = this.#now();
      await this.#recoverState();
      if (!this.#shuttingDown) await this.#cleanupTerminalWorkspaces();
      if (this.#shuttingDown && this.#stateWritesFrozen) this.#clearClaims();
    } catch (error) {
      try {
        await this.#releaseStateLease();
      } catch (releaseError) {
        this.#logger.error({ error: releaseError }, "Run state lease release failed after initialization error");
      }
      this.#clearClaims();
      this.#workflow = undefined;
      this.#tracker = undefined;
      this.#driver = undefined;
      this.#stateStore = undefined;
      this.#statePath = undefined;
      this.#scopeHash = undefined;
      this.#startedAtMs = undefined;
      this.#persistenceFailure = undefined;
      throw error;
    }
  }

  #clearClaims(): void {
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

  setDispatchPaused(paused: boolean): boolean {
    this.#requirePersistenceHealthy();
    if (this.#shuttingDown || this.#stateWritesFrozen) {
      throw new Error("A stopped orchestrator cannot change dispatch state");
    }
    if (this.#dispatchPaused === paused) return false;
    this.#dispatchPaused = paused;
    if (paused && this.#started && this.#workflow !== undefined) this.#scheduleNextPoll();
    return true;
  }

  async retryBlocked(issueIdOrIdentifier: string): Promise<boolean> {
    this.#requirePersistenceHealthy();
    if (this.#shuttingDown || this.#stateWritesFrozen) {
      throw new Error("A stopped orchestrator cannot retry blocked work");
    }
    const found = [...this.#blocked.entries()].find(
      ([issueId, entry]) => issueId === issueIdOrIdentifier || entry.issue.identifier === issueIdOrIdentifier,
    );
    if (!found) return false;
    const session = this.#sessionForTrackerScope(found[1].trackerScopeHash);
    if (session === undefined) {
      await this.#release(found[0]);
      return false;
    }
    return this.#scheduleBlockedRetry(found[0], found[1], found[1].issue, session);
  }

  async requestBlockedRetry(issueIdOrIdentifier: string): Promise<boolean> {
    this.#requirePersistenceHealthy();
    if (this.#shuttingDown || this.#stateWritesFrozen) {
      throw new Error("A stopped orchestrator cannot retry blocked work");
    }
    const found = [...this.#blocked.entries()].find(
      ([issueId, entry]) => issueId === issueIdOrIdentifier || entry.issue.identifier === issueIdOrIdentifier,
    );
    if (!found) return false;
    return this.#transitionBlocked(found[0], found[1], false);
  }

  snapshot(): OrchestratorSnapshot {
    const now = this.#now();
    const running = [...this.#running.values()].map((entry) => ({
      issueId: entry.issue.id,
      identifier: entry.issue.identifier,
      issueUrl: entry.issue.url,
      state: entry.issue.state,
      attempt: entry.attempt,
      continuation: entry.continuation,
      turnCount: entry.turnCount,
      startedAt: iso(entry.startedAtMs),
      lastActivityAt: iso(entry.lastActivityAtMs),
      secondsRunning: Math.max(0, now - entry.startedAtMs) / 1_000,
      usage: { ...entry.usage },
      lastEvent: entry.lastEvent,
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(entry.workspacePath === undefined ? {} : { workspacePath: entry.workspacePath }),
    }));
    return {
      startedAt: this.#startedAtMs === undefined ? null : iso(this.#startedAtMs),
      lastPollAt: this.#lastPollAtMs === undefined ? null : iso(this.#lastPollAtMs),
      dispatchPaused: this.#dispatchPaused,
      running,
      retrying: [...this.#retrying.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        issueUrl: entry.issue.url,
        attempt: entry.attempt,
        dueAt: iso(entry.dueAtMs),
        reason: entry.reason,
        error: normalizeRetryError(entry.error),
      })),
      blocked: [...this.#blocked.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        issueUrl: entry.issue.url,
        blockedAt: iso(entry.blockedAtMs),
        summary: entry.summary,
        reasonCode: entry.reasonCode,
      })),
      totals: {
        ...this.#totals,
        secondsRunning: this.#completedRuntimeMs / 1_000
          + running.reduce((total, entry) => total + entry.secondsRunning, 0),
      },
      latestRateLimits: normalizeAgentRateLimit(this.#latestRateLimits),
    };
  }

  async #poll(failOnTrackerError: boolean): Promise<void> {
    if (this.#shuttingDown) return;
    await this.initialize();
    this.#requirePersistenceHealthy();
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
    this.#requirePersistenceHealthy();
    if (this.#shuttingDown) return;
    await this.#dispatchDueRetries();
    this.#requirePersistenceHealthy();
    if (this.#shuttingDown) return;
    await this.#dispatchCandidates(failOnTrackerError);
    this.#lastPollAtMs = this.#now();
    this.#assertClaimInvariant();
  }

  #applyWorkflow(workflow: WorkflowDefinition): void {
    const tracker = this.#trackerOverride ?? createTracker(
      workflow.config.tracker.kind,
      workflow.config.tracker.provider,
      { logger: this.#logger, terminalStates: workflow.config.tracker.terminalStates },
    );
    const driver = this.#driverOverride ?? createAgentDriver(workflow.config.runtime.kind);
    const statePath = workflow.config.state?.path;
    const scopeHash = statePath === undefined ? undefined : workflowScopeHash(workflow);
    if (driver.kind !== workflow.config.runtime.kind) {
      throw new Error(`Runtime driver ${driver.kind} does not match configured kind ${workflow.config.runtime.kind}`);
    }
    if (workflow.config.control !== undefined && tracker.mutateIssue === undefined) {
      throw new Error("Configured control labels require tracker mutation support");
    }
    if (
      workflow.config.delivery !== undefined &&
      (tracker.mutateIssue === undefined ||
        (workflow.config.delivery.kind === "github_pr" && tracker.publishIssueChange === undefined))
    ) {
      throw new Error("Configured host delivery requires the tracker capabilities for its delivery kind");
    }
    if (this.#workflow !== undefined) {
      if (statePath !== this.#statePath) {
        throw new Error("Workflow reload cannot change durable state.path");
      }
      if (scopeHash !== this.#scopeHash) {
        throw new Error("Workflow reload cannot change the durable state scope");
      }
    }
    this.#workflow = workflow;
    this.#tracker = tracker;
    this.#driver = driver;
    this.#statePath = statePath;
    this.#scopeHash = scopeHash;
    if (statePath !== undefined && scopeHash !== undefined && this.#stateStore === undefined) {
      this.#stateStore = new RunStateStore(statePath, scopeHash);
    }
  }

  async #recoverState(): Promise<void> {
    const store = this.#stateStore;
    if (store === undefined) return;

    let claims: PersistedClaim[];
    try {
      claims = await store.load();
    } catch (error) {
      throw this.#failPersistence(error);
    }
    if (claims.length === 0) return;

    const workflow = this.#requireWorkflow();
    const tracker = this.#requireTracker();
    const driver = this.#requireDriver();
    const trackerScopeHash = workflowTrackerScopeHash(workflow);
    const claimIds = claims.map(({ issueId }) => issueId);
    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await tracker.fetchIssuesByIds(claimIds);
    } catch (error) {
      throw new Error("Unable to refresh persisted issues", { cause: error });
    }
    const issuesById = mapIssuesById(claimIds, refreshedIssues, "refreshing persisted issues");

    let changed = false;
    for (const claim of claims) {
      const issue = issuesById.get(claim.issueId);
      if (issue === undefined) {
        changed = true;
        continue;
      }

      const classification = classifyIssue(issue, workflow.config);
      if (classification === "terminal") {
        await this.#removeWorkspace(issue, workflow.config);
        changed = true;
        continue;
      }
      if (classification !== "routable") {
        changed = true;
        continue;
      }

      if (claim.kind === "running") {
        changed = true;
        if (claim.pendingDelivery !== undefined) {
          this.#retrying.set(issue.id, {
            issue,
            attempt: claim.attempt ?? 0,
            continuation: claim.continuation,
            sessionId: undefined,
            sessionDriverKind: driver.kind,
            trackerScopeHash,
            dueAtMs: Math.max(0, this.#now()),
            reason: "failure",
            error: "Host delivery failed",
            pendingDelivery: claim.pendingDelivery,
          });
        } else {
          this.#blocked.set(issue.id, {
            issue,
            attempt: claim.attempt,
            continuation: claim.continuation,
            sessionId: undefined,
            sessionDriverKind: driver.kind,
            trackerScopeHash,
            blockedAtMs: Math.max(0, this.#now()),
            summary: "Recovered an interrupted agent run; manual retry required",
            reasonCode: "run_interrupted",
          });
        }
      } else if (claim.kind === "retrying") {
        this.#retrying.set(issue.id, {
          issue,
          attempt: claim.attempt,
          continuation: claim.continuation,
          sessionId: undefined,
          sessionDriverKind: driver.kind,
          trackerScopeHash,
          dueAtMs: claim.dueAtMs,
          reason: claim.reason,
          error: normalizeRetryError(claim.error),
          ...(claim.pendingDelivery === undefined ? {} : { pendingDelivery: claim.pendingDelivery }),
        });
      } else {
        this.#blocked.set(issue.id, {
          issue,
          attempt: claim.attempt,
          continuation: claim.continuation,
          sessionId: undefined,
          sessionDriverKind: driver.kind,
          trackerScopeHash,
          blockedAtMs: claim.blockedAtMs,
          summary: claim.summary,
          reasonCode: claim.reasonCode ?? "unknown",
        });
      }
      this.#claimed.add(issue.id);
    }

    this.#assertClaimInvariant();
    if (changed) await this.#persistState();
  }

  async #persistState(): Promise<void> {
    const store = this.#stateStore;
    if (store === undefined || this.#stateWritesFrozen) return;
    this.#requirePersistenceHealthy();
    try {
      await store.save(this.#persistedClaims());
    } catch (error) {
      throw this.#failPersistence(error);
    }
  }

  #persistedClaims(): PersistedClaim[] {
    const claims: PersistedClaim[] = [];
    for (const entry of this.#running.values()) {
      claims.push({
        kind: "running",
        issueId: entry.issue.id,
        attempt: entry.attempt,
        continuation: entry.continuation,
        ...(entry.pendingDelivery === undefined ? {} : { pendingDelivery: entry.pendingDelivery }),
      });
    }
    for (const entry of this.#retrying.values()) {
      claims.push({
        kind: "retrying",
        issueId: entry.issue.id,
        attempt: entry.attempt,
        continuation: entry.continuation,
        dueAtMs: Math.max(0, entry.dueAtMs),
        reason: entry.reason,
        error: normalizeRetryError(entry.error),
        ...(entry.pendingDelivery === undefined ? {} : { pendingDelivery: entry.pendingDelivery }),
      });
    }
    for (const entry of this.#blocked.values()) {
      claims.push({
        kind: "blocked",
        issueId: entry.issue.id,
        attempt: entry.attempt,
        continuation: entry.continuation,
        blockedAtMs: Math.max(0, entry.blockedAtMs),
        summary: truncate(entry.summary, 2_000),
        reasonCode: entry.reasonCode,
      });
    }
    return claims.sort((left, right) => left.issueId.localeCompare(right.issueId));
  }

  #failPersistence(error: unknown): Error {
    if (this.#persistenceFailure !== undefined) return this.#persistenceFailure;
    const failure = new Error("Durable run state persistence failed", { cause: error });
    this.#persistenceFailure = failure;
    if (this.#started) {
      this.#resolveFatalError?.(failure);
      this.#resolveFatalError = undefined;
    }
    this.#started = false;
    this.#startupComplete = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const entry of this.#running.values()) {
      this.#requestStop(
        entry,
        "blocked",
        "Durable run state persistence failed; manual recovery required",
        "orchestrator_failure",
      );
    }
    this.#logger.error({ error }, "Durable run state persistence failed; scheduling stopped");
    return failure;
  }

  #requirePersistenceHealthy(): void {
    if (this.#persistenceFailure !== undefined) throw this.#persistenceFailure;
  }

  async #checkpointInterruptedRuns(): Promise<void> {
    const store = this.#stateStore;
    if (store === undefined || this.#stateWritesFrozen) return;
    for (const [issueId, entry] of [...this.#running.entries()]) {
      this.#recordRuntime(entry);
      this.#running.delete(issueId);
      if (entry.pendingDelivery !== undefined) {
        this.#retrying.set(issueId, {
          issue: entry.issue,
          attempt: entry.attempt ?? 0,
          continuation: entry.continuation,
          sessionId: undefined,
          sessionDriverKind: entry.driver.kind,
          trackerScopeHash: workflowTrackerScopeHash(entry.workflow),
          dueAtMs: Math.max(0, this.#now()),
          reason: "failure",
          error: "Host delivery failed",
          pendingDelivery: entry.pendingDelivery,
        });
      } else {
        this.#blocked.set(issueId, {
          issue: entry.issue,
          attempt: entry.attempt,
          continuation: entry.continuation,
          sessionId: undefined,
          sessionDriverKind: entry.driver.kind,
          trackerScopeHash: workflowTrackerScopeHash(entry.workflow),
          blockedAtMs: Math.max(0, this.#now()),
          summary: "Orchestrator stopped during an active run; manual retry required",
          reasonCode: "run_interrupted",
        });
      }
    }
    this.#assertClaimInvariant();
    this.#stateWritesFrozen = true;
    if (this.#persistenceFailure !== undefined) return;
    try {
      await store.save(this.#persistedClaims());
    } catch (error) {
      throw this.#failPersistence(error);
    }
  }

  async #releaseStateLease(): Promise<void> {
    await this.#stateStore?.releaseLease();
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
    const runningByTracker = new Map<Tracker, RunningEntry[]>();
    for (const entry of [...this.#running.values()]) {
      const stallTimeoutMs = entry.workflow.config.runtime.stallTimeoutMs;
      if (stallTimeoutMs > 0 && now - entry.lastActivityAtMs > stallTimeoutMs) {
        this.#requestStop(entry, "stalled", `No agent activity for ${stallTimeoutMs}ms`);
        continue;
      }

      const entries = runningByTracker.get(entry.tracker);
      if (entries === undefined) runningByTracker.set(entry.tracker, [entry]);
      else entries.push(entry);
    }

    for (const [tracker, entries] of runningByTracker) {
      const requestedIds = entries.map(({ issue }) => issue.id);
      let refreshedById: Map<string, Issue>;
      try {
        const refreshedIssues = await tracker.fetchIssuesByIds(requestedIds);
        refreshedById = mapIssuesById(requestedIds, refreshedIssues, "reconciling running issues");
      } catch (error) {
        for (const entry of entries) {
          this.#logger.warn(
            { error, issue_id: entry.issue.id, issue_identifier: entry.issue.identifier },
            "Running issue reconciliation failed; worker retained",
          );
        }
        continue;
      }

      for (const entry of entries) {
        const issueId = entry.issue.id;
        if (this.#running.get(issueId) !== entry) continue;
        const refreshed = refreshedById.get(issueId);
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
    }

    const blockedEntries = [...this.#blocked.entries()];
    const currentScopeHash = workflowTrackerScopeHash(this.#requireWorkflow());
    const batchSession = requireValue(
      this.#sessionForTrackerScope(currentScopeHash),
      "Current tracker session is unavailable",
    );
    const batchEntries = blockedEntries.filter(
      ([issueId, entry]) =>
        !this.#blockedTransitions.has(issueId) && entry.trackerScopeHash === currentScopeHash,
    );
    const batchIssueIds = batchEntries.map(([issueId]) => issueId);
    let batch: Promise<Map<string, Issue>> | undefined;
    const issueFromBatch = async (issueId: string): Promise<Issue | undefined> => {
      batch ??= Promise.resolve()
        .then(() => batchSession.tracker.fetchIssuesByIds(batchIssueIds))
        .then((issues) => mapIssuesById(batchIssueIds, issues, "reconciling blocked issues"));
      return (await batch).get(issueId);
    };

    const batchTransitions = new Map<string, Promise<boolean>>();
    let previousTransition = Promise.resolve();
    for (const [issueId, entry] of batchEntries) {
      const prefetchedIssue = previousTransition.then(() => issueFromBatch(issueId));
      const transition = this.#transitionBlocked(
        issueId,
        entry,
        true,
        { issue: prefetchedIssue, session: batchSession },
      );
      batchTransitions.set(issueId, transition);
      previousTransition = transition.then(
        () => undefined,
        () => undefined,
      );
    }

    for (const [issueId, entry] of blockedEntries) {
      try {
        await (
          batchTransitions.get(issueId)
          ?? this.#transitionBlocked(issueId, entry, true)
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Blocked retry label removal failed") {
          this.#logger.warn(
            { issue_id: issueId, issue_identifier: entry.issue.identifier },
            "Blocked retry label removal failed; claim retained",
          );
          continue;
        }
        this.#logger.warn(
          { error, issue_id: issueId, issue_identifier: entry.issue.identifier },
          "Blocked issue reconciliation failed",
        );
      }
    }
  }

  async #transitionBlocked(
    issueId: string,
    entry: BlockedEntry,
    requireRetryLabel: boolean,
    prefetched?: { issue: Promise<Issue | undefined>; session: SessionConfig },
  ): Promise<boolean> {
    const pending = this.#blockedTransitions.get(issueId);
    if (pending !== undefined) {
      const transitioned = await pending;
      if (transitioned || requireRetryLabel || this.#blocked.get(issueId) !== entry) return transitioned;
      return this.#transitionBlocked(issueId, entry, false);
    }

    let transition!: Promise<boolean>;
    transition = (async () => {
      if (this.#blocked.get(issueId) !== entry || this.#shuttingDown || this.#stateWritesFrozen) return false;

      const session = prefetched?.session ?? this.#sessionForTrackerScope(entry.trackerScopeHash);
      if (session === undefined) {
        await this.#release(issueId);
        return false;
      }
      let refreshed: Issue | undefined;
      if (prefetched === undefined) {
        refreshed = (await session.tracker.fetchIssuesByIds([issueId]))
          .find((issue) => sameIssueIdentity(entry.issue, issue));
      } else {
        const prefetchedIssue = await prefetched.issue;
        refreshed = sameIssueIdentity(entry.issue, prefetchedIssue) ? prefetchedIssue : undefined;
      }
      if (this.#blocked.get(issueId) !== entry || this.#shuttingDown || this.#stateWritesFrozen) return false;
      if (!this.#isCurrentSession(session)) return false;
      if (refreshed === undefined) {
        await this.#release(issueId);
        return false;
      }

      entry.issue = refreshed;
      const classification = classifyIssue(refreshed, session.workflow.config);
      if (classification === "terminal") {
        await this.#removeWorkspace(refreshed, session.workflow.config);
        if (this.#blocked.get(issueId) === entry && !this.#shuttingDown && !this.#stateWritesFrozen) {
          await this.#release(issueId);
        }
        return false;
      }
      if (classification !== "routable") {
        await this.#release(issueId);
        return false;
      }

      const retryLabel = session.workflow.config.control?.retryLabel;
      const hasRetryLabel = retryLabel !== undefined
        && refreshed.labels.some((label) => sameLabel(label, retryLabel));
      if (requireRetryLabel && !hasRetryLabel) return false;
      if (hasRetryLabel) {
        const mutateIssue = requireValue(
          session.tracker.mutateIssue?.bind(session.tracker),
          "Configured control labels require tracker mutation support",
        );
        try {
          await mutateIssue(
            refreshed,
            { kind: "remove_label", label: retryLabel },
            this.#shutdownController.signal,
          );
        } catch {
          throw new Error("Blocked retry label removal failed");
        }
        if (this.#blocked.get(issueId) !== entry || this.#shuttingDown || this.#stateWritesFrozen) return false;
      }

      const transitioned = await this.#scheduleBlockedRetry(issueId, entry, refreshed, session);
      if (transitioned && hasRetryLabel) {
        this.#logger.info(
          { issue_id: issueId, issue_identifier: refreshed.identifier },
          "Blocked retry label consumed; manual run scheduled",
        );
      }
      return transitioned;
    })().finally(() => {
      if (this.#blockedTransitions.get(issueId) === transition) this.#blockedTransitions.delete(issueId);
    });
    this.#blockedTransitions.set(issueId, transition);
    return transition;
  }

  async #scheduleBlockedRetry(
    issueId: string,
    entry: BlockedEntry,
    issue: Issue,
    session: SessionConfig,
  ): Promise<boolean> {
    if (this.#blocked.get(issueId) !== entry || this.#shuttingDown || this.#stateWritesFrozen) return false;
    this.#blocked.delete(issueId);
    this.#retrying.set(issueId, {
      issue,
      attempt: (entry.attempt ?? 0) + 1,
      continuation: entry.continuation,
      sessionId: entry.sessionDriverKind === session.driver.kind ? entry.sessionId : undefined,
      sessionDriverKind: session.driver.kind,
      trackerScopeHash: workflowTrackerScopeHash(session.workflow),
      dueAtMs: this.#now(),
      reason: "continuation",
      error: null,
    });
    this.#assertClaimInvariant();
    await this.#persistState();
    this.#wakeForRetry();
    return true;
  }

  async #dispatchDueRetries(): Promise<void> {
    if (this.#dispatchPaused) return;
    const due = [...this.#retrying.entries()]
      .filter(([, entry]) => entry.dueAtMs <= this.#now())
      .sort(([, left], [, right]) => left.dueAtMs - right.dueAtMs);

    for (const [issueId, retry] of due) {
      if (this.#shuttingDown || this.#dispatchPaused) return;
      const session = this.#sessionForTrackerScope(retry.trackerScopeHash);
      if (
        session === undefined
        || (retry.pendingDelivery !== undefined && !supportsHostDelivery(session.workflow, session.tracker))
      ) {
        if (retry.pendingDelivery === undefined) {
          await this.#release(issueId);
        } else {
          retry.dueAtMs = this.#now() + this.#requireWorkflow().config.polling.intervalMs;
          retry.error = "Host delivery failed";
          await this.#persistState();
        }
        continue;
      }
      let issue: Issue | undefined;
      try {
        [issue] = await session.tracker.fetchIssuesByIds([issueId]);
      } catch (error) {
        if (this.#shuttingDown || this.#dispatchPaused) return;
        this.#logger.warn(
          { error, issue_id: issueId, issue_identifier: retry.issue.identifier },
          "Retry refresh failed; retaining retry claim",
        );
        retry.dueAtMs = this.#now() + session.workflow.config.polling.intervalMs;
        retry.error = "Tracker refresh failed";
        await this.#persistState();
        continue;
      }
      if (this.#shuttingDown || this.#dispatchPaused) return;
      if (!sameIssueIdentity(retry.issue, issue)) {
        await this.#release(issueId);
        continue;
      }
      retry.issue = issue;
      const classification = classifyIssue(issue, session.workflow.config);
      if (classification === "terminal") {
        await this.#removeWorkspace(issue, session.workflow.config);
        await this.#release(issueId);
        continue;
      }
      if (classification !== "routable") {
        await this.#release(issueId);
        continue;
      }
      if (!this.#hasCapacity(issue, session.workflow.config)) {
        retry.dueAtMs = this.#now() + Math.min(1_000, session.workflow.config.polling.intervalMs);
        retry.error = "No available orchestrator slots";
        await this.#persistState();
        continue;
      }

      if (this.#dispatchPaused) return;
      await this.#spawn({
        issue,
        ...session,
        attempt: retry.attempt,
        continuation: retry.continuation,
        sessionId: retry.sessionDriverKind === session.driver.kind ? retry.sessionId : undefined,
        ...(retry.pendingDelivery === undefined ? {} : { pendingDelivery: retry.pendingDelivery }),
      });
    }
  }

  async #dispatchCandidates(failOnTrackerError: boolean): Promise<void> {
    if (this.#dispatchPaused) return;
    const workflow = this.#requireWorkflow();
    if (this.#running.size >= workflow.config.agent.maxConcurrentAgents) return;
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
    if (this.#dispatchPaused) return;

    for (const candidate of selectRoutableIssues(candidates, workflow.config)) {
      if (this.#shuttingDown || this.#dispatchPaused) return;
      if (this.#claimed.has(candidate.id)) continue;
      if (!this.#hasCapacity(candidate, workflow.config)) continue;

      let issue: Issue | undefined;
      try {
        [issue] = await tracker.fetchIssuesByIds([candidate.id]);
      } catch (error) {
        this.#logger.warn(
          { error, issue_id: candidate.id, issue_identifier: candidate.identifier },
          "Final issue refresh failed; dispatch skipped",
        );
        if (failOnTrackerError) throw error;
        continue;
      }
      if (this.#shuttingDown || this.#dispatchPaused) return;
      if (
        !sameIssueIdentity(candidate, issue)
        || !isRoutable(issue, workflow.config)
        || !this.#hasCapacity(issue, workflow.config)
      ) continue;

      if (this.#dispatchPaused) return;
      await this.#spawn({
        issue,
        workflow,
        tracker,
        driver,
        attempt: null,
        continuation: 0,
        sessionId: undefined,
      });
    }
  }

  async #spawn(source: SessionConfig & {
    issue: Issue;
    attempt: number | null;
    continuation: number;
    sessionId: string | undefined;
    pendingDelivery?: PendingDelivery;
  }): Promise<void> {
    if (this.#dispatchPaused) return;
    if (this.#shuttingDown) {
      await this.#release(source.issue.id);
      return;
    }
    const retry = this.#retrying.get(source.issue.id);
    this.#retrying.delete(source.issue.id);
    const now = this.#now();
    const entry: RunningEntry = {
      issue: source.issue,
      workflow: source.workflow,
      tracker: source.tracker,
      driver: source.driver,
      attempt: source.attempt,
      continuation: source.continuation,
      turnCount: 0,
      controller: new AbortController(),
      startedAtMs: now,
      lastActivityAtMs: now,
      sessionId: source.sessionId,
      workspacePath: undefined,
      stopReason: undefined,
      usage: zeroUsage(),
      lastUsage: zeroUsage(),
      lastEvent: null,
      ...(source.pendingDelivery === undefined ? {} : { pendingDelivery: source.pendingDelivery }),
      done: Promise.resolve(),
    };
    this.#running.set(entry.issue.id, entry);
    this.#claimed.add(entry.issue.id);
    this.#assertClaimInvariant();
    await this.#persistState();
    if (this.#shuttingDown || this.#running.get(entry.issue.id) !== entry) return;
    if (this.#dispatchPaused) {
      this.#running.delete(entry.issue.id);
      if (retry === undefined) this.#claimed.delete(entry.issue.id);
      else this.#retrying.set(entry.issue.id, retry);
      this.#assertClaimInvariant();
      await this.#persistState();
      return;
    }
    entry.done = this.#run(entry);
    void entry.done.catch(() => undefined);
    this.#logger.info(
      {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        attempt: entry.attempt,
        runtime: entry.driver.kind,
        ...(entry.sessionId === undefined ? {} : { session_id: entry.sessionId }),
      },
      entry.pendingDelivery === undefined ? "Agent run started" : "Host delivery retry started",
    );
  }

  async #run(entry: RunningEntry): Promise<void> {
    let outcome: RunOutcome;
    const runLifecycleHooks = entry.pendingDelivery === undefined;
    try {
      if (entry.pendingDelivery === undefined) {
        const workspace = await this.#workspaceManager.createForIssue(
          entry.issue,
          entry.workflow.config,
          entry.controller.signal,
        );
        entry.workspacePath = workspace.path;
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
      if (entry.stopReason) return this.#outcomeForStop(entry.stopReason);
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
          return { kind: "blocked", summary: completion.summary, reasonCode: "agent_reported" };
        }
        const pendingDelivery = { completion, idempotencyKey: randomUUID() };
        entry.pendingDelivery = pendingDelivery;
        await this.#persistState();
        try {
          return await this.#deliverCompletion(entry, pendingDelivery);
        } catch (error) {
          if (entry.stopReason) return this.#outcomeForDeliveryStop(entry.stopReason, pendingDelivery);
          return { kind: "delivery_failure", error, pendingDelivery };
        }
      }
      entry.continuation += 1;
    }
    return { kind: "continuation" };
  }

  async #consumeTurn(entry: RunningEntry, prompt: string): Promise<AgentEvent> {
    entry.turnCount += 1;
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
    const sensitiveEnvNames = trackerCredentialNames(entry.workflow.config);

    try {
      for await (const event of entry.driver.run({
        issue: boundIssue,
        workspacePath,
        prompt,
        attempt: entry.attempt,
        continuation: entry.continuation,
        signal: entry.controller.signal,
        runtimeOptions: entry.workflow.config.runtime.options,
        ...(sensitiveEnvNames.length === 0 ? {} : { sensitiveEnvNames }),
        ...(hostDelivery
          ? {
              completionMode: "publish_change" as const,
            }
          : {}),
        ...(hostDelivery || mutateIssue === undefined
          ? {}
          : {
              issueStateMutationMode: entry.tracker.issueStateMutationMode ?? "open_closed",
              mutateCurrentIssue: (mutation, signal) => {
                const retryLabel = entry.workflow.config.control?.retryLabel;
                if (
                  retryLabel !== undefined &&
                  (mutation.kind === "add_label" || mutation.kind === "remove_label") &&
                  sameLabel(mutation.label, retryLabel)
                ) {
                  throw new Error("Agent cannot mutate the configured control retry label");
                }
                return mutateIssue(boundIssue, mutation, signal);
              },
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
                      ...(entry.sessionId === undefined ? {} : { session_id: entry.sessionId }),
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
        entry.lastEvent = event.type;
        if (event.sessionId) entry.sessionId = event.sessionId;
        if (event.type === "usage_updated" && event.usage) this.#addUsage(entry, event.usage);
        if (event.type === "rate_limit_updated") {
          this.#latestRateLimits = normalizeAgentRateLimit(event.rateLimits);
        }
        if (event.type === "approval_required" || event.type === "input_required") {
          this.#requestStop(
            entry,
            "blocked",
            event.summary ?? (event.type === "approval_required" ? "Agent needs approval" : "Agent needs input"),
            "operator_action_required",
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
              event_type: event.type,
              summary: event.summary,
              ...(entry.sessionId === undefined ? {} : { session_id: entry.sessionId }),
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
    if (entry.stopReason) return this.#outcomeForDeliveryStop(entry.stopReason, pendingDelivery);
    if (!refreshed) return { kind: "release", summary: "Issue disappeared before delivery retry" };
    entry.issue = refreshed;
    const classification = classifyIssue(refreshed, entry.workflow.config);
    if (classification === "terminal") return { kind: "terminal" };
    if (classification !== "routable") {
      return { kind: "release", summary: `Issue became ${classification} before delivery retry` };
    }
    try {
      const workspaceRoot = await realpath(entry.workflow.config.workspace.root);
      entry.workspacePath = path.join(workspaceRoot, workspaceKey(entry.issue.identifier));
      return await this.#deliverCompletion(entry, pendingDelivery);
    } catch (error) {
      if (entry.stopReason) return this.#outcomeForDeliveryStop(entry.stopReason, pendingDelivery);
      return { kind: "delivery_failure", error, pendingDelivery };
    }
  }

  async #deliverCompletion(entry: RunningEntry, pendingDelivery: PendingDelivery): Promise<RunOutcome> {
    const { completion, idempotencyKey } = pendingDelivery;
    const delivery = requireValue(entry.workflow.config.delivery, "Host delivery is not configured");
    const mutateIssue = entry.tracker.mutateIssue?.bind(entry.tracker);
    if (mutateIssue === undefined) throw new Error("Configured host delivery requires tracker mutation support");

    let stage = "workspace_validation";
    try {
      const workspacePath = requireValue(entry.workspacePath, "Workspace is not initialized");
      const validatedPath = await this.#workspaceManager.validateForIssue(
        workspacePath,
        entry.issue,
        entry.workflow.config,
      );
      if (delivery.kind === "linear_handoff") {
        stage = "handoff_issue_refresh";
        const handoffOutcome = await this.#refreshDeliveryIssue(entry);
        if (handoffOutcome !== undefined) return handoffOutcome;
        stage = "handoff_comment";
        entry.controller.signal.throwIfAborted();
        await mutateIssue(
          entry.issue,
          {
            kind: "comment",
            idempotencyKey,
            body: linearHandoffComment(completion),
          },
          entry.controller.signal,
        );
        stage = "review_state_refresh";
        const refreshedOutcome = await this.#refreshDeliveryIssue(entry);
        if (refreshedOutcome !== undefined) return refreshedOutcome;
        stage = "review_state";
        entry.controller.signal.throwIfAborted();
        await mutateIssue(
          entry.issue,
          { kind: "set_state", state: delivery.reviewState },
          entry.controller.signal,
          { requireUnchanged: true },
        );
        return { kind: "release", summary: "Issue handed off for human review" };
      }

      const publishIssueChange = entry.tracker.publishIssueChange?.bind(entry.tracker);
      if (publishIssueChange === undefined) {
        throw new Error("Configured GitHub delivery requires tracker publishing support");
      }
      stage = "tracker_publish";
      entry.controller.signal.throwIfAborted();
      const published = await publishIssueChange(
        entry.issue,
        validatedPath,
        publishInputFor(entry.issue, completion),
        entry.controller.signal,
      );
      stage = "handoff_comment";
      entry.controller.signal.throwIfAborted();
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
      entry.controller.signal.throwIfAborted();
      await mutateIssue(
        entry.issue,
        { kind: "add_label", label: delivery.reviewLabel },
        entry.controller.signal,
      );
      stage = "queue_release";
      entry.controller.signal.throwIfAborted();
      await mutateIssue(
        entry.issue,
        { kind: "remove_label", label: delivery.queueLabel },
        entry.controller.signal,
      );
      return { kind: "release", summary: "Change published for human review" };
    } catch (error) {
      this.#logger.error(
        {
          operation: "host_delivery",
          delivery_stage: stage,
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          error,
          ...(entry.sessionId === undefined ? {} : { session_id: entry.sessionId }),
        },
        "Host delivery failed",
      );
      throw error;
    }
  }

  async #refreshDeliveryIssue(entry: RunningEntry): Promise<RunOutcome | undefined> {
    const issueId = entry.issue.id;
    const identifier = entry.issue.identifier;
    const [refreshed] = await entry.tracker.fetchIssuesByIds([issueId]);
    entry.controller.signal.throwIfAborted();
    if (refreshed === undefined) {
      return { kind: "release", summary: "Issue disappeared during host delivery" };
    }
    if (refreshed.id !== issueId || refreshed.identifier !== identifier) {
      throw new Error("Tracker returned a different issue during host delivery");
    }
    entry.issue = refreshed;
    const classification = classifyIssue(refreshed, entry.workflow.config);
    if (classification === "terminal") return { kind: "terminal" };
    if (classification !== "routable") {
      return { kind: "release", summary: `Issue became ${classification} during host delivery` };
    }
    return undefined;
  }

  #addUsage(entry: RunningEntry, current: AgentUsage): void {
    for (const key of usageKeys) {
      const value = finiteNonNegative(current[key]);
      const previous = finiteNonNegative(entry.lastUsage[key]);
      const delta = Math.max(0, value - previous);
      this.#totals[key] += delta;
      entry.usage[key] += delta;
    }
    entry.lastUsage = { ...current };
  }

  #recordRuntime(entry: RunningEntry): void {
    this.#completedRuntimeMs += Math.max(0, this.#now() - entry.startedAtMs);
  }

  async #finish(entry: RunningEntry, outcome: RunOutcome): Promise<void> {
    if (this.#running.get(entry.issue.id) !== entry) return;

    if (this.#shuttingDown) {
      outcome = this.#stateStore === undefined
        ? { kind: "release", summary: "Orchestrator stopped" }
        : entry.pendingDelivery === undefined
          ? {
              kind: "blocked",
              summary: "Orchestrator stopped during an active run; manual retry required",
              reasonCode: "run_interrupted",
            }
          : {
              kind: "delivery_failure",
              error: new Error("Orchestrator stopped during host delivery"),
              pendingDelivery: entry.pendingDelivery,
            };
    }
    if (outcome.kind === "terminal") {
      await this.#removeWorkspace(entry.issue, entry.workflow.config);
      if (this.#running.get(entry.issue.id) !== entry) return;
      this.#recordRuntime(entry);
      this.#running.delete(entry.issue.id);
      this.#claimed.delete(entry.issue.id);
      this.#assertClaimInvariant();
      await this.#persistState();
      return;
    }

    this.#recordRuntime(entry);
    this.#running.delete(entry.issue.id);
    if (outcome.kind === "release") {
      this.#claimed.delete(entry.issue.id);
      this.#logger.info(
        {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          reason: outcome.summary,
          ...(entry.sessionId === undefined ? {} : { session_id: entry.sessionId }),
        },
        "Issue claim released",
      );
    } else {
      const trackerScopeHash = workflowTrackerScopeHash(entry.workflow);
      const currentSession = this.#sessionForTrackerScope(trackerScopeHash);
      const session = currentSession ?? entry;
      if (currentSession === undefined && outcome.kind !== "delivery_failure") {
        this.#claimed.delete(entry.issue.id);
        this.#logger.info(
          {
            issue_id: entry.issue.id,
            issue_identifier: entry.issue.identifier,
            reason: "Tracker scope changed while the agent was running",
          },
          "Deferred issue claim released",
        );
      } else if (outcome.kind === "blocked") {
        const sessionId = entry.stopReason?.kind === "shutdown" || entry.driver.kind !== session.driver.kind
          ? undefined
          : entry.sessionId;
        this.#blocked.set(entry.issue.id, {
          issue: entry.issue,
          attempt: entry.attempt,
          continuation: entry.continuation,
          sessionId,
          sessionDriverKind: session.driver.kind,
          trackerScopeHash: workflowTrackerScopeHash(session.workflow),
          blockedAtMs: this.#now(),
          summary: outcome.summary,
          reasonCode: outcome.reasonCode,
        });
        this.#logger.warn(
          {
            issue_id: entry.issue.id,
            issue_identifier: entry.issue.identifier,
            reason: outcome.summary,
            ...(sessionId === undefined ? {} : { session_id: sessionId }),
          },
          "Agent run blocked; manual retry required",
        );
      } else {
        const isDeliveryFailure = outcome.kind === "delivery_failure";
        const isFailure = outcome.kind === "failure" || isDeliveryFailure;
        const nextAttempt = (entry.attempt ?? 0) + 1;
        const maxAttempts = session.workflow.config.agent.maxAttempts;
        if (!isDeliveryFailure && maxAttempts !== null && nextAttempt >= maxAttempts) {
          const summary = `Agent retry budget exhausted after ${nextAttempt} dispatched runs (max_attempts=${maxAttempts}); manual retry required`;
          this.#logger[isFailure ? "error" : "warn"](
            {
              issue_id: entry.issue.id,
              issue_identifier: entry.issue.identifier,
              reason: summary,
              error: outcome.kind === "failure" ? outcome.error : undefined,
              ...(entry.sessionId === undefined ? {} : { session_id: entry.sessionId }),
            },
            isFailure ? "Agent run failed; retry budget exhausted" : "Agent retry budget exhausted",
          );
          this.#blocked.set(entry.issue.id, {
            issue: entry.issue,
            attempt: entry.attempt,
            continuation: entry.continuation,
            sessionId: isFailure || entry.driver.kind !== session.driver.kind ? undefined : entry.sessionId,
            sessionDriverKind: session.driver.kind,
            trackerScopeHash: workflowTrackerScopeHash(session.workflow),
            blockedAtMs: this.#now(),
            summary,
            reasonCode: "retry_budget_exhausted",
          });
          this.#assertClaimInvariant();
          await this.#persistState();
          return;
        }
        const retryAttempt = isDeliveryFailure ? entry.attempt ?? 0 : nextAttempt;
        const delayMs = isDeliveryFailure
          ? this.#failureBaseDelayMs
          : isFailure
          ? Math.min(
              this.#failureBaseDelayMs * 2 ** Math.max(0, nextAttempt - 1),
              session.workflow.config.agent.maxRetryBackoffMs,
            )
          : this.#continuationDelayMs;
        this.#retrying.set(entry.issue.id, {
          issue: entry.issue,
          attempt: retryAttempt,
          continuation: entry.continuation,
          sessionId: isFailure || entry.driver.kind !== session.driver.kind ? undefined : entry.sessionId,
          sessionDriverKind: session.driver.kind,
          trackerScopeHash,
          dueAtMs: this.#now() + delayMs,
          reason: isFailure ? "failure" : "continuation",
          error: isDeliveryFailure ? "Host delivery failed" : isFailure ? "Agent run failed" : null,
          ...(outcome.kind === "delivery_failure" ? { pendingDelivery: outcome.pendingDelivery } : {}),
        });
        this.#logger[isFailure ? "error" : "info"](
          {
            issue_id: entry.issue.id,
            issue_identifier: entry.issue.identifier,
            delay_ms: delayMs,
            error:
              outcome.kind === "failure" || outcome.kind === "delivery_failure"
                ? outcome.error
                : undefined,
            ...(entry.sessionId === undefined ? {} : { session_id: entry.sessionId }),
          },
          isDeliveryFailure
            ? "Host delivery failed; retry scheduled"
            : isFailure
              ? "Agent run failed; retry scheduled"
              : "Continuation scheduled",
        );
      }
    }
    this.#assertClaimInvariant();
    await this.#persistState();
    if (this.#retrying.has(entry.issue.id)) this.#wakeForRetry();
  }

  #outcomeForStop(reason: StopReason): RunOutcome {
    if (reason.kind === "terminal") return { kind: "terminal" };
    if (reason.kind === "stalled" || reason.kind === "turn_timeout") {
      return { kind: "failure", error: new Error(reason.summary) };
    }
    if (reason.kind === "blocked") {
      return { kind: "blocked", summary: reason.summary, reasonCode: reason.blockedReasonCode ?? "unknown" };
    }
    return { kind: "release", summary: reason.summary };
  }

  #outcomeForDeliveryStop(reason: StopReason, pendingDelivery: PendingDelivery): RunOutcome {
    if (reason.kind === "stalled" || reason.kind === "turn_timeout") {
      return { kind: "delivery_failure", error: new Error(reason.summary), pendingDelivery };
    }
    return this.#outcomeForStop(reason);
  }

  #requestStop(
    entry: RunningEntry,
    kind: StopKind,
    summary: string,
    blockedReasonCode?: BlockedReasonCode,
  ): void {
    if (entry.stopReason) return;
    entry.stopReason = { kind, summary, ...(blockedReasonCode === undefined ? {} : { blockedReasonCode }) };
    entry.controller.abort(new Error(summary));
  }

  async #release(issueId: string): Promise<void> {
    this.#retrying.delete(issueId);
    this.#blocked.delete(issueId);
    this.#claimed.delete(issueId);
    this.#assertClaimInvariant();
    await this.#persistState();
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
    const stateLimits = config.agent.maxConcurrentAgentsByState;
    const stateLimit = Object.hasOwn(stateLimits, state) ? stateLimits[state] : undefined;
    if (stateLimit === undefined) return true;
    let stateCount = 0;
    for (const entry of this.#running.values()) {
      if (normalizeState(entry.issue.state) === state) stateCount += 1;
    }
    return stateCount < stateLimit;
  }

  #scheduleNextPoll(): void {
    if (!this.#started || this.#shuttingDown || this.#persistenceFailure !== undefined) return;
    if (this.#timer) clearTimeout(this.#timer);
    const intervalMs = this.#requireWorkflow().config.polling.intervalMs;
    let delayMs = intervalMs;
    if (!this.#dispatchPaused) {
      const nextRetryAt = Math.min(...[...this.#retrying.values()].map((entry) => entry.dueAtMs));
      const retryDelayMs = Number.isFinite(nextRetryAt) ? Math.max(0, nextRetryAt - this.#now()) : intervalMs;
      delayMs = Math.min(intervalMs, retryDelayMs);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.pollOnce()
        .catch((error: unknown) => this.#logger.error({ error }, "Poll cycle failed"))
        .finally(() => this.#scheduleNextPoll());
    }, delayMs);
  }

  #wakeForRetry(): void {
    if (this.#started && !this.#dispatchPaused) this.#scheduleNextPoll();
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

  #sessionForTrackerScope(trackerScopeHash: string): SessionConfig | undefined {
    const workflow = this.#requireWorkflow();
    if (trackerScopeHash !== workflowTrackerScopeHash(workflow)) return undefined;
    return {
      workflow,
      tracker: this.#requireTracker(),
      driver: this.#requireDriver(),
    };
  }

  #isCurrentSession(session: SessionConfig): boolean {
    return session.workflow === this.#workflow
      && session.tracker === this.#tracker
      && session.driver === this.#driver;
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

function sameLabel(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sameIssueIdentity(expected: Issue, actual: Issue | undefined): actual is Issue {
  return actual !== undefined && actual.id === expected.id && actual.identifier === expected.identifier;
}

function mapIssuesById(
  requestedIds: readonly string[],
  issues: readonly Issue[],
  context: string,
): Map<string, Issue> {
  const requested = new Set(requestedIds);
  const issuesById = new Map<string, Issue>();
  for (const issue of issues) {
    if (!requested.has(issue.id)) {
      throw new Error(`Tracker returned unexpected issue ${issue.id} while ${context}`);
    }
    if (issuesById.has(issue.id)) {
      throw new Error(`Tracker returned duplicate issue ${issue.id} while ${context}`);
    }
    issuesById.set(issue.id, issue);
  }
  return issuesById;
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

function linearHandoffComment(completion: AgentCompletion): string {
  const verification = completion.verification.map((item) => `- ${item}`).join("\n");
  return `Ready for human review.\n\n${completion.summary}\n\nVerification:\n${verification}`;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength).trimEnd();
}

function trackerCredentialNames(config: WorkflowConfig): string[] {
  const defaultNames = config.tracker.kind === "github"
    ? ["GITHUB_TOKEN"]
    : config.tracker.kind === "linear"
      ? ["LINEAR_API_KEY"]
      : undefined;
  if (defaultNames === undefined) return [];

  const tokenReference = config.tracker.kind === "linear"
    ? config.tracker.provider.api_key
    : config.tracker.provider.token;
  const matched = typeof tokenReference === "string"
    ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(tokenReference.trim())?.[1]
    : undefined;
  return [...new Set([...defaultNames, ...(matched === undefined ? [] : [matched])])];
}

export { workflowScopeHash } from "@ai-symphony/core/state/scope.js";

function supportsHostDelivery(workflow: WorkflowDefinition, tracker: Tracker): boolean {
  const delivery = workflow.config.delivery;
  return delivery !== undefined
    && tracker.mutateIssue !== undefined
    && (delivery.kind !== "github_pr" || tracker.publishIssueChange !== undefined);
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
