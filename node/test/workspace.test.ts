import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowConfig } from "../src/config/schema.js";
import type { Issue } from "../src/domain.js";
import { createLogger } from "../src/log.js";
import { WorkspaceManager, workspaceKey } from "../src/workspace/manager.js";

const issue: Issue = {
  id: "issue-1",
  nativeRef: null,
  identifier: "APP-1",
  title: "Test issue",
  description: null,
  priority: null,
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

function workflow(root: string, hooks: Partial<WorkflowConfig["hooks"]> = {}): WorkflowConfig {
  return {
    tracker: {
      kind: "memory",
      provider: {},
      requiredLabels: [],
      activeStates: ["Todo"],
      terminalStates: ["Done"],
    },
    polling: { intervalMs: 1_000 },
    workspace: { root },
    hooks: { timeoutMs: 1_000, ...hooks },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryBackoffMs: 1_000,
      maxConcurrentAgentsByState: {},
    },
    runtime: { kind: "claude", turnTimeoutMs: 1_000, stallTimeoutMs: 0, options: {} },
  };
}

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-node-workspace-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

test("workspace keys preserve safe identifiers and hash changed identifiers", () => {
  assert.equal(workspaceKey("APP-123.test"), "APP-123.test");
  assert.match(workspaceKey("APP/123"), /^APP_123-[0-9a-f]{16}$/);
  assert.match(workspaceKey("A💥B"), /^A_B-[0-9a-f]{16}$/);
  assert.notEqual(workspaceKey("APP/123"), workspaceKey("APP?123"));
  assert.match(workspaceKey(".."), /^issue-[0-9a-f]{16}$/);
  assert.match(workspaceKey("APP/123"), /^[A-Za-z0-9._-]+$/);
});

test("creates, reuses, and removes workspaces with lifecycle hook semantics", async (t) => {
  const root = await tempRoot(t);
  const marker = path.join(root, "hooks.log");
  const target = shellQuote(marker);
  const config = workflow(root, {
    afterCreate: `printf 'after_create\n' >> ${target}`,
    beforeRun: `printf 'before_run\n' >> ${target}`,
    afterRun: `printf 'after_run\n' >> ${target}; exit 7`,
    beforeRemove: `printf 'before_remove\n' >> ${target}; exit 8`,
  });
  const manager = new WorkspaceManager(createLogger("silent"));

  const created = await manager.createForIssue(issue, config);
  assert.equal(created.createdNow, true);
  const reused = await manager.createForIssue(issue, config);
  assert.equal(reused.createdNow, false);
  assert.equal(reused.path, created.path);

  await manager.beforeRun(created.path, issue, config);
  await manager.beforeRun(created.path, issue, config);
  await manager.afterRun(created.path, issue, config);
  await manager.removeForIssue(issue, config);

  assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
    "after_create",
    "before_run",
    "before_run",
    "after_run",
    "before_remove",
  ]);
  await assert.rejects(access(created.path));
});

test("creates private roots, leaves the clone target empty, and stores the marker in .git", async (t) => {
  const parent = await tempRoot(t);
  const root = path.join(parent, "new-root");
  const manager = new WorkspaceManager(createLogger("silent"));
  const config = workflow(root, { afterCreate: 'test -z "$(ls -A)"; mkdir .git' });

  const created = await manager.createForIssue(issue, config);

  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(created.path)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(created.path, ".git", ".symphony-workspace.json"))).mode & 0o777, 0o600);
  await assert.rejects(lstat(path.join(created.path, ".symphony-workspace.json")), (error: unknown) =>
    isErrno(error, "ENOENT"),
  );
  assert.equal((await manager.createForIssue(issue, config)).createdNow, false);
});

