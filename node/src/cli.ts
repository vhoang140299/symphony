#!/usr/bin/env node

import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { WorkflowStore } from "./config/store.js";
import { runDoctor } from "./doctor.js";
import { createOperationsServer } from "./http/server.js";
import { createLogger } from "./log.js";
import { Orchestrator } from "./orchestrator.js";
import { runPreflight } from "./preflight.js";

async function main(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed === undefined) return;
  const { once, preflight, doctor, httpHost, httpPort, workflowPath } = parsed;
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

  let operationsReady = false;
  const operationsServer =
    httpPort === undefined
      ? undefined
      : createOperationsServer(() => orchestrator.snapshot(), () => operationsReady);
  let stopPromise: Promise<void> | undefined;
  const requestStop = () => {
    operationsReady = false;
    stopPromise ??= stopServices(operationsServer, orchestrator);
    void stopPromise.catch(() => undefined);
    return stopPromise;
  };
  const shutdown = waitForShutdownSignal((signal) => {
    logger.info({ signal }, "Shutdown requested");
    void requestStop();
  });
  try {
    if (operationsServer && httpPort !== undefined) {
      await operationsServer.listen({ host: httpHost, port: httpPort });
    }
    if (stopPromise) return await stopPromise;
    await orchestrator.start();
    if (stopPromise) return await stopPromise;
    operationsReady = true;
    logger.info(
      {
        workflow_path: workflowPath,
        ...(httpPort === undefined ? {} : { http_host: httpHost, http_port: httpPort }),
      },
      "Symphony Node started",
    );

    await shutdown.promise;
    await requestStop();
  } catch (error) {
    if (stopPromise) return await stopPromise;
    await requestStop().catch(() => undefined);
    throw error;
  } finally {
    shutdown.dispose();
  }
}

async function stopServices(
  operationsServer: ReturnType<typeof createOperationsServer> | undefined,
  orchestrator: Orchestrator,
): Promise<void> {
  const results = await Promise.allSettled([operationsServer?.close(), orchestrator.stop()]);
  const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejection) throw rejection.reason;
}

function parseArguments(args: string[]):
  | {
      once: boolean;
      preflight: boolean;
      doctor: boolean;
      httpHost: string;
      httpPort: number | undefined;
      workflowPath: string;
    }
  | undefined {
  const executionModes = ["once", "preflight", "doctor"];
  const command = new Command()
    .name("symphony-node")
    .usage("[--once | --preflight | --doctor] [--http-port <PORT> [--http-host <HOST>]] [WORKFLOW]")
    .argument("[WORKFLOW]", "workflow file", "WORKFLOW.md")
    .addOption(new Option("--once", "poll once and exit").conflicts(["preflight", "doctor"]))
    .addOption(
      new Option("--preflight", "validate and inspect eligible issues without running agents")
        .conflicts(["once", "doctor"]),
    )
    .addOption(new Option("--doctor", "inspect local readiness without side effects").conflicts(["once", "preflight"]))
    .addOption(
      new Option("--http-port <PORT>", "serve operational HTTP endpoints in daemon mode")
        .argParser(parsePort)
        .conflicts(executionModes),
    )
    .addOption(
      new Option("--http-host <HOST>", "listen host (default: 127.0.0.1; requires --http-port)")
        .argParser(parseHost)
        .conflicts(executionModes),
    )
    .allowExcessArguments(false)
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed") return undefined;
    throw error;
  }
  const options = command.opts<{
    once?: boolean;
    preflight?: boolean;
    doctor?: boolean;
    httpHost?: string;
    httpPort?: number;
  }>();
  if (options.httpHost !== undefined && options.httpPort === undefined) {
    throw new InvalidArgumentError("option '--http-host <HOST>' requires option '--http-port <PORT>'");
  }
  return {
    once: options.once ?? false,
    preflight: options.preflight ?? false,
    doctor: options.doctor ?? false,
    httpHost: options.httpHost ?? "127.0.0.1",
    httpPort: options.httpPort,
    workflowPath: path.resolve(String(command.processedArgs[0])),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError("expected an integer between 1 and 65535");
  }
  return port;
}

function parseHost(value: string): string {
  const host = value.trim();
  if (host.length === 0) throw new InvalidArgumentError("expected a non-empty host");
  return host;
}

function waitForShutdownSignal(onSignal: (signal: NodeJS.Signals) => void): {
  promise: Promise<NodeJS.Signals>;
  dispose(): void;
} {
  let dispose = () => undefined;
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    const finish = (signal: NodeJS.Signals) => {
      dispose();
      onSignal(signal);
      resolve(signal);
    };
    const onSigint = () => finish("SIGINT");
    const onSigterm = () => finish("SIGTERM");
    dispose = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
  return { promise, dispose };
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`symphony-node: ${message}\n`);
  process.exitCode = 1;
});
