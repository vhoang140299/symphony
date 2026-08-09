#!/usr/bin/env node

import path from "node:path";
import { Command, Option } from "commander";
import { WorkflowStore } from "./config/store.js";
import { runDoctor } from "./doctor.js";
import { createLogger } from "./log.js";
import { Orchestrator } from "./orchestrator.js";
import { runPreflight } from "./preflight.js";

async function main(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed === undefined) return;
  const { once, preflight, doctor, workflowPath } = parsed;
  if (doctor) {
    const result = await runDoctor(workflowPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (preflight) {
    process.stdout.write(`${JSON.stringify(await runPreflight(workflowPath))}\n`);
    return;
  }
  const logger = createLogger(undefined, once ? process.stderr : undefined);
  const orchestrator = new Orchestrator(new WorkflowStore(workflowPath, logger), logger);
  if (once) {
    let completed = false;
    let interruptedSignal: NodeJS.Signals | undefined;
    let signalStop: Promise<void> | undefined;
    const handleSignal = (signal: NodeJS.Signals) => {
      if (interruptedSignal) return;
      interruptedSignal = signal;
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      logger.info({ signal }, "One-shot shutdown requested");
      const stopping = orchestrator.stop();
      signalStop = stopping;
      void stopping.catch(() => undefined);
    };
    const onSigint = () => handleSignal("SIGINT");
    const onSigterm = () => handleSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    try {
      await orchestrator.pollOnce({ failOnTrackerError: true });
      await orchestrator.waitForCurrentRuns();
      completed = interruptedSignal === undefined;
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      const snapshot = orchestrator.snapshot();
      const result = {
        running: snapshot.running.length,
        retrying: snapshot.retrying.length,
        blocked: snapshot.blocked.length,
        totals: snapshot.totals,
      };
      if (!interruptedSignal && (!completed || result.running > 0 || result.retrying > 0 || result.blocked > 0)) {
        process.exitCode = 1;
      }
      try {
        await (signalStop ?? orchestrator.stop());
      } finally {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    }
    return;
  }

  await orchestrator.start();
  logger.info({ workflow_path: workflowPath }, "Symphony Node started");

  const signal = await waitForShutdownSignal();
  logger.info({ signal }, "Shutdown requested");
  await orchestrator.stop();
}

function parseArguments(args: string[]):
  | { once: boolean; preflight: boolean; doctor: boolean; workflowPath: string }
  | undefined {
  const command = new Command()
    .name("symphony-node")
    .usage("[--once | --preflight | --doctor] [WORKFLOW]")
    .argument("[WORKFLOW]", "workflow file", "WORKFLOW.md")
    .addOption(new Option("--once", "poll once and exit").conflicts(["preflight", "doctor"]))
    .addOption(
      new Option("--preflight", "validate and inspect eligible issues without running agents")
        .conflicts(["once", "doctor"]),
    )
    .addOption(new Option("--doctor", "inspect local readiness without side effects").conflicts(["once", "preflight"]))
    .allowExcessArguments(false)
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed") return undefined;
    throw error;
  }
  const options = command.opts<{ once?: boolean; preflight?: boolean; doctor?: boolean }>();
  return {
    once: options.once ?? false,
    preflight: options.preflight ?? false,
    doctor: options.doctor ?? false,
    workflowPath: path.resolve(String(command.processedArgs[0])),
  };
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const finish = (signal: NodeJS.Signals) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(signal);
    };
    const onSigint = () => finish("SIGINT");
    const onSigterm = () => finish("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`symphony-node: ${message}\n`);
  process.exitCode = 1;
});
