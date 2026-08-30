#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { validatePlan } from "./validate-execution-plan.mjs";

function fail(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

const packageRoot = process.env.JUST_BASH_PACKAGE_ROOT;
const root = process.env.JUST_BASH_ROOT;
const planPath = process.env.JUST_BASH_PLAN;
if (!packageRoot) fail("JUST_BASH_PACKAGE_ROOT is required.", 2);
if (!root) fail("JUST_BASH_ROOT is required.", 2);
if (!planPath) fail("JUST_BASH_PLAN is required.", 2);

let plan;
try {
  plan = JSON.parse(await readFile(planPath, "utf8"));
} catch (error) {
  fail(`Cannot read execution plan ${planPath}: ${error.message}`, 2);
}
const planValidation = validatePlan(plan);
if (planValidation.errors.length) fail(`Execution plan failed full v5 validation: ${planValidation.errors.join(" ")}`, 2);
if (planValidation.blocked) fail("Execution plan risk decision is blocked; Tier-A execution is forbidden.", 2);
if (plan.capabilities?.network?.enabled !== false) fail("Bundled runner requires network=false.", 2);
if (plan.capabilities?.javascript !== false || plan.capabilities?.python !== false) fail("Bundled runner requires JavaScript and Python capabilities to remain disabled.", 2);
if (!Array.isArray(plan.capabilities?.customCommands) || plan.capabilities.customCommands.length !== 0) fail("Bundled runner requires an empty customCommands array.", 2);
const limits = plan.limits;
for (const key of ["maxCommands", "maxOutputBytes", "maxFileSizeBytes", "maxMemoryBytes", "timeoutMs"]) {
  if (!Number.isInteger(limits?.[key]) || limits[key] <= 0) fail(`Execution plan limit ${key} must be a positive integer.`, 2);
}
const candidateStage = plan.candidateStage;
if (!candidateStage || typeof candidateStage.name !== "string" || !Array.isArray(candidateStage.mutationIds) || typeof candidateStage.promotable !== "boolean") {
  fail("Execution plan v5 candidateStage contract is required.", 2);
}
const candidateExports = plan.candidateExports;
if (!Array.isArray(candidateExports)) fail("Execution plan candidateExports must be an array of post-image paths.", 2);
const candidateOutputRoot = process.env.JUST_BASH_CANDIDATE_OUT;
if (candidateExports.length > 0 && !candidateOutputRoot) fail("JUST_BASH_CANDIDATE_OUT is required when candidateExports is non-empty.", 2);
const completion = plan.completion;
if (!Number.isInteger(completion?.minStdoutBytes) || completion.minStdoutBytes <= 0) {
  fail("Execution plan completion.minStdoutBytes must be a positive integer.", 2);
}
if (!Array.isArray(completion.requiredStdoutMarkers) || completion.requiredStdoutMarkers.length === 0 || completion.requiredStdoutMarkers.some(marker => typeof marker !== "string" || !marker.trim())) {
  fail("Execution plan completion.requiredStdoutMarkers must contain at least one non-empty marker.", 2);
}
if (completion.requiredStdoutMarkers.includes("REPLACE_WITH_TASK_SPECIFIC_COMPLETION_MARKER")) {
  fail("Execution plan completion marker still contains the template placeholder.", 2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const scriptBytes = Buffer.concat(chunks);
const script = scriptBytes.toString("utf8");
if (!script.trim()) fail("Runner received an empty script on stdin.", 2);
const scriptSha256 = createHash("sha256").update(scriptBytes).digest("hex");
if (scriptSha256 !== plan.tierA.scriptSha256) fail(`Tier-A script SHA-256 mismatch: plan=${plan.tierA.scriptSha256} actual=${scriptSha256}.`, 2);
if (!/^set -e(?:u)?\r?\n/.test(script)) fail("Tier-A script must begin with set -e (or set -eu) so an earlier failed command cannot be masked by a later marker.", 2);

let module;
try {
  const entry = join(packageRoot, "node_modules", "just-bash", "dist", "bundle", "index.js");
  module = await import(pathToFileURL(entry).href);
} catch (error) {
  fail(`Cannot load just-bash from ${packageRoot}: ${error.message}`);
}

const { Bash, InMemoryFs, OverlayFs } = module;
let fs;
let cwd;
switch (plan.workspace?.mode) {
  case "read-only":
    fs = new OverlayFs({
      root,
      readOnly: true,
      maxFileReadSize: limits.maxFileSizeBytes,
      maxMemoryBytes: limits.maxMemoryBytes,
    });
    cwd = fs.getMountPoint();
    break;
  case "overlay-cow":
    fs = new OverlayFs({
      root,
      maxFileReadSize: limits.maxFileSizeBytes,
      maxMemoryBytes: limits.maxMemoryBytes,
    });
    cwd = fs.getMountPoint();
    break;
  case "in-memory":
    fs = new InMemoryFs({}, { maxTotalBytes: limits.maxMemoryBytes });
    cwd = "/";
    break;
  default:
    fail("Execution plan workspace.mode must be in-memory, read-only, or overlay-cow.", 2);
}
const bash = new Bash({
  fs,
  cwd,
  javascript: false,
  python: false,
  executionLimits: {
    maxCommandCount: limits.maxCommands,
    maxSourceBytes: limits.maxFileSizeBytes,
    maxOutputSize: limits.maxOutputBytes,
    maxExecutionTimeMs: limits.timeoutMs,
  },
});

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), limits.timeoutMs + 5000);
try {
  const result = await bash.exec(script, { signal: controller.signal, rawScript: true });
  if (result.exitCode === 0) {
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stdoutBytes = Buffer.byteLength(stdout);
    if (stdoutBytes < completion.minStdoutBytes) {
      fail(`just-bash reported success but stdout had ${stdoutBytes} byte(s); completion requires at least ${completion.minStdoutBytes}.`);
    }
    const missingMarkers = completion.requiredStdoutMarkers.filter(marker => !stdout.includes(marker));
    if (missingMarkers.length > 0) {
      fail(`just-bash reported success but stdout missed required completion marker(s): ${missingMarkers.join(", ")}`);
    }
    const exported = {};
    for (const target of candidateExports) {
      try {
        const sourcePath = fs.resolvePath(cwd, target);
        const bytes = await fs.readFileBuffer(sourcePath);
        const outputPath = join(candidateOutputRoot, target);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
        exported[target] = createHash("sha256").update(bytes).digest("hex");
      } catch (error) {
        fail(`Cannot export candidate target ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    result.candidateExports = exported;
  }
  process.stdout.write(JSON.stringify(result));
  process.exitCode = result.exitCode;
} catch (error) {
  fail(`just-bash execution failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  clearTimeout(timer);
}
