// Link cards that update themselves, web side (docs/development/app-link-previews.md,
// "Web display" and "Telling Raft a card changed"): the batched read declares
// card.changed.v1, and a `link_card.changed` nudge whose digest a shown card
// carries reads that card again, after a random wait of up to 2 s, through the
// message view's re-read (the read Refresh makes): once the message is on
// screen, once per object while one waits and at most once per 10 s per
// object, never under the pointer or focus (Kirby), never for a busy card,
// with no busy state (no Working…); an answer with no card keeps the card.
// The real hook with a fake socket, a controllable IntersectionObserver and
// fake timers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { LINK_CARD_CHANGED_EVENT } from "@botiverse/raft-shared/src/appLinkPreview";

type Listener = (payload: unknown) => void;
const socketListeners = new Map<string, Set<Listener>>();
const fakeSocket = {
  on(event: string, listener: Listener) {
    if (!socketListeners.has(event)) socketListeners.set(event, new Set());
    socketListeners.get(event)!.add(listener);
    return fakeSocket;
  },
  off(event: string, listener: Listener) {
    socketListeners.get(event)?.delete(listener);
    return fakeSocket;
  },
};
vi.mock("../src/api/socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/socket")>()),
  getSocket: () => fakeSocket,
  onSocketCreated: () => () => {},
}));

const { default: api } = await import("../src/api/client");
const { useAuthStore } = await import("../src/store/authStore");
const { useServerStore } = await import("../src/store/serverStore");
const { INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY, resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } = await import("../src/store/serverFeatureFlags");
const { clearAppLinkPreviewCacheForTests, LINK_CARD_READ_RETRIES, useAppLinkPreviews } = await import("../src/components/message/useAppLinkPreviews");
const { LINK_CARD_READ_CAPABILITIES } = await import("../src/components/message/linkCardRead");
const { LINK_CARD_CHANGED_MIN_INTERVAL_MS, resetLinkCardChangedForTests } = await import("../src/components/message/linkCardChangedRereads");
const { linkCardViewKey, resetLinkCardActionsForTests, useLinkCardActionStore } = await import("../src/components/message/linkCardExecute");

const URL_A = "https://stamp.example.test/pr/1";
const URL_B = "https://stamp.example.test/pr/2";
const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

// What the App answers now, and each link's object.
let title = "Waiting to merge";
let keys: Record<string, string> = {};
type ReadBody = { view_instance_id: string; capabilities: string[]; locale: string; urls?: string[]; tickets?: unknown };
let reads: ReadBody[] = [];
// What the App answers for a link read alone (a nudge's or Refresh's read): the card by default.
let answerOne: (url: string) => object | null = (url) => item(url);
const item = (url: string) => ({
  kind: "v2", url, app: { id: "app-1", name: "Stamp", icon: null }, ticket: null, actions: [],
  preview: { version: 2, display: "card", title, card_revision: "r1", business_revision: "b1", card: { root: "t", elements: { t: { type: "Text", props: { text: title } } } } },
  ...(keys[url] ? { object_key_sha256: keys[url] } : {}),
});

