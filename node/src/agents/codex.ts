import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { agentCompletionOutputSchema, parseAgentCompletionJson } from "../completion.js";
import type { AgentDriver, AgentEvent, AgentRunContext, AgentUsage } from "../domain.js";
import { pickEnvironment } from "./environment.js";

const codexOptionsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    model_reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
    skip_git_repo_check: z.boolean().default(false),
    env_allowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).default([]),
    codex_executable: z.string().trim().min(1).optional(),
  })
  .strict();

const execFileAsync = promisify(execFile);

export interface CodexStreamRequest {
  clientOptions: CodexOptions;
  threadOptions: ThreadOptions;
  prompt: string;
  signal: AbortSignal;
  outputSchema?: unknown;
  sessionId?: string;
}

export type OpenCodexStream = (request: CodexStreamRequest) => Promise<AsyncIterable<ThreadEvent>>;

async function openCodexStream(request: CodexStreamRequest): Promise<AsyncIterable<ThreadEvent>> {
  const codex = new Codex(request.clientOptions);
  const thread =
    request.sessionId === undefined
      ? codex.startThread(request.threadOptions)
      : codex.resumeThread(request.sessionId, request.threadOptions);
  return (
    await thread.runStreamed(request.prompt, {
      signal: request.signal,
      ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    })
  ).events;
}

export class CodexAgentDriver implements AgentDriver {
  readonly kind = "codex";
  #safeHome: Promise<string> | undefined;

  constructor(
    private readonly openStream: OpenCodexStream = openCodexStream,
    private readonly wrapperPath = defaultWrapperPath,
  ) {}

