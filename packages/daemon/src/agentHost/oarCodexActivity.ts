// Codex activity on the OAR host, read as the legacy Codex driver reads it
// (drivers/codexEventNormalizer.ts), so a Codex agent's activity log looks the
// same on either host.
//
// OAR names a tool call by its item type (`commandExecution`, `fileChange`,
// `mcpToolCall`, `webSearch`) with the input as text, and streams every
// `agentMessage` as text whatever its phase. The legacy driver reports
// `shell {command}`, one `file_change {path, kind}` per changed file,
// `mcp_<server>_<tool> {arguments}` and `web_search {query}`, and keeps
// commentary (a non-final phase) out of the text rows. What the events lack
// is in the native frames, read here from the session's raw records. OAR's
// `events()` is a tap on the same record stream, so a reader subscribed before
// it has seen a record's frame
// by the time the record's events arrive. On a replay (the host subscribes
// right after the first input) the reader reads every replayed frame before
// any event; that holds because the replay covers only the first turn.

import type { RawEvent } from "@botiverse/oar";
import { codexBlankFinalAnswerDiagnostic, codexMcpToolName, codexNotificationDiagnostics, parseCodexTelemetryEvent, type ParsedEvent } from "../drivers/index";
import type { RuntimeDiagnosticEvent } from "../runtimeEventTrace";
import type { OarActivityReading, OarTextDelta, OarToolCall, OarToolEnded, OarToolStarted } from "./oarActivity";

type NativeRecord = Record<string, unknown>;

