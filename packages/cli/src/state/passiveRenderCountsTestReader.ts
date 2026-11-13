// Test-only: read what `countPassiveRender` booked, as the daemon would take
// it at the turn end, and switch passive AX on for a test in a temp seat.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveStateDbPath } from "./agentLedger";

export function readPassiveRenderCountsForTest(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ contextId: string; kind: string; renders: number; chars: number; bytes: number }> {
  const dbPath = resolveStateDbPath(agentId, env);
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'passive_render_counts'").get()) return [];
    const rows = db.prepare("SELECT context_id, kind, renders, chars, bytes FROM passive_render_counts ORDER BY context_id, kind").all() as Array<{
      context_id: string;
      kind: string;
      renders: number;
      chars: number;
      bytes: number;
    }>;
    return rows.map((row) => ({ contextId: row.context_id, kind: row.kind, renders: row.renders, chars: row.chars, bytes: row.bytes }));
  } finally {
    db.close();
  }
}

/**
 * A temp ledger and a daemon context signal with passive AX on, in
 * `process.env`, for `fn`; the environment and the files are restored after.
 */
export async function withPassiveAxContextForTest(contextId: string, fn: () => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-passive-ax-"));
  const transportDir = path.join(root, "transport");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(transportDir, "context-generation"),
    JSON.stringify({ contextId, reason: "spawn", compactionReported: true, runtime: "claude", writtenAt: "t", passiveAx: true }),
    { mode: 0o600 },
  );
  const keys = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR"] as const;
  const prior = keys.map((key) => process.env[key]);
  process.env.SLOCK_CLI_STATE_DIR = path.join(root, "state");
  process.env.SLOCK_CLI_TRANSPORT_DIR = transportDir;
  try {
    await fn();
  } finally {
    keys.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
