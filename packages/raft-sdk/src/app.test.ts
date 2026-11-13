import assert from "node:assert/strict";
import * as agent from "./agent";
import * as app from "./app";
import { createRaftAppClient, RaftAppError, type RaftAppErrorCode } from "./app";
import * as root from "./index";

const TOKEN = "slock_at_app_sdk_test_token";
const SERVER_A = "95f993fa-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const SERVER_B = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5";

interface Call {
  url: URL;
  method: string;
  headers: Headers;
}

function harness(answer: (url: URL) => Response, options: { baseUrl?: string } = {}) {
  const calls: Call[] = [];
  const raft = createRaftAppClient({
    accessToken: TOKEN,
    ...options,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return answer(url);
    },
  });
  return { raft, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const humanUserinfo = {
  scope: "openid profile email",
  client_id: "vault",
  client_name: "Vault",
  server_id: SERVER_A,
  server_slug: "botiverse",
  sub: "user-1",
  type: "human",
  server_role: "admin",
  preferred_username: "ada",
  name: "Ada",
  avatar_url: null,
  picture: null,
  description: null,
  email: "ada@example.com",
  email_verified: true,
};

async function rejection(promise: Promise<unknown>): Promise<RaftAppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RaftAppError, `expected a RaftAppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

function assertBearerOnly(call: Call | undefined) {
  assert.equal(call?.method, "GET");
  assert.equal(call?.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(call?.headers.get("accept"), "application/json");
}

test("userinfo reads identity from the default base, names no Server, and drops the Server claims", async () => {
  const { raft, calls } = harness(() => json(humanUserinfo));
  const info = await raft.userinfo();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url.toString(), "https://api.raft.build/api/oauth/userinfo");
  assert.equal(calls[0]?.url.searchParams.has("server_id"), false);
  assertBearerOnly(calls[0]);
  assert.deepEqual(info, {
    sub: "user-1",
    type: "human",
    preferred_username: "ada",
    name: "Ada",
    avatar_url: null,
    picture: null,
    description: null,
    email: "ada@example.com",
    email_verified: true,
    scope: "openid profile email",
    client_id: "vault",
    client_name: "Vault",
  });
  for (const claim of ["server_id", "server_slug", "server_role"]) {
    assert.equal(claim in info, false, `${claim} is not identity`);
  }
});

test("userinfo without the email scope has no email fields; an agent login reads as type agent", async () => {
  const { email: _email, email_verified: _verified, ...noEmail } = humanUserinfo;
  const { raft } = harness(() => json({ ...noEmail, type: "agent", sub: "agent-1" }));
  const info = await raft.userinfo();
  assert.equal(info.type, "agent");
  assert.equal(info.sub, "agent-1");
  assert.equal("email" in info, false);
  assert.equal("email_verified" in info, false);
});

test("servers lists exactly id, slug, name and role, with no server_id on the request; a trailing slash on baseUrl is fine", async () => {
  const { raft, calls } = harness(() => json({
    servers: [
      { id: SERVER_A, slug: "botiverse", name: "Botiverse", role: "admin", extra: "dropped" },
      { id: SERVER_B, slug: "raft", name: "Raft", role: "member" },
    ],
  }), { baseUrl: "https://raft.example//" });
  const { servers } = await raft.servers();

  assert.equal(calls[0]?.url.toString(), "https://raft.example/api/oauth/servers");
  assert.equal(calls[0]?.url.searchParams.has("server_id"), false);
  assertBearerOnly(calls[0]);
  assert.deepEqual(servers, [
    { id: SERVER_A, slug: "botiverse", name: "Botiverse", role: "admin" },
    { id: SERVER_B, slug: "raft", name: "Raft", role: "member" },
  ]);
});

test("a refusal from a fetch whose body has no cancel() (node-fetch style) is still a RaftAppError", async () => {
  const bodyWithoutCancel = (status: number) => ({ status, ok: false, headers: new Headers(), body: {}, json: async () => ({}), text: async () => "" }) as unknown as Response;
  for (const [status, code] of [[401, "unauthorized"], [400, "invalid_request"], [500, "http_error"]] as const) {
    const { raft } = harness(() => bodyWithoutCancel(status));
    assert.equal((await rejection(raft.servers())).code, code, String(status));
  }
});

test("429 is rate_limited with retryAfterSeconds from Retry-After (seconds or a date, at least 1), and the body is not read", async () => {
  const limited = (headers: Record<string, string>) => harness(() => new Response("Too many requests, please try again later", { status: 429, headers }));
  const seconds = await rejection(limited({ "retry-after": "23" }).raft.servers());
  assert.equal(seconds.code, "rate_limited");
  assert.equal(seconds.status, 429);
  assert.equal(seconds.retryAfterSeconds, 23);
  assert.equal(seconds.message.includes("Too many requests, please"), false, "the body stays out of the message");
  assert.match(seconds.message, /Retry in 23 seconds/);
  assert.deepEqual(Object.keys(seconds).sort(), ["code", "name", "retryAfterSeconds", "status"], "no body is kept on the error");
  assert.equal((await rejection(limited({ "retry-after": "0" }).raft.servers())).retryAfterSeconds, 1);
  assert.equal((await rejection(limited({}).raft.servers())).retryAfterSeconds, 1);
  assert.equal((await rejection(limited({ "retry-after": "soon" }).raft.servers())).retryAfterSeconds, 1);
  assert.equal((await rejection(limited({ "retry-after": "99999999999999999999999" }).raft.servers())).retryAfterSeconds, 3600, "capped");
  assert.equal((await rejection(limited({ "retry-after": new Date(Date.now() + 30 * 86_400_000).toUTCString() }).raft.servers())).retryAfterSeconds, 3600, "a far date is capped");
  assert.equal((await rejection(limited({ "retry-after": new Date(Date.now() - 60_000).toUTCString() }).raft.servers())).retryAfterSeconds, 1, "a past date");
  const date = new Date(Date.now() + 30_000).toUTCString();
  const fromDate = (await rejection(limited({ "retry-after": date }).raft.forServer(SERVER_A).membership())).retryAfterSeconds!;
  assert.ok(fromDate >= 28 && fromDate <= 31, String(fromDate));
  // Other refusals carry no wait.
  assert.equal((await rejection(harness(() => new Response("x", { status: 500 })).raft.servers())).retryAfterSeconds, undefined);
});

test("an empty servers list is an answer, not an error", async () => {
  const { raft } = harness(() => json({ servers: [] }));
  assert.deepEqual(await raft.servers(), { servers: [] });
});

test("forServer names its Server as server_id exactly once on serverinfo, membership and agents", async () => {
  const { raft, calls } = harness((url) => {
    const path = url.pathname;
    if (path.endsWith("/serverinfo")) {
      return json({ id: SERVER_A, slug: "botiverse", name: "Botiverse", avatar_url: "/a.png", picture: "https://raft.example/a.png", is_paid: true, plan_tier: "paid" });
    }
    if (path.endsWith("/membership")) return json({ id: SERVER_A, slug: "botiverse", name: "Botiverse", role: "owner" });
    return json({ agents: [{ id: "agent-1", handle: "helper", display_name: null, avatar_url: null, picture: null, extra: 1 }] });
  }, { baseUrl: "https://raft.example/" });
  const server = raft.forServer(SERVER_A);
  assert.equal(server.serverId, SERVER_A);

  assert.deepEqual(await server.serverinfo(), {
    id: SERVER_A, slug: "botiverse", name: "Botiverse", avatar_url: "/a.png", picture: "https://raft.example/a.png", is_paid: true, plan_tier: "paid",
  });
  assert.deepEqual(await server.membership(), { id: SERVER_A, slug: "botiverse", name: "Botiverse", role: "owner" });
  assert.deepEqual(await server.agents(), { agents: [{ id: "agent-1", handle: "helper", display_name: null, avatar_url: null, picture: null }] });

  assert.deepEqual(calls.map((call) => call.url.pathname), ["/api/oauth/serverinfo", "/api/oauth/membership", "/api/oauth/agents"]);
  for (const call of calls) {
    assert.deepEqual(call.url.searchParams.getAll("server_id"), [SERVER_A]);
    assert.deepEqual([...call.url.searchParams.keys()], ["server_id"]);
    assertBearerOnly(call);
  }
});

test("serverinfo without the tier fields leaves them absent (unknown), never a default", async () => {
  const { raft } = harness(() => json({ id: SERVER_A, slug: "botiverse", name: "Botiverse", avatar_url: null, picture: null }));
  const info = await raft.forServer(SERVER_A).serverinfo();
  assert.equal("is_paid" in info, false);
  assert.equal("plan_tier" in info, false);
});

test("nothing is cached: every call is a request", async () => {
  const { raft, calls } = harness(() => json({ id: SERVER_A, slug: "botiverse", name: "Botiverse", role: "member" }));
  const server = raft.forServer(SERVER_A);
  await server.membership();
  await server.membership();
  await raft.forServer(SERVER_A).membership();
  assert.equal(calls.length, 3);
});

test("forServer refuses anything that is not a Server id, before any request", () => {
  const { raft, calls } = harness(() => json({}));
  for (const value of ["", "botiverse", SERVER_A.toUpperCase(), ` ${SERVER_A}`, `${SERVER_A}&server_id=${SERVER_B}`, "95f993fa1c2d4e5f8a9b0c1d2e3f4a5b"]) {
    assert.throws(() => raft.forServer(value), (error: unknown) => {
      assert.ok(error instanceof RaftAppError);
      assert.equal(error.code, "invalid_server_id");
      assert.equal(error.status, null);
      assert.match(error.message, /never accepted/);
      return true;
    }, JSON.stringify(value));
  }
  for (const value of [undefined, null, 42]) {
    assert.throws(() => raft.forServer(value as unknown as string), (error: unknown) => error instanceof RaftAppError && error.code === "invalid_server_id");
  }
  assert.equal(calls.length, 0, "no request was made");
});

const refusals: Array<{ status: number; body: unknown; code: RaftAppErrorCode }> = [
  { status: 401, body: { error: "Invalid or expired access token" }, code: "unauthorized" },
  { status: 401, body: { error: "Missing bearer token" }, code: "unauthorized" },
  { status: 400, body: { error: "invalid_request", error_description: "server_id is required" }, code: "invalid_request" },
  { status: 403, body: { error: "server_access_denied", error_description: "This token cannot be used for this request on that Server." }, code: "server_access_denied" },
  { status: 403, body: { error: "agent token required" }, code: "http_error" },
  { status: 404, body: { error: "Not found" }, code: "http_error" },
  { status: 500, body: { error: "Failed to load membership" }, code: "http_error" },
];

for (const { status, body, code } of refusals) {
  test(`a ${status} ${JSON.stringify(body)} is ${code}, with the SDK's own message`, async () => {
    const { raft } = harness(() => json(body, status));
    const error = await rejection(raft.forServer(SERVER_A).membership());
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.name, "RaftAppError");
    const text = `${error.message} ${String(error)} ${JSON.stringify(error)}`;
    assert.equal(text.includes(TOKEN), false, "the token never reaches the error");
    assert.equal(text.includes(SERVER_A), false, "the error never names a Server");
    if (typeof body === "object" && body !== null && "error_description" in body) {
      assert.equal(text.includes(String(body.error_description)), false, "the body's description never reaches the error");
    }
  });
}

