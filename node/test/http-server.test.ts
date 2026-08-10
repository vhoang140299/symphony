import assert from "node:assert/strict";
import { test } from "vitest";
import { createOperationsServer } from "../src/http/server.js";
import type { OrchestratorSnapshot } from "../src/orchestrator.js";

const operationHeaders = { "x-symphony-operation": "1" };

test("operations endpoints expose health and aggregate status without run details", async () => {
  let ready = false;
  let refreshes = 0;
  const retryRequests: string[] = [];
  const snapshot: OrchestratorSnapshot = {
    startedAt: "2026-08-09T01:00:00.000Z",
    lastPollAt: "2026-08-09T01:01:00.000Z",
    running: [
      {
        issueId: "secret-issue-id",
        identifier: "acme/widget#7",
        issueUrl: "https://github.example/acme/widget/issues/7",
        state: "Todo",
        attempt: 1,
        continuation: 0,
        turnCount: 2,
        startedAt: "2026-08-09T01:00:10.000Z",
        lastActivityAt: "2026-08-09T01:00:20.000Z",
        secondsRunning: 50,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          totalTokens: 18,
          costUsd: 0.01,
        },
        lastEvent: "activity",
        sessionId: "secret-session",
        workspacePath: "/secret/workspace",
      },
    ],
    retrying: [
      {
        issueId: "retry-issue-id",
        identifier: "RETRY-1",
        issueUrl: "https://tracker.example/issues/RETRY-1",
        attempt: 2,
        dueAt: "2026-08-09T01:02:00.000Z",
        reason: "failure",
      },
    ],
    blocked: [
      {
        issueId: "blocked-issue-id",
        identifier: "BLOCKED-1",
        issueUrl: "https://tracker.example/issues/BLOCKED-1",
        blockedAt: "2026-08-09T01:00:30.000Z",
        reasonCode: "operator_action_required",
        summary: "secret summary",
      },
    ],
    totals: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      totalTokens: 18,
      costUsd: 0.01,
      secondsRunning: 60,
    },
    latestRateLimits: {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.82,
      resetsAt: 1_786_268_400,
      overageDisabledReason: "secret overage reason",
      creditBalance: "secret account balance",
      secret: "provider detail",
    } as unknown as OrchestratorSnapshot["latestRateLimits"],
  };
  const server = createOperationsServer(
    () => snapshot,
    () => ready,
    () => {
      refreshes += 1;
    },
    async (identifier) => {
      retryRequests.push(identifier);
      return identifier === "BLOCKED-1";
    },
  );

  try {
    const dashboard = await server.inject({ method: "GET", url: "/" });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.headers["content-type"] ?? "", /^text\/html; charset=utf-8/iu);
    assert.equal(dashboard.headers["cache-control"], "no-store");
    assert.equal(
      dashboard.headers["content-security-policy"],
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    assert.equal(dashboard.headers["x-content-type-options"], "nosniff");
    assert.equal(dashboard.headers["referrer-policy"], "no-referrer");
    assert.match(dashboard.body, /<div id="root"><\/div>/u);
    assert.doesNotMatch(
      dashboard.body,
      /secret-issue-id|secret-session|secret summary|\/secret\/workspace|provider detail/iu,
    );

    const assetPaths = [...dashboard.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]);
    assert.ok(assetPaths.some((assetPath) => assetPath.endsWith(".js")));
    assert.ok(assetPaths.some((assetPath) => assetPath.endsWith(".css")));
    for (const assetPath of assetPaths) {
      assert.match(assetPath, /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/u);
      const asset = await server.inject({ method: "GET", url: assetPath });
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.headers["cache-control"], "no-store");
      assert.equal(asset.headers["content-security-policy"], dashboard.headers["content-security-policy"]);
      assert.equal(asset.headers["x-content-type-options"], "nosniff");
      assert.equal(asset.headers["referrer-policy"], "no-referrer");
      assert.match(asset.headers["content-type"] ?? "", assetPath.endsWith(".js") ? /javascript/iu : /^text\/css/iu);
      if (assetPath.endsWith(".js")) {
        assert.match(asset.body, /Model quota/iu);
        assert.match(asset.body, /Unavailable/iu);
      }
      assert.doesNotMatch(
        asset.body,
        /secret-issue-id|secret-session|secret summary|\/secret\/workspace|provider detail/iu,
      );
    }
    const assetPath = assetPaths[0] ?? assert.fail("dashboard must reference at least one built asset");

    const licenses = await server.inject({ method: "GET", url: "/assets/licenses.md" });
    assert.equal(licenses.statusCode, 200);
    assert.match(licenses.headers["content-type"] ?? "", /^text\/markdown; charset=utf-8/iu);
    assert.equal(licenses.headers["cache-control"], "no-store");
    assert.equal(licenses.headers["content-security-policy"], dashboard.headers["content-security-policy"]);
    assert.equal(licenses.headers["x-content-type-options"], "nosniff");
    assert.equal(licenses.headers["referrer-policy"], "no-referrer");
    assert.ok(licenses.body.length > 0);
    assert.doesNotMatch(
      licenses.body,
      /secret-issue-id|secret-session|secret summary|\/secret\/workspace|provider detail/iu,
    );

    const health = await server.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["cache-control"], "no-store");
    assert.deepEqual(health.json(), { status: "ok" });

    const unavailable = await server.inject({ method: "GET", url: "/readyz" });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { status: "not_ready" });

    ready = true;
    const available = await server.inject({ method: "GET", url: "/readyz" });
    assert.equal(available.statusCode, 200);
    assert.equal(available.headers["cache-control"], "no-store");
    assert.deepEqual(available.json(), { status: "ready" });

    const status = await server.inject({ method: "GET", url: "/status" });
    assert.equal(status.statusCode, 200);
    assert.equal(status.headers["cache-control"], "no-store");
    assert.deepEqual(status.json(), {
      startedAt: "2026-08-09T01:00:00.000Z",
      lastPollAt: "2026-08-09T01:01:00.000Z",
      running: 1,
      retrying: 1,
      blocked: 1,
      totals: snapshot.totals,
    });
    assert.doesNotMatch(status.body, /SECRET|secret|workspace|session|rate/i);

    const state = await server.inject({ method: "GET", url: "/api/v1/state" });
    assert.equal(state.statusCode, 200);
    assert.equal(state.headers["cache-control"], "no-store");
    const stateBody = state.json();
    assert.equal(typeof stateBody.generatedAt, "string");
    assert.equal(Number.isNaN(Date.parse(stateBody.generatedAt)), false);
    delete stateBody.generatedAt;
    assert.deepEqual(stateBody, {
      startedAt: "2026-08-09T01:00:00.000Z",
      lastPollAt: "2026-08-09T01:01:00.000Z",
      counts: { running: 1, retrying: 1, blocked: 1 },
      running: [
        {
          issueId: "secret-issue-id",
          identifier: "acme/widget#7",
          issueUrl: "https://github.example/acme/widget/issues/7",
          state: "Todo",
          attempt: 1,
          continuation: 0,
          turnCount: 2,
          startedAt: "2026-08-09T01:00:10.000Z",
          lastActivityAt: "2026-08-09T01:00:20.000Z",
          secondsRunning: 50,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
            totalTokens: 18,
            costUsd: 0.01,
          },
          lastEvent: "activity",
        },
      ],
      retrying: [
        {
          issueId: "retry-issue-id",
          identifier: "RETRY-1",
          issueUrl: "https://tracker.example/issues/RETRY-1",
          attempt: 2,
          dueAt: "2026-08-09T01:02:00.000Z",
          reason: "failure",
        },
      ],
      blocked: [
        {
          issueId: "blocked-issue-id",
          identifier: "BLOCKED-1",
          issueUrl: "https://tracker.example/issues/BLOCKED-1",
          blockedAt: "2026-08-09T01:00:30.000Z",
          reasonCode: "operator_action_required",
        },
      ],
      totals: snapshot.totals,
      rateLimit: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.82,
      },
    });
    assert.doesNotMatch(
      state.body,
      /secret-session|secret summary|\/secret\/workspace|provider detail|resetsAt|overageDisabledReason|account balance|creditBalance/iu,
    );

    snapshot.latestRateLimits = null;
    const stateWithoutRateLimit = await server.inject({ method: "GET", url: "/api/v1/state" });
    assert.equal(stateWithoutRateLimit.statusCode, 200);
    assert.equal(stateWithoutRateLimit.json().rateLimit, null);

    snapshot.latestRateLimits = {
      status: "secret-status",
      rateLimitType: "secret-window",
      utilization: 7,
      secret: "private malformed rate limit",
    } as unknown as OrchestratorSnapshot["latestRateLimits"];
    const stateWithMalformedRateLimit = await server.inject({ method: "GET", url: "/api/v1/state" });
    assert.equal(stateWithMalformedRateLimit.statusCode, 200);
    assert.equal(stateWithMalformedRateLimit.json().rateLimit, null);
    assert.doesNotMatch(stateWithMalformedRateLimit.body, /secret-status|secret-window|private malformed/iu);

    for (const [identifier, status, row] of [
      ["acme/widget#7", "running", stateBody.running[0]],
      ["RETRY-1", "retrying", stateBody.retrying[0]],
      ["BLOCKED-1", "blocked", stateBody.blocked[0]],
    ] as const) {
      const issue = await server.inject({ method: "GET", url: `/api/v1/${encodeURIComponent(identifier)}` });
      assert.equal(issue.statusCode, 200);
      assert.equal(issue.headers["cache-control"], "no-store");
      assert.deepEqual(issue.json(), { status, ...row });
      assert.doesNotMatch(issue.body, /secret-session|secret summary|\/secret\/workspace|provider detail|rateLimit/iu);
    }

    const missing = await server.inject({ method: "GET", url: "/api/v1/MISSING-1" });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { error: { code: "issue_not_found", message: "Issue not found" } });

    const retry = await server.inject({ method: "POST", url: "/api/v1/BLOCKED-1/retry", headers: operationHeaders });
    assert.equal(retry.statusCode, 202);
    assert.deepEqual(retry.json(), { queued: true });
    const retryMissing = await server.inject({
      method: "POST",
      url: "/api/v1/MISSING-1/retry",
      headers: operationHeaders,
    });
    assert.equal(retryMissing.statusCode, 404);
    assert.deepEqual(retryMissing.json(), {
      error: { code: "issue_not_found", message: "Issue not found" },
    });
    assert.deepEqual(retryRequests, ["BLOCKED-1", "MISSING-1"]);

    const refresh = await server.inject({ method: "POST", url: "/api/v1/refresh", headers: operationHeaders });
    assert.equal(refresh.statusCode, 202);
    assert.equal(refresh.headers["cache-control"], "no-store");
    assert.deepEqual(refresh.json(), { queued: true });
    assert.equal(refreshes, 1);

    for (const [method, url, allow] of [
      ["GET", "/api/v1/refresh", "POST"],
      ["GET", "/api/v1/BLOCKED-1/retry", "POST"],
      ["DELETE", "/api/v1/BLOCKED-1/retry", "POST"],
      ["POST", "/status", "GET"],
      ["POST", "/", "GET"],
      ["POST", "/assets", "GET"],
      ["POST", assetPath, "GET"],
    ] as const) {
      const response = await server.inject({ method, url });
      assert.equal(response.statusCode, 405);
      assert.equal(response.headers.allow, allow);
      assert.deepEqual(response.json(), {
        error: { code: "method_not_allowed", message: "Method not allowed" },
      });
    }

    for (const url of [
      "/assets",
      "/assets/missing-deadbeef.js",
      "/assets/../package.json",
      "/assets/%2e%2e%2findex.html",
      "/assets/%2e%2e%5cpackage.json",
      assetPath.slice("/assets".length),
      "/index.html",
      "/licenses.md",
      "/package.json",
    ]) {
      const response = await server.inject({ method: "GET", url });
      assert.equal(response.statusCode, 404, url);
      assert.deepEqual(response.json(), { error: { code: "not_found", message: "Route not found" } });
      assert.doesNotMatch(response.body, /<!doctype html|@ai-symphony|secret-session|provider detail/iu);
    }

    const unknown = await server.inject({ method: "GET", url: "/unknown" });
    assert.equal(unknown.statusCode, 404);
    assert.deepEqual(unknown.json(), { error: { code: "not_found", message: "Route not found" } });
  } finally {
    await server.close();
  }
});

