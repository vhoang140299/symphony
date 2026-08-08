#!/usr/bin/env node

import path from "node:path";
import { WorkflowStore } from "./config/store.js";
import { createLogger } from "./log.js";
import { Orchestrator } from "./orchestrator.js";

async function main(args: string[]): Promise<void> {
  const usage = "Usage: symphony-node [--once] [path-to-WORKFLOW.md]";
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const once = args[0] === "--once";
  const positionalArgs = once ? args.slice(1) : args;
  if (positionalArgs.length > 1 || positionalArgs[0]?.startsWith("-")) {
    throw new Error(usage);
  }

  const workflowPath = path.resolve(positionalArgs[0] ?? "WORKFLOW.md");
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
