// A push records its version's publish check, and an agent reads it (task
// #130; publish.ts, checks.ts recordVersionCheck, checkRead.ts; contract
// shared agentApiArtifactChecksContract.ts), over HTTP with real agent
// credentials:
//
// - the push: where the deployment has a check Worker (a usable
//   ARTIFACTS_CHECK_WORKER_TOKEN: checkWorkerToken.ts), a new HTML version gets a
//   `pending` row in the push's transaction and the answer's `check` names
//   it; files the previous version had byte for byte are `skipped`/`unchanged`;
//   Markdown (#217), a kind the shell draws, a PDF (not checked for now) and a
//   push that makes no version answer no `check`; a replay
//   answers its version's check as it is now (pending, then done), none
//   without a check Worker; without one nothing is recorded and the answer has no
//   `check`; a check whose recording fails (the cap count throws in Postgres)
//   rolls back alone: the push still answers 201, without `check`, and no
//   row is written;
// - artifactCheck: pending as recorded, `check: null` for a version without
//   one (a Markdown one too), an older Markdown version's own check as it was
//   recorded, a done one with its findings and screenshots, an older version by
//   `version`; one 404 NOT_VISIBLE for an agent that can't see the Artifact
//   and for another server's agent reading a public one; without a check Worker: null;
// - artifactCheckShot: a done check's PNG, through core's object files (only
//   that version's); SCREENSHOT_NOT_FOUND for a pending check, a shot let go,
//   no check Worker; NOT_VISIBLE as above.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentApiArtifactCheckResponseSchema, agentApiArtifactPublishedSchema, asServerId, RAFT_HINTS } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { putObjectFile } from "../../services/objectFiles";
import { refusalBody } from "../../platform/refusals";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { installMemoryObjectFilesStorage } from "../../test/memoryObjectFilesStorage";
import { testPng } from "../../test/objectFileTestImages";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { artifactFileObject, checkShotPart, keepNewestCheckShots } from "./checks";
import { __setScrollLockCheckForTests } from "./scrollLock";
import { artifactItems, artifactVersionChecks, artifactVersions, type ArtifactVersionCheckRow } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

// The cap count query, made to fail in Postgres while `failCapCount` is on:
// the push's own recordVersionCheck, given a `count` that raises in the
// transaction it is handed (checks.ts recordVersionCheck's savepoint).
const injected = vi.hoisted(() => ({ failCapCount: false }));
vi.mock("./checks", async (importOriginal) => {
  const real = await importOriginal<typeof import("./checks")>();
  const { sql } = await import("drizzle-orm");
  const failing: import("./checks").ArtifactCheckCount = async (executor) => {
    await executor.execute(sql.raw(`DO $$ BEGIN RAISE EXCEPTION 'injected cap count failure'; END $$`));
    throw new Error("the injected failure did not raise");
  };
  return {
    ...real,
    recordVersionCheck: (...[executor, input]: Parameters<typeof real.recordVersionCheck>) =>
      real.recordVersionCheck(executor, injected.failCapCount ? { ...input, count: failing } : input),
  };
});

const test = createApiTest();

let storage: ReturnType<typeof installMemoryObjectFilesStorage>;
beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-check-push-tests-hmac-secret-0123456789");
  storage = installMemoryObjectFilesStorage();
  __setScrollLockCheckForTests(false);
});
afterEach(() => {
  injected.failCapCount = false;
  storage.restore();
  __setScrollLockCheckForTests(undefined);
  __setArtifactR2StoreForTests(undefined);
  vi.unstubAllEnvs();
});

