import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ThreadEvent } from "@openai/codex-sdk";
import { afterAll, onTestFinished, test } from "vitest";
import {
  CodexAgentDriver,
  buildCodexEnvironment,
  buildCodexShellEnvironment,
  resolveSafeCodexHome,
  type CodexStreamRequest,
} from "../src/agents/codex.js";
import { createAgentDriver } from "../src/agents/registry.js";
import { agentCompletionOutputSchema } from "../src/completion.js";
import type { AgentEvent, AgentRunContext, Issue } from "../src/domain.js";

const execFileAsync = promisify(execFile);
const previousCodexHome = process.env.CODEX_HOME;
const createdTestCodexHome = await mkdtemp(path.join(tmpdir(), "symphony-codex-home-test-"));
await chmod(createdTestCodexHome, 0o700);
const testCodexHome = await realpath(createdTestCodexHome);
const createdTestWorkspace = await mkdtemp(path.join(tmpdir(), "symphony-codex-workspace-test-"));
const testWorkspace = await realpath(createdTestWorkspace);
await execFileAsync("git", ["init", "-q", "--initial-branch=main", testWorkspace]);
process.env.CODEX_HOME = testCodexHome;
afterAll(async () => {
  restoreEnvironment("CODEX_HOME", previousCodexHome);
  await rm(testCodexHome, { recursive: true, force: true });
  await rm(testWorkspace, { recursive: true, force: true });
});

test("normalizes a Codex stream and keeps provider output out of summaries", async () => {
  const driver = new CodexAgentDriver(async () =>
    eventStream([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: "private model response" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 3,
          cache_write_input_tokens: 2,
          output_tokens: 5,
          reasoning_output_tokens: 4,
        },
      },
    ]),
  );

  const events = await collect(driver.run(context()));

  assert.deepEqual(events.map(({ type }) => type), [
    "session_started",
    "activity",
    "activity",
    "usage_updated",
    "turn_completed",
  ]);
  assert.equal(events.every(({ sessionId }) => sessionId === "thread-1"), true);
  assert.deepEqual(events[3]?.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 2,
    totalTokens: 15,
    costUsd: 0,
  });
  assert.equal(events.some(({ summary }) => summary?.includes("private model response")), false);
});

test("requests and validates the last completed Codex structured response after draining", async () => {
  const requests: CodexStreamRequest[] = [];
  let drained = false;
  const driver = new CodexAgentDriver(async (request) => {
    requests.push(request);
    return structuredStream();
  });

  const events = await collect(driver.run(context({ completionMode: "publish_change" })));

  assert.equal(drained, true);
  assert.deepEqual(requests[0]?.outputSchema, agentCompletionOutputSchema);
  assert.deepEqual(events.at(-1), {
    type: "turn_completed",
    timestamp: events.at(-1)?.timestamp,
    sessionId: "thread-structured",
    summary: "Implemented and verified the change",
    completion: {
      status: "ready",
      summary: "Implemented and verified the change",
      verification: ["pnpm test"],
    },
  });
  assert.equal(events.some(({ summary }) => summary?.includes("private superseded response")), false);

  async function* structuredStream(): AsyncIterable<ThreadEvent> {
    yield { type: "thread.started", thread_id: "thread-structured" };
    yield {
      type: "item.completed",
      item: { id: "old", type: "agent_message", text: "private superseded response" },
    };
    yield {
      type: "item.completed",
      item: {
        id: "final",
        type: "agent_message",
        text: JSON.stringify({
          status: "ready",
          summary: "Implemented and verified the change",
          verification: ["pnpm test"],
        }),
      },
    };
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    };
    drained = true;
  }
});

