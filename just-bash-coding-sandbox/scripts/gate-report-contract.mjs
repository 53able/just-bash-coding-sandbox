#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { validatePlan } from "./validate-execution-plan.mjs";
import { hashSourceTree, operationContract, STRONG_OPERATION_KINDS } from "./strong-operation-contract.mjs";
import { resolveArtifactHandoff } from "./artifact-handoff-contract.mjs";
import { operationStatus } from "./strong-operation-status.mjs";
import { assertPlanNotBlocked } from "./risk-intake.mjs";

export class GateReportError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }
const fail = (message, code = 1) => { throw new GateReportError(message, code); };
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const COST = new Map([["cheap", 0], ["standard", 1], ["expensive", 2]]);
const RETRY_CLASSIFICATIONS = new Set(["candidate", "binding", "tool", "image-runtime", "oracle", "output-contract", "preflight"]);
const ASSESSMENT_CLASSIFICATIONS = new Set(["environment", "candidate", "validator", "oracle", "output-contract", "unknown"]);
const DEFAULT_INPUT_LIMIT = 8 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} schema fields are not exact`, 2);
};
const canonical = value => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("gate contracts allow only safe integer numbers", 2); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  fail(`unsupported gate contract value: ${typeof value}`, 2);
};
const validReason = (value, limit) => typeof value === "string" && Boolean(value.trim()) && value.length <= limit;
const hashBinding = values => { const value = createHash("sha256"); for (const item of values) value.update(item).update("\0"); return value.digest("hex"); };

export async function readStableFile(file, label, maxBytes = DEFAULT_INPUT_LIMIT) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail(`${label} byte limit is invalid`, 2);
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) { fail(`${label} is unavailable: ${error.message}`, 2); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail(`${label} must be a bounded regular single-link file`, 2);
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== after.size) fail(`${label} changed while reading`, 2);
    return bytes;
  } finally { await handle.close(); }
}
async function readStableJson(file, label, maxBytes) {
  const bytes = await readStableFile(file, label, maxBytes);
  try { return { bytes, value: JSON.parse(bytes) }; } catch (error) { fail(`${label} JSON is malformed: ${error.message}`, 2); }
}

function validateGatePlan(gatePlan, plan, planSha256) {
  exact(gatePlan, ["schemaVersion", "workflowId", "planSha256", "gates"], "gate plan");
  if (gatePlan.schemaVersion !== 1 || gatePlan.workflowId !== plan.workflowId || gatePlan.planSha256 !== planSha256 || !Array.isArray(gatePlan.gates) || gatePlan.gates.length === 0) fail("gate plan does not bind the current workflow plan", 2);
  const strongOperations = plan.operations.filter(operation => STRONG_OPERATION_KINDS.has(operation.kind));
  const byOperation = new Map(strongOperations.map(operation => [operation.id, operation]));
  const seenGateIds = new Set(), seenRoles = new Set(), byGate = new Map(); let maximumPriorCost = -1;
  for (const [index, gate] of gatePlan.gates.entries()) {
    const label = `gate plan gates[${index}]`;
    exact(gate, ["id", "operationId", "roleKey", "costClass", "orderExceptionReason", "dependsOn"], label);
    if (!ID.test(gate.id ?? "") || seenGateIds.has(gate.id)) fail(`${label}.id must be unique and stable`, 2);
    const operation = byOperation.get(gate.operationId);
    if (!operation || operation.roleKey !== gate.roleKey || seenRoles.has(gate.roleKey)) fail(`${label} must bind one unique strong operation and role`, 2);
    if (!COST.has(gate.costClass)) fail(`${label}.costClass must be cheap, standard, or expensive`, 2);
    const rank = COST.get(gate.costClass), inverted = rank < maximumPriorCost;
    if (inverted ? !validReason(gate.orderExceptionReason, 500) : gate.orderExceptionReason !== null) fail(`${label}.orderExceptionReason must justify only a global cost-order inversion`, 2);
    if (!Array.isArray(gate.dependsOn)) fail(`${label}.dependsOn must be an array`, 2);
    const dependencyIds = new Set();
    for (const [edgeIndex, edge] of gate.dependsOn.entries()) {
      exact(edge, ["gateId", "exceptionReason"], `${label}.dependsOn[${edgeIndex}]`);
      if (!byGate.has(edge.gateId) || dependencyIds.has(edge.gateId)) fail(`${label} dependencies must be unique gates declared earlier`, 2);
      if (edge.exceptionReason !== null && !validReason(edge.exceptionReason, 500)) fail(`${label} edge exceptionReason must be null or a non-empty string up to 500 characters`, 2);
      dependencyIds.add(edge.gateId);
    }
    seenGateIds.add(gate.id); seenRoles.add(gate.roleKey); byGate.set(gate.id, gate); maximumPriorCost = Math.max(maximumPriorCost, rank);
  }
  if (seenRoles.size !== strongOperations.length || strongOperations.some(operation => !seenRoles.has(operation.roleKey))) fail("gate plan must cover every current workflow strong role exactly once", 2);
  const gateByOperation = new Map([...byGate.values()].map(gate => [gate.operationId, gate]));
  for (const gate of byGate.values()) { const operation = byOperation.get(gate.operationId); if (operation.artifactInput) { const producerGate = gateByOperation.get(operation.artifactInput.operationId); if (!producerGate || !gate.dependsOn.some(edge => edge.gateId === producerGate.id)) fail(`artifact consumer gate ${gate.id} requires a direct dependency on producer gate`, 2); } }
  return { strongOperations, byOperation, byGate, roleKeys: seenRoles };
}

function validateLedger(ledger, plan, graph) {
  exact(ledger, ["schemaVersion", "attempts"], "attempt ledger");
  if (ledger.schemaVersion !== 2 || !Array.isArray(ledger.attempts)) fail("attempt ledger must use schema version 2", 2);
  const attemptIds = new Set(), current = [];
  for (const [index, attempt] of ledger.attempts.entries()) {
    exact(attempt, ["attemptId", "workflowId", "roleKey", "operationId", "bindingSha256", "failureClassification", "attemptNumber", "status", "startedAtUtc", "endedAtUtc", "elapsedMs"], `attempt ${index}`);
    if (typeof attempt.attemptId !== "string" || !attempt.attemptId || attemptIds.has(attempt.attemptId)) fail(`attempt ${index} has a missing or duplicate attemptId`, 2);
    attemptIds.add(attempt.attemptId);
    if (!ID.test(attempt.workflowId ?? "") || !ID.test(attempt.roleKey ?? "") || !ID.test(attempt.operationId ?? "") || !SHA256.test(attempt.bindingSha256 ?? "") || !Number.isSafeInteger(attempt.attemptNumber) || attempt.attemptNumber < 1 || !["passed", "failed", "running"].includes(attempt.status)) fail(`attempt ${index} is malformed`, 2);
    if (attempt.workflowId !== plan.workflowId) continue;
    if (!graph.roleKeys.has(attempt.roleKey)) fail(`attempt ledger contains an unknown current-workflow role: ${attempt.roleKey}`, 2);
    if (attempt.status === "running") fail(`current-workflow attempt is not terminal: ${attempt.attemptId}`, 2);
    const start = Date.parse(attempt.startedAtUtc), end = Date.parse(attempt.endedAtUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isSafeInteger(attempt.elapsedMs) || attempt.elapsedMs < 0) fail(`terminal attempt ${index} timing is malformed`, 2);
    current.push(attempt);
  }
  const byRole = new Map();
  for (const roleKey of graph.roleKeys) byRole.set(roleKey, []);
  for (const attempt of current) byRole.get(attempt.roleKey).push(attempt);
  for (const [roleKey, attempts] of byRole) {
    attempts.sort((left, right) => left.attemptNumber - right.attemptNumber);
    if (attempts.length > 2) fail(`role ${roleKey} exceeds the two-attempt budget`, 2);
    for (const [index, attempt] of attempts.entries()) {
      if (attempt.attemptNumber !== index + 1) fail(`role ${roleKey} attempt numbers must be contiguous`, 2);
      if (index === 0 && attempt.failureClassification !== "initial") fail(`role ${roleKey} first attempt classification must be initial`, 2);
      if (index > 0 && !RETRY_CLASSIFICATIONS.has(attempt.failureClassification)) fail(`role ${roleKey} retry classification must be non-initial and recognized`, 2);
      if (index > 0) {
        const previous = attempts[index - 1];
        if (previous.status !== "failed") fail(`role ${roleKey} has an attempt after a pass`, 2);
        if (previous.bindingSha256 === attempt.bindingSha256) fail(`role ${roleKey} retry binding must differ from the prior attempt`, 2);
        if (Date.parse(attempt.startedAtUtc) < Date.parse(previous.endedAtUtc)) fail(`role ${roleKey} retry starts before the prior attempt ended`, 2);
      }
    }
  }
  return { byRole, attempts: current };
}

async function loadContext({ planPath, ledgerPath }) {
  const { bytes: planBytes, value: plan } = await readStableJson(planPath, "workflow plan", DEFAULT_INPUT_LIMIT), validation = validatePlan(plan);
  if (validation.errors.length) fail(`workflow plan is invalid: ${validation.errors.join(" ")}`, 2);
  try { assertPlanNotBlocked(plan, "gate report"); } catch (error) { fail(error.message, 2); }
  const planSha256 = hash(planBytes), limit = Math.min(DEFAULT_INPUT_LIMIT, plan.limits.maxOutputBytes);
  const { bytes: ledgerBytes, value: ledger } = await readStableJson(ledgerPath, "attempt ledger", limit);
  return { planPath, planBytes, plan, planSha256, ledgerBytes, ledger, inputLimit: limit };
}

async function preflightBinding(context, operation, input) {
  if (operation.kind !== "browser-smoke") {
    if (input.preflightSource !== null || input.preflightEvidence !== null || input.preflightArtifact !== null) fail(`gate ${input.gateId} supplies preflight paths for a non-browser-smoke operation`, 2);
    return "0".repeat(64);
  }
  if (typeof input.preflightSource !== "string" || typeof input.preflightEvidence !== "string" || !input.preflightSource || !input.preflightEvidence) fail(`gate ${input.gateId} browser-smoke requires reusable preflight evidence`, 2);
  const args = [new URL("./validate-operation-evidence.mjs", import.meta.url).pathname, "--plan", context.planPath, "--operation-id", operation.preflightOperationId, "--source", input.preflightSource, "--evidence", input.preflightEvidence];
  if (input.preflightArtifact) args.push("--artifact", input.preflightArtifact);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, args, { encoding: "utf8", maxBuffer: context.inputLimit });
    const after = await readStableFile(context.planPath, "workflow plan after preflight validation", DEFAULT_INPUT_LIMIT);
    if (!after.equals(context.planBytes)) fail("workflow plan changed during evidence validation", 2);
    return JSON.parse(stdout).evidenceBindingSha256;
  } catch (error) { if (error instanceof GateReportError) throw error; fail(`gate ${input.gateId} preflight evidence is not reusable: ${error.stderr || error.message}`, 2); }
}

async function diagnosticManifest(evidenceRoot, operation, limits) {
  const rootStat = await lstat(evidenceRoot).catch(error => fail(`failure evidence root is unavailable: ${error.message}`, 2));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("failure evidence root must be a non-symlink directory", 2);
  const allowedFiles = new Set(["operation-status.json", ...operation.outputs.filter(output => output.kind === "evidence").map(output => output.path)]), allowedDirs = new Set();
  for (const rel of allowedFiles) { let current = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""; while (current) { allowedDirs.add(current); current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : ""; } }
  const entries = []; let count = 0, total = 0;
  async function walk(directory, prefix = "") {
    const handle = await opendir(directory);
    for await (const dirent of handle) {
      count += 1; if (count > allowedFiles.size + allowedDirs.size) fail("failure diagnostic entry count exceeds the declared ceiling", 2);
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name, full = resolve(directory, dirent.name), stat = await lstat(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) { if (!allowedDirs.has(rel)) fail(`unexpected failure diagnostic directory: ${rel}`, 2); await walk(full, rel); continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !allowedFiles.has(rel)) fail(`unexpected or unsafe failure diagnostic: ${rel}`, 2);
      const bytes = await readStableFile(full, `failure diagnostic ${rel}`, limits.maxFileSizeBytes);
      if (rel !== "operation-status.json") total += bytes.length;
      if (total > limits.maxOutputBytes) fail("failure diagnostics exceed maxOutputBytes", 2);
      entries.push({ path: rel, sizeBytes: bytes.length, sha256: hash(bytes) });
    }
  }
  await walk(evidenceRoot); entries.sort((left, right) => left.path.localeCompare(right.path));
  if (!entries.some(entry => entry.path === "operation-status.json")) fail("failure operation-status.json is missing", 2);
  return { entries, diagnosticManifestSha256: hash(Buffer.from(canonical(entries))) };
}

function reportAttempts(attempts) {
  return attempts.map(attempt => ({ attemptId: attempt.attemptId, operationId: attempt.operationId, attemptNumber: attempt.attemptNumber, failureClassification: attempt.failureClassification, bindingSha256: attempt.bindingSha256, status: attempt.status, startedAtUtc: attempt.startedAtUtc, endedAtUtc: attempt.endedAtUtc, elapsedMs: attempt.elapsedMs }));
}

async function deriveFailure(context, operation, input, gateId, attempts) {
  if (typeof input.source !== "string" || !input.source || typeof input.evidence !== "string" || !input.evidence || input.artifact !== null) fail(`failed gate ${gateId} requires source/evidence and forbids artifact input`, 2);
  if (operation.artifactInput ? (typeof input.producerHandoff !== "string" || !input.producerHandoff) : input.producerHandoff !== undefined) fail(`failed gate ${gateId} producerHandoff must be present iff artifactInput is declared`, 2);
  const source = await hashSourceTree(input.source, { maxEntries: context.plan.limits.maxSourceEntries, maxBytes: context.plan.limits.maxSourceBytes });
  if (operation.sourceTreeSha256 === null || source.sourceTreeSha256 !== operation.sourceTreeSha256) fail(`failed gate ${gateId} source tree is stale or unbound`, 2);
  const { operationContractSha256 } = operationContract(context.plan, operation.id), preflightSha256 = await preflightBinding(context, operation, input), handoffSha256 = operation.artifactInput ? resolveArtifactHandoff({ planPath: context.planPath, plan: context.plan, consumer: operation, handoffPath: input.producerHandoff }).handoffBindingSha256 : null, expectedBinding = hashBinding([operationContractSha256, source.sourceTreeSha256, preflightSha256, ...(handoffSha256 ? [handoffSha256] : [])]), latest = attempts.at(-1);
  if (!latest || latest.status !== "failed" || latest.operationId !== operation.id || latest.bindingSha256 !== expectedBinding) fail(`failed gate ${gateId} does not match its terminal failed attempt`, 2);
  const statusBytes = await readStableFile(resolve(input.evidence, "operation-status.json"), `failed gate ${gateId} status`, context.plan.limits.maxFileSizeBytes); let status;
  try { status = JSON.parse(statusBytes); } catch (error) { fail(`failed gate ${gateId} status JSON is malformed: ${error.message}`, 2); }
  const expected = operationStatus({ kind: "failure", exitCode: status.rawContainerExit, reason: status.reason, operationId: operation.id, workflowId: context.plan.workflowId, roleKey: operation.roleKey, planSha256: context.planSha256, operationContractSha256, sourceTreeSha256: source.sourceTreeSha256, preflightEvidenceSha256: preflightSha256, scriptSha256: operation.scriptSha256, image: operation.image, network: operation.network, startedAtUtc: latest.startedAtUtc, endedAtUtc: latest.endedAtUtc, elapsedMs: latest.elapsedMs });
  if (!validReason(status.reason, 2000) || JSON.stringify(status) !== JSON.stringify(expected) || status.startedAtUtc !== latest.startedAtUtc || status.endedAtUtc !== latest.endedAtUtc || status.elapsedMs !== latest.elapsedMs) fail(`failed gate ${gateId} status/timestamp binding is invalid`, 2);
  const manifest = await diagnosticManifest(input.evidence, operation, context.plan.limits);
  return { status: "failed", workloadExitCode: status.rawContainerExit, attempts: reportAttempts(attempts), operationContractSha256, sourceTreeSha256: source.sourceTreeSha256, evidenceBindingSha256: null, diagnosticManifestSha256: manifest.diagnosticManifestSha256, diagnostics: manifest.entries };
}

function validateAssessment(assessment, failure, gateId) {
  exact(assessment, ["kind", "classification", "reason", "failedAttemptId", "gateId", "diagnosticManifestSha256"], `failed gate ${gateId} operator assessment`);
  const latest = failure.attempts.at(-1);
  if (assessment.kind !== "operator-assessment" || !ASSESSMENT_CLASSIFICATIONS.has(assessment.classification) || !validReason(assessment.reason, 1000) || assessment.failedAttemptId !== latest.attemptId || assessment.gateId !== gateId || assessment.diagnosticManifestSha256 !== failure.diagnosticManifestSha256) fail(`failed gate ${gateId} operator assessment binding is invalid`, 2);
  return assessment;
}

async function derivePassed(context, operation, input, gateId, attempts) {
  if (typeof input.source !== "string" || !input.source || typeof input.evidence !== "string" || !input.evidence || input.operatorAssessment !== null) fail(`passed gate ${gateId} requires source/evidence and no operator assessment`, 2);
  const args = [new URL("./validate-operation-evidence.mjs", import.meta.url).pathname, "--plan", context.planPath, "--operation-id", operation.id, "--source", input.source, "--evidence", input.evidence];
  if (input.artifact) args.push("--artifact", input.artifact);
  if (input.preflightSource) args.push("--preflight-source", input.preflightSource);
  if (input.preflightEvidence) args.push("--preflight-evidence", input.preflightEvidence);
  if (input.preflightArtifact) args.push("--preflight-artifact", input.preflightArtifact);
  if (input.producerHandoff) args.push("--producer-handoff", input.producerHandoff);
  let reusable;
  try { const { stdout } = await promisify(execFile)(process.execPath, args, { encoding: "utf8", maxBuffer: context.inputLimit }); reusable = JSON.parse(stdout); }
  catch (error) { fail(`passed gate ${gateId} evidence is not reusable: ${error.stderr || error.message}`, 2); }
  const after = await readStableFile(context.planPath, "workflow plan after evidence validation", DEFAULT_INPUT_LIMIT);
  if (!after.equals(context.planBytes)) fail("workflow plan changed during evidence validation", 2);
  const latest = attempts.at(-1);
  if (!latest || latest.status !== "passed" || latest.operationId !== operation.id || latest.bindingSha256 !== reusable.attemptBindingSha256 || latest.elapsedMs !== reusable.elapsedMs) fail(`passed gate ${gateId} contradicts the attempt ledger`, 2);
  return { status: "passed", workloadExitCode: 0, attempts: reportAttempts(attempts), operationContractSha256: reusable.operationContractSha256, sourceTreeSha256: reusable.sourceTreeSha256, evidenceBindingSha256: reusable.evidenceBindingSha256, diagnosticManifestSha256: null, diagnostics: [], operatorAssessment: null };
}

function validateInput(input, gateId, operation) {
  exact(input, ["gateId", "state", "source", "evidence", "artifact", "preflightSource", "preflightEvidence", "preflightArtifact", "operatorAssessment", ...(operation.artifactInput ? ["producerHandoff"] : [])], `gate input ${gateId}`);
  if (operation.artifactInput && input.state !== "skipped" && (typeof input.producerHandoff !== "string" || !input.producerHandoff)) fail(`gate input ${gateId}.producerHandoff is required`, 2);
  if (input.gateId !== gateId || !["passed", "failed", "skipped"].includes(input.state)) fail(`gate input ${gateId} state or binding is invalid`, 2);
  for (const key of ["source", "evidence", "artifact", "preflightSource", "preflightEvidence", "preflightArtifact"]) if (input[key] !== null && (typeof input[key] !== "string" || !input[key])) fail(`gate input ${gateId}.${key} must be null or a non-empty path`, 2);
}

async function derive(context, gatePlanPath, gateInputPaths) {
  const { bytes: gatePlanBytes, value: gatePlan } = await readStableJson(gatePlanPath, "gate plan", context.inputLimit), graph = validateGatePlan(gatePlan, context.plan, context.planSha256), checkedLedger = validateLedger(context.ledger, context.plan, graph);
  if (gateInputPaths.length !== gatePlan.gates.length) fail(`exactly one --gate-input is required per gate: expected ${gatePlan.gates.length}, received ${gateInputPaths.length}`, 2);
  const inputs = new Map();
  for (const inputPath of gateInputPaths) { const { value } = await readStableJson(inputPath, `gate input ${inputPath}`, context.inputLimit); if (inputs.has(value.gateId)) fail(`duplicate gate input: ${value.gateId}`, 2); inputs.set(value.gateId, value); }
  const results = new Map(), reportGates = [];
  for (const gate of gatePlan.gates) {
    const input = inputs.get(gate.id); if (!input) fail(`gate input is missing: ${gate.id}`, 2);
    const operation = graph.byOperation.get(gate.operationId); validateInput(input, gate.id, operation);
    const attempts = checkedLedger.byRole.get(gate.roleKey), dependencies = gate.dependsOn.map(edge => ({ ...edge, status: results.get(edge.gateId).status, observedViolation: false })); let result;
    if (input.state === "passed") result = await derivePassed(context, operation, input, gate.id, attempts);
    else if (input.state === "failed") { result = await deriveFailure(context, operation, input, gate.id, attempts); result.operatorAssessment = validateAssessment(input.operatorAssessment, result, gate.id); }
    else {
      if (attempts.length !== 0 || input.source !== null || input.evidence !== null || input.artifact !== null || input.preflightSource !== null || input.preflightEvidence !== null || input.preflightArtifact !== null || input.operatorAssessment !== null || (operation.artifactInput && input.producerHandoff !== null)) fail(`skipped gate ${gate.id} must have no attempt or evidence inputs`, 2);
      const blockedBy = dependencies.filter(dependency => dependency.status !== "passed").map(dependency => dependency.gateId);
      if (blockedBy.length === 0) fail(`skipped gate ${gate.id} is not blocked by a non-passed dependency`, 2);
      result = { status: "skipped", workloadExitCode: null, attempts: [], operationContractSha256: operationContract(context.plan, operation.id).operationContractSha256, sourceTreeSha256: operation.sourceTreeSha256, evidenceBindingSha256: null, diagnosticManifestSha256: null, diagnostics: [], operatorAssessment: null, blockedByGateIds: blockedBy };
    }
    if (result.status !== "skipped") {
      for (const dependency of dependencies) {
        const dependencyResult = results.get(dependency.gateId), dependencyAttempts = dependencyResult.attempts, dependencyLatest = dependencyAttempts.at(-1), violated = result.attempts.some(attempt => dependencyResult.status !== "passed" || !dependencyLatest || Date.parse(attempt.startedAtUtc) < Date.parse(dependencyLatest.endedAtUtc));
        dependency.observedViolation = violated;
        if (violated && dependency.exceptionReason === null) fail(`gate ${gate.id} violates dependency ${dependency.gateId} for one or more attempts without an edge-specific exceptionReason`, 2);
      }
    }
    const entry = { gateId: gate.id, operationId: gate.operationId, roleKey: gate.roleKey, costClass: gate.costClass, orderExceptionReason: gate.orderExceptionReason, dependsOn: dependencies, ...result };
    if (entry.blockedByGateIds === undefined) entry.blockedByGateIds = [];
    results.set(gate.id, entry); reportGates.push(entry);
  }
  const terminalTimes = checkedLedger.attempts.map(attempt => attempt.endedAtUtc);
  if (terminalTimes.length === 0) fail("gate report requires at least one terminal current-workflow attempt", 2);
  const observedThroughUtc = terminalTimes.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
  const overallStatus = reportGates.some(gate => gate.status === "failed") ? "failed" : reportGates.some(gate => gate.status === "skipped") ? "blocked" : "passed";
  const report = { schemaVersion: 1, authority: "host", provenance: "host-derived-workflow-gate-report", workflowId: context.plan.workflowId, planSha256: context.planSha256, gatePlanSha256: hash(gatePlanBytes), graphSha256: hash(Buffer.from(canonical({ workflowId: gatePlan.workflowId, gates: gatePlan.gates }))), ledgerSha256: hash(context.ledgerBytes), observedThroughUtc, overallStatus, gates: reportGates };
  return { report, bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`) };
}