const label = () => randomUUID().slice(0, 8);
const PAGE = (text: string) => `<!doctype html><html><head><title>${text}</title></head><body><p>${text}</p></body></html>`;

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async read(blob) {
      const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
      if (!bytes) return null;
      const { Readable } = await import("node:stream");
      return { stream: Readable.from([bytes]), size: bytes.length };
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

/**
 * A server with Artifacts on (and a check Worker configured, unless `checks: false`):
 * agents `a` and `b` in the private #pub, `out` in no channel, and an agent of a peer
 * server (Artifacts on there too).
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, opts: { checks?: boolean } = {}) {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const agentA = await createAgent(server.id, `chk-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentB = await createAgent(server.id, `chk-b-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentOut = await createAgent(server.id, `chk-out-${label()}`, { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peer.id, `chk-peer-${label()}`, { runtime: "claude", model: "sonnet" });
  // Private: a public channel's Artifacts are every member's to see, `out` included.
  const pub = await createChannel(server.id, `chk-${label()}`, undefined, "private");
  await addHuman(pub.id, owner.id);
  await addAgent(pub.id, agentA.id);
  await addAgent(pub.id, agentB.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  if (opts.checks !== false) enableChecks();
  else disableChecks();
  __setArtifactR2StoreForTests(memoryR2(new Map()));
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send"], name: `chk-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  return {
    server, serverId: asServerId(server.id), owner, pub,
    keys: { a: await key(agentA.id), b: await key(agentB.id), out: await key(agentOut.id), peer: await key(peerAgent.id) },
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

/** A deployment with a check Worker: what turns publish checks on (checkWorkerToken.ts checksConfigured). */
const enableChecks = () => vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", "k".repeat(40));
/** One without: nothing could run a check, so none is recorded or served. */
const disableChecks = () => vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", "");

// ---- HTTP ----------------------------------------------------------------------

type Reply = { status: number; body: any };

async function call(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const push = (app: { baseUrl: string }, apiKey: string, body: unknown) => call(app.baseUrl, "POST", "/artifacts/push", apiKey, body);
const create = (app: { baseUrl: string }, world: World, files: unknown[], apiKey = world.keys.a) =>
  push(app, apiKey, { target: `#${world.pub.name}`, title: `Checked ${label()}`, files });
const readCheck = (app: { baseUrl: string }, apiKey: string, artifact: string, version?: number) =>
  call(app.baseUrl, "GET", `/artifacts/${encodeURIComponent(artifact)}/check${version === undefined ? "" : `?version=${version}`}`, apiKey);

async function readShot(baseUrl: string, apiKey: string, artifact: string, shot: string, version?: number) {
  const res = await fetch(`${baseUrl}/internal/agent-api/artifacts/${encodeURIComponent(artifact)}/check/${shot}${version === undefined ? "" : `?version=${version}`}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const json = res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(bytes.toString()) as { code: string; details?: unknown } : null;
  return { status: res.status, contentType: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), bytes, json };
}

// ---- rows ----------------------------------------------------------------------

async function versionOf(artifactId: string, number: number) {
  const [version] = await getDb().select().from(artifactVersions).where(and(eq(artifactVersions.itemId, artifactId), eq(artifactVersions.number, number))).limit(1);
  return version!;
}

async function checksOf(artifactId: string): Promise<Array<ArtifactVersionCheckRow & { number: number }>> {
  const rows = await getDb().select({ check: artifactVersionChecks, number: artifactVersions.number }).from(artifactVersionChecks)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionChecks.versionId))
    .where(eq(artifactVersions.itemId, artifactId))
    .orderBy(artifactVersions.number);
  return rows.map((row) => ({ ...row.check, number: row.number }));
}

/** Finish version `number`'s check as the check task does: both screenshots as the Artifact's object files hung on the version, the row done. */
async function finishChecked(world: World, artifactId: string, number: number) {
  const version = await versionOf(artifactId, number);
  const put = async (text: string) => (await putObjectFile({
    object: artifactFileObject(artifactId), parent: checkShotPart(version.id), bytes: testPng(text), uploadedBy: { type: "user", id: world.owner.id }, quota: "exempt",
  })).id;
  const desktop = await put(`desktop ${version.id}`);
  const phone = await put(`phone ${version.id}`);
  const findings = { consoleErrors: [{ message: "Uncaught TypeError: x is undefined", source: "index.html", line: 12 }], blockedResources: ["https://cdn.example.com/lib.js"], blank: false, phoneOverflow: { contentWidth: 640, viewportWidth: 390 } };
  await getDb().update(artifactVersionChecks)
    .set({ status: "done", finishedAt: new Date(), findings, desktopFileId: desktop, phoneFileId: phone })
    .where(eq(artifactVersionChecks.versionId, version.id));
  return { version, desktop, phone, findings };
}

// ---- the push ------------------------------------------------------------------

test("push: with a check Worker configured, a new HTML version records a pending check in its transaction and the answer names it; the same files again are skipped as unchanged", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await create(app, world, [{ path: "index.html", content: PAGE("one") }]);
  assert.equal(created.status, 201);
  assert.ok(agentApiArtifactPublishedSchema.safeParse(created.body).success, "the answer is the contract's");
  const id = created.body.artifact.id as string;
  let rows = await checksOf(id);
  assert.equal(rows.length, 1);
  assert.deepEqual(created.body.check, { id: rows[0]!.id, status: "pending" }, "no skipReason on a pending check");
  assert.equal(rows[0]!.number, 1);
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.skipReason, null);
  assert.equal(rows[0]!.finishedAt, null);

  // A changed page: a new pending check for v2.
  const changed = await push(app, world.keys.a, { artifact: id, base: 1, files: [{ path: "index.html", content: PAGE("two") }] });
  assert.equal(changed.status, 201);
  rows = await checksOf(id);
  assert.deepEqual(rows.map((row) => [row.number, row.status]), [[1, "pending"], [2, "pending"]]);
  assert.deepEqual(changed.body.check, { id: rows[1]!.id, status: "pending" });

  // Only the description changes: a new version whose files are v2's byte for byte, skipped from the start.
  const described = await push(app, world.keys.a, { artifact: id, base: 2, description: "same page, new words about it", files: [] });
  assert.equal(described.status, 201);
  assert.equal(described.body.version.number, 3);
  rows = await checksOf(id);
  assert.deepEqual(rows.map((row) => [row.number, row.status, row.skipReason]), [[1, "pending", null], [2, "pending", null], [3, "skipped", "unchanged"]]);
  assert.ok(rows[2]!.finishedAt, "a skipped check is finished when recorded");
  assert.deepEqual(described.body.check, { id: rows[2]!.id, status: "skipped", skipReason: "unchanged" });
});

test("push: a Markdown version gets no check and no `check`, a later HTML version of it does; asking for it answers null, not a failure, and an older Markdown version keeps the check it had", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const markdown = await create(app, world, [{ path: "README.md", content: "# notes\n\nhello" }]);
  assert.equal(markdown.status, 201);
  assert.ok(agentApiArtifactPublishedSchema.safeParse(markdown.body).success, "the answer is the contract's");
  assert.equal("check" in markdown.body, false, "nothing to tell the agent is pending");
  const id = markdown.body.artifact.id as string;
  assert.deepEqual(await checksOf(id), [], "no row, so no Worker task");
  const asked = await readCheck(app, world.keys.a, id);
  assert.equal(asked.status, 200);
  assert.equal(asked.body.check, null);

  // Reverse control: the same Artifact's HTML version is checked as ever.
  const page = await push(app, world.keys.a, { artifact: id, base: 1, entry: "index.html", files: [{ path: "index.html", content: PAGE("now a page") }] });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  assert.equal(page.body.check.status, "pending");

  // A version checked while Markdown was: its row is read as it was recorded.
  const [v1] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, id)).orderBy(artifactVersions.number).limit(1);
  await getDb().insert(artifactVersionChecks).values({ versionId: v1!.id, status: "done", findings: { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null }, finishedAt: new Date() });
  const older = await readCheck(app, world.keys.a, id, 1);
  assert.equal(older.body.check.status, "done");
});

test("push: no check and no `check` for a kind the shell draws, a PDF, or a push that makes no version; a replay answers its version's check as it is now", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  // A text entry: the shell draws it, nothing to open in a browser.
  const text = await create(app, world, [{ path: "notes.txt", content: "plain words" }]);
  assert.equal(text.status, 201);
  assert.equal(text.body.check, undefined);
  assert.deepEqual(await checksOf(text.body.artifact.id), []);
  // A PDF is framed, but not checked for now (shared ARTIFACT_CHECKED_KINDS).
  const pdf = await create(app, world, [{ path: "report.pdf", content_base64: Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64") }]);
  assert.equal(pdf.status, 201);
  assert.equal(pdf.body.artifact.kind, "pdf");
  assert.equal("check" in pdf.body, false);
  assert.deepEqual(await checksOf(pdf.body.artifact.id), []);

  const created = { target: `#${world.pub.name}`, title: `Checked ${label()}`, files: [{ path: "index.html", content: PAGE("one") }] };
  const page = await push(app, world.keys.a, created);
  const id = page.body.artifact.id as string;
  // The same create again answers v1 and its check.
  const createdAgain = await push(app, world.keys.a, created);
  assert.equal(createdAgain.body.replayed, true);
  assert.deepEqual(createdAgain.body.check, page.body.check);

  const body = { artifact: id, base: 1, files: [{ path: "index.html", content: PAGE("two") }] };
  const pushed = await push(app, world.keys.a, body);
  assert.equal(pushed.status, 201);
  // The same request again answers that version and its check, recording nothing more.
  const replayed = await push(app, world.keys.a, body);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.replayed, true);
  assert.ok(agentApiArtifactPublishedSchema.safeParse(replayed.body).success, "the answer is the contract's");
  assert.deepEqual(replayed.body.check, pushed.body.check);
  assert.deepEqual(replayed.body.check, { id: (await checksOf(id))[1]!.id, status: "pending" });
  // As it is now: done once the check task finished it; a status the first answer never has, still the contract's.
  await finishChecked(world, id, 2);
  const replayedDone = await push(app, world.keys.a, body);
  assert.ok(agentApiArtifactPublishedSchema.safeParse(replayedDone.body).success, "a done check is the contract's too");
  assert.deepEqual(replayedDone.body.check, { id: pushed.body.check.id, status: "done" });
  // Without a check Worker, nothing is served: no `check`.
  disableChecks();
  const replayedOff = await push(app, world.keys.a, body);
  assert.equal(replayedOff.body.replayed, true);
  assert.equal("check" in replayedOff.body, false);
  enableChecks();
  // A note alone makes no version.
  const unchanged = await push(app, world.keys.a, { artifact: id, base: 2, note: "just a note", files: [] });
  assert.equal(unchanged.body.unchanged, true);
  assert.equal(unchanged.body.check, undefined);
  // A title alone neither.
  const retitled = await push(app, world.keys.a, { artifact: id, base: 2, title: "A new title", files: [] });
  assert.ok(retitled.body.titleChanged);
  assert.equal(retitled.body.check, undefined);
  assert.deepEqual((await checksOf(id)).map((row) => row.number), [1, 2]);
});

test("push: a check whose recording fails (the cap count raises in Postgres) rolls back alone; the push answers 201 without `check` and records no row", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    injected.failCapCount = true;
    const created = await create(app, world, [{ path: "index.html", content: PAGE("one") }]);
    assert.equal(created.status, 201, "the push goes through");
    assert.ok(agentApiArtifactPublishedSchema.safeParse(created.body).success);
    assert.equal("check" in created.body, false);
    const id = created.body.artifact.id as string;
    assert.deepEqual(await checksOf(id), [], "the check's savepoint rolled back");
    // The rest of the push's transaction went on after the savepoint: v1 is the item's current version.
    const v1 = await versionOf(id, 1);
    const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)).limit(1);
    assert.equal(item!.currentVersionId, v1.id);
    const logged = warn.mock.calls.filter(([message]) => typeof message === "string" && message.includes("publish check was not recorded"));
    assert.equal(logged.length, 1);
    const fields = logged[0]![1] as Record<string, unknown>;
    assert.deepEqual(Object.keys(fields).sort(), ["errorClass", "sqlstate", "versionId"]);
    assert.equal(fields.versionId, v1.id);
    assert.equal(fields.sqlstate, "P0001", "raise_exception, from Postgres");
    assert.ok(!JSON.stringify(logged).includes("injected cap count failure"), "the log carries the class and SQLSTATE, never the message");

    // Working again, the next version is checked.
    injected.failCapCount = false;
    const next = await push(app, world.keys.a, { artifact: id, base: 1, files: [{ path: "index.html", content: PAGE("two") }] });
    assert.equal(next.status, 201);
    assert.equal(next.body.check.status, "pending");
    assert.deepEqual((await checksOf(id)).map((row) => [row.number, row.status]), [[2, "pending"]]);
  } finally {
    warn.mockRestore();
  }
});

