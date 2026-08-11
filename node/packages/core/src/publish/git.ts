import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { isNodeError, terminateProcessTreeBestEffort } from "../system.js";

const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_KILL_GRACE_MS = 250;
const MAX_OUTPUT_BYTES = 64 * 1024;
const OWNERSHIP_MARKER = ".symphony-workspace.json";
const CONTROL_CHARACTER = /[\0\r\n]/u;

type GitConfigEntry = readonly [key: string, value: string];

const SAFE_GIT_CONFIG: readonly GitConfigEntry[] = [
  ["core.hooksPath", devNull],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.askPass", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["credential.helper", ""],
  ["credential.interactive", "false"],
  ["submodule.recurse", "false"],
];

export interface PublishGitBranchOptions {
  workspacePath: string;
  expectedOwner: string;
  expectedRepo: string;
  expectedHost: string;
  pushUrl: string;
  token?: string;
  branch: string;
  baseBranch?: string;
  commitMessage: string;
  signal: AbortSignal;
}

export interface PublishGitBranchResult {
  branch: string;
  baseBranch: string;
  commitSha: string;
}

interface GitResult {
  stdout: string;
  exitCode: number;
}

interface RemoteIdentity {
  host: string;
  owner: string;
  repo: string;
  protocol: "https" | "ssh";
}

