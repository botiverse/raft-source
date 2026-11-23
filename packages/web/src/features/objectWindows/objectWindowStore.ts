// Object windows (#337): a platform object (an Artifact first) in a window of
// its own in Raft Desktop. The main window's web app opens an about:blank
// child window (`window.open("about:blank", "raft-object-window-<n>",
// "popup")`, which the shell allows and frames: apps/desktop
// main/objectWindows.ts), prepares its document here, and renders the object
// into it through a React portal (ObjectWindowsHost), so the window shares
// this page's login, live data and state. The child document has no bridge
// of its own: everything goes through the main window's (getDesktopBridge).
//
// Core knows no object: a kind (an app's) registers its render with
// registerObjectWindowKind, and opens windows of that kind with
// openObjectWindow. A plain open reuses the one reusable window (its object
// replaced, the window raised); an additional open (⌘-click, "Open in new
// window") opens another.

import type { ReactNode } from "react";
import { create } from "zustand";
import { installInputModality } from "@botiverse/raft-ui";
import { installLayerGuard } from "../../components/topbar/layerGuard";
import { getDesktopBridge } from "../../utils/desktopBridge";
import { addPageCompanionDocument } from "../../utils/visiblePoll";
import { installObjectWindowChrome, installObjectWindowFullScreen, installObjectWindowTitleBarReporting } from "./objectWindowChrome";
import { takeObjectWindowNavigationIntent } from "./objectWindowLinkRouting";
import { syncStyles } from "./syncStyles";

/** The frame name prefix the shell allows (apps/desktop main/objectWindows.ts OBJECT_WINDOW_NAME). */
export const OBJECT_WINDOW_NAME_PREFIX = "raft-object-window-";
/** At most this many open at once: the shell refuses more (MAX in main/objectWindows.ts). */
export const MAX_OBJECT_WINDOWS = 8;
/** The shell's name pattern allows 1 to 9999. */
const MAX_NAME_INDEX = 9999;
/** The element of the object window's body the object renders into. */
export const OBJECT_WINDOW_ROOT_ID = "object-window-root";
/**
 * When to look again whether a window just opened is still there: the shell
 * destroys one it refuses to adopt (apps/desktop: not opened by the main
 * window's own document), which fires no pagehide.
 */
export const OBJECT_WINDOW_ADOPTION_CHECKS_MS = [0, 250, 1_000] as const;

export interface ObjectWindowEntry {
  /** The window's frame name, `raft-object-window-<n>`: its id for the shell and here. */
  name: string;
  kind: string;
  payload: unknown;
  win: Window;
  doc: Document;
  /** The element in the window's body the object renders into. */
  root: HTMLElement;
  /** The element focus goes back to in the main window when this window closes (the row it was opened from). */
  openedFrom: WeakRef<Element> | null;
  /** Counts the times the object was replaced or reloaded: the host remounts the kind's render on a change. */
  revision: number;
}

export interface ObjectWindowRenderProps<P = unknown> {
  name: string;
  payload: P;
  /** Close this window (an object's own × or Esc). */
  close: () => void;
}

/** What a kind draws into its window, from its payload. */
export type ObjectWindowRender<P = unknown> = (props: ObjectWindowRenderProps<P>) => ReactNode;

export interface ObjectWindowKind<P = unknown> {
  render: ObjectWindowRender<P>;
  /**
   * Window › Open in Main Window (the shell's object-window command, openObjectWindowInMain): the kind shows its
   * object in the main window and raises it. Called with the window still open (it closes once this returns): read
   * what the window shows synchronously, here.
   */
  openInMain?: (payload: P) => void;
}

interface ObjectWindowState {
  windows: ReadonlyMap<string, ObjectWindowEntry>;
  /** The window a plain open reuses, or null. */
  reusable: string | null;
  kinds: ReadonlyMap<string, ObjectWindowKind>;
}

export const useObjectWindowStore = create<ObjectWindowState>(() => ({
  windows: new Map(),
  reusable: null,
  kinds: new Map(),
}));

