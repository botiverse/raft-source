import "./helpers/domSetup";

import assert from "node:assert/strict";
import { RuntimeAuthClient, runtimeAuthRequestError } from "../src/utils/runtimeAuthClient";

// #otter-lounge:#1: the edge closes a request that sends nothing for 30 s, so a
// Claude limit-reset read or redeem asks for `respondAsync` and reads its answer.
function client(steps: Array<unknown>) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const gets: string[] = [];
  let now = 0;
  const http = {
    post: async <T,>(url: string, body?: unknown) => {
      posts.push({ url, body });
      return steps.shift() as T;
    },
    get: async <T,>(url: string) => {
      gets.push(url);
      const next = steps.shift();
      if (next instanceof Error) throw next;
      return next as T;
    },
  };
  const socket = { current: () => null, onReplaced: () => () => {} };
  const sleep = async (ms: number) => { now += ms; };
  return { posts, gets, client: new RuntimeAuthClient(http as never, socket as never, () => now, sleep) };
}

const OP = "11111111-2222-4333-8444-555555555555";
const read = { result: { kind: "unsupported", reason: "consent_required" } };

test("a read asks for respondAsync and returns the operation's answer once done", async () => {
  const t = client([{ operationId: OP }, { state: "pending" }, Object.assign(new Error("blip"), { response: { status: 502 } }), { state: "done", status: 200, body: read }]);
  assert.deepEqual(await t.client.readLimitResets("s1", "m1", false), read.result);
  assert.deepEqual(t.posts[0]!.body, { onboardingRequiredReason: true, respondAsync: true });
  assert.deepEqual(t.gets, Array(3).fill(`/servers/s1/machine-operations/${OP}`), "a blip reads again");
});

test("an older server's direct answer is used as is", async () => {
  const t = client([read]);
  assert.deepEqual(await t.client.readLimitResets("s1", "m1", true), read.result);
  assert.equal(t.gets.length, 0);
});

test("a failed operation throws as the HTTP error would; no answer in time throws with no response", async () => {
  const failed = client([{ operationId: OP }, { state: "done", status: 504, body: { code: "computer_timeout", error: "late" } }]);
  const error = await failed.client.redeemLimitReset("s1", "m1", "claude", "key-1234567890abcdef" as never, "weekly").catch((e: unknown) => e);
  assert.deepEqual(runtimeAuthRequestError(error), { status: 504, code: "computer_timeout" });

  const late = client([{ operationId: OP }, ...Array(200).fill({ state: "pending" })]);
  const never = await late.client.readLimitResets("s1", "m1", false).catch((e: unknown) => e);
  assert.deepEqual(runtimeAuthRequestError(never), { status: null, code: null }, "outcome never learned");

  const gone = client([{ operationId: OP }, Object.assign(new Error("gone"), { response: { status: 404 } })]);
  assert.equal(runtimeAuthRequestError(await gone.client.readLimitResets("s1", "m1", false).catch((e: unknown) => e)).status, null);
});
