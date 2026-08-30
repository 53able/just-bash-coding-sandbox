#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function fail(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

const args = process.argv.slice(2);
let patchPath = "";
const allowed = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--patch" && args[i + 1]) patchPath = args[++i];
  else if (args[i] === "--allow" && args[i + 1]) allowed.push(args[++i]);
  else fail("Usage: node scripts/review-patch.mjs --patch <file> [--allow <path> ...]", 2);
}
if (!patchPath) fail("--patch is required.", 2);
if (allowed.length === 0) fail("At least one --allow <path> is required; patch review fails closed without an expected target allowlist.", 2);

let patch;
try {
  patch = await readFile(patchPath, "utf8");
} catch (error) {
  fail(`Cannot read patch ${patchPath}: ${error.message}`);
}
if (!patch.trim()) fail("Patch is empty.", 2);

const targets = [];
const addTarget = rawPath => {
  const path = rawPath.trim().replace(/^"|"$/g, "").replace(/^[ab]\//, "");
  if (path && path !== "/dev/null") targets.push(path);
};
for (const match of patch.matchAll(/^(?:---|\+\+\+)\s+([^\t\n]+)/gm)) addTarget(match[1]);
for (const match of patch.matchAll(/^(?:rename from|rename to|copy from|copy to)\s+(.+)$/gm)) addTarget(match[1]);
const binaryPatchDetected = /^Binary files\s+.+?\s+and\s+.+?\s+differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
for (const match of patch.matchAll(/^Binary files\s+(.+?)\s+and\s+(.+?)\s+differ$/gm)) {
  addTarget(match[1]);
  addTarget(match[2]);
}
const unparsedDiffHeaders = [];
for (const match of patch.matchAll(/^diff --git\s+(.+)$/gm)) {
  const header = match[1];
  const simple = header.match(/^a\/([^\s]+)\s+b\/([^\s]+)$/);
  if (simple) {
    addTarget(simple[1]);
    addTarget(simple[2]);
    continue;
  }
  if (header.startsWith("a/")) {
    const separator = header.lastIndexOf(" b/");
    if (separator > 2) {
      addTarget(header.slice(2, separator));
      addTarget(header.slice(separator + 3));
      continue;
    }
  }
  unparsedDiffHeaders.push(header);
}
if (targets.length === 0) fail("No old/new, rename/copy, diff, or binary target paths found in patch.", 2);

const findings = [];
const riskClasses = new Set();
for (const header of unparsedDiffHeaders) {
  findings.push(`unparsed or quoted diff header requires separate review: ${header}`);
  riskClasses.add("unsafe-path");
}
if (binaryPatchDetected) {
  findings.push("binary patch content detected");
  riskClasses.add("binary");
}
const uniqueTargets = [...new Set(targets)];
for (const path of uniqueTargets) {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    findings.push(`unsafe target path: ${path}`);
    riskClasses.add("unsafe-path");
  }
  if (allowed.length > 0 && !allowed.includes(path)) {
    findings.push(`unexpected target path: ${path}`);
    riskClasses.add("unexpected-target");
  }
  if (/^(?:\.git\/hooks\/|\.github\/workflows\/|\.circleci\/|\.buildkite\/)|(?:^|\/)(?:Jenkinsfile|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml)$/.test(path)) {
    findings.push(`high-risk automation path: ${path}`);
    riskClasses.add("automation");
  }
  if (/(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc.*|pnpmfile\..*|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|build\.zig(?:\.zon)?|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|composer\.json|composer\.lock|deno\.jsonc?|packages\.lock\.json|[^/]+\.csproj|Package\.swift|Package\.resolved|setup\.py|setup\.cfg|requirements[^/]*\.in|environment\.ya?ml|conda-lock\.ya?ml|[^/]+\.gemspec|mix\.exs|mix\.lock|pubspec\.ya?ml|pubspec\.lock|project\.clj|deps\.edn|build\.sbt|vcpkg\.json|conanfile\.(?:py|txt)|Podfile(?:\.lock)?|Cartfile(?:\.resolved)?|flake\.nix|flake\.lock|Dockerfile|Containerfile)$/.test(path)) {
    findings.push(`high-risk execution or dependency path: ${path}`);
    riskClasses.add("dependency");
  }
  if (/(?:^|\/)(?:install|build|test|release|deploy)\.(?:sh|bash|zsh|js|mjs|cjs|py)$|(?:^|\/)(?:build\.zig|Makefile|Taskfile\.ya?ml)$/.test(path)) {
    findings.push(`high-risk execution script path: ${path}`);
    riskClasses.add("automation");
  }
  if (path === "SKILL.md" || /^(?:assets\/(?:execution-(?:plan\.json|report\.md)|strong-operation\.json|gate-plan\.json)|references\/(?:execution-policy|parallel-execution|browser-validation|interactive-validation|strong-operation-authoring|artifact-handoff|gate-reports|workflow-efficiency|v4-migration)\.md|scripts\/(?:run|bootstrap|ensure|preflight|validate|review|self-test|just-bash-runner|strong-operation|risk-intake|attempt-ledger|aggregate-workflow-report|apply-candidate-patch|generate-candidate-patch|generate-gate-report|gate-report-contract|artifact-handoff-contract)[^/]*)$/.test(path) || /(?:^|\/)scripts\/[^/]*(?:sandbox|runner|container|validator)[^/]*$/.test(path)) {
    findings.push(`sandbox infrastructure path: ${path}`);
    riskClasses.add("sandbox-infrastructure");
  }
  if (/\.(?:zip|tar|tgz|gz|bz2|xz|7z|jar|war|wasm|exe|dll|dylib|so|a|o|bin|png|jpe?g|gif|webp|pdf)$/i.test(path)) {
    findings.push(`binary or archive path: ${path}`);
    riskClasses.add("binary");
  }
  if (/(?:^|\/)(?:\.env(?:\..*)?|id_rsa|credentials|secrets?\.(?:json|ya?ml))$/.test(path)) {
    findings.push(`credential-sensitive path: ${path}`);
    riskClasses.add("credential-sensitive");
  }
}

