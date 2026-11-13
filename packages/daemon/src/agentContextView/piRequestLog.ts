import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { CONTEXT_VIEW_APPEND_FLAGS, CONTEXT_VIEW_READ_FLAGS } from "./contextViewStore";

/**
 * View Context: the model requests of a runtime hosted in this daemon (Pi,
 * Built-in), which its session file does not keep (no system prompt, no tool
 * list, nothing the SDK adds on the way out). One JSONL file per session, of
 * the body as sent, deduplicated:
 *
 * - `shape` {hash, messagesKey, shape}: the body without its messages and
 *   `params`. Written once per distinct shape.
 * - `blob` {hash, message}: one message. Written once per distinct message.
 * - `request` {id, at, provider, api, model, params, shapeHash, base, keep, tail, digest}:
 *   the request's messages are the first `keep` of request `base` followed by
 *   the hashes in `tail`. `params` are the small top-level values (and those
 *   of a Google `config`): the SDK clamps `max_tokens` to the room left, so
 *   they change per request where the system prompt and tools don't. `digest`
 *   covers the shape, the params and all the message hashes.
 * - `gap` {reason, at}: requests were made here and not recorded, so the
 *   request before this line is not the one that came next.
 *
 * Hashes are SHA-256 (hex) of the record's compact JSON as written. Inline
 * media is replaced with a marker (`piRequestLogMediaMarker`): a session's
 * screenshots would otherwise be kept once per message, for 30 days, and the
 * view shows their size, not their pixels.
 *
 * The body is the one the SDK hands `onPayload` (pi.ts `recordingRequests`).
 * For Anthropic message threads pi-ai builds that body in full and only then
 * cuts the wire request down to a `continue` with the new messages, so every
 * record is the whole context with threads on or off; the assistant reply is
 * read from the next record, as without threads (piRequestLog.threads.test.ts).
 *
 * Nothing here may affect the model call: `record` never throws.
 */
/** The file stops growing here: Pi's reader takes 0.5-0.8 GiB RSS at this size, more than Claude Code's. */
export const PI_REQUEST_LOG_MAX_BYTES = 128 * 1024 * 1024;
const GAP_LINE_ROOM = 128;

const SESSION_FILE = /^[A-Za-z0-9._-]{1,200}\.jsonl$/;
/** Where each provider API keeps its messages. A body with none of these isn't recorded: it would be all shape, once per request. */
const MESSAGE_KEYS = ["messages", "input", "contents"] as const;
const PARAM_MAX_CHARS = 256;
const BASE64 = /^[A-Za-z0-9+/=_-]+$/;
const DATA_URL = /^data:([^;,]{1,100});base64,[A-Za-z0-9+/=_-]*$/;
const INLINE_MEDIA_MIN_CHARS = 1024;

function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function piRequestLogMediaMarker(mediaType: string | null, bytes: number, hash: string): string {
  return `[raft:media ${mediaType ?? "unknown"} ${bytes} bytes sha256=${hash}]`;
}

function stringField(holder: Record<string, unknown>, key: string): string | null {
  const value = holder[key];
  return typeof value === "string" ? value : null;
}

/** Anthropic's `{type: "base64", media_type, data}`, Google's `{mimeType, data}`. */
function inlineMediaType(holder: Record<string, unknown>): string | null {
  return stringField(holder, "media_type") ?? stringField(holder, "mimeType");
}

function maskInlineMedia(this: unknown, key: string, value: unknown): unknown {
  // Bedrock's image bytes.
  if (value instanceof Uint8Array) return piRequestLogMediaMarker(null, value.length, sha256Hex(value));
  if (typeof value !== "string" || value.length < INLINE_MEDIA_MIN_CHARS) return value;
  const url = DATA_URL.exec(value);
  if (url) return piRequestLogMediaMarker(url[1]!, Math.floor(((value.length - value.indexOf(",") - 1) * 3) / 4), sha256Hex(value));
  if (key !== "data" || !BASE64.test(value)) return value;
  const mediaType = inlineMediaType(this as Record<string, unknown>);
  return mediaType === null ? value : piRequestLogMediaMarker(mediaType, Math.floor((value.length * 3) / 4), sha256Hex(value));
}

function maskedJson(value: unknown): string {
  return JSON.stringify(value, maskInlineMedia) ?? "null";
}

