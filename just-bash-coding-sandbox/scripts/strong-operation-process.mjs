#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

export const RUNNER_BUNDLE_VERSION = "3";
export function stopContainer(name) {
  spawnSync("container", ["stop", name], { stdio: "ignore", timeout: 5000 });
  spawnSync("container", ["rm", name], { stdio: "ignore", timeout: 5000 });
}
export function terminateChild(child) {
  if (!child?.pid) return;
  try {
    process.platform !== "win32"
      ? process.kill(-child.pid, "SIGTERM")
      : child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.platform !== "win32"
        ? process.kill(-child.pid, "SIGKILL")
        : child.kill("SIGKILL");
    } catch {}
  }, 1000).unref();
}
export async function runBounded(
  command,
  args,
  {
    timeoutMs,
    containerName,
    timeoutMarker,
    env = process.env,
    stdio = "inherit",
    stdoutFile = null,
    onChild = null,
  } = {},
) {
  let outputFd;
  try {
    if (stdoutFile) outputFd = fs.openSync(stdoutFile, "wx", 0o600);
    const child = spawn(command, args, {
      env,
      stdio: stdoutFile ? ["ignore", outputFd, "inherit"] : stdio,
      detached: process.platform !== "win32",
    });
    onChild?.(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (timeoutMarker) {
        try {
          fs.writeFileSync(timeoutMarker, `${timeoutMs}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        } catch {}
      }
      if (containerName) stopContainer(containerName);
      terminateChild(child);
    }, timeoutMs);
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    onChild?.(null);
    if (containerName) {
      spawnSync("container", ["rm", containerName], {
        stdio: "ignore",
        timeout: 5000,
      });
    }
    if (timedOut) return 124;
    if (result.error) {
      throw new Error(`cannot launch ${command}: ${result.error.message}`);
    }
    if (Number.isInteger(result.code)) return result.code;
    throw new Error(
      `${command} ended from signal ${result.signal ?? "unknown"}`,
    );
  } finally {
    if (outputFd !== undefined) fs.closeSync(outputFd);
  }
}
export function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `${command} failed`).trim(),
    );
  }
  return result.stdout ?? "";
}
