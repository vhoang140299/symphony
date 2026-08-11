import { createHash } from "node:crypto";
import type { WorkflowDefinition } from "../config/workflow.js";

export function workflowTrackerScopeHash(workflow: WorkflowDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify({
      workflowPath: workflow.path,
      trackerKind: workflow.config.tracker.kind,
      github: githubTrackerScope(workflow),
      linear: linearTrackerScope(workflow),
    }))
    .digest("hex");
}

export function workflowScopeHash(workflow: WorkflowDefinition): string {
  const provider = workflow.config.tracker.provider;
  const githubTracker = githubTrackerScope(workflow);
  const github = githubTracker === null
    ? null
    : {
        ...githubTracker,
        baseBranch: scopeString(provider.base_branch),
        gitUrl: scopeUrl(provider.git_url, null),
      };
  const linearTracker = linearTrackerScope(workflow);
  const linear = linearTracker === null
    ? null
    : {
        ...linearTracker,
        assignee: scopeString(provider.assignee),
      };
  const memoryIssues = workflow.config.tracker.kind === "memory" && Array.isArray(provider.issues)
    ? provider.issues
        .flatMap((issue) => {
          if (typeof issue !== "object" || issue === null) return [];
          const { id, identifier } = issue as Record<string, unknown>;
          return typeof id === "string" && typeof identifier === "string" ? [{ id, identifier }] : [];
        })
        .sort((left, right) => left.id.localeCompare(right.id) || left.identifier.localeCompare(right.identifier))
    : null;
  const linearDelivery = workflow.config.delivery?.kind === "linear_handoff"
    ? { reviewState: workflow.config.delivery.reviewState.trim().toLowerCase() }
    : null;
  return createHash("sha256")
    .update(JSON.stringify({
      workflowPath: workflow.path,
      trackerKind: workflow.config.tracker.kind,
      workspaceRoot: workflow.config.workspace.root,
      github,
      linear,
      memoryIssues,
      ...(linearDelivery === null ? {} : { linearDelivery }),
    }))
    .digest("hex");
}

function githubTrackerScope(workflow: WorkflowDefinition): {
  owner: string | null;
  repo: string | null;
  endpoint: string | null;
} | null {
  if (workflow.config.tracker.kind !== "github") return null;
  const provider = workflow.config.tracker.provider;
  return {
    owner: scopeString(provider.owner),
    repo: scopeString(provider.repo),
    endpoint: scopeUrl(provider.endpoint, "https://api.github.com"),
  };
}

function linearTrackerScope(workflow: WorkflowDefinition): {
  projectSlug: string | null;
  endpoint: string | null;
} | null {
  if (workflow.config.tracker.kind !== "linear") return null;
  const provider = workflow.config.tracker.provider;
  return {
    projectSlug: scopeString(provider.project_slug),
    endpoint: scopeUrl(provider.endpoint, "https://api.linear.app/graphql"),
  };
}

function scopeString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function scopeUrl(value: unknown, fallback: string | null): string | null {
  const candidate = scopeString(value) ?? fallback;
  if (candidate === null) return null;
  return new URL(candidate).toString().replace(/\/+$/u, "");
}