test("operations server does not expose internal status errors", async () => {
  const server = createOperationsServer(
    () => {
      throw new Error("secret snapshot detail");
    },
    () => true,
    () => {
      throw new Error("secret refresh detail");
    },
    async () => {
      throw new Error("secret retry detail");
    },
  );

  try {
    for (const url of ["/status", "/api/v1/state", "/api/v1/SECRET-1"]) {
      const response = await server.inject({ method: "GET", url });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { status: "error" });
      assert.doesNotMatch(response.body, /secret|snapshot detail/iu);
    }
    const refresh = await server.inject({ method: "POST", url: "/api/v1/refresh", headers: operationHeaders });
    assert.equal(refresh.statusCode, 500);
    assert.deepEqual(refresh.json(), { status: "error" });
    assert.doesNotMatch(refresh.body, /secret|refresh detail/iu);
    const retry = await server.inject({ method: "POST", url: "/api/v1/SECRET-1/retry", headers: operationHeaders });
    assert.equal(retry.statusCode, 500);
    assert.deepEqual(retry.json(), { status: "error" });
    assert.doesNotMatch(retry.body, /secret|retry detail/iu);
  } finally {
    await server.close();
  }
});

test("refresh reports an unavailable or unready orchestrator without invoking the snapshot", async () => {
  const unavailable = createOperationsServer(
    () => assert.fail("snapshot must not be called"),
    () => true,
  );
  let ready = true;
  let refreshes = 0;
  let retries = 0;
  const server = createOperationsServer(
    () => assert.fail("snapshot must not be called"),
    () => ready,
    () => {
      refreshes += 1;
    },
    async () => {
      retries += 1;
      return true;
    },
  );

  try {
    const missingCallback = await unavailable.inject({ method: "POST", url: "/api/v1/refresh", headers: operationHeaders });
    assert.equal(missingCallback.statusCode, 503);
    const missingRetryCallback = await unavailable.inject({
      method: "POST",
      url: "/api/v1/BLOCKED-1/retry",
      headers: operationHeaders,
    });
    assert.equal(missingRetryCallback.statusCode, 503);
    ready = false;
    const response = await server.inject({ method: "POST", url: "/api/v1/refresh", headers: operationHeaders });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: { code: "orchestrator_unavailable", message: "Orchestrator is unavailable" },
    });
    assert.equal(refreshes, 0);
    const retry = await server.inject({ method: "POST", url: "/api/v1/BLOCKED-1/retry", headers: operationHeaders });
    assert.equal(retry.statusCode, 503);
    assert.deepEqual(retry.json(), {
      error: { code: "orchestrator_unavailable", message: "Orchestrator is unavailable" },
    });
    assert.equal(retries, 0);
  } finally {
    await unavailable.close();
    await server.close();
  }
});

