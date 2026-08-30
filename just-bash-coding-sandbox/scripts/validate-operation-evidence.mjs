#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, opendir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePlan } from "./validate-execution-plan.mjs";
import { assertPlanNotBlocked } from "./risk-intake.mjs";
import { hashSourceTree, operationContract, OPERATION_CONTRACT_SCHEMA_VERSION } from "./strong-operation-contract.mjs";
import { producerBindingFromValidated, resolveArtifactHandoff } from "./artifact-handoff-contract.mjs";

function fail(message, code = 1) { console.error(`ERROR: ${message}`); process.exit(code); }
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const planPath = arg("--plan"), operationId = arg("--operation-id"), sourceRoot = arg("--source"), evidenceRoot = arg("--evidence"), artifactRoot = arg("--artifact"), preflightSource = arg("--preflight-source"), preflightEvidence = arg("--preflight-evidence"), preflightArtifact = arg("--preflight-artifact"), producerHandoff = arg("--producer-handoff"), emitProducerBinding = arg("--emit-producer-binding") === "true";
if (!planPath || !operationId || !sourceRoot || !evidenceRoot) fail("Usage: node scripts/validate-operation-evidence.mjs --plan <plan.json> --operation-id <id> --source <dir> --evidence <dir> [--artifact <dir>] [--preflight-source <dir> --preflight-evidence <dir> [--preflight-artifact <dir>]] [--producer-handoff <sidecar>] [--emit-producer-binding true]", 2);

const planBytes = await readFile(planPath);
let plan;
try { plan = JSON.parse(planBytes.toString("utf8")); } catch (error) { fail(`Cannot parse plan: ${error.message}`, 2); }
const validation = validatePlan(plan);
if (validation.errors.length) fail(`Current plan is invalid: ${validation.errors.join(" ")}`, 2);
try { assertPlanNotBlocked(plan, "operation evidence reuse"); } catch (error) { fail(error.message, 2); }
const operation = plan.operations.find(value => value.id === operationId);
if (!operation) fail(`Operation is missing from current plan: ${operationId}`, 2);
const { operationContractSha256 } = operationContract(plan, operationId);
const source = await hashSourceTree(sourceRoot, { maxEntries: plan.limits.maxSourceEntries, maxBytes: plan.limits.maxSourceBytes });
if (operation.sourceTreeSha256 === null) fail(`Current operation sourceTreeSha256 is unbound: ${operationId}`, 2);
if (source.sourceTreeSha256 !== operation.sourceTreeSha256) fail(`Current source tree SHA-256 mismatch: plan=${operation.sourceTreeSha256} actual=${source.sourceTreeSha256}`);

async function readRegular(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label} must be a regular non-symlink non-hardlink file`);
  return readFile(path);
}
const statusPath = resolve(evidenceRoot, "operation-status.json");
const receiptPath = resolve(evidenceRoot, "operation-receipt.json");
const statusBytes = await readRegular(statusPath, "operation-status.json");
const receiptBytes = await readRegular(receiptPath, "operation-receipt.json");
let status, receipt;
try { status = JSON.parse(statusBytes); receipt = JSON.parse(receiptBytes); } catch (error) { fail(`Evidence JSON is malformed: ${error.message}`); }
function exactKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} schema fields are not exact`); }
exactKeys(status, ["schemaVersion","status","exitCode","authority","provenance","operationId","workflowId","roleKey","planSha256","operationContractSchemaVersion","operationContractSha256","sourceTreeSha256","preflightEvidenceSha256","scriptSha256","image","network"], "operation status");
exactKeys(receipt, ["schemaVersion","authority","provenance","operationId","workflowId","roleKey","historicalPlanSha256","operationContractSchemaVersion","operationContractSha256","sourceTreeSha256","statusSha256","startedAtUtc","endedAtUtc","elapsedMs","resources","outputs"], "operation receipt");
if (status.schemaVersion !== 2 || status.status !== "succeeded" || status.exitCode !== 0 || status.authority !== "host" || status.provenance !== "container-exit-attestation") fail("Only successful schema-version-2 host container-exit attestation is reusable");
let expectedPreflightSha256 = "0".repeat(64);
if (Boolean(operation.artifactInput) !== Boolean(producerHandoff)) fail("artifactInput and --producer-handoff must be supplied together", 2);
if (operation.kind === "browser-smoke") {
  if (!preflightSource || !preflightEvidence) fail("browser-smoke evidence reuse requires --preflight-source and --preflight-evidence");
  const childArgs = [process.argv[1], "--plan", planPath, "--operation-id", operation.preflightOperationId, "--source", preflightSource, "--evidence", preflightEvidence]; if (preflightArtifact) childArgs.push("--artifact", preflightArtifact);
  const { stdout } = await promisify(execFile)(process.execPath, childArgs, { encoding: "utf8", maxBuffer: 1024 * 1024 }); expectedPreflightSha256 = JSON.parse(stdout).evidenceBindingSha256;
} else if (preflightSource || preflightEvidence || preflightArtifact) fail("preflight evidence arguments are allowed only when validating browser-smoke evidence");
if (status.operationId !== operationId || status.workflowId !== plan.workflowId || status.roleKey !== operation.roleKey || status.operationContractSchemaVersion !== OPERATION_CONTRACT_SCHEMA_VERSION || status.operationContractSha256 !== operationContractSha256 || status.sourceTreeSha256 !== source.sourceTreeSha256 || status.preflightEvidenceSha256 !== expectedPreflightSha256) fail("Operation status does not match current workflow/role/operation contract/source/preflight evidence");
if (status.scriptSha256 !== operation.scriptSha256 || status.image !== operation.image || status.network !== operation.network) fail("Operation status execution binding mismatch");
if (receipt.schemaVersion !== 2 || receipt.authority !== "host" || receipt.provenance !== "post-execution-output-validation") fail("Operation receipt schema/authority mismatch");
if (receipt.operationId !== operationId || receipt.workflowId !== plan.workflowId || receipt.roleKey !== operation.roleKey || receipt.operationContractSchemaVersion !== OPERATION_CONTRACT_SCHEMA_VERSION || receipt.operationContractSha256 !== operationContractSha256 || receipt.sourceTreeSha256 !== source.sourceTreeSha256) fail("Operation receipt workflow/role/contract/source mismatch");
if (receipt.historicalPlanSha256 !== status.planSha256) fail("Operation receipt historical plan SHA does not match status provenance");
if (JSON.stringify(receipt.resources) !== JSON.stringify(operation.resources)) fail("Operation receipt resources do not match current operation contract");
if (receipt.statusSha256 !== createHash("sha256").update(statusBytes).digest("hex")) fail("Operation status bytes do not match receipt");
const startedAt = Date.parse(receipt.startedAtUtc), endedAt = Date.parse(receipt.endedAtUtc);
if (!Number.isInteger(receipt.elapsedMs) || receipt.elapsedMs < 0 || !Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) fail("Operation receipt timing fields are invalid");

