import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { WorkflowConfig } from "../config/schema.js";
import type { Issue } from "../domain.js";
import type { AppLogger } from "../log.js";

export interface Workspace {
  path: string;
  createdNow: boolean;
}

const OWNERSHIP_MARKER = ".symphony-workspace.json";
const HOOK_KILL_GRACE_MS = 250;

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

export class WorkspaceManager {
  readonly #logger: AppLogger;

  constructor(logger: AppLogger) {
    this.#logger = logger;
  }

  async validateForIssue(workspacePath: string, issue: Issue, config: WorkflowConfig): Promise<string> {
    return validateWorkspacePath(workspacePath, issue, config);
  }

  async createForIssue(issue: Issue, config: WorkflowConfig, signal?: AbortSignal): Promise<Workspace> {
    const root = await ensureWorkspaceRoot(config.workspace.root);
    const workspacePath = path.join(root, workspaceKey(issue.identifier));
    const createdNow = !(await pathExists(workspacePath));
    let createdIdentity: DirectoryIdentity | undefined;

    if (createdNow) {
      await mkdir(workspacePath, { mode: 0o700 });
      const workspaceStat = await validateOwnedDirectory(workspacePath, "Workspace");
      createdIdentity = identityOf(workspaceStat);
    }

    let canonicalPath = await validateWorkspaceDirectory(root, workspacePath, createdIdentity);
    if (!createdNow) {
      await requireOwnershipMarker(canonicalPath, issue);
      return { path: canonicalPath, createdNow: false };
    }

    try {
      if (config.hooks.afterCreate) {
        await runHook("after_create", config.hooks.afterCreate, canonicalPath, issue, config.hooks.timeoutMs, signal);
      }
      canonicalPath = await validateWorkspaceDirectory(root, workspacePath, createdIdentity);
      await writeOwnershipMarker(canonicalPath, issue);
      await requireOwnershipMarker(canonicalPath, issue);
    } catch (error) {
      try {
        await removeNewWorkspace(workspacePath, createdIdentity);
      } catch (cleanupError) {
        this.#logger.warn(
          { error: cleanupError, issue_id: issue.id, issue_identifier: issue.identifier },
          "unsafe workspace was left in place after after_create failure",
        );
      }
      throw error;
    }

    return { path: canonicalPath, createdNow: true };
  }

  async beforeRun(
    workspacePath: string,
    issue: Issue,
    config: WorkflowConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    const canonicalPath = await validateWorkspacePath(workspacePath, issue, config);
    if (config.hooks.beforeRun) {
      await runHook("before_run", config.hooks.beforeRun, canonicalPath, issue, config.hooks.timeoutMs, signal);
      await validateWorkspacePath(workspacePath, issue, config);
    }
  }

  async afterRun(
    workspacePath: string,
    issue: Issue,
    config: WorkflowConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!config.hooks.afterRun) return;
    try {
      const canonicalPath = await validateWorkspacePath(workspacePath, issue, config);
      await runHook("after_run", config.hooks.afterRun, canonicalPath, issue, config.hooks.timeoutMs, signal);
      await validateWorkspacePath(workspacePath, issue, config);
    } catch (error) {
      if (!signal?.aborted) {
        this.#logger.warn({ error, issue_id: issue.id, issue_identifier: issue.identifier }, "after_run hook failed");
      }
    }
  }

  async removeForIssue(issue: Issue, config: WorkflowConfig, signal?: AbortSignal): Promise<void> {
    const root = await ensureWorkspaceRoot(config.workspace.root);
    const workspacePath = path.join(root, workspaceKey(issue.identifier));
    if (!(await pathExists(workspacePath))) return;
    const canonicalPath = await validateWorkspacePath(workspacePath, issue, config);
    if (config.hooks.beforeRemove) {
      try {
        await runHook("before_remove", config.hooks.beforeRemove, canonicalPath, issue, config.hooks.timeoutMs, signal);
      } catch (error) {
        if (!signal?.aborted) {
          this.#logger.warn({ error, issue_id: issue.id, issue_identifier: issue.identifier }, "before_remove hook failed");
        }
      }
    }
    const revalidatedPath = await validateWorkspacePath(workspacePath, issue, config);
    await rm(revalidatedPath, { recursive: true, force: true });
  }
}

