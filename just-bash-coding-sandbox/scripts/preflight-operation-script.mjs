#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--script") {
  console.error("Usage: node scripts/preflight-operation-script.mjs --script <snapshotted-strong-operation.sh>");
  process.exit(2);
}

const scriptPath = path.resolve(args[1]);
let source;
try {
  const stat = fs.lstatSync(scriptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`operation script must be a regular, non-symlink, non-hardlinked file: ${scriptPath}`);
  source = fs.readFileSync(scriptPath, "utf8");
} catch (error) {
  if (error.code === "ENOENT") fail(`operation script does not exist: ${scriptPath}`);
  throw error;
}

if (/\\\r?\n/.test(source)) fail(`backslash-newline continuation is unsupported in strong-operation scripts: ${scriptPath}`);

const shell = spawnSync("/bin/bash", ["-n", scriptPath], { encoding: "utf8", timeout: 10_000 });
if (shell.error?.code === "ETIMEDOUT") fail(`operation shell syntax preflight timed out: ${scriptPath}`);
if (shell.error) fail(`could not run /bin/bash -n: ${shell.error.message}`);
if (shell.status !== 0) {
  process.stderr.write(shell.stderr || "");
  fail(`operation shell syntax preflight failed: ${scriptPath}`);
}

const lines = source.split(/\n/);
let embeddedJsCount = 0;
let dataHeredocCount = 0;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (line.trimStart().startsWith("#")) continue;
  const openerIndexes = [...line.matchAll(/(?<!<)<<(?!=<)/g)].map((match) => match.index);
  if (openerIndexes.length === 0) continue;
  if (openerIndexes.length !== 1) fail(`exactly one heredoc per line is supported; found ${openerIndexes.length} at line ${index + 1}`);
  if (index > 0 && lines[index - 1].trimEnd().endsWith("\\")) fail(`line-continued heredoc syntax is unsupported at line ${index + 1}`);

  const declaration = lines[index - 1]?.trim().match(/^# JBS_HEREDOC (data|javascript-module|javascript-commonjs)$/);
  if (!declaration) fail(`heredoc at line ${index + 1} requires an immediately preceding '# JBS_HEREDOC data|javascript-module|javascript-commonjs' declaration`);
  const kind = declaration[1];

  const openerIndex = openerIndexes[0];
  const fragment = line.slice(openerIndex);
  const marker = fragment.match(/^<<(-?)(?:'([A-Za-z_][A-Za-z0-9_-]*)'|"([A-Za-z_][A-Za-z0-9_-]*)"|([A-Za-z_][A-Za-z0-9_-]*))(?=\s|$)/);
  if (!marker) fail(`unsupported heredoc syntax at line ${index + 1}; use one literal delimiter matching [A-Za-z_][A-Za-z0-9_-]*`);
  const stripTabs = marker[1] === "-";
  const delimiter = marker[2] || marker[3] || marker[4];
  const quoted = Boolean(marker[2] || marker[3]);

  let end = index + 1;
  while (end < lines.length) {
    const candidate = stripTabs ? lines[end].replace(/^\t+/, "") : lines[end];
    if (candidate === delimiter) break;
    end += 1;
  }
  if (end >= lines.length) fail(`unterminated heredoc ${delimiter} beginning at line ${index + 1}`);

  if (kind.startsWith("javascript-")) {
    if (!quoted) fail(`embedded JavaScript heredoc at line ${index + 1} must quote delimiter ${delimiter} so checked bytes equal executed bytes`);
    let payloadLines = lines.slice(index + 1, end);
    if (stripTabs) payloadLines = payloadLines.map((value) => value.replace(/^\t+/, ""));
    const embedded = `${payloadLines.join("\n")}\n`;
    const moduleInput = kind === "javascript-module";
    const checked = spawnSync(process.execPath, [...(moduleInput ? ["--input-type=module"] : []), "--check", "-"], { input: embedded, encoding: "utf8", timeout: 10_000 });
    if (checked.error?.code === "ETIMEDOUT") fail(`embedded JavaScript syntax preflight timed out for heredoc ${delimiter} at line ${index + 1}`);
    if (checked.error) fail(`could not syntax-check embedded JavaScript at line ${index + 1}: ${checked.error.message}`);
    if (checked.status !== 0) {
      process.stderr.write(checked.stderr || "");
      fail(`embedded JavaScript syntax preflight failed for heredoc ${delimiter} at line ${index + 1}`);
    }
    embeddedJsCount += 1;
  } else {
    dataHeredocCount += 1;
  }
  index = end;
}

console.log(`OPERATION_SCRIPT_PREFLIGHT_PASS shell=bash embeddedJavaScript=${embeddedJsCount} dataHeredocs=${dataHeredocCount} script=${scriptPath}`);
