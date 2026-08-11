import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeRuntimeOptions } from "@ai-symphony/agents/claude.js";
import { codexWrapperPath, parseCodexRuntimeOptions, resolveSafeCodexHome } from "@ai-symphony/agents/codex.js";
import type { WorkflowDefinition } from "@ai-symphony/core/config/workflow.js";
import { loadWorkflow } from "@ai-symphony/core/config/workflow.js";
import { workflowScopeHash } from "@ai-symphony/core/state/scope.js";
import { RunStateStore } from "@ai-symphony/core/state/store.js";
import { validateTrackerProvider } from "@ai-symphony/trackers/registry.js";
import { inspectWorkspaceRoot } from "@ai-symphony/core/workspace/manager.js";

export type DoctorCheckStatus = "ok" | "warning" | "error";

export type DoctorCheckId =
  | "workflow.config"
  | "tracker.config"
  | "runtime.options"
  | "runtime.executable"
  | "runtime.auth"
  | "workspace.root"
  | "state.store";

export interface DoctorCheck {
  id: DoctorCheckId;
  status: DoctorCheckStatus;
  summary: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  tracker: string | null;
  runtime: string | null;
  checks: DoctorCheck[];
}

interface RuntimeInspection {
  check: DoctorCheck;
  optionsParsed: boolean;
  executableOverride?: string;
}

export async function runDoctor(workflowPath: string): Promise<DoctorReport> {
  let workflow: WorkflowDefinition;
  try {
    workflow = await loadWorkflow(workflowPath);
  } catch {
    return report(null, null, [
      check("workflow.config", "error", "workflow configuration is invalid"),
      check("tracker.config", "warning", "tracker configuration was not checked"),
      check("runtime.options", "warning", "runtime options were not checked"),
      check("runtime.executable", "warning", "runtime executable was not checked"),
      check("runtime.auth", "warning", "runtime authentication was not checked"),
      check("workspace.root", "warning", "workspace root was not checked"),
      check("state.store", "warning", "durable state was not checked"),
    ]);
  }

  const runtimeInspection = await inspectRuntimeOptions(workflow);
  const checks = [
    check("workflow.config", "ok", "workflow configuration is valid"),
    inspectTrackerConfig(workflow),
    runtimeInspection.check,
    await inspectRuntimeExecutable(workflow.config.runtime.kind, runtimeInspection),
    check("runtime.auth", "warning", "runtime authentication was not verified"),
    await inspectWorkspace(workflow),
    await inspectState(workflow),
  ];
  return report(workflow.config.tracker.kind, workflow.config.runtime.kind, checks);
}

function inspectTrackerConfig(workflow: WorkflowDefinition): DoctorCheck {
  try {
    validateTrackerProvider(workflow.config.tracker.kind, workflow.config.tracker.provider);
    if (workflow.config.delivery?.kind === "github_pr" && process.platform === "win32") throw new Error();
    return check("tracker.config", "ok", "tracker configuration is locally usable");
  } catch {
    return check("tracker.config", "error", "tracker configuration is not locally usable");
  }
}

async function inspectRuntimeOptions(workflow: WorkflowDefinition): Promise<RuntimeInspection> {
  if (workflow.config.runtime.kind === "claude") {
    try {
      const options = parseClaudeRuntimeOptions(workflow.config.runtime.options);
      return {
        check: check("runtime.options", "ok", "runtime options are valid"),
        optionsParsed: true,
        ...(options.claude_executable === undefined ? {} : { executableOverride: options.claude_executable }),
      };
    } catch {
      return {
        check: check("runtime.options", "error", "runtime options are invalid"),
        optionsParsed: false,
      };
    }
  }

  let executableOverride: string | undefined;
  try {
    executableOverride = parseCodexRuntimeOptions(workflow.config.runtime.options).codex_executable;
  } catch {
    return {
      check: check("runtime.options", "error", "runtime options are invalid"),
      optionsParsed: false,
    };
  }

  try {
    await resolveSafeCodexHome(process.env.CODEX_HOME);
    return {
      check: check("runtime.options", "ok", "runtime options are valid"),
      optionsParsed: true,
      ...(executableOverride === undefined ? {} : { executableOverride }),
    };
  } catch {
    return {
      check: check("runtime.options", "error", "runtime configuration is not locally usable"),
      optionsParsed: true,
      ...(executableOverride === undefined ? {} : { executableOverride }),
    };
  }
}