test("a 403 body never reaches the message beyond the code", async () => {
  const leak = "botiverse 95f993fa secret detail";
  const { raft } = harness(() => json({ error: "server_access_denied", error_description: leak, server: { slug: "botiverse" } }, 403));
  const error = await rejection(raft.forServer(SERVER_B).serverinfo());
  assert.equal(error.code, "server_access_denied");
  assert.match(error.message, /cannot be used for \/api\/oauth\/serverinfo on that Server/);
  assert.match(error.message, /server_access_denied/);
  for (const piece of ["botiverse", "95f993fa", "secret", SERVER_B]) {
    assert.equal(error.message.includes(piece), false, `message leaks ${piece}`);
  }
  assert.deepEqual(Object.keys(error).sort(), ["code", "name", "status"], "no body is kept on the error");
});

test("a 403 or 401 with a non-JSON body still maps by status", async () => {
  const forbidden = harness(() => new Response("<html>blocked</html>", { status: 403 }));
  assert.equal((await rejection(forbidden.raft.servers())).code, "http_error");
  const unauthorized = harness(() => new Response("nope", { status: 401 }));
  assert.equal((await rejection(unauthorized.raft.userinfo())).code, "unauthorized");
});

test("a success that is not the documented shape is invalid_response", async () => {
  const client = (body: Response) => harness(() => body).raft;
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["non-JSON", () => client(new Response("<html></html>", { status: 200 })).servers()],
    ["servers not a list", () => client(json({ servers: {} })).servers()],
    ["a slug as a Server id", () => client(json({ servers: [{ id: "botiverse", slug: "botiverse", name: "B", role: "member" }] })).servers()],
    ["a missing role", () => client(json({ servers: [{ id: SERVER_A, slug: "b", name: "B" }] })).servers()],
    ["an empty role", () => client(json({ id: SERVER_A, slug: "b", name: "B", role: "" })).forServer(SERVER_A).membership()],
    ["userinfo without sub", () => client(json({ ...humanUserinfo, sub: "" })).userinfo()],
    ["userinfo without type", () => client(json({ ...humanUserinfo, type: undefined })).userinfo()],
    ["agents not a list", () => client(json({ agents: null })).forServer(SERVER_A).agents()],
  ];
  for (const [label, call] of cases) {
    const error = await rejection(call());
    assert.equal(error.code, "invalid_response", label);
    assert.equal(error.status, null, label);
  }
});

