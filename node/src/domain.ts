export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  nativeRef: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  dispatchable: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type IssueMutation =
  | { kind: "comment"; body: string; idempotencyKey?: string }
  | { kind: "add_label"; label: string }
  | { kind: "remove_label"; label: string }
  | { kind: "set_state"; state: string };

export interface IssueMutationOptions {
  requireUnchanged?: boolean;
}

export type IssueStateMutationMode = "open_closed" | "named";

export interface AgentCompletion {
  status: "ready" | "blocked";
  summary: string;
  verification: string[];
}

export interface PublishChangeInput {
  commitMessage: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export interface PublishedChange {
  url: string;
  number: number;
  branch: string;
}

export interface Tracker {
  readonly issueStateMutationMode?: IssueStateMutationMode;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  mutateIssue?(
    issue: Issue,
    mutation: IssueMutation,
    signal: AbortSignal,
    options?: IssueMutationOptions,
  ): Promise<void>;
  publishIssueChange?(
    issue: Issue,
    workspacePath: string,
    input: PublishChangeInput,
    signal: AbortSignal,
  ): Promise<PublishedChange>;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export type AgentEventType =
  | "session_started"
  | "activity"
  | "usage_updated"
  | "rate_limit_updated"
  | "approval_required"
  | "input_required"
  | "turn_completed"
  | "turn_failed";

export interface AgentEvent {
  type: AgentEventType;
  timestamp: string;
  sessionId?: string;
  summary?: string;
  usage?: AgentUsage;
  rateLimits?: unknown;
  blockingReason?: "approval" | "input";
  completion?: AgentCompletion;
  providerData?: Record<string, unknown>;
}

export interface AgentRunContext {
  issue: Issue;
  workspacePath: string;
  prompt: string;
  attempt: number | null;
  continuation: number;
  signal: AbortSignal;
  runtimeOptions: Record<string, unknown>;
  completionMode?: "publish_change";
  issueStateMutationMode?: IssueStateMutationMode;
  sensitiveEnvNames?: string[];
  mutateCurrentIssue?: (mutation: IssueMutation, signal: AbortSignal) => Promise<void>;
  publishCurrentChange?: (input: PublishChangeInput, signal: AbortSignal) => Promise<PublishedChange>;
  sessionId?: string;
}

export interface AgentDriver {
  readonly kind: string;
  run(context: AgentRunContext): AsyncIterable<AgentEvent>;
}

export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

export function isTerminalAgentEvent(event: AgentEvent): boolean {
  return event.type === "turn_completed" || event.type === "turn_failed";
}
