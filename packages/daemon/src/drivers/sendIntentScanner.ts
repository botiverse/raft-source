/**
 * Agent typing line (packages/shared/src/agentTyping.ts), driver side: find
 * the `--target` of a `raft message send` while the shell tool call's
 * arguments are still streaming, so the daemon can announce the send before
 * the body is generated. Each driver feeds its runtime's argument deltas here
 * and forwards the returned `send_intent` event.
 */
import { findRaftSendTarget, resolveToolSemantic } from "@botiverse/raft-shared";
import type { ParsedEvent } from "./types";

export type SendIntentEvent = Extract<ParsedEvent, { kind: "send_intent" }>;

/**
 * The target comes before the body, so a command this long without one is
 * either body-first (`printf '…' | raft message send …`) or not a send; the
 * complete tool call covers it. Bounds the rescans of a long command.
 */
const MAX_SCANNED_COMMAND_CHARS = 4_096;
/**
 * Streamed argument text kept per call. Past it the call stops being scanned
 * whatever the extraction says (a huge non-`command` field first, a malformed
 * object); `complete()` still reads the finished call.
 */
export const MAX_SCANNED_ARGS_CHARS = 8 * 1024;
/**
 * A target can only newly appear once a shell token ends (a delimiter, quote
 * or operator) or a line ends; decoded text without one cannot change the
 * result, so the command is not re-lexed for it.
 */
const SHELL_TOKEN_BOUNDARY_RE = /[\s"'|;&<>()]/;
/** Arguments of this many calls are kept at once; the oldest is dropped. */
const MAX_TRACKED_CALLS = 16;

/**
 * Lenient read of a top-level string field from a JSON object that may still
 * be streaming: `{"command":"raft message send --tar` gives
 * `{ value: "raft message send --tar", complete: false }`. JSON escapes are
 * decoded; a cut-off escape at the end is dropped. Null when the field has not
 * started yet, is not a string, or the text is not an object.
 */
export function extractPartialJsonStringField(json: string, field: string): { value: string; complete: boolean } | null {
  const found = extractPartialJsonStringFieldAt(json, field);
  return found ? { value: found.value, complete: found.complete } : null;
}

type JsonStringRead = { value: string; complete: boolean; end: number };

/**
 * Decodes JSON string content from `start` (just past the opening quote, or
 * where an earlier read of the same string stopped). `end` is past the
 * closing quote, or, for an unterminated string, the first character not yet
 * decoded (a cut-off escape is left for the next read).
 */
function readJsonStringFrom(json: string, start: number): JsonStringRead {
  const n = json.length;
  let value = "";
  let i = start;
  while (i < n) {
    const ch = json[i]!;
    if (ch === '"') return { value, complete: true, end: i + 1 };
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }
    const esc = json[i + 1];
    if (esc === undefined) break;
    switch (esc) {
      case "n": value += "\n"; break;
      case "t": value += "\t"; break;
      case "r": value += "\r"; break;
      case "b": value += "\b"; break;
      case "f": value += "\f"; break;
      case "u": {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) return { value, complete: false, end: i };
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, complete: false, end: i };
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      default: value += esc; // `"`, `\\`, `/`, and anything lenient
    }
    i += 2;
  }
  return { value, complete: false, end: i };
}

/** `extractPartialJsonStringField` plus where the read stopped, to resume it. */
function extractPartialJsonStringFieldAt(json: string, field: string): JsonStringRead | null {
  const n = json.length;
  let i = 0;
  const skipWs = () => {
    while (i < n && (json[i] === " " || json[i] === "\n" || json[i] === "\r" || json[i] === "\t")) i += 1;
  };
  /** Reads a JSON string starting at the opening quote at `i`. */
  const readString = (): JsonStringRead => {
    const read = readJsonStringFrom(json, i + 1);
    i = read.end;
    return read;
  };
  /** Skips one JSON value; false when the text ends inside it. */
  const skipValue = (): boolean => {
    skipWs();
    if (i >= n) return false;
    const ch = json[i]!;
    if (ch === '"') return readString().complete;
    if (ch === "{" || ch === "[") {
      let depth = 0;
      while (i < n) {
        const c = json[i]!;
        if (c === '"') {
          if (!readString().complete) return false;
          continue;
        }
        if (c === "{" || c === "[") depth += 1;
        else if (c === "}" || c === "]") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            return true;
          }
        }
        i += 1;
      }
      return false;
    }
    while (i < n && json[i] !== "," && json[i] !== "}") i += 1;
    return i < n;
  };

  skipWs();
  if (json[i] !== "{") return null;
  i += 1;
  for (;;) {
    skipWs();
    if (json[i] === ",") {
      i += 1;
      continue;
    }
    if (json[i] !== '"') return null;
    const key = readString();
    if (!key.complete) return null;
    skipWs();
    if (json[i] !== ":") return null;
    i += 1;
    skipWs();
    if (key.value === field) {
      return json[i] === '"' ? readString() : null;
    }
    if (!skipValue()) return null;
  }
}

