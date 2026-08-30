#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { operationContract } from "./strong-operation-contract.mjs";
import { readStableRegular } from "./strong-operation-files.mjs";
import { assertPlanNotBlocked } from "./risk-intake.mjs";

export const RUNNER_BUNDLE_VERSION = "3";
export const ARTIFACT_HANDOFF_SCHEMA_VERSION = 1;
export const EMPTY_SOURCE_TREE_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256 = /^[a-f0-9]{64}$/;
const CONSUMER_KINDS = new Set(["test", "native-exec", "browser-smoke"]);
const BINDING_KEYS = ["schemaVersion", "operationId", "roleKey", "operationContractSha256", "sourceTreeSha256", "image", "receiptSha256", "evidenceBindingSha256", "artifactTreeSha256", "rebuildPolicy"];
const SIDECAR_KEYS = ["schemaVersion", "source", "evidence", "artifact", "preflightSource", "preflightEvidence", "preflightArtifact"];
const exact = (value, keys, label) => { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} schema fields are not exact`); };
const canonical = value => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new Error("artifact contracts allow only safe integer numbers"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new Error(`unsupported artifact contract value: ${typeof value}`);
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const artifactHandoffBindingSha256 = binding => hash(Buffer.from(`JBS_ARTIFACT_HANDOFF_V1\0${canonical(binding)}`));

export function validateArtifactInputShape(binding, label = "artifactInput") {
  exact(binding, BINDING_KEYS, label);
  if (binding.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9._-]*$/.test(binding.operationId ?? "") || !/^[a-z0-9][a-z0-9._-]*$/.test(binding.roleKey ?? "") || ![binding.operationContractSha256, binding.sourceTreeSha256, binding.receiptSha256, binding.evidenceBindingSha256, binding.artifactTreeSha256].every(value => SHA256.test(value ?? "")) || typeof binding.image !== "string" || !binding.image.includes("@sha256:") || binding.rebuildPolicy !== "forbidden") throw new Error(`${label} binding fields are invalid`);
  return binding;
}
export function validateArtifactConsumer(plan, consumer, index) {
  const binding = validateArtifactInputShape(consumer.artifactInput, `operations[${index}].artifactInput`), producerIndex = plan.operations.findIndex(operation => operation.id === binding.operationId), producer = plan.operations[producerIndex];
  if (producerIndex < 0 || producerIndex >= index || !producer?.roleKey || producer.roleKey !== binding.roleKey) throw new Error(`operations[${index}].artifactInput must bind one earlier strong producer operation and role`);
  if (producer.artifactInput !== undefined) throw new Error(`operations[${index}].artifactInput producer chains are not supported`);
  if (!producer.outputs?.some(output => output.kind === "artifact")) throw new Error(`operations[${index}].artifactInput producer must declare artifact output`);
  if (producer.sourceTreeSha256 !== binding.sourceTreeSha256 || producer.image !== binding.image) throw new Error(`operations[${index}].artifactInput producer source/image binding mismatch`);
  if (operationContract(plan, producer.id).operationContractSha256 !== binding.operationContractSha256) throw new Error(`operations[${index}].artifactInput producer contract binding mismatch`);
  if (consumer.sourceTreeSha256 !== EMPTY_SOURCE_TREE_SHA256 || consumer.network !== "disabled" || !CONSUMER_KINDS.has(consumer.kind)) throw new Error(`operations[${index}].artifactInput requires empty source, disabled network, and consume-only test/native-exec/browser-smoke kind`);
}
const REBUILD_COMMAND = /(^|[;&|]\s*|\n\s*)(?:npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+build|cargo\s+build|zig\s+build|go\s+build|make(?:\s|$)|cmake\s+--build|(?:gcc|g\+\+|clang|rustc|javac)\s)/im;
export function containsRebuildCommand(bytes) {
  return REBUILD_COMMAND.test(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
}
export function assertConsumeOnlyScript(bytes) {
  if (containsRebuildCommand(bytes)) throw new Error("artifact-only consumer script contains an undeclared rebuild command; rebuildPolicy=forbidden is a reviewed consume-only policy");
}
function safeRel(rel) { return typeof rel === "string" && rel && !path.posix.isAbsolute(rel) && !rel.split("/").some(part => !part || part === "." || part === "..") && !/[\0\n\r]/.test(rel); }
export function scanArtifactTree(root, { maxEntries, maxBytes, maxFileSize, destination = null }) {
  if (![maxEntries, maxBytes, maxFileSize].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("artifact tree limits must be positive safe integers");
  const supplied = fs.lstatSync(root, { bigint: true });
  if (!supplied.isDirectory() || supplied.isSymbolicLink()) throw new Error("artifact root must be a non-symlink directory");
  const rootAbs = fs.realpathSync(root), rootStat = fs.lstatSync(rootAbs, { bigint: true }), rootMode = Number(rootStat.mode & 0o777n);
  if (destination) { fs.mkdirSync(destination, { mode: rootMode }); fs.chmodSync(destination, rootMode); }
  const entries = []; let seen = 0, total = 0;
  function walk(dir, relDir = "") {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      seen += 1; if (seen > maxEntries) throw new Error(`artifact tree exceeds max entries: ${maxEntries}`);
      const full = path.join(dir, name), rel = relDir ? `${relDir}/${name}` : name;
      if (!safeRel(rel)) throw new Error(`unsafe artifact path: ${JSON.stringify(rel)}`);
      const before = fs.lstatSync(full, { bigint: true });
      if (before.isSymbolicLink()) throw new Error(`artifact tree must not contain symlinks: ${rel}`);
      const mode = Number(before.mode & 0o777n);
      if (before.isDirectory()) {
        entries.push({ path: rel, type: "directory", mode, sizeBytes: 0, sha256: null });
        if (destination) fs.mkdirSync(path.join(destination, ...rel.split("/")), { mode });
        walk(full, rel); continue;
      }
      if (!before.isFile() || before.nlink !== 1n) throw new Error(`artifact tree contains a special or hard-linked file: ${rel}`);
      if (before.size > BigInt(maxFileSize)) throw new Error(`artifact file exceeds maxFileSizeBytes: ${rel}`);
      const bytes = readStableRegular(full, `artifact ${rel}`, maxFileSize).bytes;
      total += bytes.length; if (total > maxBytes) throw new Error(`artifact tree exceeds maxOutputBytes: ${maxBytes}`);
      const after = fs.lstatSync(full, { bigint: true });
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`artifact changed while reading: ${rel}`);
      entries.push({ path: rel, type: "file", mode, sizeBytes: bytes.length, sha256: hash(bytes) });
      if (destination) { const out = path.join(destination, ...rel.split("/")); fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 }); fs.writeFileSync(out, bytes, { flag: "wx", mode }); fs.chmodSync(out, mode); }
    }
  }
  walk(rootAbs); entries.sort((a, b) => a.path.localeCompare(b.path));
  const tree = hash(Buffer.from(`JBS_ARTIFACT_TREE_V1\0${canonical({ rootMode, entries })}`));
  return { artifactTreeSha256: tree, rootMode, entryCount: entries.length, totalBytes: total, entries };
}
function readSidecar(file, maxBytes) {
  const bytes = readStableRegular(file, "producer handoff sidecar", maxBytes).bytes; let value;
  try { value = JSON.parse(bytes); } catch (error) { throw new Error(`producer handoff sidecar JSON is malformed: ${error.message}`); }
  exact(value, SIDECAR_KEYS, "producer handoff sidecar");
  if (value.schemaVersion !== 1) throw new Error("producer handoff sidecar schemaVersion must be 1");
  for (const key of SIDECAR_KEYS.slice(1)) if (value[key] !== null && (typeof value[key] !== "string" || !path.isAbsolute(value[key]))) throw new Error(`producer handoff sidecar ${key} must be null or an absolute path`);
  if (!value.source || !value.evidence || !value.artifact) throw new Error("producer handoff sidecar requires source, evidence, and artifact paths");
  return value;
}
function producerValidation(planPath, producer, sidecar) {
  const args = [new URL("./validate-operation-evidence.mjs", import.meta.url).pathname, "--plan", planPath, "--operation-id", producer.id, "--source", sidecar.source, "--evidence", sidecar.evidence, "--artifact", sidecar.artifact];
  if (sidecar.preflightSource) args.push("--preflight-source", sidecar.preflightSource);
  if (sidecar.preflightEvidence) args.push("--preflight-evidence", sidecar.preflightEvidence);
  if (sidecar.preflightArtifact) args.push("--preflight-artifact", sidecar.preflightArtifact);
  try { return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })); }
  catch (error) { throw new Error(`producer evidence is not reusable: ${error.stderr || error.message}`); }
}
export function producerBindingFromValidated({ plan, producer, reusable, evidenceRoot, artifactRoot }) {
  assertPlanNotBlocked(plan, "artifact producer binding");
  if (producer.artifactInput !== undefined) throw new Error("producer chains are not supported");
  const receipt = path.join(evidenceRoot, "operation-receipt.json"), receiptSha256 = hash(readStableRegular(receipt, "producer receipt", plan.limits.maxFileSizeBytes).bytes), artifact = scanArtifactTree(artifactRoot, { maxEntries: plan.limits.maxSourceEntries, maxBytes: plan.limits.maxOutputBytes, maxFileSize: plan.limits.maxFileSizeBytes });
  return validateArtifactInputShape({ schemaVersion: 1, operationId: producer.id, roleKey: producer.roleKey, operationContractSha256: reusable.operationContractSha256, sourceTreeSha256: reusable.sourceTreeSha256, image: producer.image, receiptSha256, evidenceBindingSha256: reusable.evidenceBindingSha256, artifactTreeSha256: artifact.artifactTreeSha256, rebuildPolicy: "forbidden" });
}
export function resolveArtifactHandoff({ planPath, plan, consumer, handoffPath, snapshotDestination = null, beforeSnapshot = null }) {
  assertPlanNotBlocked(plan, "artifact handoff");
  if (!consumer.artifactInput) throw new Error("consumer operation does not declare artifactInput");
  const binding = validateArtifactInputShape(consumer.artifactInput), sidecar = readSidecar(handoffPath, plan.limits.maxFileSizeBytes), producer = plan.operations.find(operation => operation.id === binding.operationId);
  if (!producer) throw new Error("artifactInput producer operation is missing");
  const reusable = producerValidation(planPath, producer, sidecar), actual = producerBindingFromValidated({ plan, producer, reusable, evidenceRoot: sidecar.evidence, artifactRoot: sidecar.artifact });
  if (canonical(actual) !== canonical(binding)) throw new Error("producer handoff binding does not match current producer evidence/artifact bytes");
  if (snapshotDestination) {
    if (beforeSnapshot !== null) {
      if (typeof beforeSnapshot !== "function") throw new Error("beforeSnapshot must be a function when supplied by a direct module caller");
      beforeSnapshot({ artifactRoot: sidecar.artifact, snapshotDestination });
    }
    const limits = { maxEntries: plan.limits.maxSourceEntries, maxBytes: plan.limits.maxOutputBytes, maxFileSize: plan.limits.maxFileSizeBytes }, snapshot = scanArtifactTree(sidecar.artifact, { ...limits, destination: snapshotDestination }), copied = scanArtifactTree(snapshotDestination, limits);
    if (snapshot.artifactTreeSha256 !== binding.artifactTreeSha256 || copied.artifactTreeSha256 !== binding.artifactTreeSha256) throw new Error("private producer artifact snapshot hash mismatch");
  }
  return { binding, sidecar, handoffBindingSha256: artifactHandoffBindingSha256(binding) };
}
