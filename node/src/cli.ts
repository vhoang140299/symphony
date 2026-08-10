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
  const { once, preflight, doctor, httpHost: httpHostOverride, httpPort: httpPortOverride, workflowPath } = parsed;
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
  const workflowStore = new WorkflowStore(workflowPath, logger);
  const orchestrator = new Orchestrator(workflowStore, logger);
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

  const workflow = await workflowStore.initialize();
  const httpPort = httpPortOverride ?? workflow.config.server?.port;
  if (httpHostOverride !== undefined && httpPort === undefined) {
    throw new InvalidArgumentError("option '--http-host <HOST>' requires '--port', '--http-port', or server.port");
  }
  const httpHost = httpHostOverride ?? workflow.config.server?.host ?? "127.0.0.1";
  const operationsServer =
    httpPort === undefined
      ? undefined
      : createOperationsServer(
          () => orchestrator.snapshot(),
          () => orchestrator.isReady(),
          () => {
            void orchestrator.pollOnce().catch(() => undefined);
          },
          (identifier) => orchestrator.requestBlockedRetry(identifier),
          httpHost,
          (paused) => orchestrator.setDispatchPaused(paused),
        );
  let stopPromise: Promise<void> | undefined;
  const requestStop = () => {
    stopPromise ??= stopServices(operationsServer, orchestrator);
    void stopPromise.catch(() => undefined);
    return stopPromise;
  };
  const shutdown = waitForShutdownSignal((signal) => {
    logger.info({ signal }, "Shutdown requested");
    void requestStop();
  });
  let fatalError: Error | undefined;
  let boundHttpPort = httpPort;
  try {
    if (operationsServer && httpPort !== undefined) {
      await operationsServer.listen({ host: httpHost, port: httpPort });
      const address = operationsServer.server.address();
      if (address !== null && typeof address === "object") boundHttpPort = address.port;
    }
    if (stopPromise) return await stopPromise;
    await orchestrator.start();
    if (stopPromise) return await stopPromise;
    logger.info(
      {
        workflow_path: workflowPath,
        ...(boundHttpPort === undefined ? {} : { http_host: httpHost, http_port: boundHttpPort }),
      },
      "Symphony Node started",
    );

    const outcome = await Promise.race([
      shutdown.promise.then(() => ({ kind: "shutdown" }) as const),
      orchestrator.waitForFatalError().then((error) => ({ kind: "fatal", error }) as const),
    ]);
    if (outcome.kind === "fatal") {
      fatalError = outcome.error;
      await requestStop().catch(() => undefined);
    } else {
      await requestStop();
    }
  } catch (error) {
    if (stopPromise) return await stopPromise;
    await requestStop().catch(() => undefined);
    throw error;
  } finally {
    shutdown.dispose();
  }
  if (fatalError) throw new Error("Orchestrator stopped after a fatal runtime error");
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
      httpHost: string | undefined;
      httpPort: number | undefined;
      workflowPath: string;
    }
  | undefined {
  const executionModes = ["once", "preflight", "doctor"];
  const command = new Command()
    .name("symphony-node")
    .usage("[--once | --preflight | --doctor] [--port <PORT> | --http-port <PORT>] [--http-host <HOST>] [WORKFLOW]")
    .argument("[WORKFLOW]", "workflow file", "WORKFLOW.md")
    .addOption(new Option("--once", "poll once and exit").conflicts(["preflight", "doctor"]))
    .addOption(
      new Option("--preflight", "validate and inspect eligible issues without running agents")
        .conflicts(["once", "doctor"]),
    )
    .addOption(new Option("--doctor", "inspect local readiness without side effects").conflicts(["once", "preflight"]))
    .addOption(
      new Option("--port <PORT>", "serve operational HTTP endpoints in daemon mode; overrides server.port")
        .argParser(parsePort)
        .conflicts([...executionModes, "httpPort"]),
    )
    .addOption(
      new Option("--http-port <PORT>", "alias for --port")
        .argParser(parsePort)
        .conflicts([...executionModes, "port"]),
    )
    .addOption(
      new Option("--http-host <HOST>", "listen host; overrides server.host (default: 127.0.0.1)")
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
    port?: number;
  }>();
  return {
    once: options.once ?? false,
    preflight: options.preflight ?? false,
    doctor: options.doctor ?? false,
    httpHost: options.httpHost,
    httpPort: options.port ?? options.httpPort,
    workflowPath: path.resolve(String(command.processedArgs[0])),
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError("expected an integer between 0 and 65535");
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