test("a role or principal type Raft adds later passes through instead of failing the call", async () => {
  const { raft } = harness((url) => {
    if (url.pathname.endsWith("/userinfo")) return json({ ...humanUserinfo, type: "app_bot" });
    if (url.pathname.endsWith("/membership")) return json({ id: SERVER_A, slug: "botiverse", name: "Botiverse", role: "auditor" });
    return json({ servers: [
      { id: SERVER_A, slug: "botiverse", name: "Botiverse", role: "auditor" },
      { id: SERVER_B, slug: "raft", name: "Raft", role: "member" },
    ] });
  });
  const { servers } = await raft.servers();
  assert.deepEqual(servers.map((server) => server.role), ["auditor", "member"]);
  assert.equal((await raft.forServer(SERVER_A).membership()).role, "auditor");
  assert.equal((await raft.userinfo()).type, "app_bot");
});

test("an answer about another Server than the one bound is refused", async () => {
  const { raft } = harness((url) => url.pathname.endsWith("/membership")
    ? json({ id: SERVER_B, slug: "raft", name: "Raft", role: "admin" })
    : json({ id: SERVER_B, slug: "raft", name: "Raft", avatar_url: null, picture: null }));
  const server = raft.forServer(SERVER_A);
  assert.equal((await rejection(server.membership())).code, "invalid_response");
  assert.equal((await rejection(server.serverinfo())).code, "invalid_response");
});

