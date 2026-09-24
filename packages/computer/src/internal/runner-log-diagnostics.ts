import { open, stat } from "node:fs/promises";

export const RUNNER_LOG_SCAN_BYTES = 64 * 1024;

async function readFileTail(
  logPath: string,
  options: { startOffset?: number; maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = Math.max(0, options.maxBytes ?? RUNNER_LOG_SCAN_BYTES);
  if (maxBytes === 0) return "";
  try {
    const info = await stat(logPath);
    if (!info.isFile() || info.size <= 0) return "";
    const lowerBound = Math.max(0, options.startOffset ?? 0);
    if (lowerBound >= info.size) return "";
    const readOffset = Math.max(lowerBound, info.size - maxBytes);
    const length = info.size - readOffset;
    const buf = Buffer.allocUnsafe(length);
    const fh = await open(logPath, "r");
    try {
      const { bytesRead } = await fh.read(buf, 0, length, readOffset);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close().catch(() => undefined);
    }
  } catch {
    // Missing/unreadable runner logs are expected before a runner has started.
    return "";
  }
}

export async function readRunnerLogTail(logPaths: readonly string[]): Promise<string> {
  const tails: string[] = [];
  for (const logPath of logPaths) {
    const tail = await readFileTail(logPath);
    if (tail.length > 0) tails.push(tail);
  }
  return tails.join("\n");
}

export async function readRunnerLogDiagnosticText(
  logPath: string,
  startOffset: number,
  maxBytes = RUNNER_LOG_SCAN_BYTES,
): Promise<string> {
  return readFileTail(logPath, { startOffset, maxBytes });
}

export function hasUnlinkedComputerHandshake(logTail: string): boolean {
  return (
    logTail.includes("slock_reason=computer_machine_unlinked") ||
    logTail.includes('"slock_reason":"computer_machine_unlinked"')
  );
}
