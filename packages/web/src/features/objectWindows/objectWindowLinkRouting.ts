// Links in an object window act on the main window (xxchan, VS Code's
// auxiliary windows): the object stays in its window, and a link to a
// conversation, a message, a person or another object opens in the main
// window, which comes forward. Components that navigate with the router
// (Links, useNavigate: the portal shares the main window's BrowserRouter)
// already do; what reaches the child document's own click unhandled is an
// anchor, routed here. Anything else (an outside link, a link within the
// page) keeps its default, which the shell's rules for the child window
// decide (the system browser).

import { isTextEditableElement } from "../../utils/keyboardShortcuts";
import { isElementNode } from "../../utils/ownerDocument";

/**
 * How long after a press in an object window a main-window navigation counts
 * as started there (a Link, a button calling navigate()): long enough for a
 * click's handlers and a lazy route, short enough that a redirect or a
 * replace of the main page's own later never raises the main window over
 * the object window the person is typing in.
 */
export const OBJECT_WINDOW_NAVIGATION_INTENT_MS = 1_000;

let navigationIntentUntil = 0;

/** A press in an object window that may navigate the main window (a click, Enter on a control). */
export function noteObjectWindowNavigationIntent(now = Date.now()): void {
  navigationIntentUntil = now + OBJECT_WINDOW_NAVIGATION_INTENT_MS;
}

/** Whether the navigation happening now was started in an object window; asking uses the press up. */
export function takeObjectWindowNavigationIntent(now = Date.now()): boolean {
  const started = now <= navigationIntentUntil;
  navigationIntentUntil = 0;
  return started;
}

/** A URL without its fragment. */
function withoutHash(url: URL): string {
  url.hash = "";
  return url.href;
}

/** The path, query and hash of `href` when it is a page of this app (`appHref`'s origin), else null. */
export function ownAppPathOf(href: string, appHref: string): string | null {
  let url: URL;
  let app: URL;
  try {
    app = new URL(appHref);
    url = new URL(href, app);
  } catch {
    return null;
  }
  // Compared by scheme and host, not origin: app://raft's origin is "null".
  if (url.protocol !== app.protocol || url.host !== app.host) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A link within the object window's own page: `#section`, an empty href, or
 * one that resolves to the document itself but for the hash. Under the
 * window's `<base href>` (the app's origin) those would resolve to the app's
 * home: they are left to the page.
 */
export function isInPageLink(anchor: HTMLAnchorElement): boolean {
  const raw = (anchor.getAttribute("href") ?? "").trim();
  if (raw === "" || raw.startsWith("#")) return true;
  try {
    return withoutHash(new URL(anchor.href)) === withoutHash(new URL(anchor.ownerDocument.URL));
  } catch {
    return false;
  }
}

/** The link a click is on, if any. */
function anchorOf(target: EventTarget | null): HTMLAnchorElement | null {
  if (!isElementNode(target)) return null;
  const anchor = target.closest("a[href]");
  return anchor && anchor.localName === "a" ? (anchor as HTMLAnchorElement) : null;
}

export interface ObjectWindowLinkRouting {
  /** Navigate the main window's router. */
  navigate: (path: string) => void;
  /** Bring the main window forward. */
  raiseMain: () => void;
  /** The main window's address, for what counts as this app's page. */
  appHref: () => string;
}

/**
 * On `doc` (an object window's): every press notes a navigation intent (a
 * Link or a button there navigating the main router raises the main window:
 * ObjectWindowLocationRaise), and a click or middle click on a link to this
 * app's own page that nothing handled (bubble phase, after React's handlers
 * on the portal root) navigates the main window there and raises it. Returns
 * the stop.
 */
export function installObjectWindowLinkRouting(doc: Document, routing: ObjectWindowLinkRouting): () => void {
  const onPress = () => noteObjectWindowNavigationIntent();
  const onKeyDown = (event: KeyboardEvent) => {
    // Enter or Space on a control activates it; in a text field it is typing.
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isElementNode(event.target) && isTextEditableElement(event.target)) return;
    noteObjectWindowNavigationIntent();
  };
  const onActivate = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 && event.button !== 1) return;
    const anchor = anchorOf(event.target);
    if (!anchor || anchor.hasAttribute("download") || isInPageLink(anchor)) return;
    const path = ownAppPathOf(anchor.href, routing.appHref());
    if (path === null) return;
    event.preventDefault();
    routing.navigate(path);
    // Raised here, also for a link to where the main window already is; the press's intent is used up so the
    // location change doesn't raise it a second time.
    takeObjectWindowNavigationIntent();
    routing.raiseMain();
  };
  // Capture: noted before any handler in the window navigates.
  doc.addEventListener("click", onPress, true);
  doc.addEventListener("auxclick", onPress, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("click", onActivate);
  doc.addEventListener("auxclick", onActivate);
  return () => {
    doc.removeEventListener("click", onPress, true);
    doc.removeEventListener("auxclick", onPress, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("click", onActivate);
    doc.removeEventListener("auxclick", onActivate);
  };
}
