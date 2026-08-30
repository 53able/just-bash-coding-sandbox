#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, opendir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveRiskDecision, riskDecisionSha256 } from "./risk-intake.mjs";

export const RUNNER_BUNDLE_VERSION = "3";
export const OPERATION_CONTRACT_SCHEMA_VERSION = 2;
export const STRONG_OPERATION_KINDS = new Set(["build", "test", "package-install", "native-exec", "repository-script", "browser-preflight", "browser-smoke"]);
const SHA256 = /^[a-f0-9]{64}$/;

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("operation contracts allow only safe integer numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  throw new Error(`unsupported operation contract value: ${typeof value}`);
}

export function operationContract(plan, operationId) {
  const matches = (plan.operations ?? []).filter(operation => operation.id === operationId);
  if (matches.length !== 1 || !STRONG_OPERATION_KINDS.has(matches[0].kind)) throw new Error(`operation ID must select exactly one strong operation: ${operationId}`);
  const operation = matches[0];
  const riskDecision = deriveRiskDecision(plan);
  const contract = {
    operationContractSchemaVersion: OPERATION_CONTRACT_SCHEMA_VERSION,
    workflowId: plan.workflowId,
    roleKey: operation.roleKey,
    id: operation.id,
    kind: operation.kind,
    command: operation.command,
    image: operation.image,
    scriptSha256: operation.scriptSha256,
    path: operation.path,
    requiredTools: operation.requiredTools,
    network: operation.network,
    timeoutMs: operation.timeoutMs ?? plan.limits.timeoutMs,
    resources: operation.resources ?? { cpus: 2, memory: "2G" },
    oracles: operation.oracles,
    outputs: operation.outputs,
    runner: operation.kind === "browser-preflight" || operation.kind === "browser-smoke" ? operation.runner : null,
    viewports: operation.kind === "browser-preflight" || operation.kind === "browser-smoke" ? operation.viewports : null,
    preflightOperationId: operation.kind === "browser-smoke" ? (operation.preflightOperationId ?? null) : null,
    ...(operation.browserRole === undefined ? {} : { browserRole: operation.browserRole }),
    ...(operation.artifactInput === undefined ? {} : { artifactInput: operation.artifactInput }),
    ...(riskDecision === null ? {} : { riskDecision, riskDecisionSha256: riskDecisionSha256(riskDecision) }),
    sourceLimits: { maxSourceEntries: plan.limits.maxSourceEntries, maxSourceBytes: plan.limits.maxSourceBytes },
    outputLimits: { maxFileSizeBytes: plan.limits.maxFileSizeBytes, maxOutputBytes: plan.limits.maxOutputBytes },
  };
  const bytes = Buffer.from(canonicalize(contract), "utf8");
  return { contract, operationContractSha256: createHash("sha256").update(bytes).digest("hex") };
}

