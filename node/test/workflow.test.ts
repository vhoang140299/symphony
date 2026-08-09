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
  assert.equal(workflow.config.agent.maxAttempts, null);
});

test("accepts a positive max_attempts limit and rejects invalid limits", () => {
  assert.equal(
    parseWorkflowConfig({ tracker: { kind: "memory" }, agent: { max_attempts: 3 } }).agent.maxAttempts,
    3,
  );
  assert.throws(() => parseWorkflowConfig({ tracker: { kind: "memory" }, agent: { max_attempts: 0 } }));
  assert.throws(() => parseWorkflowConfig({ tracker: { kind: "memory" }, agent: { max_attempts: 1.5 } }));
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

test("host delivery is explicit, label-bound, and keeps tracker credentials out of the agent", () => {
  const config = {
    tracker: {
      kind: "github",
      provider: { owner: "acme", repo: "widget", token: "$TRACKER_TOKEN" },
      required_labels: ["Symphony"],
    },
    delivery: { queue_label: "SYMPHONY", review_label: "Human-Review" },
    runtime: { kind: "codex", options: { env_allowlist: ["CI"] } },
  };

  assert.deepEqual(parseWorkflowConfig(config).delivery, {
    queueLabel: "symphony",
    reviewLabel: "human-review",
  });
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { queue_label: "missing", review_label: "human-review" } }),
    /queue_label.*required_labels/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { queue_label: "symphony", review_label: "symphony" } }),
    /review_label.*required_labels/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { queue_label: "s".repeat(51), review_label: "human-review" } }),
    /50/,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { queue_label: "symphony", review_label: "r".repeat(51) } }),
    /50/,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, hooks: { after_run: "docker compose down" } }),
    /does not support hooks\.after_run/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, tracker: { kind: "memory", required_labels: ["symphony"] } }),
    /GitHub tracker/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, tracker: { ...config.tracker, provider: { owner: "acme", repo: "widget" } } }),
    /explicit tracker token environment reference/i,
  );
  assert.throws(
    () => parseWorkflowConfig({
      ...config,
      runtime: { kind: "claude", options: { env_allowlist: ["TRACKER_TOKEN"] } },
    }),
    /credentials must not be passed/i,
  );
  assert.throws(
    () => parseWorkflowConfig({
      ...config,
      runtime: { kind: "codex", options: { env_allowlist: ["GITHUB_TOKEN"] } },
    }),
    /credentials must not be passed/i,
  );
});

test("loads the checked-in GitHub issue-to-PR workflow", async () => {
  const workflow = await loadWorkflow(path.resolve("WORKFLOW.github.md"));
  const codexWorkflow = await loadWorkflow(path.resolve("WORKFLOW.codex.github.md"));

  assert.equal(workflow.config.tracker.kind, "github");
  assert.deepEqual(workflow.config.tracker.requiredLabels, ["symphony"]);
  assert.deepEqual(workflow.config.tracker.provider, {
    owner: "YOUR_ORG",
    repo: "YOUR_REPO",
    token: "$GITHUB_TOKEN",
    base_branch: "main",
  });
  assert.deepEqual(workflow.config.delivery, { queueLabel: "symphony", reviewLabel: "human-review" });
  assert.equal(workflow.config.agent.maxTurns, 1);
  assert.equal(workflow.config.agent.maxAttempts, 3);
  assert.deepEqual(workflow.config.runtime.options.allowed_tools, [
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
  ]);
  assert.equal(codexWorkflow.config.runtime.kind, "codex");
  assert.equal(codexWorkflow.config.agent.maxTurns, 1);
  assert.equal(codexWorkflow.config.agent.maxAttempts, 3);
  assert.deepEqual(codexWorkflow.config.delivery, workflow.config.delivery);
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
