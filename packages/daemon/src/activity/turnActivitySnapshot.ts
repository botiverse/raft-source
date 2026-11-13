// How many of this runner's agents are mid-turn, as a tiny file the hosting
// Computer reads to find a quiet point (task #166: a Computer upgrade waits
// until no agent turn is running, so no turn is cut off).
//
// "Mid-turn" is the activity the daemon already broadcasts: an agent whose
// last activity is `working` or `thinking`. The file is rewritten only when
// the count changes, atomically (temp + rename), and carries this process's
// pid so a reader can ignore a snapshot left by a runner that has exited.
// Best effort: a failed write never affects the agents.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TURN_ACTIVITY_FORMAT_VERSION = 1;

export interface TurnActivitySnapshot {
  formatVersion: typeof TURN_ACTIVITY_FORMAT_VERSION;
  activeTurns: number;
  pid: number;
  updatedAt: string;
}

export class TurnActivitySnapshotWriter {
  private last: number | null = null;

  constructor(
    private readonly file: string | null | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly pid: number = process.pid,
  ) {}

  update(activeTurns: number): void {
    if (!this.file || this.last === activeTurns) return;
    const snapshot: TurnActivitySnapshot = {
      formatVersion: TURN_ACTIVITY_FORMAT_VERSION,
      activeTurns,
      pid: this.pid,
      updatedAt: this.now().toISOString(),
    };
    const temporary = `${this.file}.${this.pid}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.last = activeTurns;
    } catch {
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }
}
