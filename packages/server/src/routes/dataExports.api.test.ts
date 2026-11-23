import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { DATA_EXPORT_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { DataExportKind } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { accountDeletionRequests, dataExports, featureFlagRules, serverMembers, servers, sessionFamilies } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { dataExportProducers } from "../services/dataExport/producer";
import { __setEmailDeliveryObserverForTests } from "../services/emailService";
import type { EmailDelivery } from "../services/emailService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { createSession } from "../services/sessionService";
import { __setStorageForTests, resetStorageForTests } from "../services/storageService";
import { MemoryExportStorage, scriptedProducer, setDataExportFlag, zipEntryNames } from "../test/dataExportFixture";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest, signInThroughSecondStepForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";

// Data export routes (routes/dataExports.ts; #triage:#512 PR1b): the flag
// gates every route; only a person's own web sign-in, at least a day old,
// re-authenticated, may ask; a server export is the owner's alone, checked
// again at every download; the limits; a closed server's full history; and
// the emailed code of this flow only. PR1b ships no producer, so a scripted
// one stands in where a test needs an export to run.

const test = createApiTest({ skipAuthRateLimit: true });
useTotpSecretKey();

const DAY = 24 * 60 * 60 * 1000;
const PEPPER = { key: "AGENT_BOOTSTRAP_TOKEN_PEPPER", value: "data-export-test-pepper-0123456789abcdef" };
const previousPepper = process.env[PEPPER.key];
let storage: MemoryExportStorage;
beforeEach(() => {
  process.env[PEPPER.key] = PEPPER.value;
  storage = new MemoryExportStorage();
  __setStorageForTests(storage);
});
afterEach(() => {
  if (previousPepper === undefined) delete process.env[PEPPER.key];
  else process.env[PEPPER.key] = previousPepper;
  resetStorageForTests();
  dataExportProducers.unregister("personal");
  dataExportProducers.unregister("server");
  __setEmailDeliveryObserverForTests(null);
});

type Json = Record<string, any>;
type Res = { status: number; body: Json; headers: Headers; bytes?: Buffer };

async function call(baseUrl: string, method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.headers.get("content-type")?.startsWith("application/zip")) {
    return { status: res.status, body: {}, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }
  return { status: res.status, body: await res.json().catch(() => null) as Json, headers: res.headers };
}

const ME = "/api/me/data-exports";
const SERVER = (id: string) => `/api/servers/${id}/data-exports`;
const scoped = (id: string) => ({ "X-Server-Id": id });
const personalScope = { serverIds: "all" };
const passwordUser = { passwordCredentialEstablishedAt: new Date() };

/** A web sign-in made two days ago: old enough to export, not recent enough to count as re-authentication. */
async function oldSession(userId: string, twoStep = false) {
  const session = twoStep ? await signInThroughSecondStepForTest(userId) : await signInForTest(userId);
  await getDb().update(sessionFamilies).set({ createdAt: new Date(Date.now() - 2 * DAY) }).where(eq(sessionFamilies.id, session.familyId));
  return session;
}

function oneBatch(kind: DataExportKind) {
  const producer = scriptedProducer({ kind, batches: [{ ops: [{ type: "json", path: "account.json", value: { ok: true } }], counts: { rows: 1 } }] });
  dataExportProducers.register(producer);
  return producer;
}

async function settled(id: string) {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await getDb().select().from(dataExports).where(eq(dataExports.id, id));
    if (row && row.status !== "queued" && row.status !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`export ${id} did not settle`);
}

const exportRows = (userId: string) => getDb().select().from(dataExports).where(eq(dataExports.requesterUserId, userId));

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return deliveries;
}
const codeIn = (delivery: EmailDelivery | undefined) => /\n(\d{6})\n/.exec(delivery?.text ?? "")?.[1];

