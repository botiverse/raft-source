import { createContext } from "react";
import type { AgentReadStatusEntry } from "../../store/agentReadProgressDomain";

/** One agent's face on the timeline (agent_read_progress_v0). */
export interface AgentReadFace {
  agentId: string;
  name: string;
  avatarUrl: string | null;
  /** Typing in this conversation now: the face carries the busy light. */
  working: boolean;
}

/**
 * Where agents have read up to in one open conversation, for the rows of its
 * timeline (useAgentReadProgress builds it; ChatPanel and the thread panel
 * provide it around their MessageTimeline). Null: the feature is off here
 * (flag, DM, #all, joint, no hydrate, summary scope, no agent), and rows
 * render exactly as without it.
 */
export interface AgentReadProgressModel {
  scopeId: string;
  /** Faces per row before +N: 3, or 2 on a narrow width. */
  maxFaces: number;
  /** Row (message id) -> its faces, working agents first. */
  facesByMessageId: ReadonlyMap<string, readonly AgentReadFace[]>;
  /** The line under your latest message (B): the agents it will not reach, or null when it reaches all of them. */
  status: { messageId: string; entries: readonly AgentReadStatusEntry[] } | null;
  /** Every relevant agent by id (names for the B line). */
  agentsById: ReadonlyMap<string, AgentReadFace>;
}

export const AgentReadProgressContext = createContext<AgentReadProgressModel | null>(null);