test("push: without a check Worker nothing is recorded and the answer has no `check` (a token the routes refuse is none); with one, the next version is checked", async ({ app, seed }) => {
  const world = await seedWorld(seed, { checks: false });
  const created = await create(app, world, [{ path: "index.html", content: PAGE("one") }]);
  assert.equal(created.status, 201);
  assert.equal(created.body.check, undefined);
  assert.equal("check" in created.body, false);
  const id = created.body.artifact.id as string;
  assert.deepEqual(await checksOf(id), []);
  // A token the check routes would refuse (too short) is no check Worker either.
  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", "too-short");
  const short = await push(app, world.keys.a, { artifact: id, base: 1, files: [{ path: "index.html", content: PAGE("two") }] });
  assert.equal(short.status, 201, JSON.stringify(short.body));
  assert.equal("check" in short.body, false);
  assert.deepEqual(await checksOf(id), []);

  enableChecks();
  const next = await push(app, world.keys.a, { artifact: id, base: 2, files: [{ path: "index.html", content: PAGE("three") }] });
  assert.equal(next.body.check.status, "pending");
  assert.deepEqual((await checksOf(id)).map((row) => [row.number, row.status]), [[3, "pending"]]);
});

// ---- reading it ----------------------------------------------------------------

test("artifactCheck: pending as recorded, null without one, done with its findings and screenshots, an older version by `version`; it moves nothing", async ({ app, seed }) => {
  const world = await seedWorld(seed, { checks: false });
  const created = await create(app, world, [{ path: "index.html", content: PAGE("one") }]);
  const id = created.body.artifact.id as string;
  enableChecks();
  const v2 = await push(app, world.keys.a, { artifact: id, base: 1, files: [{ path: "index.html", content: PAGE("two") }] });

  // The current version (v2): pending, as the push answered it; another agent of the server reads it too.
  const pending = await readCheck(app, world.keys.b, id);
  assert.equal(pending.status, 200);
  assert.ok(agentApiArtifactCheckResponseSchema.safeParse(pending.body).success);
  assert.deepEqual(pending.body.artifact, { id, title: created.body.artifact.title, currentVersion: 2 });
  assert.equal(pending.body.version, 2);
  assert.deepEqual({ ...pending.body.check, createdAt: undefined }, {
    id: v2.body.check.id, status: "pending", skipReason: null, errorClass: null, findings: null, createdAt: undefined, finishedAt: null, screenshots: [],
  });
  // v1 was pushed without a check Worker: no check.
  const none = await readCheck(app, world.keys.a, id, 1);
  assert.deepEqual(none, { status: 200, body: { artifact: { id, title: created.body.artifact.title, currentVersion: 2 }, version: 1, check: null } });
  // A version it doesn't have.
  const missing = await readCheck(app, world.keys.a, id, 9);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "VERSION_NOT_FOUND");

  // Done, as the check task finishes it.
  const done = await finishChecked(world, id, 2);
  const read = await readCheck(app, world.keys.a, id, 2);
  assert.equal(read.body.check.status, "done");
  assert.deepEqual(read.body.check.findings, done.findings);
  assert.deepEqual(read.body.check.screenshots, [{ shot: "desktop" }, { shot: "phone" }]);
  assert.ok(read.body.check.finishedAt);
  assert.ok(!JSON.stringify(read.body).includes(done.desktop) && !JSON.stringify(read.body).includes(done.phone), "no file id: screenshots are named, fetched by artifactCheckShot");

  // A failed one: its class, nothing else.
  const v3 = await push(app, world.keys.a, { artifact: id, base: 2, files: [{ path: "index.html", content: PAGE("three") }] });
  await getDb().update(artifactVersionChecks).set({ status: "failed", errorClass: "load_timeout", finishedAt: new Date() }).where(eq(artifactVersionChecks.id, v3.body.check.id));
  const failed = await readCheck(app, world.keys.a, id);
  assert.equal(failed.body.version, 3);
  assert.deepEqual([failed.body.check.status, failed.body.check.errorClass, failed.body.check.findings, failed.body.check.screenshots], ["failed", "load_timeout", null, []]);
});

