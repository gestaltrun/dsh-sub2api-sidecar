#!/usr/bin/env node
// Build a portable Sub2API runtime pack for one os/arch target.
//
// Downloads pinned upstream binaries, verifies SHA256 against
// pack-sources.lock.json, assembles bin/ + share/config.template.yaml +
// SHA256SUMS, and emits dist/runtime-pack-<ver>-<os>-<arch>.tar.gz plus
// dist/SHA256SUMS. Node >= 22, standard library only.
//
// The pack never mutates a GitHub release: CI uploads dist/ as a workflow
// artifact; Release assets require separate user approval.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_FILE = path.join(REPO_ROOT, "pack-sources.lock.json");
const FIXED_MTIME = 946684800; // 2000-01-01T00:00:00Z, keeps tarball bytes reproducible
const DOWNLOAD_RETRIES = [2_000, 5_000, 15_000, 30_000];
const DOWNLOAD_TIMEOUT_MS = 600_000;

// Server lifecycle is all the sidecar needs; the zonky darwin payload ships
// exactly these three binaries, other platforms may carry more of this list.
const PG_BIN_KEEP = new Set(["postgres", "initdb", "pg_ctl", "psql"]);
const PG_PRUNE_DIRS = new Set(["include", "man", "doc"]);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireNode22() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) fail(`Node >= 22 required, running ${process.versions.node}`);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      os: { type: "string", default: "darwin" },
      arch: { type: "string", default: "arm64" },
      "sub2api-version": { type: "string" },
      "sub2api-binary": { type: "string" },
      "sub2api-source-ref": { type: "string" },
      "base-runtime-pack": { type: "string" },
      dist: { type: "string" },
      "downloads-cache": { type: "string" },
      "keep-work": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: node scripts/build-runtime-pack.mjs [--os <os>] [--arch <arch>] [--sub2api-version <ver>]
  --os               target os, default darwin
  --arch             target arch, default arm64 (aliases: x64 -> amd64, aarch64 -> arm64)
  --sub2api-version  override the pinned Sub2API version; the hash then comes from the
                     release's official checksums.txt instead of the lock file
  --sub2api-binary   use this exact locally built Sub2API binary instead of a release asset
  --sub2api-source-ref  required with --sub2api-binary; immutable repository@commit provenance
  --base-runtime-pack  reuse the verified PostgreSQL/Redis tree from this runtime pack
  --dist             output directory, default <repo>/dist
  --downloads-cache  dir that caches verified downloads for reruns; files must still
                     match the pinned SHA256 to be used
  --keep-work        keep the temporary work directory for debugging`);
    process.exit(0);
  }
  const archAliases = { x64: "amd64", aarch64: "arm64" };
  const osAliases = { macos: "darwin", mac: "darwin" };
  return {
    os: osAliases[values.os] ?? values.os,
    arch: archAliases[values.arch] ?? values.arch,
    sub2apiVersion: values["sub2api-version"] || null,
    sub2apiBinary: values["sub2api-binary"] ? path.resolve(values["sub2api-binary"]) : null,
    sub2apiSourceRef: values["sub2api-source-ref"] || null,
    baseRuntimePack: values["base-runtime-pack"] ? path.resolve(values["base-runtime-pack"]) : null,
    distDir: values.dist ? path.resolve(values.dist) : path.join(REPO_ROOT, "dist"),
    downloadsCache: values["downloads-cache"] ? path.resolve(values["downloads-cache"]) : null,
    keepWork: values["keep-work"],
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

// Streams the response body to <dest>.part and renames once complete.
// Retries resume from the bytes already on disk via a Range request, so flaky
// networks do not restart a large download from zero.
async function downloadTo(url, destPath) {
  const tmp = `${destPath}.part`;
  for (let attempt = 0; ; attempt++) {
    try {
      const existing = await fs.stat(tmp).catch(() => null);
      const resumeFrom = existing ? existing.size : 0;
      const headers = resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {};
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      const restarting = response.status === 200; // server ignored the Range header
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const remaining = Number(response.headers.get("content-length"));
      const expectedTotal = Number.isFinite(remaining)
        ? response.status === 206
          ? resumeFrom + remaining
          : remaining
        : null;
      const stream = createWriteStream(tmp, {
        flags: response.status === 206 && !restarting ? "a" : "w",
        start: restarting ? 0 : resumeFrom,
      });
      await new Promise((resolve, reject) => {
        Readable.fromWeb(response.body)
          .pipe(stream)
          .on("finish", resolve)
          .on("error", reject);
      });
      const size = (await fs.stat(tmp)).size;
      if (expectedTotal !== null && size !== expectedTotal) {
        throw new Error(`truncated download: got ${size} bytes, expected ${expectedTotal}`);
      }
      await fs.rename(tmp, destPath);
      return;
    } catch (error) {
      if (attempt >= DOWNLOAD_RETRIES.length) {
        fail(`download failed after ${attempt + 1} attempts: ${url}\n  ${error.message}`);
      }
      const wait = DOWNLOAD_RETRIES[attempt];
      console.warn(`download attempt ${attempt + 1} failed (${error.message}); retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function extract(command, args, what) {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  if (code !== 0) fail(`${command} ${args.join(" ")} failed (exit ${code}) while ${what}\n${stderr}`);
}

