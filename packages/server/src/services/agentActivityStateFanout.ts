// The coarse agent state for every member's tab (#proj-frontend:#8): sent to
// the agent's state room (agentActivityStateRoom: the server's capable room,
// or a personal assistant's owner) only when the coarse state (offline /
// online / busy / error) changes, and at most once per agent per interval. A
// change inside the interval is held and sent at its end, as the state it has
// then (nothing when it is back where it was). The detailed `agent:activity` goes
// to the agent's own room (agentActivityRoom) for the tabs that subscribe.
//
// "The state last sent" is this replica's memory only: while the agent's
// Computer was connected to another replica, that one sent the changes. So it
// is dropped when the agent's Computer connects or disconnects here
// (resetMachine), and a sent state older than SENT_STATE_TRUST_MS no longer
// holds back a send. Sending a state twice is harmless (clients order by
// serverSeq); holding back a real change leaves every tab on the old state.
import {
  AGENT_ACTIVITY_STATE_MIN_INTERVAL_MS,
  coarseAgentActivityState,
  type AgentActivityCoarseState,
  type AgentActivityStatePayload,
} from "@botiverse/raft-shared";

/** How long a state this replica sent is trusted to be what clients still show. */
export const SENT_STATE_TRUST_MS = 60_000;

interface StateFanoutClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface AgentEntry {
  room: string;
  machineId: string | null;
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
  observe(room: string, agentId: string, activity: string, timestamp: number, serverSeq: number, machineId: string | null = null): void {
    const latest: AgentActivityStatePayload = { agentId, state: coarseAgentActivityState(activity), activity, timestamp, serverSeq };
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = { room, machineId, latest, sentState: null, sentAt: null, timer: null };
      this.agents.set(agentId, entry);
    } else {
      entry.room = room;
      entry.machineId = machineId;
      entry.latest = latest;
    }
    if (entry.timer !== null) return;
    if (this.trustedSentState(entry) === latest.state) return;
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

  /**
   * The agents on `machineId` connected to or disconnected from this replica:
   * what this replica last sent for them no longer holds back a send (another
   * replica may have sent other states since). The interval and a held send stay.
   */
  resetMachine(machineId: string): void {
    for (const entry of this.agents.values()) {
      if (entry.machineId === machineId) entry.sentState = null;
    }
  }

  private trustedSentState(entry: AgentEntry): AgentActivityCoarseState | null {
    if (entry.sentAt === null || this.clock.now() - entry.sentAt >= SENT_STATE_TRUST_MS) return null;
    return entry.sentState;
  }

  private flush(entry: AgentEntry): void {
    if (this.trustedSentState(entry) === entry.latest.state) return;
    entry.sentState = entry.latest.state;
    entry.sentAt = this.clock.now();
    this.send(entry.room, entry.latest);
  }
}
