import assert from "node:assert/strict";
import axios from "axios";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { RAFT_CLIENT_VERSION_HEADER } from "@botiverse/raft-shared";

// The page the boot script and the API client run on (RUNTIME_API_BASE reads the origin at import).
const PAGE = "https://app.raft.build";
Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(`${PAGE}/s/acme/channel/c1`) });

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

const {
  BOOT_HINTS_SCRIPT, BOOT_PREFETCH_CONFIG_ID, BOOT_ROOT_CONVERSATION_PREFIX, BOOT_ROOT_REDIRECT_MEDIA_QUERY, BOOT_SCROLL_MEMORY_PREFIX, BOOT_SERVER_THEME_STORAGE_PREFIX,
} = await import("../src/boot/bootInlineScript");
const { BOOT_FETCH_TAKE_WITHIN_MS, __resetBootFetchesForTest, bootSentHistoryRead } = await import("../src/boot/bootPrefetch");
const { default: api } = await import("../src/api/client");
const { CHANNEL_DETAIL_REASON_HEADER } = await import("../src/store/channelDetailReason");
const { WEB_APP_VERSION } = await import("../src/utils/webAppVersion");
const { clientRequestHeaders } = await import("../src/utils/clientPlatformHint");
const { __setWebHttpClientTraceSinkForTest } = await import("../src/utils/webHttpClientTrace");

const SERVER_ID = "0b6f3c2e-1d5a-4e8b-9c7f-2a4d6e8f0a1b";
const CHANNEL_ID = "5f1e9a3c-7b2d-4c6e-8a0f-1d3b5c7e9f2a";

function jwt(expSecondsFromNow: number): string {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u1", type: "access", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

interface SentRequest { url: string; headers: Record<string, string> }

/** A fetch whose answers the test gives: by path (after the API base), 200 JSON unless said otherwise. */
function fakeFetch(answers: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }> = {}) {
  const sent: SentRequest[] = [];
  const fetch = (url: string, init: { headers: Record<string, string> }) => {
    sent.push({ url, headers: init.headers });
    const answer = answers[url.slice(`${PAGE}/api`.length)] ?? {};
    return Promise.resolve(new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", ...answer.headers },
    }));
  };
  return { sent, fetch };
}

