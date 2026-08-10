import Fastify, { type FastifyInstance } from "fastify";
import type { OrchestratorSnapshot } from "../orchestrator.js";

export function createOperationsServer(
  snapshot: () => OrchestratorSnapshot,
  isReady: () => boolean,
  requestRefresh?: () => void,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_024, requestTimeout: 5_000 });

  app.addHook("onSend", (_request, reply, payload, done) => {
    reply.header("cache-control", "no-store");
    done(null, payload);
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ status: "error" }));
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0];
    const allowed = path === "/api/v1/refresh"
      ? "POST"
      : path === "/healthz" ||
          path === "/readyz" ||
          path === "/status" ||
          path === "/api/v1/state" ||
          /^\/api\/v1\/[^/]+$/u.test(path ?? "")
        ? "GET"
        : undefined;
    if (allowed !== undefined && request.method !== allowed) {
      return reply
        .header("allow", allowed)
        .code(405)
        .send(errorPayload("method_not_allowed", "Method not allowed"));
    }
    return reply.code(404).send(errorPayload("not_found", "Route not found"));
  });

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
  app.get("/api/v1/state", () => {
    const current = snapshot();
    return {
      generatedAt: new Date().toISOString(),
      startedAt: current.startedAt,
      lastPollAt: current.lastPollAt,
      counts: {
        running: current.running.length,
        retrying: current.retrying.length,
        blocked: current.blocked.length,
      },
      running: current.running.map(runningPayload),
      retrying: current.retrying.map(retryPayload),
      blocked: current.blocked.map(blockedPayload),
      totals: current.totals,
    };
  });
  app.get<{ Params: { issue_identifier: string } }>("/api/v1/:issue_identifier", (request, reply) => {
    const current = snapshot();
    const identifier = request.params.issue_identifier;
    const running = current.running.find((entry) => entry.identifier === identifier);
    if (running !== undefined) return { status: "running", ...runningPayload(running) };
    const retrying = current.retrying.find((entry) => entry.identifier === identifier);
    if (retrying !== undefined) return { status: "retrying", ...retryPayload(retrying) };
    const blocked = current.blocked.find((entry) => entry.identifier === identifier);
    if (blocked !== undefined) return { status: "blocked", ...blockedPayload(blocked) };
    return reply.code(404).send(errorPayload("issue_not_found", "Issue not found"));
  });
  app.get("/api/v1/refresh", (_request, reply) =>
    reply
      .header("allow", "POST")
      .code(405)
      .send(errorPayload("method_not_allowed", "Method not allowed")));
  app.post("/api/v1/refresh", (_request, reply) => {
    if (!isReady() || requestRefresh === undefined) {
      return reply
        .code(503)
        .send(errorPayload("orchestrator_unavailable", "Orchestrator is unavailable"));
    }
    requestRefresh();
    reply.code(202);
    return { queued: true };
  });

  return app;
}

function runningPayload(entry: OrchestratorSnapshot["running"][number]) {
  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    issueUrl: entry.issueUrl,
    state: entry.state,
    attempt: entry.attempt,
    continuation: entry.continuation,
    turnCount: entry.turnCount,
    startedAt: entry.startedAt,
    lastActivityAt: entry.lastActivityAt,
    secondsRunning: entry.secondsRunning,
    usage: entry.usage,
    lastEvent: entry.lastEvent,
  };
}

function retryPayload(entry: OrchestratorSnapshot["retrying"][number]) {
  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    issueUrl: entry.issueUrl,
    attempt: entry.attempt,
    dueAt: entry.dueAt,
    reason: entry.reason,
  };
}

function blockedPayload(entry: OrchestratorSnapshot["blocked"][number]) {
  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    issueUrl: entry.issueUrl,
    blockedAt: entry.blockedAt,
  };
}

function errorPayload(code: string, message: string) {
  return { error: { code, message } };
}