export async function publishGitBranch(options: PublishGitBranchOptions): Promise<PublishGitBranchResult> {
  throwIfAborted(options.signal);
  const expectedHost = normalizeExpectedHost(options.expectedHost);
  const expectedOwner = repositorySegment(options.expectedOwner, "owner");
  const expectedRepo = repositorySegment(options.expectedRepo, "repository");
  const branch = exactText(options.branch, "Publish branch");
  const commitMessage = exactText(options.commitMessage, "Commit message");
  const token = normalizeToken(options.token);
  if (process.platform === "win32" && token !== undefined) {
    throw new Error("Token-authenticated Git publishing currently requires POSIX process-group cleanup");
  }

  let workspacePath: string;
  try {
    workspacePath = await realpath(exactText(options.workspacePath, "Workspace path"));
  } catch {
    throw new Error("Git workspace is unavailable");
  }
  const gitExecutable = await resolveGitExecutable(workspacePath);

  const git = (args: string[], label: string, allowedExitCodes: readonly number[] = [0], configs: readonly GitConfigEntry[] = []) =>
    runGit(gitExecutable, args, workspacePath, options.signal, label, allowedExitCodes, configs);

  const topLevel = singleLine((await git(["rev-parse", "--show-toplevel"], "Git workspace validation")).stdout);
  let canonicalTopLevel: string;
  try {
    canonicalTopLevel = await realpath(topLevel);
  } catch {
    throw new Error("Git workspace top-level is unavailable");
  }
  if (canonicalTopLevel !== workspacePath) {
    throw new Error("Workspace path must be the Git repository top-level");
  }

  const bare = singleLine((await git(["rev-parse", "--is-bare-repository"], "Git repository validation")).stdout);
  if (bare !== "false") throw new Error("Git workspace must be a non-bare repository");

  const reportedGitDirectory = singleLine(
    (await git(["rev-parse", "--absolute-git-dir"], "Git directory validation")).stdout,
  );
  let gitDirectory: string;
  try {
    gitDirectory = await realpath(reportedGitDirectory);
    if (gitDirectory !== await realpath(path.join(workspacePath, ".git"))) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error("Git directory must be the workspace .git directory");
  }
  await requireOwnershipMarker(workspacePath, gitDirectory, expectedOwner, expectedRepo, branch);
  await validateLocalConfig(git);

  const originUrls = lines((await git(["remote", "get-url", "--all", "origin"], "Git origin validation")).stdout);
  if (originUrls.length === 0) throw new Error("Git origin is missing");
  for (const originUrl of originUrls) {
    assertExpectedRemote(originUrl, expectedHost, expectedOwner, expectedRepo, "Git origin");
  }

  const pushUrl = await validatePushUrl(
    exactText(options.pushUrl, "Git push URL"),
    token,
    expectedHost,
    expectedOwner,
    expectedRepo,
  );

  let baseBranch = options.baseBranch === undefined ? undefined : exactText(options.baseBranch, "Base branch");
  if (baseBranch === undefined) {
    const originHead = await git(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      "Git base branch discovery",
      [0, 1],
    );
    if (originHead.exitCode !== 0) throw new Error("Git origin/HEAD does not identify a base branch");
    const shortName = singleLine(originHead.stdout);
    if (!shortName.startsWith("origin/") || shortName.length === "origin/".length) {
      throw new Error("Git origin/HEAD does not identify a base branch");
    }
    baseBranch = shortName.slice("origin/".length);
  }

  await validateBranchName(git, branch, "Publish branch");
  await validateBranchName(git, baseBranch, "Base branch");
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  const hasBase = await git(["show-ref", "--verify", "--quiet", baseRef], "Git base branch validation", [0, 1]);
  if (hasBase.exitCode !== 0) throw new Error("Git base branch is unavailable locally");
  const branchRef = `refs/heads/${branch}`;
  const hasBranch = await git(
    ["show-ref", "--verify", "--quiet", branchRef],
    "Git publish branch validation",
    [0, 1],
  );
  if (hasBranch.exitCode === 0) {
    await git(["switch", "--quiet", branch], "Git publish branch checkout");
  } else {
    await git(["switch", "--quiet", "--no-track", "--create", branch], "Git publish branch creation");
  }
  const basedOnExpectedBranch = await git(
    ["merge-base", "--is-ancestor", baseRef, "HEAD"],
    "Git base ancestry validation",
    [0, 1],
  );
  if (basedOnExpectedBranch.exitCode !== 0) {
    throw new Error("Git HEAD is not based on the expected base branch");
  }

  const status = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "Git worktree inspection",
  );
  if (status.stdout.length > 0) {
    await validateLocalConfig(git);
    await git(["add", "--all", "--", "."], "Git change staging");
    const staged = await git(["diff", "--cached", "--quiet", "--exit-code"], "Git staged change inspection", [0, 1]);
    if (staged.exitCode === 1) {
      await git(
        ["commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "--message", commitMessage],
        "Git change commit",
        [0],
        [
          ["user.name", "AI Symphony"],
          ["user.email", "ai-symphony@localhost"],
        ],
      );
    }
  }

  const commitSha = singleLine((await git(["rev-parse", "--verify", "HEAD^{commit}"], "Git commit inspection")).stdout);
  if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) throw new Error("Git returned an invalid commit identifier");
  const commitsAhead = Number(
    singleLine((await git(["rev-list", "--count", `${baseRef}..HEAD`], "Git change inspection")).stdout),
  );
  if (!Number.isSafeInteger(commitsAhead) || commitsAhead < 1) {
    throw new Error("Git workspace has no changes to publish");
  }

  await validateLocalConfig(git);
  const authorizationConfig =
    token === undefined
      ? []
      : [gitAuthorization(pushUrl, token), ["http.followRedirects", "false"]] satisfies readonly GitConfigEntry[];
  await git(
    ["push", "--porcelain", "--", pushUrl, `HEAD:refs/heads/${branch}`],
    "Git branch push",
    [0],
    authorizationConfig,
  );

  return { branch, baseBranch, commitSha };
}

async function validateBranchName(
  git: (args: string[], label: string, allowedExitCodes?: readonly number[]) => Promise<GitResult>,
  branch: string,
  label: string,
): Promise<void> {
  if (branch === "HEAD" || branch.includes("@{") || CONTROL_CHARACTER.test(branch)) {
    throw new Error(`${label} is invalid`);
  }
  const result = await git(["check-ref-format", "--branch", branch], `${label} validation`, [0, 1]);
  if (result.exitCode !== 0) throw new Error(`${label} is invalid`);
}

async function validateLocalConfig(
  git: (args: string[], label: string, allowedExitCodes?: readonly number[]) => Promise<GitResult>,
): Promise<void> {
  const result = await git(
    ["config", "--local", "--no-includes", "--name-only", "--null", "--list"],
    "Git local configuration inspection",
  );
  const keys = result.stdout.split("\0").filter(Boolean);
  if (keys.some((key) => !isAllowedLocalConfigKey(key))) {
    throw new Error("Git repository contains unsupported local configuration");
  }
}

function isAllowedLocalConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (
    /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|extensions\.(?:objectformat|refstorage))$/u.test(
      normalized,
    )
  ) {
    return true;
  }
  if (normalized === "remote.origin.url" || normalized === "remote.origin.fetch") return true;
  return /^branch\..+\.(?:remote|merge)$/u.test(normalized);
}

async function requireOwnershipMarker(
  workspacePath: string,
  gitDirectory: string,
  expectedOwner: string,
  expectedRepo: string,
  branch: string,
): Promise<void> {
  const issueId = /^symphony\/issue-([1-9]\d*)$/u.exec(branch)?.[1];
  if (issueId === undefined) throw new Error("Publish branch is not bound to an issue");
  const issueIdentifier = `${expectedOwner}/${expectedRepo}#${issueId}`;
  const candidates = [path.join(gitDirectory, OWNERSHIP_MARKER), path.join(workspacePath, OWNERSHIP_MARKER)];
  for (const candidate of candidates) {
    let markerStat;
    try {
      markerStat = await lstat(candidate);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw new Error("Git workspace ownership marker is unavailable");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      markerStat.isSymbolicLink() ||
      !markerStat.isFile() ||
      (uid !== undefined && markerStat.uid !== uid) ||
      (markerStat.mode & 0o022) !== 0 ||
      markerStat.size > 4_096
    ) {
      throw new Error("Git workspace ownership marker is unsafe");
    }
    try {
      const marker: unknown = JSON.parse(await readFile(candidate, "utf8"));
      if (
        typeof marker !== "object" ||
        marker === null ||
        !("issueId" in marker) ||
        !("issueIdentifier" in marker) ||
        marker.issueId !== issueId ||
        marker.issueIdentifier !== issueIdentifier
      ) {
        throw new Error("invalid marker");
      }
    } catch {
      throw new Error("Git workspace ownership marker is invalid");
    }
    return;
  }
  throw new Error("Git workspace ownership marker is missing");
}

async function validatePushUrl(
  value: string,
  token: string | undefined,
  expectedHost: string,
  expectedOwner: string,
  expectedRepo: string,
): Promise<string> {
  const remote = parseRemote(value);
  if (remote !== null) {
    assertIdentity(remote, expectedHost, expectedOwner, expectedRepo, "Git push URL");
    if (token !== undefined && remote.protocol !== "https") {
      throw new Error("Token-authenticated Git pushes require an HTTPS URL");
    }
    return value;
  }
  if (token !== undefined || !path.isAbsolute(value)) throw new Error("Git push URL is invalid");
  try {
    return await realpath(value);
  } catch {
    throw new Error("Git push target is unavailable");
  }
}

function gitAuthorization(pushUrl: string, token: string): GitConfigEntry {
  const url = new URL(pushUrl);
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  const pathScope = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return [`http.${url.origin}${pathScope}.extraHeader`, `Authorization: Basic ${authorization}`];
}

function assertExpectedRemote(
  value: string,
  expectedHost: string,
  expectedOwner: string,
  expectedRepo: string,
  label: string,
): void {
  const remote = parseRemote(value);
  if (remote === null) throw new Error(`${label} is not a supported HTTPS or SSH repository URL`);
  assertIdentity(remote, expectedHost, expectedOwner, expectedRepo, label);
}

function assertIdentity(
  remote: RemoteIdentity,
  expectedHost: string,
  expectedOwner: string,
  expectedRepo: string,
  label: string,
): void {
  if (
    remote.host.toLowerCase() !== expectedHost.toLowerCase() ||
    remote.owner.toLowerCase() !== expectedOwner.toLowerCase() ||
    remote.repo.toLowerCase() !== expectedRepo.toLowerCase()
  ) {
    throw new Error(`${label} does not match the expected repository`);
  }
}

