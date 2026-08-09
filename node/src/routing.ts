import type { WorkflowConfig } from "./config/schema.js";
import type { Issue } from "./domain.js";
import { normalizeState } from "./domain.js";

export type IssueClassification = "routable" | "terminal" | "non_active" | "unroutable";

export function classifyIssue(issue: Issue, config: WorkflowConfig): IssueClassification {
  const state = normalizeState(issue.state);
  if (config.tracker.terminalStates.some((terminal) => normalizeState(terminal) === state)) return "terminal";
  if (!config.tracker.activeStates.some((active) => normalizeState(active) === state)) return "non_active";
  return isRoutable(issue, config) ? "routable" : "unroutable";
}

export function isRoutable(issue: Issue, config: WorkflowConfig): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state || !issue.dispatchable) return false;
  const state = normalizeState(issue.state);
  if (!config.tracker.activeStates.some((active) => normalizeState(active) === state)) return false;
  if (config.tracker.terminalStates.some((terminal) => normalizeState(terminal) === state)) return false;
  const labels = new Set(issue.labels.map((label) => label.trim().toLowerCase()).filter(Boolean));
  return config.tracker.requiredLabels.every((label) => labels.has(label));
}

export function selectRoutableIssues(issues: Issue[], config: WorkflowConfig): Issue[] {
  const unique = new Map(issues.map((issue) => [issue.id, issue]));
  return [...unique.values()].filter((issue) => isRoutable(issue, config)).sort(compareIssues);
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