async function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => {
    if (!(key in vars)) fail(`lock url template needs {${key}} but no value was provided`);
    return String(vars[key]);
  });
}

async function walk(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    const resolved = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(resolved);
      const nested = await walk(resolved);
      dirs.push(...nested.dirs);
      files.push(...nested.files);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // Symlinks (PG ships versioned dylib links) are members of the pack;
      // hashing reads through them, so a dangling link fails the build.
      files.push(resolved);
    } else {
      fail(`unexpected non-regular entry in pack: ${resolved}`);
    }
  }
  return { dirs, files };
}

async function loadLock() {
  return JSON.parse(await fs.readFile(LOCK_FILE, "utf8"));
}

function resolvePlatform(lock, os, arch) {
  const platform = `${os}-${arch}`;
  if (!lock.sources.sub2api.variants[platform]) {
    fail(`no pinned sub2api hash for platform ${platform} in ${LOCK_FILE}`);
  }
  if (!lock.sources.postgresql.variants[platform]) {
    fail(`no pinned postgresql hash for platform ${platform} in ${LOCK_FILE}`);
  }
  return platform;
}

// The lock file is authoritative for the pinned default. An explicit override
// version has no locked hash, so trust only the release's own checksums.txt.
async function resolveSub2apiHash(lock, platform, version, workDir) {
  if (version === lock.sources.sub2api.defaultVersion) {
    return { sha256: lock.sources.sub2api.variants[platform].sha256, trustedFrom: "pack-sources.lock.json" };
  }
  const checksumsUrl = await fillTemplate(lock.sources.sub2api.checksumsUrlTemplate, { version });
  const tmp = path.join(workDir, "downloads", `checksums-${version}.txt`);
  await downloadTo(checksumsUrl, tmp);
  const text = await fs.readFile(tmp, "utf8");
  const asset = `sub2api_${version}_${platform.replace("-", "_")}`;
  const line = text.split("\n").find((candidate) => candidate.trim().endsWith(`  ${asset}`));
  if (!line) fail(`no checksum for ${asset} in ${checksumsUrl}`);
  console.warn(`NOTE: sub2api ${version} is not pinned in pack-sources.lock.json; hash trusted from ${checksumsUrl}`);
  return { sha256: line.trim().split(/\s+/)[0], trustedFrom: checksumsUrl };
}

