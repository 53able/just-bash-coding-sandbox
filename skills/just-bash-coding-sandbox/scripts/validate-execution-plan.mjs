#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { containsRebuildCommand, validateArtifactConsumer } from "./artifact-handoff-contract.mjs";
import { deriveRiskDecision, riskDecisionSha256, STRONG_KINDS, validateRiskIntake } from "./risk-intake.mjs";

const SAFE_OPERATIONS = new Set(["read", "search", "compare", "text-edit", "file-generate", "json-transform", "csv-transform", "diff", "patch-generate"]);
const CANDIDATE_OPERATIONS = new Set(["text-edit", "file-generate", "json-transform", "csv-transform"]);
const CONTAINER_OPERATIONS = new Set(["build", "test", "package-install", "native-exec", "repository-script", "browser-preflight", "browser-smoke"]);
const MICROVM_OPERATIONS = new Set(["docker", "unknown"]);
const PROFILES = new Set(["text-only", "standard", "high-risk"]);
const CHANGE_CLASSES = new Set(["source", "dependency", "automation", "credential-sensitive", "binary", "sandbox-infrastructure"]);
const WORKSPACE_MODES = new Set(["in-memory", "read-only", "overlay-cow"]);
const TARGETS = new Set(["none", "container", "external-microvm"]);
const NETWORKS = new Set(["disabled", "registry"]);
const COMPLETION_PLACEHOLDER = "REPLACE_WITH_TASK_SPECIFIC_COMPLETION_MARKER";
const TIER_A_SHA_PLACEHOLDER = "REPLACE_WITH_TIER_A_SCRIPT_SHA256";
const SHA256 = /^[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/;
const DANGEROUS_COMMAND = /(^|[\s;&|()])(?:npm|npx|pnpm|yarn|bun|deno|node|python\d*|ruby|perl|php|java|javac|go|zig|cargo|rustc|gcc|g\+\+|clang|make|cmake|bash|sh|zsh|fish|docker|podman|kubectl|helm|terraform|ansible)(?=$|[\s;&|()])/i;
const CURL_COMMAND = /(^|[\s;&|()])(?:curl|wget)(?=$|[\s;&|()])/i;
const PACKAGE_TARGET = /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc.*|pnpmfile\..*|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|build\.zig(?:\.zon)?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|composer\.json|composer\.lock|deno\.jsonc?|packages\.lock\.json|[^/]+\.csproj|Package\.swift|Package\.resolved|setup\.py|setup\.cfg|requirements[^/]*\.in|environment\.ya?ml|conda-lock\.ya?ml|[^/]+\.gemspec|mix\.exs|mix\.lock|pubspec\.ya?ml|pubspec\.lock|project\.clj|deps\.edn|build\.sbt|vcpkg\.json|conanfile\.(?:py|txt)|Podfile(?:\.lock)?|Cartfile(?:\.resolved)?|flake\.nix|flake\.lock)$/;

function classifyTarget(target) {
  const classes = new Set(["source"]);
  const mark = value => { classes.delete("source"); classes.add(value); };
  if (PACKAGE_TARGET.test(target) || /(?:^|\/)(?:Dockerfile|Containerfile)$/.test(target)) mark("dependency");
  if (/^(?:\.git\/hooks\/|\.github\/workflows\/|\.circleci\/|\.buildkite\/)|(?:^|\/)(?:Jenkinsfile|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|build\.zig|Makefile|Taskfile\.ya?ml)$|(?:^|\/)(?:install|build|test|release|deploy)\.(?:sh|bash|zsh|js|mjs|cjs|py)$/.test(target)) mark("automation");
  if (/(?:^|\/)(?:\.env(?:\..*)?|id_rsa|credentials|secrets?\.(?:json|ya?ml))$/.test(target)) mark("credential-sensitive");
  if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z|jar|war|wasm|exe|dll|dylib|so|a|o|bin|png|jpe?g|gif|webp|pdf)$/i.test(target)) mark("binary");
  if (target === "SKILL.md" || /^(?:assets\/(?:execution-(?:plan\.json|report\.md)|strong-operation\.json|gate-plan\.json)|references\/(?:execution-policy|parallel-execution|browser-validation|interactive-validation|strong-operation-authoring|artifact-handoff|gate-reports|workflow-efficiency|v4-migration)\.md|scripts\/(?:run|bootstrap|ensure|preflight|validate|review|self-test|just-bash-runner|strong-operation|risk-intake|attempt-ledger|aggregate-workflow-report|apply-candidate-patch|generate-candidate-patch|generate-gate-report|gate-report-contract|artifact-handoff-contract)[^/]*)$/.test(target)) mark("sandbox-infrastructure");
  return classes;
}

function safeRepositoryFile(value) {
  if (typeof value !== "string" || !value.trim() || value === "." || value.startsWith("/") || value.endsWith("/") || value.includes("\\") || /[\s\0\x7f]/u.test(value)) return false;
  const segments = value.split("/");
  return !segments.includes("") && !segments.includes(".") && !segments.includes("..");
}
function pathsOverlap(left, right) { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
function nonEmptyStrings(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || !item.trim())) errors.push(`${path} must be a non-empty array of non-empty strings.`);
}
function positiveInteger(value, path, errors) { if (!Number.isInteger(value) || value <= 0) errors.push(`${path} must be a positive integer.`); }
function zero(value, path, errors) { if (value !== 0) errors.push(`${path} must be 0 when interactive delivery is not required.`); }

