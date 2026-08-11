import { createHash } from "node:crypto";
import type { AppLogger } from "../log.js";
import { parseWorkflowSource, readWorkflowSource, type WorkflowDefinition } from "./workflow.js";

export class WorkflowStore {
  readonly #path: string;
  readonly #logger: AppLogger;
  #workflow: WorkflowDefinition | null = null;
  #fingerprint = "";

  constructor(workflowPath: string, logger: AppLogger) {
    this.#path = workflowPath;
    this.#logger = logger;
  }

  async initialize(): Promise<WorkflowDefinition> {
    if (this.#workflow) return this.#workflow;
    const source = await readWorkflowSource(this.#path);
    const workflow = parseWorkflowSource(source);
    this.#workflow = workflow;
    this.#fingerprint = fingerprint(source.content);
    return workflow;
  }

  current(): WorkflowDefinition {
    if (!this.#workflow) throw new Error("WorkflowStore is not initialized");
    return this.#workflow;
  }

  async refresh(): Promise<WorkflowDefinition> {
    const current = this.current();
    let source: { path: string; content: string };
    try {
      source = await readWorkflowSource(current.path);
    } catch (error) {
      this.#logger.error({ error }, "Unable to read workflow; retaining last known good config");
      return current;
    }

    const nextFingerprint = fingerprint(source.content);
    if (nextFingerprint === this.#fingerprint) return current;

    try {
      const workflow = parseWorkflowSource(source);
      this.#workflow = workflow;
      this.#fingerprint = nextFingerprint;
      this.#logger.info({ workflow_path: workflow.path }, "Workflow reloaded");
      return workflow;
    } catch (error) {
      this.#logger.error({ error }, "Workflow reload failed; retaining last known good config");
      return current;
    }
  }
}

function fingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