/** The inline boot script on a page with the build's prefetch config, as the browser runs it. */
function runBootScript(path: string, options: {
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  session?: Record<string, string>;
  config?: unknown;
  target?: Record<string, unknown>;
  /** The window is as wide as DefaultRoute's redirect needs. */
  wide?: boolean;
}) {
  const url = new URL(path, PAGE);
  const config = options.config === undefined ? { api: "/api", version: WEB_APP_VERSION } : options.config;
  const document = {
    documentElement: { classList: { add: () => {} }, dataset: {}, style: { setProperty: () => {} }, setAttribute: () => {} },
    getElementById: (id: string) => (id === BOOT_PREFETCH_CONFIG_ID && config !== null ? { textContent: JSON.stringify(config) } : null),
    createElement: () => ({}),
    head: { appendChild: () => {} },
  };
  const sessionStorage = { getItem: (key: string) => options.session?.[key] ?? null };
  const matchMedia = (query: string) => ({ matches: options.wide === true && query === BOOT_ROOT_REDIRECT_MEDIA_QUERY });
  new Function("document", "localStorage", "location", "navigator", "window", "fetch", "sessionStorage", "matchMedia", BOOT_HINTS_SCRIPT)(
    document, storage, url, { languages: [] }, options.target ?? globalThis, options.fetch, sessionStorage, matchMedia,
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const paths = (sent: SentRequest[]) => sent.map((request) => request.url.slice(`${PAGE}/api`.length));

/** The network under the API client: every request that really goes out. */
let network: string[] = [];
let networkAnswer: (config: InternalAxiosRequestConfig) => { status: number; data: unknown } = () => ({ status: 200, data: "{\"from\":\"network\"}" });

beforeEach(() => {
  storage.clear();
  __resetBootFetchesForTest();
  network = [];
  networkAnswer = () => ({ status: 200, data: "{\"from\":\"network\"}" });
  const adapter: AxiosAdapter = async (config) => {
    network.push(api.getUri(config).slice(`${PAGE}/api`.length));
    const { status, data } = networkAnswer(config);
    const response = { data, status, statusText: "", headers: {}, config, request: {} };
    if (status >= 400) throw Object.assign(new axios.AxiosError(`status ${status}`, "ERR_BAD_REQUEST", config, {}, response), { response });
    return response;
  };
  vi.spyOn(axios, "getAdapter").mockReturnValue(adapter);
});

describe("the boot script's prefetch", () => {
  test("a conversation link with a stored token sends the first screen's reads at once, with the API client's headers", () => {
    storage.setItem("slock_access_token", jwt(600));
    storage.setItem(`${BOOT_SERVER_THEME_STORAGE_PREFIX}${SERVER_ID}`, JSON.stringify({ theme: "raft", slug: "acme" }));
    const { sent, fetch } = fakeFetch();
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch, target: {} });
    assert.deepEqual(paths(sent), [
      "/auth/me",
      "/servers",
      `/channels/${CHANNEL_ID}`,
      `/messages/channel/${CHANNEL_ID}?limit=50`,
      "/channels?archived=include",
      "/channels/dm",
      `/servers/${SERVER_ID}/sidebar-order`,
      `/servers/${SERVER_ID}/members`,
    ]);
    const { traceparent, ...me } = sent[0].headers;
    assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    assert.deepEqual(me, {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${storage.getItem("slock_access_token")}`,
      ...clientRequestHeaders(),
    }, "the same client headers as client.ts");
    assert.equal(sent[2].headers["X-Server-Id"], SERVER_ID);
    assert.equal(sent[2].headers[CHANNEL_DETAIL_REASON_HEADER], "preload", "as preloadServerRoute asks for it");
    assert.equal(sent[0].headers["X-Server-Id"], undefined);
    assert.equal(RAFT_CLIENT_VERSION_HEADER, "X-Raft-Client-Version");
  });

  test("without the server's id on the device, its reads go out as soon as the boot's server list answers", async () => {
    storage.setItem("slock_access_token", jwt(600));
    const { sent, fetch } = fakeFetch({ "/servers": { body: [{ id: SERVER_ID, slug: "acme" }] } });
    runBootScript(`/s/acme/dm/${CHANNEL_ID}`, { fetch, target: {} });
    assert.deepEqual(paths(sent), ["/auth/me", "/servers"]);
    await flush();
    assert.deepEqual(paths(sent).slice(2, 4), [`/channels/${CHANNEL_ID}`, `/messages/channel/${CHANNEL_ID}?limit=50`]);
    assert.equal(sent.at(-1)?.headers["X-Server-Id"], SERVER_ID);
  });

  test("nothing without a usable token, off a conversation, without the build's config, or on a sign-in callback", () => {
    const { sent, fetch } = fakeFetch();
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch, target: {} });
    assert.deepEqual(sent, [], "no token");
    storage.setItem("slock_access_token", jwt(-60));
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch, target: {} });
    assert.deepEqual(sent, [], "expired: the app refreshes first");
    storage.setItem("slock_access_token", jwt(600));
    for (const path of ["/", "/s/acme", "/s/acme/channel", "/s/acme/settings/billing", "/s/acme/agent/a1", "/login", `/s/acme/channel/${CHANNEL_ID}/search`]) {
      runBootScript(path, { fetch, target: {} });
    }
    assert.deepEqual(sent, [], "not a conversation link");
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch, target: {}, config: null });
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch, target: {}, config: { api: "https://evil.example/x", version: "1" } });
    runBootScript(`/s/acme/channel/${CHANNEL_ID}?auth_callback=1`, { fetch, target: {} });
    runBootScript(`/s/acme/channel/${CHANNEL_ID}?embed=raft-settings-v1&shell=host`, { fetch, target: {} });
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch, target: { raftDesktop: {} } });
    assert.deepEqual(sent, [], "no config, an API that isn't one, a callback, a host-shell embed, Raft Desktop");
  });

  test("a thread or message link, or a remembered scroll position, gets no latest page", () => {
    storage.setItem("slock_access_token", jwt(600));
    storage.setItem(`${BOOT_SERVER_THEME_STORAGE_PREFIX}${SERVER_ID}`, JSON.stringify({ theme: "raft", slug: "acme" }));
    const { sent, fetch } = fakeFetch();
    runBootScript(`/s/acme/channel/${CHANNEL_ID}?thread=${CHANNEL_ID}:m1`, { fetch, target: {} });
    runBootScript(`/s/acme/channel/${CHANNEL_ID}?msg=m1`, { fetch, target: {} });
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch, target: {}, session: { [`${BOOT_SCROLL_MEMORY_PREFIX}${CHANNEL_ID}`]: "m9" } });
    assert.equal(paths(sent).filter((path) => path.startsWith("/messages/")).length, 0);
    assert.equal(paths(sent).filter((path) => path === `/channels/${CHANNEL_ID}`).length, 3, "the conversation itself still goes");
  });
});

describe("on the server's root", () => {
  const GUESS_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const REAL_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

  function rememberedRoot(userId = "u1") {
    storage.setItem("slock_access_token", jwt(600));
    storage.setItem(`${BOOT_SERVER_THEME_STORAGE_PREFIX}${SERVER_ID}`, JSON.stringify({ theme: "raft", slug: "acme" }));
    storage.setItem(`${BOOT_ROOT_CONVERSATION_PREFIX}${userId}:${SERVER_ID}`, GUESS_ID);
  }

  test("sends the reads of the conversation it last landed on, as for a link to it", () => {
    rememberedRoot();
    for (const path of ["/s/acme", "/s/acme/"]) {
      const { sent, fetch } = fakeFetch();
      runBootScript(path, { fetch, target: {}, wide: true });
      assert.deepEqual(paths(sent), [
        "/auth/me",
        "/servers",
        `/channels/${GUESS_ID}`,
        `/messages/channel/${GUESS_ID}?limit=50`,
        "/channels?archived=include",
        "/channels/dm",
        `/servers/${SERVER_ID}/sidebar-order`,
        `/servers/${SERVER_ID}/members`,
      ], path);
      assert.equal(sent[2].headers[CHANNEL_DETAIL_REASON_HEADER], "preload");
    }
  });

  test("nothing, as before, without a remembered conversation for this person, where the root doesn't redirect, or without the server's id on the device", () => {
    const { sent, fetch } = fakeFetch({ "/servers": { body: [{ id: SERVER_ID, slug: "acme" }] } });
    storage.setItem("slock_access_token", jwt(600));
    storage.setItem(`${BOOT_SERVER_THEME_STORAGE_PREFIX}${SERVER_ID}`, JSON.stringify({ theme: "raft", slug: "acme" }));
    runBootScript("/s/acme", { fetch, target: {}, wide: true });
    assert.deepEqual(sent, [], "no conversation remembered");
    rememberedRoot("someone-else");
    runBootScript("/s/acme", { fetch, target: {}, wide: true });
    assert.deepEqual(sent, [], "another person's");
    rememberedRoot();
    runBootScript("/s/acme", { fetch, target: {} });
    assert.deepEqual(sent, [], "a phone's root shows its Home: no redirect to guess for");
    storage.removeItem(`${BOOT_SERVER_THEME_STORAGE_PREFIX}${SERVER_ID}`);
    runBootScript("/s/acme", { fetch, target: {}, wide: true });
    assert.deepEqual(sent, [], "no server id on the device");
    rememberedRoot();
    storage.setItem(`${BOOT_ROOT_CONVERSATION_PREFIX}u1:${SERVER_ID}`, "../x");
    runBootScript("/s/acme", { fetch, target: {}, wide: true });
    assert.deepEqual(sent, [], "not a conversation id");
  });

  test("a guess the list lands on is taken; one it doesn't land on is never taken, and the real conversation is asked for", async () => {
    rememberedRoot();
    runBootScript("/s/acme", { fetch: fakeFetch({ [`/messages/channel/${GUESS_ID}?limit=50`]: { body: { messages: ["guessed"] } } }).fetch, wide: true });
    const real = await api.get(`/messages/channel/${REAL_ID}?limit=50`, { headers: { "X-Server-Id": SERVER_ID } });
    assert.deepEqual(real.data, { from: "network" });
    assert.deepEqual(network, [`/messages/channel/${REAL_ID}?limit=50`]);
    const guessed = await api.get(`/messages/channel/${GUESS_ID}?limit=50`, { headers: { "X-Server-Id": SERVER_ID } });
    assert.deepEqual(guessed.data, { messages: ["guessed"] }, "the guessed page is kept for its own request only");
    assert.equal(network.length, 1);
  });

  test("a guess that is gone (404) is never surfaced: the app's request goes out", async () => {
    rememberedRoot();
    runBootScript("/s/acme", { fetch: fakeFetch({ [`/channels/${GUESS_ID}`]: { status: 404, body: { error: "Channel not found" } } }).fetch, wide: true });
    const { data } = await api.get(`/channels/${GUESS_ID}`, { headers: { "X-Server-Id": SERVER_ID, [CHANNEL_DETAIL_REASON_HEADER]: "preload" } });
    assert.deepEqual(data, { from: "network" });
    assert.deepEqual(network, [`/channels/${GUESS_ID}`]);
  });
});

describe("the API client adopts it", () => {
  function bootOnChannel(answers: Parameters<typeof fakeFetch>[0] = {}) {
    storage.setItem("slock_access_token", jwt(600));
    storage.setItem(`${BOOT_SERVER_THEME_STORAGE_PREFIX}${SERVER_ID}`, JSON.stringify({ theme: "raft", slug: "acme" }));
    const boot = fakeFetch(answers);
    runBootScript(`/s/acme/channel/${CHANNEL_ID}`, { fetch: boot.fetch });
    return boot;
  }

  test("one network call per request: the app's request takes the boot answer, once", async () => {
    const boot = bootOnChannel({ "/auth/me": { body: { id: "u1" } } });
    const { data } = await api.get("/auth/me");
    assert.deepEqual(data, { id: "u1" }, "parsed as the network's answer would be");
    assert.deepEqual(network, [], "nothing sent again");
    await api.get("/auth/me");
    assert.deepEqual(network, ["/auth/me"], "taken once: a later read goes out");
    assert.equal(paths(boot.sent).filter((path) => path === "/auth/me").length, 1);
  });

  test("a server-scoped read is taken only with the same server; the answer's headers come along", async () => {
    bootOnChannel({ [`/messages/channel/${CHANNEL_ID}?limit=50`]: { body: { messages: [] }, headers: { "x-sync-horizon": "42" } } });
    const other = await api.get(`/messages/channel/${CHANNEL_ID}?limit=50`, { headers: { "X-Server-Id": "1b6f3c2e-1d5a-4e8b-9c7f-2a4d6e8f0a1b" } });
    assert.deepEqual(other.data, { from: "network" }, "another server: asked itself");
    const same = await api.get(`/messages/channel/${CHANNEL_ID}?limit=50`, { headers: { "X-Server-Id": SERVER_ID } });
    assert.deepEqual(same.data, { messages: [] });
    assert.equal(same.headers.get?.("x-sync-horizon") ?? same.headers["x-sync-horizon"], "42");
    assert.equal(network.length, 1);
    assert.ok(bootSentHistoryRead(), "the socket's starting horizon is refused after a boot history read");
  });

  test("a different header (another token, another reason) is not the same request", async () => {
    bootOnChannel();
    await api.get(`/channels/${CHANNEL_ID}`, { headers: { "X-Server-Id": SERVER_ID, [CHANNEL_DETAIL_REASON_HEADER]: "ensure" } });
    assert.deepEqual(network, [`/channels/${CHANNEL_ID}`]);
    storage.setItem("slock_access_token", jwt(900));
    await api.get("/servers");
    assert.deepEqual(network, [`/channels/${CHANNEL_ID}`, "/servers"]);
  });

  test("a failed or 401 boot answer is never surfaced: the app's own request goes out (and takes the usual 401 path)", async () => {
    bootOnChannel({ "/servers": { status: 500 }, "/auth/me": { status: 401, body: { error: "expired" } } });
    assert.deepEqual((await api.get("/servers")).data, { from: "network" });
    assert.deepEqual((await api.get("/auth/me")).data, { from: "network" });
    assert.deepEqual(network, ["/servers", "/auth/me"]);
  });

  test("an answer that landed more than a few seconds before the app asks is not taken", async () => {
    bootOnChannel();
    await flush();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + BOOT_FETCH_TAKE_WITHIN_MS + 1);
    await api.get("/auth/me");
    assert.deepEqual(network, ["/auth/me"]);
  });

  test("the adopted request's span is in the boot request's trace, from when it went out", async () => {
    const spans: { traceId: string; parentSpanId: string | null; startTimeMs: number }[] = [];
    __setWebHttpClientTraceSinkForTest({ record: (span) => { spans.push({ ...span.context, startTimeMs: span.startTimeMs }); } });
    try {
      const boot = bootOnChannel();
      await api.get("/auth/me");
      const [, traceId, spanId] = boot.sent[0].headers.traceparent.split("-");
      assert.equal(spans.length, 1, "one span: the replaced one is never recorded");
      assert.equal(spans[0].traceId, traceId);
      assert.equal(spans[0].parentSpanId, spanId);
      assert.ok(spans[0].startTimeMs <= Date.now());
    } finally {
      __setWebHttpClientTraceSinkForTest(null);
    }
  });

  test("a request that doesn't read (POST) never takes one", async () => {
    bootOnChannel();
    await api.post("/auth/me");
    assert.deepEqual(network, ["/auth/me"]);
  });
});
