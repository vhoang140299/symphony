import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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
  await store.acquireLease();
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
      error: null,
    },
    {
      kind: "retrying",
      issueId: "retry-delivery",
      attempt: 3,
      continuation: 0,
      dueAtMs: 5_678.5,
      reason: "failure",
      error: "Host delivery failed",
      pendingDelivery: { completion, idempotencyKey: randomUUID() },
    },
    {
      kind: "blocked",
      issueId: "blocked",
      attempt: null,
      continuation: 4,
      blockedAtMs: 9_876.5,
      summary: "Waiting for operator input.",
      reasonCode: "operator_action_required",
    },
  ];

  assert.deepEqual(await store.load(), []);
  await store.save(claims);
  assert.deepEqual(await store.load(), claims);
  assert.equal(await store.inspect(), "valid");
  assert.equal((await lstat(parent)).mode & 0o7777, 0o700);
  assert.equal((await lstat(filePath)).mode & 0o7777, 0o600);

  const envelope = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope), ["version", "scope", "claims"]);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.scope, scope);
});

posixTest("does not rewrite unchanged state and still persists changes", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  const claim = {
    kind: "running",
    issueId: "issue",
    attempt: null,
    continuation: 0,
  } satisfies PersistedClaim;
  await store.acquireLease();
  await store.save([claim]);
  const before = await lstat(filePath);

  await store.save([claim]);
  const after = await lstat(filePath);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);

  const changed = [{ ...claim, continuation: 1 }];
  await store.save(changed);
  assert.deepEqual(await store.load(), changed);
});

posixTest("loads legacy retries without an error as null", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  await store.acquireLease();
  const legacy = {
    kind: "retrying",
    issueId: "legacy-retry",
    attempt: 1,
    continuation: 0,
    dueAtMs: 1_234,
    reason: "failure",
  } as const;
  await writeFile(filePath, `${JSON.stringify({ version: 1, scope, claims: [legacy] })}\n`, { mode: 0o600 });

  assert.deepEqual(await store.load(), [{ ...legacy, error: null }]);
});

