#!/usr/bin/env node

import { createHash } from "node:crypto";

export const RUNNER_BUNDLE_VERSION = "3";
const PHASES = new Set(["inspect", "change", "validate", "deliver"]);
const WORKLOADS = new Set(["web-ui", "cli-tui", "backend-api", "library", "infrastructure", "research"]);
const INTERFACES = new Set(["none", "cli", "tui"]);
const TRUST = new Set(["trusted-reviewed", "trusted-unreviewed", "unknown", "untrusted", "hostile"]);
const ORIGINS = new Set(["first-party", "reviewed-third-party", "unreviewed-third-party", "generated-reviewed", "generated-unreviewed", "data-only", "unknown"]);
const PRIVILEGES = new Set(["none", "guest-elevated", "host-elevated", "kernel", "unknown"]);
const LIFETIMES = new Set(["none", "bounded-foreground", "bounded-ephemeral-service", "persistent-daemon", "host-daemon", "unknown"]);
const SOCKETS = new Set(["docker", "container-runtime", "ssh-agent", "gpg-agent", "system", "custom", "unknown"]);
const CREDENTIALS = new Set(["none", "ephemeral-task-scoped", "host-inherited", "persistent", "unknown"]);
const NETWORKS = new Set(["none", "package-registry", "origin-specific", "broad-egress", "unknown"]);
const ENGINEERING_WORKLOADS = new Set(["web-ui", "cli-tui", "backend-api", "library", "infrastructure"]);
const STRONG_KINDS = new Set(["build", "test", "package-install", "native-exec", "repository-script", "browser-preflight", "browser-smoke"]);
const HIGH_TRUST = new Set(["trusted-unreviewed", "unknown", "untrusted", "hostile"]);
const HIGH_ORIGINS = new Set(["unreviewed-third-party", "generated-unreviewed", "unknown"]);
const HIGH_LIFETIMES = new Set(["persistent-daemon", "host-daemon", "unknown"]);
const HIGH_NETWORKS = new Set(["origin-specific", "broad-egress", "unknown"]);
const LEVEL = new Map([["text-only", 0], ["standard", 1], ["high-risk", 2]]);

