// A quiet point: each runner records how many of its agents are mid-turn
// (daemon activity/turnActivitySnapshot.ts). `raft-computer status --json`
// reports the sum, so Raft Desktop's Stop (and its move from an embedded
// Computer to the official install) can wait until no agent turn is cut off.
import { readFile } from "node:fs/promises";

import { isProcessAlive } from "./internal/process-primitives";
import { listManagedServerIds } from "./serverState";
import { serverActivityPath } from "./paths";

export interface MachineTurnActivity {
  /** Sum over servers whose runner is alive; a dead runner has no turn running. */
  activeTurns: number;
  /** Servers whose activity is unknown (no snapshot yet, unreadable). */
  unknownServerIds: string[];
  servers: Array<{ serverId: string; activeTurns: number | null; updatedAt: string | null }>;
}

export async function readMachineTurnActivity(
  slockHome: string,
  deps: { listServerIds?: (home: string) => Promise<string[]>; isAlive?: (pid: number) => boolean } = {},
): Promise<MachineTurnActivity> {
  const serverIds = await (deps.listServerIds ?? listManagedServerIds)(slockHome);
  const alive = deps.isAlive ?? isProcessAlive;
  const servers: MachineTurnActivity["servers"] = [];
  for (const serverId of serverIds) {
    try {
      const raw = JSON.parse(await readFile(serverActivityPath(slockHome, serverId), "utf8")) as {
        formatVersion?: unknown; activeTurns?: unknown; pid?: unknown; updatedAt?: unknown;
      };
      if (raw.formatVersion !== 1 || !Number.isSafeInteger(raw.activeTurns) || !Number.isSafeInteger(raw.pid)) throw new Error("invalid");
      const activeTurns = alive(raw.pid as number) ? (raw.activeTurns as number) : 0;
      servers.push({ serverId, activeTurns, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null });
    } catch {
      servers.push({ serverId, activeTurns: null, updatedAt: null });
    }
  }
  return {
    activeTurns: servers.reduce((sum, server) => sum + (server.activeTurns ?? 0), 0),
    unknownServerIds: servers.filter((server) => server.activeTurns === null).map((server) => server.serverId),
    servers,
  };
}
