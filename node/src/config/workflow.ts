import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Liquid } from "liquidjs";
import { parse as parseYaml } from "yaml";
import type { Issue } from "../domain.js";
import { parseWorkflowConfig, type WorkflowConfig } from "./schema.js";

export interface WorkflowDefinition {
  path: string;
  directory: string;
  config: WorkflowConfig;
  promptTemplate: string;
}

const defaultPrompt = "You are working on issue {{ issue.identifier }}: {{ issue.title }}\n\n{{ issue.description }}";
const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
  const absolutePath = path.resolve(workflowPath);
  const content = await readFile(absolutePath, "utf8");
  const { config: rawConfig, promptTemplate } = parseWorkflowDocument(content);
  const config = parseWorkflowConfig(rawConfig);
  config.workspace.root = resolvePath(config.workspace.root, path.dirname(absolutePath));

  return {
    path: absolutePath,
    directory: path.dirname(absolutePath),
    config,
    promptTemplate: promptTemplate || defaultPrompt,
  };
}

export function parseWorkflowDocument(content: string): { config: unknown; promptTemplate: string } {
  if (!content.startsWith("---")) {
    return { config: {}, promptTemplate: content.trim() };
  }

  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { config: {}, promptTemplate: content.trim() };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    throw new Error("WORKFLOW.md starts with YAML front matter but has no closing ---");
  }

  const yaml = lines.slice(1, closingIndex).join("\n");
  return {
    config: parseYaml(yaml) ?? {},
    promptTemplate: lines.slice(closingIndex + 1).join("\n").trim(),
  };
}

export async function renderPrompt(workflow: WorkflowDefinition, issue: Issue, attempt: number | null): Promise<string> {
  return liquid.parseAndRender(workflow.promptTemplate, {
    issue: issueForTemplate(issue),
    attempt,
  });
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