test("cleans a new workspace when after_create fails", async (t) => {
  const root = await tempRoot(t);
  const manager = new WorkspaceManager(createLogger("silent"));
  const config = workflow(root, { afterCreate: "exit 42" });
  const expectedPath = path.join(root, workspaceKey(issue.identifier));

  await assert.rejects(manager.createForIssue(issue, config), /after_create hook exited with code 42/);
  await assert.rejects(lstat(expectedPath), (error: unknown) => isErrno(error, "ENOENT"));
});

test("rejects files, symlinks, and mismatched run paths", async (t) => {
  const root = await tempRoot(t);
  const manager = new WorkspaceManager(createLogger("silent"));
  const config = workflow(root);
  const expectedPath = path.join(root, workspaceKey(issue.identifier));

  await writeFile(expectedPath, "not a directory");
  await assert.rejects(manager.createForIssue(issue, config), /not a directory/);
  await rm(expectedPath);

  const outside = await tempRoot(t);
  await symlink(outside, expectedPath, "dir");
  await assert.rejects(manager.createForIssue(issue, config), /symbolic link/);
  await assert.rejects(manager.removeForIssue(issue, config), /symbolic link/);
  await access(outside);
  await rm(expectedPath);

  const created = await manager.createForIssue(issue, config);
  await assert.rejects(manager.beforeRun(outside, issue, config), /does not match issue/);
  await rm(created.path, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, created.path, "dir");
  await assert.rejects(manager.beforeRun(created.path, issue, config), /symbolic link/);
});

test("rejects symlinked or writable roots and insecure workspace leaves", async (t) => {
  const container = await tempRoot(t);
  const actualRoot = await tempRoot(t);
  const rootLink = path.join(container, "root-link");
  const manager = new WorkspaceManager(createLogger("silent"));

  await symlink(actualRoot, rootLink, "dir");
  await assert.rejects(manager.createForIssue(issue, workflow(rootLink)), /Workspace root must not be a symbolic link/);

  await chmod(actualRoot, 0o777);
  await assert.rejects(manager.createForIssue(issue, workflow(actualRoot)), /Workspace root must not be group- or world-writable/);
  await chmod(actualRoot, 0o700);

  const created = await manager.createForIssue(issue, workflow(actualRoot));
  await chmod(created.path, 0o720);
  await assert.rejects(manager.createForIssue(issue, workflow(actualRoot)), /Workspace must not be group- or world-writable/);
  await chmod(created.path, 0o500);
  await assert.rejects(manager.beforeRun(created.path, issue, workflow(actualRoot)), /owner-writable and searchable/);
  await chmod(created.path, 0o700);
});

test("never adopts or removes a pre-existing workspace without a matching marker", async (t) => {
  const root = await tempRoot(t);
  const workspacePath = path.join(root, workspaceKey(issue.identifier));
  const sentinel = path.join(workspacePath, "keep.txt");
  const manager = new WorkspaceManager(createLogger("silent"));
  const config = workflow(root);

  await mkdir(workspacePath, { mode: 0o700 });
  await writeFile(sentinel, "keep");
  await assert.rejects(manager.createForIssue(issue, config), /ownership marker is missing/);
  await assert.rejects(manager.removeForIssue(issue, config), /ownership marker is missing/);
  assert.equal(await readFile(sentinel, "utf8"), "keep");

  await writeFile(
    path.join(workspacePath, ".symphony-workspace.json"),
    JSON.stringify({ issueId: "another-issue", issueIdentifier: issue.identifier }),
    { mode: 0o600 },
  );
  await assert.rejects(manager.createForIssue(issue, config), /ownership marker does not match/);
  await assert.rejects(manager.removeForIssue(issue, config), /ownership marker does not match/);
  assert.equal(await readFile(sentinel, "utf8"), "keep");
});

