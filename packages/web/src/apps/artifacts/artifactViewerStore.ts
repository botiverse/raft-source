import { create } from "zustand";
import type { ArtifactCommentId } from "@botiverse/raft-shared";
import { focusLost } from "../../utils/focusGuard";
import { watchFocusIntent } from "../../utils/focusRequest";

import type { ArtifactOpenSource } from "./artifactAnalytics";
import type { ArtifactLinkTarget } from "./artifactLinks";

/**
 * Where an open Artifact shows (#proj-workspace:#104, Remy's opening rule:
 * every Artifact clicked inside Raft opens in the layout it was clicked in):
 *
 * - `conversationId`: beside a conversation's messages (F41: a Task v2 card
 *   in the channel's side column, above Tasks and Files). It belongs to the
 *   channel it was opened in, so moving to another channel leaves it behind.
 *   Opened from a thread, it goes to the channel's column and the thread
 *   stays where it is (behind the channel where it covered it).
 * - no conversation (`conversationId` null), `cover` null: the app shell's
 *   own place for it (ShellArtifactHost), beside whatever the main area
 *   shows without a channel panel: a thread Activity or Search opened, Saved,
 *   a legacy Files tab. Leaving that page closes it.
 * - no conversation, `cover` a dialog: over the dialog it was clicked in (a
 *   task's conversation), until that dialog closes.
 */
export type ArtifactPlace =
  | { conversationId: string; cover?: undefined }
  | { conversationId: null; cover: HTMLElement | null };

/**
 * The Artifact open in Raft, one at a time, where it was opened
 * (ArtifactPlace). `version` is the version it opened at; one picked in its
 * viewer since is the store's `picked`.
 *
 * `expanded` takes the whole workspace row, as the thread's Focus Mode does
 * (the channel, the thread, Tasks and Files step aside, unchanged, until it
 * collapses); a phone always covers. `openedAt` lets the column show it first where only one card fits.
 */
export type OpenArtifact = ArtifactLinkTarget & ArtifactPlace & {
  /** What it was opened from (the `artifact_opened` product event). */
  source: ArtifactOpenSource;
  /** Opened on its comments: the list opens (ArtifactCommentsProvider's `listOn`). */
  comments?: ArtifactCommentsOpening;
};

/**
 * An Artifact opened on its comments (xxchan, #proj-workspace:72934211): a
 * message card's comment count, or a card with comments new to the reader.
 * The list opens, on the thread of `at`, the first new comment (the card's
 * `unseen.firstNewComment`), when there is one. Each opening is its own
 * object: the same card clicked again opens the list again.
 */
export interface ArtifactCommentsOpening {
  at: ArtifactCommentId | null;
}

interface ArtifactViewerState {
  open: OpenArtifact | null;
  openedAt: number;
  expanded: boolean;
  /**
   * Where an open Artifact is the page's address (`?artifact=<id>`: MainLayout's
   * useArtifactViewerAddress), or null where none is: there the address's
   * history entry is the viewer's, so on a phone it pushes none of its own
   * (usePhoneHistoryEntry).
   */
  addressed: ArtifactAddressedPlaces | null;
  /**
   * The version picked in the viewer of this opening (its version history, Back to Latest, View latest; null:
   * the latest), or null while it shows the version it opened at. The viewer shows its pick itself; this is
   * for its address, whose `&version=` it replaces.
   */
  picked: { version: number | null } | null;
  openArtifact: (target: OpenArtifact) => void;
  /** A version picked in the viewer (null: the latest), in the same opening. */
  showVersion: (version: number | null) => void;
  close: () => void;
  setExpanded: (expanded: boolean) => void;
  setAddressed: (addressed: ArtifactAddressedPlaces | null) => void;
}

/**
 * The places whose open Artifact the page's address holds: the side card of
 * `conversationId` (the conversation the page shows), the shell's own card
 * (`shell`: no channel panel on the page), and the viewer over the dialog the
 * address opens (`dialog`: a task's, `?task=`).
 */
export interface ArtifactAddressedPlaces {
  conversationId: string | null;
  shell: boolean;
  dialog: boolean;
}

function samePlaces(a: ArtifactAddressedPlaces | null, b: ArtifactAddressedPlaces | null): boolean {
  return a === b || (!!a && !!b && a.conversationId === b.conversationId && a.shell === b.shell && a.dialog === b.dialog);
}