/** Per window: what its preparation installed, undone when it goes. */
const teardowns = new Map<string, () => void>();
let nextIndex = 1;
let mainListenersInstalled = false;
let adoptionTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * Register what `kind`'s windows draw (an app's, from the layout that mounts
 * the host: core never imports an app). Returns the unregister.
 */
export function registerObjectWindowKind<P>(kind: string, render: ObjectWindowRender<P>, options: Omit<ObjectWindowKind<P>, "render"> = {}): () => void {
  const entry = { render, ...options } as ObjectWindowKind;
  useObjectWindowStore.setState((state) => ({ kinds: new Map(state.kinds).set(kind, entry) }));
  return () => {
    useObjectWindowStore.setState((state) => {
      if (state.kinds.get(kind) !== entry) return state;
      const kinds = new Map(state.kinds);
      kinds.delete(kind);
      return { kinds };
    });
  };
}

/** Whether this shell hosts object windows (Raft Desktop with facts.objectWindows). */
export function canOpenObjectWindows(): boolean {
  return getDesktopBridge()?.facts?.objectWindows === true;
}

export interface OpenObjectWindowOptions {
  /** Open another window, never the reusable one (⌘-click, "Open in new window"). */
  additional?: boolean;
  /** The element the open came from, given focus back when the window closes. */
  from?: Element | null;
  /** The window's first title, before its object names it. */
  title?: string;
}

function isAlive(entry: ObjectWindowEntry | undefined): entry is ObjectWindowEntry {
  return !!entry && entry.win.closed !== true;
}

/** A name no open window has (the shell refuses a live one). */
function freeName(windows: ReadonlyMap<string, ObjectWindowEntry>): string {
  for (let tries = 0; tries < MAX_NAME_INDEX; tries++) {
    const name = `${OBJECT_WINDOW_NAME_PREFIX}${nextIndex}`;
    nextIndex = nextIndex >= MAX_NAME_INDEX ? 1 : nextIndex + 1;
    if (!windows.has(name)) return name;
  }
  throw new Error("no free object window name");
}

/**
 * Open `payload` of `kind` in an object window: true when it is shown in one,
 * false when it is not (no object windows in this shell, at the limit, or the
 * shell refused the window): the caller then shows it its usual way.
 *
 * A plain open replaces the reusable window's object and raises it, and never
 * calls window.open on an existing name; with none, it opens a window that
 * becomes the reusable one. `additional` always opens another.
 */
export function openObjectWindow(kind: string, payload: unknown, { additional = false, from = null, title }: OpenObjectWindowOptions = {}): boolean {
  const bridge = getDesktopBridge();
  if (bridge?.facts?.objectWindows !== true) return false;
  pruneClosedWindows();
  const state = useObjectWindowStore.getState();
  const openedFrom = from ? new WeakRef(from) : null;

  if (!additional && state.reusable) {
    const reusable = state.windows.get(state.reusable);
    if (isAlive(reusable)) {
      // Its new object's first title, as a new window's: never the replaced object's name.
      reusable.doc.title = title ?? document.title;
      const next = { ...reusable, kind, payload, openedFrom: openedFrom ?? reusable.openedFrom, revision: reusable.revision + 1 };
      useObjectWindowStore.setState({ windows: new Map(state.windows).set(next.name, next) });
      void bridge.objectWindows?.raise(next.name);
      return true;
    }
  }

  if (state.windows.size >= MAX_OBJECT_WINDOWS) return false;
  const name = freeName(state.windows);
  const win = window.open("about:blank", name, "popup");
  if (!win) return false;

  let prepared: PreparedObjectWindow;
  try {
    prepared = prepareObjectWindowDocument(win, name, title);
  } catch {
    // A document we cannot write (not the about:blank we asked for): leave it to the caller.
    try { win.close(); } catch { /* already gone */ }
    return false;
  }
  teardowns.set(name, prepared.teardown);
  installMainListeners();
  for (const delay of OBJECT_WINDOW_ADOPTION_CHECKS_MS) scheduleAdoptionCheck(delay);

  const entry: ObjectWindowEntry = { name, kind, payload, win, doc: prepared.doc, root: prepared.root, openedFrom, revision: 0 };
  const windows = new Map(useObjectWindowStore.getState().windows).set(name, entry);
  useObjectWindowStore.setState(additional ? { windows } : { windows, reusable: name });
  if (!additional) bridge.objectWindows?.setReusable(name);
  return true;
}