// The message's IntersectionObserver: reports `onScreen` when it starts observing and on each change.
let onScreen = true;
const observers = new Set<FakeObserver>();
class FakeObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  readonly scrollMargin = "0px";
  private target: Element | null = null;
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.target = target;
    observers.add(this);
    queueMicrotask(() => this.report());
  }
  report() {
    if (observers.has(this) && this.target) this.callback([{ isIntersecting: onScreen, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() { observers.delete(this); }
  takeRecords() { return []; }
}
const originalObserver = globalThis.IntersectionObserver;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}
async function setOnScreen(value: boolean) {
  onScreen = value;
  await act(async () => {
    for (const observer of [...observers]) observer.report();
  });
  await advance(0);
}
async function nudge(key: string) {
  await act(async () => {
    for (const listener of [...(socketListeners.get(LINK_CARD_CHANGED_EVENT) ?? [])]) listener({ app: "app-1", object_key_sha256: key });
  });
  await advance(0);
}

function mount() {
  const element = document.createElement("div");
  document.body.append(element);
  const target = { current: element };
  const hook = renderHook(() => useAppLinkPreviews({ messageId: "message-1", content: `${URL_A} and ${URL_B}`, conversationId: "channel-1", enabled: true, target, seen: true }));
  const card = (url: string) => {
    const result = hook.result.current.results.get(url);
    assert.ok(result?.kind === "card", `${url} is a card`);
    return result;
  };
  return { hook, card, element };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-11-20T10:00:00.000Z") });
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
  window.IntersectionObserver = globalThis.IntersectionObserver;
  onScreen = true;
  observers.clear();
  title = "Waiting to merge";
  keys = { [URL_A]: KEY, [URL_B]: OTHER };
  reads = [];
  answerOne = (url) => item(url);
  // The jitter: 1 + 0.5 * 2000 = 1001 ms.
  resetLinkCardChangedForTests(() => 0.5);
  useAuthStore.setState({ user: { id: "user-1" } as never });
  useServerStore.setState({ current: { id: "server-1" } as never });
  setServerFeatureFlagForTests("server-1", INTERACTIVE_LINK_CARDS_FEATURE_FLAG_KEY, true);
  vi.spyOn(api, "post").mockImplementation(async (path: string, body?: unknown) => {
    assert.equal(path, "/messages/message-1/link-cards/read");
    const read = body as ReadBody;
    reads.push(read);
    const items = read.urls ? read.urls.flatMap((url) => answerOne(url) ?? []) : [URL_A, URL_B].map(item);
    return { data: { items } } as never;
  });
});
afterEach(() => {
  cleanup();
  clearAppLinkPreviewCacheForTests();
  resetLinkCardChangedForTests();
  resetLinkCardActionsForTests();
  resetServerFeatureFlagsForTests();
  globalThis.IntersectionObserver = originalObserver;
  window.IntersectionObserver = originalObserver;
  socketListeners.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
});

test("the read declares card.changed.v1; a nudge reads the on-screen card of that object again after the jitter, as Refresh does, with no busy state", async () => {
  assert.ok(LINK_CARD_READ_CAPABILITIES.includes("card.changed.v1"));
  const { card } = mount();
  await advance(0);
  assert.equal(reads.length, 1);
  assert.ok(reads[0]!.capabilities.includes("card.changed.v1"));
  assert.equal(card(URL_A).objectKey, KEY, "the digest is kept with the card");

  const busyStates: unknown[] = [];
  const stop = useLinkCardActionStore.subscribe((state) => busyStates.push(state.views));
  title = "Merged";
  await nudge(KEY);
  await advance(1000);
  assert.equal(reads.length, 1, "not before the jitter");
  await advance(1);
  assert.equal(reads.length, 2);
  const nudged = reads[1]!;
  assert.deepEqual(nudged.urls, [URL_A], "only the card of that object");
  assert.equal(card(URL_A).title, "Merged", "the answer replaces the card");
  assert.equal(card(URL_B).title, "Waiting to merge");
  stop();
  assert.deepEqual(busyStates, [], "no Working…: the view's state never changed");

  // Refresh's read (the view's reread) sends exactly the same request.
  await act(async () => { await card(URL_A).view!.reread(URL_A); });
  assert.equal(reads.length, 3);
  assert.deepEqual(reads[2], nudged);
});

test("a nudge for another object reads nothing; a mounted row off screen reads once it is on screen; one that leaves during the wait reads once it is back", async () => {
  mount();
  await advance(0);
  await nudge("c".repeat(64));
  await advance(3000);
  assert.equal(reads.length, 1, "no card of that object");

  // Mounted but off screen (the list's overscan, scrolled away in a long thread).
  await setOnScreen(false);
  await nudge(KEY);
  await advance(3000);
  await nudge(KEY);
  await advance(3000);
  assert.equal(reads.length, 1, "off screen: nothing yet");
  await setOnScreen(true);
  await advance(1000);
  assert.equal(reads.length, 1, "on screen: the jitter first");
  await advance(1);
  assert.equal(reads.length, 2, "both nudges: one re-read");
  assert.deepEqual(reads[1]!.urls, [URL_A]);

  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  await nudge(KEY);
  await setOnScreen(false);
  await advance(3000);
  assert.equal(reads.length, 2, "due while off screen: it waits");
  await setOnScreen(true);
  assert.equal(reads.length, 3);
});

test("nudges for one object while its re-read waits are one re-read; then at most one per 10 s, the last ones merged into one at its end; links of one object all read again", async () => {
  keys = { [URL_A]: KEY, [URL_B]: KEY };
  mount();
  await advance(0);
  await nudge(KEY);
  await advance(500);
  await nudge(KEY);
  await advance(501);
  assert.deepEqual(reads.slice(1).map((read) => read.urls), [[URL_A], [URL_B]], "each link once, one read at a time");
  for (let n = 0; n < 4; n += 1) {
    await advance(2000);
    await nudge(KEY);
  }
  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS - 8000 - 2);
  assert.equal(reads.length, 3, "within 10 s of the last re-read: none yet");
  await advance(2);
  assert.equal(reads.length, 5, "the four nudges: one re-read of each link, at the end of the 10 s");
  // No budget to run out: a nudge every 10 s keeps reading.
  for (let n = 0; n < 15; n += 1) {
    await nudge(KEY);
    await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  }
  assert.equal(reads.length, 5 + 30, "past LINK_CARD_READ_RETRIES of them");
});

