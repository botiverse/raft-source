import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FindDirection, FindResult } from "@botiverse/porthole";

import { matchesShortcut, SHORTCUT_SCOPE_ATTRIBUTE, useShortcut } from "../../features/shortcuts";
import type { KeyboardShortcutEvent } from "../../utils/keyboardShortcuts";
import { isEscapeTakenElsewhere } from "./artifactInputMethodKey";

/**
 * Find in page (#proj-workspace:#138, Porthole's `find`, P131): the viewer's, the Artifact's own
 * page's and the public page's find bar (ArtifactFindBar) over a framed page (html, markdown, pdf).
 * The frame (ArtifactFrame) offers a target where its page may be searched (artifactFrameFind
 * `findAllowed`); ArtifactFindProvider holds the bar's state, in the surface (ArtifactSurface) or
 * around the public page's panel (PublicArtifactPage):
 *
 * - The page reads every query, so a query goes only once the person pauses
 *   (FIND_QUERY_PAUSE_MS) or presses Enter, never at each key; a newer one supersedes it, and only
 *   the answer to the latest is shown.
 * - Enter (Next) and Shift+Enter (Previous) move between matches; with a query not sent yet they
 *   send it. Esc, ×, and the frame going (another version) close the bar and clear its
 *   highlights.
 * - Other content in the frame (a reload, a retry, a new run, another host) forgets the query, as
 *   Porthole does: the bar empties (it stays open). `findUpdated` (the page changed) brings new
 *   numbers.
 * - "unsupported" (a content Worker before find, no answer in 3 s, a frame without find): Find
 *   isn't offered (#proj-workspace:#250): no header button, the bar closes, and Cmd/Ctrl+F is
 *   the browser's own find, with no sentence to say so.
 * - Cmd/Ctrl+F opens the bar wherever the keyboard is in the surface: its panel's keys
 *   (useArtifactFindKeyDown, in ArtifactSurface's useArtifactSurfaceKeyDown and on the public
 *   page's panel), the framed page's (`findRequested`, Porthole's `takeShortcut`), and the body's
 *   once the surface had the focus last (useArtifactFindBodyShortcut).
 */

/** How long the person pauses typing before the query goes to the page. */
export const FIND_QUERY_PAUSE_MS = 300;

/** The longest query Porthole sends (`FIND_LIMITS.query`, UTF-16 code units; past it, a refusal). */
export const FIND_QUERY_MAX = 256;

export type ArtifactFindAnswer = FindResult | "unsupported";

/** What a framed page offers the find bar, while it is shown. */
export interface ArtifactFindTarget {
  /** The content the frame shows: another key is other content, which forgets the query. */
  key: string;
  /** `waiting`: no frame to ask yet (a query waits for it); `unsupported`: this frame can't find. */
  state: "waiting" | "ready" | "unsupported";
  find: (query: string, direction: FindDirection) => Promise<ArtifactFindAnswer>;
  clear: () => void;
}

/** What `shortcut` reads of a key: the surface panel's (React's) or the window's (the body's). */
export type ArtifactFindShortcutEvent = KeyboardShortcutEvent & Pick<Event, "defaultPrevented" | "preventDefault">;

/** The bar's state, for the bar, the header's button and the surface's keys. */
export interface ArtifactFind {
  /** A page that may be searched is shown, and hasn't said it can't be: the header's button, Cmd/Ctrl+F. */
  offered: boolean;
  open: boolean;
  query: string;
  /** Beside the query: nothing yet, or the page's numbers. */
  answer: FindResult | null;
  /** Counts each time the bar is asked to open, so it takes focus again. */
  focusRequest: number;
  openBar: () => void;
  close: () => void;
  type: (query: string) => void;
  /** Enter, Shift+Enter, Next, Previous: the query typed if it isn't the one sent, else a match on. */
  step: (direction: "next" | "prev") => void;
  /** Cmd/Ctrl+F on the surface: opens the bar where Find is offered. */
  shortcut: (event: ArtifactFindShortcutEvent) => boolean;
}

