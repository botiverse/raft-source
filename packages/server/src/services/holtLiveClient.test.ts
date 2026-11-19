import { describe, expect, it } from "vitest";
import { createHoltLiveClient, HoltLiveError, resolveHoltLiveConfig, type HoltLiveTransport } from "./holtLiveClient";

/** A fetch that answers each request with the next reply and records what was asked. */
function transport(replies: Array<{ status: number; body?: unknown } | "network">) {
  const seen: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const fetchFn: HoltLiveTransport = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies.shift();
    if (!reply || reply === "network") throw new TypeError("fetch failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetchFn, seen };
}

const config = { baseUrl: "https://live.test", token: "holt_test_secret" };

describe("holt-live client", () => {
  it("signs a room token with the bearer token and maps expiresAt from milliseconds", async () => {
    const t = transport([{ status: 200, body: { url: "wss://lk.test", room: "raft-call-x", identity: "u1", token: "tok", expiresAt: 1_900_000_000_000, relay: "cn" } }]);
    const room = await createHoltLiveClient(config, t.fetchFn).issueRoomToken({ room: "raft-call-x", identity: "u1", name: "Ann", ttlSeconds: 600 });
    expect(room).toEqual({ url: "wss://lk.test", token: "tok", expiresAtMs: 1_900_000_000_000, relay: "cn" });
    expect(t.seen[0]).toEqual({
      url: "https://live.test/v1/rooms/raft-call-x/tokens",
      method: "POST",
      auth: "Bearer holt_test_secret",
      body: { identity: "u1", name: "Ann", ttl_s: 600 },
    });
  });

  it("starts a session with max_minutes and reads session_id", async () => {
    const t = transport([{ status: 201, body: { session_id: "ags_1" } }]);
    const started = await createHoltLiveClient(config, t.fetchFn).startSession({
      room: "r", agent: { id: "agent:s:a", name: "Lily" }, listen: [{ identity: "u1" }], instructions: "hi", tools: [], callback: { url: "https://raft.test/cb", secret: "whsec_x" },
    });
    expect(started).toEqual({ sessionId: "ags_1" });
    expect(t.seen[0]!.url).toBe("https://live.test/v1/agents/sessions");
    expect(t.seen[0]!.body).toMatchObject({ room: "r", max_minutes: 15, callback: { url: "https://raft.test/cb", secret: "whsec_x" } });
  });

  it("says, reports an ended session as ended, and stops (404/409: already gone)", async () => {
    const t = transport([{ status: 200, body: {} }, { status: 409, body: { code: "E_ENDED" } }, { status: 200, body: {} }, { status: 404 }]);
    const client = createHoltLiveClient(config, t.fetchFn);
    expect(await client.say("ags_1", { text: "done", callId: "tc_1" })).toBe("said");
    expect(t.seen[0]).toMatchObject({ url: "https://live.test/v1/agents/sessions/ags_1/say", body: { text: "done", call_id: "tc_1" } });
    expect(await client.say("ags_1", { text: "done", callId: "tc_1" })).toBe("ended");
    expect(await client.stop("ags_1", "caller_hung_up")).toBe("stopped");
    expect(await client.stop("ags_1", "caller_hung_up")).toBe("gone");
  });

  it("fails with the status and code only, never the reply's text", async () => {
    const t = transport([{ status: 429, body: { code: "E_QUOTA", error: "project raft-call over its daily budget of $40" } }, "network", { status: 200, body: { token: "t" } }]);
    const client = createHoltLiveClient(config, t.fetchFn);
    const quota = await client.startSession({ room: "r", agent: { id: "a", name: "n" }, listen: [], instructions: "", tools: [], callback: { url: "u", secret: "s" } }).catch((e: unknown) => e);
    expect(quota).toBeInstanceOf(HoltLiveError);
    expect(quota).toMatchObject({ status: 429, code: "E_QUOTA" });
    expect(String((quota as Error).message)).not.toContain("budget");
    await expect(client.say("ags_1", { text: "x", callId: "c" })).rejects.toMatchObject({ status: 0, code: null });
    await expect(client.issueRoomToken({ room: "r", identity: "u", name: "n", ttlSeconds: 60 })).rejects.toMatchObject({ code: "malformed_reply" });
  });

  it("is configured only with a token and an https origin (http only for a local holt-live)", () => {
    expect(resolveHoltLiveConfig({ HOLT_LIVE_URL: "https://live.test/x", HOLT_LIVE_API_TOKEN: "t" })).toEqual({ baseUrl: "https://live.test", token: "t" });
    expect(resolveHoltLiveConfig({ HOLT_LIVE_URL: "http://live.test", HOLT_LIVE_API_TOKEN: "t" })).toBeNull();
    expect(resolveHoltLiveConfig({ HOLT_LIVE_URL: "http://localhost:8787", HOLT_LIVE_API_TOKEN: "t" })).toEqual({ baseUrl: "http://localhost:8787", token: "t" });
    expect(resolveHoltLiveConfig({ HOLT_LIVE_URL: "https://live.test" })).toBeNull();
    expect(resolveHoltLiveConfig({ HOLT_LIVE_API_TOKEN: "t" })).toBeNull();
  });
});
