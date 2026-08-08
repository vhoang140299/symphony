import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  publishGitBranch,
  type PublishGitBranchOptions,
} from "../src/publish/git.js";

interface Fixture {
  root: string;
  remotePath: string;
  workspacePath: string;
}

test("publishes a fixed branch, skips hooks, and reruns without an empty commit", async (t) => {
  const fixture = await createFixture(t);
  const hookPath = path.join(fixture.workspacePath, ".git", "hooks", "pre-commit");
  await writeFile(hookPath, "#!/bin/sh\ntouch .hook-ran\nexit 91\n", { mode: 0o700 });
  await chmod(hookPath, 0o700);
  await writeFile(path.join(fixture.workspacePath, "result.txt"), "published\n");

  const first = await publishGitBranch(optionsFor(fixture));
  assert.equal(first.branch, "symphony/issue-7");
  assert.equal(first.baseBranch, "main");
  assert.match(first.commitSha, /^[0-9a-f]{40}$/u);
  assert.equal(gitBare(fixture.remotePath, ["rev-parse", "refs/heads/symphony/issue-7"]), first.commitSha);
  assert.equal(git(fixture.workspacePath, ["rev-list", "--count", "origin/main..HEAD"]), "1");
  await assert.rejects(access(path.join(fixture.workspacePath, ".hook-ran")), isMissing);

  git(fixture.workspacePath, ["remote", "set-url", "origin", "https://git.example.test/acme/widget.git"]);
  const second = await publishGitBranch(optionsFor(fixture));
  assert.equal(second.commitSha, first.commitSha);

  git(fixture.workspacePath, ["remote", "set-url", "origin", "ssh://git@git.example.test/acme/widget.git"]);
  const third = await publishGitBranch(optionsFor(fixture));
  assert.equal(third.commitSha, first.commitSha);
  assert.equal(git(fixture.workspacePath, ["status", "--porcelain"]), "");
});

test("rejects an origin bound to another repository before committing", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.workspacePath, "unpublished.txt"), "do not publish\n");
  git(fixture.workspacePath, ["remote", "set-url", "origin", "git@git.example.test:other/widget.git"]);

  await assert.rejects(publishGitBranch(optionsFor(fixture)), /Git origin does not match the expected repository/u);
  assert.equal(git(fixture.workspacePath, ["status", "--porcelain"]), "?? unpublished.txt");
  assert.notEqual(gitBareStatus(fixture.remotePath, ["show-ref", "--verify", "refs/heads/symphony/issue-7"]), 0);
});

test("rejects a publish with no commits ahead of the base branch", async (t) => {
  const fixture = await createFixture(t);

  await assert.rejects(
    publishGitBranch(optionsFor(fixture)),
    /Git workspace has no changes to publish/u,
  );
  assert.notEqual(gitBareStatus(fixture.remotePath, ["show-ref", "--verify", "refs/heads/symphony/issue-7"]), 0);
});

test("rejects an existing publish branch with unrelated history", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.workspacePath, ["switch", "--orphan", "symphony/issue-7"]);
  await writeFile(path.join(fixture.workspacePath, "unrelated.txt"), "unrelated\n");
  git(fixture.workspacePath, ["add", "unrelated.txt"]);
  git(fixture.workspacePath, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--message",
    "Unrelated history",
  ]);
  git(fixture.workspacePath, ["switch", "main"]);
  await writeFile(path.join(fixture.workspacePath, "result.txt"), "must not publish\n");

  await assert.rejects(
    publishGitBranch(optionsFor(fixture)),
    /Git HEAD is not based on the expected base branch/u,
  );
  assert.notEqual(gitBareStatus(fixture.remotePath, ["show-ref", "--verify", "refs/heads/symphony/issue-7"]), 0);
});

test("rejects executable clean filters before git add can run them", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.workspacePath, ["config", "--local", "filter.evil.clean", "touch filter-ran"]);
  await writeFile(path.join(fixture.workspacePath, ".gitattributes"), "*.txt filter=evil\n");
  await writeFile(path.join(fixture.workspacePath, "payload.txt"), "payload\n");

  await assert.rejects(
    publishGitBranch(optionsFor(fixture)),
    /Git repository contains unsupported local configuration/u,
  );
  await assert.rejects(access(path.join(fixture.workspacePath, "filter-ran")), isMissing);
});

