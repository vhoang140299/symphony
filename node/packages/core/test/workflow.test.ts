import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parseWorkflowConfig } from "../src/config/schema.js";
import { WorkflowStore } from "../src/config/store.js";
import {
  loadWorkflow,
  renderPrompt,
  WorkflowError,
  type WorkflowErrorCode,
} from "../src/config/workflow.js";
import type { Issue } from "../src/domain.js";
import { createLogger } from "../src/log.js";
import { workflowScopeHash } from "../src/state/scope.js";

function workflowError(code: WorkflowErrorCode): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, code);
    assert.notEqual(error.message, "");
    assert.equal(error.cause, undefined);
    return true;
  };
}

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
  await assert.rejects(renderPrompt(workflow, sampleIssue, null), workflowError("template_render_error"));

  workflow.promptTemplate = "{{ issue.title | unknown_filter }}";
  await assert.rejects(renderPrompt(workflow, sampleIssue, null), workflowError("template_render_error"));

  workflow.promptTemplate = "{{ issue.title";
  await assert.rejects(renderPrompt(workflow, sampleIssue, null), workflowError("template_render_error"));

  workflow.promptTemplate = "{% if issue.title";
  await assert.rejects(renderPrompt(workflow, sampleIssue, null), workflowError("template_parse_error"));
});

test("exposes stable workflow load error codes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-errors-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");

  await assert.rejects(loadWorkflow(workflowPath), workflowError("missing_workflow_file"));

  await writeFile(workflowPath, "---\ntracker: [\n---\nPrompt.\n");
  await assert.rejects(loadWorkflow(workflowPath), workflowError("workflow_parse_error"));

  await writeFile(workflowPath, "---\n- tracker\n---\nPrompt.\n");
  await assert.rejects(loadWorkflow(workflowPath), workflowError("workflow_front_matter_not_a_map"));
});