if (/^(?:new file mode|old mode|new mode|deleted file mode) 120000$/m.test(patch)) {
  findings.push("symlink mode detected");
  riskClasses.add("binary");
}
if (/^(?:new file mode|old mode|new mode|deleted file mode) 100755$/m.test(patch)) {
  findings.push("executable mode change detected");
  riskClasses.add("binary");
}
if (/^(?:new file mode|old mode|new mode|deleted file mode) 160000$/m.test(patch) || /^Subproject commit\s+[0-9a-f]+/m.test(patch)) {
  findings.push("gitlink or submodule change detected");
  riskClasses.add("dependency");
}

const added = patch.split("\n")
  .filter(line => line.startsWith("+") && !line.startsWith("+++"))
  .map(line => line.slice(1))
  .join("\n");
const urlMatches = added.match(/https?:\/\/[^\s"'<>`)]+/g) ?? [];
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][^"']{8,}["']/gi,
];
const credentialReferencePatterns = [
  /\b(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET)\b/g,
  /(?:^|[\s"'])~?\/\.ssh\//gm,
  /\b(?:credential|secret|token)[-_ ]?(?:file|path|store|vault)\b/gi,
];
const secretMarkerCount = secretPatterns.reduce((total, pattern) => total + (added.match(pattern)?.length ?? 0), 0);
const credentialReferenceCount = credentialReferencePatterns.reduce((total, pattern) => total + (added.match(pattern)?.length ?? 0), 0);
if (secretMarkerCount > 0) {
  findings.push(`${secretMarkerCount} possible secret marker(s) in added content`);
  riskClasses.add("credential-sensitive");
}
if (credentialReferenceCount > 0) {
  findings.push(`${credentialReferenceCount} credential or cloud reference(s) in added content`);
  riskClasses.add("credential-sensitive");
}
const parsedUrls = urlMatches.flatMap(value => {
  try {
    return [{ raw: value, url: new URL(value) }];
  } catch {
    return [];
  }
});
const addedUrlHosts = [...new Set(parsedUrls.map(({ url }) => url.host))].sort();
const fundingHosts = new Set(["opencollective.com", "tidelift.com", "www.patreon.com"]);
const urlCategories = { packageArtifact: [], fundingMetadata: [], other: [] };
for (const { raw, url } of parsedUrls) {
  if (/\.(?:tgz|tar|tar\.gz|zip|whl|gem|jar)(?:$|[?#])/i.test(raw) || (url.host === "registry.npmjs.org" && url.pathname.includes("/-/")) || (url.host === "github.com" && /\/releases\/download\//i.test(url.pathname))) {
    urlCategories.packageArtifact.push(raw);
  } else if (fundingHosts.has(url.host) || (url.host === "github.com" && /^\/sponsors(?:\/|$)/i.test(url.pathname)) || /\/(?:sponsors?|funding)(?:\/|$)/i.test(url.pathname)) {
    urlCategories.fundingMetadata.push(raw);
  } else {
    urlCategories.other.push(raw);
  }
}
const urlCategorySummary = Object.fromEntries(Object.entries(urlCategories).map(([category, values]) => [category, {
  count: values.length,
  hosts: [...new Set(values.flatMap(value => {
    try { return [new URL(value).host]; } catch { return []; }
  }))].sort(),
}]));

const report = {
  schemaVersion: 1,
  reviewPatchSha256: createHash("sha256").update(Buffer.from(patch, "utf8")).digest("hex"),
  status: findings.length === 0 ? "PATCH_PASS" : "PATCH_REVIEW_REQUIRED",
  targets: uniqueTargets,
  riskClasses: [...riskClasses].sort(),
  addedUrlCount: urlMatches.length,
  addedUrlHosts,
  addedUrlCategories: urlCategorySummary,
  addedUrls: [...new Set(urlMatches)].slice(0, 20),
  secretMarkerCount,
  credentialReferenceCount,
  findings,
};
console.log(JSON.stringify(report, null, 2));
process.exit(findings.length === 0 ? 0 : 2);