test("flag off: every route of both mounts answers 404 and writes nothing; no-store on every answer", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  oneBatch("personal");
  oneBatch("server");
  const { token } = await oldSession(human.id);
  const routes: Array<[string, string, unknown?]> = [
    ["GET", ME], ["POST", ME, { scope: personalScope, password: "password123" }], ["POST", `${ME}/email-code`],
    ["GET", `${ME}/00000000-0000-4000-8000-000000000001`], ["DELETE", `${ME}/00000000-0000-4000-8000-000000000001`],
    ["POST", `${ME}/00000000-0000-4000-8000-000000000001/download`, {}],
    ["GET", SERVER(server.id)], ["POST", SERVER(server.id), { scope: {}, password: "password123" }],
  ];
  await setDataExportFlag(false);
  // While off, a server request without (or with another) X-Server-Id reads the same 404.
  for (const headers of [{}, scoped("00000000-0000-4000-8000-000000000009")]) {
    assert.equal((await call(app.baseUrl, "GET", SERVER(server.id), token, undefined, headers)).status, 404);
  }
  for (const [method, path, body] of routes) {
    const res = await call(app.baseUrl, method, path, token, body, scoped(server.id));
    assert.equal(res.status, 404, `${method} ${path}: ${JSON.stringify(res.body)}`);
    assert.equal(res.headers.get("cache-control"), "no-store", `${method} ${path}`);
  }
  // The kill switch is off too, whatever the default says.
  await setDataExportFlag(true, { killSwitch: true });
  assert.equal((await call(app.baseUrl, "POST", ME, token, { scope: personalScope, password: "password123" })).status, 404);
  assert.deepEqual(await exportRows(human.id), []);
});

test("no producer for a kind (PR1b): the list says unavailable and asking answers 404 data_export_kind_unavailable", async ({ app, seed }) => {
  await setDataExportFlag(true);
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  const { token } = await oldSession(human.id);
  const list = await call(app.baseUrl, "GET", ME, token);
  assert.deepEqual([list.status, list.body.exports, list.body.available], [200, [], false]);
  assert.equal(list.headers.get("cache-control"), "no-store");
  for (const [path, scope] of [[ME, personalScope], [SERVER(server.id), {}]] as const) {
    const res = await call(app.baseUrl, "POST", path, token, { scope, password: "password123" }, scoped(server.id));
    assert.deepEqual([res.status, res.body.code], [404, "data_export_kind_unavailable"], path);
  }
  assert.deepEqual(await exportRows(human.id), []);
});

test("only a person's own web sign-in, at least a day old: a device session and an agent key are refused, a new sign-in is told to wait", async ({ app, seed }) => {
  await setDataExportFlag(true);
  oneBatch("personal");
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  const fresh = await signInForTest(human.id);
  const device = await createSession(await proofForDeviceLogin(human.id, fresh.familyId), undefined, { scope: "device" });
  const agent = await createAgent(server.id, `ext-${human.id.slice(0, 8)}`, { runtime: "external", creatorType: "user", creatorId: human.id });
  const agentKey = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "k", issuedVia: "human", createdByUserId: human.id });
  const callers = [
    ["device", signAccessToken(human.id, device.familyId), 403, "device_session_not_allowed"],
    ["agent", agentKey.apiKey, 401, "auth_required"],
  ] as const;
  for (const [name, token, status, code] of callers) {
    for (const [method, path] of [["GET", ME], ["POST", ME]] as const) {
      const res = await call(app.baseUrl, method, path, token, method === "POST" ? { scope: personalScope, password: "password123" } : undefined);
      assert.deepEqual([res.status, res.body?.code], [status, code], `${name} ${method}: ${JSON.stringify(res.body)}`);
    }
  }
  const young = await call(app.baseUrl, "POST", ME, fresh.token, { scope: personalScope, password: "password123" });
  assert.deepEqual([young.status, young.body.code], [403, "data_export_session_too_new"]);
  assert.deepEqual(await exportRows(human.id), []);
});