// Sources one download into destPath, verifying its SHA256 against expectedSha:
// copies from --downloads-cache when a matching file is there, otherwise
// downloads and, when a cache dir is configured, populates it for reruns.
async function obtainVerified(url, expectedSha, destPath, label, cacheDir, trustedFrom) {
  const cached = cacheDir ? path.join(cacheDir, path.basename(destPath)) : null;
  if (cached && (await sha256File(cached).catch(() => null)) === expectedSha) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(cached, destPath);
    console.log(`[${label}] cache hit, sha256 ok: ${cached}`);
    return;
  }
  console.log(`[${label}] downloading ${url}`);
  await downloadTo(url, destPath);
  const actual = await sha256File(destPath);
  if (actual !== expectedSha) {
    fail(
      `checksum mismatch for ${path.basename(destPath)}\n` +
        `  expected ${expectedSha} (${trustedFrom})\n` +
        `  actual   ${actual}`,
    );
  }
  console.log(`[${label}] sha256 ok: ${actual}`);
  if (cacheDir) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.copyFile(destPath, cached);
  }
}

async function fetchSub2api(lock, cli, version, workDir, packBin) {
  const url = await fillTemplate(lock.sources.sub2api.urlTemplate, {
    version,
    os: cli.os,
    arch: cli.arch,
  });
  const archive = path.join(workDir, "downloads", path.basename(url));
  const expected = await resolveSub2apiHash(lock, cli.platform, version, workDir);
  await obtainVerified(
    url,
    expected.sha256,
    archive,
    `sub2api ${version}`,
    cli.downloadsCache,
    expected.trustedFrom,
  );
  const extracted = path.join(workDir, "sub2api");
  await fs.mkdir(extracted, { recursive: true });
  await extract("tar", ["-xzf", archive, "-C", extracted], "extracting sub2api tarball");
  const { files } = await walk(extracted);
  const binary = files.find((file) => path.basename(file) === "sub2api");
  if (!binary) fail("sub2api archive does not contain a 'sub2api' binary");
  const target = path.join(packBin, "sub2api");
  await fs.copyFile(binary, target);
  await fs.chmod(target, 0o755);
  return {
    url,
    version,
    sourceRef: `Wei-Shaw/sub2api@v${version}`,
    archiveSha256: expected.sha256,
    binarySha256: await sha256File(target),
  };
}

/** Copy one exact locally built Sub2API binary into the pack with provenance. */
export async function installLocalSub2api(binaryPath, sourceRef, version, packBin) {
  if (sourceRef.trim() === "") fail("--sub2api-source-ref must name an immutable repository@commit");
  const sourceStat = await fs.stat(binaryPath).catch(() => null);
  if (!sourceStat?.isFile()) fail(`--sub2api-binary is not a regular file: ${binaryPath}`);
  await fs.mkdir(packBin, { recursive: true });
  const target = path.join(packBin, "sub2api");
  await fs.copyFile(binaryPath, target);
  await fs.chmod(target, 0o755);
  return {
    url: null,
    version,
    sourceRef,
    archiveSha256: null,
    binarySha256: await sha256File(target),
  };
}

async function fetchPostgresql(lock, cli, workDir, packDir) {
  const source = lock.sources.postgresql;
  const variant = source.variants[cli.platform];
  const url = await fillTemplate(source.urlTemplate, {
    mavenArch: variant.mavenArch,
    version: source.version,
  });
  const jar = path.join(workDir, "downloads", path.basename(url));
  await obtainVerified(
    url,
    variant.sha256,
    jar,
    `postgresql ${source.version}`,
    cli.downloadsCache,
    "repo1.maven.org .sha256 sidecar pinned in pack-sources.lock.json",
  );
  const jarDir = path.join(workDir, "postgresql-jar");
  const txzRoot = path.join(workDir, "postgresql");
  await fs.mkdir(jarDir, { recursive: true });
  await fs.mkdir(txzRoot, { recursive: true });
  await extract("unzip", ["-q", jar, "-d", jarDir], "unzipping zonky jar");
  const { files } = await walk(jarDir);
  const txz = files.find((file) => file.endsWith(".txz"));
  if (!txz) fail("zonky jar does not contain a .txz payload");
  await extract("tar", ["-xJf", txz, "-C", txzRoot], "extracting postgresql txz");
  const top = await fs.readdir(txzRoot, { withFileTypes: true });
  const root = top.length === 1 && top[0].isDirectory() ? path.join(txzRoot, top[0].name) : txzRoot;
  await copyPostgresqlTree(root, packDir);
  return { url, version: source.version, sha256: variant.sha256 };
}