function exactObject(value, keys, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object with exact fields: ${keys.join(", ")}.`);
    return false;
  }
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) errors.push(`${path} fields must be exact: ${keys.join(", ")}.`);
  return true;
}
function member(value, values, path, errors) {
  if (typeof value !== "string" || !values.has(value)) errors.push(`${path} has an unsupported value.`);
}

export function validateRiskIntake(intake) {
  const errors = [];
  if (!exactObject(intake, ["schemaVersion", "phase", "workloadProfile", "interfaceMode", "repository", "requirements"], "intake", errors)) return errors;
  if (intake.schemaVersion !== 1) errors.push("intake.schemaVersion must be 1.");
  member(intake.phase, PHASES, "intake.phase", errors);
  member(intake.workloadProfile, WORKLOADS, "intake.workloadProfile", errors);
  member(intake.interfaceMode, INTERFACES, "intake.interfaceMode", errors);
  if (exactObject(intake.repository, ["trust", "codeOrigin"], "intake.repository", errors)) {
    member(intake.repository.trust, TRUST, "intake.repository.trust", errors);
    member(intake.repository.codeOrigin, ORIGINS, "intake.repository.codeOrigin", errors);
  }
  if (exactObject(intake.requirements, ["privilege", "processLifetime", "hostSockets", "credentials", "network"], "intake.requirements", errors)) {
    member(intake.requirements.privilege, PRIVILEGES, "intake.requirements.privilege", errors);
    member(intake.requirements.processLifetime, LIFETIMES, "intake.requirements.processLifetime", errors);
    member(intake.requirements.credentials, CREDENTIALS, "intake.requirements.credentials", errors);
    member(intake.requirements.network, NETWORKS, "intake.requirements.network", errors);
    if (!Array.isArray(intake.requirements.hostSockets)) errors.push("intake.requirements.hostSockets must be an array.");
    else {
      const seen = new Set();
      for (const socket of intake.requirements.hostSockets) {
        if (typeof socket !== "string" || !SOCKETS.has(socket)) errors.push("intake.requirements.hostSockets contains an unsupported value.");
        else if (seen.has(socket)) errors.push(`intake.requirements.hostSockets must be unique: ${socket}.`);
        seen.add(socket);
      }
    }
  }
  if (intake.workloadProfile === "cli-tui") {
    if (intake.interfaceMode !== "cli" && intake.interfaceMode !== "tui") errors.push("intake.interfaceMode must be cli or tui for cli-tui workloadProfile.");
  } else if (WORKLOADS.has(intake.workloadProfile) && intake.interfaceMode !== "none") errors.push("intake.interfaceMode must be none except for cli-tui workloadProfile.");
  return errors;
}

function highest(left, right) { return LEVEL.get(left) >= LEVEL.get(right) ? left : right; }
function executablePattern(names, suffix = "(?=$|[\\s;&|()])") {
  const executable = `(?:/(?:[^\\s;&|()/]+/)*)?(?:${names})`;
  return new RegExp(`(^|[\\s;&|()])(?:command[\\t ]+)?${executable}${suffix}`, "i");
}
const HOST_COMMAND_SIGNALS = [
  ["privilege-tool", executablePattern("sudo|doas")],
  ["container-runtime", executablePattern("docker|podman")],
  ["privileged-container", /(^|[\s=])--privileged(?=$|[\s=])/i],
  ["host-root-mount", /(?:^|[\s,])(?:-v|--volume)(?:=|\s+)?["']?\/["']?(?:\s*:\s*|:)|(?:^|[\s,])(?:source|src)\s*=\s*(?:"\/"|'\/'|\/)(?=,|\s|$)/i],
  ["docker-socket", /(?:\/var\/run\/docker\.sock|\/run\/docker\.sock)/i],
  ["cluster-control", executablePattern("kubectl")],
  ["terraform-apply", executablePattern("terraform", "\\s+(?:-[^\\s]+\\s+)*apply(?=$|\\s)")],
  ["cloud-credential-env", /(?:^|[\s;&|()])(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE)\s*=/i],
  ["daemon-manager", new RegExp(`${executablePattern("systemctl|launchctl|service").source}|${executablePattern("brew", "\\s+services(?=$|\\s)").source}`, "i")],
];
function hostCommandReasons(plan) {
  const commands = plan?.delivery?.hostRuntime?.commands;
  if (!Array.isArray(commands)) return [];
  const reasons = new Set();
  for (const command of commands) if (typeof command === "string") for (const [signal, pattern] of HOST_COMMAND_SIGNALS) if (pattern.test(command)) reasons.add(`host-command:${signal}`);
  return [...reasons];
}
function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("risk decisions allow only safe integer numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  throw new Error(`unsupported risk decision value: ${typeof value}`);
}

export function deriveRiskDecision(plan) {
  if (plan?.intake === undefined) return null;
  const intake = plan.intake, operations = Array.isArray(plan.operations) ? plan.operations : [];
  const strong = operations.filter(operation => STRONG_KINDS.has(operation?.kind));
  const microvm = operations.filter(operation => operation?.kind === "docker" || operation?.kind === "unknown");
  const highReasons = [], standardReasons = [];
  if (HIGH_TRUST.has(intake?.repository?.trust)) highReasons.push(`repository-trust:${intake.repository.trust}`);
  if (HIGH_ORIGINS.has(intake?.repository?.codeOrigin)) highReasons.push(`code-origin:${intake.repository.codeOrigin}`);
  if (intake?.requirements?.privilege !== "none") highReasons.push(`privilege:${intake?.requirements?.privilege}`);
  if (HIGH_LIFETIMES.has(intake?.requirements?.processLifetime)) highReasons.push(`process-lifetime:${intake.requirements.processLifetime}`);
  for (const socket of [...(Array.isArray(intake?.requirements?.hostSockets) ? intake.requirements.hostSockets : [])].sort()) highReasons.push(`host-socket:${socket}`);
  if (intake?.requirements?.credentials !== "none") highReasons.push(`credentials:${intake?.requirements?.credentials}`);
  if (HIGH_NETWORKS.has(intake?.requirements?.network)) highReasons.push(`network:${intake.requirements.network}`);
  for (const kind of [...new Set(microvm.map(operation => operation.kind))].sort()) highReasons.push(`operation:${kind}`);
  if (plan.profile === "high-risk") highReasons.push("caller-profile:high-risk");
  highReasons.push(...hostCommandReasons(plan));

  if (ENGINEERING_WORKLOADS.has(intake?.workloadProfile)) standardReasons.push(`engineering-workload:${intake.workloadProfile}`);
  if (strong.length) standardReasons.push("strong-operation");
  if (intake?.requirements?.network === "package-registry") standardReasons.push("network:package-registry");
  if (intake?.requirements?.processLifetime === "bounded-ephemeral-service") standardReasons.push("process-lifetime:bounded-ephemeral-service");
  if (plan?.delivery?.hostRuntime?.required === true) standardReasons.push("delivery:host-runtime");
  if (plan?.delivery?.interactive?.required === true) standardReasons.push("delivery:interactive");

  const derivedProfile = highReasons.length ? "high-risk" : standardReasons.length ? "standard" : "text-only";
  const effectiveProfile = highest(plan.profile, derivedProfile);
  const blocked = effectiveProfile === "high-risk" || microvm.length > 0;
  const route = blocked ? "external-microvm" : strong.length ? "container" : "none";
  const canonicalIntake = {
    schemaVersion: intake.schemaVersion,
    phase: intake.phase,
    workloadProfile: intake.workloadProfile,
    interfaceMode: intake.interfaceMode,
    repository: { trust: intake.repository.trust, codeOrigin: intake.repository.codeOrigin },
    requirements: { ...intake.requirements, hostSockets: [...intake.requirements.hostSockets].sort() },
  };
  return {
    schemaVersion: 1,
    intakeSha256: createHash("sha256").update(Buffer.from(canonicalize(canonicalIntake), "utf8")).digest("hex"),
    callerProfile: plan.profile,
    derivedProfile,
    effectiveProfile,
    route,
    blocked,
    reasons: [...highReasons, ...standardReasons].sort(),
  };
}

export function riskDecisionSha256(decision) {
  if (!decision) throw new Error("risk decision is required");
  return createHash("sha256").update(Buffer.from(canonicalize(decision), "utf8")).digest("hex");
}

export function assertPlanNotBlocked(plan, boundary = "plan-consuming boundary") {
  const decision = deriveRiskDecision(plan);
  if (decision?.blocked) throw new Error(`${boundary} rejects blocked risk decision; external-microvm execution is not implemented`);
  return decision;
}

export function assertDeliveryPhase(plan, boundary = "delivery boundary") {
  const decision = assertPlanNotBlocked(plan, boundary);
  if (plan?.intake !== undefined && plan.intake?.phase !== "deliver") throw new Error(`${boundary} requires intake.phase=deliver`);
  return decision;
}

export { STRONG_KINDS };