async function scanSourceTree(root, { maxEntries, maxBytes, destination = null }) {
  const rootAbs = resolve(root), destinationAbs = destination ? resolve(destination) : null;
  const rootStat = await lstat(rootAbs);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`source root must be a regular directory: ${root}`);
  if (destinationAbs) { const mode = rootStat.mode & 0o777; await mkdir(destinationAbs, { mode }); await chmod(destinationAbs, mode); }
  const entries = []; let totalBytes = 0, seenEntries = 0;
  const addEntry = entry => { entries.push(entry); };
  async function walk(directory, relativeDirectory = "") {
    const dirents = [], directoryHandle = await opendir(directory);
    for await (const dirent of directoryHandle) { seenEntries += 1; if (seenEntries > maxEntries) throw new Error(`source tree exceeds max entries: ${maxEntries}`); dirents.push(dirent); }
    dirents.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const dirent of dirents) {
      const full = resolve(directory, dirent.name), rel = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      if (!rel || rel.startsWith("../") || rel === ".." || /[\0\n\r]/.test(rel)) throw new Error(`unsafe source-tree path: ${JSON.stringify(rel)}`);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`source tree must not contain symlinks: ${rel}`);
      if (stat.isDirectory()) {
        addEntry({ path: rel, type: "directory", mode: stat.mode & 0o777, sizeBytes: 0, sha256: null });
        if (destinationAbs) { const outputDirectory = resolve(destinationAbs, ...rel.split("/")), mode = stat.mode & 0o777; await mkdir(outputDirectory, { mode }); await chmod(outputDirectory, mode); }
        await walk(full, rel); continue;
      }
      if (!stat.isFile()) throw new Error(`source tree contains a non-regular entry: ${rel}`);
      const handle = await open(full, "r");
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw new Error(`source tree must not contain hard-linked/non-regular files: ${rel}`);
        if (before.size > BigInt(maxBytes - totalBytes)) throw new Error(`source tree exceeds max bytes: ${maxBytes}`);
        const mode = Number(before.mode & 0o777n), hasher = createHash("sha256"), sourceStream = handle.createReadStream({ autoClose: false });
        let outputHandle = null, bytesRead = 0;
        if (destinationAbs) outputHandle = await open(resolve(destinationAbs, ...rel.split("/")), "wx", mode);
        try {
          for await (const chunk of sourceStream) {
            bytesRead += chunk.length; totalBytes += chunk.length;
            if (totalBytes > maxBytes) throw new Error(`source tree exceeds max bytes while reading: ${maxBytes}`);
            hasher.update(chunk); if (outputHandle) await outputHandle.write(chunk);
          }
        } finally { if (outputHandle) await outputHandle.close(); }
        const after = await handle.stat({ bigint: true });
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytesRead) !== after.size) throw new Error(`source file changed while reading: ${rel}`);
        const sha256 = hasher.digest("hex"); addEntry({ path: rel, type: "file", mode, sizeBytes: bytesRead, sha256 });
        if (destinationAbs) await chmod(resolve(destinationAbs, ...rel.split("/")), mode);
      } finally { await handle.close(); }
    }
  }
  await walk(rootAbs);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); const hasher = createHash("sha256");
  for (const entry of entries) { for (const value of [entry.path, entry.type, String(entry.mode), String(entry.sizeBytes), entry.sha256 ?? "-"]) { hasher.update(Buffer.from(value)); hasher.update(Buffer.from([0])); } }
  return { sourceTreeSha256: hasher.digest("hex"), entryCount: entries.length, totalBytes, entries };
}
export async function hashSourceTree(root, { maxEntries = 100000, maxBytes = Number.MAX_SAFE_INTEGER } = {}) { return scanSourceTree(root, { maxEntries, maxBytes }); }
export async function snapshotSourceTree(source, destination, { maxEntries, maxBytes }) {
  const original = await scanSourceTree(source, { maxEntries, maxBytes, destination });
  const snapshot = await scanSourceTree(destination, { maxEntries, maxBytes });
  if (original.sourceTreeSha256 !== snapshot.sourceTreeSha256) throw new Error("private source snapshot does not match descriptor-pinned source bytes");
  return { original, snapshot };
}

function fail(message) { console.error(`ERROR: ${message}`); process.exit(1); }
async function cli() {
  const [command, ...args] = process.argv.slice(2);
  const readArg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  if (command === "hash-tree") {
    const root = readArg("--root"); if (!root) fail("Usage: node scripts/strong-operation-contract.mjs hash-tree --root <directory> [--max-entries N --max-bytes N]");
    const maxEntries = readArg("--max-entries") === undefined ? 100000 : Number(readArg("--max-entries"));
    const maxBytes = readArg("--max-bytes") === undefined ? Number.MAX_SAFE_INTEGER : Number(readArg("--max-bytes"));
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("hash-tree limits must be positive safe integers");
    console.log(JSON.stringify(await hashSourceTree(root, { maxEntries, maxBytes }), null, 2)); return;
  }
  if (command === "snapshot") {
    const source = readArg("--source"), destination = readArg("--destination");
    const maxEntries = Number(readArg("--max-entries")), maxBytes = Number(readArg("--max-bytes"));
    if (!source || !destination || !Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("Usage: node scripts/strong-operation-contract.mjs snapshot --source <dir> --destination <absent-path> --max-entries N --max-bytes N");
    console.log(JSON.stringify(await snapshotSourceTree(source, destination, { maxEntries, maxBytes }), null, 2)); return;
  }
  if (command === "contract") {
    const planPath = readArg("--plan"), operationId = readArg("--operation-id");
    if (!planPath || !operationId) fail("Usage: node scripts/strong-operation-contract.mjs contract --plan <plan.json> --operation-id <id>");
    const plan = JSON.parse(await readFile(planPath, "utf8")); console.log(JSON.stringify(operationContract(plan, operationId), null, 2)); return;
  }
  if (command === "verify-sha") {
    const value = readArg("--sha256"); if (!SHA256.test(value ?? "")) fail("--sha256 must be 64 lowercase hexadecimal characters"); console.log(value); return;
  }
  fail("Usage: node scripts/strong-operation-contract.mjs <hash-tree|snapshot|contract|verify-sha> ...");
}
async function isDirectCli() { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href; } catch { return false; } }
if (await isDirectCli()) cli().catch(error => fail(error.stack ?? error.message));