test("fails Codex completion mode once for missing or invalid structured output", async () => {
  const invalidMessages = [undefined, "private malformed output", JSON.stringify({
    status: "ready",
    summary: "Done",
    verification: [],
  })];

  for (const text of invalidMessages) {
    const driver = new CodexAgentDriver(async () =>
      eventStream([
        ...(text === undefined
          ? []
          : [{ type: "item.completed", item: { id: "final", type: "agent_message", text } } as ThreadEvent]),
        {
          type: "turn.completed",
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ]),
    );

    const events = await collect(driver.run(context({ completionMode: "publish_change" })));
    assert.equal(events.filter(({ type }) => type === "turn_failed").length, 1);
    assert.equal(events.filter(({ type }) => type === "turn_completed").length, 0);
    assert.equal(events.some(({ summary }) => summary?.includes("private malformed output")), false);
  }
});

test("resumes a Codex thread with fixed sandbox options, an allowlisted environment, and the caller signal", async () => {
  const requests: CodexStreamRequest[] = [];
  const driver = new CodexAgentDriver(async (request) => {
    requests.push(request);
    return eventStream([
      {
        type: "turn.completed",
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ]);
  });
  const previousGithub = process.env.GITHUB_TOKEN;
  const previousExtra = process.env.CODEX_TEST_EXTRA;
  process.env.GITHUB_TOKEN = "github-secret";
  process.env.CODEX_TEST_EXTRA = "allowed-value";

  try {
    const runContext = context({
      sessionId: "thread-existing",
      runtimeOptions: {
        model: "gpt-test",
        model_reasoning_effort: "high",
        env_allowlist: ["CODEX_TEST_EXTRA", "GITHUB_TOKEN"],
        codex_executable: "/opt/codex",
      },
      sensitiveEnvNames: ["github_token", "path"],
    });
    await collect(driver.run(runContext));

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request?.sessionId, "thread-existing");
    assert.equal(request?.signal, runContext.signal);
    assert.deepEqual(request?.threadOptions, {
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workingDirectory: testWorkspace,
      skipGitRepoCheck: false,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      model: "gpt-test",
      modelReasoningEffort: "high",
    });
    assert.match(request?.clientOptions.codexPathOverride ?? "", /codex-symphony-wrapper\.mjs$/);
    assert.equal(request?.clientOptions.env?.SYMPHONY_CODEX_REAL_EXECUTABLE, "/opt/codex");
    assert.equal(request?.clientOptions.env?.CODEX_TEST_EXTRA, "allowed-value");
    assert.equal(request?.clientOptions.env?.GITHUB_TOKEN, undefined);
    assert.equal(request?.clientOptions.env?.PATH, undefined);
    assert.equal(request?.clientOptions.env?.CODEX_HOME, testCodexHome);
    assert.equal(request?.clientOptions.env?.HOME, testCodexHome);
    const config = request?.clientOptions.config as Record<string, unknown>;
    assert.equal(config.allow_login_shell, false);
    assert.deepEqual(config.agents, { enabled: false });
    assert.deepEqual(config.features, {
      apps: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      computer_use: false,
      hooks: false,
      image_generation: false,
      in_app_browser: false,
      plugins: false,
      skill_mcp_dependency_install: false,
      skill_search: false,
    });
    const sandbox = config.sandbox_workspace_write as Record<string, unknown>;
    assert.equal(sandbox.network_access, false);
    assert.equal(sandbox.exclude_slash_tmp, true);
    assert.equal(sandbox.exclude_tmpdir_env_var, true);
    const commandTemp = (sandbox.writable_roots as string[])[0];
    assert.match(commandTemp ?? "", /symphony-codex-command-/);
    const shellPolicy = config.shell_environment_policy as Record<string, unknown>;
    assert.equal(shellPolicy.inherit, "none");
    assert.equal(shellPolicy.ignore_default_excludes, false);
    const shellEnvironment = shellPolicy.set as Record<string, string>;
    assert.equal(shellEnvironment.PATH, undefined);
    assert.equal(shellEnvironment.TEMP, commandTemp);
    assert.equal(shellEnvironment.TMP, commandTemp);
    assert.equal(shellEnvironment.TMPDIR, commandTemp);
    await assert.rejects(lstat(commandTemp ?? ""), (error: unknown) => isErrorCode(error, "ENOENT"));
  } finally {
    restoreEnvironment("GITHUB_TOKEN", previousGithub);
    restoreEnvironment("CODEX_TEST_EXTRA", previousExtra);
  }
});

test("emits exactly one failed terminal event for stream errors, empty streams, and pre-aborted runs", async () => {
  const cases = [
    new CodexAgentDriver(async () => eventStream([{ type: "error", message: "private provider error" }])),
    new CodexAgentDriver(async () => eventStream([])),
    new CodexAgentDriver(async () => {
      throw new Error("private thrown error");
    }),
  ];

  for (const driver of cases) {
    const events = await collect(driver.run(context()));
    assert.equal(events.filter(({ type }) => type === "turn_failed").length, 1);
    assert.equal(events.filter(({ type }) => type === "turn_completed").length, 0);
    assert.equal(events.some(({ summary }) => summary?.includes("private")), false);
  }

  let opened = false;
  const controller = new AbortController();
  controller.abort();
  const aborted = new CodexAgentDriver(async () => {
    opened = true;
    return eventStream([]);
  });
  const events = await collect(aborted.run(context({ signal: controller.signal })));
  assert.equal(opened, false);
  assert.equal(events[0]?.summary, "Codex run aborted");
});

test("drains the Codex stream before reporting success or provider failure", async () => {
  let drained = false;
  const driver = new CodexAgentDriver(async () => lateFailureStream());

  const events = await collect(driver.run(context()));

  assert.equal(drained, true);
  assert.deepEqual(events.map(({ type }) => type), ["usage_updated", "turn_failed"]);
  assert.equal(events.some(({ type }) => type === "turn_completed"), false);

  async function* lateFailureStream(): AsyncIterable<ThreadEvent> {
    try {
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      };
      throw new Error("Codex process exited unsuccessfully after its terminal event");
    } finally {
      drained = true;
    }
  }

  let providerFailureDrained = false;
  const providerFailure = new CodexAgentDriver(async () => providerFailureStream());
  const providerEvents = await collect(providerFailure.run(context()));
  assert.equal(providerFailureDrained, true);
  assert.deepEqual(providerEvents.map(({ type }) => type), ["turn_failed"]);

  async function* providerFailureStream(): AsyncIterable<ThreadEvent> {
    yield { type: "turn.failed", error: { message: "private provider failure" } };
    providerFailureDrained = true;
  }
});

