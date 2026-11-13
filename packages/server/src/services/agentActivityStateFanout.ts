// The coarse agent state for every member's tab (#proj-frontend:#8): sent to
// the agent's state room (agentActivityStateRoom: the server's capable room,
// or a personal assistant's owner) only when the coarse state (offline /
// online / busy / error) changes, and at most once per agent per interval. A
// change inside the interval is held and sent at its end, as the state it has
// then (nothing when it is back where it was). The detailed `agent:activity` goes
// to the agent's own room (agentActivityRoom) for the tabs that subscribe.
import {
  AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS,
  coarseAgentActivityState,
  type AgentActivityCoarseState,
  type AgentActivityStatePayload,
} from "@botiverse/raft-shared";

interface StateFanoutClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface AgentEntry {
  room: string;
  latest: AgentActivityStatePayload;
  sentState: AgentActivityCoarseState | null;
  sentAt: number | null;
  timer: unknown | null;
}

export class AgentActivityStateFanout {
  private readonly agents = new Map<string, AgentEntry>();

  constructor(
    private readonly send: (room: string, payload: AgentActivityStatePayload) => void,
    private readonly clock: StateFanoutClock,
    private readonly intervalMs: number = AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS,
  ) {}

  /** A detailed activity was emitted for `agentId`: send its coarse state to `room` if it changed, within the interval. */
  observe(room: string, agentId: string, activity: string, timestamp: number, serverSeq: number): void {
    const latest: AgentActivityStatePayload = { agentId, state: coarseAgentActivityState(activity), activity, timestamp, serverSeq };
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = { room, latest, sentState: null, sentAt: null, timer: null };
      this.agents.set(agentId, entry);
    } else {
      entry.room = room;
      entry.latest = latest;
    }
    if (entry.timer !== null) return;
    if (entry.sentState === latest.state) return;
    const wait = entry.sentAt === null ? 0 : entry.sentAt + this.intervalMs - this.clock.now();
    if (wait <= 0) {
      this.flush(entry);
      return;
    }
    const held = entry;
    held.timer = this.clock.setTimeout(() => {
      held.timer = null;
      this.flush(held);
    }, wait);
  }

  /** Forget an agent (deleted): its pending send is dropped. */
  forget(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry?.timer != null) this.clock.clearTimeout(entry.timer);
    this.agents.delete(agentId);
  }

  private flush(entry: AgentEntry): void {
    if (entry.sentState === entry.latest.state) return;
    entry.sentState = entry.latest.state;
    entry.sentAt = this.clock.now();
    this.send(entry.room, entry.latest);
  }
}
