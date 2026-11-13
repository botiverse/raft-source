// Core's agent write budgets on Artifacts' agent API writes
// (services/agentApiWriteLimits.ts, routes/internalAgentApi.ts
// AGENT_API_WRITE_BUDGET_ROUTES), through Artifacts' routes over HTTP with
// real agent credentials: every write but a push's file uploads in
// `artifactWrites`, the uploads in `artifactUploads`; per agent and per server;
// the 429 an agent gets past one (operation, limit, wait, Retry-After); reads
// never counted; uploads refused before their body is read; a publish refused
// before its large body is parsed, and counted once; a review spending one per
// comment, and one larger than a whole budget refused outright. Budgets set
// low by __setAgentApiWriteBudgetsForTests (the harness skips them otherwise);
// the counts are the ones replicas share (Redis; this process's memory here),
// fixedWindowRateLimit.test.ts proves that sharing.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS, parseAgentApiRateLimitedBody } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { __setAgentApiWriteBudgetsForTests } from "../../services/agentApiWriteLimits";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests } from "./blobStore";
import type { ArtifactR2Store } from "./blobStore";
import { artifactComments } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const WRITES = 2;
const UPLOADS = 3;
/** Far above what a test spends: the per-agent budgets are the ones tried, unless a test sets this lower. */
const SERVER_WIDE = 100;
const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-write-limit-tests-hmac-secret-0123456789");
  __setAgentApiWriteBudgetsForTests({ artifactWrites: { perAgent: WRITES, perServer: SERVER_WIDE }, artifactUploads: { perAgent: UPLOADS, perServer: SERVER_WIDE } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
  __setAgentApiWriteBudgetsForTests(null);
});
const label = () => randomUUID().slice(0, 8);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MiB = 1024 * 1024;

function memoryR2(): ArtifactR2Store {
  const objects = new Map<string, Buffer>();
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
    },
    async presign(blob) {
      return `https://r2.example.test/${blob.r2Key}`;
    },
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

/** A server with the flag on: agents A and B in #priv (private), each with a key. */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agentA = await createAgent(server.id, `wl-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentB = await createAgent(server.id, `wl-b-${label()}`, { runtime: "claude", model: "sonnet" });
  const priv = await createChannel(server.id, `priv-${label()}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  await addAgent(priv.id, agentA.id);
  await addAgent(priv.id, agentB.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  __setArtifactR2StoreForTests(memoryR2());
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `wl-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  return { priv, agentA, agentB, keys: { a: await key(agentA.id), b: await key(agentB.id) } };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: any };

/**
 * One request with `body` sent as given and `headers` exactly as given: a
 * declared Content-Length longer than `body` leaves the request unfinished,
 * so it is answered only if the Server never waits for the rest.
 */
function request(baseUrl: string, method: string, path: string, apiKey: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Reply> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: `/internal/agent-api${path}`, headers: { Authorization: `Bearer ${apiKey}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text || null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* the text as is (express's own 400 is HTML) */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
      res.on("error", reject);
    });
    // A refusal that closes the connection may cut off what is still being written; the answer came first.
    req.on("error", reject);
    if (body) req.write(body);
    if (headers["Content-Length"] === undefined || Number(headers["Content-Length"]) === (body?.length ?? 0)) req.end();
  });
}

const json = (app: { baseUrl: string }, method: string, path: string, apiKey: string, body?: unknown) => {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return request(app.baseUrl, method, path, apiKey, bytes, bytes ? { "Content-Type": "application/json", "Content-Length": String(bytes.length) } : {});
};
const upload = (app: { baseUrl: string }, apiKey: string, bytes: Buffer) =>
  request(app.baseUrl, "PUT", `/artifacts/uploads/${sha(bytes)}`, apiKey, bytes, { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) });