test("resolves optional state paths with the workspace path rules", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-state-resolve-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const environmentName = "SYMPHONY_TEST_CHECKPOINT_PATH";
  const previousEnvironmentValue = process.env[environmentName];
  const environmentPath = path.join(directory, "environment-state.json");
  process.env[environmentName] = environmentPath;

  try {
    for (const [configuredPath, expectedPath] of [
      ["./relative-state.json", path.join(directory, "relative-state.json")],
      [`$${environmentName}`, environmentPath],
      ["~/.symphony-test-state.json", path.join(homedir(), ".symphony-test-state.json")],
    ]) {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: memory\nworkspace:\n  root: ./workspaces\nstate:\n  path: ${JSON.stringify(configuredPath)}\n---\nDo work.\n`,
      );
      assert.equal((await loadWorkflow(workflowPath)).config.state?.path, expectedPath);
    }
  } finally {
    if (previousEnvironmentValue === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previousEnvironmentValue;
  }
});

test("keeps checkpoint files out of issue workspace descendants", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-state-containment-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");

  for (const [configuredPath, accepted] of [
    ["./workspaces/state.json", true],
    ["./state/checkpoint.json", true],
    ["./workspaces", false],
    ["./workspaces/ISSUE-1/state.json", false],
  ] as const) {
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: memory\nworkspace:\n  root: ./workspaces\nstate:\n  path: ${JSON.stringify(configuredPath)}\n---\nDo work.\n`,
    );
    if (accepted) await loadWorkflow(workflowPath);
    else await assert.rejects(loadWorkflow(workflowPath), /state\.path.*workspace\.root.*direct file child/i);
  }
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
  let reloadLog = "";
  const reloadLogger = createLogger("error", {
    write(message: string) {
      reloadLog += message;
    },
  });
  await writeFile(workflowPath, "---\ntracker:\n  kind: memory\n---\nOriginal prompt.\n");
  const store = new WorkflowStore(workflowPath, reloadLogger);
  const original = await store.initialize();

  await writeFile(workflowPath, "---\ntracker: [WORKFLOW_RELOAD_SECRET_SENTINEL\n---\nBroken prompt.\n");
  assert.equal(await store.initialize(), original);
  const later = new Date(Date.now() + 2_000);
  await utimes(workflowPath, later, later);
  const refreshed = await store.refresh();

  assert.equal(refreshed, original);
  assert.equal(store.current().promptTemplate, "Original prompt.");
  assert.match(reloadLog, /Workflow reload failed/);
  assert.doesNotMatch(reloadLog, /WORKFLOW_RELOAD_SECRET_SENTINEL/);
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

test("normalizes per-state concurrency limits and ignores invalid entries", () => {
  const config = parseWorkflowConfig({
    tracker: { kind: "memory" },
    agent: {
      max_concurrent_agents_by_state: {
        " Todo ": 2,
        "IN PROGRESS": 3,
        " ": 4,
        Done: 0,
        Closed: -1,
        Review: 1.5,
        Backlog: "5",
        Canceled: null,
        Nonfinite: Number.NaN,
        Unsafe: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  });

  assert.deepEqual(config.agent.maxConcurrentAgentsByState, { todo: 2, "in progress": 3 });
  const prototypeStateLimits = parseWorkflowConfig({
    tracker: { kind: "memory" },
    agent: {
      max_concurrent_agents_by_state: Object.fromEntries([["__proto__", 2]]),
    },
  }).agent.maxConcurrentAgentsByState;
  assert.equal(Object.hasOwn(prototypeStateLimits, "__proto__"), true);
  assert.equal(prototypeStateLimits["__proto__"], 2);
  for (const maxConcurrentAgentsByState of [null, [], "invalid", 1]) {
    assert.throws(() => parseWorkflowConfig({
      tracker: { kind: "memory" },
      agent: { max_concurrent_agents_by_state: maxConcurrentAgentsByState },
    }));
  }
});

test("keeps state optional and validates its strict shape", () => {
  assert.equal(parseWorkflowConfig({ tracker: { kind: "memory" } }).state, undefined);
  assert.deepEqual(
    parseWorkflowConfig({ tracker: { kind: "memory" }, state: { path: " checkpoint.json " } }).state,
    { path: "checkpoint.json" },
  );
  assert.throws(() => parseWorkflowConfig({ tracker: { kind: "memory" }, state: { path: " " } }));
  assert.throws(() => parseWorkflowConfig({
    tracker: { kind: "memory" },
    state: { path: "checkpoint.json", extra: true },
  }), /unrecognized|extra/i);
});

test("keeps the operations listener opt-in and validates its strict address", () => {
  assert.equal(parseWorkflowConfig({ tracker: { kind: "memory" } }).server, undefined);
  assert.deepEqual(
    parseWorkflowConfig({ tracker: { kind: "memory" }, server: { port: 0 } }).server,
    { port: 0, host: "127.0.0.1" },
  );
  assert.deepEqual(
    parseWorkflowConfig({ tracker: { kind: "memory" }, server: { port: 65_535, host: " localhost " } }).server,
    { port: 65_535, host: "localhost" },
  );
  assert.deepEqual(
    parseWorkflowConfig({ tracker: { kind: "memory" }, server: { host: "localhost" } }).server,
    { host: "localhost" },
  );
  for (const port of [-1, 65_536, 1.5, "3000"]) {
    assert.throws(() => parseWorkflowConfig({ tracker: { kind: "memory" }, server: { port } }));
  }
  assert.throws(() => parseWorkflowConfig({ tracker: { kind: "memory" }, server: { host: " " } }));
  assert.throws(
    () => parseWorkflowConfig({ tracker: { kind: "memory" }, server: { port: 3000, extra: true } }),
    /unrecognized|extra/i,
  );
});

test("uses tracker-specific state defaults and preserves explicit states", () => {
  const memory = parseWorkflowConfig({ tracker: { kind: "memory" } });
  assert.deepEqual(memory.tracker.activeStates, ["Todo", "In Progress"]);
  assert.deepEqual(memory.tracker.terminalStates, ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]);

  const github = parseWorkflowConfig({ tracker: { kind: "github" } });
  assert.deepEqual(github.tracker.activeStates, ["open"]);
  assert.deepEqual(github.tracker.terminalStates, ["closed"]);

  const linear = parseWorkflowConfig({ tracker: { kind: "linear" } });
  assert.deepEqual(linear.tracker.activeStates, ["Todo", "In Progress"]);
  assert.deepEqual(linear.tracker.terminalStates, ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]);
  assert.equal(linear.agent.maxTurns, 1);
  assert.equal(linear.agent.maxAttempts, 3);

  const explicitLinear = parseWorkflowConfig({
    tracker: { kind: "linear" },
    agent: { max_turns: 2, max_attempts: 4 },
  });
  assert.equal(explicitLinear.agent.maxTurns, 2);
  assert.equal(explicitLinear.agent.maxAttempts, 4);

  const explicit = parseWorkflowConfig({
    tracker: { kind: "github", active_states: [" CLOSED "], terminal_states: [" OPEN "] },
  });
  assert.deepEqual(explicit.tracker.activeStates, ["CLOSED"]);
  assert.deepEqual(explicit.tracker.terminalStates, ["OPEN"]);
});

test("accepts provider kinds, rejects unsupported trackers, and validates provider states", () => {
  assert.equal(parseWorkflowConfig({ tracker: { kind: "linear" } }).tracker.kind, "linear");
  assert.throws(
    () => parseWorkflowConfig({ tracker: { kind: "unknown" } }),
    /memory.*github.*linear/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ tracker: { kind: "github", active_states: ["Todo"] } }),
    /GitHub tracker states must be open, closed, or all/,
  );
});

