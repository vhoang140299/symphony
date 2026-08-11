import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { isNodeError } from "../system.js";

const MAX_NODE_BYTES = 1024;
const MAX_CHAIN_DEPTH = 1024;
const REQUIRED_DIRECTORY_MODE = 0o700;
const REQUIRED_FILE_MODE = 0o600;
const MAX_HOSTNAME_LENGTH = 255;
const UNAVAILABLE = "Durable run state lease is unavailable";
const OWNERSHIP_LOST = "Durable run state lease ownership was lost";

const ownerSchema = z
  .object({
    version: z.literal(1),
    token: z.uuid(),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    hostname: z.string().min(1).max(MAX_HOSTNAME_LENGTH),
    previousToken: z.uuid().nullable(),
  })
  .strict();

type LeaseOwner = z.infer<typeof ownerSchema>;

interface LeaseNode {
  owner: LeaseOwner;
  filePath: string;
  stat: Stats;
}

interface LeaseTail {
  node: LeaseNode;
  length: number;
}

export class RunStateLease {
  readonly #directory: string;
  #owned: LeaseNode | undefined;

  constructor(statePath: string) {
    this.#directory = `${path.resolve(statePath)}.lease`;
  }

  async acquire(): Promise<void> {
    try {
      if (this.#owned !== undefined) {
        await this.#assertActiveOwnership();
        return;
      }

      await this.#ensureDirectory();
      for (let attempt = 0; attempt < MAX_CHAIN_DEPTH; attempt += 1) {
        await this.#validateDirectory();
        const chain = await this.#readTail();
        const tail = chain?.node;
        if (chain !== undefined && chain.length >= MAX_CHAIN_DEPTH) throw new Error(UNAVAILABLE);
        if (tail !== undefined && !(await this.#isEligible(tail))) throw new Error(UNAVAILABLE);

        const previousToken = tail?.owner.token ?? null;
        const targetPath =
          tail === undefined
            ? path.join(this.#directory, "root")
            : path.join(this.#directory, `next-${tail.owner.token}`);
        const published = await this.#publishOwner(targetPath, previousToken);
        if (published !== undefined) {
          this.#owned = published;
          return;
        }
      }
      throw new Error(UNAVAILABLE);
    } catch {
      try {
        await this.release();
      } catch {}
      throw new Error(UNAVAILABLE);
    }
  }

  async assertOwned(): Promise<void> {
    try {
      await this.#assertActiveOwnership();
    } catch {
      throw new Error(OWNERSHIP_LOST);
    }
  }

  async assertOwnedIfAcquired(): Promise<void> {
    if (this.#owned === undefined) return;
    await this.assertOwned();
  }

  async release(): Promise<void> {
    const owned = this.#owned;
    if (owned === undefined) return;
    try {
      await this.#validateDirectory();
      const tail = (await this.#readTail())?.node;
      if (!sameNode(tail, owned)) throw new Error(OWNERSHIP_LOST);

      const releasedPath = path.join(this.#directory, `released-${owned.owner.token}`);
      const existing = await this.#readMarker(releasedPath);
      if (existing !== undefined) {
        if (!sameInode(existing, owned.stat)) throw new Error(OWNERSHIP_LOST);
        await this.#syncDirectory();
        this.#owned = undefined;
        return;
      }
      try {
        await link(owned.filePath, releasedPath);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      const publishedMarker = await this.#readMarker(releasedPath);
      if (publishedMarker === undefined || !sameInode(publishedMarker, owned.stat)) {
        throw new Error(OWNERSHIP_LOST);
      }
      await this.#syncDirectory();
      this.#owned = undefined;
    } catch {
      throw new Error(OWNERSHIP_LOST);
    }
  }

  async #assertActiveOwnership(): Promise<void> {
    const owned = this.#owned;
    if (owned === undefined) throw new Error(OWNERSHIP_LOST);
    await this.#validateDirectory();
    const tail = (await this.#readTail())?.node;
    if (!sameNode(tail, owned)) throw new Error(OWNERSHIP_LOST);
    if ((await this.#readMarker(path.join(this.#directory, `released-${owned.owner.token}`))) !== undefined) {
      throw new Error(OWNERSHIP_LOST);
    }
  }

  async #ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.#directory, { mode: REQUIRED_DIRECTORY_MODE });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await this.#validateDirectory();
  }

  async #validateDirectory(): Promise<void> {
    const stat = await lstat(this.#directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(UNAVAILABLE);
    if (stat.uid !== currentUid()) throw new Error(UNAVAILABLE);
    if ((stat.mode & 0o7777) !== REQUIRED_DIRECTORY_MODE) throw new Error(UNAVAILABLE);
    if ((await realpath(this.#directory)) !== this.#directory) throw new Error(UNAVAILABLE);
  }

  async #readTail(): Promise<LeaseTail | undefined> {
    let filePath = path.join(this.#directory, "root");
    let expectedPreviousToken: string | null = null;
    const visited = new Set<string>();

    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
      const node = await this.#readOwner(filePath);
      if (node === undefined) {
        if (depth === 0) return undefined;
        throw new Error(UNAVAILABLE);
      }
      if (node.owner.previousToken !== expectedPreviousToken || visited.has(node.owner.token)) {
        throw new Error(UNAVAILABLE);
      }
      visited.add(node.owner.token);

      const successorPath = path.join(this.#directory, `next-${node.owner.token}`);
      const successor = await this.#readOwner(successorPath);
      if (successor === undefined) return { node, length: depth + 1 };
      expectedPreviousToken = node.owner.token;
      filePath = successorPath;
    }
    throw new Error(UNAVAILABLE);
  }

  async #isEligible(tail: LeaseNode): Promise<boolean> {
    const marker = await this.#readMarker(path.join(this.#directory, `released-${tail.owner.token}`));
    if (marker !== undefined) {
      if (!sameInode(marker, tail.stat)) throw new Error(UNAVAILABLE);
      return true;
    }
    if (tail.owner.hostname !== hostname()) return false;
    try {
      process.kill(tail.owner.pid, 0);
      return false;
    } catch (error) {
      if (isNodeError(error, "ESRCH")) return true;
      if (isNodeError(error, "EPERM")) return false;
      throw error;
    }
  }

  async #publishOwner(targetPath: string, previousToken: string | null): Promise<LeaseNode | undefined> {
    const owner: LeaseOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      previousToken,
    };
    if (!ownerSchema.safeParse(owner).success) throw new Error(UNAVAILABLE);
    const contents = `${JSON.stringify(owner)}\n`;
    if (Buffer.byteLength(contents) > MAX_NODE_BYTES) throw new Error(UNAVAILABLE);

    const candidatePath = path.join(this.#directory, `.candidate-${randomUUID()}.tmp`);
    let handle;
    let candidateStat: Stats | undefined;
    try {
      handle = await open(
        candidatePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        REQUIRED_FILE_MODE,
      );
      await handle.chmod(REQUIRED_FILE_MODE);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      candidateStat = await handle.stat();
      await handle.close();
      handle = undefined;

      if (candidateStat === undefined) throw new Error(UNAVAILABLE);
      try {
        await link(candidatePath, targetPath);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) return undefined;
        throw error;
      }
      this.#owned = { owner, filePath: targetPath, stat: candidateStat };
      await this.#syncDirectory();
      const published = await this.#readOwner(targetPath);
      if (published === undefined || published.owner.token !== owner.token) throw new Error(UNAVAILABLE);
      return published;
    } finally {
      await handle?.close();
      try {
        await unlink(candidatePath);
      } catch {}
    }
  }

  async #readOwner(filePath: string): Promise<LeaseNode | undefined> {
    const expectedStat = await this.#lstatFile(filePath);
    if (expectedStat === undefined) return undefined;

    let handle;
    try {
      handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const openedStat = await handle.stat();
      if (!sameInode(openedStat, expectedStat)) throw new Error(UNAVAILABLE);
      const buffer = Buffer.allocUnsafe(MAX_NODE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_NODE_BYTES) throw new Error(UNAVAILABLE);

      let raw: unknown;
      try {
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } catch {
        throw new Error(UNAVAILABLE);
      }
      const parsed = ownerSchema.safeParse(raw);
      if (!parsed.success) throw new Error(UNAVAILABLE);
      return { owner: parsed.data, filePath, stat: openedStat };
    } finally {
      await handle?.close();
    }
  }

  async #readMarker(filePath: string): Promise<Stats | undefined> {
    return this.#lstatFile(filePath);
  }

  async #lstatFile(filePath: string): Promise<Stats | undefined> {
    let stat: Stats;
    try {
      stat = await lstat(filePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(UNAVAILABLE);
    if (stat.uid !== currentUid()) throw new Error(UNAVAILABLE);
    if ((stat.mode & 0o7777) !== REQUIRED_FILE_MODE) throw new Error(UNAVAILABLE);
    if (stat.size > MAX_NODE_BYTES) throw new Error(UNAVAILABLE);
    if ((await realpath(filePath)) !== filePath) throw new Error(UNAVAILABLE);
    return stat;
  }

  async #syncDirectory(): Promise<void> {
    const handle = await open(
      this.#directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function sameNode(left: LeaseNode | undefined, right: LeaseNode): boolean {
  return (
    left !== undefined &&
    left.filePath === right.filePath &&
    left.owner.token === right.owner.token &&
    sameInode(left.stat, right.stat)
  );
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error(UNAVAILABLE);
  return uid;
}
