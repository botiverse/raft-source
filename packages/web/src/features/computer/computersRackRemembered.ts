import { useEffect, useMemo } from "react";
import { readSidebarComputerRowCount } from "../../components/layout/sidebarSectionRowCounts";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { accessTokenSubject } from "../../utils/hostAccessTokenSync";
import { readRackUsageTwoLines } from "../../components/machine/rack/rackUsageLines";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";

// What the Computers page drew the last time its list loaded on a server, so
// while the list loads again it draws the same and the loaded page lands in
// place (skeleton-vs-loaded audit of the Computers page): the rack's computer
// rows or cards (`rows`), and the lines of the attention summary above it
// (`attentionLines`, 0 to 2). One entry per (user, server, part):
// `slock:computersRack:{userId}:{serverId}:{part}`. Counts only, never names.
// Desktop only: the phone's panel draws its own skeleton from the sidebar's count.

export type ComputersRackRememberedPart = "rows" | "attentionLines";

const STORAGE_PREFIX = "slock:computersRack";
/** About a screenful of cards or list rows: the rest is below the fold. */
export const RACK_PLACEHOLDER_MAX = 12;
/** Rows drawn when this server's rack has never loaded here (nor its sidebar rail). */
export const RACK_PLACEHOLDER_DEFAULT = 4;

type RememberedStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): RememberedStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function computersRackRememberedKey(userId: string, serverId: string, part: ComputersRackRememberedPart): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(serverId)}:${part}`;
}

function clampCount(count: number): number {
  return Math.min(Math.max(Math.floor(count), 0), RACK_PLACEHOLDER_MAX);
}

/** The remembered count; null when never loaded here (or unreadable). */
export function readComputersRackRemembered(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  part: ComputersRackRememberedPart,
  storage: RememberedStorage | undefined = defaultStorage(),
): number | null {
  if (!userId || !serverId || !storage) return null;
  try {
    const stored = storage.getItem(computersRackRememberedKey(userId, serverId, part));
    const count = stored === null ? NaN : Number(stored);
    return Number.isFinite(count) ? clampCount(count) : null;
  } catch {
    return null;
  }
}

export function writeComputersRackRemembered(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  part: ComputersRackRememberedPart,
  count: number,
  storage: RememberedStorage | undefined = defaultStorage(),
): void {
  if (!userId || !serverId || !storage) return;
  const key = computersRackRememberedKey(userId, serverId, part);
  const value = String(clampCount(count));
  try {
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/**
 * The placeholders a loading rack draws: as many rows as it drew last time,
 * else as many as the sidebar's Computers rail held (every computer, so at
 * most a screenful), else RACK_PLACEHOLDER_DEFAULT.
 */
export function rackPlaceholderRows(remembered: number | null, sidebarRows: number | null): number {
  return remembered ?? Math.min(sidebarRows ?? RACK_PLACEHOLDER_DEFAULT, RACK_PLACEHOLDER_MAX);
}

/** Keyed like the sidebar's remembered counts: by the stored token's person before /auth/me answers. */
function useRememberedKey() {
  const userId = useAuthStore((s) => s.user?.id ?? accessTokenSubject(s.accessToken));
  const serverId = useServerStore((s) => s.current?.id);
  return { userId, serverId };
}

/** This server's remembered count of `part` (null: never loaded here), read once per person and server. */
export function useComputersRackRemembered(part: ComputersRackRememberedPart): number | null {
  const { userId, serverId } = useRememberedKey();
  return useMemo(() => readComputersRackRemembered(userId, serverId, part), [userId, serverId, part]);
}

/** How many placeholder rows or cards the rack draws while its computers load. */
export function useRackPlaceholderRows(): number {
  const { userId, serverId } = useRememberedKey();
  return useMemo(
    () => rackPlaceholderRows(readComputersRackRemembered(userId, serverId, "rows"), readSidebarComputerRowCount(userId, serverId)),
    [userId, serverId],
  );
}

/**
 * Remembers what the page drew for next time: `count` once the list has
 * loaded (null while it loads or failed, which say nothing about it).
 */
export function useRememberComputersRack(part: ComputersRackRememberedPart, count: number | null): void {
  const { userId, serverId } = useRememberedKey();
  useEffect(() => {
    if (count === null) return;
    writeComputersRackRemembered(userId, serverId, part, count);
  }, [count, part, serverId, userId]);
}

/**
 * A card's shape for its placeholder: how many usage lines it drew, whether it
 * had the Other runtimes line, or that it was an offline card (no meters).
 * Stored per (user, server) as one short string, in the cards' order:
 * "3+,2^,x" = three usage lines and Other runtimes; two lines, one of them
 * leading the meters (the list sorted by it: a second divider); offline.
 * ".1" after a shape: that many of its usage lines also had a model line
 * (rackUsageLines, the same memory the usage cells read).
 */
export type RackCardShape = { usageLines: number; modelLines: number; leadUsage: boolean; otherRuntimes: boolean; offline: boolean };

const CARD_SHAPE_MAX_LINES = 8;

export function encodeRackCardShapes(shapes: readonly RackCardShape[]): string {
  return shapes.slice(0, RACK_PLACEHOLDER_MAX).map((shape) => (
    shape.offline ? "x" : `${Math.min(Math.max(shape.usageLines, 0), CARD_SHAPE_MAX_LINES)}${shape.leadUsage && shape.usageLines > 0 ? "^" : ""}${shape.otherRuntimes ? "+" : ""}${shape.modelLines > 0 ? `.${Math.min(shape.modelLines, shape.usageLines)}` : ""}`
  )).join(",");
}

export function decodeRackCardShapes(stored: string | null): RackCardShape[] | null {
  if (!stored) return null;
  const shapes: RackCardShape[] = [];
  for (const part of stored.split(",").slice(0, RACK_PLACEHOLDER_MAX)) {
    if (part === "x") {
      shapes.push({ usageLines: 0, modelLines: 0, leadUsage: false, otherRuntimes: false, offline: true });
      continue;
    }
    const match = /^(\d)(\^?)(\+?)(?:\.(\d))?$/.exec(part);
    if (!match) return null;
    const usageLines = Math.min(Number(match[1]), CARD_SHAPE_MAX_LINES);
    shapes.push({ usageLines, modelLines: Math.min(Number(match[4] ?? 0), usageLines), leadUsage: match[2] === "^" && usageLines > 0, otherRuntimes: match[3] === "+", offline: false });
  }
  return shapes;
}

function cardShapesKey(userId: string, serverId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(serverId)}:cards`;
}

