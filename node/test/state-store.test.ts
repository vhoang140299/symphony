import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { RunStateStore, type PersistedClaim } from "../src/state/store.js";

const scope = "a".repeat(64);
const otherScope = "b".repeat(64);
const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const invalidTimestampMs = 8_640_000_000_000_001;
const completion = {
  status: "ready" as const,
  summary: "Implemented the change.",
  verification: ["pnpm test"],
};
const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("round-trips every claim variant with secure permissions", async () => {
  const { parent, filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  const claims: PersistedClaim[] = [
    { kind: "running", issueId: "running", attempt: null, continuation: 0 },
    {
      kind: "running",
      issueId: "running-delivery",
      attempt: 1,
      continuation: 2,
      pendingDelivery: { completion, idempotencyKey },
    },
    {
      kind: "retrying",
      issueId: "retry-continuation",
      attempt: 2,
      continuation: 1,
      dueAtMs: 1_234,
      reason: "continuation",
    },
    {
      kind: "retrying",
      issueId: "retry-delivery",
      attempt: 3,
      continuation: 0,
      dueAtMs: 5_678.5,
      reason: "failure",
      pendingDelivery: { completion, idempotencyKey: randomUUID() },
    },
    {
      kind: "blocked",
      issueId: "blocked",
      attempt: null,
      continuation: 4,
      blockedAtMs: 9_876.5,
      summary: "Waiting for operator input.",
    },
  ];

  assert.deepEqual(await store.load(), []);
  await store.save(claims);
  assert.deepEqual(await store.load(), claims);
  assert.equal((await lstat(parent)).mode & 0o7777, 0o700);
  assert.equal((await lstat(filePath)).mode & 0o7777, 0o600);

  const envelope = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope), ["version", "scope", "claims"]);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.scope, scope);
});

posixTest("serializes concurrent saves so the last call wins", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  const saves = Array.from({ length: 20 }, (_, index) => {
    const claims: PersistedClaim[] = [
      { kind: "running", issueId: `issue-${index}`, attempt: index, continuation: 0 },
    ];
    return store.save(claims);
  });

  await Promise.all(saves);
  assert.deepEqual(await store.load(), [
    { kind: "running", issueId: "issue-19", attempt: 19, continuation: 0 },
  ]);
});

posixTest("rejects corrupt, incompatible, cross-scope, and duplicate state", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  assert.deepEqual(await store.load(), []);
  const claim = { kind: "running", issueId: "issue-1", attempt: null, continuation: 0 };
  const blockedDeliveryClaim = {
    ...claim,
    pendingDelivery: {
      completion: { ...completion, status: "blocked" },
      idempotencyKey,
    },
  };
  const invalidContents = [
    "{",
    JSON.stringify({ version: 2, scope, claims: [] }),
    JSON.stringify({ version: 1, scope: otherScope, claims: [] }),
    JSON.stringify({ version: 1, scope, claims: [claim, claim] }),
    JSON.stringify({ version: 1, scope, claims: [blockedDeliveryClaim] }),
    JSON.stringify({
      version: 1,
      scope,
      claims: [{ kind: "retrying", issueId: "retry", attempt: 0, continuation: 0, dueAtMs: invalidTimestampMs, reason: "failure" }],
    }),
    JSON.stringify({
      version: 1,
      scope,
      claims: [{ kind: "blocked", issueId: "blocked", attempt: null, continuation: 0, blockedAtMs: invalidTimestampMs, summary: "waiting" }],
    }),
    JSON.stringify({ version: 1, scope, claims: [], extra: true }),
  ];

  for (const contents of invalidContents) {
    await writeFile(filePath, contents, { mode: 0o600 });
    await assert.rejects(store.load());
    await assert.rejects(store.save([]));
  }
});

