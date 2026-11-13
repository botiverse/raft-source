import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Stand-ins for pi's AgentSession over a real SessionManager, for session
// rotation tests (drivers/piSessionRotation.test.ts and the APM side).

let clock = 0;
export function turn(sm: SessionManager, label: string): string {
  const id = sm.appendMessage({ role: "user", content: `${label} question ${"words ".repeat(50)}`, timestamp: ++clock });
  const answer: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: `${label} answer` }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: ++clock,
  };
  sm.appendMessage(answer);
  return id;
}

/** A session with history, a compaction keeping the last turns, and a turn after it. */
export function compactedSession(sessionDir: string, cwd: string, sessionId: string, before?: (sm: SessionManager) => void): SessionManager {
  const sm = SessionManager.create(cwd, sessionDir, { id: sessionId });
  before?.(sm);
  turn(sm, "t1");
  const kept = turn(sm, "t2");
  sm.appendCompaction("summary of t1", kept, 1000);
  turn(sm, "t3");
  return sm;
}

/** Stand-in for pi's AgentSession over a real SessionManager. */
export class FakePiSession {
  readonly prompts: string[] = [];
  disposed = false;
  isIdle = true;
  isRetrying = false;
  isStreaming = false;
  pendingMessageCount = 0;
  /** The loaded extensions; none by default (the daemon's own is not a user extension either). */
  extensions: Array<{ path: string }> = [];
  readonly systemPrompt = "";
  readonly messages = [];
  readonly model = undefined;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  constructor(readonly sessionManager: SessionManager) {}

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get resourceLoader() {
    return { getExtensions: () => ({ extensions: this.extensions }) };
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener(event as unknown as AgentSessionEvent);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    turn(this.sessionManager, text);
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled", aborted: false });
  }

  async steer(text: string): Promise<void> {
    this.prompts.push(`steer:${text}`);
  }

  dispose(): void {
    this.disposed = true;
  }
}

export const COMPACTION_END = {
  type: "compaction_end",
  reason: "threshold",
  result: { summary: "s", firstKeptEntryId: "x", tokensBefore: 1 },
  aborted: false,
  willRetry: false,
};