test("a password person: reauth_required with the methods, a wrong password refused; with it the export runs to ready and the local download streams the zip as an attachment", async ({ app, seed }) => {
  await setDataExportFlag(true);
  oneBatch("personal");
  storage = new MemoryExportStorage(false);
  __setStorageForTests(storage);
  const human = await seed.human(passwordUser);
  const { token } = await oldSession(human.id);

  const bare = await call(app.baseUrl, "POST", ME, token, { scope: personalScope });
  assert.deepEqual([bare.status, bare.body.code, bare.body.details], [403, "reauth_required", { methods: ["password"] }]);
  const wrong = await call(app.baseUrl, "POST", ME, token, { scope: personalScope, password: "not-it" });
  assert.deepEqual([wrong.status, wrong.body.code], [401, "password_incorrect"]);
  const badScope = await call(app.baseUrl, "POST", ME, token, { scope: { serverIds: "some" }, password: "password123" });
  assert.deepEqual([badScope.status, badScope.body.code], [400, "data_export_scope_invalid"]);
  assert.deepEqual(await exportRows(human.id), []);

  const created = await call(app.baseUrl, "POST", ME, token, { scope: personalScope, password: "password123" });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.export.status, "queued");
  assert.deepEqual(created.body.export.scope, { serverIds: "all", includeContext: false, includeFiles: false });
  const ready = await settled(created.body.export.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.requesterSessionFamilyId, (await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id)))[0]!.id);

  const listed = await call(app.baseUrl, "GET", ME, token);
  assert.equal(listed.body.exports[0].status, "ready");
  assert.equal(JSON.stringify(listed.body).includes("data-exports/"), false, "no storage key reaches the client");
  const download = await call(app.baseUrl, "POST", `${ME}/${ready.id}/download`, token, { volume: 1 });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment; filename="raft-export-me-\d{4}-\d{2}-\d{2}\.zip"$/);
  assert.deepEqual(zipEntryNames(download.bytes!), ["account.json", "manifest.json"]);
  const [after] = await exportRows(human.id);
  assert.ok(after!.downloadedAt && after!.lastDownloadedAt, "the download is recorded");
  assert.deepEqual((await call(app.baseUrl, "POST", `${ME}/${ready.id}/download`, token, { volume: 2 })).body.code, "data_export_volume_not_found");
  // A sign-in less than a day old can neither download nor delete it (a stolen session takes nothing at once).
  const fresh = await signInForTest(human.id);
  for (const [method, path] of [["POST", `${ME}/${ready.id}/download`], ["DELETE", `${ME}/${ready.id}`]] as const) {
    const res = await call(app.baseUrl, method, path, fresh.token, method === "POST" ? { volume: 1 } : undefined);
    assert.deepEqual([res.status, res.body.code], [403, "data_export_session_too_new"], `${method} ${path}`);
  }
  assert.equal((await exportRows(human.id))[0]!.status, "ready");

  // Someone else's export reads as none, for every route.
  const other = await oldSession((await seed.human()).id);
  for (const [method, path] of [["GET", `${ME}/${ready.id}`], ["DELETE", `${ME}/${ready.id}`], ["POST", `${ME}/${ready.id}/download`]] as const) {
    const res = await call(app.baseUrl, method, path, other.token, method === "POST" ? {} : undefined);
    assert.deepEqual([res.status, res.body.code], [404, "data_export_not_found"], `${method} ${path}`);
  }
  // Delete: gone from the list, the archive with it.
  assert.equal((await call(app.baseUrl, "DELETE", `${ME}/${ready.id}`, token)).status, 200);
  assert.deepEqual((await call(app.baseUrl, "GET", ME, token)).body.exports, []);
  assert.equal(storage.objects.size, 0);
});

test("two-step verification on: step-up on this sign-in (second_factor_step_up_required), then the export is asked", async ({ app, seed }) => {
  await setDataExportFlag(true);
  oneBatch("personal");
  const human = await seed.human(passwordUser);
  await enrollSecondFactor(human.id);
  const session = await oldSession(human.id, true);
  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(sessionFamilies.id, session.familyId));
  const stale = await call(app.baseUrl, "POST", ME, session.token, { scope: personalScope, password: "password123" });
  assert.deepEqual([stale.status, stale.body.code], [403, "second_factor_step_up_required"]);
  assert.match(stale.body.error, /before exporting data/);
  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date() }).where(eq(sessionFamilies.id, session.familyId));
  const ok = await call(app.baseUrl, "POST", ME, session.token, { scope: personalScope });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
});

