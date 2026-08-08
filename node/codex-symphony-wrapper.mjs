#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [subcommand, ...args] = process.argv.slice(2);
if (subcommand !== "exec") {
  process.stderr.write("Symphony Codex wrapper only supports codex exec\n");
  process.exit(2);
}

const environment = { ...process.env };
const executableOverride = environment.SYMPHONY_CODEX_REAL_EXECUTABLE;
delete environment.SYMPHONY_CODEX_REAL_EXECUTABLE;

const codexArgs = [
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
  ...args,
];
const launcher = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
const command = executableOverride ?? process.execPath;
const commandArgs = executableOverride === undefined ? [launcher, ...codexArgs] : codexArgs;
const detached = process.platform !== "win32";
let child;
let killTimer;
let pendingSignal;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => requestStop(signal));
}

child = spawn(command, commandArgs, { stdio: "inherit", env: environment, detached });
child.once("error", () => {
  process.stderr.write("Symphony could not start the Codex executable\n");
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (killTimer !== undefined) clearTimeout(killTimer);
  process.exitCode = code ?? signalExitCode(signal);
});
if (pendingSignal !== undefined) requestStop(pendingSignal);

function requestStop(signal) {
  pendingSignal ??= signal;
  if (child === undefined) return;
  signalChild(pendingSignal);
  killTimer ??= setTimeout(() => signalChild("SIGKILL"), 250);
}

function signalChild(signal) {
  try {
    if (child === undefined) return;
    if (detached && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The child already exited.
  }
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
}