export const useArtifactViewerStore = create<ArtifactViewerState>((set) => ({
  open: null,
  openedAt: 0,
  expanded: false,
  addressed: null,
  picked: null,
  openArtifact: (open) => set({ open, openedAt: Date.now(), expanded: false, picked: null }),
  showVersion: (version) => set((state) => (state.open ? { picked: { version } } : state)),
  close: () => set({ open: null, expanded: false, picked: null }),
  setExpanded: (expanded) => set({ expanded }),
  setAddressed: (addressed) => set((state) => (samePlaces(state.addressed, addressed) ? state : { addressed })),
}));

/**
 * A panel covered by its own thread can bring itself forward for a click from
 * that thread (F41): true when it did, and the viewer opens there.
 */
export type RevealArtifactHost = (from: Element) => boolean;

interface ArtifactHost {
  conversationId: string;
  reveal?: RevealArtifactHost;
}

/**
 * The channel panels that can show the viewer right now. A panel registers its
 * body element while it is mounted with the flag on; whether it is on screen
 * is read at click time (a panel can be mounted but covered by a thread, a
 * task dialog or a phone page).
 */
const hosts = new Map<HTMLElement, ArtifactHost>();

export function registerArtifactHost(element: HTMLElement, conversationId: string, reveal?: RevealArtifactHost): () => void {
  const host = { conversationId, reveal };
  hosts.set(element, host);
  return () => {
    if (hosts.get(element) === host) hosts.delete(element);
  };
}

/** Is the element on screen and not covered (the topmost element at its center is inside it)? */
function isShown(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[inert], [aria-hidden='true']")) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof document.elementFromPoint !== "function") return true;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return !!hit && element.contains(hit);
}

/** How many app shells (ShellArtifactHost) are mounted: outside one (a public page, the Artifact's own page) a link is a link. */
let shells = 0;

/** The app shell can show an Artifact where no channel panel can (ShellArtifactHost), while mounted. */
export function registerArtifactShell(): () => void {
  shells += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    shells -= 1;
  };
}

/** Is what was clicked itself on screen in `panel` (the topmost element at its own center is inside the panel)? */
function reaches(from: Element, panel: HTMLElement): boolean {
  if (!panel.isConnected || panel.closest("[inert], [aria-hidden='true']")) return false;
  const rect = from.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof document.elementFromPoint !== "function") return true;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return !!hit && panel.contains(hit);
}

/**
 * The channel panel a click on `from` opens the viewer in: the one containing
 * it, else the one on screen, else one its thread covers that steps forward.
 * None from a dialog: the panel under it can't be seen.
 *
 * The panel containing the click counts when it is on screen (isShown: its
 * center isn't covered) or when what was clicked is (reaches). The second is
 * for a layer over the panel's center that has nothing to do with the click:
 * a link's own hover card or a toast there made the open fall to the shell's
 * place, which a channel page doesn't put in its address, so the viewer
 * closed at the page's next address change (#proj-workspace:#284).
 */
function findConversationHost(from: Element | null): string | null {
  const entries = [...hosts];
  const shown = entries.filter(([element]) => isShown(element));
  const containing = from ? entries.find(([element]) => element.contains(from) && (shown.some(([other]) => other === element) || reaches(from, element))) : undefined;
  if (containing) return containing[1].conversationId;
  if (from?.closest(DIALOG_SELECTOR)) return null;
  if (shown.length === 1) return shown[0]![1].conversationId;
  if (!from || shown.length > 0) return null;
  const revealed = entries.find(([, host]) => host.reveal?.(from) === true);
  return revealed ? revealed[1].conversationId : null;
}

/** A dialog (the task dialog's popup carries the role; its card is the DialogSurface inside). */
const DIALOG_SELECTOR = "[role='dialog'], [aria-modal='true']";

/**
 * Opens an Artifact over the dialog on screen (the topmost; its card, as a
 * click in it would), for an address that names one (a reload of
 * `?task=…&artifact=…`): at once where it is there, else once it appears (the
 * dialog loads after the address). Returns the cancel (the address changed
 * first); gives up after `timeoutMs`.
 */
export function openArtifactOverDialog(open: ArtifactLinkTarget & { source: ArtifactOpenSource }, timeoutMs = 15_000): () => void {
  const find = (): HTMLElement | null => {
    const dialogs = [...document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)].filter((element) => element.isConnected && !element.closest("[data-testid='artifact-cover']"));
    const dialog = dialogs.at(-1) ?? null;
    return dialog ? dialog.querySelector<HTMLElement>("[data-slot='dialog-surface']") ?? dialog : null;
  };
  const show = (cover: HTMLElement) => useArtifactViewerStore.getState().openArtifact({ ...open, conversationId: null, cover });
  const now = find();
  if (now) {
    show(now);
    return () => {};
  }
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(() => {
    const cover = find();
    if (!cover) return;
    stop();
    show(cover);
  });
  const timer = setTimeout(() => stop(), timeoutMs);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
  };
  observer.observe(document.body, { childList: true, subtree: true });
  return stop;
}

