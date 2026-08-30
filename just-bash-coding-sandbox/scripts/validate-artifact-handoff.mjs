#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { validatePlan } from "./validate-execution-plan.mjs";
import { producerBindingFromValidated, resolveArtifactHandoff, scanArtifactTree } from "./artifact-handoff-contract.mjs";
import { assertPlanNotBlocked } from "./risk-intake.mjs";

const usage = "Usage: node scripts/validate-artifact-handoff.mjs hash-tree --artifact <dir> --max-entries N --max-bytes N --max-file-size N | emit-binding --plan <v5-plan> --operation-id <producer> --source <dir> --evidence <dir> --artifact <dir> [preflight paths] | validate --plan <v5-plan> --operation-id <consumer> --producer-handoff <sidecar>";
const [command, ...tokens] = process.argv.slice(2), values = new Map(), allowedByCommand = { "hash-tree": new Set(["--artifact", "--max-entries", "--max-bytes", "--max-file-size"]), "emit-binding": new Set(["--plan", "--operation-id", "--source", "--evidence", "--artifact", "--preflight-source", "--preflight-evidence", "--preflight-artifact"]), validate: new Set(["--plan", "--operation-id", "--producer-handoff"]) };
try {
  const allowed = allowedByCommand[command]; if (!allowed) throw new Error(usage);
  for (let i = 0; i < tokens.length; i += 2) { if (!allowed.has(tokens[i]) || tokens[i + 1] === undefined || values.has(tokens[i])) throw new Error(usage); values.set(tokens[i], tokens[i + 1]); }
  const need = (...keys) => { for (const key of keys) if (!values.has(key)) throw new Error(`missing ${key}\n${usage}`); };
  let result;
  if (command === "hash-tree") { need("--artifact", "--max-entries", "--max-bytes", "--max-file-size"); result = scanArtifactTree(values.get("--artifact"), { maxEntries: Number(values.get("--max-entries")), maxBytes: Number(values.get("--max-bytes")), maxFileSize: Number(values.get("--max-file-size")) }); }
  else {
    need("--plan", "--operation-id"); const planPath = values.get("--plan"), plan = JSON.parse(fs.readFileSync(planPath)), checked = validatePlan(plan); if (checked.errors.length) throw new Error(`invalid plan: ${checked.errors.join(" ")}`); assertPlanNotBlocked(plan, "artifact handoff CLI"); const operation = plan.operations.find(item => item.id === values.get("--operation-id")); if (!operation) throw new Error("operation is missing");
    if (command === "validate") { need("--producer-handoff"); result = { status: "ARTIFACT_HANDOFF_VALID", ...resolveArtifactHandoff({ planPath, plan, consumer: operation, handoffPath: values.get("--producer-handoff") }) }; }
    else { need("--source", "--evidence", "--artifact"); if (operation.artifactInput !== undefined) throw new Error("producer chains are not supported"); const args = [new URL("./validate-operation-evidence.mjs", import.meta.url).pathname, "--plan", planPath, "--operation-id", operation.id, "--source", values.get("--source"), "--evidence", values.get("--evidence"), "--artifact", values.get("--artifact")]; for (const key of ["--preflight-source", "--preflight-evidence", "--preflight-artifact"]) if (values.has(key)) args.push(key, values.get(key)); const reusable = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })); result = { status: "PRODUCER_BINDING_EMITTED", artifactInput: producerBindingFromValidated({ plan, producer: operation, reusable, evidenceRoot: values.get("--evidence"), artifactRoot: values.get("--artifact") }) }; }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`ERROR: ${error.message}`); process.exit(error.code ?? 1); }