test("binds durable Linear state to its project scope without hashing credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-linear-scope-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const writeLinearWorkflow = async (
    projectSlug: string,
    token: string,
    assignee = "worker-1",
    reviewState?: string,
  ) => {
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  provider:\n    project_slug: ${projectSlug}\n    api_key: ${token}\n    assignee: ${assignee}\nworkspace:\n  root: ./workspaces\n${reviewState === undefined ? "" : `delivery:\n  review_state: ${JSON.stringify(reviewState)}\n`}---\nDo work.\n`,
    );
    return workflowScopeHash(await loadWorkflow(workflowPath));
  };

  const original = await writeLinearWorkflow("project-a", "$LINEAR_TOKEN_ONE");
  assert.equal(await writeLinearWorkflow("project-a", "$LINEAR_TOKEN_TWO"), original);
  assert.notEqual(await writeLinearWorkflow("project-b", "$LINEAR_TOKEN_TWO"), original);
  assert.notEqual(await writeLinearWorkflow("project-a", "$LINEAR_TOKEN_TWO", "worker-2"), original);
  const handoff = await writeLinearWorkflow(
    "project-a",
    "$LINEAR_TOKEN_TWO",
    "worker-1",
    "Human Review",
  );
  assert.notEqual(handoff, original);
  assert.equal(
    await writeLinearWorkflow("project-a", "$LINEAR_TOKEN_ONE", "worker-1", " human review "),
    handoff,
  );
  assert.notEqual(
    await writeLinearWorkflow("project-a", "$LINEAR_TOKEN_TWO", "worker-1", "Quality Review"),
    handoff,
  );
});

test("accepts supported coding-agent runtimes and rejects unknown kinds during config parsing", () => {
  assert.equal(parseWorkflowConfig({ tracker: { kind: "memory" }, runtime: { kind: "codex" } }).runtime.kind, "codex");
  assert.throws(
    () => parseWorkflowConfig({ tracker: { kind: "memory" }, runtime: { kind: "unknown" } }),
    /claude.*codex|codex.*claude/i,
  );
});

test("normalizes the safe Symphony top-level codex profile", async () => {
  assert.deepEqual(parseWorkflowConfig({ tracker: { kind: "memory" }, codex: {} }).runtime, {
    kind: "codex",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    options: { read_timeout_ms: 5_000 },
  });

  const configured = parseWorkflowConfig({
    tracker: { kind: "memory" },
    codex: {
      command: " codex app-server ",
      approval_policy: "never",
      thread_sandbox: "workspace-write",
      turn_timeout_ms: 12_000,
      read_timeout_ms: 2_000,
      stall_timeout_ms: 0,
    },
  });
  assert.deepEqual(configured.runtime, {
    kind: "codex",
    turnTimeoutMs: 12_000,
    stallTimeoutMs: 0,
    options: { read_timeout_ms: 2_000 },
  });

  const directory = await mkdtemp(path.join(tmpdir(), "symphony-workflow-codex-compat-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  try {
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: memory\ncodex:\n  command: codex app-server\n  approval_policy: never\n  thread_sandbox: workspace-write\n---\nDo work.\n`,
    );
    assert.equal((await loadWorkflow(workflowPath)).config.runtime.kind, "codex");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects ambiguous or unsafe top-level codex configuration", () => {
  assert.throws(
    () => parseWorkflowConfig({
      tracker: { kind: "memory" },
      codex: {},
      runtime: { kind: "codex" },
    }),
    /codex.*cannot be combined.*runtime/i,
  );

  for (const codex of [
    { command: "codex app-server --unsafe" },
    { approval_policy: "on-request" },
    { thread_sandbox: "danger-full-access" },
    { turn_sandbox_policy: { type: "dangerFullAccess" } },
    { turn_timeout_ms: 0 },
    { read_timeout_ms: 0 },
    { read_timeout_ms: 1.5 },
    { stall_timeout_ms: -1 },
    { stall_timeout_ms: 1.5 },
  ]) {
    assert.throws(() => parseWorkflowConfig({ tracker: { kind: "memory" }, codex }));
  }
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
    kind: "github_pr",
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
    () => parseWorkflowConfig({ ...config, tracker: { kind: "linear", required_labels: ["symphony"] } }),
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