/** An artifact in #priv, published by `apiKey` (one of its writes). */
async function createSite(app: { baseUrl: string }, world: World, apiKey: string): Promise<string> {
  const res = await json(app, "POST", "/artifacts/push", apiKey, { target: `#${world.priv.name}`, title: `Site ${label()}`, files: [{ path: "index.html", content: "<h1>home</h1>" }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.artifact.id as string;
}

/** The 429 an agent gets (the body older clients parse): the operation, the limit, the wait (in the sentence and Retry-After). */
function assertLimited(res: Reply, expected: { operation: string; what: string; limit: number; scope?: "agent" | "server" }): void {
  assert.equal(res.status, 429, JSON.stringify(res.body));
  const parsed = parseAgentApiRateLimitedBody(res.body);
  assert.ok(parsed, "the body older clients parse");
  const wait = parsed.details.retryAfterSeconds;
  assert.ok(wait >= 1 && wait <= 60, `retryAfterSeconds ${wait}`);
  const retry = `Retry in ${wait} second${wait === 1 ? "" : "s"}.`;
  assert.equal(res.body.error, expected.scope === "server"
    ? `The agents of this server made too many ${expected.what}: the limit is ${expected.limit} a minute for the whole server. ${retry}`
    : `This agent made too many ${expected.what}: the limit is ${expected.limit} a minute. ${retry}`);
  assert.deepEqual(parsed.details, { operation: expected.operation, limit: expected.limit, windowSeconds: 60, retryAfterSeconds: wait });
  assert.equal(res.body.retryAfterSeconds, wait);
  assert.equal(res.headers["retry-after"], String(wait));
}
const WRITES_NOUN = "artifact changes";
const UPLOADS_NOUN = "artifact file uploads";

test("writes: an agent's comment past its budget is refused 429 with the operation, limit and wait; nothing written; another agent still writes", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // B's write, not A's; A reads it first (others' new version would hold A's comment, UNSEEN_CHANGES).
  const id = await createSite(app, world, world.keys.b);
  assert.equal((await request(app.baseUrl, "GET", `/artifacts/${id}`, world.keys.a)).status, 200);
  for (let i = 0; i < WRITES; i += 1) {
    const res = await json(app, "POST", `/artifacts/${id}/comments`, world.keys.a, { body: `comment ${i}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const limited = await json(app, "POST", `/artifacts/${id}/comments`, world.keys.a, { body: "one too many" });
  assertLimited(limited, { operation: "artifactComment", what: WRITES_NOUN, limit: WRITES });
  const written = await getDb().select().from(artifactComments).where(and(eq(artifactComments.authorType, "agent"), eq(artifactComments.authorId, world.agentA.id)));
  assert.equal(written.length, WRITES, "the refused comment was not written");
  // One budget for every Artifact write but uploads (artifactWrites): following is refused too, by its own name.
  assertLimited(await json(app, "PUT", `/artifacts/${id}/subscription`, world.keys.a), { operation: "artifactSubscribe", what: WRITES_NOUN, limit: WRITES });
  // Per agent: B has used one of its writes (it reads A's comments first).
  assert.equal((await request(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.b)).status, 200);
  const other = await json(app, "POST", `/artifacts/${id}/comments`, world.keys.b, { body: "still mine" });
  assert.equal(other.status, 201, JSON.stringify(other.body));
});

test("reads are never counted: list, read, comments and a file, many times over both budgets, then a write still goes through", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const id = await createSite(app, world, world.keys.b);
  const reads = ["/artifacts", `/artifacts/${id}`, `/artifacts/${id}/comments`, `/artifacts/${id}/files/index.html/content`, `/artifacts/${id}/files/index.html`];
  for (let round = 0; round < WRITES + UPLOADS + 1; round += 1) {
    for (const path of reads) {
      const res = await request(app.baseUrl, "GET", path, world.keys.a);
      assert.equal(res.status, 200, `${path} (round ${round}): ${JSON.stringify(res.body)}`);
    }
  }
  assert.equal((await json(app, "POST", `/artifacts/${id}/comments`, world.keys.a, { body: "after reading" })).status, 201);
});

test("uploads: their own budget, past it refused before the body is read (the connection closed); the writes' budget untouched", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // More uploads than the writes' budget: they don't count against it.
  for (let i = 0; i < UPLOADS; i += 1) {
    const res = await upload(app, world.keys.a, Buffer.from(`file ${i}`));
    assert.equal(res.status, 204, JSON.stringify(res.body));
  }
  // 1 MiB declared, a few bytes sent: the answer comes without the rest.
  const partial = Buffer.from("partial");
  const limited = await request(app.baseUrl, "PUT", `/artifacts/uploads/${sha(Buffer.from("whole"))}`, world.keys.a, partial, { "Content-Type": "application/octet-stream", "Content-Length": String(MiB) });
  assertLimited(limited, { operation: "artifactUpload", what: UPLOADS_NOUN, limit: UPLOADS });
  assert.equal(limited.headers.connection, "close");
  // Every write is still there.
  const id = await createSite(app, world, world.keys.a);
  assert.equal((await json(app, "POST", `/artifacts/${id}/comments`, world.keys.a, { body: "the second write" })).status, 201);
  // Another agent's uploads are its own.
  assert.equal((await upload(app, world.keys.b, Buffer.from("b's file"))).status, 204);
});

test("publish: counted once (ahead of its body's parser), and past the budget refused before the body is parsed or read", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // Two publishes in a budget of two: each counted once, not again at the route.
  const id = await createSite(app, world, world.keys.a);
  const next = await json(app, "POST", "/artifacts/push", world.keys.a, { artifact: id, base: 1, files: [{ path: "index.html", content: "<h1>v2</h1>" }] });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  // Not JSON: a parsed body would be refused 400 as malformed.
  const notJson = Buffer.from("{not json");
  const malformed = await request(app.baseUrl, "POST", "/artifacts/push", world.keys.a, notJson, { "Content-Type": "application/json", "Content-Length": String(notJson.length) });
  assertLimited(malformed, { operation: "artifactPublish", what: WRITES_NOUN, limit: WRITES });
  // 32 MiB declared and a few bytes sent: refused without waiting for the rest, the connection closed.
  const unread = await request(app.baseUrl, "POST", "/artifacts/push", world.keys.a, Buffer.from('{"target":'), { "Content-Type": "application/json", "Content-Length": String(32 * MiB) });
  assertLimited(unread, { operation: "artifactPublish", what: WRITES_NOUN, limit: WRITES });
  assert.equal(unread.headers.connection, "close");
  // B's budget is its own: the same malformed body reaches the parser.
  assert.equal((await request(app.baseUrl, "POST", "/artifacts/push", world.keys.b, notJson, { "Content-Type": "application/json", "Content-Length": String(notJson.length) })).status, 400);
});

test("per server: the agents of one server share each budget; past it the next agent is refused for the whole server", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  __setAgentApiWriteBudgetsForTests({ artifactWrites: { perAgent: SERVER_WIDE, perServer: 3 }, artifactUploads: { perAgent: SERVER_WIDE, perServer: 3 } });
  const id = await createSite(app, world, world.keys.a);
  const subscription = `/artifacts/${id}/subscription`;
  assert.equal((await json(app, "PUT", subscription, world.keys.b)).status, 200);
  assert.equal((await json(app, "DELETE", subscription, world.keys.a)).status, 200);
  assertLimited(await json(app, "DELETE", subscription, world.keys.b), { operation: "artifactUnsubscribe", what: WRITES_NOUN, limit: 3, scope: "server" });
  // The uploads' budget is the server's too, and apart from the writes'.
  assert.equal((await upload(app, world.keys.a, Buffer.from("a1"))).status, 204);
  assert.equal((await upload(app, world.keys.a, Buffer.from("a2"))).status, 204);
  assert.equal((await upload(app, world.keys.b, Buffer.from("b1"))).status, 204);
  assertLimited(await upload(app, world.keys.b, Buffer.from("b2")), { operation: "artifactUpload", what: UPLOADS_NOUN, limit: 3, scope: "server" });
});

test("reviews: one write per comment; past the budget refused with nothing posted; one larger than the whole budget refused outright, spending nothing; one over the comment limit spends one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  __setAgentApiWriteBudgetsForTests({ artifactWrites: { perAgent: 5, perServer: SERVER_WIDE } });
  // B's push, not A's; A reads it first (a review is held by what A hasn't seen).
  const id = await createSite(app, world, world.keys.b);
  assert.equal((await request(app.baseUrl, "GET", `/artifacts/${id}`, world.keys.a)).status, 200);
  const review = (count: number) => json(app, "POST", `/artifacts/${id}/reviews`, world.keys.a, { comments: Array.from({ length: count }, (_, i) => ({ body: `note ${i}` })) });
  const byA = () => getDb().select().from(artifactComments).where(and(eq(artifactComments.authorType, "agent"), eq(artifactComments.authorId, world.agentA.id)));

  // Six comments are more than the agent's whole minute: refused before anything, never charged.
  const tooLarge = await review(6);
  assert.equal(tooLarge.status, 400, JSON.stringify(tooLarge.body));
  assert.equal(tooLarge.body.code, "agent_api_write_too_large");
  assert.equal(tooLarge.body.error, "One review can carry at most 5 comments, each one of this agent's writes; split it into smaller reviews.");
  assert.equal((await byA()).length, 0);

  // More comments than a review may carry: the route's 400 TOO_MANY_COMMENTS, spending one write, not 51 (reverse:
  // charged per comment, it took the whole minute and the agent's next writes got 429).
  const tooMany = await review(AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS + 1);
  assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body));
  assert.equal(tooMany.body.code, "TOO_MANY_COMMENTS");

  // Three (four spent), then three more: the second is past five.
  const first = await review(3);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assertLimited(await review(3), { operation: "artifactReview", what: WRITES_NOUN, limit: 5 });
  assert.equal((await byA()).length, 3, "the refused review posted nothing");
  // Another agent's own budget.
  assert.equal((await request(app.baseUrl, "GET", `/artifacts/${id}/comments`, world.keys.b)).status, 200);
  assert.equal((await json(app, "POST", `/artifacts/${id}/reviews`, world.keys.b, { comments: [{ body: "b1" }, { body: "b2" }, { body: "b3" }, { body: "b4" }] })).status, 201);
});

test("a thread's resolve and reopen (#249): one write each in artifactWrites, past the budget refused with nothing changed", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  __setAgentApiWriteBudgetsForTests({ artifactWrites: { perAgent: 4, perServer: SERVER_WIDE } });
  // A's push and comment (two writes), then a resolve with a note and a reopen (one each, the note included).
  const id = await createSite(app, world, world.keys.a);
  const posted = await json(app, "POST", `/artifacts/${id}/comments`, world.keys.a, { body: "a thread" });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const thread = posted.body.comment.id as string;
  const resolved = await json(app, "POST", `/artifacts/${id}/comments/${thread}/resolve`, world.keys.a, { note: "done" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal((await json(app, "POST", `/artifacts/${id}/comments/${thread}/reopen`, world.keys.a)).status, 200);
  assertLimited(await json(app, "POST", `/artifacts/${id}/comments/${thread}/resolve`, world.keys.a, {}), { operation: "artifactCommentResolve", what: WRITES_NOUN, limit: 4 });
  const [row] = await getDb().select().from(artifactComments).where(eq(artifactComments.id, thread));
  assert.equal(row!.resolvedAt, null, "refused: still open");
});
