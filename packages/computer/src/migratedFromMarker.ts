// `ready.migratedFrom` (shared COMPUTER_MIGRATED_FROM): Raft Desktop leaves
// `computer/migrated-from.json` (`{"from":"electron"}`) when it moves this
// home from its embedded Computer to the official install and the move
// reached its `start` step (not necessarily that it then succeeded). Each server's
// runner puts `migratedFrom: "electron"` on its first ready after that, so the
// server can count, in its ready trace, migrated machines that came back.
//
// Runners are separate processes, one per server: each records that it sent
// it (`servers/<id>/migrated-from.sent`, its own file, so no two runners write
// the same one), and whichever finds every attached server done deletes the
// note, then the per-server records. A note that is unreadable or says
// anything else is ignored (and left: it is Desktop's file).
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { isComputerMigratedFrom, type ComputerMigratedFrom } from "@botiverse/raft-shared";
import { migratedFromMarkerPath, serverMigratedFromSentPath } from "./paths";
import { listAttachedServerIds } from "./serverState";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * What this server's next ready should say: the note's `from`, unless this
 * server already had it. Its own record is read FIRST: the cleanup deletes
 * the note before the records, so a runner that already sent it can never
 * see the note while its record is already gone (a second report).
 */
export async function readMigratedFromForServer(
  slockHome: string,
  serverId: string,
  /** Tests: runs between the two reads (another runner's cleanup). */
  between?: () => Promise<void>,
): Promise<ComputerMigratedFrom | null> {
  const sent = await exists(serverMigratedFromSentPath(slockHome, serverId));
  await between?.();
  if (sent) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(migratedFromMarkerPath(slockHome), "utf8"));
  } catch {
    return null;
  }
  const from = (raw as { from?: unknown } | null)?.from;
  return isComputerMigratedFrom(from) ? from : null;
}

/** This server's ready carried it: never again here; the note goes once every attached server had it. */
export async function acknowledgeMigratedFrom(slockHome: string, serverId: string): Promise<void> {
  await writeFile(serverMigratedFromSentPath(slockHome, serverId), "", { mode: 0o600 });
  const attached = await listAttachedServerIds(slockHome);
  for (const id of attached) {
    if (!(await exists(serverMigratedFromSentPath(slockHome, id)))) return;
  }
  // The note first, then the records (readMigratedFromForServer reads in the other order).
  await rm(migratedFromMarkerPath(slockHome), { force: true });
  for (const id of new Set([...attached, serverId])) {
    await rm(serverMigratedFromSentPath(slockHome, id), { force: true });
  }
}
