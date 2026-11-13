/**
 * Tool calls a CLI driver has reported started and not yet finished, keyed by
 * the runtime's own call id (task #26). The daemon counts every `tool_call`
 * against a `tool_output`, so a driver must end exactly the calls it started:
 * an end with an id the driver never opened (a Copilot advisor result, a
 * duplicate) is dropped instead of closing some other open call.
 */
export class OpenToolCalls {
  private readonly open = new Map<string, string>();
  /** Ids already ended in this turn: a repeated start must not reopen them. */
  private readonly closed = new Set<string>();

  /** False when this id is already open or already ended (a duplicate start). */
  start(callId: string, name: string): boolean {
    if (this.open.has(callId) || this.closed.has(callId)) return false;
    this.open.set(callId, name);
    return true;
  }

  /** The name the call started with, or undefined if it is not open. */
  end(callId: string): string | undefined {
    const name = this.open.get(callId);
    if (name === undefined) return undefined;
    this.open.delete(callId);
    this.closed.add(callId);
    return name;
  }

  /** Every call still open, closed: the runtime will not finish them. */
  drain(): { callId: string; name: string }[] {
    const calls = [...this.open].map(([callId, name]) => ({ callId, name }));
    for (const callId of this.open.keys()) this.closed.add(callId);
    this.open.clear();
    return calls;
  }

  /** The turn ended (the daemon resets its count with it). */
  clear(): void {
    this.open.clear();
    this.closed.clear();
  }
}
