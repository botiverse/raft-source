import { appendFileSync, readFileSync } from "node:fs";

export const SERVER_SHARD_TIMINGS_ENV = "RAFT_SERVER_SHARD_TIMINGS_PATH";

export type FileTimingEvent =
  | { event: "run-start"; files: number }
  | { event: "queued"; file: string; at: number }
  | { event: "finished"; file: string; durationMs: number; wallMs: number; state: string; integrationCases?: number; phasesMs?: Record<string, number>; reuse?: Record<string, number> }
  /** The worker process running a file (src/test/setup/shardFileWorker.ts), for the per-file time limit. */
  | { event: "worker"; file: string; pid: number }
  | { event: "run-end" };

/**
 * The Vitest coordinator writes every event but `worker`, which each file's worker adds; every
 * record is one small synchronous append, so records don't interleave and survive termination.
 */
export function recordFileTiming(journal: string | undefined, event: FileTimingEvent): void {
  if (journal) appendFileSync(journal, `${JSON.stringify(event)}\n`);
}

type FinishedFile = Extract<FileTimingEvent, { event: "finished" }>;

export interface FileTimingSummary {
  files: number | null;
  completed: FinishedFile[];
  /** Started, not finished; workerPid: the worker process that reported running it, if one did. */
  unfinished: Array<{ file: string; elapsedMs: number; workerPid?: number }>;
  notStarted: number | null;
  runFinished: boolean;
  invalidRecords: number;
  error?: string;
}

function parseTimingEvent(line: string): FileTimingEvent | null {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const milliseconds = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (row.event === "run-end") return { event: "run-end" };
  if (row.event === "run-start" && typeof row.files === "number" && Number.isSafeInteger(row.files) && row.files >= 0) {
    return { event: "run-start", files: row.files };
  }
  if (typeof row.file !== "string") return null;
  if (row.event === "queued" && milliseconds(row.at)) {
    return { event: "queued", file: row.file, at: row.at };
  }
  if (row.event === "worker" && typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0) {
    return { event: "worker", file: row.file, pid: row.pid };
  }
  if (row.event === "finished" && milliseconds(row.durationMs) && milliseconds(row.wallMs) && typeof row.state === "string") {
    const finished: FinishedFile = { event: "finished", file: row.file, durationMs: row.durationMs, wallMs: row.wallMs, state: row.state };
    if (row.integrationCases === undefined && row.phasesMs === undefined) return finished;
    const cases = row.integrationCases;
    const phases = row.phasesMs;
    if (typeof cases !== "number" || !Number.isSafeInteger(cases) || cases < 0) return null;
    if (!phases || typeof phases !== "object" || Array.isArray(phases)) return null;
    if (!Object.values(phases).every(milliseconds)) return null;
    const reuse = row.reuse;
    if (reuse === undefined) return { ...finished, integrationCases: cases, phasesMs: phases as Record<string, number> };
    if (!reuse || typeof reuse !== "object" || Array.isArray(reuse) || !Object.values(reuse).every(milliseconds)) return null;
    return { ...finished, integrationCases: cases, phasesMs: phases as Record<string, number>, reuse: reuse as Record<string, number> };
  }
  return null;
}

export function readFileTimings(journal: string, now = Date.now()): FileTimingSummary {
  const summary: FileTimingSummary = {
    files: null, completed: [], unfinished: [], notStarted: null,
    runFinished: false, invalidRecords: 0,
  };
  let text: string;
  try {
    text = readFileSync(journal, "utf8");
  } catch {
    summary.error = "timing journal unavailable";
    return summary;
  }
  const completed = new Map<string, FinishedFile>();
  const queued = new Map<string, number>();
  const workers = new Map<string, number>();
  const lines = text.split("\n");
  // A process killed during an append may leave a partial final record.
  if (lines.pop()) summary.invalidRecords += 1;
  for (const line of lines) {
    if (!line) continue;
    let event: FileTimingEvent | null;
    try { event = parseTimingEvent(line); } catch { event = null; }
    if (!event) { summary.invalidRecords += 1; continue; }
    switch (event.event) {
      case "run-start":
        summary.files = event.files;
        summary.runFinished = false;
        completed.clear(); queued.clear(); workers.clear();
        break;
      case "queued":
        queued.set(event.file, event.at);
        completed.delete(event.file);
        break;
      case "finished":
        completed.set(event.file, event);
        queued.delete(event.file);
        break;
      // A worker may report its file before the coordinator records it queued.
      case "worker": workers.set(event.file, event.pid); break;
      case "run-end": summary.runFinished = true; break;
    }
  }
  summary.completed = [...completed.values()].sort((a, b) => b.wallMs - a.wallMs || a.file.localeCompare(b.file));
  summary.unfinished = [...queued].map(([file, at]) => {
    const workerPid = workers.get(file);
    return { file, elapsedMs: Math.max(0, now - at), ...(workerPid === undefined ? {} : { workerPid }) };
  })
    .sort((a, b) => b.elapsedMs - a.elapsedMs || a.file.localeCompare(b.file));
  if (summary.files !== null) summary.notStarted = Math.max(0, summary.files - completed.size - queued.size);
  return summary;
}

/**
 * Adds per-file integration phase totals and reuse-probe counts (src/test/integration/reuseProbe.ts);
 * files without integration cases contribute nothing, and `reuse` appears only when some file has it.
 */
export function sumIntegrationPhases(files: readonly Pick<FinishedFile, "integrationCases" | "phasesMs" | "reuse">[]): { integrationCases: number; phasesMs: Record<string, number>; reuse?: Record<string, number> } {
  const phasesMs: Record<string, number> = {};
  let reuse: Record<string, number> | undefined;
  let integrationCases = 0;
  for (const file of files) {
    integrationCases += file.integrationCases ?? 0;
    for (const [phase, ms] of Object.entries(file.phasesMs ?? {})) phasesMs[phase] = (phasesMs[phase] ?? 0) + ms;
    for (const [key, count] of Object.entries(file.reuse ?? {})) {
      reuse ??= {};
      reuse[key] = (reuse[key] ?? 0) + count;
    }
  }
  for (const phase of Object.keys(phasesMs)) phasesMs[phase] = Math.round(phasesMs[phase]);
  return reuse ? { integrationCases, phasesMs, reuse } : { integrationCases, phasesMs };
}

export type FileTimingsReason = "exit" | "watchdog" | "fileTimeLimit";

export function formatFileTimings(shard: number, reason: FileTimingsReason, summary: FileTimingSummary): string {
  const { completed, unfinished, ...metadata } = summary;
  const lines = [`[serverShardTimings] summary ${JSON.stringify({ shard, reason, ...metadata, completed: completed.length, unfinished: unfinished.length, ...sumIntegrationPhases(completed) })}`];
  for (const { event: _, ...file } of completed) lines.push(`[serverShardTimings] completed ${JSON.stringify(file)}`);
  for (const file of unfinished) lines.push(`[serverShardTimings] unfinished ${JSON.stringify(file)}`);
  return `${lines.join("\n")}\n`;
}

/** Keep the final table out of Node's asynchronous stdout buffer before process.exit. */
function writeTimingOutput(text: string): void {
  try { appendFileSync(process.stdout.fd, text); } catch { console.error("[serverShardTimings] stdout write failed"); }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`text\n${text}\`\`\`\n`); }
    catch { console.error("[serverShardTimings] step summary write failed"); }
  }
}

export function emitFileTimings(
  journal: string,
  shard: number,
  reason: FileTimingsReason,
  write = writeTimingOutput,
): void {
  write(formatFileTimings(shard, reason, readFileTimings(journal)));
}
