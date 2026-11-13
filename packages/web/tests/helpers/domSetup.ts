// DOM test setup for jsdom/RTL behavioral component tests.
// Vitest loads this before every `*.test.tsx` file through vitest.config.ts.
import "global-jsdom/register";
import { mountAllTimelineRowsInDomTests } from "./timelineRowsInDomTests";

// jsdom performs no layout and ships no `scrollIntoView`; component code is
// allowed to call it unguarded (every real browser has it), so the shared DOM
// harness provides a no-op. Suites asserting scroll behavior override this
// per file (e.g. attachmentCommentsPanelAnchor).
Element.prototype.scrollIntoView = function scrollIntoView() {};
// Same for element `scrollTo` / `scrollBy` (raft-ui VirtualList, the
// timeline's scroller, calls them to jump to a row and to keep rows in place).
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = function scrollTo() {} as typeof Element.prototype.scrollTo;
}
if (typeof Element.prototype.scrollBy !== "function") {
  Element.prototype.scrollBy = function scrollBy() {} as typeof Element.prototype.scrollBy;
}

// jsdom has no viewport geometry or IntersectionObserver. Keep unobserved
// content unobserved: an eager "everything is visible" fake would trigger
// preview/network work in unrelated message tests. Visibility-specific tests
// install their own controllable observer (e.g. appLinkPreviews.behavior (removed in the 2026-11 web DOM test prune)).
if (typeof globalThis.IntersectionObserver === "undefined") {
  class NoLayoutIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: readonly number[];
    readonly scrollMargin = "0px";
    constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? "0px";
      this.thresholds = Array.isArray(options?.threshold) ? options.threshold : [options?.threshold ?? 0];
    }
    observe(_target: Element) {}
    unobserve(_target: Element) {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  globalThis.IntersectionObserver = NoLayoutIntersectionObserver;
  window.IntersectionObserver = NoLayoutIntersectionObserver;
}

// jsdom before 30 shipped no `CSS.escape` (browsers do; jsdom 30 does too, so
// this is now a fallback). Minimal spec-shaped polyfill: escape everything
// outside the identifier-safe set, so escaped selectors built from URL-decoded
// ids stay valid and match nothing on a crafted input (task #702).
if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
  const cssShim = (typeof CSS === "undefined" ? {} : CSS) as { escape?: (value: string) => string };
  cssShim.escape = (value: string) => String(value).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, "\\$&");
  (globalThis as typeof globalThis & { CSS?: typeof cssShim }).CSS = cssShim;
}

// jsdom 30 implements `CSS.supports()` by parsing the declaration, so it
// answers true for `field-sizing: content` although it has no layout engine
// and never sizes a field. Component code that picks the native path on that
// answer (the composer autosize) would silently stop running its measured
// fallback in every DOM test. Report the property as unsupported here; suites
// that want the native path pass `fieldSizingSupported` explicitly.
if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
  const nativeSupports = CSS.supports.bind(CSS) as (...args: string[]) => boolean;
  CSS.supports = ((...args: string[]) =>
    args[0]?.includes("field-sizing") ? false : nativeSupports(...args)) as typeof CSS.supports;
}
// oxlint-disable-next-line no-restricted-imports -- Whole-module React shim for classic-runtime test dependencies.
import * as React from "react";

// The Hands SDK source export currently reaches Vitest through its classic JSX
// runtime, so expose React only inside the shared DOM-test harness.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }

  get length() {
    return this.map.size;
  }
}

for (const storageKey of ["localStorage", "sessionStorage"] as const) {
  const current = globalThis[storageKey] as Storage | undefined;
  if (typeof current?.getItem !== "function") {
    Object.defineProperty(globalThis, storageKey, {
      value: new MemoryStorage(),
      configurable: true,
    });
  }
}

// React ships separate production/development builds and picks one at import
// time from NODE_ENV. The dev build is required for tests: `React.act` and the
// act-environment checks only exist there. Force it before any test file
// imports react (global-jsdom does not pull in react, so this runs first).
process.env.NODE_ENV = "test";

// React 19's `act()` reads this flag to confirm it is in a test environment.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

// jsdom's real window.close() DESTROYS the shared document (document.body
// becomes undefined for every test that runs after it), unlike a browser where
// close() on a non-script-opened page is a no-op. Production code legitimately
// calls window.close() (Native onboarding completion asks the WebView host to
// close, task #311), so neuter it here. Tests that assert the close request
// install their own spy by assigning window.close.
window.close = () => {};

if (typeof globalThis.localStorage?.getItem !== "function") {
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

// Every virtual timeline mounts all of its rows: jsdom has no layout to
// window them by (timelineRowsInDomTests.ts).
mountAllTimelineRowsInDomTests();

// A press's click guard (useRowSwipe `swallowClickAfterPress`) waits on the
// document for that press's click, until the next press. A real click always
// follows a press, but a test's `fireEvent.click` comes without one, so a
// guard a swipe left in the last case would swallow it. A cancelled press
// disarms every guard: end each case with one.
afterEach(() => {
  document.dispatchEvent(new window.Event("pointercancel"));
});
