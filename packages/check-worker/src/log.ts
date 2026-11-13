// The check Worker's log lines: one JSON object each, `{ evt: "raft-check.<event>", ... }`,
// with ids, codes and counts only. There is no field for a URL, a message or an error: the
// lease's ticket URL never reaches a log (isolation condition 2), and every string field still
// goes through redact.ts forLog (no URL survives it), so a code built from something
// unexpected can't carry one either.
import { forLog } from "./redact";

export type LogLevel = "info" | "warn" | "error";

/** What a log line may carry. */
export interface LogFields {
  checkId?: string;
  artifactId?: string;
  versionId?: string;
  /** An HTTP status, or a check's end (`done`, `failed`). */
  status?: number | string;
  /** A code-shaped class (report.ts errorClassOf). */
  errorClass?: string;
  /** How the page loaded (`ok`, `timeout`, `error`). */
  load?: string;
  /** What a configuration lacks, in words of the Worker's own (never a value). */
  problem?: string;
  count?: number;
  elapsedMs?: number;
}

export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void;

/** The line `log` writes, as a string (exported for tests). */
export function logLine(event: string, fields: LogFields = {}): string {
  const line: Record<string, string | number> = { evt: `raft-check.${forLog(event)}` };
  for (const [key, value] of Object.entries(fields) as Array<[keyof LogFields, string | number | undefined]>) {
    if (value === undefined) continue;
    line[key] = typeof value === "string" ? forLog(value) : value;
  }
  return JSON.stringify(line);
}

/** Writes each line to the console (Workers Logs). */
export function consoleLogger(sink: Pick<Console, "info" | "warn" | "error"> = console): Logger {
  return (level, event, fields) => sink[level](logLine(event, fields));
}
