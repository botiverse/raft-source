import { readFileSync, rmSync } from "node:fs";
import { agentStateFile, writeAgentStateText } from "./agentStateFiles";

/**
 * task #10 — consecutive terminal context-compaction failures of one runtime
 * session, kept on disk per agent so a daemon or computer restart does not
 * reset them.
 *
 * Pi summarizes a session in one request; once that request no longer fits
 * the model, every resume of the session fails compaction again, and every
 * automatic start resumes it (one agent failed 759 times in a week). After
 * SESSION_NEEDS_RESET_THRESHOLD failures in a row, starts refuse to resume
 * that session (`session_needs_reset`) until someone resets it. A successful
 * compaction clears the count; so does a different session id (Reset Session)
 * or a different model, which can change what fits.
 *
 * Stored in the daemon's agent state (`agentStateFiles.ts`), never the
 * workspace. The record holds ids, a model name and counts; never
 * conversation content.
 */
export const SESSION_NEEDS_RESET_THRESHOLD = 3;

interface LedgerRecord {
  version: 1;
  sessionId: string;
  model: string | null;
  count: number;
  updatedAtMs: number;
}

const FILE_NAME = "compaction-failures.json";

export class SessionCompactionFailureLedger {
  /** `agentsDir` holds one workspace directory per agent id. */
  constructor(private readonly agentsDir: string, private readonly now: () => number = Date.now) {}

  private file(agentId: string): string {
    return agentStateFile(this.agentsDir, agentId, FILE_NAME);
  }

  private read(agentId: string): LedgerRecord | null {
    try {
      const value = JSON.parse(readFileSync(this.file(agentId), "utf8")) as Partial<LedgerRecord>;
      if (value?.version !== 1 || typeof value.sessionId !== "string" || typeof value.count !== "number") return null;
      return {
        version: 1,
        sessionId: value.sessionId,
        model: typeof value.model === "string" ? value.model : null,
        count: value.count,
        updatedAtMs: typeof value.updatedAtMs === "number" ? value.updatedAtMs : 0,
      };
    } catch {
      return null;
    }
  }

  /** Counts one terminal compaction failure of `sessionId`; returns the consecutive count. */
  recordFailure(agentId: string, sessionId: string, model: string | null): number {
    const current = this.read(agentId);
    const same = current !== null && current.sessionId === sessionId && current.model === model;
    const record: LedgerRecord = {
      version: 1,
      sessionId,
      model,
      count: same ? current.count + 1 : 1,
      updatedAtMs: this.now(),
    };
    writeAgentStateText(this.file(agentId), JSON.stringify(record));
    return record.count;
  }

  /** A compaction succeeded: the session is healthy again. */
  clear(agentId: string): void {
    rmSync(this.file(agentId), { force: true });
  }

  /** The consecutive failure count when resuming `sessionId` with `model` must be refused, else null. */
  needsReset(agentId: string, sessionId: string, model: string | null): number | null {
    const current = this.read(agentId);
    if (!current || current.sessionId !== sessionId || current.model !== model) return null;
    return current.count >= SESSION_NEEDS_RESET_THRESHOLD ? current.count : null;
  }
}