test("a fetch that throws is network_error, with the original as cause and no token in the message", async () => {
  const cause = new TypeError("fetch failed");
  const raft = createRaftAppClient({ accessToken: TOKEN, fetch: async () => { throw cause; } });
  const error = await rejection(raft.userinfo());
  assert.equal(error.code, "network_error");
  assert.equal(error.status, null);
  assert.equal(error.cause, cause);
  assert.equal(error.message.includes(TOKEN), false);
});

test("createRaftAppClient refuses unusable options before any request", () => {
  const fetch = async () => json({});
  const bad: Array<[string, unknown]> = [
    ["no token", { fetch }],
    ["empty token", { accessToken: "", fetch }],
    ["token with a newline", { accessToken: `${TOKEN}\nx-injected: 1`, fetch }],
    ["relative baseUrl", { accessToken: TOKEN, baseUrl: "/api", fetch }],
    ["non-HTTP baseUrl", { accessToken: TOKEN, baseUrl: "ftp://raft.example", fetch }],
    ["baseUrl with credentials", { accessToken: TOKEN, baseUrl: "https://user:pw@raft.example", fetch }],
    ["baseUrl with a query", { accessToken: TOKEN, baseUrl: "https://raft.example/?server_id=x", fetch }],
    ["plain HTTP to another host", { accessToken: TOKEN, baseUrl: "http://raft.example", fetch }],
    ["plain HTTP to a LAN address", { accessToken: TOKEN, baseUrl: "http://192.168.1.10:8080", fetch }],
    ["plain HTTP to a look-alike host", { accessToken: TOKEN, baseUrl: "http://localhost.raft.example", fetch }],
  ];
  for (const [label, options] of bad) {
    assert.throws(
      () => createRaftAppClient(options as Parameters<typeof createRaftAppClient>[0]),
      (error: unknown) => {
        assert.ok(error instanceof RaftAppError, label);
        assert.equal(error.code, "invalid_options", label);
        assert.equal(error.message.includes(TOKEN), false, label);
        return true;
      },
    );
  }
});