function parseRemote(value: string): RemoteIdentity | null {
  if (CONTROL_CHARACTER.test(value)) return null;
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (
      url.username !== (url.protocol === "ssh:" ? "git" : "") ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    const repository = repositoryPath(url.pathname);
    if (repository === null) return null;
    return {
      host: url.host,
      owner: repository.owner,
      repo: repository.repo,
      protocol: url.protocol === "https:" ? "https" : "ssh",
    };
  }

  const scp = /^git@([^:/\s]+):(.+)$/u.exec(value);
  if (!scp?.[1] || !scp[2]) return null;
  const repository = repositoryPath(scp[2]);
  if (repository === null) return null;
  return { host: scp[1], owner: repository.owner, repo: repository.repo, protocol: "ssh" };
}

function repositoryPath(value: string): { owner: string; repo: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).replace(/^\/+|\/+$/gu, "");
  } catch {
    return null;
  }
  const segments = decoded.split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  const repo = segments[1].endsWith(".git") ? segments[1].slice(0, -4) : segments[1];
  if (!isRepositorySegment(segments[0]) || !isRepositorySegment(repo)) return null;
  return { owner: segments[0], repo };
}

function normalizeExpectedHost(value: string): string {
  const expected = exactText(value, "Expected Git host").toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(`https://${expected}`);
  } catch {
    throw new Error("Expected Git host is invalid");
  }
  if (parsed.host.toLowerCase() !== expected || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Expected Git host is invalid");
  }
  return expected;
}

function repositorySegment(value: string, label: string): string {
  const segment = exactText(value, `Expected Git ${label}`);
  if (!isRepositorySegment(segment)) throw new Error(`Expected Git ${label} is invalid`);
  return segment;
}

function isRepositorySegment(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/u.test(value);
}

function normalizeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "" || value.trim() !== value || CONTROL_CHARACTER.test(value)) {
    throw new Error("Git token is invalid");
  }
  return value;
}

function exactText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || CONTROL_CHARACTER.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function singleLine(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Git returned an invalid response");
  }
  return trimmed;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Git publish aborted");
}

export async function resolveGitExecutable(workspacePath: string): Promise<string> {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd", "git.bat"] : ["git"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      try {
        const executable = await realpath(path.join(directory, name));
        await access(executable, fsConstants.X_OK);
        const relative = path.relative(workspacePath, executable);
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
          continue;
        }
        return executable;
      } catch {
        // Keep searching the host PATH for an executable outside the agent workspace.
      }
    }
  }
  throw new Error("A trusted Git executable is unavailable");
}

function runGit(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  label: string,
  allowedExitCodes: readonly number[],
  extraConfig: readonly GitConfigEntry[],
): Promise<GitResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: gitEnvironment(extraConfig, path.dirname(executable)),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let outputBytes = 0;
    let finished = false;
    let terminating = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const terminate = (error: Error) => {
      if (finished || terminating) return;
      terminating = true;
      terminateProcessTreeBestEffort(child.pid, "SIGTERM");
      forceKill = setTimeout(() => {
        terminateProcessTreeBestEffort(child.pid, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        fail(error);
      }, COMMAND_KILL_GRACE_MS);
    };
    const onAbort = () => terminate(new Error("Git publish aborted"));
    const collect = (chunk: Buffer | string, include: boolean) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error(`${label} failed`));
      } else if (include) {
        stdout += chunk.toString();
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer | string) => collect(chunk, false));
    child.once("error", () => {
      if (!terminating) fail(new Error(`${label} failed`));
    });
    child.once("close", (exitCode) => {
      if (terminating || finished) return;
      finished = true;
      cleanup();
      if (exitCode !== null && allowedExitCodes.includes(exitCode)) {
        resolve({ stdout, exitCode });
      } else {
        reject(new Error(`${label} failed`));
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    timeout = setTimeout(() => terminate(new Error(`${label} timed out`)), COMMAND_TIMEOUT_MS);
  });
}

function gitEnvironment(extraConfig: readonly GitConfigEntry[], executableDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: executableDirectory };
  for (const name of [
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  environment.SSH_ASKPASS_REQUIRE = "never";
  environment.GIT_PAGER = "cat";
  environment.PAGER = "cat";
  environment.LC_ALL = "C";

  const config = [...SAFE_GIT_CONFIG, ...extraConfig];
  environment.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}