async function copyPostgresqlTree(sourceRoot, packDir) {
  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    if (PG_PRUNE_DIRS.has(entry.name)) continue;
    const from = path.join(sourceRoot, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "bin") {
        const binDest = path.join(packDir, "bin");
        await fs.mkdir(binDest, { recursive: true });
        for (const binEntry of await fs.readdir(from, { withFileTypes: true })) {
          if (!binEntry.isFile() || !PG_BIN_KEEP.has(binEntry.name)) continue;
          const target = path.join(binDest, binEntry.name);
          await fs.copyFile(path.join(from, binEntry.name), target);
          await fs.chmod(target, 0o755);
        }
      } else {
        await copyDir(from, path.join(packDir, entry.name));
      }
    } else if (entry.isFile()) {
      await fs.copyFile(from, path.join(packDir, entry.name));
    }
  }
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (PG_PRUNE_DIRS.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(source, dest);
    } else if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(source), dest);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".a")) continue; // static archives: dead weight at runtime
      await fs.copyFile(source, dest);
    }
  }
}

async function verifyPackTree(packDir) {
  const text = await fs.readFile(path.join(packDir, "SHA256SUMS"), "utf8");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) fail(`invalid inner SHA256SUMS line in base runtime pack: ${line}`);
    const file = path.resolve(packDir, match[2]);
    if (!file.startsWith(`${path.resolve(packDir)}${path.sep}`)) fail(`base runtime pack checksum escapes root: ${match[2]}`);
    const actual = await sha256File(file).catch(() => null);
    if (actual !== match[1]) fail(`base runtime pack checksum mismatch: ${match[2]}`);
  }
}

