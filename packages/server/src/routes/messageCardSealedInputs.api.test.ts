import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import { BasicTracer, MemoryTraceSink, type MessageCardInput, type MessageCardReadAnswer } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import type { Database } from "../db";
import {
  channelHumans, linkCardClientRequests, linkCardOperations, oauthAppLinkPreviews, oauthClients, oauthUserConsents, officialAppRegistry, serverMembers,
} from "../db/schema";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { __resetLinkCardActionLimitsForTests } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests, linkCardRequestSha256 } from "../services/linkCardActionService";
import { __observeLinkCardLiveStateForTests } from "../services/linkCardLiveState";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import { linkCardUrlSha256, signLinkCardHandle, verifyLinkCardHandle } from "../services/linkCardTokens";
import { __setMessageCardActionsSendLimitForTests } from "../services/messageCardActionService";
import { createOAuthClient } from "../services/oauthService";
import { addMember } from "../services/serverService";
import { appAnswer, appBotFixture, clientRequestId, handleFor, statusOf, stubApp, type ActionCall, type AppBotFixture } from "../test/linkCardActionFixture";

// RFC 086 step 2 (§5.3, §5.4), PR C: a card form's values on execute.
// `sealed_inputs` (the SecretInput values, a JWE sealed to the App on the
// person's device) and `inputs` (the TextInput values) ride the execute
// request only: checked against the button's form, forwarded inline to the
// App's action endpoint, never stored, logged, traced, digested or answered.
// The execute JWT carries what the App compares the JWE header with, and the
// sealing side (official App, its key, the handle's kid) is re-checked under
// execute's lock.
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  __setLinkCardActionHooksForTests(null);
  __observeLinkCardLiveStateForTests(null);
  __resetLinkCardActionLimitsForTests();
  __resetLinkCardReadBudgetForTests();
  __setMessageCardActionsSendLimitForTests(null);
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const FORM_CAPABILITIES = ["card.execute.v1", "card.form.v1", "card.form.secret.v1"];
const NAME_FIELD = { type: "TextInput", id: "name", label: "Name", required: true, maxLength: 40 } as const;
const SECRET_FIELD = { type: "SecretInput", id: "value", label: "Value", required: true } as const;
const REASON_FIELD = { type: "TextInput", id: "reason", label: "Reason", maxLength: 60 } as const;
/** Save a new key: a SecretInput behind Raft's confirmation; Deny: an undo-window button asking an optional reason. */
const ACTIONS = {
  approve: { kind: "execute", action_id: "approve", confirm: "prepare", form: { fields: [NAME_FIELD, SECRET_FIELD] } },
  deny: { kind: "execute", action_id: "deny", undoWindowMs: 5000, form: { fields: [REASON_FIELD] } },
} as const;
const PLAIN_ACTIONS = { deny: { kind: "execute", action_id: "deny", undoWindowMs: 5000 } } as const;

/** A value no answer, log, span or row may ever carry; base64url-safe, so it fits inside a JWE compact string. */
const marker = (kind: string) => `${kind}MARK${randomUUID().replace(/-/g, "")}`;
/** A JWE compact string's shape (Raft never reads it) carrying `mark` in its ciphertext. */
const sealedWith = (mark: string) => `aGVhZGVy..aXZpdml2aXY.${mark}.dGFndGFn`;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function keyCard(fx: { origin: string }): MessageCardInput {
  const page = `${fx.origin}/keys/new`;
  return {
    version: 1,
    header: { title: "A new key for builder-bot" },
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["what", "row"] },
      what: { type: "Text", props: { text: "builder-bot needs an API key for the deploy." } },
      row: { type: "Stack", props: { direction: "row" }, children: ["approve", "deny"] },
      approve: { type: "Button", props: { label: "Save", action: { kind: "navigate", url: page } } },
      deny: { type: "Button", props: { label: "Deny", variant: "ghost", action: { kind: "navigate", url: page } } },
    },
  };
}

/** The App's P-256 card encryption key, stored on its registration as the PUT route stores it. */
async function setCardKey(db: Database, fx: AppBotFixture, kid: string) {
  const { x, y } = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" }) as { x: string; y: string };
  await db.update(oauthAppLinkPreviews).set({ cardEncryptionKey: { kty: "EC", crv: "P-256", use: "enc", alg: "ECDH-ES", kid, x, y }, cardEncryptionKid: kid, cardEncryptionKeySetAt: new Date() })
    .where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
}

