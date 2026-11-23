import type { Channel } from "../../store/channelStore";

// The destination catalog (buildSearchEntityEntries) reads a handful of fields
// per channel / DM row. Selecting whole `channels` / `dmChannels` rebuilt and
// re-sorted it on every channel patch — unread counts, member counts, a socket
// flood of `channel:updated` (#532) — though no field it reads had changed.
// These selectors give a store subscription a projection that keeps its
// identity until one of those fields does.

export type CatalogChannel = Pick<Channel, "id" | "type" | "name" | "description" | "archivedAt">;
export type CatalogDmChannel = Pick<Channel, "id" | "peerType" | "peerId">;

function sameRows<P extends object>(previous: readonly P[], next: readonly P[], keys: readonly (keyof P)[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (keys.some((key) => !Object.is(before[key], after[key]))) return false;
  }
  return true;
}

/**
 * A selector projecting a row list onto `keys`, remembering its last answer:
 * the same input list, or one whose rows agree on every key, returns the
 * previous projection (same reference), so a subscriber does not re-render.
 */
function stableProjection<T extends object, K extends keyof T>(keys: readonly K[]): (rows: readonly T[]) => readonly Pick<T, K>[] {
  let lastInput: readonly T[] | null = null;
  let lastOutput: readonly Pick<T, K>[] = [];
  return (rows) => {
    if (rows === lastInput) return lastOutput;
    const projected = rows.map((row) => {
      const picked = {} as Pick<T, K>;
      for (const key of keys) picked[key] = row[key];
      return picked;
    });
    lastInput = rows;
    if (!sameRows(lastOutput, projected, keys)) lastOutput = projected;
    return lastOutput;
  };
}

export const selectCatalogChannels: (channels: readonly Channel[]) => readonly CatalogChannel[] =
  stableProjection<Channel, keyof CatalogChannel>(["id", "type", "name", "description", "archivedAt"]);

export const selectCatalogDmChannels: (dmChannels: readonly Channel[]) => readonly CatalogDmChannel[] =
  stableProjection<Channel, keyof CatalogDmChannel>(["id", "peerType", "peerId"]);
