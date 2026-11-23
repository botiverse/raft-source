import type { DesktopWebPreviewMediaKind, DesktopWebPreviewTabListBridge } from "@botiverse/raft-shared";
import { create } from "zustand";

/**
 * What the built-in browser's kept pages of each conversation the window is
 * not on are doing (Raft Desktop, a shell with `tabs.list.onInUse`): a page
 * uses the microphone or the camera (`media`), plays sound (`audible`), or
 * plays and the person muted it (`muted`, only where none is heard). The
 * sidebar marks that conversation's row with it (SidebarBrowserInUseMark).
 *
 * The shell sends the whole summary after each change (and on every `get`
 * and `present`); mirrorBrowserTabsList feeds it here for the mirror's life
 * and empties it when the mirror ends (a sign-out, another account). Each
 * conversation's object stays the same while what it says does (the rows are
 * memo'd). A web in a normal browser never has any.
 *
 * The other way, the sidebar says which conversations it can mark now
 * (`markable`: the ones with a row in the sidebar on screen, in a folded
 * section too); mirrorBrowserTabsList hands each new list to the shell
 * (`list.setMarkable`), which keeps a page using a device only for those.
 */
export interface BrowserInUse {
  media: readonly DesktopWebPreviewMediaKind[];
  audible: boolean;
  muted: boolean;
}

interface BrowserInUseState {
  /** By conversation; only the ones whose kept pages do something. */
  byOwner: Readonly<Record<string, BrowserInUse>>;
  /** The conversations the sidebar on screen has a row for, sorted; null: it has not said yet (loading). */
  markable: readonly string[] | null;
}

export const useBrowserInUseStore = create<BrowserInUseState>(() => ({ byOwner: {}, markable: null }));

const NONE: Readonly<Record<string, BrowserInUse>> = {};
/** The devices, in the order the mark names them (browserTabsStore's browserMediaKinds: that module feeds this one). */
const MEDIA_KINDS: readonly DesktopWebPreviewMediaKind[] = ["microphone", "camera"];

function sameUse(a: BrowserInUse | undefined, b: BrowserInUse): boolean {
  return a !== undefined && a.audible === b.audible && a.muted === b.muted && a.media.join() === b.media.join();
}

/**
 * The shell's summary (DesktopWebPreviewInUse[]) as the store keeps it, checked: a conversation whose pages do
 * nothing has no entry; one with sound heard is not also muted. `previous` itself where nothing changed, and each
 * unchanged conversation's object from it.
 */
export function browserInUseByOwner(value: unknown, previous: Readonly<Record<string, BrowserInUse>>): Readonly<Record<string, BrowserInUse>> {
  const next: Record<string, BrowserInUse> = {};
  for (const each of Array.isArray(value) ? value : []) {
    if (!each || typeof each !== "object") continue;
    const { owner, audible, muted, media } = each as Record<string, unknown>;
    if (typeof owner !== "string" || owner === "") continue;
    const use: BrowserInUse = { media: Array.isArray(media) ? MEDIA_KINDS.filter((kind) => media.includes(kind)) : [], audible: audible === true, muted: muted === true && audible !== true };
    if (use.media.length === 0 && !use.audible && !use.muted) continue;
    const was = previous[owner];
    next[owner] = sameUse(was, use) ? was! : use;
  }
  const owners = Object.keys(next);
  if (owners.length === Object.keys(previous).length && owners.every((owner) => next[owner] === previous[owner])) return previous;
  return owners.length === 0 ? NONE : next;
}

/** The shell said what the kept pages do now. */
export function applyBrowserInUse(value: unknown): void {
  const previous = useBrowserInUseStore.getState().byOwner;
  const byOwner = browserInUseByOwner(value, previous);
  if (byOwner !== previous) useBrowserInUseStore.setState({ byOwner });
}

/** The mirror ended: no conversation's pages are known. */
export function clearBrowserInUse(): void {
  if (Object.keys(useBrowserInUseStore.getState().byOwner).length > 0) useBrowserInUseStore.setState({ byOwner: NONE });
}

/** The conversations the sidebar on screen can mark now (each once, any order): stored sorted, only when they change. */
export function setBrowserMarkable(conversationIds: Iterable<string>): void {
  const markable = [...new Set(conversationIds)].sort();
  const held = useBrowserInUseStore.getState().markable;
  if (held && held.length === markable.length && held.every((id, index) => id === markable[index])) return;
  useBrowserInUseStore.setState({ markable });
}

/** A new markable list waits this long for the next one (a burst of sidebar changes, a remount): only the last goes. */
export const BROWSER_MARKABLE_DELAY_MS = 250;

/**
 * Follows the shell's list bridge for one mirror (mirrorBrowserTabsList): what the kept pages do (`onInUse`, from
 * now), and the sidebar's markable list to the shell (`setMarkable`) once the list is had (`listHad`: the shell
 * starts a new account's from none) and after each change, the last of a burst, never while the sidebar has not
 * said. `end`: nothing more, and what the kept pages do is forgotten.
 */
export function followShellInUse(list: DesktopWebPreviewTabListBridge): { listHad(): void; end(): void } {
  let ended = false;
  let had = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The list the shell last got (joined); null: none yet. */
  let sent: string | null = null;
  const sendSoon = (): void => {
    if (ended || !had || !list.setMarkable) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const markable = useBrowserInUseStore.getState().markable;
      if (ended || markable === null || markable.join("\n") === sent) return;
      sent = markable.join("\n");
      list.setMarkable?.([...markable]);
    }, BROWSER_MARKABLE_DELAY_MS);
  };
  const unsubscribeInUse = list.onInUse?.((inUse) => {
    if (!ended) applyBrowserInUse(inUse);
  });
  const unsubscribeMarkable = useBrowserInUseStore.subscribe((state, before) => {
    if (state.markable !== before.markable) sendSoon();
  });
  return {
    listHad: () => {
      had = true;
      sendSoon();
    },
    end: () => {
      ended = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribeInUse?.();
      unsubscribeMarkable();
      clearBrowserInUse();
    },
  };
}
