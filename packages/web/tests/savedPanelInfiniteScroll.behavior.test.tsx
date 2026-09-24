import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import SavedPanel from "../src/components/saved/SavedPanel";
import { useSavedStore } from "../src/store/savedStore";
import type { SavedEntry } from "../src/store/savedStore";

const SERIAL = { concurrency: false };

const initialSavedState = useSavedStore.getState();
let intersectionCallback: IntersectionObserverCallback | null = null;
let observedTargets: Element[] = [];
let observedOptions: IntersectionObserverInit | undefined;

globalThis.IntersectionObserver = class {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    intersectionCallback = callback;
    observedOptions = options;
  }

  observe(target: Element) { observedTargets.push(target); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

function makeSavedEntry(overrides: Partial<SavedEntry> = {}): SavedEntry {
  return {
    messageId: "message-1",
    channelId: "channel-1",
    channelName: "proj-frontend",
    channelType: "channel",
    content: "Saved message content",
    senderType: "user",
    senderId: "user-1",
    senderName: "Artea",
    createdAt: new Date("2026-07-11T01:00:00Z").toISOString(),
    savedAt: new Date("2026-07-11T01:00:00Z").toISOString(),
    parentChannelId: null,
    parentChannelName: null,
    parentChannelType: null,
    parentMessageId: null,
    ...overrides,
  };
}

function makeSavedEntries(count: number, offset = 0): SavedEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const n = offset + index + 1;
    return makeSavedEntry({
      messageId: `message-${n}`,
      content: `Saved message content ${n}`,
      createdAt: new Date(Date.UTC(2026, 6, 11, 1, index)).toISOString(),
      savedAt: new Date(Date.UTC(2026, 6, 11, 1, index)).toISOString(),
    });
  });
}

function makeSavedIdSet(entries: SavedEntry[]): Set<string> {
  return new Set(entries.map((entry) => entry.messageId));
}

function trackSavedEntryRowReads(entry: SavedEntry) {
  let reads = 0;
  const proxy = new Proxy(entry, {
    get(target, property, receiver) {
      if (typeof property === "string" && property !== "messageId") {
        reads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    entry: proxy,
    reset: () => { reads = 0; },
    reads: () => reads,
  };
}

afterEach(() => {
  cleanup();
  intersectionCallback = null;
  observedTargets = [];
  observedOptions = undefined;
  useSavedStore.setState(initialSavedState, true);
});

test("Saved panel renders the finalized Chinese title and standalone item count", SERIAL, () => {
  useSavedStore.setState({
    ...initialSavedState,
    saved: [],
    savedIds: new Set(),
    loading: false,
    hasMore: false,
    total: 33,
    loadSaved: async () => {},
  }, true);

  rtlRender(
    <MemoryRouter>
      <TestIntlProvider locale="zh-cn">
        <SavedPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole("heading", { name: "已保存" }));
  assert.ok(screen.getByText("33 项"));
  assert.equal(screen.queryByText("已保存 33 项"), null);
  assert.equal(screen.queryByText("已收藏"), null);
});

test("Saved panel loads additional pages from a bottom sentinel instead of a Load More button", SERIAL, async () => {
  let loadMoreCalls = 0;
  useSavedStore.setState({
    ...initialSavedState,
    saved: [makeSavedEntry()],
    savedIds: new Set(["message-1"]),
    loading: false,
    hasMore: true,
    total: 2,
    loadSaved: async () => {},
    loadMore: async () => {
      loadMoreCalls += 1;
    },
  }, true);

  render(
    <MemoryRouter>
      <SavedPanel />
    </MemoryRouter>,
  );

  assert.equal(screen.queryByRole("button", { name: /load more/i }), null);
  const sentinel = screen.getByTestId("saved-infinite-scroll-sentinel");
  const scroller = screen.getByTestId("saved-list-scroller");
  assert.deepEqual(observedTargets, [sentinel]);
  assert.equal(observedOptions?.root, scroller);

  await act(async () => {
    intersectionCallback?.([
      { target: sentinel, isIntersecting: true } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });

  assert.equal(loadMoreCalls, 1);
});

test("Saved panel appends a page without re-rendering already mounted saved rows", SERIAL, async () => {
  const firstPageTrackers = makeSavedEntries(20).map(trackSavedEntryRowReads);
  const firstPage = firstPageTrackers.map((tracker) => tracker.entry);
  const secondPage = makeSavedEntries(20, 20);

  useSavedStore.setState({
    ...initialSavedState,
    saved: firstPage,
    savedIds: makeSavedIdSet(firstPage),
    loading: false,
    hasMore: true,
    total: 40,
    loadSaved: async () => {},
    loadMore: async () => {},
  }, true);

  render(
    <MemoryRouter>
      <SavedPanel />
    </MemoryRouter>,
  );

  for (const tracker of firstPageTrackers) tracker.reset();

  await act(async () => {
    useSavedStore.setState({ loading: true });
  });

  for (const tracker of firstPageTrackers) {
    assert.equal(tracker.reads(), 0, "old saved entry row data is not read for the loading commit");
  }

  await act(async () => {
    const saved = [...firstPage, ...secondPage];
    useSavedStore.setState({
      saved,
      savedIds: makeSavedIdSet(saved),
      loading: false,
      hasMore: false,
      total: 40,
    });
  });

  for (const tracker of firstPageTrackers) {
    assert.equal(tracker.reads(), 0, "old saved entry row data is not read when the next page appends");
  }
  for (const entry of secondPage) screen.getByText(entry.content);
});
