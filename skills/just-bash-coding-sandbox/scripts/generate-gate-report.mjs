#!/usr/bin/env node

import { generateGateReport, inspectFailure, validateGateReport } from "./gate-report-contract.mjs";

const usage = "Usage: node scripts/generate-gate-report.mjs inspect-failure --plan <v5-plan> --ledger <v2-ledger> --operation-id <id> --gate-id <id> --source <dir> --evidence <dir> [--producer-handoff <sidecar>] [--preflight-source <dir> --preflight-evidence <dir> [--preflight-artifact <dir>]] | generate|validate --plan <v5-plan> --gate-plan <gate-plan> --ledger <v2-ledger> --gate-input <json>... (--out <absent-report> | --report <report>)";
const [command, ...tokens] = process.argv.slice(2);
function parse(allowed, repeatable = new Set()) {
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index], value = tokens[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith("--")) throw new Error(usage);
    if (!repeatable.has(name) && values.has(name)) throw new Error(`duplicate argument: ${name}`);
    if (repeatable.has(name)) values.set(name, [...(values.get(name) ?? []), value]); else values.set(name, value);
  }
  return values;
}
const required = (values, names) => { for (const name of names) if (!values.has(name)) throw new Error(`missing required argument ${name}\n${usage}`); };
try {
  let result;
  if (command === "inspect-failure") {
    const values = parse(new Set(["--plan", "--ledger", "--operation-id", "--gate-id", "--source", "--evidence", "--producer-handoff", "--preflight-source", "--preflight-evidence", "--preflight-artifact"]));
    required(values, ["--plan", "--ledger", "--operation-id", "--gate-id", "--source", "--evidence"]);
    result = await inspectFailure({ planPath: values.get("--plan"), ledgerPath: values.get("--ledger"), operationId: values.get("--operation-id"), gateId: values.get("--gate-id"), source: values.get("--source"), evidence: values.get("--evidence"), producerHandoff: values.get("--producer-handoff"), preflightSource: values.get("--preflight-source"), preflightEvidence: values.get("--preflight-evidence"), preflightArtifact: values.get("--preflight-artifact") });
  } else if (command === "generate" || command === "validate") {
    const outputName = command === "generate" ? "--out" : "--report", forbidden = command === "generate" ? "--report" : "--out";
    const values = parse(new Set(["--plan", "--gate-plan", "--ledger", "--gate-input", outputName]), new Set(["--gate-input"]));
    required(values, ["--plan", "--gate-plan", "--ledger", "--gate-input", outputName]);
    if (values.has(forbidden)) throw new Error(usage);
    const options = { planPath: values.get("--plan"), gatePlanPath: values.get("--gate-plan"), ledgerPath: values.get("--ledger"), gateInputPaths: values.get("--gate-input") };
    result = command === "generate" ? await generateGateReport({ ...options, outPath: values.get("--out") }) : await validateGateReport({ ...options, reportPath: values.get("--report") });
  } else throw new Error(usage);
  console.log(JSON.stringify(result));
} catch (error) { console.error(`ERROR: ${error.message}`); process.exit(error.code ?? 1); }
