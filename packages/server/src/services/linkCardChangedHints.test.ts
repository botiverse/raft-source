import assert from "node:assert/strict";
import { afterEach, beforeEach, vi } from "vitest";
import { asLinkCardObjectRef, type LinkCardObjectKeySha256 } from "@botiverse/raft-shared/src/appLinkPreview";
import { createLinkCardChangedCoalescer, LINK_CARD_CHANGED_WINDOW_MS, parseLinkCardChangedBody, type LinkCardChangedApp } from "./linkCardChangedHints";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";
import {
  __setLinkCardReaderStoreForTests, __settleLinkCardReadersForTests, LINK_CARD_READERS_PER_OBJECT, LINK_CARD_READERS_WINDOW_MS, linkCardObjectKeySha256,
  memoryLinkCardReaderStore, type LinkCardReaderStore,
} from "./linkCardReaders";

// The parts of link_card.changed that need no database: the body, the
// coalescing window (fake timers over the memory store, which the Redis store
// mirrors), the reader store's window and cap, and the partial fan-out budget.
// The endpoint, the read and the sends: routes/linkCardChanged.api.test.ts.

const app: LinkCardChangedApp = { id: "11111111-1111-4111-8111-111111111111", key: "stamp", hints: () => {} };
const key = (ref: string) => linkCardObjectKeySha256(app.id, asLinkCardObjectRef(ref)!);
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-11-20T10:00:00.000Z") });
  __setLinkCardReaderStoreForTests(null);
});
afterEach(async () => {
  await __settleLinkCardReadersForTests();
  __setLinkCardReaderStoreForTests(null);
  vi.useRealTimers();
});

function recordingSends() {
  const sends: { at: number; keys: string[]; trailing: boolean }[] = [];
  const start = Date.now();
  const send = async (_app: LinkCardChangedApp, objectKeys: LinkCardObjectKeySha256[], trailing: boolean) => { sends.push({ at: Date.now() - start, keys: [...objectKeys], trailing }); };
  return { sends, send };
}
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await __settleLinkCardReadersForTests(); };

test("two changes 3 s apart: the first goes at once, exactly one more when the 5-second window ends, then nothing", async () => {
  const { sends, send } = recordingSends();
  const changed = createLinkCardChangedCoalescer({ send });
  await changed(app, [key("pr:1")]);
  assert.deepEqual(sends, [{ at: 0, keys: [key("pr:1")], trailing: false }]);
  await advance(3000);
  await changed(app, [key("pr:1")]);
  assert.equal(sends.length, 1, "inside the window: only marked");
  await advance(1999);
  assert.equal(sends.length, 1);
  await advance(1);
  assert.deepEqual(sends[1], { at: LINK_CARD_CHANGED_WINDOW_MS, keys: [key("pr:1")], trailing: true }, "the trailing one, when the window ends");
  await advance(60_000);
  assert.equal(sends.length, 2, "exactly one trailing send");
});

test("more changes in one window still send one trailing nudge; a lone change sends none; after the window a change goes at once", async () => {
  const { sends, send } = recordingSends();
  const changed = createLinkCardChangedCoalescer({ send });
  await changed(app, [key("pr:1"), key("pr:2")]);
  for (let repeat = 0; repeat < 3; repeat++) { await advance(500); await changed(app, [key("pr:1")]); }
  await advance(LINK_CARD_CHANGED_WINDOW_MS);
  assert.deepEqual(sends.map((send) => [send.keys, send.trailing]), [[[key("pr:1"), key("pr:2")], false], [[key("pr:1")], true]], "pr:2 changed once: no trailing nudge");
  await changed(app, [key("pr:1")]);
  assert.deepEqual(sends.at(-1), { at: 1500 + LINK_CARD_CHANGED_WINDOW_MS, keys: [key("pr:1")], trailing: false }, "a new window, sent at once");
  await advance(LINK_CARD_CHANGED_WINDOW_MS);
  assert.equal(sends.length, 3, "and nothing more without another change");
});

test("across replicas: the window lives in the store, so a change another replica takes inside it is sent once, by the opener", async () => {
  const opener = recordingSends();
  const other = recordingSends();
  const a = createLinkCardChangedCoalescer({ send: opener.send });
  const b = createLinkCardChangedCoalescer({ send: other.send });
  await a(app, [key("pr:1")]);
  await advance(3000);
  await b(app, [key("pr:1")]);
  await advance(2000);
  assert.deepEqual(opener.sends.map((send) => send.trailing), [false, true]);
  assert.deepEqual(other.sends, []);
});