async function seedFromBaseRuntimePack(archive, workDir, packDir) {
  const extracted = path.join(workDir, "base-runtime-pack");
  await fs.mkdir(extracted, { recursive: true });
  await extract("tar", ["-xzf", archive, "-C", extracted], "extracting base runtime pack");
  const roots = (await fs.readdir(extracted, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) fail("base runtime pack must contain exactly one top-level directory");
  const root = path.join(extracted, roots[0].name);
  await verifyPackTree(root);
  await copyDir(root, packDir);
  await fs.rm(path.join(packDir, "SHA256SUMS"), { force: true });
}

// darwin ships no trustworthy portable Redis binary (rationale and
// re-evaluation triggers live in pack-sources.lock.json sources.redis), so the
// pack carries a stub that fails loudly instead of a silent missing binary.
async function writeRedisPlaceholder(lock, platform, packBin) {
  const source = lock.sources.redis;
  if (source.status === "resolved" && source.variants[platform]) {
    fail("redis source is marked resolved but fetching it is not implemented; extend this script");
  }
  const stub = `#!/bin/sh
# Redis placeholder for this runtime pack (platform: ${platform}).
# No trustworthy portable Redis darwin binary distribution exists yet; the
# decision and its re-evaluation triggers are recorded in
# pack-sources.lock.json (sources.redis) and the README "Runtime pack" section.
echo "redis-server: NOT INCLUDED in this runtime pack (${platform})." >&2
echo "Redis darwin distribution is an open TODO: pack-sources.lock.json sources.redis.status=${source.status}." >&2
echo "Point the sidecar at an external Redis/Valkey on 127.0.0.1:6379, or replace this" >&2
echo "stub with a real binary." >&2
exit 78
`;
  const target = path.join(packBin, "redis-server");
  await fs.writeFile(target, stub, { mode: 0o755 });
  return { url: null, version: "todo (placeholder stub)", sha256: null };
}

function configTemplate(packName) {
  return `# Sub2API configuration template shipped with ${packName}.
# Copy to config.yaml and replace every CHANGE_ME before first start.
#
# Directory contract (DSH sidecar):
#   - This pack directory holds binaries only and is replaced on upgrade.
#     本包目录只放二进制，升级时整包替换。
#   - All mutable state lives in the data directory $DSH_HOME/sub2api/data,
#     kept separate from the binary directory above.
#     全部可变状态落在数据目录 $DSH_HOME/sub2api/data，与二进制目录分离。
#
# Field semantics follow upstream deploy/config.example.yaml of Wei-Shaw/sub2api.

# simple: hide SaaS billing features; standard: full SaaS mode
run_mode: "simple"

server:
  host: "127.0.0.1"
  port: 8080
  mode: "release"

database:
  host: "127.0.0.1"
  port: 5432
  user: "postgres"
  password: "CHANGE_ME"
  dbname: "sub2api"
  sslmode: "disable"

redis:
  host: "127.0.0.1"
  port: 6379
  username: ""
  password: ""
  db: 0

jwt:
  secret: "CHANGE_ME"
  expire_hour: 24
`;
}

async function writeSha256Sums(packDir, outputFile) {
  const { files } = await walk(packDir);
  const lines = [];
  for (const file of files) {
    const relative = path.relative(packDir, file).split(path.sep).join("/");
    lines.push(`${await sha256File(file)}  ${relative}`);
  }
  lines.sort();
  await fs.writeFile(outputFile, `${lines.join("\n")}\n`);
  return lines.length;
}

async function normalizeTree(packDir) {
  const { dirs, files } = await walk(packDir);
  for (const dir of dirs) {
    await fs.chmod(dir, 0o755);
    await fs.utimes(dir, FIXED_MTIME, FIXED_MTIME);
  }
  for (const file of files) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      // The link carries its own mtime in tar headers; normalize it via lutimes.
      await fs.lutimes(file, FIXED_MTIME, FIXED_MTIME);
      continue;
    }
    if (!(stat.mode & 0o111)) await fs.chmod(file, 0o644);
    await fs.utimes(file, FIXED_MTIME, FIXED_MTIME);
  }
  return { dirs, files };
}

