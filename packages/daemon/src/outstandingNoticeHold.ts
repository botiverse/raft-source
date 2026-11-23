import type { AgentMessage } from "@botiverse/raft-shared";
import { runtimeProfileNotificationFromMessage } from "./agentRuntimeInput";

/**
 * Task #triage:#399 step 1: at most one outstanding pure inbox notice per
 * session, for Codex only (`noticeHoldAppliesTo`).
 *
 * A pure notice is an inbox update that carries no message body (the
 * "[Raft inbox notice: ...]" text, sent as ordinary user input). Runtimes
 * such as Codex keep every user input across compaction, so a long busy turn
 * that is told of each new batch fills the compacted history with notices.
 *
 * Once one pure notice has landed in a session, further busy pure notices for
 * that session are held until the agent reads its inbox, the turn ends, a
 * compaction boundary passes or the session changes. A new @mention of the
 * agent, a new DM (or a runtime-profile control message) breaks through once;
 * the notice it sends covers what was held, and the hold starts again. What
 * was held and is still unread is told once when the hold ends (at the turn
 * end: the ordinary idle delivery, which starts a new turn).
 *
 * Idle notices are never held (each starts a turn); they do start a hold.
 * Message bodies (thread context), system notices and runtime-profile control
 * prompts are unchanged.
 */

/**
 * The runtimes the hold applies to: Codex, whose sessions keep every user
 * input across compaction (the customer report; Codex app-server 0.168).
 * Every other runtime is told of each batch as before.
 */
export function noticeHoldAppliesTo(runtimeId: string | null | undefined): boolean {
  return runtimeId === "codex";
}

/** Daemon-local kill switch: `RAFT_DAEMON_NOTICE_HOLD_DISABLED=1` tells every busy notice as before. */
export const NOTICE_HOLD_DISABLED_ENV = "RAFT_DAEMON_NOTICE_HOLD_DISABLED";

/** Read live at each decision, as `isOarHostEnabled` reads its switch. */
export function isNoticeHoldEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[NOTICE_HOLD_DISABLED_ENV]?.trim().toLowerCase();
  return raw === undefined || raw === "" || raw === "0" || raw === "false" || raw === "off";
}

export type NoticeHoldReleaseReason =
  /** The agent read through the credential proxy (`message check` / `inbox read` / history / a held send's context). */
  | "inbox_read"
  | "turn_end"
  /** The process went idle without a turn end (a closed busy gate, an error): its idle flush tells what waits. */
  | "idle"
  | "compaction"
  /** A notice the runtime took was later rejected: it never reached the model. */
  | "delivery_rejected";

/**
 * A message that is told even while a notice is outstanding: it mentions the
 * agent, it is a DM to it (or a reply in a DM thread), or it is a
 * runtime-profile control message. Third-party app events are not DMs here.
 */
export function breaksNoticeHold(message: AgentMessage): boolean {
  if (message.mentioned === true) return true;
  if (runtimeProfileNotificationFromMessage(message)) return true;
  if (message.third_party_event) return false;
  if (message.channel_type === "dm") return true;
  return message.channel_type === "thread" && message.parent_channel_type === "dm";
}

/**
 * Whether a pure notice is outstanding in a session, and how many notices
 * were held behind it. Owns no timers and no message state: callers keep
 * their held deliveries where they already were (the legacy inbox, the OAR
 * host's pending list).
 */
export class OutstandingNoticeHold {
  private armed = false;
  private sessionId: string | null = null;
  private suppressed = 0;

  /** Notices held since the hold started. */
  get suppressedCount(): number {
    return this.suppressed;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /**
   * A pure notice landed in `sessionId`: hold the next ones. Returns how many
   * were held behind the previous one in the same session (a break-through),
   * else 0.
   */
  arm(sessionId: string | null): number {
    const previous = this.armed && this.sessionId === sessionId ? this.suppressed : 0;
    this.armed = true;
    this.sessionId = sessionId;
    this.suppressed = 0;
    return previous;
  }

  /**
   * Whether a busy pure notice to `sessionId` waits. Only in the session the
   * outstanding notice went to; a fresh session's id learned after its first
   * input (task #389) is the same session.
   */
  holds(sessionId: string | null): boolean {
    if (!this.armed || !isNoticeHoldEnabled()) return false;
    if (this.sessionId === null && sessionId !== null) this.sessionId = sessionId;
    return this.sessionId === sessionId;
  }

  /** One more notice held; returns the count so far. */
  noteSuppressed(): number {
    this.suppressed += 1;
    return this.suppressed;
  }

  /** What was held went out with another write (a message body): nothing is held behind the outstanding notice now. It stays outstanding. */
  settleSuppressed(): void {
    this.suppressed = 0;
  }

  /** Ends the hold; null when none was armed. */
  release(): { suppressed: number } | null {
    if (!this.armed) return null;
    const released = { suppressed: this.suppressed };
    this.reset();
    return released;
  }

  reset(): void {
    this.armed = false;
    this.sessionId = null;
    this.suppressed = 0;
  }
}