type Viewer = { id: string; headers: Record<string, string> };
async function person(db: Database, seed: Parameters<typeof appBotFixture>[1], fx: AppBotFixture, channelIds: string[] = [fx.channel.id]): Promise<Viewer> {
  const human = await seed.human();
  await addMember(fx.server.id, human.id);
  for (const channelId of channelIds) await addHuman(channelId, human.id);
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: human.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  return { id: human.id, headers: { Authorization: `Bearer ${await tokenForHuman(human.email)}`, "X-Server-Id": fx.server.id, "Content-Type": "application/json" } };
}

async function sendCard(baseUrl: string, fx: AppBotFixture, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/internal/agent-api/v2/send`, {
    method: "POST", headers: { Authorization: `Bearer ${fx.botKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target: `#${fx.channel.name}`, card: keyCard(fx), actions: ACTIONS, content: "Vault: a new key", ...body }),
  });
  const answer = await res.json() as { messageId?: string };
  assert.equal(res.status, 200, JSON.stringify(answer));
  return answer.messageId!;
}

async function handles(baseUrl: string, viewer: Viewer, messageId: string): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/api/messages/${messageId}/link-cards/read`, {
    method: "POST", headers: viewer.headers, body: JSON.stringify({ view_instance_id: randomUUID(), capabilities: FORM_CAPABILITIES, locale: "en" }),
  });
  const body = await res.json() as { message_card?: MessageCardReadAnswer };
  assert.equal(res.status, 200, JSON.stringify(body));
  return Object.fromEntries((body.message_card?.actions ?? []).map((action) => [action.element_id, action.handle]));
}

/**
 * Watches every place a request could leak to while a test runs: console
 * output (each argument inspected deeply, so an Error's own properties count,
 * such as a JSON parser's `body`), the server's spans, their events and the
 * trace events outside a span, and every answer the test received.
 */
function watch(app: { app: { set: (name: string, value: unknown) => void } }) {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 10, showHidden: true }))).join(" "));
    });
  }
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const answers: string[] = [];
  return { lines, sink, answers };
}
type Watched = ReturnType<typeof watch>;

type Answer = { status: number; text: string; body: Record<string, any> };
async function call(watched: Watched, baseUrl: string, path: string, viewer: Viewer, body: unknown): Promise<Answer> {
  const res = await fetch(`${baseUrl}/api/link-cards/${path}`, { method: "POST", headers: viewer.headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  watched.answers.push(text);
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { /* not JSON */ }
  return { status: res.status, text, body: parsed };
}

/**
 * None of `marks` in a log line, a span, an answer, or any row of any table
 * (link_card_operations, link_card_client_requests, message metadata, audit,
 * everything), nor in what an agent reads of the conversation.
 */
async function assertNowhere(db: Database, baseUrl: string, fx: AppBotFixture, watched: Watched, marks: string[]) {
  const history = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${fx.channel.name}`)}&consume=false`, {
    headers: { Authorization: `Bearer ${fx.botKey}` },
  });
  assert.equal(history.status, 200);
  const places: Record<string, string> = {
    logs: watched.lines.join("\n"), spans: JSON.stringify({ spans: watched.sink.getAllSpans(), events: watched.sink.getAllLogEvents() }), answers: watched.answers.join("\n"), agent: await history.text(),
  };
  for (const mark of marks) {
    for (const [place, text] of Object.entries(places)) assert.ok(!text.includes(mark), `${mark.slice(0, 12)}... found in ${place}`);
  }
  assert.ok(marks.every((mark) => /^[A-Za-z0-9]+$/.test(mark)));
  const tables = await db.execute<{ schema: string; name: string }>(sql`SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
    WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`);
  assert.ok(tables.rows.length > 50, "every table of the database");
  const pattern = marks.join("|");
  for (const { schema, name } of tables.rows) {
    const found = await db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM "${schema}"."${name}" AS t WHERE t::text ~ '${pattern}'`));
    assert.equal(Number(found.rows[0]?.n ?? 0), 0, `a value found in ${schema}.${name}`);
  }
}