async function tarFlavor() {
  const child = spawn("tar", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  await new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
  return stdout.includes("bsdtar") ? "bsdtar" : "gnu";
}

// Member list order, zeroed ownership, fixed mtimes, and gzip -n together make
// the tarball bytes depend only on the assembled pack content.
async function createTarball(packDir, tarballPath, members) {
  const flavor = await tarFlavor();
  const normalize =
    flavor === "bsdtar"
      ? ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
      : ["--owner=0", "--group=0", "--numeric-owner"];
  const env = { ...process.env, COPYFILE_DISABLE: "1", TZ: "UTC" };
  const tar = spawn("tar", ["-cf", "-", ...normalize, "-C", packDir, ...members], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gzip = spawn("gzip", ["-n"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const out = createWriteStream(tarballPath);
  tar.stdout.pipe(gzip.stdin);
  gzip.stdout.pipe(out);
  let tarStderr = "";
  tar.stderr.on("data", (chunk) => {
    tarStderr += chunk;
  });
  const closed = Promise.all([
    new Promise((resolve, reject) => {
      tar.on("close", resolve);
      tar.on("error", reject);
    }),
    new Promise((resolve, reject) => {
      gzip.on("close", resolve);
      gzip.on("error", reject);
    }),
    new Promise((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    }),
  ]);
  const [tarCode, gzipCode] = await closed;
  if (tarCode !== 0) fail(`tar failed (exit ${tarCode})\n${tarStderr}`);
  if (gzipCode !== 0) fail(`gzip failed (exit ${gzipCode})`);
}

async function main() {
  requireNode22();
  const cli = parseCli();
  const lock = await loadLock();
  const platform = resolvePlatform(lock, cli.os, cli.arch);
  const fullCli = { ...cli, platform };
  const version = cli.sub2apiVersion || lock.sources.sub2api.defaultVersion;
  if ((cli.sub2apiBinary === null) !== (cli.sub2apiSourceRef === null)) {
    fail("--sub2api-binary and --sub2api-source-ref must be provided together");
  }
  if (cli.baseRuntimePack !== null && cli.sub2apiBinary === null) {
    fail("--base-runtime-pack requires --sub2api-binary and --sub2api-source-ref");
  }

  const packName = `runtime-pack-${version}-${cli.os}-${cli.arch}`;
  const workDir = path.join(cli.distDir, ".work");
  // Tarball members live under the top-level packName/ directory so an
  // extraction never splatters files into the caller's cwd.
  const packDir = path.join(workDir, "pack", packName);
  const packBin = path.join(packDir, "bin");
  const packShare = path.join(packDir, "share");
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(path.join(workDir, "downloads"), { recursive: true });
  await fs.mkdir(packBin, { recursive: true });
  await fs.mkdir(packShare, { recursive: true });

  if (cli.baseRuntimePack !== null) await seedFromBaseRuntimePack(cli.baseRuntimePack, workDir, packDir);
  const sub2api = cli.sub2apiBinary === null
    ? await fetchSub2api(lock, fullCli, version, workDir, packBin)
    : await installLocalSub2api(cli.sub2apiBinary, cli.sub2apiSourceRef, version, packBin);
  const postgresql = cli.baseRuntimePack === null
    ? await fetchPostgresql(lock, fullCli, workDir, packDir)
    : { url: `base runtime pack ${path.basename(cli.baseRuntimePack)}`, version: lock.sources.postgresql.version };
  const redis = cli.baseRuntimePack === null
    ? await writeRedisPlaceholder(lock, platform, packBin)
    : { url: null, version: "from verified base runtime pack", sha256: null };
  await fs.writeFile(path.join(packShare, "config.template.yaml"), configTemplate(packName));
  await fs.writeFile(path.join(packShare, "runtime-provenance.json"), `${JSON.stringify({
    formatVersion: 1,
    sub2api: {
      version: sub2api.version,
      sourceRef: sub2api.sourceRef,
      binarySha256: sub2api.binarySha256,
      archiveSha256: sub2api.archiveSha256,
    },
  }, null, 2)}\n`);

  const sumsPath = path.join(packDir, "SHA256SUMS");
  const packedFiles = await writeSha256Sums(packDir, sumsPath);
  console.log(`[pack] SHA256SUMS written for ${packedFiles} files`);

  const { dirs, files } = await normalizeTree(packDir);
  const tarRoot = path.join(workDir, "pack");
  const members = [...dirs, ...files].map((member) =>
    path.relative(tarRoot, member).split(path.sep).join("/"),
  );
  const tarball = path.join(cli.distDir, `${packName}.tar.gz`);
  await createTarball(tarRoot, tarball, members);

  const tarballSha = await sha256File(tarball);
  const distSums = path.join(cli.distDir, "SHA256SUMS");
  await fs.writeFile(distSums, `${tarballSha}  ${path.basename(tarball)}\n`);

  if (!cli.keepWork) await fs.rm(workDir, { recursive: true, force: true });

  console.log(
    `
runtime pack built: ${tarball}
  sha256: ${tarballSha}
  checksums: ${distSums}
components:
  sub2api     ${sub2api.version}  ${sub2api.sourceRef}
  postgresql  ${postgresql.version}  ${postgresql.url}
  redis       ${redis.version}  (no darwin distribution; see pack-sources.lock.json sources.redis)
`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