test("emailed codes never cross flows: an account deletion code does not start an export, an export code does not delete the account; the export's own code does, once", async ({ app, seed }) => {
  await setDataExportFlag(true);
  oneBatch("personal");
  const human = await seed.human();
  const { token } = await oldSession(human.id);
  const emails = captureEmails();

  const noCode = await call(app.baseUrl, "POST", ME, token, { scope: personalScope });
  assert.deepEqual([noCode.status, noCode.body.code, noCode.body.details], [403, "reauth_required", { methods: ["email_code"] }]);

  assert.equal((await call(app.baseUrl, "POST", "/api/me/account/deletion/email-code", token)).status, 200);
  const deletionCode = codeIn(emails.at(-1));
  assert.ok(deletionCode);
  const crossed = await call(app.baseUrl, "POST", ME, token, { scope: personalScope, emailCode: deletionCode });
  assert.deepEqual([crossed.status, crossed.body.code], [400, "email_code_invalid"]);
  assert.deepEqual(await exportRows(human.id), []);

  const sent = await call(app.baseUrl, "POST", `${ME}/email-code`, token);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.match(emails.at(-1)!.subject, /data export/i);
  const exportCode = codeIn(emails.at(-1));
  assert.ok(exportCode && exportCode !== deletionCode);
  const crossedBack = await call(app.baseUrl, "POST", "/api/me/account/deletion", token, { emailCode: exportCode });
  assert.deepEqual([crossedBack.status, crossedBack.body.code], [400, "email_code_invalid"]);
  assert.deepEqual(await getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, human.id)), []);
  assert.equal((await call(app.baseUrl, "POST", `${ME}/email-code`, token)).body.code, "email_code_recently_sent");

  // A request the limits refuse doesn't spend the code.
  const [blocking] = await getDb().insert(dataExports).values({
    kind: "personal", requesterUserId: human.id, requesterSessionFamilyId: "00000000-0000-4000-8000-000000000001",
    scope: { serverIds: "all", includeContext: false, includeFiles: false }, scopeVersion: 1, status: "queued", createdAt: new Date(Date.now() - 8 * DAY), updatedAt: new Date(),
  }).returning();
  assert.equal((await call(app.baseUrl, "POST", ME, token, { scope: personalScope, emailCode: exportCode })).body.code, "data_export_in_flight");
  await getDb().delete(dataExports).where(eq(dataExports.id, blocking!.id));
  const created = await call(app.baseUrl, "POST", ME, token, { scope: personalScope, emailCode: exportCode });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  await settled(created.body.export.id);
  await getDb().delete(dataExports).where(eq(dataExports.requesterUserId, human.id));
  const again = await call(app.baseUrl, "POST", ME, token, { scope: personalScope, emailCode: exportCode });
  assert.deepEqual([again.status, again.body.code], [400, "email_code_invalid"], "used once");
});

test("a server export is the owner's: an admin and a member are refused, a non-member gets 404; the download is re-checked, a demoted owner can't download, and S3 gets a 5-minute attachment link", async ({ app, seed }) => {
  await setDataExportFlag(true);
  oneBatch("server");
  const owner = await seed.human(passwordUser);
  const coOwner = await seed.human(passwordUser);
  const admin = await seed.human(passwordUser);
  const member = await seed.human(passwordUser);
  const server = await seed.server({ owner, members: [coOwner, admin, member] });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, coOwner.id)));
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const outsider = await oldSession((await seed.human(passwordUser)).id);

  for (const person of [admin, member]) {
    const { token } = await oldSession(person.id);
    const res = await call(app.baseUrl, "POST", SERVER(server.id), token, { scope: {}, password: "password123" }, scoped(server.id));
    assert.deepEqual([res.status, res.body.code], [403, "data_export_owner_only"]);
  }
  assert.equal((await call(app.baseUrl, "GET", SERVER(server.id), outsider.token, undefined, scoped(server.id))).status, 404);
  // X-Server-Id is checked once the caller may see the server: missing, or naming another server (one the caller owns), it is refused.
  const ownSession = await oldSession(owner.id);
  assert.deepEqual((await call(app.baseUrl, "GET", SERVER(server.id), ownSession.token)).body.code, "server_scope_required");
  const other = await seed.server({ owner });
  const mismatch = await call(app.baseUrl, "GET", SERVER(server.id), ownSession.token, undefined, scoped(other.id));
  assert.deepEqual([mismatch.status, mismatch.body.code], [400, "server_scope_required"]);

  const { token } = await oldSession(coOwner.id);
  const created = await call(app.baseUrl, "POST", SERVER(server.id), token, { scope: { includeFiles: true }, password: "password123" }, scoped(server.id));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const ready = await settled(created.body.export.id);
  assert.equal(ready.status, "ready");
  const link = await call(app.baseUrl, "POST", `${SERVER(server.id)}/${ready.id}/download`, token, { volume: 1 }, scoped(server.id));
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.match(link.body.url, /^https:\/\/exports\.example\.test\//);
  assert.deepEqual(storage.presigned.map(({ expiresIn, responseContentType }) => [expiresIn, responseContentType]), [[300, "application/zip"]]);
  assert.match(storage.presigned[0]!.responseContentDisposition!, new RegExp(`^attachment; filename="raft-export-${server.slug}-`));

  // The personal mount never shows (or deletes) a server export, and the other owner doesn't see this one.
  assert.deepEqual((await call(app.baseUrl, "GET", ME, token)).body.exports, []);
  assert.deepEqual((await call(app.baseUrl, "DELETE", `${ME}/${ready.id}`, token)).body.code, "data_export_not_found");
  assert.equal((await getDb().select().from(dataExports).where(eq(dataExports.id, ready.id)))[0]!.status, "ready");
  const ownerSession = await oldSession(owner.id);
  assert.deepEqual((await call(app.baseUrl, "GET", SERVER(server.id), ownerSession.token, undefined, scoped(server.id))).body.exports, []);

  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, coOwner.id)));
  const demoted = await call(app.baseUrl, "POST", `${SERVER(server.id)}/${ready.id}/download`, token, { volume: 1 }, scoped(server.id));
  assert.deepEqual([demoted.status, demoted.body.code], [403, "data_export_owner_only"]);
  assert.equal(storage.presigned.length, 1, "no new link");
});