/** The App: prepare answers a description, execute `done`; every call recorded. */
function vault() {
  return stubApp((received) => received.body.phase === "prepare"
    ? appAnswer({ status: "prepared", description: {
      prepared_action_id: received.body.prepared_action_id, action_id: received.body.action_id, business_revision: "1", locale: "en",
      read_at: "2026-11-14T08:15:30.120Z", title: "Save a new key for builder-bot", rows: [{ label: "Name", value: "as you type it" }],
      confirm_label: "Save", cancel_label: "Cancel",
    } })
    : appAnswer({ status: "done" }));
}
const executes = (calls: ActionCall[]) => calls.filter((item) => item.body.phase === "execute");

test("happy path: the values are forwarded inline in the one execute request; the JWT names the request the JWE header binds; stored, logged, digested and answered nowhere", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  await setCardKey(db, fx, "vault-1");
  const messageId = await sendCard(app.baseUrl, fx, { for: alice.id });
  const pressable = await handles(app.baseUrl, alice, messageId);
  const watched = watch(app);
  const calls = vault();
  const secret = marker("SECRET");
  const name = marker("NAME");
  const reason = marker("REASON");

  // Prepare (and so the confirmation dialog) never carries the values: refused if present.
  for (const extra of [{ sealed_inputs: sealedWith(secret) }, { inputs: { name } }]) {
    const refused = await call(watched, app.baseUrl, "prepare", alice, { handle: pressable.approve, claimed: { business_revision: "1" }, ...extra });
    assert.deepEqual([refused.status, refused.body], [400, { error: "Invalid link card request", code: "INVALID_REQUEST" }]);
  }
  const prepared = await call(watched, app.baseUrl, "prepare", alice, { handle: pressable.approve, claimed: { business_revision: "1" } });
  assert.equal(prepared.status, 200, prepared.text);
  const [prepareCall] = calls;
  assert.ok(prepareCall && !("sealed_inputs" in prepareCall.body) && !("inputs" in prepareCall.body));

  const requestId = clientRequestId();
  const body = {
    client_request_id: requestId, handle: pressable.approve, prepared_action_id: prepared.body.prepared_action_id, prepared_digest: prepared.body.prepared_digest,
    sealed_inputs: sealedWith(secret), inputs: { name },
  };
  const saved = await call(watched, app.baseUrl, "execute", alice, body);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.state, "done");
  const [sent] = executes(calls);
  assert.ok(sent);
  assert.equal(sent.body.sealed_inputs, sealedWith(secret), "the ciphertext as the device sealed it");
  assert.deepEqual(sent.body.inputs, { name }, "the TextInput values as typed");
  assert.equal(sent.claims.body_sha256, sha256(sent.raw), "covered by the signed body digest");
  // RFC 086 §5.3: what the App compares the JWE protected header with, from the signed claims.
  const claims = verifyLinkCardHandle(pressable.approve!, new Date())!.claims;
  assert.deepEqual({
    sub: sent.claims.sub, server_id: sent.claims.server_id, aud: sent.claims.aud, handle_sha256: sent.claims.handle_sha256, action_id: sent.claims.action_id,
    prepared_action_id: sent.claims.prepared_action_id, prepared_digest: sent.claims.prepared_digest, client_request_id: sent.claims.client_request_id,
    handle_exp: sent.claims.handle_exp,
  }, {
    sub: alice.id, server_id: fx.server.id, aud: `urn:raft:card-action:${fx.client.clientId}`, handle_sha256: sha256(pressable.approve!), action_id: "approve",
    prepared_action_id: prepared.body.prepared_action_id, prepared_digest: prepared.body.prepared_digest, client_request_id: requestId, handle_exp: claims.exp,
  });

  // Recorded: only that there were values. The request digest is the one without them.
  const [op] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, saved.body.operation_id));
  assert.deepEqual([op!.sealedInputsSubmitted, op!.textInputsSubmitted], [true, true]);
  const digest = linkCardRequestSha256({
    urlSha256: linkCardUrlSha256(`${fx.origin}/keys/new`), actionId: "approve", handleSha256: sha256(pressable.approve!),
    prepared: { actionId: prepared.body.prepared_action_id, digest: prepared.body.prepared_digest },
  });
  assert.equal(op!.requestSha256, digest);
  const [mapping] = await db.select().from(linkCardClientRequests).where(eq(linkCardClientRequests.operationId, op!.operationId));
  assert.equal(mapping!.requestSha256, digest);

  // A retry of the same request (the client's LINK_CARD_EXECUTE_RETRY_MS) is recovered; nothing is sent again. Status never sends them either.
  const retried = await call(watched, app.baseUrl, "execute", alice, body);
  assert.deepEqual([retried.status, retried.body.operation_id], [200, saved.body.operation_id]);
  const status = await statusOf(app.baseUrl, alice, { operation_id: saved.body.operation_id });
  watched.answers.push(JSON.stringify(status.body));
  assert.equal(executes(calls).length, 1, "sent once");

  // An undo-window button with a TextInput only: inputs, no sealed_inputs.
  const denied = await call(watched, app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: pressable.deny, inputs: { reason } });
  assert.equal(denied.status, 200, denied.text);
  const deny = executes(calls)[1]!;
  assert.deepEqual(deny.body.inputs, { reason });
  assert.ok(!("sealed_inputs" in deny.body));
  assert.equal(deny.claims.prepared_action_id, undefined, "no confirmation, no prepared claims");
  const [denyOp] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, denied.body.operation_id));
  assert.deepEqual([denyOp!.sealedInputsSubmitted, denyOp!.textInputsSubmitted], [false, true]);

  await assertNowhere(db, app.baseUrl, fx, watched, [secret, name, reason]);
});

