import Fastify, { type FastifyInstance } from "fastify";
import type { OrchestratorSnapshot } from "../orchestrator.js";

export function createOperationsServer(
  snapshot: () => OrchestratorSnapshot,
  isReady: () => boolean,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_024, requestTimeout: 5_000 });

  app.addHook("onSend", (_request, reply, payload, done) => {
    reply.header("cache-control", "no-store");
    done(null, payload);
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ status: "error" }));

  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/readyz", (_request, reply) => {
    const ready = isReady();
    reply.code(ready ? 200 : 503);
    return { status: ready ? "ready" : "not_ready" };
  });
  app.get("/status", () => {
    const current = snapshot();
    return {
      startedAt: current.startedAt,
      lastPollAt: current.lastPollAt,
      running: current.running.length,
      retrying: current.retrying.length,
      blocked: current.blocked.length,
      totals: current.totals,
    };
  });

  return app;
}