function asRecord(value: unknown): NativeRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as NativeRecord : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A missing phase is "unknown", not commentary: providers do not always send it (the driver's rule). */
function isUserVisiblePhase(phase: string | null | undefined): boolean {
  return phase === null || phase === undefined || phase === "final_answer";
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function parsedJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One file change item's changes, as the driver announces them: `{path, kind}` each, ids `<item>:<index>`. */
function fileChangeCalls(callId: string, changes: unknown): OarToolCall[] {
  if (!Array.isArray(changes)) return [];
  return changes.map((change, index) => {
    const entry = asRecord(change);
    return { name: "file_change", input: { path: entry?.path, kind: entry?.kind }, callId: `${callId}:${index}` };
  });
}

export class CodexActivityReader implements OarActivityReading {
  /** The legacy driver's line for a reconnect; OAR 0.89 reports those as `retry`. */
  readonly retryDetail = "Codex reconnecting to provider…";

  /** Per turn, by item id: each agent message's phase as codex said it. */
  private readonly messagePhases = new Map<string, string | null>();
  /** Per turn, by item id: how many calls a file change announced, so its end closes each. */
  private readonly fileChangeCounts = new Map<string, number>();
  /** Per turn, by item id: the changes a completed file change lists, for one whose start listed none. */
  private readonly completedChanges = new Map<string, unknown>();
  /** Leading whitespace of a visible message that has shown no character yet (held, never shown alone). */
  private readonly heldWhitespace = new Map<string, string>();
  private readonly visibleMessages = new Set<string>();
  private sawAssistantText = false;
  private reviewing = false;
  private deliveredVisibleText = false;
  /** The turn the last `turn/started` named: a telemetry frame that names none belongs to it (the driver's `activeTurnId`). */
  private activeTurnId: string | undefined;

  constructor(private readonly rootSessionId: string) {}

  /** Codex is in review mode: a delivery into the turn is held. */
  get inReview(): boolean {
    return this.reviewing;
  }

  /** The turn so far has shown the user some of the model's text (commentary and whitespace don't count). */
  get turnShowedText(): boolean {
    return this.deliveredVisibleText;
  }

  /**
   * The legacy driver's telemetry (token usage, rate limits) for one record.
   * Token totals stay codex's own session totals, not OAR's per-session count
   * net of the resume baseline, so a turn's cost reads the same on either host.
   */
  telemetry(record: RawEvent): Extract<ParsedEvent, { kind: "telemetry" }> | null {
    if (record.kind !== "frame" || record.agentPath.length > 0 || record.sessionId !== this.rootSessionId) return null;
    const params = asRecord(record.body.native) ?? {};
    const event = parseCodexTelemetryEvent({ method: record.body.type, params });
    if (event?.kind !== "telemetry") return null;
    const turnId = nonEmptyString(params.turnId) ?? this.activeTurnId;
    return turnId ? { ...event, turnId } : event;
  }

  /**
   * Reads one record of the session's stream. Returns the warnings it
   * carries for the activity log (codex warnings, a thread waiting on
   * approval), which no OAR event reports.
   */
  observe(record: RawEvent): RuntimeDiagnosticEvent[] {
    if (record.kind !== "frame" || record.agentPath.length > 0 || record.sessionId !== this.rootSessionId) return [];
    const method = record.body.type;
    const params = asRecord(record.body.native) ?? {};
    switch (method) {
      case "turn/started":
        // Cleared at the next turn's start, not at a turn's end: a coalesced
        // text event of the turn can still arrive after its end frame was read.
        this.messagePhases.clear();
        this.fileChangeCounts.clear();
        this.completedChanges.clear();
        this.heldWhitespace.clear();
        this.visibleMessages.clear();
        this.sawAssistantText = false;
        this.deliveredVisibleText = false;
        this.activeTurnId = nonEmptyString(asRecord(params.turn)?.id) ?? nonEmptyString(params.turnId);
        return [];
      case "turn/completed":
        // A review never outlives its turn, even if its exit item was lost.
        this.reviewing = false;
        return [];
      case "item/agentMessage/delta": {
        const itemId = nonEmptyString(params.itemId);
        const phase = nonEmptyString(params.phase) ?? nonEmptyString(asRecord(params.item)?.phase);
        if (itemId && phase) this.messagePhases.set(itemId, phase);
        return [];
      }
      case "item/started":
      case "item/completed": {
        const item = asRecord(params.item);
        // Review mode (the driver's review_started / review_finished): a steer waits it out.
        if (item?.type === "enteredReviewMode" && method === "item/started") this.reviewing = true;
        if (item?.type === "exitedReviewMode" && method === "item/completed") this.reviewing = false;
        const itemId = nonEmptyString(item?.id);
        if (!item || !itemId) return [];
        if (item.type === "fileChange" && method === "item/completed") this.completedChanges.set(itemId, item.changes);
        if (item.type === "agentMessage" && !this.messagePhases.has(itemId)) this.messagePhases.set(itemId, nonEmptyString(item.phase) ?? null);
        return [];
      }
      default:
        return codexNotificationDiagnostics(method, params);
    }
  }

  toolCalls(event: OarToolStarted): OarToolCall[] | null {
    switch (event.tool) {
      case "commandExecution":
        return [{ name: "shell", input: { command: event.input ?? "" }, callId: event.callId }];
      case "webSearch":
        return [{ name: "web_search", input: { query: event.input ?? "" }, callId: event.callId }];
      case "collabAgentToolCall":
        return [{ name: "collab_tool_call", input: parsedJson(event.input) ?? {}, callId: event.callId }];
      case "mcpToolCall":
        return [{ name: codexMcpToolName({ server: event.server, tool: event.toolName }), input: parsedJson(event.input) ?? {}, callId: event.callId }];
      case "fileChange": {
        const calls = fileChangeCalls(event.callId, parsedJson(event.input));
        this.fileChangeCounts.set(event.callId, calls.length);
        return calls;
      }
      default:
        return null;
    }
  }

  /**
   * A file change closes each call its start announced. One whose start
   * listed no files (or never arrived) announces its files now, from the
   * completed item, so every end has its own start and none closes another
   * open call (the driver's 10-28 case: a command shown open for 3 h).
   */
  toolEnds(event: OarToolEnded): { late: OarToolCall[]; callIds: string[] } | null {
    const isFileChange = this.fileChangeCounts.has(event.callId) || this.completedChanges.has(event.callId);
    if (!isFileChange) return null;
    const announced = this.fileChangeCounts.get(event.callId) ?? 0;
    const late = announced === 0 ? fileChangeCalls(event.callId, this.completedChanges.get(event.callId)) : [];
    this.fileChangeCounts.delete(event.callId);
    this.completedChanges.delete(event.callId);
    const count = announced === 0 ? late.length : announced;
    return { late, callIds: Array.from({ length: count }, (_, index) => `${event.callId}:${index}`) };
  }

  /**
   * Commentary stays out of the text rows; a visible message's leading
   * whitespace waits for its first character, and a message that never has
   * one is never shown (the driver's `admitAgentMessageText`).
   */
  visibleText(event: OarTextDelta): string | null {
    const itemId = event.messageId;
    // OAR 0.89 carries the phase where native reported it, including a completed message with no deltas.
    const phase = event.phase ?? (itemId ? this.messagePhases.get(itemId) : undefined);
    if (!isBlank(event.text)) this.sawAssistantText = true;
    if (!isUserVisiblePhase(phase)) return "";
    if (!itemId) {
      if (isBlank(event.text)) return "";
      this.deliveredVisibleText = true;
      return event.text;
    }
    if (this.visibleMessages.has(itemId)) return event.text;
    if (isBlank(event.text)) {
      this.heldWhitespace.set(itemId, (this.heldWhitespace.get(itemId) ?? "") + event.text);
      return "";
    }
    const held = this.heldWhitespace.get(itemId) ?? "";
    this.heldWhitespace.delete(itemId);
    this.visibleMessages.add(itemId);
    this.deliveredVisibleText = true;
    return held + event.text;
  }

  /** At a completed turn's end: the model wrote, but nothing reached the user (codex's whitespace-only final answer). */
  blankFinalAnswer(): RuntimeDiagnosticEvent | null {
    if (!this.sawAssistantText || this.deliveredVisibleText) return null;
    // Once per turn: a repeated turn end must not report it again.
    this.sawAssistantText = false;
    return codexBlankFinalAnswerDiagnostic(this.rootSessionId);
  }
}