/** What the frame tells the bar: its target (null: none), and what its page said. */
interface ArtifactFindFrame {
  show: (owner: symbol, target: ArtifactFindTarget | null) => void;
  gone: (owner: symbol) => void;
  /** Cmd/Ctrl+F in the page (`findRequested`): open the bar, nothing more. */
  requested: () => void;
  /** The page changed under the query shown (`findUpdated`). */
  updated: (result: FindResult) => void;
}

const FindContext = createContext<ArtifactFind | null>(null);
const FindFrameContext = createContext<ArtifactFindFrame | null>(null);

export const ArtifactFindContext = FindContext.Provider;
export const ArtifactFindFrameContext = FindFrameContext.Provider;

/** The bar's state; null outside an ArtifactFindProvider (a frame with no find bar). */
export function useArtifactFind(): ArtifactFind | null {
  return useContext(FindContext);
}

/** The find bar's state: one per opening (ArtifactFindProvider: the surface's, the public page's). */
export function useArtifactFindState(): { find: ArtifactFind; frame: ArtifactFindFrame } {
  const [target, setTarget] = useState<ArtifactFindTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<ArtifactFindAnswer | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const current = useRef<{ owner: symbol; target: ArtifactFindTarget | null } | null>(null);
  /** The query the page was last given (null: none), and one waiting for a frame to take it. */
  const sent = useRef<string | null>(null);
  const waiting = useRef<string | null>(null);
  /** Counts the queries: only the latest one's answer is shown. */
  const asked = useRef(0);
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPause = useCallback(() => {
    if (pause.current !== null) clearTimeout(pause.current);
    pause.current = null;
  }, []);
  /** Forget the query and its numbers; the page's highlights too where it still shows them. */
  const reset = useCallback((clearPage: boolean) => {
    stopPause();
    asked.current += 1;
    if (clearPage && sent.current !== null) current.current?.target?.clear();
    sent.current = null;
    waiting.current = null;
    setQuery("");
    setAnswer(null);
  }, [stopPause]);

  const send = useCallback((text: string, direction: FindDirection) => {
    stopPause();
    const mine = ++asked.current;
    const to = current.current?.target ?? null;
    if (text.trim() === "") {
      // An empty query finds nothing: the page's highlights go, nothing is sent.
      if (sent.current !== null) to?.clear();
      sent.current = null;
      waiting.current = null;
      setAnswer(null);
      return;
    }
    if (to === null || to.state === "waiting") {
      waiting.current = text;
      return;
    }
    waiting.current = null;
    if (to.state === "unsupported") return;
    sent.current = text;
    void to.find(text, direction).then((result) => {
      if (mine !== asked.current) return;
      setAnswer(result);
      // The page can't find after all: no bar, so Cmd/Ctrl+F is the browser's.
      if (result === "unsupported") setOpen(false);
    });
  }, [stopPause]);

  useEffect(() => stopPause, [stopPause]);

  const frame = useMemo<ArtifactFindFrame>(() => ({
    show: (owner, next) => {
      const was = current.current;
      // Other content (another frame, a reload, a retry, another host): Porthole forgot the query.
      if (was !== null && (was.owner !== owner || was.target?.key !== next?.key)) reset(false);
      current.current = { owner, target: next };
      setTarget(next);
      if (next === null || next.state === "unsupported") setOpen(false);
      // A frame that couldn't take a query yet (its ticket, its code) takes the one waiting once it can.
      else if (next.state !== "waiting" && waiting.current !== null) send(waiting.current, "none");
    },
    gone: (owner) => {
      if (current.current?.owner !== owner) return;
      current.current = null;
      reset(false);
      setTarget(null);
      setOpen(false);
    },
    requested: () => {
      setOpen(true);
      setFocusRequest((n) => n + 1);
    },
    updated: (result) => {
      if (sent.current !== null) setAnswer(result);
    },
  }), [reset, send]);

  // Not where this frame can't find, or its page said so (an older content Worker, no answer in time).
  const offered = target !== null && target.state !== "unsupported" && answer !== "unsupported";
  const openBar = frame.requested;
  const close = useCallback(() => {
    reset(true);
    setOpen(false);
  }, [reset]);
  const type = useCallback((text: string) => {
    setQuery(text);
    stopPause();
    pause.current = setTimeout(() => send(text, "none"), FIND_QUERY_PAUSE_MS);
  }, [send, stopPause]);
  const step = useCallback((direction: "next" | "prev") => {
    send(query, query === sent.current ? direction : "none");
  }, [query, send]);
  const shortcut = useCallback((event: ArtifactFindShortcutEvent) => {
    if (!offered || event.defaultPrevented || !matchesShortcut(event, "artifact-find")) return false;
    event.preventDefault();
    openBar();
    return true;
  }, [offered, openBar]);

  const find = useMemo<ArtifactFind>(() => ({
    offered,
    open: open && offered,
    query,
    answer: answer === "unsupported" ? null : answer,
    focusRequest,
    openBar,
    close,
    type,
    step,
    shortcut,
  }), [offered, open, query, answer, focusRequest, openBar, close, type, step, shortcut]);
  return { find, frame };
}

