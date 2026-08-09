import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { loadWorkflow } from "../src/config/workflow.js";
import { configuredExecutableCandidates, runDoctor } from "../src/doctor.js";
import type { Issue } from "../src/domain.js";
import { summarizePreflight } from "../src/preflight.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const exampleWorkflowPath = fileURLToPath(new URL("../WORKFLOW.md", import.meta.url));

test("CLI prints help and exits successfully", async () => {
  const result = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.match(result.stdout, /Usage: symphony-node \[--once \| --preflight \| --doctor\] \[WORKFLOW\]/);
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

test(
  "CLI --doctor stays offline and reports missing local paths as warnings without side effects",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-doctor-"));
    const workflowPath = path.join(directory, "WORKFLOW.md");
    const workspaceRoot = path.join(directory, "missing-workspaces");
    const stateDirectory = path.join(directory, "missing-state");
    const statePath = path.join(stateDirectory, "checkpoint.json");
    const hookMarker = path.join(directory, "hook-ran");
    const executableMarker = path.join(directory, "executable-ran");
    const executablePath = path.join(directory, "doctor-executable");
    await writeFile(executablePath, `#!/bin/sh\nprintf x > ${JSON.stringify(executableMarker)}\n`);
    await chmod(executablePath, 0o700);
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github
  provider:
    owner: doctor-secret-owner
    repo: doctor-secret-repository
    endpoint: https://127.0.0.1:1
    token: $DOCTOR_SECRET_TOKEN
  required_labels: [symphony]
  active_states: [open]
  terminal_states: [closed]
workspace:
  root: ${JSON.stringify(workspaceRoot)}
state:
  path: ${JSON.stringify(statePath)}
hooks:
  after_create: printf x > ${JSON.stringify(hookMarker)}
runtime:
  kind: claude
  options:
    claude_executable: ${JSON.stringify(executablePath)}
---
Doctor secret prompt must never be rendered.
`,
    );

    try {
      const environment: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: "silent" };
      delete environment.DOCTOR_SECRET_TOKEN;
      const result = await execFileAsync(process.execPath, [cliPath, "--doctor", workflowPath], {
        env: environment,
      });

      assert.equal(result.stdout.trim().split("\n").length, 1);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        schemaVersion: 1,
        ok: true,
        tracker: "github",
        runtime: "claude",
        checks: [
          { id: "workflow.config", status: "ok", summary: "workflow configuration is valid" },
          { id: "tracker.config", status: "ok", summary: "tracker configuration is locally usable" },
          { id: "runtime.options", status: "ok", summary: "runtime options are valid" },
          { id: "runtime.executable", status: "ok", summary: "runtime executable is available" },
          { id: "runtime.auth", status: "warning", summary: "runtime authentication was not verified" },
          { id: "workspace.root", status: "warning", summary: "workspace root does not exist yet" },
          { id: "state.store", status: "warning", summary: "durable state does not exist yet" },
        ],
      });
      for (const sensitive of [
        directory,
        "DOCTOR_SECRET_TOKEN",
        "doctor-secret-owner",
        "doctor-secret-repository",
        "Doctor secret prompt",
      ]) {
        assert.equal(result.stdout.includes(sensitive), false);
      }
      await assert.rejects(access(hookMarker));
      await assert.rejects(access(executableMarker));
      await assert.rejects(access(workspaceRoot));
      await assert.rejects(access(stateDirectory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("doctor mirrors native Windows executable lookup without accepting shell scripts", () => {
  assert.deepEqual(
    configuredExecutableCandidates("agent.exe", "win32", "C:\\bin;D:\\tools"),
    ["C:\\bin\\agent.exe", "D:\\tools\\agent.exe"],
  );
  assert.deepEqual(
    configuredExecutableCandidates("agent", "win32", "C:\\bin"),
    ["C:\\bin\\agent.COM", "C:\\bin\\agent.EXE"],
  );
  assert.deepEqual(
    configuredExecutableCandidates("C:\\bin\\agent.com", "win32", "D:\\ignored"),
    ["C:\\bin\\agent.com"],
  );
  assert.deepEqual(configuredExecutableCandidates("agent.cmd", "win32", "C:\\bin"), []);
  assert.deepEqual(configuredExecutableCandidates("C:\\bin\\agent.bat", "win32", ""), []);
});

test("doctor rejects Windows host delivery but leaves control-only GitHub routing usable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-doctor-windows-delivery-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platformDescriptor);
  const workflow = (hostConfig: string) => `---
tracker:
  kind: github
  provider:
    owner: acme
    repo: widget
    token: $DOCTOR_WINDOWS_TOKEN
  required_labels: [symphony]
workspace:
  root: ${JSON.stringify(path.join(directory, "missing-workspaces"))}
runtime:
  kind: claude
  options:
    permission_mode: acceptEdits
${hostConfig}
---
Never rendered.
`;

  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    await writeFile(workflowPath, workflow("delivery:\n  queue_label: symphony\n  review_label: review"));
    const delivery = await runDoctor(workflowPath);
    assert.deepEqual(
      delivery.checks.find(({ id }) => id === "tracker.config"),
      { id: "tracker.config", status: "error", summary: "tracker configuration is not locally usable" },
    );

    await writeFile(workflowPath, workflow("control:\n  retry_label: retry"));
    const control = await runDoctor(workflowPath);
    assert.deepEqual(
      control.checks.find(({ id }) => id === "tracker.config"),
      { id: "tracker.config", status: "ok", summary: "tracker configuration is locally usable" },
    );
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "CLI --doctor aggregates unsafe workspace and corrupt state errors without exposing raw details",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-doctor-errors-"));
    const workflowPath = path.join(directory, "WORKFLOW.md");
    const workspaceRoot = path.join(directory, "unsafe-workspaces");
    const stateDirectory = path.join(directory, "state");
    const statePath = path.join(stateDirectory, "checkpoint.json");
    const hookMarker = path.join(directory, "hook-ran");
    await mkdir(workspaceRoot, { mode: 0o700 });
    await chmod(workspaceRoot, 0o777);
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(statePath, "RAW_STATE_SECRET", { mode: 0o600 });
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: memory
  provider: { issues: [] }
workspace:
  root: ${JSON.stringify(workspaceRoot)}
state:
  path: ${JSON.stringify(statePath)}
hooks:
  after_create: printf x > ${JSON.stringify(hookMarker)}
runtime:
  kind: claude
  options:
    claude_executable: ${JSON.stringify(process.execPath)}
---
Raw doctor error prompt must stay private.
`,
    );

    try {
      await assert.rejects(
        execFileAsync(process.execPath, [cliPath, "--doctor", workflowPath]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("stdout" in error);
          assert.ok("stderr" in error);
          const stdout = String(error.stdout);
          assert.equal(stdout.trim().split("\n").length, 1);
          assert.equal(String(error.stderr), "");
          assert.deepEqual(JSON.parse(stdout), {
            schemaVersion: 1,
            ok: false,
            tracker: "memory",
            runtime: "claude",
            checks: [
              { id: "workflow.config", status: "ok", summary: "workflow configuration is valid" },
              { id: "tracker.config", status: "ok", summary: "tracker configuration is locally usable" },
              { id: "runtime.options", status: "ok", summary: "runtime options are valid" },
              { id: "runtime.executable", status: "ok", summary: "runtime executable is available" },
              { id: "runtime.auth", status: "warning", summary: "runtime authentication was not verified" },
              { id: "workspace.root", status: "error", summary: "workspace root is not locally usable" },
              { id: "state.store", status: "error", summary: "durable state is not locally usable" },
            ],
          });
          for (const sensitive of [directory, "RAW_STATE_SECRET", "Raw doctor error prompt"]) {
            assert.equal(stdout.includes(sensitive), false);
          }
          return true;
        },
      );
      await assert.rejects(access(hookMarker));
      assert.equal(await readFile(statePath, "utf8"), "RAW_STATE_SECRET");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "CLI --doctor rejects missing and non-executable configured runtime paths without running them",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-doctor-executable-"));
    const workflowPath = path.join(directory, "WORKFLOW.md");
    const executableMarker = path.join(directory, "executable-ran");
    const missingExecutable = path.join(directory, "missing-executable");
    const nonExecutable = path.join(directory, "non-executable");
    await writeFile(nonExecutable, `#!/bin/sh\nprintf x > ${JSON.stringify(executableMarker)}\n`, { mode: 0o600 });

    try {
      for (const candidate of [missingExecutable, nonExecutable]) {
        await writeFile(
          workflowPath,
          `---
tracker:
  kind: memory
  provider: { issues: [] }
workspace:
  root: ${JSON.stringify(path.join(directory, "missing-workspaces"))}
runtime:
  kind: claude
  options:
    claude_executable: ${JSON.stringify(candidate)}
---
Executable probe must stay offline.
`,
        );
        await assert.rejects(
          execFileAsync(process.execPath, [cliPath, "--doctor", workflowPath]),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok("stdout" in error);
            assert.ok("stderr" in error);
            const stdout = String(error.stdout);
            const report = JSON.parse(stdout) as {
              ok: boolean;
              checks: Array<{ id: string; status: string }>;
            };
            assert.equal(stdout.trim().split("\n").length, 1);
            assert.equal(String(error.stderr), "");
            assert.equal(report.ok, false);
            assert.deepEqual(
              report.checks.find(({ id }) => id === "runtime.executable"),
              { id: "runtime.executable", status: "error", summary: "runtime executable is unavailable" },
            );
            assert.equal(stdout.includes(candidate), false);
            return true;
          },
        );
      }
      await assert.rejects(access(executableMarker));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("CLI --doctor reports invalid workflows with generic redacted JSON", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-cli-doctor-config-"));
  const workflowPath = path.join(directory, "WORKFLOW.md");
  const rawSecret = "RAW_INVALID_WORKFLOW_SECRET";
  await writeFile(workflowPath, `---\ntracker: { leaked: ${rawSecret} }\n---\n${rawSecret}\n`);

  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "--doctor", workflowPath]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("stdout" in error);
        assert.ok("stderr" in error);
        const stdout = String(error.stdout);
        const report = JSON.parse(stdout) as {
          schemaVersion: number;
          ok: boolean;
          tracker: string | null;
          runtime: string | null;
          checks: Array<{ id: string; status: string }>;
        };
        assert.equal(stdout.trim().split("\n").length, 1);
        assert.equal(String(error.stderr), "");
        assert.equal(report.schemaVersion, 1);
        assert.equal(report.ok, false);
        assert.equal(report.tracker, null);
        assert.equal(report.runtime, null);
        assert.equal(report.checks.length, 7);
        assert.deepEqual(report.checks[0], {
          id: "workflow.config",
          status: "error",
          summary: "workflow configuration is invalid",
        });
        assert.equal(stdout.includes(directory), false);
        assert.equal(stdout.includes(rawSecret), false);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects mutually exclusive execution modes before loading the workflow", async () => {
  for (const modes of [
    ["--once", "--preflight"],
    ["--once", "--doctor"],
    ["--preflight", "--doctor"],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, ...modes, exampleWorkflowPath]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("stdout" in error);
        assert.ok("stderr" in error);
        assert.equal(String(error.stdout), "");
        assert.match(String(error.stderr), /cannot be used with option/);
        return true;
      },
    );
  }
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
