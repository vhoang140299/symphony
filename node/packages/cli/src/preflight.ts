import type { WorkflowDefinition } from "@ai-symphony/core/config/workflow.js";
import { loadWorkflow } from "@ai-symphony/core/config/workflow.js";
import type { Issue } from "@ai-symphony/core/domain.js";
import type { AppLogger } from "@ai-symphony/core/log.js";
import { selectRoutableIssues } from "@ai-symphony/core/routing.js";
import { createTracker } from "@ai-symphony/trackers/registry.js";

export interface PreflightResult {
  tracker: string;
  runtime: string;
  delivery: boolean;
  control: boolean;
  fetched: number;
  eligible: Array<Pick<Issue, "id" | "identifier" | "state">>;
}

export async function runPreflight(
  workflowPath: string,
  logger?: Pick<AppLogger, "warn">,
): Promise<PreflightResult> {
  const workflow = await loadWorkflow(workflowPath);
  const tracker = createTracker(
    workflow.config.tracker.kind,
    workflow.config.tracker.provider,
    {
      ...(logger === undefined ? {} : { logger }),
      terminalStates: workflow.config.tracker.terminalStates,
    },
  );
  const fetched = await tracker.fetchIssuesByStates(workflow.config.tracker.activeStates);
  return summarizePreflight(workflow, fetched);
}

export function summarizePreflight(workflow: WorkflowDefinition, fetched: Issue[]): PreflightResult {
  return {
    tracker: workflow.config.tracker.kind,
    runtime: workflow.config.runtime.kind,
    delivery: workflow.config.delivery !== undefined,
    control: workflow.config.control !== undefined,
    fetched: fetched.length,
    eligible: selectRoutableIssues(fetched, workflow.config)
      .map(({ id, identifier, state }) => ({ id, identifier, state })),
  };
}