export function validatePlan(plan) {
  const errors = [];
  const hasIntake = plan?.intake !== undefined;
  if (hasIntake) errors.push(...validateRiskIntake(plan.intake));
  if ([1, 2, 3, 4].includes(plan?.version)) errors.push(`version ${plan.version} plans are rejected; migrate to version 5 with workflow identity, mutation contracts, role keys, and Apple Container runtime scope.`);
  else if (plan?.version !== 5) errors.push("version must be 5.");
  if (typeof plan?.workflowId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(plan.workflowId)) errors.push("workflowId must be a lowercase stable identifier.");
  if (plan?.runtime?.provider !== "apple-container" || plan?.runtime?.scope !== "local-macos-only") errors.push("runtime must declare provider=apple-container and scope=local-macos-only.");
  if (typeof plan?.task !== "string" || !plan.task.trim()) errors.push("task must be a non-empty string.");
  if (!PROFILES.has(plan?.profile)) errors.push("profile must be text-only, standard, or high-risk.");
  if (!plan?.workspace || !WORKSPACE_MODES.has(plan.workspace.mode)) errors.push("workspace.mode must be in-memory, read-only, or overlay-cow.");
  if (typeof plan?.workspace?.root !== "string" || !plan.workspace.root.trim()) errors.push("workspace.root must be a non-empty string.");
  if (plan?.tierA?.scriptSha256 === TIER_A_SHA_PLACEHOLDER) errors.push("tierA.scriptSha256 still contains the template placeholder; replace it with the SHA-256 of the exact reviewed Tier-A script bytes for this task.");
  else if (!plan?.tierA || !SHA256.test(plan.tierA.scriptSha256 ?? "")) errors.push("tierA.scriptSha256 must be 64 lowercase hexadecimal characters and bind the reviewed Tier-A script bytes.");

  let packageTargetDeclared = false;
  let containerDependencyTargetDeclared = false;
  const changeSet = plan?.changeSet;
  const mutationById = new Map(), preimageOwners = new Map(), postimageOwners = new Map(), ownedPaths = [];
  if (!changeSet || typeof changeSet !== "object" || !Array.isArray(changeSet.mutations) || changeSet.mutations.length === 0) errors.push("changeSet.mutations must be a non-empty array.");
  else {
    const derived = new Set();
    for (const [index, mutation] of changeSet.mutations.entries()) {
      const label = `changeSet.mutations[${index}]`;
      if (!mutation || typeof mutation !== "object") { errors.push(`${label} must be an object.`); continue; }
      if (typeof mutation.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(mutation.id)) errors.push(`${label}.id must be a lowercase identifier.`);
      else if (mutationById.has(mutation.id)) errors.push(`${label}.id must be unique: ${mutation.id}`); else mutationById.set(mutation.id, mutation);
      if (!["add", "modify", "delete", "rename"].includes(mutation.type)) { errors.push(`${label}.type must be add, modify, delete, or rename.`); continue; }
      const paths = mutation.type === "rename" ? [mutation.from, mutation.to] : [mutation.path];
      for (const target of paths) {
        if (!safeRepositoryFile(target)) errors.push(`${label} contains an unsafe repository-relative path: ${JSON.stringify(target)}`);
        else {
          for (const value of classifyTarget(target)) derived.add(value);
          if (PACKAGE_TARGET.test(target)) packageTargetDeclared = true;
          if (/(?:^|\/)(?:Dockerfile|Containerfile)$/.test(target)) containerDependencyTargetDeclared = true;
          for (const owner of ownedPaths) if (pathsOverlap(target, owner.path)) errors.push(`${label} has duplicate or ancestor/descendant overlap with mutation ${owner.id}: ${target} <> ${owner.path}`);
          ownedPaths.push({ path: target, id: mutation.id });
        }
      }
      const preimagePath = mutation.type === "rename" ? mutation.from : mutation.path;
      const postimagePath = mutation.type === "delete" ? null : mutation.type === "rename" ? mutation.to : mutation.path;
      if (safeRepositoryFile(preimagePath)) { if (preimageOwners.has(preimagePath)) errors.push(`${label} overlaps mutation preimage path owned by ${preimageOwners.get(preimagePath)}: ${preimagePath}`); else preimageOwners.set(preimagePath, mutation.id); }
      if (safeRepositoryFile(postimagePath)) { if (postimageOwners.has(postimagePath)) errors.push(`${label} overlaps mutation post-image path owned by ${postimageOwners.get(postimagePath)}: ${postimagePath}`); else postimageOwners.set(postimagePath, mutation.id); }
      if (mutation.type === "add") {
        if (mutation.beforeSha256 !== null) errors.push(`${label}.beforeSha256 must be null for add.`);
        for (const key of Object.keys(mutation)) if (!["id","type","path","beforeSha256"].includes(key)) errors.push(`${label} contains unknown field: ${key}`);
      } else {
        if (!SHA256.test(mutation.beforeSha256 ?? "")) errors.push(`${label}.beforeSha256 must bind the existing source bytes.`);
        if (mutation.type === "rename" && mutation.from === mutation.to) errors.push(`${label}.from and .to must differ.`);
        const allowed = mutation.type === "rename" ? ["id","type","from","to","beforeSha256"] : ["id","type","path","beforeSha256"];
        for (const key of Object.keys(mutation)) if (!allowed.includes(key)) errors.push(`${label} contains unknown field: ${key}`);
      }
    }
    if (!Array.isArray(changeSet.classes) || changeSet.classes.length === 0) errors.push("changeSet.classes must be a non-empty array.");
    else { for (const value of changeSet.classes) if (!CHANGE_CLASSES.has(value)) errors.push(`changeSet.classes contains an unsupported class: ${value}`); for (const value of derived) if (!changeSet.classes.includes(value)) errors.push(`changeSet.classes must include ${value}, derived from mutations.`); }
    if (typeof changeSet.expectedReviewRequired !== "boolean") errors.push("changeSet.expectedReviewRequired must be a boolean.");
    else if ([...derived].some(value => value !== "source") && !changeSet.expectedReviewRequired) errors.push("changeSet.expectedReviewRequired must be true for non-source target classes.");
  }

  const stage = plan?.candidateStage;
  let stageSet = new Set();
  if (!stage || typeof stage !== "object") errors.push("candidateStage contract is required.");
  else {
    if (typeof stage.name !== "string" || !stage.name.trim()) errors.push("candidateStage.name must be a non-empty string.");
    if (typeof stage.promotable !== "boolean") errors.push("candidateStage.promotable must be a boolean.");
    if (!Array.isArray(stage.mutationIds)) errors.push("candidateStage.mutationIds must be an array.");
    else {
      const ids = new Set(stage.mutationIds); if (ids.size !== stage.mutationIds.length) errors.push("candidateStage.mutationIds must not contain duplicates.");
      for (const id of ids) if (!mutationById.has(id)) errors.push(`candidateStage.mutationIds references unknown mutation: ${id}`);
      if (stage.promotable && (ids.size !== mutationById.size || [...mutationById.keys()].some(id => !ids.has(id)))) errors.push("candidateStage.mutationIds must include every mutation when promotable is true.");
      for (const id of ids) { const m=mutationById.get(id); if (m?.type === "add" || m?.type === "modify") stageSet.add(m.path); else if (m?.type === "rename") stageSet.add(m.to); }
    }
  }

  const exports = plan?.candidateExports;
  if (!Array.isArray(exports)) errors.push("candidateExports must be an array of post-image paths.");
  else {
    const seen = new Set();
    for (const target of exports) { if (!safeRepositoryFile(target)) errors.push(`candidateExports contains an unsafe path: ${JSON.stringify(target)}`); else if (!stageSet.has(target)) errors.push(`candidateExports is not a staged post-image path: ${target}`); if (seen.has(target)) errors.push(`candidateExports contains a duplicate: ${target}`); seen.add(target); }
    if (stage?.promotable && (seen.size !== stageSet.size || [...stageSet].some(path => !seen.has(path)))) errors.push("candidateExports must exactly equal staged post-image paths when promotable is true.");
    if (plan?.workspace?.mode === "read-only" && exports.length) errors.push("candidateExports must be empty for a read-only workspace.");
  }

  const caps = plan?.capabilities;
  if (!caps || typeof caps !== "object") errors.push("capabilities must be an object.");
  else {
    if (caps.javascript !== false) errors.push("capabilities.javascript must be false.");
    if (caps.python !== false) errors.push("capabilities.python must be false.");
    if (!Array.isArray(caps.customCommands) || caps.customCommands.length) errors.push("capabilities.customCommands must be empty.");
    if (!caps.network || caps.network.enabled !== false || !Array.isArray(caps.network.allowedUrlPrefixes) || caps.network.allowedUrlPrefixes.length) errors.push("Tier A network must be disabled with an empty allowedUrlPrefixes array.");
  }
  if (!plan?.limits || typeof plan.limits !== "object") errors.push("limits must be an object.");
  else for (const key of ["maxCommands", "maxOutputBytes", "maxFileSizeBytes", "maxSourceEntries", "maxSourceBytes", "maxMemoryBytes", "timeoutMs"]) positiveInteger(plan.limits[key], `limits.${key}`, errors);
  const retryPolicy = plan?.retryPolicy;
  if (!retryPolicy || typeof retryPolicy !== "object") errors.push("retryPolicy is required for version 5 plans.");
  else {
    if (retryPolicy.maxAttemptsPerOperation !== 2) errors.push("retryPolicy.maxAttemptsPerOperation must be 2 (initial attempt plus one classified retry).");
    if (retryPolicy.maxBatchRepairCycles !== 1) errors.push("retryPolicy.maxBatchRepairCycles must be 1.");
    if (retryPolicy.blindRetry !== false) errors.push("retryPolicy.blindRetry must be false.");
  }
  if (!plan?.completion || typeof plan.completion !== "object") errors.push("completion must be an object.");
  else {
    positiveInteger(plan.completion.minStdoutBytes, "completion.minStdoutBytes", errors);
    nonEmptyStrings(plan.completion.requiredStdoutMarkers, "completion.requiredStdoutMarkers", errors);
    if (plan.completion.requiredStdoutMarkers?.includes(COMPLETION_PLACEHOLDER)) errors.push("completion marker still contains the template placeholder.");
  }

  const delivery = plan?.delivery;
  if (!delivery || typeof delivery !== "object") errors.push("delivery contract is required.");
  else {
    const host = delivery.hostRuntime;
    if (!host || typeof host.required !== "boolean" || !Array.isArray(host.commands)) errors.push("delivery.hostRuntime must contain boolean required and commands array.");
    else {
      if (host.commands.some(value => typeof value !== "string" || !value.trim())) errors.push("delivery.hostRuntime.commands must contain non-empty strings.");
      if (host.required && host.commands.length === 0) errors.push("delivery.hostRuntime.commands must be non-empty when required is true.");
      if (!host.required && host.commands.length !== 0) errors.push("delivery.hostRuntime.commands must be empty when required is false.");
    }
    const interactive = delivery.interactive;
    if (!interactive || typeof interactive.required !== "boolean" || !Array.isArray(interactive.oracles)) errors.push("delivery.interactive must contain required, runner, command, terminalType, rows, columns, and oracles.");
    else {
      if (interactive.oracles.some(value => typeof value !== "string" || !value.trim())) errors.push("delivery.interactive.oracles must contain non-empty strings.");
      if (interactive.required) {
        if (!new Set(["host", "container"]).has(interactive.runner)) errors.push("delivery.interactive.runner must be host or container when required.");
        if (typeof interactive.command !== "string" || !interactive.command.trim()) errors.push("delivery.interactive.command must be non-empty when required.");
        if (typeof interactive.terminalType !== "string" || !interactive.terminalType.trim()) errors.push("delivery.interactive.terminalType must be non-empty when required.");
        positiveInteger(interactive.rows, "delivery.interactive.rows", errors);
        positiveInteger(interactive.columns, "delivery.interactive.columns", errors);
        if (interactive.oracles.length === 0) errors.push("delivery.interactive.oracles must be non-empty when required.");
        if (interactive.runner === "host" && (!host?.required || !host.commands?.includes(interactive.command))) errors.push("host interactive runner requires hostRuntime.required=true and an exact matching declared host command.");
      } else {
        if (interactive.runner !== "none") errors.push("delivery.interactive.runner must be none when not required.");
        if (interactive.command !== "") errors.push("delivery.interactive.command must be empty when not required.");
        if (interactive.terminalType !== "") errors.push("delivery.interactive.terminalType must be empty when not required.");
        zero(interactive.rows, "delivery.interactive.rows", errors);
        zero(interactive.columns, "delivery.interactive.columns", errors);
        if (interactive.oracles.length) errors.push("delivery.interactive.oracles must be empty when not required.");
      }
    }
  }

  if (!Array.isArray(plan?.operations) || plan.operations.length === 0) errors.push("operations must be a non-empty array.");
  let needsContainer = false, needsMicrovm = false, hasPackageInstall = false, hasCandidateOperation = false, hasPatchGenerate = false;
  const ids = new Set(), roleKeys = new Set();
  const operationKinds = new Map();
  const operationById = new Map();
  for (const [index, op] of (plan?.operations ?? []).entries()) {
    const label = `operations[${index}]`;
    if (!op || typeof op.kind !== "string") { errors.push(`${label}.kind must be a string.`); continue; }
    if (SAFE_OPERATIONS.has(op.kind)) {
      if (CANDIDATE_OPERATIONS.has(op.kind)) hasCandidateOperation = true;
      if (op.kind === "patch-generate") hasPatchGenerate = true;
      if (typeof op.command !== "string" || !op.command.trim()) errors.push(`${label}.command must be non-empty.`);
      else {
        if (DANGEROUS_COMMAND.test(op.command)) errors.push(`${label}.command contains a runtime, package manager, shell, build tool, or native command; escalate it.`);
        if (CURL_COMMAND.test(op.command)) errors.push(`${label}.command uses a network client; escalate it.`);
      }
      if (op.output !== "stdout" && !stageSet.has(op.output)) errors.push(`${label}.output must be stdout or a declared candidateStage target.`);
      if (CANDIDATE_OPERATIONS.has(op.kind) && (!stageSet.has(op.output) || !exports?.includes(op.output))) errors.push(`${label}.output must be a candidateStage target exported by candidateExports for candidate-producing operations.`);
    } else if (CONTAINER_OPERATIONS.has(op.kind)) {
      needsContainer = true;
      const allowedFields = new Set(["id", "roleKey", "kind", "command", "image", "scriptSha256", "sourceTreeSha256", "path", "requiredTools", "resources", "network", "timeoutMs", "oracles", "outputs", "runner", "viewports", "preflightOperationId", "browserRole", "artifactInput"]);
      for (const key of Object.keys(op)) if (!allowedFields.has(key)) errors.push(`${label} contains an unknown strong-operation field: ${key}`);
      if (op.kind === "package-install") hasPackageInstall = true;
      if (typeof op.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(op.id)) errors.push(`${label}.id must be a non-empty lowercase identifier using letters, digits, dot, underscore, or hyphen.`);
      else if (ids.has(op.id)) errors.push(`${label}.id must be unique: ${op.id}`);
      else { ids.add(op.id); operationKinds.set(op.id, op.kind); operationById.set(op.id, op); }
      if (typeof op.roleKey !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(op.roleKey)) errors.push(`${label}.roleKey must be a stable lowercase identifier.`);
      else if (roleKeys.has(op.roleKey)) errors.push(`${label}.roleKey must be unique: ${op.roleKey}`); else roleKeys.add(op.roleKey);
      if (typeof op.command !== "string" || !op.command.trim()) errors.push(`${label}.command must describe reviewed intent.`);
      if (!IMMUTABLE_IMAGE.test(op.image ?? "")) errors.push(`${label}.image must be an immutable reference ending in @sha256:<64 lowercase hex>.`);
      if (!SHA256.test(op.scriptSha256 ?? "")) errors.push(`${label}.scriptSha256 must be 64 lowercase hexadecimal characters.`);
      if (op.sourceTreeSha256 !== null && !SHA256.test(op.sourceTreeSha256 ?? "")) errors.push(`${label}.sourceTreeSha256 must be null before source binding or 64 lowercase hexadecimal characters.`);
      nonEmptyStrings(op.requiredTools, `${label}.requiredTools`, errors);
      if (!op.resources || typeof op.resources !== "object") errors.push(`${label}.resources must declare cpus and memory.`);
      else {
        if (!Number.isSafeInteger(op.resources.cpus) || op.resources.cpus <= 0 || op.resources.cpus > 32) errors.push(`${label}.resources.cpus must be a positive number no greater than 32.`);
        if (typeof op.resources.memory !== "string" || !/^[1-9][0-9]*(?:M|G)$/.test(op.resources.memory)) errors.push(`${label}.resources.memory must be a positive integer followed by M or G.`);
        for (const key of Object.keys(op.resources)) if (!new Set(["cpus", "memory"]).has(key)) errors.push(`${label}.resources contains an unknown field: ${key}`);
      }
      if (!Array.isArray(op.path) || op.path.some(value => typeof value !== "string" || !value.startsWith("/") || value.includes(":") || value.includes("\n") || value.includes("\r"))) errors.push(`${label}.path must be an array of absolute guest paths without PATH delimiters or newlines.`);
      else if (new Set(op.path).size !== op.path.length) errors.push(`${label}.path must not contain duplicates.`);
      if (!NETWORKS.has(op.network)) errors.push(`${label}.network must be disabled or registry.`);
      if (op.network === "registry" && op.kind !== "package-install") errors.push(`${label}.network=registry is allowed only for package-install operations.`);
      nonEmptyStrings(op.oracles, `${label}.oracles`, errors);
      if (op.timeoutMs !== undefined && (!Number.isInteger(op.timeoutMs) || op.timeoutMs <= 0 || op.timeoutMs > plan?.limits?.timeoutMs)) errors.push(`${label}.timeoutMs must be a positive integer no greater than limits.timeoutMs.`);
      if (!Array.isArray(op.outputs) || op.outputs.length === 0) errors.push(`${label}.outputs must be a non-empty array of {kind,path} declarations.`);
      else {
        const outputKeys = new Set();
        for (const [outputIndex, output] of op.outputs.entries()) {
          const outputLabel = `${label}.outputs[${outputIndex}]`;
          if (!output || !new Set(["evidence", "artifact"]).has(output.kind)) errors.push(`${outputLabel}.kind must be evidence or artifact.`);
          if (output && typeof output === "object") for (const key of Object.keys(output)) if (!new Set(["kind", "path", "viewportId"]).has(key)) errors.push(`${outputLabel} contains an unknown field: ${key}`);
          if (!safeRepositoryFile(output?.path)) errors.push(`${outputLabel}.path must be a safe relative file path.`);
          if (output?.kind === "evidence" && new Set(["operation-status.json", "operation-receipt.json"]).has(output.path)) errors.push(`${outputLabel}.path is reserved for operation status/receipt.`);
          const key = `${output?.kind}:${output?.path}`;
          if (outputKeys.has(key)) errors.push(`${outputLabel} duplicates ${key}.`);
          outputKeys.add(key);
        }
      }
      if (op.artifactInput !== undefined) {
        try { validateArtifactConsumer(plan, op, index); } catch (error) { errors.push(error.message); }
        if (containsRebuildCommand(op.command ?? "")) errors.push(`${label}.command contradicts artifactInput.rebuildPolicy=forbidden.`);
      }
      if (op.kind === "browser-preflight" || op.kind === "browser-smoke") {
        if (op.kind === "browser-preflight" && op.browserRole !== undefined) errors.push(`${label}.browserRole is allowed only for browser-smoke.`);
        if (op.kind === "browser-smoke" && op.browserRole !== undefined && !new Set(["interaction", "viewport-validation"]).has(op.browserRole)) errors.push(`${label}.browserRole must be interaction or viewport-validation when declared.`);
        if (typeof op.runner !== "string" || !op.runner.trim()) errors.push(`${label}.runner must identify the browser runner.`);
        if (!Array.isArray(op.viewports) || op.viewports.length === 0) errors.push(`${label}.viewports must declare the browser viewport matrix.`);
        else { const viewportIds = new Set(); for (const [viewportIndex, viewport] of op.viewports.entries()) {
          const viewportLabel = `${label}.viewports[${viewportIndex}]`;
          if (!viewport || typeof viewport !== "object") { errors.push(`${viewportLabel} must be an object.`); continue; }
          for (const key of Object.keys(viewport)) if (!new Set(["id", "width", "height", "mobile", "pointer"]).has(key)) errors.push(`${viewportLabel} contains an unknown field: ${key}`);
          if (typeof viewport.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(viewport.id)) errors.push(`${viewportLabel}.id must be a lowercase identifier.`);
          else if (viewportIds.has(viewport.id)) errors.push(`${viewportLabel}.id must be unique within the operation: ${viewport.id}`); else viewportIds.add(viewport.id);
          positiveInteger(viewport.width, `${viewportLabel}.width`, errors); positiveInteger(viewport.height, `${viewportLabel}.height`, errors);
          if (typeof viewport.mobile !== "boolean") errors.push(`${viewportLabel}.mobile must be a boolean.`);
          if (!new Set(["none", "fine", "coarse"]).has(viewport.pointer)) errors.push(`${viewportLabel}.pointer must be none, fine, or coarse.`);
        } }
        if (op.kind === "browser-smoke" && Array.isArray(op.viewports)) {
          if (op.browserRole === undefined) {
            const requiredViewportIds = ["desktop", "phone-portrait", "phone-landscape", "tablet-portrait", "tablet-landscape"];
            const declaredViewportIds = new Set(op.viewports.map(viewport => viewport?.id));
            for (const viewportId of requiredViewportIds) if (!declaredViewportIds.has(viewportId)) errors.push(`${label} legacy browser-smoke requires the standard viewport: ${viewportId}`);
          } else if (op.viewports.length !== 1) errors.push(`${label} split browser-smoke requires exactly one viewport.`);
        }
        if (!op.outputs?.some(output => output.kind === "evidence")) errors.push(`${label} browser operations require at least one evidence output.`);
        const browserArtifacts = op.outputs?.filter(output => output.kind === "artifact") ?? [];
        if (browserArtifacts.length === 0) errors.push(`${label} browser operations require at least one screenshot/artifact output.`);
        const viewportIds = new Set(op.viewports?.map(viewport => viewport.id) ?? []), coveredViewportIds = new Set();
        for (const artifact of browserArtifacts) { if (typeof artifact.viewportId !== "string" || !viewportIds.has(artifact.viewportId)) errors.push(`${label} browser artifact ${artifact.path} must reference a declared viewportId.`); else coveredViewportIds.add(artifact.viewportId); }
        for (const viewportId of viewportIds) if (!coveredViewportIds.has(viewportId)) errors.push(`${label} browser viewport lacks a screenshot/artifact output: ${viewportId}`);
        for (const output of op.outputs ?? []) if (output.kind !== "artifact" && output.viewportId !== undefined) errors.push(`${label} viewportId is allowed only on browser artifact outputs.`);
      } else {
        for (const output of op.outputs ?? []) if (output.viewportId !== undefined) errors.push(`${label} viewportId is allowed only on browser artifact outputs.`);
        if (op.runner !== undefined) errors.push(`${label}.runner is allowed only for browser operations.`);
        if (op.viewports !== undefined) errors.push(`${label}.viewports is allowed only for browser operations.`);
        if (op.browserRole !== undefined) errors.push(`${label}.browserRole is allowed only for browser-smoke.`);
      }
      if (op.kind === "browser-smoke" && (typeof op.preflightOperationId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(op.preflightOperationId))) errors.push(`${label}.preflightOperationId must identify a browser-preflight operation.`);
      if (op.kind !== "browser-smoke" && op.preflightOperationId !== undefined) errors.push(`${label}.preflightOperationId is allowed only for browser-smoke.`);
    } else if (MICROVM_OPERATIONS.has(op.kind)) {
      needsMicrovm = true;
      if (!hasIntake) errors.push(`${label}.kind requires external-microvm, which this local-macos-only skill does not implement.`);
    } else errors.push(`${label}.kind is unsupported: ${op.kind}`);
  }
  for (const [index, op] of (plan?.operations ?? []).entries()) {
    if (op?.kind === "browser-smoke") {
      const preflight = operationById.get(op.preflightOperationId);
      if (operationKinds.get(op.preflightOperationId) !== "browser-preflight") errors.push(`operations[${index}].preflightOperationId must reference a declared browser-preflight operation.`);
      else for (const key of ["image", "runner", "network", "path", "requiredTools", "resources"]) if (JSON.stringify(op[key]) !== JSON.stringify(preflight[key])) errors.push(`operations[${index}] browser runtime field ${key} must exactly match preflight operation ${op.preflightOperationId}.`);
    }
  }
  const browserSmokes = (plan?.operations ?? []).filter(op => op?.kind === "browser-smoke");
  const splitBrowserSmokes = browserSmokes.filter(op => op.browserRole !== undefined);
  if (splitBrowserSmokes.length > 0 && splitBrowserSmokes.length !== browserSmokes.length) errors.push("browser-smoke operations must not mix legacy combined mode with split browserRole mode.");
  if (splitBrowserSmokes.length > 0 && splitBrowserSmokes.length === browserSmokes.length) {
    const splitPreflightIds = new Set(splitBrowserSmokes.map(op => op.preflightOperationId));
    if (splitPreflightIds.size !== 1) errors.push("split browser mode requires every role to share one preflightOperationId.");
    const splitSourceTreeHashes = new Set(splitBrowserSmokes.map(op => op.sourceTreeSha256));
    if (splitSourceTreeHashes.size !== 1) errors.push("split browser mode requires every role to bind the same sourceTreeSha256.");
    const interactions = splitBrowserSmokes.filter(op => op.browserRole === "interaction");
    const viewportValidations = splitBrowserSmokes.filter(op => op.browserRole === "viewport-validation");
    if (interactions.length !== 1) errors.push("split browser mode requires exactly one interaction operation.");
    else {
      if (interactions[0].roleKey !== "browser-interaction") errors.push("split browser interaction roleKey must be browser-interaction.");
      if (interactions[0].viewports?.length !== 1 || interactions[0].viewports[0]?.id !== "desktop") errors.push("split browser interaction must declare exactly the desktop viewport.");
    }
    const requiredViewportIds = ["desktop", "phone-portrait", "phone-landscape", "tablet-portrait", "tablet-landscape"];
    if (viewportValidations.length !== requiredViewportIds.length) errors.push("split browser mode requires exactly five viewport-validation operations.");
    const seenViewportIds = new Set();
    for (const op of viewportValidations) {
      const viewportId = op.viewports?.length === 1 ? op.viewports[0]?.id : null;
      if (!requiredViewportIds.includes(viewportId)) errors.push(`split browser viewport-validation has unsupported viewport: ${viewportId ?? "missing"}`);
      else if (seenViewportIds.has(viewportId)) errors.push(`split browser viewport-validation duplicates viewport: ${viewportId}`);
      else seenViewportIds.add(viewportId);
      if (viewportId && op.roleKey !== `browser-viewport.${viewportId}`) errors.push(`split browser viewport roleKey must be browser-viewport.${viewportId}.`);
    }
    for (const viewportId of requiredViewportIds) if (!seenViewportIds.has(viewportId)) errors.push(`split browser mode is missing viewport-validation: ${viewportId}`);
  }
  if (hasCandidateOperation && stageSet.size === 0) errors.push("candidate-producing stages require at least one staged post-image path.");
  if (hasCandidateOperation && exports?.length === 0) errors.push("candidate-producing operations require candidateExports.");
  if (plan?.workspace?.mode === "read-only" && (stageSet.size || (stage?.mutationIds?.length ?? 0))) errors.push("read-only workspace requires an empty candidate stage.");
  if (hasPatchGenerate && stage?.promotable !== true) errors.push("patch-generate requires promotable=true.");
  if (hasIntake && plan.intake?.phase !== "deliver" && stage?.promotable === true) errors.push(`intake phase ${plan.intake?.phase} requires candidateStage.promotable=false; promotion is delivery.`);
  if (packageTargetDeclared && !hasPackageInstall) errors.push("package manifest or lockfile targets require a package-install operation.");
  if (containerDependencyTargetDeclared && !needsContainer && !needsMicrovm) errors.push("Dockerfile or Containerfile targets require container or microVM execution.");
  const riskDecision = hasIntake && validateRiskIntake(plan.intake).length === 0 ? deriveRiskDecision(plan) : null;
  const effectiveProfile = riskDecision?.effectiveProfile ?? plan?.profile;
  if (effectiveProfile === "text-only" && (needsContainer || needsMicrovm)) errors.push("text-only profile cannot contain container or microVM operations.");

  if (hasIntake && riskDecision) validateIntakePlanConsistency(plan, riskDecision, errors);

  const escalation = plan?.escalation;
  if (!escalation || typeof escalation.required !== "boolean" || !TARGETS.has(escalation.target)) errors.push("escalation must contain required and target.");
  else if (effectiveProfile === "high-risk" || needsMicrovm) {
    if (!escalation.required || escalation.target !== "external-microvm") errors.push("high-risk and microVM tasks must target external-microvm.");
    if (!hasIntake) errors.push("external-microvm execution is not implemented by this scoped Apple Container skill; task is blocked.");
  } else {
    const required = needsContainer, expectedTarget = needsContainer ? "container" : "none";
    if (escalation.required !== required) errors.push(`escalation.required must be ${required}.`);
    if (escalation.target !== expectedTarget) errors.push(`escalation.target must be ${expectedTarget}.`);
    if (required && (typeof escalation.reason !== "string" || !escalation.reason.trim())) errors.push("escalation.reason must explain strong execution.");
  }
  if (!hasIntake) return { errors, needsContainer, needsMicrovm };
  return { errors, needsContainer, needsMicrovm, riskDecision, blocked: Boolean(riskDecision?.blocked) };
}

