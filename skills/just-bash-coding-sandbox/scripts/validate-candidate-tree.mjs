#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { validatePlan } from "./validate-execution-plan.mjs";

const fail = (messages, code = 1) => { for (const message of Array.isArray(messages) ? messages : [messages]) console.error(`ERROR: ${message}`); process.exit(code); };
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const root = arg("--root"), baseline = arg("--baseline"), planPath = arg("--plan");
if (!root || !baseline || !planPath || args.length !== 6) fail("Usage: node scripts/validate-candidate-tree.mjs --root <candidate-root> --baseline <baseline-root> --plan <plan.json>", 2);
let planBytes, plan;
try { planBytes = await readFile(planPath); plan = JSON.parse(planBytes); } catch (error) { fail(`Cannot read execution plan: ${error.message}`, 2); }
const validation = validatePlan(plan);
if (validation.errors.length) fail(["Execution plan failed full v5 validation before candidate inspection.", ...validation.errors], 2);
if (validation.blocked) fail("Blocked execution plan cannot produce a passing or promotion-eligible candidate validation.", 2);
const rootAbs = resolve(root), baselineAbs = resolve(baseline), errors = [], files = [];
for (const [label, path] of [["candidate", rootAbs], ["baseline", baselineAbs]]) {
  try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} root must be a non-symlink directory: ${path}`, 2); } catch (error) { fail(`Cannot inspect ${label} root: ${error.message}`, 2); }
}
const denied = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".nuxt", "vendor", "coverage", "__pycache__"]);
async function walk(directory) {
  const handle = await opendir(directory); const entries = [];
  for await (const entry of handle) entries.push(entry); entries.sort((a,b)=>a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = resolve(directory, entry.name), rel = relative(rootAbs, full).split(sep).join("/");
    if (!rel || rel.startsWith("../") || rel.split("/").some(value => denied.has(value))) { errors.push(`unsafe or denied candidate path: ${rel}`); continue; }
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) errors.push(`symbolic link is not allowed in candidate: ${rel}`);
    else if (stat.isDirectory()) await walk(full);
    else if (stat.isFile() && stat.nlink === 1) files.push(rel);
    else errors.push(`candidate entry must be a regular non-hardlinked file: ${rel}`);
  }
}
await walk(rootAbs);
files.sort(); const expected = [...plan.candidateExports].sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) errors.push(`candidate post-image file set mismatch: expected=${expected.join(",")} actual=${files.join(",")}`);
async function state(path, boundary) {
  let parent = resolve(path, "..");
  while (parent !== boundary) { try { const parentStat = await lstat(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return { invalid: true }; } catch (error) { if (error.code === "ENOENT") return { absent: true }; throw error; } const next = resolve(parent, ".."); if (next === parent) return { invalid: true }; parent = next; }
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { invalid: true }; const bytes = await readFile(path); return { hash: createHash("sha256").update(bytes).digest("hex") }; }
  catch (error) { if (error.code === "ENOENT") return { absent: true }; throw error; }
}
const mutations = [];
for (const mutation of plan.changeSet.mutations) {
  const sourceRel = mutation.type === "rename" ? mutation.from : mutation.path;
  const before = await state(resolve(baselineAbs, ...sourceRel.split("/")), baselineAbs);
  if (mutation.type === "add") { if (!before.absent) errors.push(`add preimage must be absent: ${sourceRel}`); }
  else if (before.invalid || before.absent || before.hash !== mutation.beforeSha256) errors.push(`${mutation.type} preimage mismatch: ${sourceRel}`);
  if (mutation.type === "rename") { const destination = await state(resolve(baselineAbs, ...mutation.to.split("/")), baselineAbs); if (!destination.absent) errors.push(`rename destination must be absent in baseline: ${mutation.to}`); }
  const postPath = mutation.type === "rename" ? mutation.to : mutation.type === "delete" ? null : mutation.path;
  let afterSha256 = null;
  if (postPath) { const post = await state(resolve(rootAbs, ...postPath.split("/")), rootAbs); if (post.invalid || post.absent) errors.push(`candidate post-image missing or unsafe: ${postPath}`); else afterSha256 = post.hash; }
  mutations.push({ id: mutation.id, type: mutation.type, sourcePath: sourceRel, destinationPath: mutation.type === "rename" ? mutation.to : null, beforeSha256: mutation.beforeSha256, afterSha256 });
}
if (errors.length) fail(errors);
const tree = createHash("sha256");
for (const path of files) { const hash = createHash("sha256").update(await readFile(resolve(rootAbs, ...path.split("/")))).digest("hex"); tree.update(path).update("\0").update(hash).update("\0"); }
const deliveryEligible = plan.intake === undefined || plan.intake.phase === "deliver";
console.log(JSON.stringify({ schemaVersion: 2, status: "CANDIDATE_PASS", workflowId: plan.workflowId, planSha256: createHash("sha256").update(planBytes).digest("hex"), candidateTreeSha256: tree.digest("hex"), stage: plan.candidateStage.name, promotionEligible: deliveryEligible && plan.candidateStage.promotable === true, files, mutations }, null, 2));