interface PreparedObjectWindow {
  doc: Document;
  root: HTMLElement;
  teardown: () => void;
}

/**
 * Turn the new window's about:blank into the object's page: a standards-mode
 * document (the initial about:blank is in quirks mode), its charset, a base
 * of this app's origin (so the copied stylesheets and relative links resolve
 * as in the main window), the title, the main window's styles kept in sync,
 * the root the object renders into, and the window's own pagehide removing it.
 */
function prepareObjectWindowDocument(win: Window, name: string, title: string | undefined): PreparedObjectWindow {
  const doc = win.document;
  doc.open();
  doc.write("<!doctype html><html><head></head><body></body></html>");
  doc.close();

  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const base = doc.createElement("base");
  base.href = new URL("/", window.location.href).href;
  doc.head.append(charset, base);
  doc.title = title ?? document.title;

  const stopStyles = syncStyles(document, doc);
  // Its own frame (the window controls' corners, its drag region), from its own overlay: objectWindowChrome.ts.
  const stopChrome = installObjectWindowChrome(doc.documentElement, win, getDesktopBridge());
  // Its own full screen, from the shell (it hides the window controls there, so their corners are not reserved).
  const stopFullScreen = installObjectWindowFullScreen(doc.documentElement, name, getDesktopBridge());
  // Its window controls in its own head row's colours and height, not the main window's frame (objectWindowChrome.ts).
  const stopTitleBarReport = installObjectWindowTitleBarReporting(doc, name, getDesktopBridge());
  // Its own layers: a menu open here frees its title bar for the press that closes it, and one open in the main
  // window leaves this one's alone (layerGuard.ts; data-raft-layer-open is never mirrored, syncStyles).
  const stopLayerGuard = installLayerGuard(doc);
  // Focus rings follow this window's own input (raft-ui's data-input-modality on its <html>), not the main window's.
  const stopModality = installInputModality(doc);
  const root = doc.createElement("div");
  root.id = OBJECT_WINDOW_ROOT_ID;
  doc.body.append(root);

  const removeCompanion = addPageCompanionDocument(doc);
  // The window closing (its ×, ⌘W, the shell closing it): its object goes with it.
  const onPageHide = () => removeObjectWindow(name);
  win.addEventListener("pagehide", onPageHide);

  return {
    doc,
    root,
    teardown: () => {
      win.removeEventListener("pagehide", onPageHide);
      stopStyles();
      stopLayerGuard();
      stopChrome();
      stopFullScreen();
      stopTitleBarReport();
      stopModality();
      removeCompanion();
    },
  };
}

/** Look again in `delay` ms whether every window is still there (the shell may have refused the new one). */
function scheduleAdoptionCheck(delay: number): void {
  const timer = setTimeout(() => {
    adoptionTimers = adoptionTimers.filter((pending) => pending !== timer);
    pruneClosedWindows();
  }, delay);
  adoptionTimers.push(timer);
}

/** The main window coming back: a window the shell destroyed meanwhile (no pagehide) is forgotten. */
function onMainVisibilityChange(): void {
  if (document.visibilityState === "visible") pruneClosedWindows();
}

/**
 * Once, at the first open: the main page going away (reload, navigation,
 * quit) takes every object window with it, and the main window's focus or
 * showing again forgets the windows that closed without a pagehide.
 */
function installMainListeners(): void {
  if (mainListenersInstalled) return;
  mainListenersInstalled = true;
  window.addEventListener("pagehide", closeAllObjectWindows);
  window.addEventListener("focus", pruneClosedWindows);
  document.addEventListener("visibilitychange", onMainVisibilityChange);
}