function validateIntakePlanConsistency(plan, decision, errors) {
  const intake = plan.intake, strong = (plan.operations ?? []).filter(operation => STRONG_KINDS.has(operation?.kind));
  if (intake.requirements.network === "none") {
    for (const operation of strong) if (operation.network !== "disabled") errors.push(`intake network none requires disabled network for strong operation: ${operation.id ?? operation.kind}`);
  } else if (intake.requirements.network === "package-registry") {
    if (!strong.some(operation => operation.kind === "package-install" && operation.network === "registry")) errors.push("intake network package-registry requires at least one package-install registry operation.");
    for (const operation of strong) if (operation.network === "registry" && operation.kind !== "package-install") errors.push(`intake package-registry forbids registry on non-package-install strong operation: ${operation.id ?? operation.kind}`);
  }
  const host = plan.delivery?.hostRuntime, interactive = plan.delivery?.interactive;
  if (intake.phase === "change" || intake.phase === "validate") {
    if (host?.required || interactive?.required) errors.push(`intake phase ${intake.phase} disallows host or interactive delivery.`);
  }
  if (intake.phase === "inspect") {
    if (host?.required || interactive?.required) errors.push("intake phase inspect requires host and interactive delivery to be false.");
    if (strong.length) errors.push("intake phase inspect does not allow strong operations.");
  }
  if (intake.phase !== "deliver") return;
  const hasKind = (...kinds) => (plan.operations ?? []).some(operation => kinds.includes(operation?.kind));
  const noInteractive = label => { if (interactive?.required) errors.push(`${label} delivery requires terminal interactive delivery to be false.`); };
  const noHostOrInteractive = label => {
    if (host?.required || interactive?.required) errors.push(`${label} delivery requires host and interactive delivery to be false.`);
  };
  switch (intake.workloadProfile) {
    case "web-ui":
      if (!hasKind("browser-preflight") || !hasKind("browser-smoke")) errors.push("web-ui delivery requires browser-preflight and browser-smoke operations.");
      noInteractive("web-ui");
      break;
    case "cli-tui":
      if (intake.interfaceMode === "cli" && !hasKind("test", "native-exec", "repository-script")) errors.push("cli delivery requires a test, native-exec, or repository-script operation.");
      if (intake.interfaceMode === "tui" && !(interactive?.required && interactive.runner === "host")) errors.push("tui delivery requires the existing exact host interactive delivery contract.");
      break;
    case "backend-api":
      if (!hasKind("test")) errors.push("backend-api delivery requires a test operation.");
      noInteractive("backend-api");
      break;
    case "library":
      if (!hasKind("build", "test")) errors.push("library delivery requires a build or test operation.");
      noHostOrInteractive("library");
      break;
    case "infrastructure":
      if (!hasKind("test", "native-exec", "repository-script")) errors.push("infrastructure delivery requires an offline test, native-exec, or repository-script operation.");
      if (strong.some(operation => operation.network !== "disabled")) errors.push("infrastructure delivery strong operations must be offline.");
      if (plan.changeSet?.expectedReviewRequired !== true) errors.push("infrastructure delivery requires changeSet.expectedReviewRequired=true.");
      noHostOrInteractive("infrastructure");
      break;
    case "research":
      if (!hasKind("test", "build", "native-exec")) errors.push("research delivery requires a test, build, or native-exec operation.");
      noHostOrInteractive("research");
      break;
  }
  if (decision.blocked && decision.route !== "external-microvm") errors.push("blocked intake decisions must route to external-microvm.");
}

