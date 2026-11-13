import { effectiveRaftTheme, isRaftThemeId } from "@botiverse/raft-shared";
import type { RaftThemeId } from "@botiverse/raft-shared";
import { refreshSystemBarColor } from "./systemBarColor";

/**
 * Each member picks a Raft theme per server (design/foundations/themes.md).
 * The light/dark mode stays the device's (AppThemeProvider); the theme is a
 * second axis on the same element: `data-theme="<id>"` next to the `.light` /
 * `.dark` class on <html>, and `data-theme-decor="off"` when the member turned
 * the frame's pixel art off. Raft Yellow is the foundation itself: no attribute.
 *
 * Each server's last effective look is kept on this device, so a server that
 * becomes current (or the page that reloads into it) shows its own frame at
 * once, before its record arrives, never the previous server's.
 */

export const SERVER_THEME_STORAGE_PREFIX = "raft:server-theme:v1:";

export interface ServerThemeLook {
  theme: RaftThemeId;
  decor: boolean;
}

/** The fields of a server record this reads (GET /api/servers). */
export interface ServerThemeSource {
  id: string;
  slug?: string;
  plan?: string;
  theme?: RaftThemeId | null;
  themeDecor?: boolean;
}

export const RAFT_LOOK: ServerThemeLook = { theme: "raft", decor: true };

/** The themes whose series draws pixel art on the frame (shared, so the server reads it the same way). */
export { raftThemeHasDecor } from "@botiverse/raft-shared";

function isFreePlan(plan: string | null | undefined): boolean {
  return !plan || plan === "free";
}

/**
 * What the member sees on this server, or null while the record does not
 * carry the theme yet (an older server, or a record built locally).
 * `plan` is the freshest reading of the server's plan (billing first).
 */
export function serverThemeLook(server: ServerThemeSource, plan?: string | null): ServerThemeLook | null {
  if (server.theme === undefined) return null;
  return {
    theme: effectiveRaftTheme(server.theme, isFreePlan(plan || server.plan)),
    decor: server.themeDecor !== false,
  };
}

function storage(): Storage | null {
  try {
    const value = globalThis.localStorage;
    return value && typeof value.getItem === "function" ? value : null;
  } catch {
    return null;
  }
}

function parseLook(raw: string | null): (ServerThemeLook & { slug?: string }) | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { theme?: unknown; decor?: unknown; slug?: unknown };
    if (!isRaftThemeId(value?.theme)) return null;
    return {
      theme: value.theme,
      decor: value.decor !== false,
      ...(typeof value.slug === "string" ? { slug: value.slug } : {}),
    };
  } catch {
    return null;
  }
}

export function readCachedServerTheme(serverId: string): ServerThemeLook | null {
  try {
    const look = parseLook(storage()?.getItem(`${SERVER_THEME_STORAGE_PREFIX}${serverId}`) ?? null);
    return look ? { theme: look.theme, decor: look.decor } : null;
  } catch {
    return null;
  }
}

/** A server this person no longer belongs to keeps no look: its public page must not wear their old theme. */
export function forgetCachedServerTheme(serverId: string): void {
  try {
    storage()?.removeItem(`${SERVER_THEME_STORAGE_PREFIX}${serverId}`);
  } catch {
    // Storage unavailable: nothing to forget.
  }
}

export function writeCachedServerTheme(serverId: string, look: ServerThemeLook, slug?: string): void {
  try {
    storage()?.setItem(
      `${SERVER_THEME_STORAGE_PREFIX}${serverId}`,
      JSON.stringify({ theme: look.theme, decor: look.decor, ...(slug ? { slug } : {}) }),
    );
  } catch {
    // A full or blocked storage only costs the next visit's first frame.
  }
}

/** The cached look of the server with this slug, for the first paint. */
function readCachedServerThemeBySlug(slug: string): ServerThemeLook | null {
  const store = storage();
  if (!store) return null;
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key?.startsWith(SERVER_THEME_STORAGE_PREFIX)) continue;
      const look = parseLook(store.getItem(key));
      if (look?.slug === slug) return { theme: look.theme, decor: look.decor };
    }
  } catch {
    return null;
  }
  return null;
}

/** Puts a look on <html>; Raft Yellow with its decorations on is no attribute at all. */
export function applyRootServerTheme(look: ServerThemeLook | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = look?.theme ?? "raft";
  if (theme === "raft") delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (look && !look.decor) root.dataset.themeDecor = "off";
  else delete root.dataset.themeDecor;
  refreshSystemBarColor();
}

/**
 * Before the first render: the cached look of the server the URL opens, so a
 * reload never flashes Raft Yellow before its record loads. Only on a server's
 * own route: sign-in, invite and verification pages stay Raft Yellow even when
 * a last-visited server is remembered.
 */
export function applyBootServerTheme(pathname: string): void {
  const match = /^\/s\/([^/?#]+)/.exec(pathname);
  if (!match) return;
  const slug = decodeURIComponent(match[1]);
  const look = readCachedServerThemeBySlug(slug);
  if (look) applyRootServerTheme(look);
}

interface ServerThemeStoreState {
  current: (ServerThemeSource & { slug: string }) | null;
  billing: { plan?: string } | null;
  servers?: ReadonlyArray<{ id: string }>;
}

interface ServerThemeStore {
  getState: () => ServerThemeStoreState;
  subscribe: (listener: (state: ServerThemeStoreState, previous: ServerThemeStoreState) => void) => () => void;
}

/**
 * Keeps <html> on the current server's look. Runs inside the store update
 * that makes a server current, before React renders it: the cached look first,
 * then the record's own once it carries one (which refreshes the cache).
 */
export function syncServerTheme(state: ServerThemeStoreState, previous: ServerThemeStoreState | null): void {
  const current = state.current;
  if (!current) {
    if (previous?.current) applyRootServerTheme(null);
    return;
  }
  const look = serverThemeLook(current, state.billing?.plan);
  if (look) {
    applyRootServerTheme(look);
    writeCachedServerTheme(current.id, look, current.slug);
    return;
  }
  if (previous?.current?.id !== current.id) applyRootServerTheme(readCachedServerTheme(current.id));
}

export function installServerThemeSync(store: ServerThemeStore): () => void {
  syncServerTheme(store.getState(), null);
  return store.subscribe((state, previous) => {
    // Left, deleted or removed: forget that server's look.
    if (state.servers && previous.servers && state.servers !== previous.servers) {
      const kept = new Set(state.servers.map((server) => server.id));
      for (const server of previous.servers) if (!kept.has(server.id)) forgetCachedServerTheme(server.id);
    }
    if (
      state.current === previous.current
      && state.billing?.plan === previous.billing?.plan
    ) return;
    syncServerTheme(state, previous);
  });
}
