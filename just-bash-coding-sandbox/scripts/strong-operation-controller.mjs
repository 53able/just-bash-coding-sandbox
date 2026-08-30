#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlan } from "./validate-execution-plan.mjs";
import { assertConsumeOnlyScript, resolveArtifactHandoff } from "./artifact-handoff-contract.mjs";
import {
  inspectEmptyDestination,
  publishTree,
  readStableRegular,
  rollbackTree,
  safeTree,
  snapshotBundle,
  snapshotFile,
} from "./strong-operation-files.mjs";
import {
  runBounded,
  runChecked,
  stopContainer,
  terminateChild,
} from "./strong-operation-process.mjs";
import {
  assertBundleVersion,
  bindingSha256,
  elapsedMs,
  now,
  prepareContract,
  remainingMs,
  writeOperationStatus,
} from "./strong-operation-status.mjs";

export const RUNNER_BUNDLE_VERSION = "3";
export function assertBrowserSplitMetadata(metadata) {
  if (metadata.browserRole === null) return;
  if (!new Set(["interaction", "viewport-validation"]).has(metadata.browserRole)) throw new Error("split browser operation metadata has an unsupported browserRole");
  if (metadata.operationKind !== "browser-smoke" || metadata.viewportIds.length !== 1) throw new Error("split browser operation metadata requires one browser-smoke viewport");
  const viewportId = metadata.viewportIds[0];
  if (metadata.browserRole === "interaction" && (metadata.roleKey !== "browser-interaction" || viewportId !== "desktop")) throw new Error("split browser interaction metadata mismatch");
  if (metadata.browserRole === "viewport-validation" && metadata.roleKey !== `browser-viewport.${viewportId}`) throw new Error("split browser viewport metadata mismatch");
}
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
function usage() {
  throw Object.assign(
    new Error(
      "Usage: run-strong-operation-apple-container.sh --source <dir> --script <file> --plan <validated-v5-plan> --operation-id <id> --evidence-out <empty-dir> [--artifact-out <empty-dir>] --attempt-ledger <file> [--failure-classification <class>] [--preflight-source <dir> --preflight-evidence <dir> [--preflight-artifact <dir>]] [--producer-handoff <location-sidecar>]\nImage, source hash, tools, PATH, resources, network, timeout, oracles, outputs, and optional producer binding are derived from the selected plan operation.",
    ),
    { exitCode: 2 },
  );
}
function parseArgs(args) {
  const allowed = new Set([
      "--source",
      "--script",
      "--plan",
      "--operation-id",
      "--evidence-out",
      "--artifact-out",
      "--preflight-source",
      "--preflight-evidence",
      "--preflight-artifact",
      "--attempt-ledger",
      "--failure-classification",
      "--producer-handoff",
    ]),
    v = { failureClassification: "initial" };
  for (let i = 0; i < args.length; i += 2) {
    if (i + 1 >= args.length || !allowed.has(args[i])) usage();
    const key = args[i].slice(2).replace(
      /-([a-z])/g,
      (_, c) => c.toUpperCase(),
    );
    if (v[key] !== undefined && key !== "failureClassification") usage();
    v[key] = args[i + 1];
  }
  for (
    const key of [
      "source",
      "script",
      "plan",
      "operationId",
      "evidenceOut",
      "attemptLedger",
    ]
  ) if (!v[key]) usage();
  return v;
}
function regular(file, label) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${file}`);
  }
}
function directory(file, label) {
  const st = fs.lstatSync(file);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${file}`);
  }
}
function overlap(a, b) {
  return a === b || a.startsWith(`${b}${path.sep}`) ||
    b.startsWith(`${a}${path.sep}`);
}
function shaFile(file) {
  return createHash("sha256").update(readStableRegular(file, file).bytes)
    .digest("hex");
}
function mkdirExclusive(dir) {
  fs.mkdirSync(dir, { mode: 0o700 });
}
function exactEmpty(dir, label) {
  directory(dir, label);
  if (fs.readdirSync(dir).length) throw new Error(`${label} must be empty.`);
}
function shellSafeMount(p) {
  if (/[,\n\r]/.test(p)) {
    throw new Error(
      `Apple Container mount paths containing comma or newline are unsupported: ${p}`,
    );
  }
}
function operationError(message, exitCode = 1) {
  return Object.assign(new Error(message), { exitCode });
}