test("the server mount never tells which server ids exist or are rolled out: a non-member of a flagged server, a random id, a malformed id and a flag-off server read byte for byte the same, whatever the header or sign-in", async ({ app, seed }) => {
  await setDataExportFlag(false);
  oneBatch("server");
  const owner = await seed.human(passwordUser);
  const flagged = await seed.server({ owner });
  const unflagged = await seed.server({ owner });
  await getDb().insert(featureFlagRules).values({ flagKey: DATA_EXPORT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [flagged.id] });
  const outsider = await seed.human(passwordUser);
  const web = await oldSession(outsider.id);
  const device = await createSession(await proofForDeviceLogin(outsider.id, web.familyId), undefined, { scope: "device" });
  const deviceToken = signAccessToken(outsider.id, device.familyId);
  // The owner sees the flagged server (the rule is live) and not the unflagged one.
  const ownerSession = await oldSession(owner.id);
  assert.equal((await call(app.baseUrl, "GET", SERVER(flagged.id), ownerSession.token, undefined, scoped(flagged.id))).status, 200);
  const ownerOff = await call(app.baseUrl, "GET", SERVER(unflagged.id), ownerSession.token, undefined, scoped(unflagged.id));

  // Every answer for each kind of sign-in, across ids: a web sign-in reaches the
  // mount and gets its one 404; a device sign-in is refused before it (the same
  // for every id). A malformed id is refused by the servers router before either.
  const answersOf = async (token: string, ids: string[]) => {
    const answers: string[] = [];
    for (const id of ids) {
      for (const headers of [scoped(id), {}, scoped(owner.id)]) {
        for (const [method, path] of [["GET", SERVER(id)], ["POST", SERVER(id)], ["POST", `${SERVER(id)}/email-code`]] as const) {
          const res = await call(app.baseUrl, method, path, token, method === "POST" ? { scope: {}, password: "password123" } : undefined, headers);
          answers.push(`${res.status} ${JSON.stringify(res.body)}`);
        }
      }
    }
    return [...new Set(answers)];
  };
  const ids = [flagged.id, unflagged.id, "00000000-0000-4000-8000-00000000abcd"];
  const webAnswers = await answersOf(web.token, ids);
  webAnswers.push(...[`${ownerOff.status} ${JSON.stringify(ownerOff.body)}`].filter((a) => !webAnswers.includes(a)));
  assert.equal(webAnswers.length, 1, webAnswers.join("\n"));
  assert.match(webAnswers[0]!, /^404 .*"That server was not found\.".*"code":"not_found"/);
  const deviceAnswers = await answersOf(deviceToken, ids);
  assert.equal(deviceAnswers.length, 1, deviceAnswers.join("\n"));
  assert.match(deviceAnswers[0]!, /^403 .*device_session_not_allowed/);
  assert.equal((await answersOf(web.token, ["not-a-uuid", "also-not-a-uuid"])).length, 1);
  assert.deepEqual(await exportRows(outsider.id), []);
});