test("does not execute a Git binary planted in the workspace", async (t) => {
  const fixture = await createFixture(t);
  const plantedGit = path.join(fixture.workspacePath, "git");
  const plantedMarker = path.join(fixture.workspacePath, "planted-git-ran");
  await writeFile(plantedGit, `#!/bin/sh\ntouch '${plantedMarker}'\nexit 99\n`, { mode: 0o700 });
  await writeFile(path.join(fixture.workspacePath, "result.txt"), "published\n");
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.workspacePath}${path.delimiter}${previousPath ?? ""}`;

  try {
    await publishGitBranch(optionsFor(fixture));
    await assert.rejects(access(plantedMarker), isMissing);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("rejects repository-local URL rewrites and HTTP settings", async (t) => {
  await t.test("URL rewrite", async (t) => {
    const fixture = await createFixture(t);
    git(fixture.workspacePath, [
      "config",
      "--local",
      "url.https://evil.example/.insteadOf",
      "git@git.example.test:",
    ]);
    await assert.rejects(
      publishGitBranch(optionsFor(fixture)),
      /Git repository contains unsupported local configuration/u,
    );
  });

  await t.test("HTTP proxy", async (t) => {
    const fixture = await createFixture(t);
    git(fixture.workspacePath, ["config", "--local", "http.proxy", "https://evil.example"]);
    await assert.rejects(
      publishGitBranch(optionsFor(fixture)),
      /Git repository contains unsupported local configuration/u,
    );
  });
});

test("requires a Symphony ownership marker", async (t) => {
  const fixture = await createFixture(t);
  await rm(path.join(fixture.workspacePath, ".git", ".symphony-workspace.json"));
  await assert.rejects(publishGitBranch(optionsFor(fixture)), /Git workspace ownership marker is missing/u);
});

test("requires the ownership marker to match the bound issue", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    path.join(fixture.workspacePath, ".git", ".symphony-workspace.json"),
    `${JSON.stringify({ issueId: "8", issueIdentifier: "acme/widget#8" })}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(publishGitBranch(optionsFor(fixture)), /Git workspace ownership marker is invalid/u);
});

test("honors a pre-aborted publish signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    publishGitBranch({
      workspacePath: "/not-used",
      expectedOwner: "acme",
      expectedRepo: "widget",
      expectedHost: "git.example.test",
      pushUrl: "/not-used",
      branch: "symphony/issue-7",
      commitMessage: "Publish issue 7",
      signal: controller.signal,
    }),
    /Git publish aborted/u,
  );
});

test(
  "abort terminates the Git process group and its token-bearing descendant",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await createFixture(t);
    const wrapperDirectory = path.join(fixture.root, "bin");
    const pidPath = path.join(fixture.root, "descendant.pid");
    await mkdir(wrapperDirectory);
    const wrapperPath = path.join(wrapperDirectory, "git");
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$1" = "push" ]; then
  (trap "" TERM; while :; do /bin/sleep 1; done) &
  descendant=$!
  echo "$descendant" > ${shellQuote(pidPath)}
  trap "" TERM
  while :; do /bin/sleep 1; done
fi
exec ${shellQuote(hostGitExecutable())} "$@"
`,
      { mode: 0o700 },
    );
    await writeFile(path.join(fixture.workspacePath, "result.txt"), "published\n");
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${previousPath ?? ""}`;
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;

    try {
      pending = publishGitBranch({
        ...optionsFor(fixture),
        pushUrl: "https://git.example.test/acme/widget.git",
        token: "tree-cleanup-token",
        signal: controller.signal,
      });
      const descendantPid = Number(await waitForFile(pidPath));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      controller.abort();
      await assert.rejects(pending, /Git publish aborted/u);
      await waitForProcessExit(descendantPid);
    } finally {
      controller.abort();
      await pending?.catch(() => undefined);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

async function createFixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-git-publisher-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const remotePath = path.join(root, "remote.git");
  const seedPath = path.join(root, "seed");
  const workspacePath = path.join(root, "workspace");

  git(root, ["init", "--bare", "--initial-branch=main", remotePath]);
  git(root, ["init", "--initial-branch=main", seedPath]);
  git(seedPath, ["config", "user.name", "Test User"]);
  git(seedPath, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(seedPath, "README.md"), "# fixture\n");
  git(seedPath, ["add", "README.md"]);
  git(seedPath, ["commit", "-m", "Initial commit"]);
  git(seedPath, ["remote", "add", "origin", remotePath]);
  git(seedPath, ["push", "-u", "origin", "main"]);
  git(root, ["clone", remotePath, workspacePath]);
  git(workspacePath, ["remote", "set-url", "origin", "git@git.example.test:acme/widget.git"]);
  await writeFile(
    path.join(workspacePath, ".git", ".symphony-workspace.json"),
    `${JSON.stringify({ issueId: "7", issueIdentifier: "acme/widget#7" })}\n`,
    { mode: 0o600 },
  );
  return { root, remotePath, workspacePath };
}

function optionsFor(fixture: Fixture): PublishGitBranchOptions {
  return {
    workspacePath: fixture.workspacePath,
    expectedOwner: "acme",
    expectedRepo: "widget",
    expectedHost: "git.example.test",
    pushUrl: fixture.remotePath,
    branch: "symphony/issue-7",
    commitMessage: "Publish issue 7",
    signal: new AbortController().signal,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitBare(gitDirectory: string, args: string[]): string {
  return git(path.dirname(gitDirectory), [`--git-dir=${gitDirectory}`, ...args]);
}

function gitBareStatus(gitDirectory: string, args: string[]): number {
  try {
    gitBare(gitDirectory, args);
    return 0;
  } catch (error) {
    if (isExecError(error) && typeof error.status === "number") return error.status;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExecError(error: unknown): error is Error & { status?: number } {
  return error instanceof Error && "status" in error;
}

function hostGitExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error("Git executable not found for test");
}

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} survived Git publish cleanup`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