test("registers Codex and strips unrelated secrets from its default environment", () => {
  assert.equal(createAgentDriver("codex").kind, "codex");
  const previousGithub = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "github-secret";
  try {
    assert.equal(buildCodexEnvironment([]).GITHUB_TOKEN, undefined);
    assert.equal(buildCodexEnvironment(["GITHUB_TOKEN"]).GITHUB_TOKEN, "github-secret");
  } finally {
    restoreEnvironment("GITHUB_TOKEN", previousGithub);
  }
});

test("Codex sensitive environment names override defaults and explicit allowlists case-insensitively", () => {
  const previousGithub = process.env.GITHUB_TOKEN;
  const previousPath = process.env.PATH;
  process.env.GITHUB_TOKEN = "github-secret";
  process.env.PATH = "path-secret";
  try {
    const client = buildCodexEnvironment(
      ["GITHUB_TOKEN"],
      testCodexHome,
      ["github_token", "path", "home"],
    );
    const shell = buildCodexShellEnvironment("/private/symphony-command", ["GitHub_ToKeN", "Path", "temp"]);
    assert.equal(client.GITHUB_TOKEN, undefined);
    assert.equal(client.PATH, undefined);
    assert.equal(client.HOME, undefined);
    assert.equal(shell.GITHUB_TOKEN, undefined);
    assert.equal(shell.PATH, undefined);
    assert.equal(shell.TEMP, undefined);
  } finally {
    restoreEnvironment("GITHUB_TOKEN", previousGithub);
    restoreEnvironment("PATH", previousPath);
  }
});