interface ScannedCall {
  name: string;
  args: string;
  /** Still reading streamed fragments (no target yet, under the caps). */
  scanning: boolean;
  /** An intent was yielded, or the call can never yield one. */
  settled: boolean;
  /** Once the `command` value is found: its text so far, and where in `args` decoding resumes. */
  command: { value: string; resumeAt: number } | null;
}

/**
 * Per-runtime-session scanner: accumulates each call's streamed argument
 * JSON and yields one `send_intent` per call once the target is complete.
 * Only shell tools are scanned. Streaming work per call is bounded: argument
 * text past `MAX_SCANNED_ARGS_CHARS` (or a command past
 * `MAX_SCANNED_COMMAND_CHARS`) stops the scan, the `command` value is decoded
 * incrementally, and the command is re-lexed only when new text can end a
 * shell token.
 */
export class SendIntentArgumentScanner {
  private readonly calls = new Map<string, ScannedCall>();

  /** Feed a call's next argument fragment (name may arrive on any fragment). */
  append(callId: string, toolName: string | undefined, delta: string | undefined): SendIntentEvent | null {
    if (!callId) return null;
    const call = this.track(callId);
    if (toolName) call.name = toolName;
    if (call.settled || !call.scanning) return null;
    if (call.name && resolveToolSemantic(call.name) !== "bash") {
      // Not a shell call: never keep its (possibly large) arguments.
      call.settled = true;
      this.stopScanning(call);
      return null;
    }
    if (delta) call.args += delta;
    if (call.args.length > MAX_SCANNED_ARGS_CHARS) {
      // Whatever the extraction would say: the finished call is read by `complete()`.
      this.stopScanning(call);
      return null;
    }
    if (!delta || !call.name) return null;

    let added: string;
    let complete: boolean;
    if (call.command) {
      const read = readJsonStringFrom(call.args, call.command.resumeAt);
      call.command.value += read.value;
      call.command.resumeAt = read.end;
      added = read.value;
      complete = read.complete;
    } else {
      const read = extractPartialJsonStringFieldAt(call.args, "command");
      if (!read) return null;
      call.command = { value: read.value, resumeAt: read.end };
      added = read.value;
      complete = read.complete;
    }
    const command = call.command.value;
    // The value only grows; text that cannot end a token cannot reveal a
    // target, unless the string just closed (that ends the last token too).
    if (complete || SHELL_TOKEN_BOUNDARY_RE.test(added)) {
      const target = findRaftSendTarget(command, { partial: !complete });
      if (target) {
        call.settled = true;
        this.stopScanning(call);
        return { kind: "send_intent", callId, target, early: true };
      }
    }
    if (complete) {
      // The whole command was read and names no target.
      call.settled = true;
      this.stopScanning(call);
    } else if (command.length > MAX_SCANNED_COMMAND_CHARS) {
      this.stopScanning(call);
    }
    return null;
  }

  /**
   * The call's arguments are complete (before it runs). Yields the intent if
   * streaming did not already, marked `early: false`.
   */
  complete(callId: string, toolName: string, input: unknown): SendIntentEvent | null {
    if (!callId) return null;
    const call = this.track(callId);
    if (call.settled) return null;
    call.settled = true;
    this.stopScanning(call);
    if (resolveToolSemantic(toolName) !== "bash") return null;
    const command = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
    if (typeof command !== "string") return null;
    const target = findRaftSendTarget(command, { partial: false });
    return target ? { kind: "send_intent", callId, target, early: false } : null;
  }

  reset(): void {
    this.calls.clear();
  }

  private stopScanning(call: ScannedCall): void {
    call.scanning = false;
    call.args = "";
    call.command = null;
  }

  private track(callId: string): ScannedCall {
    let call = this.calls.get(callId);
    if (!call) {
      call = { name: "", args: "", scanning: true, settled: false, command: null };
      this.calls.set(callId, call);
      if (this.calls.size > MAX_TRACKED_CALLS) {
        const oldest = this.calls.keys().next().value;
        if (oldest !== undefined) this.calls.delete(oldest);
      }
    }
    return call;
  }
}
