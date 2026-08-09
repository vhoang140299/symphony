import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { loadWorkflow } from "../src/config/workflow.js";
import type { Issue } from "../src/domain.js";
import { summarizePreflight } from "../src/preflight.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const exampleWorkflowPath = fileURLToPath(new URL("../WORKFLOW.md", import.meta.url));

test("CLI prints help and exits successfully", async () => {
  const result = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.match(result.stdout, /Usage: symphony-node \[--once \| --preflight\] \[WORKFLOW\]/);
  assert.equal(result.stderr, "");
});

test("CLI --once polls once, prints a compact snapshot, and exits successfully when idle", async () => {
  const result = await execFileAsync(process.execPath, [cliPath, "--once", exampleWorkflowPath], {
    env: { ...process.env, LOG_LEVEL: "silent" },
  });

  assert.deepEqual(JSON.parse(result.stdout), {
    running: 0,
    retrying: 0,
    blocked: 0,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  });
  assert.equal(result.stderr, "");
});

test("CLI --preflight reports only sorted eligible issues without running hooks or an agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-preflight-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const workspaceRoot = path.join(directory, "workspaces");
  const hookMarker = path.join(directory, "hook-ran");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: memory
  provider:
    issues:
      - id: later
        identifier: LATER-1
        title: Lower priority candidate
        state: Todo
        priority: 2
        labels: [symphony]
        dispatchable: true
        created_at: 2025-01-01T00:00:00Z
      - id: first
        identifier: FIRST-1
        title: Higher priority candidate
        state: Todo
        priority: 1
        labels: [symphony]
        dispatchable: true
        created_at: 2025-02-01T00:00:00Z
      - id: unlabeled
        identifier: UNLABELED-1
        title: Missing routing label
        state: Todo
        priority: 1
        labels: []
        dispatchable: true
      - id: disabled
        identifier: DISABLED-1
        title: Explicitly disabled
        state: Todo
        priority: 1
        labels: [symphony]
        dispatchable: false
      - id: terminal
        identifier: TERMINAL-1
        title: Already done
        state: Done
        priority: 1
        labels: [symphony]
        dispatchable: true
  required_labels: [symphony]
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: ${JSON.stringify(workspaceRoot)}
hooks:
  after_create: printf x > ${JSON.stringify(hookMarker)}
  before_run: printf x > ${JSON.stringify(hookMarker)}
runtime:
  kind: codex
  options:
    codex_home: relative-and-invalid
---
This prompt must never reach an agent.
`,
  );

  try {
    const result = await execFileAsync(process.execPath, [cliPath, "--preflight", workflowPath], {
      env: { ...process.env, LOG_LEVEL: "silent" },
    });

    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      tracker: "memory",
      runtime: "codex",
      delivery: false,
      control: false,
      fetched: 4,
      eligible: [
        { id: "first", identifier: "FIRST-1", state: "Todo" },
        { id: "later", identifier: "LATER-1", state: "Todo" },
      ],
    });
    assert.equal(result.stderr, "");
    await assert.rejects(access(hookMarker));
    await assert.rejects(access(workspaceRoot));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight deduplicates tracker results before exposing eligible issue fields", async () => {
  const workflow = await loadWorkflow(exampleWorkflowPath);
  const first: Issue = {
    id: "duplicate",
    nativeRef: null,
    identifier: "DUPLICATE-1",
    title: "First copy",
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: ["symphony"],
    blockedBy: [],
    dispatchable: true,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: null,
  };
  const result = summarizePreflight(workflow, [first, { ...first, identifier: "DUPLICATE-2" }]);

  assert.equal(result.fetched, 2);
  assert.deepEqual(result.eligible, [{ id: "duplicate", identifier: "DUPLICATE-2", state: "Todo" }]);
});

test("CLI rejects mutually exclusive execution modes before loading the workflow", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "--once", "--preflight", exampleWorkflowPath]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok("stdout" in error);
      assert.ok("stderr" in error);
      assert.equal(String(error.stdout), "");
      assert.match(String(error.stderr), /cannot be used with option/);
      return true;
    },
  );
});

test("CLI --preflight exits nonzero on configuration and tracker errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-preflight-errors-"));
  const invalidConfigPath = path.join(directory, "invalid-WORKFLOW.md");
  const invalidTrackerPath = path.join(directory, "duplicate-WORKFLOW.md");
  await writeFile(invalidConfigPath, "---\ntracker: {}\n---\nInvalid.\n");
  await writeFile(
    invalidTrackerPath,
    `---
tracker:
  kind: memory
  provider:
    issues:
      - { id: duplicate, identifier: DUP-1, title: First, state: Todo }
      - { id: duplicate, identifier: DUP-2, title: Second, state: Todo }
  active_states: [Todo]
  terminal_states: [Done]
---
Duplicate.
`,
  );

  try {
    for (const [workflowPath, expected] of [
      [invalidConfigPath, /tracker[\s\S]*kind/],
      [invalidTrackerPath, /Duplicate memory issue id/],
    ] as const) {
      await assert.rejects(
        execFileAsync(process.execPath, [cliPath, "--preflight", workflowPath]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("stdout" in error);
          assert.ok("stderr" in error);
          assert.equal(String(error.stdout), "");
          assert.match(String(error.stderr), expected);
          return true;
        },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI --once exits nonzero and preserves retry state in its final snapshot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-once-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const workspaceRoot = path.join(directory, "workspaces");
  const attemptsPath = path.join(directory, "attempts");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: memory
  provider:
    issues:
      - id: fail-1
        identifier: FAIL-1
        title: Fail without spawning Claude
        state: Todo
        labels: [symphony]
        dispatchable: true
  required_labels: [symphony]
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: ${JSON.stringify(workspaceRoot)}
hooks:
  before_run: |
    printf x >> ${JSON.stringify(attemptsPath)}
    exit 1
  timeout_ms: 1000
agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 1
runtime:
  kind: claude
  options:
    permission_mode: default
    setting_sources: []
    allowed_tools: [Read]
    tools: [Read]
---
This prompt must never reach Claude.
`,
  );

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "--once", workflowPath], {
        env: { ...process.env, LOG_LEVEL: "info" },
        timeout: 5_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("stdout" in error);
        assert.ok("stderr" in error);
        assert.deepEqual(JSON.parse(String(error.stdout)), {
          running: 0,
          retrying: 1,
          blocked: 0,
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        });
        assert.match(String(error.stderr), /Agent run started/);
        assert.equal((String(error.stderr).match(/Agent run started/gu) ?? []).length, 1);
        return true;
      },
    );
    assert.equal(await readFile(attemptsPath, "utf8"), "x");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "CLI --once handles SIGTERM and removes its detached after_run process group",
  { skip: process.platform === "win32", timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-signal-"));
    const workflowPath = path.join(directory, "WORKFLOW.md");
    const hookPidsPath = path.join(directory, "hook-pids");
    const workspaceRoot = path.join(directory, "workspaces");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: memory
  provider:
    issues:
      - id: stop-1
        identifier: STOP-1
        title: Stop a running hook
        state: Todo
        labels: [symphony]
        dispatchable: true
  required_labels: [symphony]
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: ${JSON.stringify(workspaceRoot)}
hooks:
  before_run: exit 1
  after_run: |
    printf '%s\\n' "$$" > ${JSON.stringify(hookPidsPath)}
    sleep 60 &
    printf '%s\\n' "$!" >> ${JSON.stringify(hookPidsPath)}
    wait
  timeout_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 1
runtime:
  kind: claude
  options:
    permission_mode: default
    setting_sources: []
    allowed_tools: [Read]
    tools: [Read]
---
This prompt must never reach Claude.
`,
    );

    const child = spawn(process.execPath, [cliPath, "--once", workflowPath], {
      env: { ...process.env, LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let hookPids: number[] = [];

    try {
      hookPids = await waitForPids(hookPidsPath, 2, 2_000);
      assert.equal(child.kill("SIGTERM"), true);
      const outcome = await closed;

      assert.deepEqual(outcome, { code: 143, signal: null });
      assert.equal(JSON.parse(stdout).running, 0);
      assert.match(stderr, /One-shot shutdown requested/);
      for (const pid of hookPids) await waitForProcessExit(pid, 1_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const pid of hookPids) terminateBestEffort(pid);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("CLI reports a missing workflow on stderr and exits nonzero", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-"));
  const missing = path.join(directory, "missing-WORKFLOW.md");
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, missing]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok("stderr" in error);
      assert.match(String(error.stderr), /symphony-node:/);
      return true;
    },
  );
});

async function waitForPids(filePath: string, count: number, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pids = (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      if (pids.length === count) return pids;
    } catch {
      // The hook has not written the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} hook processes`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} was left running`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function terminateBestEffort(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process has already exited.
  }
}
