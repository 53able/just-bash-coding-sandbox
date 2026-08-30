#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  operationContract,
  RUNNER_BUNDLE_VERSION as CONTRACT_VERSION,
} from "./strong-operation-contract.mjs";
import { writeExclusive } from "./strong-operation-files.mjs";

export const RUNNER_BUNDLE_VERSION = "3";
export function assertBundleVersion(expected) {
  if (
    expected !== RUNNER_BUNDLE_VERSION ||
    CONTRACT_VERSION !== RUNNER_BUNDLE_VERSION
  ) throw new Error("runner bundle version mismatch");
}
export function prepareContract(
  {
    planPath,
    operationId,
    contractPath,
    metadataDirectory,
    toolsPath,
    pathPath,
    outputsPath,
  },
) {
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")),
    operation = plan.operations?.find((v) => v.id === operationId);
  if (!operation) throw new Error(`operation is missing: ${operationId}`);
  const wrapper = operationContract(plan, operationId);
  wrapper.sourceTreeSha256 = operation.sourceTreeSha256;
  writeExclusive(contractPath, JSON.stringify(wrapper));
  writeExclusive(toolsPath, `${wrapper.contract.requiredTools.join("\n")}\n`);
  writeExclusive(pathPath, `${wrapper.contract.path.join("\n")}\n`);
  writeExclusive(
    outputsPath,
    `${
      wrapper.contract.outputs.map((v) => `${v.kind}\t${v.path}`).join("\n")
    }\n`,
  );
  fs.mkdirSync(metadataDirectory, { mode: 0o700 });
  const m = {
    image: wrapper.contract.image,
    network: wrapper.contract.network,
    timeoutMs: wrapper.contract.timeoutMs,
    plannedScriptSha256: wrapper.contract.scriptSha256,
    plannedSourceTreeSha256: wrapper.sourceTreeSha256 ?? "",
    operationContractSha256: wrapper.operationContractSha256,
    cpus: wrapper.contract.resources.cpus,
    memory: wrapper.contract.resources.memory,
    maxFileSize: wrapper.contract.outputLimits.maxFileSizeBytes,
    maxOutputBytes: wrapper.contract.outputLimits.maxOutputBytes,
    maxSourceEntries: wrapper.contract.sourceLimits.maxSourceEntries,
    maxSourceBytes: wrapper.contract.sourceLimits.maxSourceBytes,
    operationKind: wrapper.contract.kind,
    workflowId: wrapper.contract.workflowId,
    roleKey: wrapper.contract.roleKey,
    preflightOperationId: wrapper.contract.preflightOperationId ?? "",
    browserRole: wrapper.contract.browserRole ?? null,
    viewportIds: wrapper.contract.viewports?.map((viewport) => viewport.id) ?? [],
    artifactInput: wrapper.contract.artifactInput ?? null,
  };
  writeExclusive(
    path.join(metadataDirectory, "metadata.json"),
    JSON.stringify(m),
  );
  return m;
}
export function bindingSha256(values) {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value).update("\0");
  return hash.digest("hex");
}
export function now() {
  return { utc: new Date().toISOString(), mono: process.hrtime.bigint() };
}
export function elapsedMs(start, end = process.hrtime.bigint()) {
  return Number((end - start) / 1_000_000n);
}
export function remainingMs(start, total) {
  return Math.max(0, total - elapsedMs(start));
}
export function operationStatus(options) {
  const exitCode = Number(options.exitCode);
  if (options.kind === "attestation") {
    return {
      schemaVersion: 2,
      status: exitCode === 0 ? "succeeded" : "failed",
      exitCode,
      authority: "host",
      provenance: "container-exit-attestation",
      operationId: options.operationId,
      workflowId: options.workflowId,
      roleKey: options.roleKey,
      planSha256: options.planSha256,
      operationContractSchemaVersion: 2,
      operationContractSha256: options.operationContractSha256,
      sourceTreeSha256: options.sourceTreeSha256,
      preflightEvidenceSha256: options.preflightEvidenceSha256,
      scriptSha256: options.scriptSha256,
      image: options.image,
      network: options.network,
    };
  }
  if (options.kind === "failure") {
    return {
      schemaVersion: 2,
      status: "failed",
      exitCode,
      authority: "host",
      provenance: "host-failure-assessment",
      reason: options.reason,
      rawContainerExit: exitCode,
      operationId: options.operationId,
      workflowId: options.workflowId,
      roleKey: options.roleKey,
      planSha256: options.planSha256,
      operationContractSchemaVersion: 2,
      operationContractSha256: options.operationContractSha256,
      sourceTreeSha256: options.sourceTreeSha256,
      preflightEvidenceSha256: options.preflightEvidenceSha256,
      scriptSha256: options.scriptSha256,
      image: options.image,
      network: options.network,
      startedAtUtc: options.startedAtUtc,
      endedAtUtc: options.endedAtUtc,
      elapsedMs: Number(options.elapsedMs),
    };
  }
  throw new Error(`unsupported status kind: ${options.kind}`);
}
export function writeOperationStatus(file, options) {
  const value = operationStatus(options);
  writeExclusive(file, `${JSON.stringify(value)}\n`);
  return value;
}