/** What a viewer opened in a dialog covers: the dialog's own card (raft-ui DialogSurface) where it has one, else the dialog. */
function coverOf(from: Element | null): HTMLElement | null {
  const dialog = from?.closest<HTMLElement>(DIALOG_SELECTOR) ?? null;
  const surface = from?.closest<HTMLElement>("[data-slot='dialog-surface']") ?? null;
  return surface && dialog?.contains(surface) ? surface : dialog;
}

/**
 * Where a click on `from` opens an Artifact (the opening rule, ArtifactPlace):
 * beside the channel panel it belongs to (findConversationHost); else beside
 * `conversationId`'s own messages where the opener has that place (the Files
 * card); else, in the app shell, over the dialog it is in or in the shell's
 * own place. Null only outside the app shell: the link is then followed.
 */
export function findArtifactPlace(from: Element | null, conversationId: string | null = null): ArtifactPlace | null {
  const conversation = findConversationHost(from) ?? conversationId;
  if (conversation) return { conversationId: conversation };
  if (shells === 0) return null;
  return { conversationId: null, cover: coverOf(from) };
}

/** Where focus goes back to when the viewer closes: the card that opened it. */
let returnFocusTo: HTMLElement | null = null;
/** The press that opened it, while still wanted (watchFocusIntent): the viewer's focus on mount is the person's then. */
let openIntent: (() => boolean) | null = null;

/** The person pressed `element` to open the viewer (null: forget it). */
export function setArtifactReturnFocus(element: HTMLElement | null): void {
  returnFocusTo = element;
  openIntent?.();
  openIntent = element ? watchFocusIntent() : null;
}

/**
 * Why the viewer (or its placeholder) takes focus as it mounts: `user` when the person's press opened it and they have
 * done nothing since (in a browser that focuses no pressed button, focus is still in the composer: it moves in); else
 * `mount`, which leaves focus in a text field or dialog the person went to while it loaded (focus plan rules 2, 3).
 * Asked once per open.
 */
export function artifactOpenFocusReason(): "user" | "mount" {
  const wanted = openIntent?.() ?? false;
  openIntent = null;
  return wanted ? "user" : "mount";
}

export function takeArtifactReturnFocus(): HTMLElement | null {
  const element = returnFocusTo;
  returnFocusTo = null;
  return element?.isConnected ? element : null;
}

/** Can focus go there: on screen, not inert, not inside something hidden (a thread that stepped behind its channel)? */
export function canTakeFocus(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest("[inert]")) return false;
  if (typeof element.checkVisibility === "function") return element.checkVisibility();
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/**
 * The channel panel body (a registered host) the element is in; else, for
 * the viewer in the channel's side area (outside the panel body, task #165),
 * the panel of the channel it is open in.
 */
export function artifactHostOf(element: Element | null, conversationId?: string | null): HTMLElement | null {
  if (element) for (const host of hosts.keys()) if (host.contains(element)) return host;
  if (conversationId == null) return null;
  for (const [host, entry] of hosts) if (entry.conversationId === conversationId) return host;
  return null;
}

/**
 * Focus after the viewer closes, only where it went with the viewer (focusLost: focus plan rule 4; the viewer closed
 * from outside, an address changed or Back, leaves focus the person put elsewhere where it is): the card that opened
 * it, where it can take focus; else, in the channel panel the viewer was in, the composer, or the side card left on top
 * where the composer is covered. Never nothing.
 */
export function returnArtifactFocus(host: HTMLElement | null): void {
  const opener = takeArtifactReturnFocus();
  // Asked for where it would go: opened over a dialog (the task dialog), the dialog's own popup holds focus once the
  // viewer is gone, nowhere for a card inside it, somewhere for anything behind it (rule 1).
  if (opener && canTakeFocus(opener) && focusLost(opener)) opener.focus();
  if (!focusLost(host)) return;
  if (!host?.isConnected) return;
  const fallback = [...host.querySelectorAll("textarea, [data-side-card-focus]")].find(canTakeFocus);
  fallback?.focus();
}
