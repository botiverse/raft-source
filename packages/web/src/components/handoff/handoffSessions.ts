import { isElectronDesktopShell } from "../../utils/desktopShell";
import { getDesktopBridge } from "../../utils/desktopBridge";
import { correlateSelfMachine } from "../machine/localComputer/localComputerLogic";
import type { LocalMachineIdentity } from "../machine/localComputer/localComputerLogic";

// Desktop-only Handoff (#kabi-desktop task #13 → task #104): recent LOCAL
// Claude Code / Codex sessions read through the electron bridge, migrated into a
// normal Raft agent (existing createAgent API + a previewed briefing DM). This
// module holds the bridge access and the pure helpers; the UI lives in
// HandoffCreateFlow (rendered inside Create Agent as the "start from a local
// session" option since task #104 — the standalone rail page is gone).

export interface LocalSession {
  tool: "claude-code" | "codex";
  sessionId: string;
  cwd: string | null;
  model: string | null;
  title: string | null;
  lastActiveAt: number;
  sizeBytes: number;
  transcriptPath: string;
  activeRecently: boolean;
}

export interface SessionExcerpt {
  firstUserMessage: string | null;
  recentExcerpt: string;
}

export interface ContentSearchResult {
  // Full summaries (not ids): a hit may live outside the recency-bounded initial
  // listing, so the flow renders these directly rather than filtering the list.
  matches: LocalSession[];
  complete: boolean;
}

export interface HandoffBridge {
  listSessions(): Promise<LocalSession[]>;
  sessionExcerpt(input: { transcriptPath: string; tool: string }): Promise<SessionExcerpt>;
  /**
   * Full-content search over transcript bodies (id + directory + model + title +
   * body, all query terms must match somewhere). Optional: an older desktop
   * bridge without it degrades to metadata-only search.
   */
  searchContent?(query: string): Promise<ContentSearchResult>;
}

export function getHandoffBridge(): HandoffBridge | null {
  // Runtime narrowing, not just a type assertion: the preload owns this shape,
  // but a stale/foreign global must not crash the flow.
  const handoff: unknown = getDesktopBridge()?.handoff;
  if (!handoff || typeof handoff !== "object") return null;
  const candidate = handoff as Partial<HandoffBridge>;
  if (typeof candidate.listSessions !== "function" || typeof candidate.sessionExcerpt !== "function") return null;
  return candidate as HandoffBridge;
}

/**
 * Whether Create Agent may offer "start from a local session": the desktop
 * shell AND a bridge that can scan sessions. Web is always false.
 */
export function isHandoffAvailable(): boolean {
  return isElectronDesktopShell() && getHandoffBridge() !== null;
}

export type SearchState =
  | { status: "idle" }
  | { status: "pending"; query: string }
  | { status: "done"; query: string; summaries: LocalSession[]; complete: boolean };

export type SearchAction =
  | { type: "reset" }
  | { type: "pending"; query: string }
  | { type: "done"; query: string; summaries: LocalSession[]; complete: boolean };

export function searchReducer(_state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "reset": return { status: "idle" };
    case "pending": return { status: "pending", query: action.query };
    case "done": return { status: "done", query: action.query, summaries: action.summaries, complete: action.complete };
  }
}

export type LocalIdentity = LocalMachineIdentity;

export interface MachineLike {
  id: string;
  hostname: string | null;
  status: "online" | "offline";
  computerAttachedByCurrentUser?: boolean;
}

/**
 * The machineStore row this app runs on, ONLINE only: the same match as the
 * Computers list's "This device" (correlateSelfMachine — the attachment's
 * machineId; a hostname only while no attachment names an id, for a row the
 * current user attached, matching exactly one such row — so a handoff never
 * routes to another computer).
 */
export function pickLocalOnlineMachine<T extends MachineLike>(
  machines: readonly T[],
  identity: LocalIdentity,
): T | null {
  const match = correlateSelfMachine(machines, identity);
  return match?.status === "online" ? match : null;
}

export const TOOL_LABEL: Record<LocalSession["tool"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function dirBasename(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}