test("plain HTTP is allowed only to this machine, and no request follows a redirect", async () => {
  for (const baseUrl of ["http://localhost:3000", "http://127.0.0.1:8787", "http://[::1]:3000"]) {
    const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const raft = createRaftAppClient({
      accessToken: TOKEN,
      baseUrl,
      fetch: async (input, init) => {
        seen.push({ url: String(input), redirect: init?.redirect });
        return json({ servers: [] });
      },
    });
    await raft.servers();
    assert.equal(seen.length, 1, baseUrl);
    assert.ok(seen[0]!.url.startsWith(`${baseUrl}/api/oauth/servers`), seen[0]!.url);
    assert.equal(seen[0]!.redirect, "error", baseUrl);
  }
});

test("the client holds the token out of sight: not a property, not in its JSON", () => {
  const { raft } = harness(() => json({}));
  const server = raft.forServer(SERVER_A);
  for (const value of [raft, server]) {
    assert.equal(JSON.stringify(value).includes(TOKEN), false);
    assert.equal(Object.values(value).some((v) => v === TOKEN), false);
  }
  assert.deepEqual(Object.keys(raft).sort(), ["forServer", "servers", "userinfo"], "no Server method on the top-level client");
  assert.deepEqual(Object.keys(server).sort(), ["agents", "membership", "serverId", "serverinfo"]);
  assert.equal(Object.isFrozen(raft), true);
  assert.equal(Object.isFrozen(server), true);
});

test("./app is its own entry: the root and ./agent export none of it, and it exports nothing of theirs", () => {
  for (const name of ["createRaftAppClient", "RaftAppError"]) {
    assert.equal(name in app, true, `${name} on ./app`);
    assert.equal(name in root, false, `${name} not on the root`);
    assert.equal(name in agent, false, `${name} not on ./agent`);
  }
  assert.deepEqual(Object.keys(app).sort(), ["RaftAppError", "createRaftAppClient"]);
  assert.equal("asServerId" in app, false, "the unchecked brand cast stays internal");
});
