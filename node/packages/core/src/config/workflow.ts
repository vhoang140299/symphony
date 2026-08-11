import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Liquid, ParseError, TokenizationError, TokenKind } from "liquidjs";
import { parse as parseYaml } from "yaml";
import type { Issue } from "../domain.js";
import { parseWorkflowConfig, type WorkflowConfig } from "./schema.js";

export interface WorkflowDefinition {
  path: string;
  directory: string;
  config: WorkflowConfig;
  promptTemplate: string;
}

export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error";

export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

const defaultPrompt = "You are working on issue {{ issue.identifier }}: {{ issue.title }}\n\n{{ issue.description }}";
const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export async function readWorkflowSource(workflowPath: string): Promise<{ path: string; content: string }> {
  const absolutePath = path.resolve(workflowPath);
  try {
    return { path: absolutePath, content: await readFile(absolutePath, "utf8") };
  } catch {
    throw new WorkflowError("missing_workflow_file", "Workflow file could not be read");
  }
}

export function parseWorkflowSource(source: { path: string; content: string }): WorkflowDefinition {
  const absolutePath = source.path;
  const workflowDirectory = path.dirname(absolutePath);
  const { config: rawConfig, promptTemplate } = parseWorkflowDocument(source.content);
  const config = parseWorkflowConfig(rawConfig);
  config.workspace.root = resolvePath(config.workspace.root, workflowDirectory);
  if (config.state !== undefined) {
    config.state.path = resolvePath(config.state.path, workflowDirectory);
    assertSafeStatePath(config.state.path, config.workspace.root);
  }

  return {
    path: absolutePath,
    directory: workflowDirectory,
    config,
    promptTemplate: promptTemplate || defaultPrompt,
  };
}

export async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
  return parseWorkflowSource(await readWorkflowSource(workflowPath));
}

function parseWorkflowDocument(content: string): { config: unknown; promptTemplate: string } {
  if (!content.startsWith("---")) {
    return { config: {}, promptTemplate: content.trim() };
  }

  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { config: {}, promptTemplate: content.trim() };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "Workflow YAML front matter has no closing delimiter",
    );
  }

  const yaml = lines.slice(1, closingIndex).join("\n");
  let config: unknown;
  try {
    config = yaml.trim() === "" ? {} : parseYaml(yaml);
  } catch {
    throw new WorkflowError("workflow_parse_error", "Workflow YAML front matter could not be parsed");
  }
  if (!isRecord(config)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "Workflow YAML front matter must be a map",
    );
  }

  return {
    config,
    promptTemplate: lines.slice(closingIndex + 1).join("\n").trim(),
  };
}

export async function renderPrompt(workflow: WorkflowDefinition, issue: Issue, attempt: number | null): Promise<string> {
  let template;
  try {
    template = liquid.parse(workflow.promptTemplate);
  } catch (error) {
    if (isOutputInterpolationError(error)) {
      throw new WorkflowError("template_render_error", "Workflow prompt template could not be rendered");
    }
    throw new WorkflowError("template_parse_error", "Workflow prompt template could not be parsed");
  }

  try {
    return await liquid.render(template, {
      issue: issueForTemplate(issue),
      attempt,
    });
  } catch {
    throw new WorkflowError("template_render_error", "Workflow prompt template could not be rendered");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutputInterpolationError(error: unknown): boolean {
  return (error instanceof ParseError && error.token.kind === TokenKind.Output) ||
    (error instanceof TokenizationError && error.token.getText().startsWith("{{"));
}

function resolvePath(value: string, workflowDirectory: string): string {
  let resolved = value;
  if (value.startsWith("$") && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    const environmentValue = process.env[value.slice(1)];
    if (!environmentValue) throw new Error(`Missing path environment variable ${value}`);
    resolved = environmentValue;
  } else if (value === "~" || value.startsWith("~/")) {
    resolved = path.join(homedir(), value.slice(2));
  }

  return path.resolve(workflowDirectory, resolved);
}

function assertSafeStatePath(statePath: string, workspaceRoot: string): void {
  const relative = path.relative(workspaceRoot, statePath);
  const insideWorkspaceRoot =
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (relative === "" || (insideWorkspaceRoot && path.dirname(relative) !== ".")) {
    throw new Error("state.path must be outside workspace.root or a direct file child of it");
  }
}

function issueForTemplate(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    native_ref: issue.nativeRef,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    url: issue.url,
    assignee_id: issue.assigneeId,
    labels: issue.labels,
    blocked_by: issue.blockedBy,
    dispatchable: issue.dispatchable,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}