/** Forget a window: its listeners, style sync and entry; the reusable one is reusable no more. */
function removeObjectWindow(name: string): ObjectWindowEntry | null {
  const state = useObjectWindowStore.getState();
  const entry = state.windows.get(name);
  teardowns.get(name)?.();
  teardowns.delete(name);
  if (!entry) return null;
  const windows = new Map(state.windows);
  windows.delete(name);
  const wasReusable = state.reusable === name;
  useObjectWindowStore.setState(wasReusable ? { windows, reusable: null } : { windows });
  if (wasReusable) getDesktopBridge()?.objectWindows?.setReusable(null);
  return entry;
}

/**
 * Windows that closed without a pagehide reaching us (the shell destroyed one
 * it refused, a crash): forgotten, the reusable one with the shell too.
 */
export function pruneClosedWindows(): void {
  for (const entry of useObjectWindowStore.getState().windows.values()) {
    if (entry.win.closed === true) removeObjectWindow(entry.name);
  }
}

/** Close the object window `name` (its object's × or Esc). */
export function closeObjectWindow(name: string): void {
  const entry = removeObjectWindow(name);
  if (!entry) return;
  try {
    entry.win.close();
  } catch {
    // Already gone.
  }
}

/** Close every object window: the main page leaving, a server switch (the layout unmounting). */
export function closeAllObjectWindows(): void {
  for (const name of [...useObjectWindowStore.getState().windows.keys()]) closeObjectWindow(name);
}

/** The shell's View › Reload with an object window focused: its object remounts (the main page is not reloaded). */
export function reloadObjectWindow(name: string): void {
  const state = useObjectWindowStore.getState();
  const entry = state.windows.get(name);
  if (!entry) return;
  useObjectWindowStore.setState({ windows: new Map(state.windows).set(name, { ...entry, revision: entry.revision + 1 }) });
}

/**
 * The shell's Window › Open in Main Window, and an object's own "Open in main window": the kind shows the object in
 * the main window (and raises it), and this window closes. The kind is asked while the window is still open, its
 * object still drawn (Kirby): what it reads of the window (the version its Artifact shows) is read before the close,
 * never left to React not having unmounted the view yet. The press in the window that asked for it is used up
 * here: the kind raises the main window itself (the menu's command comes with no press), so the main router's move
 * doesn't raise it a second time (ObjectWindowLocationRaise).
 */
export function openObjectWindowInMain(name: string): void {
  const state = useObjectWindowStore.getState();
  const entry = state.windows.get(name);
  if (!entry) return;
  const openInMain = state.kinds.get(entry.kind)?.openInMain;
  if (!openInMain) return;
  takeObjectWindowNavigationIntent();
  try {
    openInMain(entry.payload);
  } finally {
    closeObjectWindow(name);
  }
}

/**
 * Name the object window `name` (its title bar, the Window menu, the OS's window list): its object's name, once
 * known. With `forPayload`, only while that is still the window's payload (not after its object was replaced).
 */
export function setObjectWindowTitle(name: string, title: string, forPayload?: unknown): void {
  const entry = useObjectWindowStore.getState().windows.get(name);
  if (!entry || entry.win.closed === true || (forPayload !== undefined && entry.payload !== forPayload)) return;
  if (entry.doc.title !== title) entry.doc.title = title;
}

/** The object window whose document has the focus, or null (the main window has it, or another app). */
export function focusedObjectWindow(): ObjectWindowEntry | null {
  for (const entry of useObjectWindowStore.getState().windows.values()) {
    if (entry.doc.hasFocus()) return entry;
  }
  return null;
}

/** Test seam: close every window and start the names from 1 again. */
export function resetObjectWindowsForTests(): void {
  closeAllObjectWindows();
  nextIndex = 1;
  for (const timer of adoptionTimers) clearTimeout(timer);
  adoptionTimers = [];
  if (mainListenersInstalled) {
    window.removeEventListener("pagehide", closeAllObjectWindows);
    window.removeEventListener("focus", pruneClosedWindows);
    document.removeEventListener("visibilitychange", onMainVisibilityChange);
  }
  mainListenersInstalled = false;
  useObjectWindowStore.setState({ windows: new Map(), reusable: null, kinds: new Map() });
}