  async *run(context: AgentRunContext): AsyncIterable<AgentEvent> {
    let terminalEmitted = false;
    let turnCompleted = false;
    let turnFailed = false;
    let commandTempPath: string | undefined;
    let sessionId = context.sessionId;
    let lastCompletedAgentMessage: string | undefined;

    try {
      const configured = codexOptionsSchema.parse(context.runtimeOptions);
      if (context.signal.aborted) {
        terminalEmitted = true;
        yield eventNow("turn_failed", {
          summary: "Codex run aborted",
          ...(sessionId === undefined ? {} : { sessionId }),
        });
        return;
      }

      const codexHome = await this.#resolveSafeHome();
      const workspacePath = await resolveSafeCodexWorkspace(
        context.workspacePath,
        configured.skip_git_repo_check,
        context.signal,
      );
      await assertCodexHomeOutsideWorkspace(codexHome, workspacePath);
      commandTempPath = await createCodexCommandTemp();

      const threadOptions: ThreadOptions = {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        workingDirectory: workspacePath,
        skipGitRepoCheck: configured.skip_git_repo_check,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        ...(configured.model === undefined ? {} : { model: configured.model }),
        ...(configured.model_reasoning_effort === undefined
          ? {}
          : { modelReasoningEffort: configured.model_reasoning_effort }),
      };
      const clientEnvironment = buildCodexEnvironment(
        configured.env_allowlist,
        codexHome,
        context.sensitiveEnvNames,
      );
      if (configured.codex_executable !== undefined) {
        clientEnvironment.SYMPHONY_CODEX_REAL_EXECUTABLE = configured.codex_executable;
      }
      const clientOptions: CodexOptions = {
        env: clientEnvironment,
        codexPathOverride: this.wrapperPath,
        config: {
          allow_login_shell: false,
          agents: { enabled: false },
          features: {
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
          },
          sandbox_workspace_write: {
            network_access: false,
            writable_roots: [commandTempPath],
            exclude_slash_tmp: true,
            exclude_tmpdir_env_var: true,
          },
          shell_environment_policy: {
            inherit: "none",
            ignore_default_excludes: false,
            set: buildCodexShellEnvironment(commandTempPath, context.sensitiveEnvNames),
          },
        },
      };
      const stream = await this.openStream({
        clientOptions,
        threadOptions,
        prompt: context.prompt,
        signal: context.signal,
        ...(context.completionMode === "publish_change" ? { outputSchema: agentCompletionOutputSchema } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      });

      for await (const event of stream) {
        if (event.type === "thread.started") {
          sessionId = event.thread_id;
          yield eventNow("session_started", { sessionId, summary: "Codex session started" });
          continue;
        }

        if (event.type === "turn.completed") {
          yield eventNow("usage_updated", {
            usage: normalizeCodexUsage(event.usage),
            ...(sessionId === undefined ? {} : { sessionId }),
          });
          turnCompleted = true;
          continue;
        }

        if (event.type === "turn.failed" || event.type === "error") {
          turnFailed = true;
          continue;
        }

        if (
          context.completionMode === "publish_change" &&
          event.type === "item.completed" &&
          event.item.type === "agent_message"
        ) {
          lastCompletedAgentMessage = event.item.text;
        }

        yield eventNow("activity", {
          summary: activitySummary(event),
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      }

      if (turnFailed) {
        terminalEmitted = true;
        yield eventNow("turn_failed", {
          summary: "Codex turn failed",
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      } else if (turnCompleted) {
        terminalEmitted = true;
        if (context.completionMode === "publish_change") {
          const completion = parseAgentCompletionJson(lastCompletedAgentMessage);
          if (completion === undefined) {
            yield eventNow("turn_failed", {
              summary: "Codex returned invalid structured completion",
              ...(sessionId === undefined ? {} : { sessionId }),
            });
          } else {
            yield eventNow("turn_completed", {
              summary: completion.summary,
              completion,
              ...(sessionId === undefined ? {} : { sessionId }),
            });
          }
        } else {
          yield eventNow("turn_completed", {
            summary: "Codex turn completed",
            ...(sessionId === undefined ? {} : { sessionId }),
          });
        }
      } else if (!terminalEmitted) {
        terminalEmitted = true;
        yield eventNow("turn_failed", {
          summary: "Codex stream ended without a terminal event",
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      }
    } catch (error) {
      if (!terminalEmitted) {
        terminalEmitted = true;
        yield eventNow("turn_failed", {
          summary:
            context.signal.aborted
              ? "Codex run aborted"
              : error instanceof CodexConfigurationError
                ? error.message
                : "Codex run failed",
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      }
    } finally {
      if (commandTempPath !== undefined) await removeCodexCommandTemp(commandTempPath);
    }
  }

  #resolveSafeHome(): Promise<string> {
    this.#safeHome ??= resolveSafeCodexHome(process.env.CODEX_HOME);
    return this.#safeHome;
  }
}

export function buildCodexEnvironment(
  extraNames: string[],
  codexHome = process.env.CODEX_HOME,
  sensitiveEnvNames: string[] = [],
): Record<string, string> {
  return pickEnvironment(
    [...safeEnvironmentNames, ...extraNames],
    sensitiveEnvNames,
    codexHome === undefined
      ? {}
      : {
          CODEX_HOME: codexHome,
          HOME: codexHome,
          ...(process.platform === "win32"
            ? { USERPROFILE: codexHome, APPDATA: codexHome, LOCALAPPDATA: codexHome }
            : {}),
        },
  );
}

export async function resolveSafeCodexHome(configuredPath: string | undefined): Promise<string> {
  if (process.platform === "win32") {
    throw new CodexConfigurationError("The safe Codex runtime is not supported on Windows");
  }
  if (configuredPath === undefined || configuredPath.trim() === "") {
    throw new CodexConfigurationError("Codex requires CODEX_HOME to point to a dedicated profile");
  }
  if (!path.isAbsolute(configuredPath)) {
    throw new CodexConfigurationError("CODEX_HOME must be an absolute path");
  }

  try {
    const leaf = await lstat(configuredPath);
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) throw new Error("not a real directory");
    const canonicalPath = await realpath(configuredPath);
    const info = await lstat(canonicalPath);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("wrong owner");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("unsafe permissions");
    }

    const entries = await readdir(canonicalPath, { withFileTypes: true });
    if (entries.some((entry) => forbiddenCodexHomeEntry(entry.name))) {
      throw new CodexConfigurationError(
        "CODEX_HOME must not contain global instructions, hooks, or user skills",
      );
    }
    await assertNoUserCodexSkills(canonicalPath, entries.map(({ name }) => name));
    return canonicalPath;
  } catch (error) {
    if (error instanceof CodexConfigurationError) throw error;
    throw new CodexConfigurationError("CODEX_HOME must be an existing private user-owned directory");
  }
}

export function buildCodexShellEnvironment(
  commandTempPath: string,
  sensitiveEnvNames: string[] = [],
): Record<string, string> {
  return pickEnvironment(safeShellEnvironmentNames, sensitiveEnvNames, {
    TEMP: commandTempPath,
    TMP: commandTempPath,
    TMPDIR: commandTempPath,
  });
}

export function normalizeCodexUsage(usage: Usage): AgentUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cached_input_tokens,
    cacheCreationInputTokens: usage.cache_write_input_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    costUsd: 0,
  };
}

function activitySummary(
  event: Exclude<ThreadEvent, { type: "thread.started" | "turn.completed" | "turn.failed" | "error" }>,
): string {
  if (event.type === "turn.started") return "Codex turn started";
  const phase = event.type.slice("item.".length);
  return `Codex ${event.item.type.replaceAll("_", " ")} ${phase}`;
}

function eventNow(type: AgentEvent["type"], fields: Omit<AgentEvent, "type" | "timestamp">): AgentEvent {
  return { type, timestamp: new Date().toISOString(), ...fields };
}

async function resolveSafeCodexWorkspace(
  workspacePath: string,
  skipGitRepoCheck: boolean,
  signal: AbortSignal,
): Promise<string> {
  try {
    const workspace = await realpath(workspacePath);
    await assertNoProjectExtensionLayers(workspace);
    try {
      const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16_384,
        signal,
      });
      const gitRoot = await realpath(stdout.trim());
      if (gitRoot !== workspace) {
        throw new CodexConfigurationError("The Codex Git root must equal the issue workspace");
      }
    } catch (error) {
      if (error instanceof CodexConfigurationError) throw error;
      if (skipGitRepoCheck && isGitNoRepository(error)) return workspace;
      if (isGitNoRepository(error)) {
        throw new CodexConfigurationError("The Codex workspace must be a Git repository");
      }
      throw new CodexConfigurationError("The Codex Git workspace could not be validated");
    }
    return workspace;
  } catch (error) {
    if (error instanceof CodexConfigurationError) throw error;
    throw new CodexConfigurationError("The Codex issue workspace could not be validated");
  }
}

async function assertNoProjectExtensionLayers(workspacePath: string): Promise<void> {
  try {
    const entries = await readdir(workspacePath);
    if (entries.some((name) => name.toLowerCase() === ".codex" || name.toLowerCase() === ".agents")) {
      throw new CodexConfigurationError(
        "Workspace-local .codex and .agents layers are unsupported by the safe Codex runtime",
      );
    }
  } catch (error) {
    if (error instanceof CodexConfigurationError) throw error;
    throw new CodexConfigurationError("Workspace extension layers could not be validated");
  }
}

function forbiddenCodexHomeEntry(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "agents.md" ||
    normalized === "agents.override.md" ||
    normalized === "hooks.json" ||
    normalized === ".agents"
  );
}

async function assertNoUserCodexSkills(codexHome: string, entryNames: string[]): Promise<void> {
  for (const skillsDirectory of entryNames.filter((name) => name.toLowerCase() === "skills")) {
    const skillEntries = await readdir(path.join(codexHome, skillsDirectory));
    if (skillEntries.some((name) => name.toLowerCase() !== ".system")) {
      throw new CodexConfigurationError("CODEX_HOME must not contain user-installed Codex skills");
    }
  }
}

async function assertCodexHomeOutsideWorkspace(codexHome: string, workspacePath: string): Promise<void> {
  try {
    const workspace = await realpath(workspacePath);
    if (isContained(codexHome, workspace) || isContained(workspace, codexHome)) {
      throw new CodexConfigurationError("CODEX_HOME and the issue workspace must be disjoint");
    }
  } catch (error) {
    if (error instanceof CodexConfigurationError) throw error;
    throw new CodexConfigurationError("The Codex issue workspace could not be validated");
  }
}

async function createCodexCommandTemp(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "symphony-codex-command-"));
  await chmod(created, 0o700);
  return realpath(created);
}

async function removeCodexCommandTemp(commandTempPath: string): Promise<void> {
  try {
    const systemTemp = await realpath(tmpdir());
    if (
      path.dirname(commandTempPath) === systemTemp &&
      path.basename(commandTempPath).startsWith("symphony-codex-command-")
    ) {
      await rm(commandTempPath, { recursive: true, force: true });
    }
  } catch {
    // A temporary directory cleanup failure must not create a second agent outcome.
  }
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isGitNoRepository(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 128;
}

class CodexConfigurationError extends Error {}

const safeEnvironmentNames = [
  "APPDATA",
  "CI",
  "CODEX_HOME",
  "COMSPEC",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
] as const;

const safeShellEnvironmentNames = [
  "CI",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TERM",
] as const;

const defaultWrapperPath = fileURLToPath(new URL("../../../codex-symphony-wrapper.mjs", import.meta.url));
