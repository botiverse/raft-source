// The document and window a node lives in, for code that may run in more than
// one: an object window (features/objectWindows) is a second window whose
// document the main window's web app renders into through a React portal, so
// a surface there has its own `document`, `window`, focus, selection,
// clipboard, matchMedia and animation frames, and its nodes are made by
// another realm's constructors (`node instanceof HTMLElement` is false for
// them in the main window's code). Read them from the node, or from
// useOwnerDocument / useOwnerWindow in a component, never from the globals.

import { createContext, useContext } from "react";

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

export type OwnerWindow = Window & typeof globalThis;

/** An Element of any window (nodeType 1): what `instanceof Element` means, across windows. */
export function isElementNode(value: unknown): value is Element {
  return typeof value === "object" && value !== null && (value as { nodeType?: unknown }).nodeType === ELEMENT_NODE;
}

function isDocumentNode(value: unknown): value is Document {
  return typeof value === "object" && value !== null && (value as { nodeType?: unknown }).nodeType === DOCUMENT_NODE;
}

/**
 * The document `value` belongs to: a node's ownerDocument, a document itself,
 * a window's document; the global document for anything else (null, a
 * non-node). Undefined only where there is no global document (a test without
 * a DOM).
 */
export function docOf(value?: unknown): Document {
  if (isDocumentNode(value)) return value;
  const owner = typeof value === "object" && value !== null ? (value as { ownerDocument?: unknown }).ownerDocument : null;
  if (isDocumentNode(owner)) return owner;
  const windowDocument = typeof value === "object" && value !== null ? (value as { document?: unknown }).document : null;
  if (isDocumentNode(windowDocument)) return windowDocument;
  // Read off globalThis: no ReferenceError where there is no DOM.
  return globalThis.document;
}

/** The window `value`'s document is shown in (docOf); the global window when it has none. */
export function viewOf(value?: unknown): OwnerWindow {
  const view = docOf(value)?.defaultView as OwnerWindow | null | undefined;
  return view ?? globalThis.window;
}

/** An HTMLElement of any window: `instanceof HTMLElement` checked against the element's own window. */
export function isHTMLElementNode(value: unknown): value is HTMLElement {
  if (!isElementNode(value)) return false;
  const ownHTMLElement = value.ownerDocument?.defaultView?.HTMLElement;
  if (ownHTMLElement) return value instanceof ownHTMLElement;
  return value.namespaceURI === "http://www.w3.org/1999/xhtml";
}

/** The document and window a subtree renders into. */
export interface OwnerDocumentValue {
  doc: Document;
  win: OwnerWindow;
}

/** Set by whatever renders a subtree into another window's document (ObjectWindowsHost); absent: the main window. */
export const OwnerDocumentContext = createContext<OwnerDocumentValue | null>(null);

/** The document this component renders into: an object window's, or the global document (undefined with no DOM). */
export function useOwnerDocument(): Document {
  return useContext(OwnerDocumentContext)?.doc ?? globalThis.document;
}

/** The window this component renders into: an object window, or the global window (undefined with no DOM). */
export function useOwnerWindow(): OwnerWindow {
  return useContext(OwnerDocumentContext)?.win ?? globalThis.window;
}

/** What schedules an animation frame. */
export type AnimationFrames = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;

/**
 * The animation frames of `doc`'s window: the globals for the main document
 * (what a test fakes), the object window's own for its document (the main
 * window draws no frames while it is hidden behind one).
 */
export function animationFramesOf(doc: Document | null | undefined): AnimationFrames {
  if (!doc || doc === globalThis.document) return globalThis;
  return doc.defaultView ?? globalThis;
}

/** What runs a timer. */
export type Timers = Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;

/**
 * The timers of `doc`'s window, as animationFramesOf: the globals for the main
 * document (what a test fakes), the object window's own for its document (a
 * hidden main window's timers are slowed to once a second or less, its own
 * are not while it is shown).
 */
export function timersOf(doc: Document | null | undefined): Timers {
  if (!doc || doc === globalThis.document) return globalThis as unknown as Timers;
  return doc.defaultView ?? (globalThis as unknown as Timers);
}

/** The timers of the window this component renders into (timersOf its document). */
export function useOwnerTimers(): Timers {
  return timersOf(useOwnerDocument());
}

/**
 * The ResizeObserver of `node`'s window, as animationFramesOf: the global one
 * for the main document (what a test stubs), the object window's own for its
 * nodes (an observer reports in its own window's rendering, which a hidden
 * main window doesn't do). Undefined where there is none (jsdom).
 */
export function resizeObserverOf(node: unknown): typeof ResizeObserver | undefined {
  const doc = docOf(node);
  const own = !doc || doc === globalThis.document ? undefined : (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
  return own ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
}

/** The IntersectionObserver of `node`'s window (resizeObserverOf's rule). */
export function intersectionObserverOf(node: unknown): typeof IntersectionObserver | undefined {
  const doc = docOf(node);
  const own = !doc || doc === globalThis.document ? undefined : (doc.defaultView as (Window & { IntersectionObserver?: typeof IntersectionObserver }) | null)?.IntersectionObserver;
  return own ?? (typeof IntersectionObserver === "undefined" ? undefined : IntersectionObserver);
}