posixTest("inspects missing state without creating its parent or file", async () => {
  const { parent, filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);

  assert.equal(await store.inspect(), "missing");
  await assert.rejects(
    access(parent),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  await assert.rejects(
    access(`${filePath}.lease`),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );

  await mkdir(parent, { mode: 0o700 });
  assert.equal(await store.inspect(), "missing");
  await assert.rejects(
    access(filePath),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
  await assert.rejects(
    access(`${filePath}.lease`),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

posixTest("serializes concurrent saves so the last call wins", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  await store.acquireLease();
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
  await store.acquireLease();
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
    await assert.rejects(store.inspect());
    await assert.rejects(store.load());
    await assert.rejects(store.save([]));
  }
});

posixTest("rejects symlinks, unsafe permissions, canonical aliases, and oversized state", async () => {
  const { root, parent, filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  await store.acquireLease();
  assert.deepEqual(await store.load(), []);
  const validEnvelope = JSON.stringify({ version: 1, scope, claims: [] });
  const target = path.join(parent, "target.json");
  await writeFile(target, validEnvelope, { mode: 0o600 });
  await symlink(target, filePath);
  await assert.rejects(store.inspect(), /regular file/);
  await assert.rejects(store.load(), /regular file/);
  await assert.rejects(store.save([]), /regular file/);

  await unlink(filePath);
  await writeFile(filePath, validEnvelope, { mode: 0o600 });
  await chmod(filePath, 0o644);
  await assert.rejects(store.inspect(), /0600/);
  await assert.rejects(store.load(), /0600/);

  await unlink(filePath);
  await writeFile(filePath, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(store.inspect(), /1 MiB/);
  await assert.rejects(store.load(), /1 MiB/);

  const largeClaims: PersistedClaim[] = Array.from({ length: 600 }, (_, index) => ({
    kind: "blocked",
    issueId: `large-${index}`,
    attempt: null,
    continuation: 0,
    blockedAtMs: 0,
    summary: "x".repeat(2_000),
  }));
  const largeStore = new RunStateStore(path.join(parent, "large.json"), scope);
  await largeStore.acquireLease();
  await assert.rejects(largeStore.save(largeClaims), /1 MiB/);

  const realParent = path.join(root, "real-parent");
  const aliasParent = path.join(root, "alias-parent");
  await mkdir(realParent, { mode: 0o700 });
  await symlink(realParent, aliasParent);
  await assert.rejects(
    new RunStateStore(path.join(aliasParent, "state.json"), scope).inspect(),
    /real directory|canonical/,
  );
  await assert.rejects(new RunStateStore(path.join(aliasParent, "state.json"), scope).load(), /real directory|canonical/);

  const unsafeParent = path.join(root, "unsafe-parent");
  await mkdir(unsafeParent, { mode: 0o700 });
  await chmod(unsafeParent, 0o755);
  await assert.rejects(
    new RunStateStore(path.join(unsafeParent, "state.json"), scope).inspect(),
    /0700/,
  );
  await assert.rejects(new RunStateStore(path.join(unsafeParent, "state.json"), scope).load(), /0700/);
});

posixTest("validates claim bounds, delivery UUIDs, and completion payloads", async () => {
  const { filePath } = await fixture();
  const store = new RunStateStore(filePath, scope);
  await store.acquireLease();
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
    {
      kind: "retrying",
      issueId: "retry",
      attempt: 0,
      continuation: 0,
      dueAtMs: 0,
      reason: "failure",
      error: "private provider failure",
    },
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
  await store.acquireLease();
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

posixTest("holds one live lease and transfers it only after clean release", async () => {
  const { filePath } = await fixture();
  const first = new RunStateStore(filePath, scope);
  const second = new RunStateStore(filePath, otherScope);

  await first.acquireLease();
  await first.acquireLease();
  const leaseDirectory = `${filePath}.lease`;
  const rootPath = path.join(leaseDirectory, "root");
  const ownerContents = await readFile(rootPath, "utf8");
  assert.equal((await lstat(leaseDirectory)).mode & 0o7777, 0o700);
  assert.equal((await lstat(rootPath)).mode & 0o7777, 0o600);
  assert.ok(Buffer.byteLength(ownerContents) <= 1024);
  assert.deepEqual(Object.keys(JSON.parse(ownerContents) as Record<string, unknown>), [
    "version",
    "token",
    "pid",
    "hostname",
    "previousToken",
  ]);
  await first.save([{ kind: "running", issueId: "owned", attempt: null, continuation: 0 }]);
  assert.deepEqual(await new RunStateStore(filePath, scope).load(), [
    { kind: "running", issueId: "owned", attempt: null, continuation: 0 },
  ]);
  await assert.rejects(second.acquireLease(), exactError("Durable run state lease is unavailable"));

  await first.releaseLease();
  await first.releaseLease();
  await second.acquireLease();
  await first.releaseLease();
  await second.releaseLease();
});

posixTest("scopes leases by canonical state path rather than workflow hash", async () => {
  const { parent, filePath } = await fixture();
  const first = new RunStateStore(filePath, scope);
  const sameScopeDifferentPath = new RunStateStore(path.join(parent, "other.json"), scope);
  const differentScopeSamePath = new RunStateStore(filePath, otherScope);

  await Promise.all([first.acquireLease(), sameScopeDifferentPath.acquireLease()]);
  await assert.rejects(differentScopeSamePath.acquireLease(), /lease is unavailable/);
});

posixTest("releases a published owner when the first directory fsync fails", async () => {
  const { root, filePath } = await fixture();
  const probe = await open(root, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    sync: (this: FileHandle) => Promise<void>;
  };
  const originalSync = fileHandlePrototype.sync;
  await probe.close();
  let injected = false;
  fileHandlePrototype.sync = async function (this: FileHandle): Promise<void> {
    const stat = await this.stat();
    if (!injected && stat.isDirectory()) {
      injected = true;
      throw new Error("injected directory fsync failure");
    }
    await originalSync.call(this);
  };

  try {
    await assert.rejects(
      new RunStateStore(filePath, scope).acquireLease(),
      exactError("Durable run state lease is unavailable"),
    );
  } finally {
    fileHandlePrototype.sync = originalSync;
  }
  assert.equal(injected, true);

  const successor = new RunStateStore(filePath, scope);
  await successor.acquireLease();
  await successor.releaseLease();
});

posixTest("reclaims a dead tail with exactly one concurrent winner", async () => {
  const { filePath } = await fixture();
  await seedLeaseRoot(filePath, { pid: 2_147_483_647 });
  const contenders = Array.from({ length: 12 }, () => new RunStateStore(filePath, scope));
  const results = await Promise.allSettled(contenders.map((store) => store.acquireLease()));
  const winners = results.flatMap((result, index) => (result.status === "fulfilled" ? [contenders[index]!] : []));

  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, contenders.length - 1);
  await winners[0]!.releaseLease();
});

posixTest("preserves an append-only chain across several released generations", async () => {
  const { filePath } = await fixture();
  const tokens: string[] = [];

  for (let generation = 0; generation < 24; generation += 1) {
    const store = new RunStateStore(filePath, scope);
    await store.acquireLease();
    const leaseDirectory = `${filePath}.lease`;
    const ownerPath =
      generation === 0 ? path.join(leaseDirectory, "root") : path.join(leaseDirectory, `next-${tokens[generation - 1]}`);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as LeaseOwnerFixture;
    assert.equal(owner.previousToken, tokens[generation - 1] ?? null);
    tokens.push(owner.token);
    await store.releaseLease();

    const ownerStat = await lstat(ownerPath);
    const releasedStat = await lstat(path.join(leaseDirectory, `released-${owner.token}`));
    assert.equal(releasedStat.dev, ownerStat.dev);
    assert.equal(releasedStat.ino, ownerStat.ino);
  }
});

posixTest("refuses to append beyond the readable lease-chain limit", async () => {
  const { filePath } = await fixture();
  const { tail, tailPath } = await seedLeaseChain(filePath, 1024);
  await link(tailPath, path.join(`${filePath}.lease`, `released-${tail.token}`));

  await assert.rejects(new RunStateStore(filePath, scope).acquireLease(), /lease is unavailable/);
  await assert.rejects(access(path.join(`${filePath}.lease`, `next-${tail.token}`)), isMissing);
});

posixTest("fails closed for malformed, linked, unsafe, oversized, and foreign owners", async () => {
  const cases: Array<(filePath: string, rootPath: string) => Promise<void>> = [
    async (_filePath, rootPath) => writeFile(rootPath, "{", { mode: 0o600 }),
    async (filePath, rootPath) => {
      const target = path.join(path.dirname(filePath), "owner-target");
      await writeFile(target, JSON.stringify(leaseOwner()), { mode: 0o600 });
      await symlink(target, rootPath);
    },
    async (_filePath, rootPath) => {
      await writeFile(rootPath, JSON.stringify(leaseOwner()), { mode: 0o600 });
      await chmod(rootPath, 0o644);
    },
    async (_filePath, rootPath) => writeFile(rootPath, Buffer.alloc(1025), { mode: 0o600 }),
    async (_filePath, rootPath) => {
      await writeFile(rootPath, JSON.stringify(leaseOwner({ hostname: `${hostname()}-foreign` })), { mode: 0o600 });
    },
  ];

  for (const setup of cases) {
    const { filePath } = await fixture();
    const rootPath = await createLeaseDirectory(filePath);
    await setup(filePath, rootPath);
    await assert.rejects(
      new RunStateStore(filePath, scope).acquireLease(),
      exactError("Durable run state lease is unavailable"),
    );
  }
});

posixTest("fails closed for unsafe lease directories, broken chains, and forged release markers", async () => {
  {
    const { filePath } = await fixture();
    const rootPath = await createLeaseDirectory(filePath);
    await chmod(path.dirname(rootPath), 0o755);
    await assert.rejects(new RunStateStore(filePath, scope).acquireLease(), /lease is unavailable/);
  }
  {
    const { parent, filePath } = await fixture();
    await mkdir(parent, { mode: 0o700 });
    const realLeaseDirectory = path.join(parent, "real-lease");
    await mkdir(realLeaseDirectory, { mode: 0o700 });
    await symlink(realLeaseDirectory, `${filePath}.lease`);
    await assert.rejects(new RunStateStore(filePath, scope).acquireLease(), /lease is unavailable/);
  }
  {
    const { filePath } = await fixture();
    const rootPath = await createLeaseDirectory(filePath);
    const root = leaseOwner();
    await writeFile(rootPath, JSON.stringify(root), { mode: 0o600 });
    await writeFile(
      path.join(path.dirname(rootPath), `next-${root.token}`),
      JSON.stringify(leaseOwner({ previousToken: randomUUID() })),
      { mode: 0o600 },
    );
    await assert.rejects(new RunStateStore(filePath, scope).acquireLease(), /lease is unavailable/);
  }
  {
    const { filePath } = await fixture();
    const rootPath = await createLeaseDirectory(filePath);
    const root = leaseOwner();
    await writeFile(rootPath, JSON.stringify(root), { mode: 0o600 });
    await writeFile(
      path.join(path.dirname(rootPath), `next-${root.token}`),
      JSON.stringify({ ...root, previousToken: root.token }),
      { mode: 0o600 },
    );
    await assert.rejects(new RunStateStore(filePath, scope).acquireLease(), /lease is unavailable/);
  }
  {
    const { filePath } = await fixture();
    const rootPath = await createLeaseDirectory(filePath);
    const root = leaseOwner({ pid: 2_147_483_647 });
    await writeFile(rootPath, JSON.stringify(root), { mode: 0o600 });
    await writeFile(path.join(path.dirname(rootPath), `released-${root.token}`), "forged", { mode: 0o600 });
    await assert.rejects(new RunStateStore(filePath, scope).acquireLease(), /lease is unavailable/);
  }
});

posixTest("requires ownership for writes and blocks an active owner after a successor appears", async () => {
  const { filePath } = await fixture();
  const unowned = new RunStateStore(filePath, scope);
  await unowned.releaseLease();
  await assert.rejects(unowned.save([]), exactError("Durable run state lease ownership was lost"));

  const owner = new RunStateStore(filePath, scope);
  await owner.acquireLease();
  await owner.save([{ kind: "running", issueId: "owned", attempt: null, continuation: 0 }]);
  const rootPath = path.join(`${filePath}.lease`, "root");
  const root = JSON.parse(await readFile(rootPath, "utf8")) as LeaseOwnerFixture;
  await writeFile(
    path.join(`${filePath}.lease`, `next-${root.token}`),
    JSON.stringify(leaseOwner({ previousToken: root.token })),
    { mode: 0o600 },
  );

  await assert.rejects(owner.load(), exactError("Durable run state lease ownership was lost"));
  await assert.rejects(owner.save([]), exactError("Durable run state lease ownership was lost"));
  await assert.rejects(owner.releaseLease(), exactError("Durable run state lease ownership was lost"));
  assert.deepEqual(await new RunStateStore(filePath, scope).load(), [
    { kind: "running", issueId: "owned", attempt: null, continuation: 0 },
  ]);
});

interface LeaseOwnerFixture {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  previousToken: string | null;
}

function leaseOwner(overrides: Partial<LeaseOwnerFixture> = {}): LeaseOwnerFixture {
  return {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    previousToken: null,
    ...overrides,
  };
}

async function createLeaseDirectory(filePath: string): Promise<string> {
  await mkdir(path.dirname(filePath), { mode: 0o700 });
  const leaseDirectory = `${filePath}.lease`;
  await mkdir(leaseDirectory, { mode: 0o700 });
  return path.join(leaseDirectory, "root");
}

async function seedLeaseRoot(filePath: string, overrides: Partial<LeaseOwnerFixture>): Promise<void> {
  const rootPath = await createLeaseDirectory(filePath);
  await writeFile(rootPath, `${JSON.stringify(leaseOwner(overrides))}\n`, { mode: 0o600 });
}

async function seedLeaseChain(
  filePath: string,
  length: number,
): Promise<{ tail: LeaseOwnerFixture; tailPath: string }> {
  const rootPath = await createLeaseDirectory(filePath);
  let previous: LeaseOwnerFixture | undefined;
  let ownerPath = rootPath;
  for (let index = 0; index < length; index += 1) {
    const owner = leaseOwner({ previousToken: previous?.token ?? null });
    ownerPath = previous === undefined ? rootPath : path.join(`${filePath}.lease`, `next-${previous.token}`);
    await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    previous = owner;
  }
  assert.ok(previous);
  return { tail: previous, tailPath: ownerPath };
}

function exactError(message: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message === message;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function fixture(): Promise<{ root: string; parent: string; filePath: string }> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "symphony-state-store-"));
  const root = await realpath(temporaryRoot);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "state");
  return { root, parent, filePath: path.join(parent, "runs.json") };
}
