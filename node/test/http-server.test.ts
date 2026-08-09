import assert from "node:assert/strict";
import { test } from "vitest";
import { createOperationsServer } from "../src/http/server.js";
import type { OrchestratorSnapshot } from "../src/orchestrator.js";

test("operations endpoints expose health and aggregate status without run details", async () => {
  let ready = false;
  const snapshot: OrchestratorSnapshot = {
    startedAt: "2026-08-09T01:00:00.000Z",
    lastPollAt: "2026-08-09T01:01:00.000Z",
    running: [
      {
        issueId: "secret-issue-id",
        identifier: "SECRET-1",
        state: "Todo",
        attempt: 1,
        continuation: 0,
        startedAt: "2026-08-09T01:00:10.000Z",
        lastActivityAt: "2026-08-09T01:00:20.000Z",
        sessionId: "secret-session",
        workspacePath: "/secret/workspace",
      },
    ],
    retrying: [
      {
        issueId: "retry-issue-id",
        identifier: "RETRY-1",
        attempt: 2,
        dueAt: "2026-08-09T01:02:00.000Z",
        reason: "failure",
      },
    ],
    blocked: [
      {
        issueId: "blocked-issue-id",
        identifier: "BLOCKED-1",
        blockedAt: "2026-08-09T01:00:30.000Z",
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
    },
    latestRateLimits: { secret: "provider detail" },
  };
  const server = createOperationsServer(() => snapshot, () => ready);

  try {
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
  );

  try {
    const response = await server.inject({ method: "GET", url: "/status" });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { status: "error" });
    assert.doesNotMatch(response.body, /secret|snapshot detail/iu);
  } finally {
    await server.close();
  }
});
