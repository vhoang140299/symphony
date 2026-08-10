import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "symphony-package-"));

try {
  const firstDirectory = path.join(temporaryRoot, "first");
  const secondDirectory = path.join(temporaryRoot, "second");
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  runPnpm(["pack", "--pack-destination", firstDirectory], packageRoot);
  runPnpm(["pack", "--pack-destination", secondDirectory], packageRoot);

  const firstTarball = await onlyTarball(firstDirectory);
  const secondTarball = await onlyTarball(secondDirectory);
  const [firstContents, secondContents] = await Promise.all([readFile(firstTarball), readFile(secondTarball)]);
  assert.equal(sha512(firstContents), sha512(secondContents), "repeated packs must be byte-for-byte deterministic");
  const packagedFiles = run("tar", ["-tzf", firstTarball], packageRoot).trim().split(/\r?\n/u);
  const allowedFiles = new Set([
    "package/LICENSE",
    "package/NOTICE",
    "package/README.md",
    "package/WORKFLOW.codex.github.md",
    "package/WORKFLOW.github.md",
    "package/WORKFLOW.md",
    "package/codex-symphony-wrapper.mjs",
    "package/package.json",
  ]);
  assert.ok(packagedFiles.includes("package/dist/dashboard/index.html"), "tarball must include the dashboard");
  assert.ok(
    packagedFiles.includes("package/dist/dashboard/assets/licenses.md"),
    "tarball must include bundled dependency licenses",
  );
  assert.ok(packagedFiles.includes("package/dist/src/cli.js"), "tarball must include the compiled CLI");
  assert.deepEqual(
    packagedFiles.filter(
      (entry) =>
        !allowedFiles.has(entry) &&
        !entry.startsWith("package/dist/dashboard/") &&
        !entry.startsWith("package/dist/src/"),
    ),
    [],
    "tarball must contain only runtime artifacts and public documentation",
  );

  const consumerDirectory = path.join(temporaryRoot, "consumer");
  await mkdir(consumerDirectory);
  await writeFile(path.join(consumerDirectory, "package.json"), '{"name":"packaging-smoke","private":true}\n');
  runPnpm(["add", "--ignore-scripts", firstTarball], consumerDirectory);

  const installedRoot = path.join(consumerDirectory, "node_modules", "@ai-symphony", "node");
  const installedMetadata = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedMetadata.name, packageMetadata.name);
  assert.equal(installedMetadata.version, packageMetadata.version);
  assert.deepEqual((await readdir(installedRoot)).filter((entry) => entry !== "node_modules").sort(), [
    "LICENSE",
    "NOTICE",
    "README.md",
    "WORKFLOW.codex.github.md",
    "WORKFLOW.github.md",
    "WORKFLOW.md",
    "codex-symphony-wrapper.mjs",
    "dist",
    "package.json",
  ]);
  if (process.platform !== "win32") {
    await access(path.join(installedRoot, "codex-symphony-wrapper.mjs"), constants.X_OK);
  }

  const binDirectory = path.join(consumerDirectory, "node_modules", ".bin");
  const help =
    process.platform === "win32"
      ? run("cmd.exe", ["/d", "/s", "/c", path.join(binDirectory, "symphony-node.cmd"), "--help"], consumerDirectory)
      : run(path.join(binDirectory, "symphony-node"), ["--help"], consumerDirectory);
  assert.match(help, /Usage: symphony-node/u);

  process.stdout.write(
    `packaging smoke passed: ${path.basename(firstTarball)} (${firstContents.byteLength} bytes, sha512 ${sha512(firstContents)})\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function onlyTarball(directory) {
  const tarballs = (await readdir(directory)).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `expected one tarball in ${directory}`);
  return path.join(directory, tarballs[0]);
}

function runPnpm(args, cwd) {
  const pnpmScript = process.env.npm_execpath;
  if (pnpmScript === undefined) return run("pnpm", args, cwd);
  return /\.[cm]?js$/u.test(pnpmScript)
    ? run(process.execPath, [pnpmScript, ...args], cwd)
    : run(pnpmScript, args, cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  return result.stdout;
}

function sha512(contents) {
  return createHash("sha512").update(contents).digest("hex");
}
