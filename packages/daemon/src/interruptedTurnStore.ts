import { rmSync } from "node:fs";
import { agentStateFile, readPlainSmallFile, writeAgentStateText } from "./agentStateFiles";
import { RUNTIME_SPEC_COMPONENTS, type RuntimeSpecComponent, type RuntimeSpecDriftKind } from "./runtimeSpec";

const FILE_NAME = "interrupted-turn.json";
const MAX_BYTES = 4 * 1024;
const ALLOWED_DRIFT_COMPONENTS: ReadonlySet<string> = new Set<string>(RUNTIME_SPEC_COMPONENTS);

/**
 * #proj-runtime:#80: default TTL for an interrupted-turn handoff note.
 * Bounded so a stale record from a long-stopped agent never leaks into a much
 * later unrelated wake.
 */
export const DEFAULT_INTERRUPTED_TURN_TTL_MS = 10 * 60_000;

export interface InterruptedTurnRecord {
  interruptedAtMs: number;
  /** Non-secret RuntimeSpecComponent drift kinds (never env keys or values). */
  drift: RuntimeSpecComponent[];
}

/**
 * #proj-runtime:#80: remembers when an explicit runtime-config edit interrupted
 * an active foreground turn so the immediate replacement launch (fresh or
 * resumed) receives a brief one-shot note and continues where it left off
 * without waiting for a human poke.
 *
 * Stored in `<agentsDir>/.agent-state/<agentId>/interrupted-turn.json` (outside
 * the agent workspace, using symlink-refusing helpers matching `LastSessionStore`).
 * Contains ONLY non-secret `RuntimeSpecComponent` drift kinds and a timestamp.
 */
export class InterruptedTurnStore {
  constructor(
    private readonly agentsDir: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_INTERRUPTED_TURN_TTL_MS,
  ) {}

  write(agentId: string, drift: readonly RuntimeSpecDriftKind[]): void {
    const filtered: RuntimeSpecComponent[] = [];
    for (const kind of drift) {
      if (ALLOWED_DRIFT_COMPONENTS.has(kind) && !filtered.includes(kind as RuntimeSpecComponent)) {
        filtered.push(kind as RuntimeSpecComponent);
      }
    }
    try {
      const record: InterruptedTurnRecord = {
        interruptedAtMs: this.now(),
        drift: filtered,
      };
      writeAgentStateText(agentStateFile(this.agentsDir, agentId, FILE_NAME), `${JSON.stringify(record)}\n`);
    } catch {
      // Best-effort handoff hint; never blocks a config-driven stop.
    }
  }

  /** Non-destructive read: returns the record if fresh within TTL (clears expired/corrupt files). */
  read(agentId: string): InterruptedTurnRecord | null {
    const filePath = agentStateFile(this.agentsDir, agentId, FILE_NAME);
    let raw: string | null = null;
    try {
      raw = readPlainSmallFile(filePath, MAX_BYTES);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const interruptedAtMs = typeof parsed.interruptedAtMs === "number" && Number.isFinite(parsed.interruptedAtMs)
        ? parsed.interruptedAtMs
        : null;
      if (interruptedAtMs === null) {
        this.delete(agentId);
        return null;
      }
      const ageMs = this.now() - interruptedAtMs;
      if (ageMs < 0 || ageMs > this.ttlMs) {
        this.delete(agentId);
        return null;
      }
      const rawDrift = Array.isArray(parsed.drift) ? parsed.drift : [];
      const drift: RuntimeSpecComponent[] = [];
      for (const item of rawDrift) {
        if (typeof item === "string" && ALLOWED_DRIFT_COMPONENTS.has(item) && !drift.includes(item as RuntimeSpecComponent)) {
          drift.push(item as RuntimeSpecComponent);
        }
      }
      return { interruptedAtMs, drift };
    } catch {
      this.delete(agentId);
      return null;
    }
  }

  /** Consume once: returns the record if fresh within TTL, and always removes the file. */
  take(agentId: string): InterruptedTurnRecord | null {
    const record = this.read(agentId);
    this.delete(agentId);
    return record;
  }

  delete(agentId: string): void {
    try {
      rmSync(agentStateFile(this.agentsDir, agentId, FILE_NAME), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