export async function inspectFailure(options) {
  const context = await loadContext(options), operation = context.plan.operations.find(value => value.id === options.operationId && STRONG_OPERATION_KINDS.has(value.kind));
  if (!operation || !ID.test(options.gateId ?? "") || !options.source || !options.evidence) fail("inspect-failure requires a strong operation, stable gate ID, source, and evidence", 2);
  const graph = { roleKeys: new Set(context.plan.operations.filter(value => STRONG_OPERATION_KINDS.has(value.kind)).map(value => value.roleKey)) }, checkedLedger = validateLedger(context.ledger, context.plan, graph), attempts = checkedLedger.byRole.get(operation.roleKey);
  if (operation.artifactInput ? !options.producerHandoff : options.producerHandoff !== undefined) fail("inspect-failure --producer-handoff is required iff the operation declares artifactInput", 2);
  const input = { gateId: options.gateId, state: "failed", source: options.source, evidence: options.evidence, artifact: null, preflightSource: options.preflightSource ?? null, preflightEvidence: options.preflightEvidence ?? null, preflightArtifact: options.preflightArtifact ?? null, operatorAssessment: null, ...(operation.artifactInput ? { producerHandoff: options.producerHandoff } : {}) };
  const failure = await deriveFailure(context, operation, input, options.gateId, attempts);
  return { status: "FAILURE_DIAGNOSTICS_INSPECTED", workflowId: context.plan.workflowId, operationId: operation.id, roleKey: operation.roleKey, failedAttemptId: failure.attempts.at(-1).attemptId, gateId: options.gateId, diagnosticManifestSha256: failure.diagnosticManifestSha256, diagnostics: failure.diagnostics };
}