test("refusals carry nothing of the values: malformed sealed_inputs (bad JSON, over the cap, wrong type, not a JWE), malformed inputs, values that don't fit the form; the App is never called and nothing is stored", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  await setCardKey(db, fx, "vault-1");
  const messageId = await sendCard(app.baseUrl, fx, { for: alice.id });
  const plainMessage = await sendCard(app.baseUrl, fx, { for: alice.id, actions: PLAIN_ACTIONS });
  const pressable = await handles(app.baseUrl, alice, messageId);
  const plain = await handles(app.baseUrl, alice, plainMessage);
  const watched = watch(app);
  const calls = vault();
  const prepared = await call(watched, app.baseUrl, "prepare", alice, { handle: pressable.approve, claimed: { business_revision: "1" } });
  assert.equal(prepared.status, 200, prepared.text);
  const approve = () => ({
    client_request_id: clientRequestId(), handle: pressable.approve, prepared_action_id: prepared.body.prepared_action_id, prepared_digest: prepared.body.prepared_digest,
  });
  const mark = marker("LEAK");
  const sealed = sealedWith(mark);
  const INVALID = { error: "Invalid link card request", code: "INVALID_REQUEST" };
  const TOO_LARGE = { error: "Link card request too large", code: "INVALID_REQUEST" };
  const FORM_INVALID = { error: "This button's form wasn't sent as it asks. Fill it in again.", code: "FORM_INVALID" };

  const cases: Array<[string, unknown, number, Record<string, string>]> = [
    // Malformed: the parser's and the request schema's refusals.
    ["bad JSON", `{"client_request_id":"${clientRequestId()}","sealed_inputs":"${sealed}",`, 400, INVALID],
    ["bad JSON, the value unquoted", `{"sealed_inputs": ${mark}}`, 400, INVALID],
    ["the whole body over its bound", { ...approve(), sealed_inputs: sealed, inputs: { name: `${mark}${"x".repeat(70 * 1024)}` } }, 413, TOO_LARGE],
    ["sealed_inputs over its cap", { ...approve(), sealed_inputs: `${sealed}${"A".repeat(8 * 1024)}` }, 413, TOO_LARGE],
    ["sealed_inputs over its cap, beside an unknown member", { sealed_inputs: `${sealed}${"A".repeat(8 * 1024)}`, [mark]: mark }, 413, TOO_LARGE],
    ["sealed_inputs an object", { ...approve(), sealed_inputs: { value: mark } }, 400, INVALID],
    ["sealed_inputs an array", { ...approve(), sealed_inputs: [sealed] }, 400, INVALID],
    ["sealed_inputs not a JWE", { ...approve(), sealed_inputs: `sk-live ${mark}` }, 400, INVALID],
    ["inputs not an object", { ...approve(), sealed_inputs: sealed, inputs: [mark] }, 400, INVALID],
    ["an input not a string", { ...approve(), sealed_inputs: sealed, inputs: { name: { value: mark } } }, 400, INVALID],
    ["an input over any TextInput's bound", { ...approve(), sealed_inputs: sealed, inputs: { name: `${mark}${"x".repeat(500)}` } }, 400, INVALID],
    ["an input id that is no field id", { ...approve(), sealed_inputs: sealed, inputs: { [`Bad ${mark}`]: "x" } }, 400, INVALID],
    // Well formed, but not what the button's form asks.
    ["no sealed_inputs for a SecretInput", { ...approve(), inputs: { name: mark } }, 400, FORM_INVALID],
    ["a SecretInput's value in plain text", { ...approve(), sealed_inputs: sealed, inputs: { name: "prod", value: mark } }, 400, FORM_INVALID],
    ["a required TextInput left out", { ...approve(), sealed_inputs: sealed }, 400, FORM_INVALID],
    ["a TextInput over its maxLength", { ...approve(), sealed_inputs: sealed, inputs: { name: `${mark}${"x".repeat(40)}` } }, 400, FORM_INVALID],
    ["a TextInput on two lines", { ...approve(), sealed_inputs: sealed, inputs: { name: `prod\n${mark}` } }, 400, FORM_INVALID],
    ["a field the form doesn't have", { ...approve(), sealed_inputs: sealed, inputs: { name: "prod", other: mark } }, 400, FORM_INVALID],
    ["sealed_inputs on a button without a SecretInput", { client_request_id: clientRequestId(), handle: pressable.deny, sealed_inputs: sealed }, 400, FORM_INVALID],
    ["sealed_inputs on a button without a form", { client_request_id: clientRequestId(), handle: plain.deny, sealed_inputs: sealed }, 400, FORM_INVALID],
    ["inputs on a button without a form", { client_request_id: clientRequestId(), handle: plain.deny, inputs: { reason: mark } }, 400, FORM_INVALID],
  ];
  for (const [why, body, status, answer] of cases) {
    const refused = await call(watched, app.baseUrl, "execute", alice, body);
    assert.deepEqual([refused.status, refused.body], [status, answer], `${why}: ${refused.text.slice(0, 200)}`);
  }
  // A link card's button (RFC 076) takes no form at all; pressed by the person it was read for.
  const owner = { id: fx.owner.id, headers: fx.headers };
  for (const extra of [{ sealed_inputs: sealed }, { inputs: { reason: mark } }]) {
    const refused = await call(watched, app.baseUrl, "execute", owner, { client_request_id: clientRequestId(), handle: handleFor(fx).handle, ...extra });
    assert.deepEqual([refused.status, refused.body], [400, FORM_INVALID], `a link card's button: ${refused.text}`);
  }
  assert.equal(executes(calls).length, 0, "the App is never called");
  assert.equal((await db.select().from(linkCardOperations).where(eq(linkCardOperations.serverId, fx.server.id))).length, 0, "no operation");
  // The buttons still work with what their forms ask.
  const saved = await call(watched, app.baseUrl, "execute", alice, { ...approve(), sealed_inputs: sealedWith(marker("OK")), inputs: { name: "prod" } });
  assert.equal(saved.status, 200, saved.text);
  await assertNowhere(db, app.baseUrl, fx, watched, [mark]);
});