export async function commitResult(
  {
    state,
    publishArtifact,
    publishEvidence,
    finalize,
    verifiedFailure = false,
    hooks = {},
  },
) {
  state.committing = true;
  try {
    if (publishArtifact) {
      publishArtifact();
      hooks.afterArtifactPublish?.(state);
    }
    publishEvidence();
    hooks.afterEvidencePublish?.(state);
    hooks.beforeFinalizer?.(state);
    finalize(verifiedFailure ? "failed" : "passed");
    hooks.afterFinalizer?.(state);
    await new Promise((resolve) => setImmediate(resolve));
    state.committed = true;
    return {
      exitCode: verifiedFailure ? 1 : 0,
      pendingSignal: state.pendingSignal,
    };
  } finally {
    state.committing = false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv),
    source = fs.realpathSync(a.source),
    script = path.resolve(a.script),
    planPath = path.resolve(a.plan),
    evidence = fs.realpathSync(a.evidenceOut),
    artifact = a.artifactOut ? fs.realpathSync(a.artifactOut) : null,
    ledger = path.resolve(a.attemptLedger),
    producerHandoff = a.producerHandoff ? path.resolve(a.producerHandoff) : null;
  if (producerHandoff) { regular(producerHandoff, "producer handoff sidecar"); a.producerHandoff = producerHandoff; }
  directory(source, "source");
  regular(script, "script");
  regular(planPath, "plan");
  exactEmpty(evidence, "evidence output");
  if (artifact) exactEmpty(artifact, "artifact output");
  if (fs.existsSync(ledger)) regular(ledger, "attempt ledger");
  else directory(path.dirname(ledger), "attempt ledger parent");
  for (
    const p of [
      source,
      script,
      planPath,
      evidence,
      ledger,
      ...(artifact ? [artifact] : []),
      ...(producerHandoff ? [producerHandoff] : []),
    ]
  ) shellSafeMount(p);
  for (const input of [source, script, planPath, ...(producerHandoff ? [producerHandoff] : [])]) {
    if (overlap(input, evidence)) {
      throw new Error("evidence output overlaps an input.");
    }
    if (artifact && overlap(input, artifact)) {
      throw new Error("artifact output overlaps an input.");
    }
  }
  if (artifact && overlap(evidence, artifact)) {
    throw new Error("evidence and artifact outputs overlap.");
  }
  for (
    const p of [
      source,
      script,
      planPath,
      evidence,
      ...(artifact ? [artifact] : []),
      ...(producerHandoff ? [producerHandoff] : []),
    ]
  ) {
    if (overlap(ledger, p)) {
      throw new Error(
        "attempt ledger overlaps source, plan, script, or output.",
      );
    }
  }
  const initialPlan = JSON.parse(readStableRegular(planPath, "plan preflight").bytes);
  const initialValidity = validatePlan(initialPlan);
  if (initialValidity.errors.length) throw new Error(initialValidity.errors.join("\n"));
  if (initialValidity.blocked) throw new Error("effective risk route is blocked; external-microvm execution is not implemented");
  runChecked("container", ["--version"], { stdio: "ignore" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jbs-strong-")),
    containerName = `jbs-${
      a.operationId.replace(/[^A-Za-z0-9_.-]/g, "-")
    }-${process.pid}-${randomBytes(4).toString("hex")}`;
  const state = {
    committing: false,
    pendingSignal: null,
    interrupted: null,
    activeChild: null,
    committed: false,
    attemptId: null,
    attemptFinalized: false,
    publishedArtifact: null,
    publishedEvidence: null,
    containerName,
  };
  const signalHandler = (code) => {
    if (state.committing) {
      state.pendingSignal ??= code;
      return;
    }
    state.interrupted = code;
    stopContainer(containerName);
    terminateChild(state.activeChild);
  };
  process.on("SIGINT", () => signalHandler(130));
  process.on("SIGTERM", () => signalHandler(143));
  let started,
    planSha,
    scriptSha,
    metadata,
    sourceSha,
    preflightSha = "0".repeat(64),
    failureStage,
    evidenceStage,
    artifactStage,
    bundleSha,
    authoritativeElapsedMs,
    authoritativeEndedAtUtc,
    attemptStarted,
    evidenceIdentity,
    artifactIdentity,
    producerArtifactSnapshot,
    handoffBindingSha256 = null;
  const throwIfInterrupted = () => {
    if (state.interrupted) {
      throw operationError(
        `interrupted by signal (${state.interrupted})`,
        state.interrupted,
      );
    }
  };
  const runInterruptible = async (command, args, options) => {
    try {
      const code = await runBounded(command, args, options);
      throwIfInterrupted();
      return code;
    } catch (error) {
      if (state.interrupted) throwIfInterrupted();
      throw error;
    }
  };
  const finalizeLedger = (status) => {
    if (!state.attemptId || state.attemptFinalized) return;
    if (!authoritativeEndedAtUtc) authoritativeEndedAtUtc = new Date().toISOString();
    if (authoritativeElapsedMs === undefined) authoritativeElapsedMs = elapsedMs((attemptStarted ?? started).mono);
    runChecked(process.execPath, [
      path.join(SCRIPT_DIR, "attempt-ledger.mjs"),
      "finalize",
      "--ledger",
      ledger,
      "--workflow-id",
      metadata.workflowId,
      "--role-key",
      metadata.roleKey,
      "--operation-id",
      a.operationId,
      "--attempt-id",
      state.attemptId,
      "--status",
      status,
      "--elapsed-ms",
      String(authoritativeElapsedMs),
      "--ended-at-utc",
      authoritativeEndedAtUtc,
    ]);
    state.attemptFinalized = true;
  };
  const rollbackOwned = () => {
    for (
      const [destination, record, name] of [[
        evidence,
        state.publishedEvidence,
        "evidence",
      ], [artifact, state.publishedArtifact, "artifact"]]
    ) {
      if (destination && record) {
        try {
          rollbackTree(destination, path.join(tmp, `rollback-${name}`), record);
        } catch (error) {
          console.error(
            `WARNING: owned ${name} publication was not rolled back: ${error.message}`,
          );
        }
      }
    }
  };
  const cleanup = () => {
    stopContainer(containerName);
    if (state.activeChild) terminateChild(state.activeChild);
    if (!state.committed) rollbackOwned();
    if (state.attemptId && !state.attemptFinalized) {
      try {
        finalizeLedger("failed");
      } catch {}
    }
    for (const staging of [evidenceStage, failureStage, artifactStage]) {
      if (!staging || staging === artifact || staging === evidence || staging.startsWith(`${tmp}${path.sep}`)) continue;
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  };
  try {
    for (
      const d of [
        "guest",
        "status",
        "lifecycle",
        "discarded-artifacts",
        "bundle",
      ]
    ) mkdirExclusive(path.join(tmp, d));
    bundleSha = snapshotBundle(
      SCRIPT_DIR,
      path.join(tmp, "bundle-files"),
      RUNNER_BUNDLE_VERSION,
    );
    assertBundleVersion(RUNNER_BUNDLE_VERSION);
    evidenceStage = path.join(
      path.dirname(evidence),
      `.jbs-evidence-${containerName}`,
    );
    failureStage = path.join(
      path.dirname(evidence),
      `.jbs-failure-evidence-${containerName}`,
    );
    if (fs.existsSync(evidenceStage) || fs.existsSync(failureStage)) {
      throw new Error("evidence staging path already exists.");
    }
    mkdirExclusive(evidenceStage);
    mkdirExclusive(failureStage);
    evidenceIdentity = inspectEmptyDestination(evidence);
    if (artifact) {
      artifactStage = path.join(
        path.dirname(artifact),
        `.jbs-artifact-${containerName}`,
      );
      if (fs.existsSync(artifactStage)) {
        throw new Error("artifact staging path already exists.");
      }
      mkdirExclusive(artifactStage);
      artifactIdentity = inspectEmptyDestination(artifact);
    } else artifactStage = path.join(tmp, "discarded-artifacts");
    const guest = path.join(tmp, "guest"),
      planSnapshot = path.join(guest, "plan.json"),
      scriptSnapshot = path.join(guest, "operation.sh");
    snapshotFile(planPath, planSnapshot, 0o400);
    snapshotFile(script, scriptSnapshot, 0o500);
    const plan = JSON.parse(
      readStableRegular(planSnapshot, "plan snapshot").bytes,
    );
    const validity = validatePlan(plan);
    if (validity.errors.length) throw new Error(validity.errors.join("\n"));
    if (validity.blocked) throw new Error("effective risk route is blocked; external-microvm execution is not implemented");
    runChecked(process.execPath, [
      path.join(SCRIPT_DIR, "preflight-operation-script.mjs"),
      "--script",
      scriptSnapshot,
    ]);
    planSha = shaFile(planSnapshot);
    scriptSha = shaFile(scriptSnapshot);
    metadata = prepareContract({
      planPath: planSnapshot,
      operationId: a.operationId,
      contractPath: path.join(guest, "contract.json"),
      metadataDirectory: path.join(tmp, "metadata"),
      toolsPath: path.join(guest, "required-tools.txt"),
      pathPath: path.join(guest, "path.txt"),
      outputsPath: path.join(guest, "outputs.tsv"),
    });
    if (Boolean(metadata.artifactInput) !== Boolean(a.producerHandoff)) throw new Error("artifactInput and --producer-handoff must be supplied together");
    if (metadata.artifactInput) assertConsumeOnlyScript(readStableRegular(scriptSnapshot, "artifact-only consumer script").bytes);
    if (scriptSha !== metadata.plannedScriptSha256) {
      throw new Error(
        `strong-operation script SHA-256 mismatch: plan=${metadata.plannedScriptSha256} actual=${scriptSha}`,
      );
    }
    if (!metadata.plannedSourceTreeSha256) {
      throw new Error("selected strong operation has unbound sourceTreeSha256");
    }
    assertBrowserSplitMetadata(metadata);
    const outputs = fs.readFileSync(path.join(guest, "outputs.tsv"), "utf8")
      .trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
    const hasArtifact = outputs.some(([kind]) => kind === "artifact");
    if (hasArtifact !== Boolean(artifact)) {
      throw new Error(
        hasArtifact
          ? "--artifact-out is required by selected operation outputs."
          : "--artifact-out was provided but selected operation declares no artifact outputs.",
      );
    }
    if (
      metadata.operationKind === "browser-smoke" &&
      (!a.preflightSource || !a.preflightEvidence)
    ) throw new Error("browser-smoke requires preflight source and evidence");
    if (
      metadata.operationKind !== "browser-smoke" &&
      (a.preflightSource || a.preflightEvidence || a.preflightArtifact)
    ) throw new Error("preflight arguments are allowed only for browser-smoke");
    started = now();
    if (metadata.operationKind === "browser-smoke") {
      const preflightJson = path.join(guest, "preflight-validation.json"),
        args = [
          path.join(SCRIPT_DIR, "validate-operation-evidence.mjs"),
          "--plan",
          planSnapshot,
          "--operation-id",
          metadata.preflightOperationId,
          "--source",
          a.preflightSource,
          "--evidence",
          a.preflightEvidence,
        ];
      if (a.preflightArtifact) args.push("--artifact", a.preflightArtifact);
      const code = await runInterruptible(process.execPath, args, {
        timeoutMs: metadata.timeoutMs,
        containerName: `preflight-${containerName}`,
        timeoutMarker: path.join(tmp, "preflight-timeout"),
        stdoutFile: preflightJson,
        onChild: (c) => state.activeChild = c,
      });
      if (code !== 0) {
        throw new Error(
          "browser preflight evidence is not reusable for the current plan",
        );
      }
      preflightSha =
        JSON.parse(fs.readFileSync(preflightJson)).evidenceBindingSha256;
    }
    throwIfInterrupted();
    let readinessLeft = remainingMs(started.mono, metadata.timeoutMs);
    if (readinessLeft <= 0) {
      throw new Error("wall-clock timeout exhausted before source readiness");
    }
    const snapshotJson = path.join(guest, "source-snapshot.json"),
      sourceSnapshot = path.join(tmp, "source-snapshot");
    let code = await runInterruptible(process.execPath, [
      path.join(tmp, "bundle-files", "strong-operation-contract.mjs"),
      "snapshot",
      "--source",
      source,
      "--destination",
      sourceSnapshot,
      "--max-entries",
      String(metadata.maxSourceEntries),
      "--max-bytes",
      String(metadata.maxSourceBytes),
    ], {
      timeoutMs: readinessLeft,
      containerName: `source-readiness-${containerName}`,
      timeoutMarker: path.join(tmp, "source-readiness-timeout"),
      stdoutFile: snapshotJson,
      onChild: (c) => state.activeChild = c,
    });
    if (code !== 0) {
      throw new Error("bounded source snapshot readiness failed or timed out");
    }
    sourceSha =
      JSON.parse(fs.readFileSync(snapshotJson)).snapshot.sourceTreeSha256;
    if (sourceSha !== metadata.plannedSourceTreeSha256) {
      throw new Error("strong-operation source tree SHA-256 mismatch during readiness");
    }
    throwIfInterrupted();
    if (metadata.artifactInput) {
      producerArtifactSnapshot = path.join(tmp, "producer-artifact-snapshot");
      const handoff = resolveArtifactHandoff({ planPath: planSnapshot, plan, consumer: plan.operations.find(operation => operation.id === a.operationId), handoffPath: a.producerHandoff, snapshotDestination: producerArtifactSnapshot });
      handoffBindingSha256 = handoff.handoffBindingSha256;
    }
    const binding = bindingSha256([
      metadata.operationContractSha256,
      metadata.plannedSourceTreeSha256,
      preflightSha,
      ...(handoffBindingSha256 ? [handoffBindingSha256] : []),
    ]);
    runChecked(path.join(SCRIPT_DIR, "ensure-apple-container-ready.sh"), []);
    readinessLeft = remainingMs(started.mono, metadata.timeoutMs);
    if (readinessLeft <= 0) {
      throw new Error("wall-clock timeout exhausted before image/tool readiness");
    }
    const readinessArgs = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--cpus",
      String(metadata.cpus),
      "--memory",
      metadata.memory,
      "--cap-drop",
      "ALL",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--mount",
      `type=bind,source=${guest},target=/guest,readonly`,
      "--workdir",
      "/tmp",
      "-e",
      `PATH=${fs.readFileSync(path.join(guest, "path.txt"), "utf8").trim().split("\n").join(":")}`,
      "-e",
      "HOME=/tmp/home",
      "-e",
      "XDG_CACHE_HOME=/tmp/cache",
    ];
    if (metadata.network === "disabled") {
      readinessArgs.push("--network", "none", "--no-dns");
    }
    readinessArgs.push(
      metadata.image,
      "/bin/bash",
      "-Eeuo",
      "pipefail",
      "-c",
      "mkdir -p /tmp/home /tmp/cache; chmod 700 /tmp/home /tmp/cache; while IFS= read -r tool; do [[ -z \"$tool\" ]] && continue; command -v -- \"$tool\" >/dev/null 2>&1 || { printf \"ERROR: required tool unavailable: %s\\n\" \"$tool\" >&2; exit 127; }; done < /guest/required-tools.txt",
    );
    const readinessCode = await runInterruptible("container", readinessArgs, {
      timeoutMs: readinessLeft,
      containerName,
      timeoutMarker: path.join(tmp, "readiness-timeout"),
      onChild: (c) => state.activeChild = c,
    });
    if (readinessCode !== 0) {
      throw new Error(`immutable image/tool readiness failed with exit ${readinessCode}`);
    }
    throwIfInterrupted();
    const reservation = JSON.parse(
      runChecked(process.execPath, [
        path.join(SCRIPT_DIR, "attempt-ledger.mjs"),
        "reserve",
        "--ledger",
        ledger,
        "--workflow-id",
        metadata.workflowId,
        "--role-key",
        metadata.roleKey,
        "--operation-id",
        a.operationId,
        "--binding-sha256",
        binding,
        "--failure-classification",
        a.failureClassification,
      ]),
    );
    state.attemptId = reservation.attemptId;
    attemptStarted = { utc: reservation.startedAtUtc, mono: process.hrtime.bigint() };
    const writeEarlyFailure = (reason) => {
      if (!fs.existsSync(path.join(failureStage, "operation-status.json"))) {
        writeOperationStatus(path.join(failureStage, "operation-status.json"), {
          kind: "failure",
          reason,
          exitCode: 1,
          operationId: a.operationId,
          workflowId: metadata.workflowId,
          roleKey: metadata.roleKey,
          planSha256: planSha,
          operationContractSha256: metadata.operationContractSha256,
          sourceTreeSha256: metadata.plannedSourceTreeSha256,
          preflightEvidenceSha256: preflightSha,
          scriptSha256: scriptSha,
          image: metadata.image,
          network: metadata.network,
          startedAtUtc: attemptStarted.utc,
          endedAtUtc: authoritativeEndedAtUtc ??= new Date().toISOString(),
          elapsedMs: authoritativeElapsedMs ??= elapsedMs(attemptStarted.mono),
        });
      }
      state.publishedEvidence = publishTree(
        failureStage,
        evidence,
        evidenceIdentity,
      );
      failureStage = null;
      state.committed = true;
    };
    let left = remainingMs(started.mono, metadata.timeoutMs);
    snapshotFile(
      path.join(tmp, "bundle-files", "strong-operation-entrypoint.sh"),
      path.join(guest, "entrypoint.sh"),
      0o500,
    );
    const pathValue = fs.readFileSync(path.join(guest, "path.txt"), "utf8")
      .trim().split("\n").join(":");
    left = remainingMs(started.mono, metadata.timeoutMs);
    if (left <= 0) {
      throw new Error(
        "strong operation exhausted its wall-clock timeout during preparation",
      );
    }
    const cargs = [
      "run",
      "--name",
      containerName,
      "--cpus",
      String(metadata.cpus),
      "--memory",
      metadata.memory,
      "--cap-drop",
      "ALL",
      "--read-only",
      "--tmpfs",
      "/work",
      "--tmpfs",
      "/tmp",
      "--mount",
      `type=bind,source=${sourceSnapshot},target=/source,readonly`,
      "--mount",
      `type=bind,source=${guest},target=/guest,readonly`,
      "--mount",
      `type=bind,source=${path.join(tmp, "lifecycle")},target=/lifecycle`,
      "--mount",
      `type=bind,source=${evidenceStage},target=/evidence`,
      "--mount",
      `type=bind,source=${artifactStage},target=/artifacts`,
      "--workdir",
      "/work",
      "-e",
      `PATH=${pathValue}`,
      "-e",
      "HOME=/tmp/home",
      "-e",
      "XDG_CACHE_HOME=/tmp/cache",
      "-e",
      `STRONG_OPERATION_ID=${a.operationId}`,
      "-e",
      `STRONG_OPERATION_WORKFLOW_ID=${metadata.workflowId}`,
      "-e",
      `STRONG_OPERATION_ROLE_KEY=${metadata.roleKey}`,
      "-e",
      `STRONG_OPERATION_PLAN_SHA256=${planSha}`,
      "-e",
      `STRONG_OPERATION_CONTRACT_SHA256=${metadata.operationContractSha256}`,
      "-e",
      `STRONG_OPERATION_SOURCE_TREE_SHA256=${sourceSha}`,
      "-e",
      `STRONG_OPERATION_PREFLIGHT_EVIDENCE_SHA256=${preflightSha}`,
      "-e",
      `STRONG_OPERATION_SCRIPT_SHA256=${scriptSha}`,
      "-e",
      `STRONG_OPERATION_IMAGE=${metadata.image}`,
      "-e",
      `STRONG_OPERATION_NETWORK=${metadata.network}`,
      "-e",
      `STRONG_OPERATION_RUNNER_BUNDLE_VERSION=${RUNNER_BUNDLE_VERSION}`,
    ];
    if (producerArtifactSnapshot) {
      cargs.push("--mount", `type=bind,source=${producerArtifactSnapshot},target=/producer-artifact,readonly`, "-e", "STRONG_OPERATION_PRODUCER_ARTIFACT=/producer-artifact");
    }
    if (metadata.network === "disabled") {
      cargs.push("--network", "none", "--no-dns");
    }
    cargs.push(metadata.image, "/bin/bash", "/guest/entrypoint.sh");
    code = await runInterruptible("container", cargs, {
      timeoutMs: left,
      containerName,
      timeoutMarker: path.join(tmp, "host-timeout"),
      onChild: (c) => state.activeChild = c,
    });
    throwIfInterrupted();
    const lifecycle = path.join(tmp, "lifecycle"),
      startedMarker = path.join(lifecycle, "started"),
      completedMarker = path.join(lifecycle, "completed");
    if (
      !fs.existsSync(startedMarker) ||
      fs.readFileSync(startedMarker, "utf8").trim() !== "started"
    ) {
      writeEarlyFailure("container lifecycle start marker is missing");
      throw new Error("container runtime failed before lifecycle start");
    }
    if (!fs.existsSync(completedMarker)) {
      writeEarlyFailure("container lifecycle completion record is missing");
      throw new Error("container runtime failed before completion");
    }
    const opExit = Number(fs.readFileSync(completedMarker, "utf8").trim());
    if (!Number.isInteger(opExit) || opExit !== code) {
      writeEarlyFailure(
        "container CLI exit disagrees with operation completion record",
      );
      throw new Error("container exit disagreement");
    }
    const ended = now();
    authoritativeEndedAtUtc = ended.utc;
    authoritativeElapsedMs = elapsedMs(attemptStarted.mono, ended.mono);
    writeOperationStatus(path.join(tmp, "status", "operation-status.json"), {
      kind: "attestation",
      exitCode: code,
      operationId: a.operationId,
      workflowId: metadata.workflowId,
      roleKey: metadata.roleKey,
      planSha256: planSha,
      operationContractSha256: metadata.operationContractSha256,
      sourceTreeSha256: sourceSha,
      preflightEvidenceSha256: preflightSha,
      scriptSha256: scriptSha,
      image: metadata.image,
      network: metadata.network,
    });
    left = remainingMs(started.mono, metadata.timeoutMs);
    if (left <= 0) {
      writeEarlyFailure(
        "wall-clock timeout exhausted before output verification",
      );
      throw new Error(
        "wall-clock timeout exhausted before output verification",
      );
    }
    const verifyArgs = [
      path.join(tmp, "bundle-files", "verify-strong-operation-output.mjs"),
      path.join(tmp, "status", "operation-status.json"),
      evidenceStage,
      artifactStage,
      failureStage,
      path.join(guest, "outputs.tsv"),
      a.operationId,
      metadata.workflowId,
      metadata.roleKey,
      planSha,
      metadata.operationContractSha256,
      sourceSha,
      preflightSha,
      scriptSha,
      metadata.image,
      metadata.network,
      String(code),
      path.join(tmp, "host-timeout"),
      String(metadata.timeoutMs),
      attemptStarted.utc,
      authoritativeEndedAtUtc,
      String(authoritativeElapsedMs),
      String(metadata.cpus),
      metadata.memory,
      String(metadata.maxFileSize),
      String(metadata.maxOutputBytes),
      RUNNER_BUNDLE_VERSION,
    ];
    const verifyCode = await runInterruptible(process.execPath, verifyArgs, {
      timeoutMs: left,
      containerName: `verify-${containerName}`,
      timeoutMarker: path.join(tmp, "verify-timeout"),
      onChild: (c) => state.activeChild = c,
    });
    if (![0, 2].includes(verifyCode)) {
      writeEarlyFailure("output verification failed or timed out");
      throw new Error("output verification failed or timed out");
    }
    if (verifyCode === 0) {
      const validateArgs = [
        path.join(SCRIPT_DIR, "validate-operation-evidence.mjs"),
        "--plan",
        planSnapshot,
        "--operation-id",
        a.operationId,
        "--source",
        sourceSnapshot,
        "--evidence",
        evidenceStage,
      ];
      if (artifact) validateArgs.push("--artifact", artifactStage);
      if (a.producerHandoff) validateArgs.push("--producer-handoff", a.producerHandoff);
      if (metadata.operationKind === "browser-smoke") {
        validateArgs.push(
          "--preflight-source",
          a.preflightSource,
          "--preflight-evidence",
          a.preflightEvidence,
        );
        if (a.preflightArtifact) {
          validateArgs.push("--preflight-artifact", a.preflightArtifact);
        }
      }
      runChecked(process.execPath, validateArgs);
    }
    const result = await commitResult({
      state,
      verifiedFailure: verifyCode === 2,
      publishArtifact: artifact
        ? () => {
          state.publishedArtifact = publishTree(
            artifactStage,
            artifact,
            artifactIdentity,
          );
          artifactStage = null;
        }
        : null,
      publishEvidence: () => {
        state.publishedEvidence = publishTree(
          evidenceStage,
          evidence,
          evidenceIdentity,
        );
        evidenceStage = null;
      },
      finalize: finalizeLedger,
    });
    if (result.pendingSignal) {
      console.error(
        `WARNING: signal ${result.pendingSignal} arrived after verified commit began; preserving committed result.`,
      );
    }
    if (result.exitCode === 0) {
      console.log(
        `STRONG_OPERATION_PASS: ${a.operationId} contract=${metadata.operationContractSha256} source=${sourceSha} runnerBundleSha256=${bundleSha} elapsedMs=${
          authoritativeElapsedMs
        }`,
      );
    }
    return result.exitCode;
  } catch (error) {
    if (
      !state.committed && state.attemptId && metadata && started &&
      !fs.existsSync(path.join(failureStage ?? "", "operation-status.json"))
    ) {
      try {
        writeOperationStatus(path.join(failureStage, "operation-status.json"), {
          kind: "failure",
          reason: error.message,
          exitCode: error.exitCode ?? 1,
          operationId: a.operationId,
          workflowId: metadata.workflowId,
          roleKey: metadata.roleKey,
          planSha256: planSha,
          operationContractSha256: metadata.operationContractSha256,
          sourceTreeSha256: metadata.plannedSourceTreeSha256,
          preflightEvidenceSha256: preflightSha,
          scriptSha256: scriptSha,
          image: metadata.image,
          network: metadata.network,
          startedAtUtc: attemptStarted.utc,
          endedAtUtc: authoritativeEndedAtUtc ??= new Date().toISOString(),
          elapsedMs: authoritativeElapsedMs ??= elapsedMs(attemptStarted.mono),
        });
        state.publishedEvidence = publishTree(
          failureStage,
          evidence,
          evidenceIdentity,
        );
        failureStage = null;
        state.committed = true;
      } catch {}
    }
    console.error(`ERROR: ${error.message}`);
    return error.exitCode ?? 1;
  } finally {
    cleanup();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
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
if (isDirectCli()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });
}
