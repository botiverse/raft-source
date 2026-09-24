import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { after, before, beforeEach } from "node:test";

type StorageCall = { method: "setItem" | "removeItem"; key: string; value?: string };

class SpyStorage {
  private readonly values = new Map<string, string>();
  readonly calls: StorageCall[] = [];

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.calls.push({ method: "setItem", key, value });
    this.values.set(key, String(value));
  }

  removeItem(key: string) {
    this.calls.push({ method: "removeItem", key });
    this.values.delete(key);
  }

  clear() {
    this.calls.length = 0;
    this.values.clear();
  }
}

type FakeTimer = { at: number; callback: () => void; cancelled: boolean };

class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  readonly setTimeout = ((callback: () => void, delay = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, delay), callback, cancelled: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  readonly clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const timer = this.timers.get(Number(handle));
    if (timer) timer.cancelled = true;
  }) as typeof clearTimeout;

  advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => !timer.cancelled && timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at || 0);
      const next = due[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      if (!timer.cancelled) timer.callback();
    }
    this.now = target;
  }

  pendingCount() {
    return [...this.timers.values()].filter((timer) => !timer.cancelled).length;
  }
}

const storage = new SpyStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(window, "localStorage", { configurable: true, value: storage });

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const clock = new FakeClock();

// Import only after the storage seam exists. The persistence module must also
// discover the DOM lifecycle seam at module initialization.
const {
  DRAFTS_STORAGE_KEY,
  DRAFT_PERSISTENCE_DEBOUNCE_MS,
  DRAFT_PERSISTENCE_MAX_WAIT_MS,
  useMessageStore,
} = await import("../src/store/messageStore.js");

function installClock() {
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  window.setTimeout = clock.setTimeout;
  window.clearTimeout = clock.clearTimeout;
}

function restoreClock() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  window.setTimeout = realSetTimeout;
  window.clearTimeout = realClearTimeout;
}

function reset() {
  // Lifecycle flush is also the public cleanup path: it must cancel every
  // pending timer before the next test starts.
  window.dispatchEvent(new window.Event("pagehide"));
  storage.clear();
  useMessageStore.setState({ drafts: {} });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
}

before(() => installClock());
beforeEach(() => reset());
after(() => restoreClock());

test("rapid draft updates coalesce to one trailing write of the exact latest snapshot", () => {
  const store = useMessageStore.getState();
  for (let i = 0; i < 20; i += 1) store.setDraft("channel-1", `draft-${i}`);

  assert.equal(storage.calls.length, 0, "writes must be deferred until the trailing edge");
  clock.advance(DRAFT_PERSISTENCE_DEBOUNCE_MS - 1);
  assert.equal(storage.calls.length, 0);
  clock.advance(1);

  assert.deepEqual(storage.calls, [{
    method: "setItem",
    key: DRAFTS_STORAGE_KEY,
    value: JSON.stringify({ "channel-1": "draft-19" }),
  }]);
  assert.equal(clock.pendingCount(), 0, "flush must cancel both debounce and maxWait timers");
});

test("hidden and pagehide synchronously flush the latest snapshot before either timer", () => {
  useMessageStore.getState().setDraft("channel-2", "latest");
  clock.advance(Math.max(1, DRAFT_PERSISTENCE_DEBOUNCE_MS - 10));
  assert.equal(storage.calls.length, 0, "the lifecycle event must be the first durable write");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new window.Event("visibilitychange"));

  assert.deepEqual(storage.calls, [{
    method: "setItem",
    key: DRAFTS_STORAGE_KEY,
    value: JSON.stringify({ "channel-2": "latest" }),
  }]);
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(storage.calls.length, 1, "pagehide after hidden must not duplicate a flushed snapshot");
});

test("pagehide synchronously flushes the latest snapshot without a visibility event", () => {
  useMessageStore.getState().setDraft("channel-pagehide", "latest-pagehide");
  assert.equal(storage.calls.length, 0);
  window.dispatchEvent(new window.Event("pagehide"));

  assert.deepEqual(storage.calls, [{
    method: "setItem",
    key: DRAFTS_STORAGE_KEY,
    value: JSON.stringify({ "channel-pagehide": "latest-pagehide" }),
  }]);
});

test("clearDraft overrides a pending snapshot and stale timers cannot resurrect it", () => {
  const store = useMessageStore.getState();
  store.setDraft("channel-3", "to-delete");
  clock.advance(10);
  store.clearDraft("channel-3");
  assert.deepEqual(storage.calls, [{ method: "removeItem", key: DRAFTS_STORAGE_KEY }]);
  clock.advance(DRAFT_PERSISTENCE_MAX_WAIT_MS + DRAFT_PERSISTENCE_DEBOUNCE_MS);

  assert.deepEqual(storage.calls, [{ method: "removeItem", key: DRAFTS_STORAGE_KEY }]);
  assert.equal(storage.getItem(DRAFTS_STORAGE_KEY), null);
  assert.equal(clock.pendingCount(), 0);
});

test("adoptDraftChannel persists only the selected destination and never the stale source", () => {
  const store = useMessageStore.getState();
  store.setDraft("source", "source-draft");
  clock.advance(10);
  store.setDraft("destination", "destination-draft");
  clock.advance(10);
  assert.equal(store.adoptDraftChannel("source", "destination"), "destination-draft");
  assert.deepEqual(storage.calls, [{
    method: "setItem",
    key: DRAFTS_STORAGE_KEY,
    value: JSON.stringify({ destination: "destination-draft" }),
  }]);
  clock.advance(DRAFT_PERSISTENCE_MAX_WAIT_MS + DRAFT_PERSISTENCE_DEBOUNCE_MS);
  assert.equal(storage.calls.length, 1, "stale timers must not restore the source draft");
});

test("maxWait flushes a continuously edited draft even without lifecycle events", () => {
  const store = useMessageStore.getState();
  const step = Math.max(1, Math.floor(DRAFT_PERSISTENCE_DEBOUNCE_MS * 0.75));
  let elapsed = 0;
  let latest = 0;
  store.setDraft("mobile", `draft-${latest}`);
  while (elapsed + step < DRAFT_PERSISTENCE_MAX_WAIT_MS) {
    clock.advance(step);
    elapsed += step;
    latest += 1;
    store.setDraft("mobile", `draft-${latest}`);
  }
  clock.advance(DRAFT_PERSISTENCE_MAX_WAIT_MS - elapsed);

  assert.equal(storage.calls.length, 1, "maxWait must produce a bounded write during continuous input");
  assert.equal(storage.calls[0]?.method, "setItem");
  assert.equal(JSON.parse(storage.calls[0]?.value ?? "{}").mobile, `draft-${latest}`);
});

test("messageStore imports safely when window and document do not exist", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    'delete globalThis.window; delete globalThis.document; await import("./src/store/messageStore.ts");',
  ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
});
