#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNNER_BUNDLE_VERSION = "3";
export const BUNDLE_FILES = [
  "artifact-handoff-contract.mjs",
  "risk-intake.mjs",
  "strong-operation-contract.mjs",
  "strong-operation-controller.mjs",
  "strong-operation-entrypoint.sh",
  "strong-operation-files.mjs",
  "strong-operation-process.mjs",
  "strong-operation-status.mjs",
  "verify-strong-operation-output.mjs",
];

function stable(a, b, length) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs &&
    BigInt(length) === b.size;
}
export function readStableRegular(
  file,
  label = "file",
  maxSize = Number.MAX_SAFE_INTEGER,
) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`${label} must be a single-link regular file`);
    }
    if (before.size > BigInt(maxSize)) {
      throw new Error(`${label} exceeds size limit`);
    }
    const bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd, { bigint: true });
    if (!stable(before, after, bytes.length)) {
      throw new Error(`${label} changed while being read`);
    }
    return { bytes, stat: after };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function writeExclusive(file, bytes, mode = 0o600) {
  fs.writeFileSync(file, bytes, { flag: "wx", mode });
}
export function snapshotFile(source, destination, mode = 0o500) {
  const { bytes } = readStableRegular(source, "snapshot source");
  writeExclusive(destination, bytes, mode);
  return bytes;
}
function versionFromBytes(name, bytes) {
  const text = bytes.toString("utf8");
  const match = name.endsWith(".sh")
    ? text.match(/^RUNNER_BUNDLE_VERSION=['"]?([^'"\n]+)['"]?$/m)
    : text.match(/export const RUNNER_BUNDLE_VERSION = ["']([^"']+)["'];/);
  if (!match) throw new Error(`runner bundle version is missing from ${name}`);
  return match[1];
}
export function snapshotBundle(sourceDir, destination, expectedVersion) {
  if (expectedVersion !== RUNNER_BUNDLE_VERSION) {
    throw new Error("launcher/files runner bundle version mismatch");
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  const hash = createHash("sha256");
  for (const name of BUNDLE_FILES) {
    const mode = name.endsWith(".sh") ? 0o500 : 0o400,
      bytes = snapshotFile(
        path.join(sourceDir, name),
        path.join(destination, name),
        mode,
      ),
      version = versionFromBytes(name, bytes);
    if (version !== expectedVersion) {
      throw new Error(
        `mixed runner bundle versions: ${name}=${version} expected=${expectedVersion}`,
      );
    }
    hash.update(name).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}
export function safeTree(root) {
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("publication tree root must be a non-symlink directory");
  }
  const hash = createHash("sha256");
  let entries = 0;
  function walk(dir, prefix = "") {
    for (const name of fs.readdirSync(dir).sort()) {
      if (/[\0\n\r]/.test(name)) throw new Error("unsafe publication path");
      const rel = prefix ? `${prefix}/${name}` : name,
        full = path.join(dir, name),
        stat = fs.lstatSync(full, { bigint: true });
      entries++;
      if (stat.isSymbolicLink()) {
        throw new Error(`publication tree contains link: ${rel}`);
      }
      if (stat.isDirectory()) {
        hash.update(rel).update("\0directory\0");
        walk(full, rel);
        continue;
      }
      const { bytes } = readStableRegular(full, `publication file ${rel}`);
      hash.update(rel).update("\0file\0").update(bytes).update("\0");
    }
  }
  walk(root);
  return { treeSha256: hash.digest("hex"), entries };
}
export function inspectEmptyDestination(destination) {
  const stat = fs.lstatSync(destination, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("publication destination must be a non-symlink directory");
  }
  if (fs.readdirSync(destination).length) {
    throw new Error("publication destination must be empty");
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export function publishTree(staging, destination, expectedIdentity) {
  const identity = inspectEmptyDestination(destination);
  if (
    identity.dev !== expectedIdentity.dev ||
    identity.ino !== expectedIdentity.ino
  ) throw new Error("publication destination identity changed");
  const tree = safeTree(staging);
  fs.rmdirSync(destination);
  try {
    fs.renameSync(staging, destination);
  } catch (error) {
    try {
      fs.mkdirSync(destination, { mode: 0o700 });
    } catch {}
    throw error;
  }
  const installed = fs.lstatSync(destination, { bigint: true });
  return {
    dev: String(installed.dev),
    ino: String(installed.ino),
    treeSha256: tree.treeSha256,
  };
}
export function rollbackTree(destination, quarantine, record) {
  const stat = fs.lstatSync(destination, { bigint: true });
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    String(stat.dev) !== record.dev || String(stat.ino) !== record.ino
  ) {
    throw new Error(
      "refusing rollback: installed destination identity changed",
    );
  }
  if (safeTree(destination).treeSha256 !== record.treeSha256) {
    throw new Error("refusing rollback: installed destination tree changed");
  }
  if (fs.existsSync(quarantine)) {
    throw new Error("rollback quarantine already exists");
  }
  fs.renameSync(destination, quarantine);
  try {
    fs.mkdirSync(destination, { mode: 0o700 });
  } catch (error) {
    try {
      fs.renameSync(quarantine, destination);
    } catch {}
    throw error;
  }
}