test("limits: one in flight per person, one personal export per 7 days and one server export per server per 24 hours; a failed one doesn't count", async ({ app, seed }) => {
  await setDataExportFlag(true);
  oneBatch("personal");
  oneBatch("server");
  const human = await seed.human(passwordUser);
  const coOwner = await seed.human(passwordUser);
  const server = await seed.server({ owner: human, members: [coOwner] });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, coOwner.id)));
  const { token, familyId } = await oldSession(human.id);
  const ask = (path: string, scope: unknown, t = token) => call(app.baseUrl, "POST", path, t, { scope, password: "password123" }, scoped(server.id));

  // One in flight (a queued row of the person's).
  const [inFlight] = await getDb().insert(dataExports).values({
    kind: "personal", requesterUserId: human.id, requesterSessionFamilyId: familyId, scope: { serverIds: "all", includeContext: false, includeFiles: false },
    scopeVersion: 1, status: "queued", createdAt: new Date(Date.now() - 8 * DAY), updatedAt: new Date(),
  }).returning();
  assert.deepEqual((await ask(ME, personalScope)).body.code, "data_export_in_flight");
  assert.deepEqual((await ask(SERVER(server.id), {})).body.code, "data_export_in_flight", "per person, any kind");
  await getDb().update(dataExports).set({ status: "failed", finishedAt: new Date() }).where(eq(dataExports.id, inFlight!.id));

  const first = await ask(ME, personalScope);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await settled(first.body.export.id);
  const second = await ask(ME, personalScope);
  assert.deepEqual([second.status, second.body.code], [429, "data_export_cooldown"]);
  assert.ok(second.body.retryAfterSeconds > 6 * 24 * 3600 && Number(second.headers.get("retry-after")) === second.body.retryAfterSeconds);
  // A failed export doesn't count against the limit.
  await getDb().update(dataExports).set({ status: "failed" }).where(eq(dataExports.id, first.body.export.id));
  const third = await ask(ME, personalScope);
  assert.equal(third.status, 202);
  await settled(third.body.export.id);
  // A deleted export still counts: the list no longer shows it, so it says when the person may ask again.
  assert.equal((await call(app.baseUrl, "DELETE", `${ME}/${third.body.export.id}`, token)).status, 200);
  const listed = await call(app.baseUrl, "GET", ME, token);
  assert.ok(!listed.body.exports.some((row: Json) => row.id === third.body.export.id));
  assert.equal(listed.body.nextAllowedAt, new Date(new Date(third.body.export.createdAt).getTime() + 7 * DAY).toISOString());
  assert.equal((await ask(ME, personalScope)).body.code, "data_export_cooldown");

  // Per server: another owner of the same server within 24 hours waits too.
  const serverFirst = await ask(SERVER(server.id), {}, (await oldSession(coOwner.id)).token);
  assert.equal(serverFirst.status, 202, JSON.stringify(serverFirst.body));
  await settled(serverFirst.body.export.id);
  const serverSecond = await ask(SERVER(server.id), {});
  assert.deepEqual([serverSecond.status, serverSecond.body.code], [429, "data_export_cooldown"]);
  assert.ok(serverSecond.body.retryAfterSeconds <= 24 * 3600);
});

test("a closed server: only its full history, only until the purge window ends; an open server can't ask for full history", async ({ app, seed }) => {
  await setDataExportFlag(true);
  oneBatch("server");
  const owner = await seed.human(passwordUser);
  const server = await seed.server({ owner });
  const { token } = await oldSession(owner.id);
  const ask = (scope: unknown) => call(app.baseUrl, "POST", SERVER(server.id), token, { scope, password: "password123" }, scoped(server.id));

  assert.deepEqual((await ask({ fullHistoryAfterClose: true })).body.code, "data_export_full_history_not_closed");
  await getDb().update(servers).set({ deletedAt: new Date(Date.now() - 31 * DAY) }).where(eq(servers.id, server.id));
  assert.deepEqual((await ask({ fullHistoryAfterClose: true })).body.code, "data_export_window_over");
  await getDb().update(servers).set({ deletedAt: new Date(Date.now() - DAY) }).where(eq(servers.id, server.id));
  assert.deepEqual((await ask({})).body.code, "data_export_full_history_required");
  const created = await ask({ fullHistoryAfterClose: true });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const ready = await settled(created.body.export.id);
  // Downloadable until the purge begins.
  assert.equal((await call(app.baseUrl, "POST", `${SERVER(server.id)}/${ready.id}/download`, token, {}, scoped(server.id))).status, 200);
  await getDb().update(servers).set({ purgeState: "apps" }).where(eq(servers.id, server.id));
  assert.equal((await call(app.baseUrl, "POST", `${SERVER(server.id)}/${ready.id}/download`, token, {}, scoped(server.id))).body.code, "data_export_window_over");
});