posixTest("rejects symlinks, unsafe permissions, canonical aliases, and oversized state", async () => {
  const { root, parent, filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  assert.deepEqual(await store.load(), []);
  const validEnvelope = JSON.stringify({ version: 1, scope, claims: [] });
  const target = path.join(parent, "target.json");
  await writeFile(target, validEnvelope, { mode: 0o600 });
  await symlink(target, filePath);
  await assert.rejects(store.load(), /regular file/);
  await assert.rejects(store.save([]), /regular file/);

  await unlink(filePath);
  await writeFile(filePath, validEnvelope, { mode: 0o600 });
  await chmod(filePath, 0o644);
  await assert.rejects(store.load(), /0600/);

  await unlink(filePath);
  await writeFile(filePath, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(store.load(), /1 MiB/);

  const largeClaims: PersistedClaim[] = Array.from({ length: 600 }, (_, index) => ({
    kind: "blocked",
    issueId: `large-${index}`,
    attempt: null,
    continuation: 0,
    blockedAtMs: 0,
    summary: "x".repeat(2_000),
  }));
  await assert.rejects(new RunStateStore(path.join(parent, "large.json"), scope).save(largeClaims), /1 MiB/);

  const realParent = path.join(root, "real-parent");
  const aliasParent = path.join(root, "alias-parent");
  await mkdir(realParent, { mode: 0o700 });
  await symlink(realParent, aliasParent);
  await assert.rejects(new RunStateStore(path.join(aliasParent, "state.json"), scope).load(), /real directory|canonical/);

  const unsafeParent = path.join(root, "unsafe-parent");
  await mkdir(unsafeParent, { mode: 0o700 });
  await chmod(unsafeParent, 0o755);
  await assert.rejects(new RunStateStore(path.join(unsafeParent, "state.json"), scope).load(), /0700/);
});

posixTest("validates claim bounds, delivery UUIDs, and completion payloads", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  const valid = { kind: "running", issueId: "issue", attempt: null, continuation: 0 };
  const invalidClaims: unknown[] = [
    { ...valid, issueId: "" },
    { ...valid, issueId: "   " },
    { ...valid, issueId: "x".repeat(257) },
    { ...valid, attempt: -1 },
    { ...valid, attempt: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, continuation: 0.5 },
    { ...valid, continuation: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, pendingDelivery: { completion, idempotencyKey: "not-a-uuid" } },
    {
      ...valid,
      pendingDelivery: { completion: { ...completion, status: "blocked" }, idempotencyKey },
    },
    {
      ...valid,
      pendingDelivery: {
        completion: { ...completion, summary: "x".repeat(2_001) },
        idempotencyKey,
      },
    },
    { kind: "retrying", issueId: "retry", attempt: null, continuation: 0, dueAtMs: 0, reason: "failure" },
    { kind: "retrying", issueId: "retry", attempt: 0, continuation: 0, dueAtMs: invalidTimestampMs, reason: "failure" },
    { kind: "blocked", issueId: "blocked", attempt: null, continuation: 0, blockedAtMs: invalidTimestampMs, summary: "waiting" },
    { kind: "blocked", issueId: "blocked", attempt: null, continuation: 0, blockedAtMs: 0, summary: "x".repeat(2_001) },
  ];

  for (const claim of invalidClaims) {
    await assert.rejects(store.save([claim as PersistedClaim]), /invalid shape/);
  }
  await assert.rejects(store.save([valid, valid] as PersistedClaim[]), /duplicate issue id/);
  assert.throws(() => new RunStateStore(filePath, "A".repeat(64)), /SHA-256/);
});

posixTest("rejects fields that could persist runtime secrets", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  const unsafe = {
    kind: "running",
    issueId: "issue",
    attempt: null,
    continuation: 0,
    prompt: "secret prompt",
    token: "secret token",
    providerConfig: { token: "nested token" },
    workspacePath: "/private/workspace",
    rawEvent: { private: true },
    sessionId: "private-session",
  } as unknown as PersistedClaim;

  await assert.rejects(store.save([unsafe]), /invalid shape/);
  await assert.rejects(access(filePath), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");

  await store.save([{ kind: "running", issueId: "issue", attempt: null, continuation: 0 }]);
  const contents = await readFile(filePath, "utf8");
  for (const field of ["prompt", "token", "providerConfig", "workspacePath", "rawEvent", "sessionId"]) {
    assert.doesNotMatch(contents, new RegExp(`"${field}"`, "u"));
  }
});

async function fixture(): Promise<{ root: string; parent: string; filePath: string }> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "symphony-state-store-"));
  const root = await realpath(temporaryRoot);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "state");
  return { root, parent, filePath: path.join(parent, "runs.json") };
}