async function inspectRuntimeExecutable(
  runtimeKind: WorkflowDefinition["config"]["runtime"]["kind"],
  inspection: RuntimeInspection,
): Promise<DoctorCheck> {
  if (!inspection.optionsParsed) {
    return check("runtime.executable", "warning", "runtime executable was not checked");
  }

  try {
    if (inspection.executableOverride !== undefined) {
      await inspectConfiguredExecutable(inspection.executableOverride);
    } else if (runtimeKind === "claude") {
      await inspectDefaultClaudeExecutable();
    } else {
      await inspectDefaultCodexExecutable();
    }
    return check("runtime.executable", "ok", "runtime executable is available");
  } catch {
    return check("runtime.executable", "error", "runtime executable is unavailable");
  }
}

async function inspectConfiguredExecutable(candidate: string): Promise<void> {
  for (const executable of configuredExecutableCandidates(candidate, process.platform, process.env.PATH)) {
    try {
      await requireExecutable(executable);
      return;
    } catch {
      // Try the next local PATH candidate without exposing it in the report.
    }
  }
  throw new Error("Configured executable is unavailable");
}

export function configuredExecutableCandidates(
  candidate: string,
  platform: NodeJS.Platform,
  searchPath: string | undefined,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? windowsExecutableNames(candidate) : [candidate];
  if (names.length === 0) return [];
  if (pathApi.isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")) {
    return names.map((name) => pathApi.resolve(name));
  }
  return (searchPath ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => pathApi.join(directory, name)));
}

function windowsExecutableNames(candidate: string): string[] {
  const extension = path.win32.extname(candidate).toLowerCase();
  if (extension === ".exe" || extension === ".com") return [candidate];
  return extension === "" ? [`${candidate}.COM`, `${candidate}.EXE`] : [];
}

async function inspectDefaultClaudeExecutable(): Promise<void> {
  const sdkRequire = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const platformPackages = process.platform === "linux"
    ? [
        `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
        `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
      ]
    : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`];
  for (const packageName of platformPackages) {
    try {
      await requireExecutable(sdkRequire.resolve(`${packageName}/claude${suffix}`));
      return;
    } catch {
      // The SDK supports a fallback Linux libc package; try every local candidate.
    }
  }
  throw new Error("Bundled Claude executable is unavailable");
}

async function inspectDefaultCodexExecutable(): Promise<void> {
  await requireExecutable(codexWrapperPath);

  const target = codexTarget();
  const packageJson = fileURLToPath(import.meta.resolve(`${target.packageName}/package.json`));
  await requireExecutable(
    path.join(
      path.dirname(packageJson),
      "vendor",
      target.triple,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    ),
  );
}

function codexTarget(): { packageName: string; triple: string } {
  if ((process.platform === "linux" || process.platform === "android") && process.arch === "x64") {
    return { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" };
  }
  if ((process.platform === "linux" || process.platform === "android") && process.arch === "arm64") {
    return { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
  }
  throw new Error("Codex is unavailable on this platform");
}

async function requireExecutable(candidate: string): Promise<void> {
  const info = await stat(candidate);
  if (!info.isFile()) throw new Error("Executable is not a regular file");
  await access(candidate, fsConstants.X_OK);
}

async function inspectWorkspace(workflow: WorkflowDefinition): Promise<DoctorCheck> {
  try {
    const result = await inspectWorkspaceRoot(workflow.config.workspace.root);
    return result === "valid"
      ? check("workspace.root", "ok", "workspace root is locally usable")
      : check("workspace.root", "warning", "workspace root does not exist yet");
  } catch {
    return check("workspace.root", "error", "workspace root is not locally usable");
  }
}

async function inspectState(workflow: WorkflowDefinition): Promise<DoctorCheck> {
  if (workflow.config.state === undefined) {
    return check("state.store", "ok", "durable state is disabled");
  }
  try {
    const result = await new RunStateStore(
      workflow.config.state.path,
      workflowScopeHash(workflow),
    ).inspect();
    return result === "valid"
      ? check("state.store", "ok", "durable state is valid")
      : check("state.store", "warning", "durable state does not exist yet");
  } catch {
    return check("state.store", "error", "durable state is not locally usable");
  }
}

function check(id: DoctorCheckId, status: DoctorCheckStatus, summary: string): DoctorCheck {
  return { id, status, summary };
}

function report(tracker: string | null, runtime: string | null, checks: DoctorCheck[]): DoctorReport {
  return {
    schemaVersion: 1,
    ok: !checks.some(({ status }) => status === "error"),
    tracker,
    runtime,
    checks,
  };
}