test("artifactCheckShot: a done check's screenshots as PNG bytes; SCREENSHOT_NOT_FOUND for a pending check and once let go", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await create(app, world, [{ path: "index.html", content: PAGE("one") }]);
  const id = created.body.artifact.id as string;

  // Pending: nothing to download.
  const early = await readShot(app.baseUrl, world.keys.a, id, "desktop");
  assert.equal(early.status, 404);
  assert.deepEqual(early.json, JSON.parse(JSON.stringify(refusalBody({
    code: "SCREENSHOT_NOT_FOUND",
    error: "Version 1 of this artifact has no desktop screenshot: only a finished publish check has screenshots, and only the newest three checked versions keep them, so read the version's check first.",
    next: RAFT_HINTS.artifactCheck({ artifact: id, version: 1 }),
    details: { shot: "desktop", version: 1 },
  }))));

  await finishChecked(world, id, 1);
  const desktop = await readShot(app.baseUrl, world.keys.b, id, "desktop", 1);
  assert.equal(desktop.status, 200);
  assert.equal(desktop.contentType, "image/png");
  assert.equal(desktop.disposition, 'attachment; filename="check-v1-desktop.png"');
  assert.ok(desktop.bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  const phone = await readShot(app.baseUrl, world.keys.a, id, "phone");
  assert.equal(phone.status, 200);
  assert.ok(!phone.bytes.equals(desktop.bytes), "each shot its own file");
  // Not a shot name.
  assert.equal((await readShot(app.baseUrl, world.keys.a, id, "tablet")).status, 400);

  // Four more checked versions: only the newest three keep their screenshots.
  for (const number of [2, 3, 4, 5]) {
    const next = await push(app, world.keys.a, { artifact: id, base: number - 1, files: [{ path: "index.html", content: PAGE(`v${number}`) }] });
    assert.equal(next.status, 201);
    await finishChecked(world, id, number);
  }
  await keepNewestCheckShots(id);
  const gone = await readShot(app.baseUrl, world.keys.a, id, "desktop", 1);
  assert.equal(gone.status, 404);
  assert.equal(gone.json?.code, "SCREENSHOT_NOT_FOUND");
  assert.deepEqual((await readCheck(app, world.keys.a, id, 1)).body.check.screenshots, [], "the row stays, without its screenshots");
  assert.equal((await readShot(app.baseUrl, world.keys.a, id, "desktop", 5)).status, 200);
});

