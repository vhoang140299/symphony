import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { OrchestratorSnapshot } from "../orchestrator.js";

const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const hashedAssetPattern = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/u;

export function createOperationsServer(
  snapshot: () => OrchestratorSnapshot,
  isReady: () => boolean,
  requestRefresh?: () => void,
  retryBlocked?: (issueIdentifier: string) => Promise<boolean>,
  listenerHost = "127.0.0.1",
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_024, requestTimeout: 5_000 });
  const dashboardRoot = resolveDashboardRoot();
  const configuredHost = normalizeHostname(listenerHost);

  app.addHook("onRequest", (request, reply, done) => {
    const authority = parseAuthority(request.headers.host);
    const localHost = normalizeHostname(request.raw.socket.localAddress);
    const allowedHosts = new Set(
      [configuredHost, localHost].filter((host): host is string => host !== undefined && !isWildcard(host)),
    );
    if ([...allowedHosts].some(isLoopback)) {
      allowedHosts.add("localhost").add("127.0.0.1").add("::1");
    }
    if (authority === undefined || !allowedHosts.has(authority.hostname)) {
      void reply.code(403).send(errorPayload("forbidden", "Request not allowed"));
      return;
    }
    done();
  });

  app.addHook("onSend", (_request, reply, payload, done) => {
    reply
      .header("cache-control", "no-store")
      .header("content-security-policy", contentSecurityPolicy)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
    done(null, payload);
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ status: "error" }));
  app.setNotFoundHandler((request, reply) => {
    const requestPath = request.url.split("?", 1)[0];
    const allowed = requestPath === "/api/v1/refresh" || /^\/api\/v1\/[^/]+\/retry$/u.test(requestPath ?? "")
      ? "POST"
      : requestPath === "/" ||
          requestPath === "/assets" ||
          requestPath?.startsWith("/assets/") === true ||
          requestPath === "/healthz" ||
          requestPath === "/readyz" ||
          requestPath === "/status" ||
          requestPath === "/api/v1/state" ||
          /^\/api\/v1\/[^/]+$/u.test(requestPath ?? "")
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

  app.get("/", (_request, reply) =>
    sendDashboardFile(reply, path.join(dashboardRoot, "index.html"), "text/html; charset=utf-8"));
  app.get<{ Params: { file: string } }>("/assets/:file", (request, reply) => {
    const file = request.params.file;
    if (file === "licenses.md") {
      return sendDashboardFile(reply, path.join(dashboardRoot, "assets", file), "text/markdown; charset=utf-8");
    }
    const match = hashedAssetPattern.exec(file);
    if (match === null) return reply.code(404).send(errorPayload("not_found", "Route not found"));
    const contentType = match[1] === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    return sendDashboardFile(reply, path.join(dashboardRoot, "assets", file), contentType);
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
  app.post("/api/v1/refresh", (request, reply) => {
    if (!isTrustedOperation(request.headers.host, request.headers.origin, request.headers["x-symphony-operation"])) {
      return reply.code(403).send(errorPayload("forbidden", "Request not allowed"));
    }
    if (!isReady() || requestRefresh === undefined) {
      return reply
        .code(503)
        .send(errorPayload("orchestrator_unavailable", "Orchestrator is unavailable"));
    }
    requestRefresh();
    reply.code(202);
    return { queued: true };
  });
  app.post<{ Params: { issue_identifier: string } }>(
    "/api/v1/:issue_identifier/retry",
    async (request, reply) => {
      if (!isTrustedOperation(request.headers.host, request.headers.origin, request.headers["x-symphony-operation"])) {
        return reply.code(403).send(errorPayload("forbidden", "Request not allowed"));
      }
      if (!isReady() || retryBlocked === undefined) {
        return reply
          .code(503)
          .send(errorPayload("orchestrator_unavailable", "Orchestrator is unavailable"));
      }
      if (!(await retryBlocked(request.params.issue_identifier))) {
        return reply.code(404).send(errorPayload("issue_not_found", "Issue not found"));
      }
      reply.code(202);
      return { queued: true };
    },
  );

  return app;
}

function isTrustedOperation(
  host: string | undefined,
  origin: string | undefined,
  operation: string | string[] | undefined,
) {
  if (operation !== "1") return false;
  if (origin === undefined) return true;
  const match = /^(?:https?):\/\/([^/?#]+)$/iu.exec(origin);
  const requestAuthority = parseAuthority(host);
  const originAuthority = parseAuthority(match?.[1]);
  return requestAuthority !== undefined && originAuthority?.authority === requestAuthority.authority;
}

function parseAuthority(value: string | undefined): { authority: string; hostname: string } | undefined {
  if (value === undefined || value.length === 0 || value.trim() !== value) return undefined;
  try {
    const parsed = new URL(`symphony://${value}`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "" || parsed.search !== "" || parsed.hash !== "") {
      return undefined;
    }
    return { authority: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "") };
  } catch {
    return undefined;
  }
}

function normalizeHostname(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const mapped = /^::ffff:(.+)$/iu.exec(value)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  const host = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
  return parseAuthority(host)?.hostname;
}

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
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
    reasonCode: entry.reasonCode,
  };
}

function errorPayload(code: string, message: string) {
  return { error: { code, message } };
}

async function sendDashboardFile(reply: FastifyReply, filePath: string, contentType: string) {
  try {
    const contents = await readFile(filePath);
    return reply.type(contentType).send(contents);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return reply.code(404).send(errorPayload("not_found", "Route not found"));
    }
    throw error;
  }
}

function resolveDashboardRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const relativeRoot = path.extname(modulePath) === ".ts" ? "../../dist/dashboard" : "../../dashboard";
  return path.resolve(path.dirname(modulePath), relativeRoot);
}
