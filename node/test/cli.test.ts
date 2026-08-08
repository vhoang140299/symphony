import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const exampleWorkflowPath = fileURLToPath(new URL("../../WORKFLOW.md", import.meta.url));

test("CLI prints help and exits successfully", async () => {
  const result = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.match(result.stdout, /Usage: symphony-node \[--once\]/);
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
