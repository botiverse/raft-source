import { formatUtcTimestamp } from "@botiverse/raft-shared";

export type DaemonLogLevel = "INFO" | "WARN" | "ERROR";

export interface DaemonLogEvent {
  level: DaemonLogLevel;
  line: string;
  message: string;
  error?: unknown;
}

type Listener = (event: DaemonLogEvent) => void;
const listeners = new Set<Listener>();

function timestamp(): string {
  return formatUtcTimestamp(new Date());
}

function format(level: DaemonLogLevel, msg: string): string {
  return `${timestamp()} [${level}] ${msg}`;
}

function emit(event: DaemonLogEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeDaemonLogs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const logger = {
  info(msg: string) {
    const line = format("INFO", msg);
    console.log(line);
    emit({ level: "INFO", line, message: msg });
  },
  warn(msg: string) {
    const line = format("WARN", msg);
    console.warn(line);
    emit({ level: "WARN", line, message: msg });
  },
  error(msg: string, err?: unknown) {
    const line = format("ERROR", msg);
    if (err) {
      console.error(line, err);
    } else {
      console.error(line);
    }
    emit({ level: "ERROR", line, message: msg, error: err });
  },
};