test("re-checked under execute's lock: the App no longer official or without its key, the key rotated, the person no longer a member or reader: refused, the values dropped, nothing sent", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const privateChannel = await createChannel(fx.server.id, `keys-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(privateChannel.id, fx.owner.id);
  await addAgent(privateChannel.id, fx.botId);
  const alice = await person(db, seed, fx, [fx.channel.id, privateChannel.id]);
  await setCardKey(db, fx, "vault-1");
  const watched = watch(app);
  const calls = vault();
  const marks: string[] = [];

  const official = () => db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  // The refusal at admission (the live check), then under the lock.
  const CHANGES: Record<string, { apply: () => Promise<unknown>; undo: () => Promise<unknown>; codes: [string, string] }> = {
    // Still able to act on its own Server (RFC 076 §17), but not official: a SecretInput is for official Apps only.
    // (At admission the live check refuses the handle first: it lacks unreviewed_app.v1, which such an App's buttons need.)
    "the App is no longer official": {
      apply: async () => {
        await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
        await db.update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, fx.client.id));
      },
      undo: async () => { await official(); await db.update(oauthClients).set({ appType: "third_party_global" }).where(eq(oauthClients.id, fx.client.id)); },
      codes: ["HANDLE_INVALID", "PROVIDER_NOT_ELIGIBLE"],
    },
    "the App removed its key": {
      apply: () => db.update(oauthAppLinkPreviews).set({ cardEncryptionKey: null, cardEncryptionKid: null, cardEncryptionKeySetAt: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id)),
      undo: () => setCardKey(db, fx, "vault-1"),
      codes: ["PROVIDER_NOT_ELIGIBLE", "PROVIDER_NOT_ELIGIBLE"],
    },
    "the App rotated its key (a stale kid)": { apply: () => setCardKey(db, fx, "vault-2"), undo: () => setCardKey(db, fx, "vault-1"), codes: ["HANDLE_INVALID", "HANDLE_INVALID"] },
    "the person was demoted to a guest": {
      apply: () => db.update(serverMembers).set({ role: "guest", guestChannelId: privateChannel.id }).where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, alice.id))),
      undo: () => db.update(serverMembers).set({ role: "member", guestChannelId: null }).where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, alice.id))),
      codes: ["HANDLE_INVALID", "HANDLE_INVALID"],
    },
    "the person can no longer read the conversation": {
      apply: () => db.delete(channelHumans).where(and(eq(channelHumans.channelId, privateChannel.id), eq(channelHumans.userId, alice.id))),
      undo: () => addHuman(privateChannel.id, alice.id),
      codes: ["HANDLE_INVALID", "HANDLE_INVALID"],
    },
  };
  for (const [change, { apply, undo, codes }] of Object.entries(CHANGES)) {
    for (const when of ["admission", "under the lock"] as const) {
      const sentCalls = executes(calls).length;
      const messageId = await sendCard(app.baseUrl, fx, { target: `#${privateChannel.name}`, for: alice.id });
      const approve = (await handles(app.baseUrl, alice, messageId)).approve!;
      const prepared = await call(watched, app.baseUrl, "prepare", alice, { handle: approve, claimed: { business_revision: "1" } });
      assert.equal(prepared.status, 200, `${change}: ${prepared.text}`);
      const phases: string[] = [];
      let applied = false;
      __observeLinkCardLiveStateForTests((phase) => phases.push(phase));
      if (when === "admission") await apply();
      else __setLinkCardActionHooksForTests({ beforeAdmission: async () => { await apply(); applied = true; } });
      const secret = marker("SECRET");
      const name = marker("NAME");
      marks.push(secret, name);
      const refused = await call(watched, app.baseUrl, "execute", alice, {
        client_request_id: clientRequestId(), handle: approve, prepared_action_id: prepared.body.prepared_action_id, prepared_digest: prepared.body.prepared_digest,
        sealed_inputs: sealedWith(secret), inputs: { name },
      });
      __setLinkCardActionHooksForTests(null);
      __observeLinkCardLiveStateForTests(null);
      assert.deepEqual([refused.status, refused.body.code], [410, codes[when === "admission" ? 0 : 1]], `${change} (${when}): ${refused.text}`);
      if (when === "under the lock") assert.ok(applied && phases[0] === "execute", `${change}: the live check passed first, the lock refused (${phases.join(",")})`);
      assert.equal(executes(calls).length, sentCalls, `${change} (${when}): nothing sent`);
      assert.equal((await db.select().from(linkCardOperations).where(eq(linkCardOperations.messageId, messageId))).length, 0, `${change} (${when}): no operation`);
      await undo();
    }
  }

  // Someone who isn't for, with a handle signed for them as the read would sign it: refused before anything else.
  const bob = await person(db, seed, fx, [fx.channel.id, privateChannel.id]);
  const messageId = await sendCard(app.baseUrl, fx, { target: `#${privateChannel.name}`, for: alice.id });
  const claims = verifyLinkCardHandle((await handles(app.baseUrl, alice, messageId)).deny!, new Date())!.claims;
  const reason = marker("REASON");
  marks.push(reason);
  const notFor = await call(watched, app.baseUrl, "execute", bob, {
    client_request_id: clientRequestId(), handle: signLinkCardHandle({ ...claims, binding: { ...claims.binding, viewerId: bob.id } }), inputs: { reason },
  });
  assert.deepEqual([notFor.status, notFor.body.code], [410, "HANDLE_INVALID"]);
  assert.equal(executes(calls).length, 0);
  await assertNowhere(db, app.baseUrl, fx, watched, marks);
});