test("Linear host handoff is state-bound and keeps tracker credentials out of the agent", () => {
  const config = {
    tracker: {
      kind: "linear",
      provider: { project_slug: "symphony", api_key: "$LINEAR_HANDOFF_TOKEN" },
      required_labels: ["Symphony"],
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done", "Canceled"],
    },
    delivery: { review_state: " Human Review " },
    runtime: { kind: "codex", options: { env_allowlist: ["CI"] } },
  };

  assert.deepEqual(parseWorkflowConfig(config).delivery, {
    kind: "linear_handoff",
    reviewState: "Human Review",
  });
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { review_state: "Human Review", extra: true } }),
    /unrecognized|extra|union/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { review_state: "r".repeat(101) } }),
    /100/,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { review_state: " in progress " } }),
    /review_state.*active_states.*terminal_states/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, delivery: { review_state: "CANCELED" } }),
    /review_state.*active_states.*terminal_states/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, hooks: { after_run: "cleanup" } }),
    /does not support hooks\.after_run/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, tracker: { ...config.tracker, kind: "github" } }),
    /Linear tracker/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, tracker: { ...config.tracker, kind: "memory" } }),
    /Linear tracker/i,
  );
  assert.throws(
    () => parseWorkflowConfig({
      ...config,
      tracker: { ...config.tracker, provider: { project_slug: "symphony" } },
    }),
    /Linear host handoff.*explicit tracker API key environment reference/i,
  );
  assert.throws(
    () => parseWorkflowConfig({
      ...config,
      tracker: { ...config.tracker, provider: { project_slug: "symphony", api_key: "literal-key" } },
    }),
    /Linear host handoff.*explicit tracker API key environment reference/i,
  );
  for (const name of ["LINEAR_HANDOFF_TOKEN", "LINEAR_API_KEY"]) {
    assert.throws(
      () => parseWorkflowConfig({
        ...config,
        runtime: { kind: "codex", options: { env_allowlist: [name] } },
      }),
      /credentials must not be passed/i,
    );
  }
});