test("requires its marker around hooks and revalidates after after_create", async (t) => {
  const root = await tempRoot(t);
  const hookLog = path.join(root, "hook.log");
  const manager = new WorkspaceManager(createLogger("silent"));
  const config = workflow(root, {
    beforeRun: `printf before >> ${shellQuote(hookLog)}`,
    afterRun: `printf after >> ${shellQuote(hookLog)}`,
  });
  const created = await manager.createForIssue(issue, config);

  await rm(path.join(created.path, ".symphony-workspace.json"));
  await assert.rejects(manager.beforeRun(created.path, issue, config), /ownership marker is missing/);
  await manager.afterRun(created.path, issue, config);
  await assert.rejects(access(hookLog), (error: unknown) => isErrno(error, "ENOENT"));
  await assert.rejects(manager.removeForIssue(issue, config), /ownership marker is missing/);
  await access(created.path);

  const secondIssue = { ...issue, id: "issue-2", identifier: "APP-2" };
  const unsafePath = path.join(root, workspaceKey(secondIssue.identifier));
  await assert.rejects(
    manager.createForIssue(secondIssue, workflow(root, { afterCreate: "chmod 0777 ." })),
    /Workspace must not be group- or world-writable/,
  );
  await assert.rejects(lstat(unsafePath), (error: unknown) => isErrno(error, "ENOENT"));
});

test("hook timeout escalates to the detached process group", async (t) => {
  if (process.platform === "win32") return;
  const root = await tempRoot(t);
  const leaderFile = path.join(root, "leader.pid");
  const manager = new WorkspaceManager(createLogger("silent"));
  const config = workflow(root, {
    timeoutMs: 50,
    beforeRun: `echo $$ > ${shellQuote(leaderFile)}; trap '' TERM; (trap '' TERM; while :; do sleep 30; done) & wait`,
  });
  const workspace = await manager.createForIssue(issue, config);
  const startedAt = Date.now();

  await assert.rejects(manager.beforeRun(workspace.path, issue, config), /before_run hook timed out after 50ms/);
  assert.ok(Date.now() - startedAt < 2_000);

  const leaderPid = Number.parseInt(await readFile(leaderFile, "utf8"), 10);
  assert.ok(Number.isInteger(leaderPid));
  await waitForProcessGroupExit(leaderPid);
});

test("hook timeout stays bounded when a detached descendant keeps stderr open", async (t) => {
  if (process.platform === "win32") return;
  const root = await tempRoot(t);
  const escapedPidFile = path.join(root, "escaped.pid");
  const manager = new WorkspaceManager(createLogger("silent"));
  const escapedProgram = "setInterval(() => {}, 30_000)";
  const hookProgram = [
    'const { spawn } = require("node:child_process")',
    'const { writeFileSync } = require("node:fs")',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(escapedProgram)}], { detached: true, stdio: ["ignore", "ignore", 2] })`,
    "child.unref()",
    `writeFileSync(${JSON.stringify(escapedPidFile)}, String(child.pid))`,
    "setInterval(() => {}, 30_000)",
  ].join(";");
  const config = workflow(root, {
    timeoutMs: 200,
    beforeRun: `${shellQuote(process.execPath)} -e ${shellQuote(hookProgram)}`,
  });
  const workspace = await manager.createForIssue(issue, config);
  const startedAt = Date.now();

  await assert.rejects(manager.beforeRun(workspace.path, issue, config), /before_run hook timed out after 200ms/);
  assert.ok(Date.now() - startedAt < 1_500);

  const escapedPid = Number.parseInt(await readFile(escapedPidFile, "utf8"), 10);
  assert.ok(Number.isInteger(escapedPid));
  terminateGroup(escapedPid);
  await waitForProcessExit(escapedPid);
});

async function waitForProcessGroupExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      // EPERM means this short-lived PGID has already been recycled by another
      // test worker; any surviving process from our hook would still share our uid.
      if (isErrno(error, "ESRCH") || isErrno(error, "EPERM")) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  terminateGroup(pid);
  assert.fail(`process group ${pid} survived hook timeout`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isErrno(error, "ESRCH")) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function terminateGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isErrno(error, "ESRCH")) throw error;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