test("an opener that dies holding the window: its trailing nudge is lost, and the window frees itself 2 s after it should have closed", async () => {
  const { sends, send } = recordingSends();
  const changed = createLinkCardChangedCoalescer({ send, schedule: () => {} });  // its close never runs
  await changed(app, [key("pr:1")]);
  await advance(3000);
  await changed(app, [key("pr:1")]);
  await advance(LINK_CARD_CHANGED_WINDOW_MS + 1999 - 3000);
  await changed(app, [key("pr:1")]);
  assert.equal(sends.length, 1, "still inside the stale window");
  await advance(1);
  await changed(app, [key("pr:1")]);
  assert.deepEqual(sends.map((send) => send.trailing), [false, false], "a new window opens and sends at once");
});

test("a store failure while coalescing loses that call's nudges and is logged without the objects; it never throws", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const broken: LinkCardReaderStore = { ...memoryLinkCardReaderStore(), openOrMark: async () => { throw new Error("Redis is reconnecting"); } };
  __setLinkCardReaderStoreForTests(broken);
  const { sends, send } = recordingSends();
  await createLinkCardChangedCoalescer({ send })(app, [key("pr:1")]);
  assert.deepEqual(sends, []);
  const logged = JSON.stringify(warn.mock.calls);
  assert.match(logged, /change window failed/);
  assert.match(logged, /"app_key":"stamp"/);
  assert.ok(!logged.includes(key("pr:1")) && !logged.includes("pr:1"));
  warn.mockRestore();
});

test("the reader store keeps reads of the last 24 hours, at most 1,000 an object, dropping the oldest", async () => {
  const store = memoryLinkCardReaderStore();
  const object = key("pr:1");
  const now = Date.now();
  await store.record([object], "old", now - LINK_CARD_READERS_WINDOW_MS);
  await store.record([object], "recent", now - 1000);
  assert.deepEqual(await store.readers([object], now - LINK_CARD_READERS_WINDOW_MS), [["recent"]], "a read 24 hours ago no longer counts");
  for (let i = 0; i < LINK_CARD_READERS_PER_OBJECT; i++) await store.record([object], `reader-${i}`, now + i);
  const readers = (await store.readers([object], now - LINK_CARD_READERS_WINDOW_MS))[0]!;
  assert.equal(readers.length, LINK_CARD_READERS_PER_OBJECT);
  assert.ok(!readers.includes("recent"), "the oldest went first");
  await store.record([object], "reader-0", now + 5000);
  assert.equal((await store.readers([object], now + 4999))[0]![0], "reader-0", "a new read refreshes the reader");
});

test("the fan-out budget grants part of a batch, and nothing once spent", async () => {
  const counter = createFixedWindowCounter();
  assert.equal(await counter.grant("app", 10, 60, 7), 7);
  assert.equal(await counter.grant("app", 10, 60, 7), 3, "only what is left");
  assert.equal(await counter.grant("app", 10, 60, 1), 0);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(await counter.grant("app", 10, 60, 4), 4, "a new minute");
});

test("the body: strict JSON, only objects, 1-50 object_refs; repeats merged; errors name the field and never echo it", () => {
  assert.deepEqual(parseLinkCardChangedBody(bytes({ objects: ["pr:1", "request:req_abc", "pr:1"] })), { objects: ["pr:1", "request:req_abc"] });
  assert.ok("objects" in parseLinkCardChangedBody(bytes({ objects: ["x".repeat(200), " ~"] })));
  const refusals: [unknown, RegExp][] = [
    [{ objects: [] }, /^objects must be/], [{ objects: Array(51).fill("a") }, /^objects must be/], [{ objects: null }, /^objects must be/],
    [{ objects: ["ok", "\u0007bell"] }, /^objects\[1\]/], [{ objects: ["ok", { ref: 1 }] }, /^objects\[1\]/],
    [{ objects: ["a"], extra: 1 }, /^Only the field objects/], ["[1]", /strict JSON/], ['{"objects":["a"],"objects":["a"]}', /strict JSON/],
  ];
  for (const [body, error] of refusals) {
    const parsed = parseLinkCardChangedBody(bytes(body));
    assert.ok("error" in parsed, JSON.stringify(body));
    assert.match(parsed.error, error);
    assert.ok(!parsed.error.includes("bell"));
  }
  assert.ok("error" in parseLinkCardChangedBody({ objects: ["a"] }), "only raw bytes");
  assert.ok("error" in parseLinkCardChangedBody(new Uint8Array([0x7b, 0xff, 0x7d])), "invalid UTF-8");
});
