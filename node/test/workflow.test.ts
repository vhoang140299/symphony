import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWorkflowConfig } from "../src/config/schema.js";
import { WorkflowStore } from "../src/config/store.js";
import { loadWorkflow, renderPrompt } from "../src/config/workflow.js";
import type { Issue } from "../src/domain.js";
import { createLogger } from "../src/log.js";

const logger = createLogger("silent");

test("loads required tracker config, resolves workspace relative to WORKFLOW.md, and renders strict Liquid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: memory
workspace:
  root: ./workspaces
---
Work on {{ issue.identifier }} (attempt {{ attempt }}).
`,
  );

  const workflow = await loadWorkflow(workflowPath);
  assert.equal(workflow.config.workspace.root, path.join(directory, "workspaces"));
  assert.equal(await renderPrompt(workflow, sampleIssue, 2), "Work on TEST-1 (attempt 2).");

  workflow.promptTemplate = "{{ issue.missing_field }}";
  await assert.rejects(renderPrompt(workflow, sampleIssue, null));
});

test("rejects a workflow without tracker.kind", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-required-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  await writeFile(workflowPath, "---\nworkspace:\n  root: ./workspaces\n---\nDo work.\n");
  await assert.rejects(loadWorkflow(workflowPath), /tracker/i);
});

test("invalid hot reload retains the last known-good workflow", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-reload-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  await writeFile(workflowPath, "---\ntracker:\n  kind: memory\n---\nOriginal prompt.\n");
  const store = new WorkflowStore(workflowPath, logger);
  const original = await store.initialize();

  await writeFile(workflowPath, "---\ntracker: [invalid]\n---\nBroken prompt.\n");
  const later = new Date(Date.now() + 2_000);
  await utimes(workflowPath, later, later);
  const refreshed = await store.refresh();

  assert.equal(refreshed, original);
  assert.equal(store.current().promptTemplate, "Original prompt.");
});

test("uses SPEC agent defaults and accepts max_turns as the canonical turn limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-turns-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  await writeFile(workflowPath, "---\ntracker:\n  kind: memory\nagent:\n  max_turns: 1\n---\nDo work.\n");

  const workflow = await loadWorkflow(workflowPath);
  assert.equal(workflow.config.agent.maxTurns, 1);
  assert.equal(workflow.config.agent.maxConcurrentAgents, 10);
});

test("uses tracker-specific state defaults and preserves explicit states", () => {
  const memory = parseWorkflowConfig({ tracker: { kind: "memory" } });
  assert.deepEqual(memory.tracker.activeStates, ["Todo", "In Progress"]);
  assert.deepEqual(memory.tracker.terminalStates, ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]);

  const github = parseWorkflowConfig({ tracker: { kind: "github" } });
  assert.deepEqual(github.tracker.activeStates, ["open"]);
  assert.deepEqual(github.tracker.terminalStates, ["closed"]);

  const explicit = parseWorkflowConfig({
    tracker: { kind: "github", active_states: [" CLOSED "], terminal_states: [" OPEN "] },
  });
  assert.deepEqual(explicit.tracker.activeStates, ["CLOSED"]);
  assert.deepEqual(explicit.tracker.terminalStates, ["OPEN"]);
});

test("rejects unsupported tracker kinds and GitHub states while loading config", () => {
  assert.throws(() => parseWorkflowConfig({ tracker: { kind: "linear" } }), /memory.*github|github.*memory/i);
  assert.throws(
    () => parseWorkflowConfig({ tracker: { kind: "github", active_states: ["Todo"] } }),
    /GitHub tracker states must be open, closed, or all/,
  );
});

test("accepts supported coding-agent runtimes and rejects unknown kinds during config parsing", () => {
  assert.equal(parseWorkflowConfig({ tracker: { kind: "memory" }, runtime: { kind: "codex" } }).runtime.kind, "codex");
  assert.throws(
    () => parseWorkflowConfig({ tracker: { kind: "memory" }, runtime: { kind: "unknown" } }),
    /claude.*codex|codex.*claude/i,
  );
});

test("loads the checked-in GitHub issue-to-PR workflow", async () => {
  const workflow = await loadWorkflow(path.resolve("WORKFLOW.github.md"));

  assert.equal(workflow.config.tracker.kind, "github");
  assert.deepEqual(workflow.config.tracker.requiredLabels, ["symphony"]);
  assert.deepEqual(workflow.config.tracker.provider, {
    owner: "YOUR_ORG",
    repo: "YOUR_REPO",
    token: "$GITHUB_TOKEN",
    base_branch: "main",
  });
  assert.deepEqual(workflow.config.runtime.options.allowed_tools, [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
    "mcp__symphony__publish_current_change",
    "mcp__symphony__comment_current_issue",
    "mcp__symphony__add_current_issue_label",
    "mcp__symphony__remove_current_issue_label",
  ]);
});

const sampleIssue: Issue = {
  id: "test-1",
  nativeRef: null,
  identifier: "TEST-1",
  title: "Test",
  description: null,
  priority: 1,
  state: "Todo",
  branchName: null,
  url: null,
  assigneeId: null,
  labels: [],
  blockedBy: [],
  dispatchable: true,
  createdAt: null,
  updatedAt: null,
};
