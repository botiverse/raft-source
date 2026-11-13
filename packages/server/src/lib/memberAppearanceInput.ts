// A member's own look in a server (theme, decorations), as
// `PATCH /api/servers/:id/appearance-settings` (routes/servers.ts) and the
// personal assistant's `PATCH /internal/agent-api/assistant/owner-settings`
// accept it: the same checks, the same messages, the same socket event.
import { isRaftThemeId, type RaftThemeId } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";

export type MemberAppearanceInput = { theme?: RaftThemeId; themeDecor?: boolean };

/**
 * Checks a theme and/or themeDecor from a request body (either may be absent).
 * A Pro theme is accepted on any plan: the server keeps it, and
 * effectiveRaftTheme shows it as Raft Yellow on Free.
 */
export function parseMemberAppearanceInput(rawTheme: unknown, rawDecor: unknown):
  { ok: true; input: MemberAppearanceInput } | { ok: false; error: string } {
  if (rawTheme !== undefined && !isRaftThemeId(rawTheme)) return { ok: false, error: "invalid_theme" };
  if (rawDecor !== undefined && typeof rawDecor !== "boolean") return { ok: false, error: "themeDecor must be a boolean" };
  return {
    ok: true,
    input: {
      ...(rawTheme !== undefined ? { theme: rawTheme as RaftThemeId } : {}),
      ...(rawDecor !== undefined ? { themeDecor: rawDecor as boolean } : {}),
    },
  };
}

/** The member's other tabs and devices follow without a reload. */
export function emitMemberAppearanceUpdated(
  io: SocketServer | undefined,
  userId: string,
  serverId: string,
  appearance: { theme: RaftThemeId | null; themeDecor: boolean },
): void {
  io?.to(`user:${userId}`).emit("appearance:updated", { serverId, ...appearance });
}
