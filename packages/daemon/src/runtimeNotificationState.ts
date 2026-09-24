import { clearTimeout as clearNodeTimeout, setTimeout as scheduleNodeTimeout } from "node:timers";

/**
 * Derived dedup-key for a busy stdin inbox notice: the sorted set of
 * seq (preferred) / message_id identities of the messages projected into the
 * notice. NOT a count and NOT a (count, first, latest) summary — those collide
 * on the over-suppress case (read-one + new-one keeps the count but changes the
 * set). The key is recomputed from the current unread-set on every send, so a
 * stale key can only ever cause one extra notice (safe), never swallow one.
 *
 * Returns "" when no message carries a usable identity; callers treat an empty
 * key as "do not dedup" (fail toward sending).
 */
export type InboxNoticeIdentityMessage = { seq?: number; message_id?: string; id?: string };

export interface RuntimeNotificationScheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}

const systemNotificationScheduler: RuntimeNotificationScheduler = {
  schedule: (fn, ms) => scheduleNodeTimeout(fn, ms),
  cancel: (timer) => clearNodeTimeout(timer as ReturnType<typeof scheduleNodeTimeout>),
};

export function inboxNoticeMessageIdentity(message: InboxNoticeIdentityMessage): string {
  const seq = typeof message.seq === "number" && Number.isFinite(message.seq) && message.seq > 0
    ? Math.floor(message.seq)
    : null;
  if (seq !== null) {
    return `s:${seq}`;
  }
  const id = typeof message.message_id === "string" && message.message_id.length > 0
    ? message.message_id
    : typeof message.id === "string" && message.id.length > 0
      ? message.id
      : "";
  return id.length > 0 ? `m:${id}` : "";
}

export function computeInboxNoticeFingerprint(
  messages: readonly InboxNoticeIdentityMessage[],
): string {
  const keys: string[] = [];
  for (const m of messages) {
    const key = inboxNoticeMessageIdentity(m);
    if (key.length > 0) keys.push(key);
  }
  if (keys.length === 0) return "";
  keys.sort();
  return keys.join(",");
}

/**
 * Owns pending busy-delivery notification state.
 *
 * The count is intentionally separate from inbox length: it tracks messages
 * queued since the last notification attempt, so compaction suppression and
 * encode failures can restore the notification debt without duplicating inbox
 * state.
 *
 * It also holds the last-written notice fingerprint (a derived dedup memo, NOT
 * a cursor): the unread-set identity last SUCCESSFULLY written to the runtime
 * over stdin, scoped to the session it was written under. This lets
 * sendStdinNotification suppress byte-identical re-injection of an already-
 * delivered, not-yet-consumed unread-set (the inbox-notice 429 retry storm),
 * while never suppressing a genuinely changed set. The model-seen / consume
 * boundary remains the single source of truth; this memo only remembers "what
 * was last sent" and is compared against a set recomputed from that boundary.
 *
 * The failed-encode memo is separate: it remembers an unsupported busy-send
 * attempt for the same unread-set so a closed steering gate does not trigger a
 * blind retry loop. Unlike a written notice, this memo must not consume pending
 * debt; callers keep pending queued and retry only from a signal that can
 * actually reopen delivery, such as runtime progress or the turn boundary.
 *
 * The contributed-identity set is narrower than a consume cursor: it records
 * which still-pending messages have already contributed to a content-free inbox
 * update in this session. Later batches may still report the total pending
 * count, but they must not count an already-contributed row as changed again.
 * Pruning against the current inbox keeps the memo from hiding a row that was
 * consumed/read and then re-arrived with the same server identity.
 */
export class RuntimeNotificationState {
  private timerValue: unknown | null = null;
  private pendingCountValue = 0;
  private lastNoticeFingerprint: string | null = null;
  private lastNoticeSessionId: string | null = null;
  private lastEncodeFailedFingerprint: string | null = null;
  private lastEncodeFailedSessionId: string | null = null;
  private contributedSessionId: string | null = null;
  private contributedIdentities = new Set<string>();

  constructor(private readonly scheduler: RuntimeNotificationScheduler = systemNotificationScheduler) {}

  get pendingCount(): number {
    return this.pendingCountValue;
  }

  get timer(): unknown | null {
    return this.timerValue;
  }

  get hasTimer(): boolean {
    return this.timerValue !== null;
  }

  add(count = 1): number {
    this.pendingCountValue += count;
    return this.pendingCountValue;
  }