export function workspaceKey(identifier: string): string {
  let sanitized = identifier.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (sanitized === "." || sanitized === ".." || sanitized === "") sanitized = "issue";
  if (sanitized === identifier) return sanitized;
  const digest = createHash("sha256").update(identifier).digest("hex").slice(0, 16);
  return `${sanitized}-${digest}`;
}

async function validateWorkspacePath(
  workspacePath: string,
  issue: Issue,
  config: WorkflowConfig,
): Promise<string> {
  const root = await ensureWorkspaceRoot(config.workspace.root);
  const expectedPath = path.join(root, workspaceKey(issue.identifier));
  if (path.resolve(workspacePath) !== expectedPath) {
    throw new Error(`Workspace path does not match issue ${issue.identifier}: ${workspacePath}`);
  }

  const canonicalPath = await validateWorkspaceDirectory(root, expectedPath);
  await requireOwnershipMarker(canonicalPath, issue);
  return canonicalPath;
}

async function ensureWorkspaceRoot(configuredRoot: string): Promise<string> {
  if (!(await pathExists(configuredRoot))) {
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  }
  await validateOwnedDirectory(configuredRoot, "Workspace root");
  return realpath(configuredRoot);
}

async function validateWorkspaceDirectory(
  root: string,
  workspacePath: string,
  expectedIdentity?: DirectoryIdentity,
): Promise<string> {
  const workspaceStat = await validateOwnedDirectory(workspacePath, "Workspace");
  if (
    expectedIdentity &&
    (workspaceStat.dev !== expectedIdentity.dev || workspaceStat.ino !== expectedIdentity.ino)
  ) {
    throw new Error(`Workspace was replaced while it was being prepared: ${workspacePath}`);
  }
  const canonicalPath = await realpath(workspacePath);
  assertContained(root, canonicalPath);
  return canonicalPath;
}

async function validateOwnedDirectory(candidate: string, label: string): Promise<Stats> {
  const candidateStat = await lstat(candidate);
  if (candidateStat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${candidate}`);
  if (!candidateStat.isDirectory()) throw new Error(`${label} path is not a directory: ${candidate}`);

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && candidateStat.uid !== uid) {
    throw new Error(`${label} must be owned by uid ${uid}: ${candidate}`);
  }
  if ((candidateStat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable: ${candidate}`);
  }
  if ((candidateStat.mode & 0o300) !== 0o300) {
    throw new Error(`${label} must be owner-writable and searchable: ${candidate}`);
  }
  return candidateStat;
}

