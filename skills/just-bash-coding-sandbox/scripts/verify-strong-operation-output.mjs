#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStableRegular } from "./strong-operation-files.mjs";
import { operationStatus } from "./strong-operation-status.mjs";

export const RUNNER_BUNDLE_VERSION = "3";
export class StrongOperationVerificationError extends Error {}

export function verifyStrongOperationOutput(options) {
  const {
    statusPath,
    evidenceStaging,
    artifactStaging,
    failureEvidence,
    outputsPath,
    operationId,
    workflowId,
    roleKey,
    planSha,
    contractSha,
    sourceSha,
    preflightSha,
    scriptSha,
    image,
    network,
    rawExit,
    timeoutMarker,
    timeoutMs,
    startedAtUtc,
    endedAtUtc,
    elapsedMs,
    cpus,
    memory,
    maxFileSize,
    maxOutputBytes,
    runnerBundleVersion = RUNNER_BUNDLE_VERSION,
  } = options;
  if (runnerBundleVersion !== RUNNER_BUNDLE_VERSION) {
    throw new Error(
      `runner bundle version mismatch: verifier=${RUNNER_BUNDLE_VERSION} launcher=${runnerBundleVersion}`,
    );
  }
  const containerExit = Number(rawExit),
    failureStatus = path.join(failureEvidence, "operation-status.json");
  const declared = readStableRegular(outputsPath, "declared outputs").bytes
    .toString("utf8").trim().split("\n").filter(Boolean).map((line) => {
      const [kind, ...rest] = line.split("\t"),
        relativePath = rest.join("\t"),
        segments = relativePath.split("/");
      if (
        !relativePath || path.posix.isAbsolute(relativePath) ||
        segments.some((segment) =>
          !segment || segment === "." || segment === ".."
        ) || /[\0\n\r]/.test(relativePath)
      ) {
        throw new Error(
          `unsafe declared output path: ${JSON.stringify(relativePath)}`,
        );
      }
      return { kind, path: relativePath };
    });

  function declaredSource(root, relativePath) {
    const segments = relativePath.split("/");
    let current = root;
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("diagnostic root is not a non-symlink directory");
    }
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
          `diagnostic parent is not a non-symlink directory: ${relativePath}`,
        );
      }
    }
    return path.join(current, segments.at(-1));
  }
  function publishFailureDiagnostics() {
    let total = 0;
    for (const item of declared.filter((value) => value.kind === "evidence")) {
      const destination = path.join(failureEvidence, ...item.path.split("/"));
      try {
        const source = declaredSource(evidenceStaging, item.path);
        const { bytes, stat } = readStableRegular(
          source,
          `failure diagnostic ${item.path}`,
          Number(maxFileSize),
        );
        total += Number(stat.size);
        if (total > Number(maxOutputBytes)) break;
        fs.mkdirSync(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ELOOP") {
          console.error(
            `WARNING: could not preserve failure diagnostic ${item.path}: ${error.message}`,
          );
        }
      }
    }
  }
  function hostFailure(reason) {
    const value = operationStatus({
      kind: "failure",
      exitCode: containerExit,
      reason,
      operationId,
      workflowId,
      roleKey,
      planSha256: planSha,
      operationContractSha256: contractSha,
      sourceTreeSha256: sourceSha,
      preflightEvidenceSha256: preflightSha,
      scriptSha256: scriptSha,
      image,
      network,
      startedAtUtc,
      endedAtUtc,
      elapsedMs,
    });
    try {
      fs.writeFileSync(failureStatus, `${JSON.stringify(value)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      publishFailureDiagnostics();
    } catch (error) {
      console.error(
        `ERROR: could not write host failure assessment: ${error.message}`,
      );
    }
  }
  function die(message) {
    hostFailure(message);
    throw new StrongOperationVerificationError(message);
  }
  if (fs.existsSync(timeoutMarker)) {
    die(`host wall-clock timeout after ${timeoutMs}ms`);
  }

  let statusRead;
  try {
    statusRead = readStableRegular(statusPath, "authoritative status");
  } catch (error) {
    die(
      error.code === "ENOENT"
        ? "authoritative private operation status is missing"
        : error.message,
    );
  }
  const statusBytes = statusRead.bytes;
  let status;
  try {
    status = JSON.parse(statusBytes);
  } catch (error) {
    die(`authoritative status is malformed: ${error.message}`);
  }
  const keys = Object.keys(status).sort().join(","),
    expected = [
      "authority",
      "exitCode",
      "image",
      "network",
      "operationContractSchemaVersion",
      "operationContractSha256",
      "operationId",
      "workflowId",
      "roleKey",
      "planSha256",
      "preflightEvidenceSha256",
      "provenance",
      "schemaVersion",
      "scriptSha256",
      "sourceTreeSha256",
      "status",
    ].sort().join(",");
  if (
    keys !== expected || status.schemaVersion !== 2 ||
    status.authority !== "host" ||
    status.provenance !== "container-exit-attestation" ||
    !["succeeded", "failed"].includes(status.status) ||
    !Number.isInteger(status.exitCode)
  ) die("authoritative status schema mismatch");
  if (
    status.operationId !== operationId || status.workflowId !== workflowId ||
    status.roleKey !== roleKey || status.planSha256 !== planSha ||
    status.operationContractSchemaVersion !== 2 ||
    status.operationContractSha256 !== contractSha ||
    status.sourceTreeSha256 !== sourceSha ||
    status.preflightEvidenceSha256 !== preflightSha ||
    status.scriptSha256 !== scriptSha || status.image !== image ||
    status.network !== network
  ) die("authoritative status binding mismatch");
  if (
    (status.status === "succeeded") !== (status.exitCode === 0) ||
    status.exitCode !== containerExit
  ) die("container exit and authoritative status disagree");
  if (containerExit !== 0) die(`operation exited nonzero: ${containerExit}`);

  let total = 0;
  const receiptOutputs = [];
  function verify(root, kind) {
    const expectedFiles = new Set(
        declared.filter((value) => value.kind === kind).map((value) =>
          value.path
        ),
      ),
      allowedDirs = new Set();
    for (const relativePath of expectedFiles) {
      let current = path.posix.dirname(relativePath);
      while (current !== ".") {
        allowedDirs.add(current);
        current = path.posix.dirname(current);
      }
    }
    const actual = [], ceiling = expectedFiles.size + allowedDirs.size;
    let enumerated = 0;
    function walk(directory, prefix = "") {
      const handle = fs.opendirSync(directory);
      try {
        for (let entry; (entry = handle.readSync()) !== null;) {
          enumerated += 1;
          if (enumerated > ceiling) {
            die(
              `${kind} output entry count exceeds declared file/directory ceiling`,
            );
          }
          const name = entry.name,
            relativePath = prefix ? `${prefix}/${name}` : name,
            full = path.join(directory, name),
            entryStat = fs.lstatSync(full);
          if (
            entryStat.isSymbolicLink() ||
            (!entryStat.isDirectory() &&
              (!entryStat.isFile() || entryStat.nlink !== 1))
          ) {
            die(
              `${kind} output must be regular and not linked: ${relativePath}`,
            );
          }
          if (entryStat.isDirectory()) {
            if (!allowedDirs.has(relativePath)) {
              die(`unexpected ${kind} directory: ${relativePath}`);
            }
            walk(full, relativePath);
          } else actual.push(relativePath);
        }
      } finally {
        handle.closeSync();
      }
    }
    walk(root);
    for (const relativePath of expectedFiles) {
      if (!actual.includes(relativePath)) {
        die(`declared ${kind} output is missing: ${relativePath}`);
      }
    }
    for (const relativePath of actual) {
      if (!expectedFiles.has(relativePath)) {
        die(`unexpected ${kind} output: ${relativePath}`);
      }
    }
    for (const relativePath of [...expectedFiles].sort()) {
      let read;
      try {
        read = readStableRegular(
          path.join(root, ...relativePath.split("/")),
          `${kind} output ${relativePath}`,
          Number(maxFileSize),
        );
      } catch (error) {
        die(error.message);
      }
      total += Number(read.stat.size);
      if (total > Number(maxOutputBytes)) {
        die("combined outputs exceed maxOutputBytes");
      }
      receiptOutputs.push({
        kind,
        path: relativePath,
        sizeBytes: Number(read.stat.size),
        sha256: crypto.createHash("sha256").update(read.bytes).digest("hex"),
      });
    }
  }
  verify(evidenceStaging, "evidence");
  verify(artifactStaging, "artifact");
  fs.writeFileSync(
    path.join(evidenceStaging, "operation-status.json"),
    statusBytes,
    { flag: "wx", mode: 0o600 },
  );
  const receipt = {
    schemaVersion: 2,
    authority: "host",
    provenance: "post-execution-output-validation",
    operationId,
    workflowId,
    roleKey,
    historicalPlanSha256: planSha,
    operationContractSchemaVersion: 2,
    operationContractSha256: contractSha,
    sourceTreeSha256: sourceSha,
    statusSha256: crypto.createHash("sha256").update(statusBytes).digest("hex"),
    startedAtUtc,
    endedAtUtc,
    elapsedMs: Number(elapsedMs),
    resources: { cpus: Number(cpus), memory },
    outputs: receiptOutputs.sort((a, b) =>
      `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`)
    ),
  };
  fs.writeFileSync(
    path.join(evidenceStaging, "operation-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return containerExit === 0 && status.status === "succeeded" ? 0 : 2;
}

export function optionsFromArguments(args) {
  if (args.length !== 26) {
    throw new Error(
      "Usage: node scripts/verify-strong-operation-output.mjs <status> <evidence-staging> <artifact-staging> <failure-evidence-staging> <outputs.tsv> <operation-id> <workflow-id> <role-key> <plan-sha> <contract-sha> <source-sha> <preflight-sha> <script-sha> <image> <network> <raw-exit> <timeout-marker> <timeout-ms> <started-at-utc> <ended-at-utc> <elapsed-ms> <cpus> <memory> <max-file-size> <max-output-bytes> <runner-bundle-version>",
    );
  }
  const [
    statusPath,
    evidenceStaging,
    artifactStaging,
    failureEvidence,
    outputsPath,
    operationId,
    workflowId,
    roleKey,
    planSha,
    contractSha,
    sourceSha,
    preflightSha,
    scriptSha,
    image,
    network,
    rawExit,
    timeoutMarker,
    timeoutMs,
    startedAtUtc,
    endedAtUtc,
    elapsedMs,
    cpus,
    memory,
    maxFileSize,
    maxOutputBytes,
    runnerBundleVersion,
  ] = args;
  return {
    statusPath,
    evidenceStaging,
    artifactStaging,
    failureEvidence,
    outputsPath,
    operationId,
    workflowId,
    roleKey,
    planSha,
    contractSha,
    sourceSha,
    preflightSha,
    scriptSha,
    image,
    network,
    rawExit,
    timeoutMarker,
    timeoutMs,
    startedAtUtc,
    endedAtUtc,
    elapsedMs,
    cpus,
    memory,
    maxFileSize,
    maxOutputBytes,
    runnerBundleVersion,
  };
}
function cli() {
  try {
    process.exitCode = verifyStrongOperationOutput(
      optionsFromArguments(process.argv.slice(2)),
    );
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
function isDirectCli() {
  try {
    return Boolean(process.argv[1]) &&
      fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isDirectCli()) cli();