test("the check routes: one 404 NOT_VISIBLE for an agent that can't see the Artifact and for another server's agent reading a public one", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await create(app, world, [{ path: "index.html", content: PAGE("one") }]);
  const id = created.body.artifact.id as string;
  await finishChecked(world, id, 1);

  // Not in #pub.
  const outCheck = await readCheck(app, world.keys.out, id);
  assert.equal(outCheck.status, 404);
  assert.equal(outCheck.body.code, "NOT_VISIBLE");
  const outShot = await readShot(app.baseUrl, world.keys.out, id, "desktop");
  assert.equal(outShot.status, 404);
  assert.equal(outShot.json?.code, "NOT_VISIBLE");

  // Public: another server's agent reads its current version, never its check.
  await getDb().update(artifactItems).set({ homeKind: "public", homeChannelId: null }).where(eq(artifactItems.id, id));
  assert.equal((await call(app.baseUrl, "GET", `/artifacts/${id}`, world.keys.peer)).status, 200, "the public face is readable");
  const peerCheck = await readCheck(app, world.keys.peer, id);
  assert.equal(peerCheck.status, 404);
  assert.equal(peerCheck.body.code, "NOT_VISIBLE");
  const peerShot = await readShot(app.baseUrl, world.keys.peer, id, "desktop");
  assert.equal(peerShot.status, 404);
  assert.equal(peerShot.json?.code, "NOT_VISIBLE");
  // The server's own agents still read it.
  assert.equal((await readCheck(app, world.keys.out, id)).body.check.status, "done");
});

test("the check routes on a deployment whose check Worker is gone: no check is served (null, SCREENSHOT_NOT_FOUND); configured again, the rows are there", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await create(app, world, [{ path: "index.html", content: PAGE("one") }]);
  const id = created.body.artifact.id as string;
  await finishChecked(world, id, 1);
  disableChecks();

  const read = await readCheck(app, world.keys.a, id);
  assert.equal(read.status, 200);
  assert.equal(read.body.check, null);
  const shot = await readShot(app.baseUrl, world.keys.a, id, "desktop");
  assert.equal(shot.status, 404);
  assert.equal(shot.json?.code, "SCREENSHOT_NOT_FOUND");

  enableChecks();
  assert.equal((await readCheck(app, world.keys.a, id)).body.check.status, "done");
  assert.equal((await readShot(app.baseUrl, world.keys.a, id, "desktop")).status, 200);
});