async function writeOwnershipMarker(workspacePath: string, issue: Issue): Promise<void> {
  const markerPath = await markerPathForWrite(workspacePath);
  await writeFile(
    markerPath,
    `${JSON.stringify({ issueId: issue.id, issueIdentifier: issue.identifier })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function requireOwnershipMarker(workspacePath: string, issue: Issue): Promise<void> {
  const markerPath = await markerPathForRead(workspacePath);
  if (!markerPath) {
    throw new Error(`Workspace ownership marker is missing for ${issue.identifier}: ${workspacePath}`);
  }

  const markerStat = await lstat(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new Error(`Workspace ownership marker must be a regular file: ${markerPath}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && markerStat.uid !== uid) {
    throw new Error(`Workspace ownership marker must be owned by uid ${uid}: ${markerPath}`);
  }
  if ((markerStat.mode & 0o022) !== 0 || markerStat.size > 4_096) {
    throw new Error(`Workspace ownership marker is unsafe: ${markerPath}`);
  }

  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Workspace ownership marker is invalid: ${markerPath}`, { cause: error });
  }
  if (
    typeof marker !== "object" ||
    marker === null ||
    !("issueId" in marker) ||
    !("issueIdentifier" in marker) ||
    marker.issueId !== issue.id ||
    marker.issueIdentifier !== issue.identifier
  ) {
    throw new Error(`Workspace ownership marker does not match issue ${issue.identifier}: ${markerPath}`);
  }
}

async function markerPathForWrite(workspacePath: string): Promise<string> {
  const gitDirectory = path.join(workspacePath, ".git");
  if (await isDirectory(gitDirectory)) {
    await validateOwnedDirectory(gitDirectory, "Git directory");
    return path.join(gitDirectory, OWNERSHIP_MARKER);
  }
  return path.join(workspacePath, OWNERSHIP_MARKER);
}

async function markerPathForRead(workspacePath: string): Promise<string | undefined> {
  const gitDirectory = path.join(workspacePath, ".git");
  if (await isDirectory(gitDirectory)) {
    await validateOwnedDirectory(gitDirectory, "Git directory");
    const gitMarker = path.join(gitDirectory, OWNERSHIP_MARKER);
    if (await pathExists(gitMarker)) return gitMarker;
  }
  const leafMarker = path.join(workspacePath, OWNERSHIP_MARKER);
  return (await pathExists(leafMarker)) ? leafMarker : undefined;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function removeNewWorkspace(
  workspacePath: string,
  expectedIdentity: DirectoryIdentity | undefined,
): Promise<void> {
  if (!expectedIdentity || !(await pathExists(workspacePath))) return;
  const workspaceStat = await lstat(workspacePath);
  if (
    workspaceStat.isSymbolicLink() ||
    !workspaceStat.isDirectory() ||
    workspaceStat.dev !== expectedIdentity.dev ||
    workspaceStat.ino !== expectedIdentity.ino
  ) {
    throw new Error(`Refusing to clean a replaced workspace: ${workspacePath}`);
  }
  await rm(workspacePath, { recursive: true, force: true });
}

function identityOf(candidateStat: Stats): DirectoryIdentity {
  return { dev: candidateStat.dev, ino: candidateStat.ino };
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe workspace path outside configured root: ${candidate}`);
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function runHook(
  name: string,
  script: string,
  cwd: string,
  issue: Issue,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error(`${name} hook aborted`);

  let terminationKind: "aborted" | "timeout" | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  const child = spawn("bash", ["-lc", script], {
    cwd,
    env: {
      ...process.env,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });

  try {
    const childOutcome = new Promise<
      { kind: "close"; exitCode: number | null } | { kind: "error"; error: Error }
    >((resolve) => {
      child.once("error", (error) => resolve({ kind: "error", error }));
      child.once("close", (exitCode) => resolve({ kind: "close", exitCode }));
    });
    let resolveTermination!: (outcome: { kind: "aborted" | "timeout" }) => void;
    const terminationOutcome = new Promise<{ kind: "aborted" | "timeout" }>((resolve) => {
      resolveTermination = resolve;
    });
    const terminate = (kind: "aborted" | "timeout") => {
      if (terminationKind) return;
      terminationKind = kind;
      terminateTreeBestEffort(child.pid, "SIGTERM");
      forceKill = setTimeout(() => {
        terminateTreeBestEffort(child.pid, "SIGKILL");
        child.stderr.destroy();
        resolveTermination({ kind });
      }, HOOK_KILL_GRACE_MS);
    };
    const onAbort = () => terminate("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timeout = setTimeout(() => terminate("timeout"), timeoutMs);

    let outcome = await Promise.race([childOutcome, terminationOutcome]);
    if (terminationKind && outcome.kind !== terminationKind) outcome = await terminationOutcome;
    signal?.removeEventListener("abort", onAbort);
    if (outcome.kind === "timeout") {
      throw new Error(`${name} hook timed out after ${timeoutMs}ms`);
    }
    if (outcome.kind === "aborted") throw new Error(`${name} hook aborted`);
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind !== "close") throw new Error(`${name} hook ended unexpectedly`);
    if (outcome.exitCode !== 0) {
      throw new Error(`${name} hook exited with code ${String(outcome.exitCode)}: ${stderr.trim()}`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  }
}

function terminateTreeBestEffort(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  const targets = process.platform === "win32" ? [pid] : [-pid, pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ESRCH") {
        // The timeout remains bounded even when the OS refuses termination.
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
