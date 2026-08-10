import { stat } from "node:fs/promises";
import type { AppLogger } from "../log.js";
import { loadWorkflow, type WorkflowDefinition } from "./workflow.js";

export class WorkflowStore {
  readonly #path: string;
  readonly #logger: AppLogger;
  #workflow: WorkflowDefinition | null = null;
  #mtimeMs = -1;

  constructor(workflowPath: string, logger: AppLogger) {
    this.#path = workflowPath;
    this.#logger = logger;
  }

  async initialize(): Promise<WorkflowDefinition> {
    if (this.#workflow) return this.#workflow;
    const workflow = await loadWorkflow(this.#path);
    const mtimeMs = (await stat(workflow.path)).mtimeMs;
    this.#workflow = workflow;
    this.#mtimeMs = mtimeMs;
    return workflow;
  }

  current(): WorkflowDefinition {
    if (!this.#workflow) throw new Error("WorkflowStore is not initialized");
    return this.#workflow;
  }

  async refresh(): Promise<WorkflowDefinition> {
    const current = this.current();
    let nextMtimeMs: number;
    try {
      nextMtimeMs = (await stat(current.path)).mtimeMs;
    } catch (error) {
      this.#logger.error({ error }, "Unable to stat workflow; retaining last known good config");
      return current;
    }

    if (nextMtimeMs === this.#mtimeMs) return current;

    try {
      const workflow = await loadWorkflow(current.path);
      this.#workflow = workflow;
      this.#mtimeMs = nextMtimeMs;
      this.#logger.info({ workflow_path: workflow.path }, "Workflow reloaded");
      return workflow;
    } catch (error) {
      this.#logger.error({ error }, "Workflow reload failed; retaining last known good config");
      return current;
    }
  }
}