export async function generateGateReport(options) {
  const context = await loadContext(options), derived = await derive(context, options.gatePlanPath, options.gateInputPaths);
  if (derived.bytes.length > context.plan.limits.maxOutputBytes || derived.bytes.length > context.plan.limits.maxFileSizeBytes) fail("gate report exceeds the declared output size limit", 2);
  try { await writeFile(options.outPath, derived.bytes, { flag: "wx", mode: 0o600 }); } catch (error) { fail(`cannot exclusively create gate report: ${error.message}`, 2); }
  return { status: "GATE_REPORT_WRITTEN", workflowId: context.plan.workflowId, reportSha256: hash(derived.bytes), graphSha256: derived.report.graphSha256, out: options.outPath };
}

export async function validateGateReport(options) {
  const context = await loadContext(options), existingBytes = await readStableFile(options.reportPath, "gate report", Math.min(context.plan.limits.maxOutputBytes, context.plan.limits.maxFileSizeBytes)), derived = await derive(context, options.gatePlanPath, options.gateInputPaths); let existing;
  try { existing = JSON.parse(existingBytes); } catch (error) { fail(`gate report JSON is malformed: ${error.message}`, 2); }
  exact(existing, ["schemaVersion", "authority", "provenance", "workflowId", "planSha256", "gatePlanSha256", "graphSha256", "ledgerSha256", "observedThroughUtc", "overallStatus", "gates"], "gate report");
  if (existing.authority !== "host" || existing.provenance !== "host-derived-workflow-gate-report" || !Number.isFinite(Date.parse(existing.observedThroughUtc))) fail("gate report authority/provenance/timestamp is invalid", 2);
  if (!existingBytes.equals(derived.bytes)) fail("gate report bytes do not match current plan/gate-plan/ledger/evidence derivation", 2);
  return { status: "GATE_REPORT_VALID", workflowId: context.plan.workflowId, reportSha256: hash(existingBytes), graphSha256: derived.report.graphSha256, report: options.reportPath };
}