test("operations server rejects untrusted hosts and forged control requests", async () => {
  let refreshes = 0;
  let retries = 0;
  const server = createOperationsServer(
    () => assert.fail("snapshot must not be called"),
    () => true,
    () => {
      refreshes += 1;
    },
    async () => {
      retries += 1;
      return true;
    },
  );

  try {
    const untrustedHost = await server.inject({ method: "GET", url: "/healthz", headers: { host: "evil.example" } });
    assert.equal(untrustedHost.statusCode, 403);
    assert.deepEqual(untrustedHost.json(), { error: { code: "forbidden", message: "Request not allowed" } });

    for (const headers of [
      { host: "evil.example", ...operationHeaders },
      { host: "localhost:4321" },
      { host: "localhost:4321", "x-symphony-operation": "0" },
      { host: "localhost:4321", origin: "null", ...operationHeaders },
      { host: "localhost:4321", origin: "https://evil.example", ...operationHeaders },
      { host: "localhost:4321", origin: "http://localhost:9999", ...operationHeaders },
      { host: "localhost:4321", origin: "http://localhost:4321/", ...operationHeaders },
      { host: "localhost:4321", origin: "not-an-origin", ...operationHeaders },
    ]) {
      const response = await server.inject({ method: "POST", url: "/api/v1/refresh", headers });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: { code: "forbidden", message: "Request not allowed" } });
    }
    const forgedRetry = await server.inject({
      method: "POST",
      url: "/api/v1/BLOCKED-1/retry",
      headers: { host: "localhost:4321", origin: "https://evil.example", ...operationHeaders },
    });
    assert.equal(forgedRetry.statusCode, 403);
    assert.equal(refreshes, 0);
    assert.equal(retries, 0);

    const curlRefresh = await server.inject({
      method: "POST",
      url: "/api/v1/refresh",
      headers: { host: "127.0.0.1:4321", ...operationHeaders },
    });
    assert.equal(curlRefresh.statusCode, 202);
    const browserRetry = await server.inject({
      method: "POST",
      url: "/api/v1/BLOCKED-1/retry",
      headers: { host: "localhost:4321", origin: "http://localhost:4321", ...operationHeaders },
    });
    assert.equal(browserRetry.statusCode, 202);
    assert.equal(refreshes, 1);
    assert.equal(retries, 1);
  } finally {
    await server.close();
  }
});

test("operations server trusts an explicitly configured listener host", async () => {
  const server = createOperationsServer(
    () => assert.fail("snapshot must not be called"),
    () => true,
    undefined,
    undefined,
    "192.0.2.10",
  );

  try {
    const trusted = await server.inject({ method: "GET", url: "/healthz", headers: { host: "192.0.2.10:4321" } });
    assert.equal(trusted.statusCode, 200);
    const untrusted = await server.inject({ method: "GET", url: "/healthz", headers: { host: "evil.example" } });
    assert.equal(untrusted.statusCode, 403);
  } finally {
    await server.close();
  }
});

test("operations server normalizes IPv4-mapped listener addresses", async () => {
  const server = createOperationsServer(
    () => assert.fail("snapshot must not be called"),
    () => true,
    undefined,
    undefined,
    "::FFFF:192.0.2.10",
  );

  try {
    const response = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { host: "192.0.2.10:4321" },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await server.close();
  }
});