const expected = new Map(operation.outputs.map(value => [`${value.kind}:${value.path}`, value]));
if (!Array.isArray(receipt.outputs) || receipt.outputs.length !== expected.size) fail("Operation receipt output count mismatch");
const seen = new Set();
for (const entry of receipt.outputs) {
  exactKeys(entry, ["kind","path","sizeBytes","sha256"], "operation receipt output");
  const key = `${entry.kind}:${entry.path}`;
  if (!expected.has(key) || seen.has(key)) fail(`Operation receipt has unexpected or duplicate output: ${key}`);
  seen.add(key);
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) fail(`Operation receipt entry is invalid: ${key}`);
  const root = entry.kind === "evidence" ? evidenceRoot : artifactRoot;
  if (!root) fail(`Artifact root is required for receipted output: ${entry.path}`);
  const bytes = await readRegular(resolve(root, ...entry.path.split("/")), key);
  if (bytes.length !== entry.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) fail(`Operation output no longer matches receipt: ${key}`);
}
for (const key of expected.keys()) if (!seen.has(key)) fail(`Operation receipt is missing output: ${key}`);

async function exactFiles(root, allowed, label) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`${label} root must be a non-symlink directory`);
  const actual = [], allowedDirectories = new Set();
  for (const rel of allowed) { let current = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""; while (current) { allowedDirectories.add(current); current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : ""; } }
  const ceiling = allowed.size + allowedDirectories.size; let enumerated = 0;
  async function walk(directory, prefix = "") {
    const handle = await opendir(directory);
    for await (const dirent of handle) {
      enumerated += 1; if (enumerated > ceiling) fail(`${label} entry count exceeds expected file/directory ceiling`);
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const path = resolve(directory, dirent.name); const stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { if (!allowedDirectories.has(rel)) fail(`${label} contains unexpected directory: ${rel}`); await walk(path, rel); }
      else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) actual.push(rel);
      else fail(`${label} contains a non-regular, symlink, or hard-linked entry: ${rel}`);
    }
  }
  await walk(root);
  actual.sort(); const wanted = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} exact file set mismatch: expected=${wanted.join(",")} actual=${actual.join(",")}`);
}
await exactFiles(evidenceRoot, new Set([...operation.outputs.filter(value => value.kind === "evidence").map(value => value.path), "operation-status.json", "operation-receipt.json"]), "evidence");
if (operation.outputs.some(value => value.kind === "artifact")) await exactFiles(artifactRoot, new Set(operation.outputs.filter(value => value.kind === "artifact").map(value => value.path)), "artifact");
else if (artifactRoot) await exactFiles(artifactRoot, new Set(), "artifact");
let handoffBindingSha256 = null;
if (operation.artifactInput) handoffBindingSha256 = resolveArtifactHandoff({ planPath, plan, consumer: operation, handoffPath: producerHandoff }).handoffBindingSha256;
const evidenceBindingHasher = createHash("sha256");
for (const value of [plan.workflowId, operation.roleKey, operationId, operationContractSha256, source.sourceTreeSha256, receipt.statusSha256, ...(handoffBindingSha256 ? [handoffBindingSha256] : []), ...receipt.outputs.map(entry => `${entry.kind}:${entry.path}:${entry.sizeBytes}:${entry.sha256}`).sort()]) { evidenceBindingHasher.update(value); evidenceBindingHasher.update("\0"); }
const attemptBindingHasher = createHash("sha256");
for (const value of [operationContractSha256, source.sourceTreeSha256, expectedPreflightSha256, ...(handoffBindingSha256 ? [handoffBindingSha256] : [])]) { attemptBindingHasher.update(value); attemptBindingHasher.update("\0"); }
const reusable = { status: "EVIDENCE_REUSABLE", workflowId: plan.workflowId, roleKey: operation.roleKey, operationId, operationContractSha256, sourceTreeSha256: source.sourceTreeSha256, attemptBindingSha256: attemptBindingHasher.digest("hex"), evidenceBindingSha256: evidenceBindingHasher.digest("hex"), historicalPlanSha256: status.planSha256, currentPlanSha256: createHash("sha256").update(planBytes).digest("hex"), elapsedMs: receipt.elapsedMs };
if (emitProducerBinding) {
  if (!artifactRoot || operation.artifactInput !== undefined) fail("--emit-producer-binding requires a non-consumer operation with artifact evidence", 2);
  reusable.artifactInput = producerBindingFromValidated({ plan, producer: operation, reusable, evidenceRoot, artifactRoot });
}
console.log(JSON.stringify(reusable, null, 2));