test("a handle issued before another App took the origin over fails at execute (admission and under the lock); its values are dropped", async ({ app, db, seed }) => {
  const fx = await appBotFixture(db, seed);
  const alice = await person(db, seed, fx);
  await setCardKey(db, fx, "vault-1");
  const watched = watch(app);
  const sent: ActionCall[] = [];
  const marks: string[] = [];
  for (const when of ["admission", "under the lock"] as const) {
    // The holder answers its own proof and actions until another App proves the origin.
    let prover = fx.client.clientId;
    __setPreviewHttpForTests(async (url, body, assertion, options) => {
      if (body === undefined) return { client_id: prover };
      const [h, p] = assertion!.split(".");
      const decoded = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
      sent.push({ url, raw: body, body: JSON.parse(body) as Record<string, unknown>, assertion: assertion!, header: decoded(h!), claims: decoded(p!), options });
      return appAnswer(JSON.parse(body).phase === "prepare" ? {
        status: "prepared", description: {
          prepared_action_id: JSON.parse(body).prepared_action_id, action_id: "approve", business_revision: "1", locale: "en",
          read_at: "2026-11-14T08:15:30.120Z", title: "Save a new key", rows: [], confirm_label: "Save", cancel_label: "Cancel",
        },
      } : { status: "done" });
    });
    if (when === "under the lock") {
      // A fresh holder registration for this round (the first round's taker holds the origin now).
      await db.delete(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.origin, fx.origin));
      await db.insert(oauthAppLinkPreviews).values({
        clientId: fx.client.id, origin: fx.origin, endpoint: `${fx.origin}/callback`, paths: ["/pr"], actionEndpoint: fx.actionEndpoint, previewVersions: [1, 2, 3],
        revision: fx.registration.revision,
      });
      await setCardKey(db, fx, "vault-1");
    }
    const messageId = await sendCard(app.baseUrl, fx, { for: alice.id });
    const pressable = await handles(app.baseUrl, alice, messageId);
    const prepared = await call(watched, app.baseUrl, "prepare", alice, { handle: pressable.approve, claimed: { business_revision: "1" } });
    assert.equal(prepared.status, 200, prepared.text);

    const taker = await createOAuthClient({ serverId: fx.server.id, createdByUserId: fx.owner.id, clientId: `taker-${randomUUID().slice(0, 8)}`, name: "Taker" });
    const takeOver = async () => {
      prover = taker.client.clientId;
      const res = await fetch(`${app.baseUrl}/api/oauth/link-preview`, {
        method: "PUT",
        headers: { Authorization: "Basic " + Buffer.from(`${taker.client.clientId}:${taker.clientSecret}`).toString("base64"), "Content-Type": "application/json" },
        body: JSON.stringify({ origin: fx.origin, endpoint: `${fx.origin}/preview`, paths: ["/keys"], action_endpoint: `${fx.origin}/actions` }),
      });
      assert.equal(res.status, 200, await res.text());
    };
    if (when === "admission") await takeOver();
    else __setLinkCardActionHooksForTests({ beforeAdmission: takeOver });
    // Under the lock: prove the live check passed first and the lock refused (Warden).
    const phases: string[] = [];
    if (when === "under the lock") __observeLinkCardLiveStateForTests((phase) => phases.push(phase));
    const secret = marker("SECRET");
    const reason = marker("REASON");
    marks.push(secret, reason);
    const refused = await call(watched, app.baseUrl, "execute", alice, {
      client_request_id: clientRequestId(), handle: pressable.approve, prepared_action_id: prepared.body.prepared_action_id, prepared_digest: prepared.body.prepared_digest,
      sealed_inputs: sealedWith(secret), inputs: { name: "prod" },
    });
    __setLinkCardActionHooksForTests(null);
    __observeLinkCardLiveStateForTests(null);
    assert.equal(refused.status, 410, `${when}: ${refused.text}`);
    assert.equal(refused.body.code, "PROVIDER_NOT_ELIGIBLE", `${when}: ${refused.text}`);
    if (when === "under the lock") assert.equal(phases[0], "execute", `the live check passed first, the lock refused (${phases.join(",")})`);
    const deny = await call(watched, app.baseUrl, "execute", alice, { client_request_id: clientRequestId(), handle: pressable.deny, inputs: { reason } });
    assert.equal(deny.status, 410, `${when}: ${deny.text}`);
    assert.deepEqual(sent.filter((item) => item.body.phase === "execute"), [], `${when}: nothing sent, to either App`);
    assert.equal((await db.select().from(linkCardOperations).where(eq(linkCardOperations.messageId, messageId))).length, 0);
  }
  await assertNowhere(db, app.baseUrl, fx, watched, marks);
});
