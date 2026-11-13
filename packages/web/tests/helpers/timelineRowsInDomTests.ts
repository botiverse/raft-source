import { requestAllTimelineRowsMounted } from "../../src/utils/timelineMountAll";

// jsdom lays nothing out, and the virtual timeline (raft-ui VirtualList)
// mounts only the rows that fit its measured viewport: with no layout, a row
// or two. DOM tests (tests/helpers/domSetup.ts) therefore ask every timeline
// to mount all of its rows (timelineMountAll, the app's own mode for "Share as
// image": VirtualList with `virtual` off, every row in flow), so tests written
// against a timeline's rows see every loaded row. The windowing itself is
// tested in a real browser (tests/e2e/tests/virtual-timeline.spec.ts and the
// other timeline specs).

let release: (() => void) | null = null;

/** Every timeline mounts all of its rows (the DOM-test default). */
export function mountAllTimelineRowsInDomTests(): void {
  release ??= requestAllTimelineRowsMounted();
}

/** Timelines mount only the rows near the view again (with no layout: none) until the returned restore is called. */
export function virtualizeTimelinesInDomTests(): () => void {
  release?.();
  release = null;
  return mountAllTimelineRowsInDomTests;
}

const LIST_SELECTOR = '[data-slot="virtual-list"]';

/**
 * For tests of paging: timelines window their rows again, in a view this
 * tall (default 100,000 px: every row of a test's pages fits, at the list's
 * minimum row size) scrolled to its top, as a short first page is in the app.
 * The timeline then loads older pages on its own, as it does when the loaded
 * rows don't fill the view. jsdom's scrollTop / scrollHeight stay 0: the view
 * is also at its bottom. Call the returned restore after the test (one
 * layout at a time: a second call before the restore would stack its stubs).
 */
export function layOutTimelinesInDomTests(viewportHeight = 100_000): () => void {
  const restoreMountAll = virtualizeTimelinesInDomTests();
  const restores = (["offsetHeight", "clientHeight"] as const).map((property) => {
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
    const original = own ?? Object.getOwnPropertyDescriptor(Element.prototype, property);
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        if (this.matches(LIST_SELECTOR)) return viewportHeight;
        return original?.get?.call(this) ?? 0;
      },
    });
    return () => {
      if (own) Object.defineProperty(HTMLElement.prototype, property, own);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
    };
  });
  return () => {
    for (const restore of restores) restore();
    restoreMountAll();
  };
}
