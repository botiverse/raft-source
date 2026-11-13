/**
 * task #26: context the server writes for an agent about its own setup (the
 * onboarding owner facts), held per agent instead of queued as a message.
 *
 * It is not a channel's content: its `channel_id` is a label
 * ("onboarding-context"), so an inbox row for it offers a `raft message read`
 * that cannot resolve and never clears. It is also not a reason to work: it
 * rides ahead of the next input each runtime process gets (its first prompt,
 * or the next stdin write), once per process and session, and never wakes or
 * starts an agent by itself. The server re-sends it whenever the computer
 * comes back; the latest copy wins.
 */
export interface ServerContext {
  id: string;
  body: string;
}

/** Where an input is written: the process, and its session when known. */
export interface ServerContextReach {
  processInstanceId: string;
  sessionId?: string | null;
}

/** Enough to cover the launches one daemon lifetime resumes the same body into. */
const MAX_REACHED_KEYS = 64;

export class ServerContextLedger {
  private readonly held = new Map<string, ServerContext>();
  private readonly reached = new Map<string, string[]>();

  /** Keeps the latest context for the agent. Returns false when it is unchanged. */
  hold(agentId: string, context: ServerContext): boolean {
    const previous = this.held.get(agentId);
    if (previous && previous.body === context.body) return false;
    this.held.set(agentId, context);
    // A new body has reached nobody yet.
    this.reached.delete(agentId);
    return true;
  }

  /** The held context this process and session have not been given yet. */
  pending(agentId: string, reach: ServerContextReach): ServerContext | null {
    const context = this.held.get(agentId);
    if (!context) return null;
    const keys = this.reached.get(agentId) ?? [];
    if (keys.includes(processKey(reach.processInstanceId))) return null;
    if (reach.sessionId && keys.includes(sessionKey(reach.sessionId))) return null;
    return context;
  }

  /**
   * Records a write that landed. With the context included it now reached the
   * process and its session; without it, a process that already had it may
   * have learned its session id since, so a later resume of that session is
   * not given it again.
   */
  noteWritten(agentId: string, reach: ServerContextReach, included: ServerContext | null): void {
    const context = this.held.get(agentId);
    if (!context) return;
    if (included && included.body !== context.body) return;
    const keys = this.reached.get(agentId) ?? [];
    const hadProcess = keys.includes(processKey(reach.processInstanceId));
    if (!included && !hadProcess) return;
    const add = [processKey(reach.processInstanceId), ...(reach.sessionId ? [sessionKey(reach.sessionId)] : [])];
    const next = [...keys.filter((key) => !add.includes(key)), ...add];
    this.reached.set(agentId, next.slice(-MAX_REACHED_KEYS));
  }

  /** A process that had the context learned its session id: a resume of that session has it too. */
  noteSession(agentId: string, processInstanceId: string, sessionId: string | null): void {
    if (sessionId) this.noteWritten(agentId, { processInstanceId, sessionId }, null);
  }

  /** The runtime rejected an input after accepting it: it may have carried the context. */
  forgetReach(agentId: string, reach: ServerContextReach): void {
    const keys = this.reached.get(agentId);
    if (!keys) return;
    const drop = [processKey(reach.processInstanceId), ...(reach.sessionId ? [sessionKey(reach.sessionId)] : [])];
    this.reached.set(agentId, keys.filter((key) => !drop.includes(key)));
  }
}

function processKey(processInstanceId: string): string {
  return `process:${processInstanceId}`;
}

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}
