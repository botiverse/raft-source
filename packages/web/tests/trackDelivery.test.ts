import assert from "node:assert/strict";
import { flushProductEvents, resetProductEventsForTest, setProductEventServerIdGetter, trackEvent } from "../src/analytics/track";

// trackEvent's onDelivery (for Desktop's migration reports, kept until stored):
// the event goes in a batch of its own, and is "delivered" only when that
// batch's answer says it was accepted (or already taken: a repeated uuid).

const props = { feature: "invite", action: "open" } as const;
let posts: Array<{ url: string; body: { events: Array<{ uuid: string }> } }> = [];
let answer: () => Promise<Response> = async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
let allowed = true;

function install(): void {
  posts = [];
  resetProductEventsForTest(async (url, init) => {
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: allowed }), { status: 200 });
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    return answer();
  });
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => "token", setItem: () => {}, removeItem: () => {} };
  setProductEventServerIdGetter(() => "server-1");
  allowed = true;
  answer = async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  install();
});

afterEach(() => {
  resetProductEventsForTest();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

async function deliver(): Promise<boolean[]> {
  const results: boolean[] = [];
  trackEvent("feature_action", props);
  trackEvent("feature_action", props, { uuid: "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d", onDelivery: (delivered) => results.push(delivered) });
  await flushProductEvents();
  return results;
}

test("accepted: delivered, in a batch of its own, with the caller's uuid", async () => {
  assert.deepEqual(await deliver(), [true]);
  assert.equal(posts.length, 2, "the tracked event alone, the others in their batch");
  assert.deepEqual(posts[0].body.events.map((e) => e.uuid), ["9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d"]);
  assert.equal(posts[1].body.events.length, 1);
});

test("already taken (a repeat): delivered; refused, not stored, failed or gated: not", async () => {
  answer = async () => new Response(JSON.stringify({ accepted: 0, duplicates: 1 }), { status: 202 });
  assert.deepEqual(await deliver(), [true]);
  for (const response of [
    async () => new Response(JSON.stringify({ accepted: 0 }), { status: 202 }),
    async () => new Response("{}", { status: 500 }),
    async () => { throw new Error("offline"); },
  ]) {
    install();
    answer = response;
    assert.deepEqual(await deliver(), [false]);
  }
  install();
  allowed = false;
  assert.deepEqual(await deliver(), [false], "the user or workspace does not share: never sent");
  assert.equal(posts.length, 0);
});

test("signed out: not delivered", async () => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  assert.deepEqual(await deliver(), [false]);
});