/**
 * For ArtifactFrame: offers its target to the surface's find bar while mounted (null: its page may
 * not be searched, or no bar), and what its page says (`findRequested`, `findUpdated`). Null
 * outside an ArtifactFindProvider.
 */
export function useArtifactFindFrame(target: ArtifactFindTarget | null): Pick<ArtifactFindFrame, "requested" | "updated"> | null {
  const frame = useContext(FindFrameContext);
  const [owner] = useState(() => Symbol("artifact-frame"));
  useLayoutEffect(() => {
    frame?.show(owner, target);
  }, [frame, owner, target]);
  useLayoutEffect(() => () => frame?.gone(owner), [frame, owner]);
  return frame;
}

/**
 * The find bar's keys on the element that holds it (`[data-artifact-focus]`: the surface's panel, the public page's):
 * Cmd/Ctrl+F opens the bar where Find is offered; with the bar open, Esc closes it wherever the focus is inside (its
 * buttons included), the focus moving to that element first so it isn't lost to the body with the bar's buttons.
 * True: the key was the bar's (the caller handles nothing more).
 */
export function useArtifactFindKeyDown(): (event: ReactKeyboardEvent<HTMLElement>) => boolean {
  const find = useArtifactFind();
  const shortcut = find?.shortcut;
  const close = find?.open ? find.close : null;
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (shortcut?.(event)) return true;
    // An Esc taken elsewhere (input method, an open modal over the surface) closes nothing here.
    if (!close || event.key !== "Escape" || isEscapeTakenElsewhere(event)) return false;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    close();
    return true;
  }, [shortcut, close]);
}

/**
 * Cmd/Ctrl+F (or the person's keys) with no focused element (the Artifact's own page just loaded, or what had the
 * focus went) opens the find bar while the last click or focus landed in the surface (`surface`), as ThreadPanel's
 * ⌘F does: otherwise the browser's find would open over the Artifact. A key in the surface is its panel's, one in the
 * framed page the page's. Through the registry: the surface is the "artifact" scope, and the dispatcher offers a key
 * on the body to the scope last clicked or focused (the viewer moves the focus in when it opens). `wholePage`: the
 * Artifact's own page, which is the whole document, in scope from the start.
 */
export function useArtifactFindBodyShortcut(surface: HTMLElement | null, { wholePage = false }: { wholePage?: boolean } = {}): void {
  const find = useArtifactFind();
  const surfaceRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    surfaceRef.current = surface;
    if (!surface) return;
    surface.setAttribute(SHORTCUT_SCOPE_ATTRIBUTE, "artifact");
    return () => surface.removeAttribute(SHORTCUT_SCOPE_ATTRIBUTE);
  }, [surface]);
  useShortcut("artifact-find", (event) => (event.target === document.body ? (find?.shortcut(event) ?? false) : false), {
    enabled: surface !== null,
    scopeRef: surfaceRef,
    ambient: wholePage,
  });
}