test("requires an isolated private CODEX_HOME and rejects local extension layers", async () => {
  await assert.rejects(resolveSafeCodexHome(undefined), /requires CODEX_HOME/);

  const hookedHome = await mkdtemp(path.join(tmpdir(), "symphony-codex-home-hooked-"));
  await chmod(hookedHome, 0o700);
  await writeFile(path.join(hookedHome, "hooks.json"), "{}\n");
  onTestFinished(() => rm(hookedHome, { recursive: true, force: true }));
  await assert.rejects(resolveSafeCodexHome(hookedHome), /hooks/);

  const instructedHome = await mkdtemp(path.join(tmpdir(), "symphony-codex-home-instructed-"));
  await chmod(instructedHome, 0o700);
  await writeFile(path.join(instructedHome, "AGENTS.override.md"), "Use an unsafe external tool.\n");
  onTestFinished(() => rm(instructedHome, { recursive: true, force: true }));
  await assert.rejects(resolveSafeCodexHome(instructedHome), /global instructions/);

  const skilledHome = await mkdtemp(path.join(tmpdir(), "symphony-codex-home-skilled-"));
  await chmod(skilledHome, 0o700);
  await mkdir(path.join(skilledHome, ".agents"));
  onTestFinished(() => rm(skilledHome, { recursive: true, force: true }));
  await assert.rejects(resolveSafeCodexHome(skilledHome), /user skills/);

  const caseVariantSkillsHome = await mkdtemp(path.join(tmpdir(), "symphony-codex-home-skills-case-"));
  await chmod(caseVariantSkillsHome, 0o700);
  await mkdir(path.join(caseVariantSkillsHome, "Skills", ".system"), { recursive: true });
  await mkdir(path.join(caseVariantSkillsHome, "skills", "unsafe"), { recursive: true });
  onTestFinished(() => rm(caseVariantSkillsHome, { recursive: true, force: true }));
  await assert.rejects(resolveSafeCodexHome(caseVariantSkillsHome), /user-installed Codex skills/);

  if (process.platform !== "win32") {
    const publicHome = await mkdtemp(path.join(tmpdir(), "symphony-codex-home-public-"));
    await chmod(publicHome, 0o755);
    onTestFinished(() => rm(publicHome, { recursive: true, force: true }));
    await assert.rejects(resolveSafeCodexHome(publicHome), /private user-owned/);
  }

  const workspacePath = await mkdtemp(path.join(tmpdir(), "symphony-codex-project-config-"));
  await mkdir(path.join(workspacePath, ".codex"));
  await writeFile(path.join(workspacePath, ".codex", "config.toml"), "[mcp_servers.unsafe]\ncommand = 'unsafe'\n");
  onTestFinished(() => rm(workspacePath, { recursive: true, force: true }));
  let opened = false;
  const driver = new CodexAgentDriver(async () => {
    opened = true;
    return eventStream([]);
  });
  const events = await collect(driver.run(context({ workspacePath })));
  assert.equal(opened, false);
  assert.match(events[0]?.summary ?? "", /Workspace-local \.codex and \.agents layers/);

  const skilledWorkspace = await mkdtemp(path.join(tmpdir(), "symphony-codex-project-skills-"));
  await mkdir(path.join(skilledWorkspace, ".agents", "skills", "unsafe"), { recursive: true });
  await writeFile(path.join(skilledWorkspace, ".agents", "skills", "unsafe", "SKILL.md"), "# Unsafe\n");
  onTestFinished(() => rm(skilledWorkspace, { recursive: true, force: true }));
  opened = false;
  const skillEvents = await collect(driver.run(context({ workspacePath: skilledWorkspace })));
  assert.equal(opened, false);
  assert.match(skillEvents[0]?.summary ?? "", /Workspace-local \.codex and \.agents layers/);

  const nestedWorkspace = await mkdtemp(path.join(tmpdir(), "symphony-codex-nested-workspace-"));
  const nestedHome = path.join(nestedWorkspace, "codex-home");
  await mkdir(nestedHome, { mode: 0o700 });
  onTestFinished(() => rm(nestedWorkspace, { recursive: true, force: true }));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = nestedHome;
  try {
    const nestedDriver = new CodexAgentDriver(async () => eventStream([]));
    const nestedEvents = await collect(
      nestedDriver.run(context({ workspacePath: nestedWorkspace, runtimeOptions: { skip_git_repo_check: true } })),
    );
    assert.match(nestedEvents[0]?.summary ?? "", /must be disjoint/);
  } finally {
    restoreEnvironment("CODEX_HOME", previousHome);
  }

  const parentRepository = await mkdtemp(path.join(tmpdir(), "symphony-codex-parent-repository-"));
  await execFileAsync("git", ["init", "-q", "--initial-branch=main", parentRepository]);
  const nestedWorkspaceInRepository = path.join(parentRepository, "issue-workspace");
  await mkdir(nestedWorkspaceInRepository);
  onTestFinished(() => rm(parentRepository, { recursive: true, force: true }));
  const parentDriver = new CodexAgentDriver(async () => eventStream([]));
  const parentEvents = await collect(parentDriver.run(context({ workspacePath: nestedWorkspaceInRepository })));
  assert.match(parentEvents[0]?.summary ?? "", /Git root must equal the issue workspace/);
});