test("the owner's context switch (/data-export-settings) and the server export's summary: behind the flag, members read the switch, only an owner changes it or reads the summary; the personal list names the servers that allow context", async ({ app, seed }) => {
  const owner = await seed.human(passwordUser);
  const admin = await seed.human(passwordUser);
  const member = await seed.human(passwordUser);
  const server = await seed.server({ owner, members: [admin, member] });
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  const SETTINGS = `/api/servers/${server.id}/data-export-settings`;
  const [ownerSession, adminSession, memberSession] = await Promise.all([owner, admin, member].map((person) => oldSession(person.id)));

  await setDataExportFlag(false);
  // The same 404 as /:id/data-exports answers while the flag is off.
  const listOff = await call(app.baseUrl, "GET", SERVER(server.id), ownerSession!.token, undefined, scoped(server.id));
  for (const res of [
    await call(app.baseUrl, "GET", SETTINGS, ownerSession!.token, undefined, scoped(server.id)),
    await call(app.baseUrl, "PATCH", SETTINGS, ownerSession!.token, { memberContextExportEnabled: true }, scoped(server.id)),
  ]) {
    assert.deepEqual([res.status, res.body], [404, listOff.body]);
    assert.deepEqual([res.body.code, res.body.error], ["not_found", "That server was not found."]);
  }

  await setDataExportFlag(true);
  assert.deepEqual((await call(app.baseUrl, "GET", SETTINGS, memberSession!.token, undefined, scoped(server.id))).body, { memberContextExportEnabled: false, canManage: false });
  const byAdmin = await call(app.baseUrl, "PATCH", SETTINGS, adminSession!.token, { memberContextExportEnabled: true }, scoped(server.id));
  assert.deepEqual([byAdmin.status, byAdmin.body.code], [403, "data_export_owner_only"], "admins don't have exportServerData");
  assert.equal((await call(app.baseUrl, "PATCH", SETTINGS, ownerSession!.token, { memberContextExportEnabled: "yes" }, scoped(server.id))).status, 400);
  assert.equal((await call(app.baseUrl, "GET", ME, memberSession!.token)).body.contextServerIds.length, 0);
  // Only a web sign-in changes it: a device login's session and an agent key are refused, nothing changes.
  const device = await createSession(await proofForDeviceLogin(owner.id, ownerSession!.familyId), undefined, { scope: "device" });
  const agent = await createAgent(server.id, `ext-${owner.id.slice(0, 8)}`, { runtime: "external", creatorType: "user", creatorId: owner.id });
  const agentKey = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "k", issuedVia: "human", createdByUserId: owner.id });
  for (const token of [signAccessToken(owner.id, device.familyId), agentKey.apiKey]) {
    const refusedSession = await call(app.baseUrl, "PATCH", SETTINGS, token, { memberContextExportEnabled: true }, scoped(server.id));
    assert.ok([401, 403].includes(refusedSession.status), JSON.stringify(refusedSession.body));
  }
  assert.equal((await call(app.baseUrl, "GET", SETTINGS, ownerSession!.token, undefined, scoped(server.id))).body.memberContextExportEnabled, false);
  const on = await call(app.baseUrl, "PATCH", SETTINGS, ownerSession!.token, { memberContextExportEnabled: true }, scoped(server.id));
  assert.deepEqual([on.status, on.body], [200, { memberContextExportEnabled: true, canManage: true }]);
  assert.deepEqual((await call(app.baseUrl, "GET", ME, memberSession!.token)).body.contextServerIds, [server.id]);

  oneBatch("server");
  const summary = await call(app.baseUrl, "GET", `${SERVER(server.id)}/summary`, ownerSession!.token, undefined, scoped(server.id));
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.deepEqual(Object.keys(summary.body).sort(), ["fileBytes", "files", "filesCapped", "historyFrom", "messages", "messagesCapped", "publicChannels"]);
  const refused = await call(app.baseUrl, "GET", `${SERVER(server.id)}/summary`, adminSession!.token, undefined, scoped(server.id));
  assert.deepEqual([refused.status, refused.body.code], [403, "data_export_owner_only"]);
  assert.equal((await call(app.baseUrl, "GET", `${ME}/summary`, memberSession!.token)).status, 404, "the personal mount has none");
  assert.equal((await call(app.baseUrl, "GET", SERVER(server.id), ownerSession!.token, undefined, scoped(server.id))).body.closed, false);
});