function isParam(value: unknown): boolean {
  return typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= PARAM_MAX_CHARS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitParams(from: Record<string, unknown>): { params: Record<string, unknown>; rest: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(from)) (isParam(value) ? params : rest)[key] = value;
  return { params, rest };
}

function splitBody(body: Record<string, unknown>): { messagesKey: string; messages: unknown[]; params: Record<string, unknown>; shape: Record<string, unknown> } | null {
  const messagesKey = MESSAGE_KEYS.find((key) => Array.isArray(body[key]));
  if (!messagesKey) return null;
  const { [messagesKey]: messages, ...others } = body;
  const { params, rest: shape } = splitParams(others);
  if (isPlainObject(shape.config)) {
    const config = splitParams(shape.config);
    params.config = config.params;
    shape.config = config.rest;
  }
  return { messagesKey, messages: messages as unknown[], params, shape };
}

export function piRequestDigest(shapeHash: string, paramsJson: string, messageHashes: readonly string[]): string {
  return sha256Hex(`${shapeHash}\n${paramsJson}\n${messageHashes.join("\n")}`);
}

/** The runtimes hosted in this daemon, whose context comes from this log. */
export function isPiRequestLogRuntime(runtime: string | null | undefined): boolean {
  return runtime === "pi" || runtime === "builtin";
}

export interface PiRequestFacts {
  sessionId: string;
  provider: string | null;
  api: string | null;
  model: string | null;
}

export type PiRequestLogSkip = "not_an_object" | "unknown_body" | "bad_session_id" | "over_cap" | "write_failed";

export function piRequestLogFile(dir: string, sessionId: string): string | null {
  const name = `${sessionId}.jsonl`;
  return SESSION_FILE.test(name) ? path.join(dir, name) : null;
}

function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buffer.length) {
    const count = writeSync(fd, buffer, written);
    if (count === 0) throw new Error("request log write made no progress");
    written += count;
  }
}

/** One session at a time: a process holds one, and rotation keeps its id. */
export class PiRequestLog {
  private current: {
    sessionId: string;
    bytes: number;
    written: Set<string>;
    last: { id: string; hashes: string[] } | null;
    full: boolean;
  } | null = null;
  /** Requests of this session that weren't recorded since the last that was. */
  private missed: { sessionId: string; reason: string; marked: boolean } | null = null;