test("Codex wrapper forces user config, rules, provider tools, and extension layers off", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-codex-wrapper-test-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const capturePath = path.join(directory, "args.json");
  await writeFile(
    fakeCodex,
    "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_WRAPPER_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
  );
  await chmod(fakeCodex, 0o700);
  const wrapperPath = path.resolve("codex-symphony-wrapper.mjs");

  await execFileAsync(wrapperPath, ["exec", "--experimental-json", "--cd", testWorkspace], {
    env: {
      ...process.env,
      SYMPHONY_CODEX_REAL_EXECUTABLE: fakeCodex,
      CODEX_WRAPPER_CAPTURE: capturePath,
    },
  });

  const args = JSON.parse(await readFile(capturePath, "utf8")) as string[];
  assert.deepEqual(args.slice(0, 27), [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "browser_use_full_cdp_access",
    "--disable",
    "computer_use",
    "--disable",
    "hooks",
    "--disable",
    "image_generation",
    "--disable",
    "in_app_browser",
    "--disable",
    "plugins",
    "--disable",
    "skill_mcp_dependency_install",
    "--disable",
    "skill_search",
    "--experimental-json",
    "--cd",
  ]);
  assert.equal(args[27], testWorkspace);
});

test(
  "Codex wrapper terminates its detached executable process group on shutdown",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "symphony-codex-wrapper-signal-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const fakeCodex = path.join(directory, "fake-codex.mjs");
    const capturePath = path.join(directory, "pids.txt");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.on("SIGTERM", () => {});
writeFileSync(process.env.CODEX_WRAPPER_CAPTURE, process.pid + "\\n" + child.pid + "\\n");
setInterval(() => {}, 1000);
`,
    );
    await chmod(fakeCodex, 0o700);
    const wrapper = spawn(path.resolve("codex-symphony-wrapper.mjs"), ["exec"], {
      env: {
        ...process.env,
        SYMPHONY_CODEX_REAL_EXECUTABLE: fakeCodex,
        CODEX_WRAPPER_CAPTURE: capturePath,
      },
      stdio: "ignore",
    });
    let pids: number[] = [];
    onTestFinished(() => {
      terminateBestEffort(wrapper.pid);
      for (const pid of pids) terminateBestEffort(pid);
    });

    pids = await waitForPids(capturePath, 2, 2_000);
    wrapper.kill("SIGTERM");
    const [code] = await once(wrapper, "exit", { signal: AbortSignal.timeout(2_000) });
    assert.equal(code, 1);
    for (const pid of pids) await waitForProcessExit(pid, 2_000);
  },
);

async function* eventStream(events: ThreadEvent[]): AsyncIterable<ThreadEvent> {
  for (const event of events) yield event;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function context(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    issue: sampleIssue,
    workspacePath: testWorkspace,
    prompt: "Do the task",
    attempt: null,
    continuation: 0,
    signal: new AbortController().signal,
    runtimeOptions: {},
    ...overrides,
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

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
      // The fake executable has not written its process ids yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} Codex processes`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isErrorCode(error, "ESRCH")) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex process ${pid} was left running`);
}

function terminateBestEffort(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

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
