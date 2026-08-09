import { createHash } from "node:crypto";
import type { WorkflowDefinition } from "../config/workflow.js";

export function workflowScopeHash(workflow: WorkflowDefinition): string {
  const provider = workflow.config.tracker.provider;
  const github = workflow.config.tracker.kind === "github"
    ? {
        owner: scopeString(provider.owner),
        repo: scopeString(provider.repo),
        endpoint: scopeUrl(provider.endpoint, "https://api.github.com"),
        baseBranch: scopeString(provider.base_branch),
        gitUrl: scopeUrl(provider.git_url, null),
      }
    : null;
  const linear = workflow.config.tracker.kind === "linear"
    ? {
        projectSlug: scopeString(provider.project_slug),
        endpoint: scopeUrl(provider.endpoint, "https://api.linear.app/graphql"),
        assignee: scopeString(provider.assignee),
      }
    : null;
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

function scopeString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function scopeUrl(value: unknown, fallback: string | null): string | null {
  const candidate = scopeString(value) ?? fallback;
  if (candidate === null) return null;
  return new URL(candidate).toString().replace(/\/+$/u, "");
}