function fail(messages, code = 1) { for (const message of messages) console.error(`ERROR: ${message}`); process.exit(code); }
async function cli() {
  const jsonMode = process.argv[2] === "--json";
  const path = jsonMode ? process.argv[3] : process.argv[2];
  const expectedLength = jsonMode ? 4 : 3;
  if (!path || process.argv.length !== expectedLength) fail([jsonMode ? "Usage: node scripts/validate-execution-plan.mjs --json <plan.json>" : "Usage: node scripts/validate-execution-plan.mjs <plan.json>"], jsonMode ? 2 : 1);
  let plan;
  const jsonResult = ({ status, plan = null, result = null, errors = [] }) => {
    const decision = result?.riskDecision ?? null, intakePresent = plan?.intake !== undefined;
    return {
      schemaVersion: 1,
      status,
      intakePresent,
      assessmentStatus: intakePresent ? "assessed" : plan ? "legacy-unassessed" : "unavailable",
      callerProfile: decision?.callerProfile ?? plan?.profile ?? null,
      derivedProfile: decision?.derivedProfile ?? null,
      effectiveProfile: decision?.effectiveProfile ?? plan?.profile ?? null,
      blocked: Boolean(result?.blocked),
      route: decision?.route ?? (result?.needsMicrovm ? "external-microvm" : result?.needsContainer ? "container" : plan ? "none" : null),
      intakeSha256: decision?.intakeSha256 ?? null,
      riskDecisionSha256: decision ? riskDecisionSha256(decision) : null,
      reasons: decision?.reasons ?? [],
      errors,
    };
  };
  try { plan = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    const message = `Cannot read valid JSON from ${path}: ${error.message}`;
    if (jsonMode) { console.log(JSON.stringify(jsonResult({ status: "invalid", errors: [message] }))); process.exit(2); }
    fail([message]);
  }
  const result = validatePlan(plan);
  if (jsonMode) {
    const status = result.errors.length ? "invalid" : result.blocked ? "blocked" : "executable";
    console.log(JSON.stringify(jsonResult({ status, plan, result, errors: result.errors })));
    process.exit(status === "invalid" ? 2 : status === "blocked" ? 3 : 0);
  }
  if (result.errors.length) fail(result.errors);
  if (result.blocked) fail(["external-microvm execution is not implemented by this scoped Apple Container skill; task is blocked."]);
  const review = plan.changeSet.expectedReviewRequired ? " A separate semantic review is expected before host application." : "";
  const effectiveProfile = result.riskDecision?.effectiveProfile ?? plan.profile;
  if (effectiveProfile === "high-risk" || result.needsContainer || result.needsMicrovm) console.log(`ESCALATION_REQUIRED: Plan is structurally valid for scoped Apple Container execution.${review}`);
  else if (effectiveProfile === "text-only") console.log(`SAFE_FAST_PATH: Plan is structurally valid for network-off text-only execution.${review}`);
  else console.log(`SAFE_TIER: Plan is structurally valid for the declared just-bash capability profile.${review}`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(error => fail([`Unexpected validator failure: ${error.stack ?? error.message}`]));