test("not under the pointer, focus or an open popup: the re-read waits for it to end", async () => {
  const { element, card } = mount();
  await advance(0);
  title = "Merged";
  element.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
  await nudge(KEY);
  await advance(5000);
  assert.equal(reads.length, 1, "the pointer is over the message");
  element.dispatchEvent(new window.Event("pointerleave"));
  await advance(0);
  assert.equal(reads.length, 2, "read once it leaves");
  assert.equal(card(URL_A).title, "Merged");

  const button = document.createElement("button");
  element.append(button);
  button.focus();
  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  await nudge(KEY);
  await advance(5000);
  assert.equal(reads.length, 2, "focus is in the message");
  button.blur();
  await advance(0);
  assert.equal(reads.length, 3, "read once focus leaves");

  button.setAttribute("data-popup-open", "");
  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  await nudge(KEY);
  await advance(5000);
  assert.equal(reads.length, 3, "a hover card or menu of it is open");
  await act(async () => { button.removeAttribute("data-popup-open"); });
  await advance(0);
  assert.equal(reads.length, 4, "read once it closes");

  const viewKey = linkCardViewKey(card(URL_A).view!, URL_A);
  act(() => useLinkCardActionStore.setState({ views: { [viewKey]: { busy: "confirming" } } }));
  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  await nudge(KEY);
  await advance(5000);
  assert.equal(reads.length, 4, "Raft's confirm dialog is open on it");
  act(() => useLinkCardActionStore.setState({ views: {} }));
  await advance(0);
  assert.equal(reads.length, 5, "read once it closes");
});

test("a nudge's answer with no card keeps the card; the person's own Refresh shows it gone", async () => {
  const { card, hook } = mount();
  await advance(0);
  for (const [answer, what] of [[() => null, "no item (a plain link, access lost)"], [(url: string) => ({ ...item(url), preview: { version: 2, display: "connect_account", connect_url: "https://stamp.example.test/connect" } }), "connect_account"]] as const) {
    answerOne = answer;
    await nudge(KEY);
    await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
    assert.equal(card(URL_A).title, "Waiting to merge", what);
  }
  api.post = vi.fn(async () => { throw new Error("offline"); }) as never;
  await nudge(KEY);
  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  assert.equal(card(URL_A).title, "Waiting to merge", "a failed read");
  vi.restoreAllMocks();
  vi.spyOn(api, "post").mockImplementation(async () => ({ data: { items: [] } }) as never);
  await act(async () => { await card(URL_A).view!.reread(URL_A); });
  assert.equal(hook.result.current.results.get(URL_A), undefined, "Refresh: the author's link");
});

test("a busy card or one with an operation open is left to it; a rate_limited answer goes again within the view's LINK_CARD_READ_RETRIES", async () => {
  const { card } = mount();
  await advance(0);
  const viewKey = linkCardViewKey(card(URL_A).view!, URL_A);
  act(() => useLinkCardActionStore.setState({ views: { [viewKey]: { operation: { id: "op-1", state: "sent" } } } }));
  await nudge(KEY);
  await advance(3000);
  assert.equal(reads.length, 1, "an operation open: its end reads the card");
  act(() => useLinkCardActionStore.setState({ views: { [viewKey]: { busy: "executing" } } }));
  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  await nudge(KEY);
  await advance(3000);
  assert.equal(reads.length, 1, "busy: left to the press");
  act(() => useLinkCardActionStore.setState({ views: {} }));

  answerOne = (url) => ({ kind: "rate_limited", url, retry_after: 1 });
  await advance(LINK_CARD_CHANGED_MIN_INTERVAL_MS);
  await nudge(KEY);
  await advance(120_000);
  assert.equal(reads.length, 2 + LINK_CARD_READ_RETRIES, "the nudge's read, then the view's rate-limited re-reads");
  assert.equal(card(URL_A).title, "Waiting to merge", "the card stays meanwhile");
});

test("a cached answer of a nudged object is shown on the next mount and read again once on screen; one not nudged is not", async () => {
  const first = mount();
  await advance(0);
  first.hook.unmount();
  const again = mount();
  await advance(3000);
  assert.equal(reads.length, 1, "control: the cached answer, no request");
  assert.equal(again.card(URL_A).title, "Waiting to merge");
  again.hook.unmount();

  title = "Merged";
  await nudge(KEY);
  const third = mount();
  assert.equal(third.card(URL_A).title, "Waiting to merge", "the old card shows meanwhile: no plain link");
  await advance(0);
  assert.equal(reads.length, 2);
  assert.equal(reads[1]!.urls, undefined, "the whole message");
  assert.equal(third.card(URL_A).title, "Merged");
});
