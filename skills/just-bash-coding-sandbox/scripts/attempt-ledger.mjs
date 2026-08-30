#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

class CliError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }
const die = (message, code = 1) => { throw new CliError(message, code); };
async function withLock(path, callback) {
  for (let attempt = 0;; attempt += 1) { try { await mkdir(path, { mode: 0o700 }); break; } catch (error) { if (error.code !== "EEXIST" || attempt >= 100) die(`attempt ledger lock unavailable: ${error.message}`); await new Promise(resolvePromise => setTimeout(resolvePromise, 25)); } }
  try { return await callback(); } finally { await rm(path, { recursive: true, force: true }); }
}
async function main() {
  const args = process.argv.slice(2), command = args.shift();
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const ledgerPath = arg("--ledger"), workflowId = arg("--workflow-id"), roleKey = arg("--role-key"), operationId = arg("--operation-id"), bindingSha256 = arg("--binding-sha256"), classification = arg("--failure-classification") ?? "initial";
  const id = /^[a-z0-9][a-z0-9._-]*$/;
  if (!ledgerPath || !id.test(workflowId ?? "") || !id.test(roleKey ?? "") || !id.test(operationId ?? "") || !["reserve", "finalize"].includes(command)) die("Usage: node scripts/attempt-ledger.mjs <reserve|finalize> --ledger <file> --workflow-id <id> --role-key <key> --operation-id <id> ...", 2);
  return withLock(`${resolve(ledgerPath)}.lock`, async () => {
    let ledger = { schemaVersion: 2, attempts: [] };
    try { ledger = JSON.parse(await readFile(ledgerPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") die(`cannot read attempt ledger: ${error.message}`); }
    if (ledger.schemaVersion !== 2 || !Array.isArray(ledger.attempts)) die("attempt ledger schema mismatch; v1 ledgers are not reusable");
    const roleAttempts = ledger.attempts.filter(value => value.workflowId === workflowId && value.roleKey === roleKey);
    if (command === "reserve") {
      if (!/^[a-f0-9]{64}$/.test(bindingSha256 ?? "")) die("reserve requires --binding-sha256", 2);
      const allowed = new Set(["initial", "candidate", "binding", "tool", "image-runtime", "oracle", "output-contract", "preflight"]);
      if (!allowed.has(classification) || (roleAttempts.length === 0) !== (classification === "initial")) die(`invalid failure classification for role attempt ${roleAttempts.length + 1}: ${classification}`);
      if (roleAttempts.some(value => value.status === "passed")) die(`workflow role ${workflowId}/${roleKey} already passed; operation ID changes do not reset the budget`);
      if (roleAttempts.some(value => value.status === "running")) die(`workflow role ${workflowId}/${roleKey} already has a running attempt`);
      if (roleAttempts.length >= 2) die(`retry budget exhausted for workflow role ${workflowId}/${roleKey}`);
      if (roleAttempts.some(value => value.bindingSha256 === bindingSha256)) die(`blind retry rejected for workflow role ${workflowId}/${roleKey}: binding SHA-256 is unchanged`);
      const attemptId = randomUUID();
      const startedAtUtc = new Date().toISOString();
      ledger.attempts.push({ attemptId, workflowId, roleKey, operationId, bindingSha256, failureClassification: classification, attemptNumber: roleAttempts.length + 1, status: "running", startedAtUtc, endedAtUtc: null, elapsedMs: null });
      await save(); return { status: "ATTEMPT_RESERVED", attemptId, workflowId, roleKey, operationId, attemptNumber: roleAttempts.length + 1, startedAtUtc };
    }
    const attemptId = arg("--attempt-id"), status = arg("--status"), elapsedMs = Number(arg("--elapsed-ms")), declaredEnd = arg("--ended-at-utc");
    if (!attemptId || !new Set(["passed", "failed"]).has(status) || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) die("finalize requires --attempt-id, --status passed|failed, and nonnegative --elapsed-ms", 2);
    const entry = ledger.attempts.find(value => value.attemptId === attemptId && value.workflowId === workflowId && value.roleKey === roleKey);
    if (!entry || entry.status !== "running") die(`running attempt is missing from ledger: ${attemptId}`);
    const endedAtUtc = declaredEnd ?? new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(endedAtUtc) || Date.parse(endedAtUtc) < Date.parse(entry.startedAtUtc)) die("finalize --ended-at-utc must be a valid UTC instant at or after reservation");
    entry.status = status; entry.endedAtUtc = endedAtUtc; entry.elapsedMs = elapsedMs; await save();
    return { status: "ATTEMPT_FINALIZED", attemptId, workflowId, roleKey, operationId: entry.operationId, result: status, elapsedMs };
    async function save() { const temp = `${ledgerPath}.tmp-${process.pid}-${randomUUID()}`; await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await rename(temp, ledgerPath); }
  });
}
try { console.log(JSON.stringify(await main())); } catch (error) { console.error(`ERROR: ${error.message}`); process.exit(error.code ?? 1); }
