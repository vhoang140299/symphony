import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { agentCompletionSchema } from "../completion.js";
import { RunStateLease } from "./lease.js";

const MAX_FILE_BYTES = 1024 * 1024;
const REQUIRED_DIRECTORY_MODE = 0o700;
const REQUIRED_FILE_MODE = 0o600;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const SCOPE_HASH = /^[0-9a-f]{64}$/u;
const timestampSchema = z.number().finite().nonnegative().max(MAX_TIMESTAMP_MS);

const pendingDeliverySchema = z
  .object({
    completion: agentCompletionSchema.refine((completion) => completion.status === "ready"),
    idempotencyKey: z.uuid(),
  })
  .strict();

const baseClaim = {
  issueId: z.string().min(1).max(256).refine((value) => value.trim().length > 0),
  continuation: z.number().int().nonnegative(),
};

const persistedClaimSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("running"),
      ...baseClaim,
      attempt: z.number().int().nonnegative().nullable(),
      pendingDelivery: pendingDeliverySchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retrying"),
      ...baseClaim,
      attempt: z.number().int().nonnegative(),
      dueAtMs: timestampSchema,
      reason: z.enum(["continuation", "failure"]),
      pendingDelivery: pendingDeliverySchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("blocked"),
      ...baseClaim,
      attempt: z.number().int().nonnegative().nullable(),
      blockedAtMs: timestampSchema,
      summary: z.string().max(2_000),
    })
    .strict(),
]);

const envelopeSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(SCOPE_HASH),
    claims: z.array(persistedClaimSchema),
  })
  .strict();

export type PersistedPendingDelivery = z.infer<typeof pendingDeliverySchema>;
export type PersistedClaim = z.infer<typeof persistedClaimSchema>;

export class RunStateStore {
  readonly #filePath: string;
  readonly #directory: string;
  readonly #scopeHash: string;
  readonly #lease: RunStateLease;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(filePath: string, scopeHash: string) {
    requirePosix();
    if (!SCOPE_HASH.test(scopeHash)) throw new Error("Run state scope must be a lowercase SHA-256 hash");
    this.#filePath = path.resolve(filePath);
    this.#directory = path.dirname(this.#filePath);
    this.#scopeHash = scopeHash;
    this.#lease = new RunStateLease(this.#filePath);
  }

  async acquireLease(): Promise<void> {
    await this.#enqueue(async () => {
      await validateParent(this.#directory);
      await this.#lease.acquire();
    });
  }

  async releaseLease(): Promise<void> {
    await this.#enqueue(() => this.#lease.release());
  }

  async load(): Promise<PersistedClaim[]> {
    return this.#enqueue(async () => {
      await validateParent(this.#directory);
      await this.#lease.assertOwnedIfAcquired();
      return (await this.#readExisting()) ?? [];
    });
  }

  async inspect(): Promise<"missing" | "valid"> {
    await this.#operationTail;
    if (!(await inspectParent(this.#directory))) return "missing";
    return (await this.#readExisting()) === undefined ? "missing" : "valid";
  }

  async #readExisting(): Promise<PersistedClaim[] | undefined> {
    const expectedStat = await validateExistingFile(this.#filePath);
    if (expectedStat === undefined) return undefined;

    let handle;
    try {
      handle = await open(this.#filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const openedStat = await handle.stat();
      if (openedStat.dev !== expectedStat.dev || openedStat.ino !== expectedStat.ino) {
        throw new Error("Run state file changed while it was being opened");
      }

      const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_FILE_BYTES) throw new Error("Run state file exceeds 1 MiB");

      let raw: unknown;
      try {
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } catch (error) {
        throw new Error("Run state file is not valid JSON", { cause: error });
      }
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) throw new Error("Run state file has an invalid shape");
      if (parsed.data.scope !== this.#scopeHash) throw new Error("Run state scope does not match this workflow");
      assertUniqueIssueIds(parsed.data.claims);
      return parsed.data.claims;
    } finally {
      await handle?.close();
    }
  }

  async save(claims: readonly PersistedClaim[]): Promise<void> {
    const parsed = z.array(persistedClaimSchema).safeParse(claims);
    if (!parsed.success) throw new Error("Run state claims have an invalid shape");
    assertUniqueIssueIds(parsed.data);
    const contents = `${JSON.stringify({ version: 1, scope: this.#scopeHash, claims: parsed.data })}\n`;
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new Error("Run state file exceeds 1 MiB");

    await this.#enqueue(() => this.#write(contents));
  }

  async #write(contents: string): Promise<void> {
    await validateParent(this.#directory);
    await this.#lease.assertOwned();
    await this.#readExisting();
    const temporaryPath = path.join(this.#directory, `.symphony-state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        REQUIRED_FILE_MODE,
      );
      await handle.chmod(REQUIRED_FILE_MODE);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#filePath);

      const directoryHandle = await open(
        this.#directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await handle?.close();
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function validateParent(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: REQUIRED_DIRECTORY_MODE });
  await validateParentMetadata(directory);
}

async function inspectParent(directory: string): Promise<boolean> {
  try {
    await validateParentMetadata(directory);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function validateParentMetadata(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Run state parent must be a real directory");
  }
  if (stat.uid !== currentUid()) throw new Error("Run state parent must be owned by the current user");
  if ((stat.mode & 0o7777) !== REQUIRED_DIRECTORY_MODE) throw new Error("Run state parent must have mode 0700");
  if ((await realpath(directory)) !== directory) throw new Error("Run state parent path must be canonical");
}

async function validateExistingFile(filePath: string): Promise<Stats | undefined> {
  let stat: Stats;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Run state file must be a regular file");
  if (stat.uid !== currentUid()) throw new Error("Run state file must be owned by the current user");
  if ((stat.mode & 0o7777) !== REQUIRED_FILE_MODE) throw new Error("Run state file must have mode 0600");
  if (stat.size > MAX_FILE_BYTES) throw new Error("Run state file exceeds 1 MiB");
  if ((await realpath(filePath)) !== filePath) throw new Error("Run state file path must be canonical");
  return stat;
}

function assertUniqueIssueIds(claims: readonly PersistedClaim[]): void {
  const issueIds = new Set<string>();
  for (const claim of claims) {
    if (issueIds.has(claim.issueId)) throw new Error(`Run state contains duplicate issue id: ${claim.issueId}`);
    issueIds.add(claim.issueId);
  }
}

function requirePosix(): void {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_DIRECTORY !== "number"
  ) {
    throw new Error("Durable run state requires POSIX filesystem guarantees");
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Durable run state requires POSIX filesystem guarantees");
  return uid;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
