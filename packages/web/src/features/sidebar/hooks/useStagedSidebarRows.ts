import { startTransition, useEffect, useState } from "react";

/**
 * How many rows each sidebar section mounts in the first render after a
 * server opens: about two screens of rows. A server with hundreds of channels
 * mounted every row in one task when it was opened, 89–120ms on staging at
 * 300 channels, and unmounted them all again when you left it, 116–201ms
 * (InNOut, #proj-frontend:57f32c96). The rest mount right after, in a
 * transition the browser can interrupt, so the sidebar is on screen first
 * and the long task is split.
 */
export const STAGED_SIDEBAR_ROWS = 40;

/**
 * The row limit for each section: `STAGED_SIDEBAR_ROWS` on the first render
 * for a server, then `Infinity` from the next frame on. Changing server stages
 * again. Every row id stays in the drag-and-drop lists; only the rendering is
 * staged.
 */
export function useStagedSidebarRows(serverId: string | null | undefined): number {
  const [staged, setStaged] = useState({ serverId, done: false });
  if (staged.serverId !== serverId) setStaged({ serverId, done: false });
  const done = staged.serverId === serverId && staged.done;

  useEffect(() => {
    if (done) return;
    const frame = window.requestAnimationFrame(() => {
      startTransition(() => {
        setStaged((current) => (current.serverId === serverId ? { serverId, done: true } : current));
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [done, serverId]);

  return done ? Infinity : STAGED_SIDEBAR_ROWS;
}

/** The first `limit` ids, or the same array when it already fits (so memoized children keep their props). */
export function stagedRowIds<T>(ids: readonly T[], limit: number): readonly T[] {
  return ids.length > limit ? ids.slice(0, limit) : ids;
}
