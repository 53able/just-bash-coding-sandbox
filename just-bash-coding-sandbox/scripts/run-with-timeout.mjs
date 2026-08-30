#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator + 1 >= args.length) {
  console.error("Usage: node run-with-timeout.mjs <timeout-ms> <container-name> -- <command> [args...]");
  process.exit(2);
}
const timeoutMs = Number(args[0]);
const containerName = args[1];
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !containerName) process.exit(2);
const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const detached = process.platform !== "win32";
const child = spawn(command, commandArgs, { stdio: "inherit", detached });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (process.env.STRONG_OPERATION_TIMEOUT_MARKER) {
    try { writeFileSync(process.env.STRONG_OPERATION_TIMEOUT_MARKER, `${timeoutMs}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) { console.error(`ERROR: cannot record host timeout marker: ${error.message}`); }
  }
  console.error(`ERROR: host wall-clock timeout after ${timeoutMs}ms; stopping ${containerName}.`);
  spawnSync("container", ["stop", containerName], { stdio: "ignore", timeout: 5000 });
  spawnSync("container", ["rm", containerName], { stdio: "ignore", timeout: 5000 });
  try { detached && child.pid ? process.kill(-child.pid, "SIGTERM") : child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { detached && child.pid ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch {} }, 1000).unref();
}, timeoutMs);
const result = await new Promise(resolve => {
  child.once("error", error => resolve({ error }));
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
spawnSync("container", ["rm", containerName], { stdio: "ignore", timeout: 5000 });
if (timedOut) process.exit(124);
if (result.error) { console.error(`ERROR: cannot launch container command: ${result.error.message}`); process.exit(1); }
if (Number.isInteger(result.code)) process.exit(result.code);
console.error(`ERROR: container command ended from signal ${result.signal ?? "unknown"}.`);
process.exit(1);