test("operator retry control supports GitHub and Linear while keeping credentials host-side", () => {
  const config = {
    tracker: {
      kind: "github",
      provider: { owner: "acme", repo: "widget", token: "$TRACKER_TOKEN" },
      required_labels: ["Symphony"],
    },
    control: { retry_label: " Symphony-Retry " },
    runtime: { kind: "codex", options: { env_allowlist: ["CI"] } },
  };

  assert.deepEqual(parseWorkflowConfig(config).control, { retryLabel: "symphony-retry" });
  assert.throws(
    () => parseWorkflowConfig({ ...config, control: { retry_label: "symphony-retry", extra: true } }),
    /unrecognized|extra/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, control: { retry_label: "symphony" } }),
    /retry_label.*required_labels.*delivery labels/i,
  );
  assert.throws(
    () => parseWorkflowConfig({
      ...config,
      delivery: { queue_label: "symphony", review_label: "human-review" },
      control: { retry_label: "human-review" },
    }),
    /retry_label.*required_labels.*delivery labels/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, control: { retry_label: "r".repeat(51) } }),
    /50/,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, tracker: { ...config.tracker, kind: "memory" } }),
    /GitHub or Linear tracker/i,
  );
  assert.throws(
    () => parseWorkflowConfig({ ...config, tracker: { ...config.tracker, provider: { owner: "acme", repo: "widget" } } }),
    /explicit tracker token environment reference/i,
  );
  for (const name of ["TRACKER_TOKEN", "GITHUB_TOKEN"]) {
    assert.throws(
      () => parseWorkflowConfig({ ...config, runtime: { kind: "claude", options: { env_allowlist: [name] } } }),
      /credentials must not be passed/i,
    );
  }

  const linear = {
    tracker: {
      kind: "linear",
      provider: { project_slug: "symphony", api_key: "$LINEAR_CONTROL_TOKEN" },
      required_labels: ["Symphony"],
    },
    control: { retry_label: " Symphony-Retry " },
    runtime: { kind: "claude", options: { env_allowlist: ["CI"] } },
  };
  assert.deepEqual(parseWorkflowConfig(linear).control, { retryLabel: "symphony-retry" });
  assert.throws(
    () => parseWorkflowConfig({
      ...linear,
      tracker: { ...linear.tracker, provider: { project_slug: "symphony" } },
    }),
    /Linear retry control.*explicit tracker API key environment reference/i,
  );
  assert.throws(
    () => parseWorkflowConfig({
      ...linear,
      tracker: { ...linear.tracker, provider: { project_slug: "symphony", api_key: "literal-key" } },
    }),
    /Linear retry control.*explicit tracker API key environment reference/i,
  );
  for (const name of ["LINEAR_CONTROL_TOKEN", "LINEAR_API_KEY"]) {
    assert.throws(
      () => parseWorkflowConfig({
        ...linear,
        runtime: { kind: "claude", options: { env_allowlist: [name] } },
      }),
      /credentials must not be passed/i,
    );
  }
});

test("loads the checked-in GitHub issue-to-PR workflow", async () => {
  const workflow = await loadWorkflow(fileURLToPath(new URL("../../../workflows/WORKFLOW.github.md", import.meta.url)));
  const codexWorkflow = await loadWorkflow(fileURLToPath(new URL("../../../workflows/WORKFLOW.codex.github.md", import.meta.url)));

  assert.equal(workflow.config.tracker.kind, "github");
  assert.deepEqual(workflow.config.tracker.requiredLabels, ["symphony"]);
  assert.deepEqual(workflow.config.tracker.provider, {
    owner: "YOUR_ORG",
    repo: "YOUR_REPO",
    token: "$GITHUB_TOKEN",
    base_branch: "main",
  });
  assert.deepEqual(workflow.config.delivery, {
    kind: "github_pr",
    queueLabel: "symphony",
    reviewLabel: "human-review",
  });
  assert.deepEqual(workflow.config.control, { retryLabel: "symphony-retry" });
  assert.equal(workflow.config.state, undefined);
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
  assert.deepEqual(codexWorkflow.config.control, workflow.config.control);
  assert.equal(codexWorkflow.config.state, undefined);
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