  clearPending() {
    this.pendingCountValue = 0;
  }

  remove(count: number) {
    if (!Number.isFinite(count) || count <= 0) return this.pendingCountValue;
    this.pendingCountValue = Math.max(0, this.pendingCountValue - Math.floor(count));
    return this.pendingCountValue;
  }

  clearTimer() {
    if (this.timerValue) {
      this.scheduler.cancel(this.timerValue);
      this.timerValue = null;
    }
  }

  clear() {
    this.clearPending();
    this.clearTimer();
    this.clearNoticeFingerprint();
  }

  /**
   * True iff this exact unread-set was already successfully written in THIS
   * session (per-(agent,session) scope — never suppress across a session
   * change). Empty fingerprint always returns false (fail toward sending).
   */
  isDuplicateNotice(fingerprint: string, sessionId: string | null): boolean {
    if (fingerprint.length === 0) return false;
    return this.lastNoticeFingerprint === fingerprint && this.lastNoticeSessionId === sessionId;
  }

  /** Register a fingerprint as written — call ONLY after a successful stdin write. */
  recordNoticeWritten(
    fingerprint: string,
    sessionId: string | null,
    messages: readonly InboxNoticeIdentityMessage[] = [],
  ) {
    this.lastNoticeFingerprint = fingerprint;
    this.lastNoticeSessionId = sessionId;
    this.lastEncodeFailedFingerprint = null;
    this.lastEncodeFailedSessionId = null;
    this.ensureContributionSession(sessionId);
    for (const message of messages) {
      const identity = inboxNoticeMessageIdentity(message);
      if (identity.length > 0) {
        this.contributedIdentities.add(identity);
      }
    }
  }

  hasContributedMessage(message: InboxNoticeIdentityMessage, sessionId: string | null): boolean {
    if (this.contributedSessionId !== sessionId) return false;
    const identity = inboxNoticeMessageIdentity(message);
    return identity.length > 0 && this.contributedIdentities.has(identity);
  }

  filterUncontributedMessages<T extends InboxNoticeIdentityMessage>(
    messages: readonly T[],
    sessionId: string | null,
  ): T[] {
    if (this.contributedSessionId !== sessionId || this.contributedIdentities.size === 0) {
      return [...messages];
    }
    return messages.filter((message) => {
      const identity = inboxNoticeMessageIdentity(message);
      return identity.length === 0 || !this.contributedIdentities.has(identity);
    });
  }

  pruneContributedToPending(messages: readonly InboxNoticeIdentityMessage[], sessionId: string | null) {
    this.ensureContributionSession(sessionId);
    if (this.contributedIdentities.size === 0) return;
    const pending = new Set<string>();
    for (const message of messages) {
      const identity = inboxNoticeMessageIdentity(message);
      if (identity.length > 0) pending.add(identity);
    }
    for (const identity of this.contributedIdentities) {
      if (!pending.has(identity)) {
        this.contributedIdentities.delete(identity);
      }
    }
  }

  isDuplicateEncodeFailedNotice(fingerprint: string, sessionId: string | null): boolean {
    if (fingerprint.length === 0) return false;
    return this.lastEncodeFailedFingerprint === fingerprint && this.lastEncodeFailedSessionId === sessionId;
  }

  recordNoticeEncodeFailed(fingerprint: string, sessionId: string | null) {
    if (fingerprint.length === 0) return;
    this.lastEncodeFailedFingerprint = fingerprint;
    this.lastEncodeFailedSessionId = sessionId;
  }

  clearNoticeFingerprint() {
    this.lastNoticeFingerprint = null;
    this.lastNoticeSessionId = null;
    this.lastEncodeFailedFingerprint = null;
    this.lastEncodeFailedSessionId = null;
    this.contributedSessionId = null;
    this.contributedIdentities.clear();
  }

  schedule(callback: () => void, delayMs: number): boolean {
    if (this.timerValue) return false;
    this.timerValue = this.scheduler.schedule(callback, delayMs);
    return true;
  }

  takePendingAndClearTimer(): number {
    const count = this.pendingCountValue;
    this.pendingCountValue = 0;
    this.clearTimer();
    return count;
  }

  private ensureContributionSession(sessionId: string | null) {
    if (this.contributedSessionId === sessionId) return;
    this.contributedSessionId = sessionId;
    this.contributedIdentities.clear();
  }
}