/** The cards' shapes as drawn last time on this server; null when never drawn here (or unreadable). */
export function useRackPlaceholderCardShapes(): RackCardShape[] | null {
  const { userId, serverId } = useRememberedKey();
  return useMemo(() => {
    const storage = defaultStorage();
    if (!userId || !serverId || !storage) return null;
    try {
      return decodeRackCardShapes(storage.getItem(cardShapesKey(userId, serverId)));
    } catch {
      return null;
    }
  }, [userId, serverId]);
}

function writeRackCardShapes(userId: string | null | undefined, serverId: string | null | undefined, shapes: string): void {
  const storage = defaultStorage();
  if (!userId || !serverId || !storage) return;
  const key = cardShapesKey(userId, serverId);
  try {
    if (storage.getItem(key) !== shapes) storage.setItem(key, shapes);
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/** A drawn card: its shape but the model lines, and the usage providers whose last answer decides those. */
export type DrawnRackCard = { shape: Omit<RackCardShape, "modelLines">; machineId: string; usageProviders: readonly RuntimeAccountUsageProvider[] };

/**
 * Remembers the drawn cards' shapes (null while loading or not drawn as it
 * opens). Written after the cells' own effects, so a usage line's "two lines"
 * (rackUsageLines) is the one they just wrote; `usageAnswers` changes as their
 * answers land and writes it again.
 */
export function useRememberRackCardShapes(cards: readonly DrawnRackCard[] | null, usageAnswers: unknown): void {
  const { userId, serverId } = useRememberedKey();
  useEffect(() => {
    if (cards === null || !serverId) return;
    const shapes = cards.map(({ shape, machineId, usageProviders }) => ({
      ...shape,
      modelLines: shape.offline ? 0 : usageProviders.filter((provider) => readRackUsageTwoLines(serverId, machineId, provider)).length,
    }));
    writeRackCardShapes(userId, serverId, encodeRackCardShapes(shapes));
  }, [cards, serverId, usageAnswers, userId]);
}