  constructor(
    /** The directory for this agent's logs; null while the feature is off, which stops the writing. */
    private readonly directory: () => string | null,
    private readonly onSkip: (reason: PiRequestLogSkip, error?: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  record(body: unknown, facts: PiRequestFacts): void {
    try {
      this.write(body, facts);
    } catch (error) {
      this.current = null;
      this.miss(facts.sessionId, "write_failed", error);
    }
  }

  private miss(sessionId: string, reason: PiRequestLogSkip | "off", error?: unknown): void {
    this.missed = { sessionId, reason, marked: false };
    if (reason !== "off") this.onSkip(reason, error);
  }

  /** A body we won't record: the file says so now, or a send after it would read as the older request's. */
  private missBody(file: string, sessionId: string, reason: PiRequestLogSkip): void {
    if (this.missed?.sessionId === sessionId && this.missed.marked) return;
    this.miss(sessionId, reason);
    // No file: nothing recorded to mistake for this request, and no log to report as available.
    if (!existsSync(file)) {
      this.missed = { sessionId, reason, marked: true };
      return;
    }
    const fd = openSync(file, CONTEXT_VIEW_APPEND_FLAGS, 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new Error("request log is not a plain file");
      const line = `${info.size > 0 && !endsWithNewline(file, info.size) ? "\n" : ""}${this.gapLine(reason)}`;
      if (info.size + Buffer.byteLength(line, "utf8") > PI_REQUEST_LOG_MAX_BYTES) return;
      writeAll(fd, line);
      if (this.current?.sessionId === sessionId && this.current.bytes === info.size) this.current.bytes += Buffer.byteLength(line, "utf8");
      this.missed = { sessionId, reason, marked: true };
    } finally {
      closeSync(fd);
    }
  }

  private gapLine(reason: string): string {
    return `${JSON.stringify({ type: "gap", reason, at: new Date(this.now()).toISOString() })}\n`;
  }

  private write(body: unknown, facts: PiRequestFacts): void {
    const dir = this.directory();
    if (dir === null) {
      this.current = null;
      this.miss(facts.sessionId, "off");
      return;
    }
    const file = piRequestLogFile(dir, facts.sessionId);
    if (file === null) {
      this.onSkip("bad_session_id");
      return;
    }
    if (!isPlainObject(body)) {
      this.missBody(file, facts.sessionId, "not_an_object");
      return;
    }
    const split = splitBody(body);
    if (split === null) {
      this.missBody(file, facts.sessionId, "unknown_body");
      return;
    }
    if (this.current?.sessionId !== facts.sessionId) {
      this.current = { sessionId: facts.sessionId, bytes: -1, written: new Set(), last: null, full: false };
    }
    const session = this.current;
    if (session.full) return;

    const lines: string[] = [];
    const shapeJson = maskedJson(split.shape);
    const shapeHash = sha256Hex(shapeJson);
    const hashes: string[] = [];
    const blobs = new Map<string, string>();
    for (const message of split.messages) {
      const json = maskedJson(message);
      const hash = sha256Hex(json);
      hashes.push(hash);
      blobs.set(hash, json);
    }
    const paramsJson = JSON.stringify(split.params);

    const fd = openSync(file, CONTEXT_VIEW_APPEND_FLAGS, 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new Error("request log is not a plain file");
      // A restart continues the file, writing its shape and messages again once
      // rather than read a file that can be 128 MiB. A size we didn't leave it
      // at means the file was swept or cut under us: same, nothing it held is known.
      let lineEnd = "";
      if (info.size !== session.bytes) {
        session.written.clear();
        session.last = null;
        session.bytes = info.size;
        if (info.size > 0 && !endsWithNewline(file, info.size)) lineEnd = "\n";
      }
      lines.push(lineEnd);
      if (this.missed?.sessionId === facts.sessionId && !this.missed.marked) lines.push(this.gapLine(this.missed.reason));

      if (!session.written.has(shapeHash)) {
        lines.push(`{"type":"shape","hash":"${shapeHash}","messagesKey":${JSON.stringify(split.messagesKey)},"shape":${shapeJson}}\n`);
      }
      for (const [hash, json] of blobs) {
        if (!session.written.has(hash)) lines.push(`{"type":"blob","hash":"${hash}","message":${json}}\n`);
      }
      const last = session.last;
      let keep = 0;
      if (last) while (keep < last.hashes.length && keep < hashes.length && last.hashes[keep] === hashes[keep]) keep += 1;
      const id = randomUUID();
      lines.push(`${JSON.stringify({
        type: "request",
        id,
        at: new Date(this.now()).toISOString(),
        provider: facts.provider,
        api: facts.api,
        model: facts.model,
        params: split.params,
        shapeHash,
        base: keep > 0 ? last!.id : null,
        keep,
        tail: hashes.slice(keep),
        digest: piRequestDigest(shapeHash, paramsJson, hashes),
      })}\n`);

      const text = lines.join("");
      const bytes = Buffer.byteLength(text, "utf8");
      if (session.bytes + bytes + GAP_LINE_ROOM > PI_REQUEST_LOG_MAX_BYTES) {
        // The file stops here, and says so if there's room: a file over the
        // restore's cap would be refused whole, so the line never takes it past.
        const stop = lineEnd + this.gapLine("over_cap");
        if (session.bytes + Buffer.byteLength(stop, "utf8") <= PI_REQUEST_LOG_MAX_BYTES) writeAll(fd, stop);
        session.full = true;
        this.onSkip("over_cap");
        return;
      }
      // Whole, or the next request sees a size it didn't expect and starts over.
      writeAll(fd, text);
      session.bytes += bytes;
      session.written.add(shapeHash);
      for (const hash of blobs.keys()) session.written.add(hash);
      session.last = { id, hashes };
      this.missed = null;
    } finally {
      closeSync(fd);
    }
  }
}

function endsWithNewline(file: string, size: number): boolean {
  const fd = openSync(file, CONTEXT_VIEW_READ_FLAGS);
  try {
    const last = Buffer.alloc(1);
    return readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Removes session logs not written to since the cutoff. Returns how many went. */
export function sweepPiRequestLogs(dir: string, cutoffMs: number): number {
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return 0;
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!SESSION_FILE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const info = lstatSync(file);
      if (info.isFile() && info.mtimeMs < cutoffMs) {
        unlinkSync(file);
        removed += 1;
      }
    } catch {
      // Gone already, or not ours to read: the next sweep looks again.
    }
  }
  return removed;
}
