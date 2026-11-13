
/**
 * The Raft message that started a foreground runtime turn (task #21, @peng msg 3bc1a766).
 *
 * The server only raises a Connect card for a refused managed MCP call when the call names the
 * message it came from, and it re-validates that message (same server, acting Agent is a member).
 * Without an origin it posts nothing -- it never guesses a channel. So the daemon's only job is to
 * say, truthfully, which single message a turn is answering, and to say nothing when it cannot.
 *
 * Shape (@peng):
 *   · derived by the manager from the exact runtime input: a SINGLE CONCRETE MESSAGE ENVELOPE with a
 *     stable UUID, regardless of whether it renders as a content-free inbox notice (msg 4b57d30e).
 *     Batches, app-inbox and system notices, unread summaries, control, pure resume and background
 *     input have no such envelope and carry no origin.
 *   · held per RuntimeSession as {processInstanceId, turnEpoch, sourceMessageId}; set only when a
 *     new prompt is accepted, never by a busy steer; cleared on turn_end, exit and stop.
 *   · read by both call surfaces AT CALL TIME through a getter bound to that session's process.
 *   · never last-writer-wins: a new origin while the previous turn is still open fails closed, and
 *     stays closed for any number of later messages. Only turn_end, close, or a new process (a new
 *     holder) restores origins -- never a later message.
 */
export type RuntimeTurnOrigin = { sourceMessageId: string };

export type RuntimeTurnOriginSnapshot = {
  processInstanceId: string;
  turnEpoch: number;
  sourceMessageId: string;
};

export type RuntimeTurnOriginReader = () => RuntimeTurnOriginSnapshot | null;

/**
 * Per-session holder. One instance per RuntimeSession, and a session is never shared across process
 * bindings, so the holder is bound to exactly one process instance.
 */
export class RuntimeTurnOriginHolder {
  private turnEpoch = 0;
  private turnOpen = false;
  private sourceMessageId: string | null = null;
  private closed = false;

  constructor(readonly processInstanceId: string | null | undefined) {}

  /**
   * Record that a NEW prompt was accepted. Busy steers must not call this.
   *
   * ⚠️ If the previous turn has not reported turn_end, this does not overwrite it with the newer
   * origin: it clears the origin for the rest of the open turn. Calls in that turn could belong to
   * either message, and naming either one would be a guess.
   */
  beginTurn(origin: RuntimeTurnOrigin | null | undefined): void {
    if (this.closed) return;
    this.turnEpoch += 1;
    if (this.turnOpen) {
      this.sourceMessageId = null;
      return;
    }
    this.turnOpen = true;
    this.sourceMessageId = origin?.sourceMessageId ?? null;
  }

  endTurn(): void {
    this.turnOpen = false;
    this.sourceMessageId = null;
  }

  close(): void {
    this.closed = true;
    this.endTurn();
  }

  /** Read-only getter handed to the call surfaces. Returns a copy; there is no way to write through it. */
  readonly read: RuntimeTurnOriginReader = () => {
    if (this.closed || !this.turnOpen || !this.sourceMessageId || !this.processInstanceId) return null;
    return {
      processInstanceId: this.processInstanceId,
      turnEpoch: this.turnEpoch,
      sourceMessageId: this.sourceMessageId,
    };
  };
}

/**
 * Resolve the origin a managed MCP call may carry.
 *
 * `captured` is the snapshot read when the call STARTED. It is re-read here, just before the request
 * is sent, and must still be the same process, the same turn epoch and the same message; otherwise
 * the call goes out without an origin. That covers a call that awaited something (the native proxy
 * reloads the tool snapshot first) while its turn ended or another began.
 *
 * `expectedProcessInstanceId` is the process the call surface was created for. A reader belonging to
 * any other process instance yields no origin.
 */
export function confirmRuntimeTurnOrigin(input: {
  read: RuntimeTurnOriginReader | undefined;
  captured: RuntimeTurnOriginSnapshot | null;
  expectedProcessInstanceId: string | null | undefined;
}): RuntimeTurnOrigin | null {
  const { read, captured, expectedProcessInstanceId } = input;
  if (!read || !captured || !expectedProcessInstanceId) return null;
  if (captured.processInstanceId !== expectedProcessInstanceId) return null;
  const current = read();
  if (
    !current
    || current.processInstanceId !== captured.processInstanceId
    || current.turnEpoch !== captured.turnEpoch
    || current.sourceMessageId !== captured.sourceMessageId
  ) return null;
  return { sourceMessageId: current.sourceMessageId };
}
