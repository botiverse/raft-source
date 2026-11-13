import { execFileSync, spawn } from "node:child_process";
import { ambientProcessEnv } from "../processEnvPatch";

/** Long enough that code which waited for the unblocker cannot pass for code that never opened the FIFO. */
const UNBLOCK_AFTER_MS = 3_000;

// Opens each FIFO read-write (which releases a blocked reader's open, and
// itself never blocks), holds it a moment, and exits on its own.
const UNBLOCKER = `
const fs = require("node:fs");
const [ms, ...fifos] = process.argv.slice(1);
setTimeout(() => {
  for (const fifo of fifos) {
    try { fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK); } catch {}
  }
  setTimeout(() => process.exit(0), 200);
}, Number(ms));
`;

/**
 * Runs `fn` with FIFOs at `fifos`, for code that must never open one. A
 * blocking open stops the event loop, so no test timeout could fire and the
 * worker would hang; instead a child process opens every FIFO after
 * UNBLOCK_AFTER_MS, which releases such an open, and the caller asserts on
 * `elapsedMs` that `fn` did not wait for it. The child exits by itself soon
 * after, and is killed once `fn` returns.
 */
export async function withFifos<T>(fifos: string[], fn: () => T | Promise<T>): Promise<{ result: T; elapsedMs: number; waitedForUnblock: boolean }> {
  for (const fifo of fifos) execFileSync("mkfifo", [fifo], { env: ambientProcessEnv() });
  const unblocker = spawn(process.execPath, ["-e", UNBLOCKER, String(UNBLOCK_AFTER_MS), ...fifos], { stdio: "ignore", env: ambientProcessEnv() });
  const started = performance.now();
  try {
    const result = await fn();
    const elapsedMs = performance.now() - started;
    return { result, elapsedMs, waitedForUnblock: elapsedMs >= UNBLOCK_AFTER_MS / 2 };
  } finally {
    unblocker.kill("SIGKILL");
  }
}
