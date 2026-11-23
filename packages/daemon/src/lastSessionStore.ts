import { rmSync } from "node:fs";
import { agentStateFile, readPlainSmallFile, writeAgentStateText } from "./agentStateFiles";

const FILE_NAME = "last-session.json";
const MAX_BYTES = 8 * 1024;

export interface LastSessionRecord {
  runtime: string;
  sessionId: string;
  updatedAtMs: number;
}

/**
 * #proj-runtime:#80: remembers the last committed `(runtime, sessionId)` per
 * agent in `<agentsDir>/.agent-state/<agentId>/last-session.json` (outside the
 * workspace so a sandboxed runtime cannot redirect writes via symlinks).
 *
 * Read on non-resume fresh starts (model switch, runtime switch, manual
 * session reset) so `buildFreshConstructedInit` can locate a prior readable
 * transcript (e.g. Claude JSONL) even after the server cleared `sessionId` or
 * the agent switched runtimes across hosts. Cleared on full workspace reset.
 */
export class LastSessionStore {
  constructor(private readonly agentsDir: string, private readonly now: () => number = Date.now) {}

  read(agentId: string): LastSessionRecord | null {
    let raw: string | null;
    try {
      raw = readPlainSmallFile(agentStateFile(this.agentsDir, agentId, FILE_NAME), MAX_BYTES);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.runtime !== "string" || !parsed.runtime) return null;
      if (typeof parsed.sessionId !== "string" || !parsed.sessionId) return null;
      const updatedAtMs = typeof parsed.updatedAtMs === "number" && Number.isFinite(parsed.updatedAtMs) ? parsed.updatedAtMs : 0;
      return { runtime: parsed.runtime, sessionId: parsed.sessionId, updatedAtMs };
    } catch {
      return null;
    }
  }

  write(agentId: string, runtime: string | null | undefined, sessionId: string | null | undefined): void {
    if (!runtime || !sessionId) return;
    try {
      const record: LastSessionRecord = { runtime, sessionId, updatedAtMs: this.now() };
      writeAgentStateText(agentStateFile(this.agentsDir, agentId, FILE_NAME), `${JSON.stringify(record)}\n`);
    } catch {
      // Best-effort continuity hint; never blocks a session commit.
    }
  }

  delete(agentId: string): void {
    try {
      rmSync(agentStateFile(this.agentsDir, agentId, FILE_NAME), { force: true });
    } catch {
      // Best-effort cleanup on full workspace reset.
    }
  }
}
