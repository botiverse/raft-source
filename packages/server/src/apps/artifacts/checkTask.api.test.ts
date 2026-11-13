// The publish check Worker's API over HTTP (task #130; checkRoutes.ts,
// checkTask.ts; contract shared artifactCheckContract.ts): its token (unset
// or unusable 503 with nothing leased, missing or wrong 401), the lease (the
// oldest check that may run moves to `running`, its answer the version's
// check ticket, verified here as the content Worker verifies one: no
// ancestor, the version's own subject; 204 with none; flags off, an
// Artifact gone or a cap reached finish the row instead), the result (two
// screenshots stored as the publisher's object files of the Artifact, hung
// on the version, the row finished in one transaction; only while that lease
// is current: late, repeated or another lease's 409 with nothing written),
// the retry of a lost lease and the expiry that bounds it; fair leasing
// between servers, fewest running first, with no per-server cap (task #185).
// The spans (trace.ts): a finished result says how long the whole check
// (`check_ms`) and its last run (`run_ms`) took and the version's `kind`;
// neither route's span carries an id.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  ARTIFACT_CHECK_SHOT_MAX_BYTES,
  ARTIFACT_CHECK_TIMING_MAX_MS,
  artifactCheckWorkerPaths,
  asServerId,
  BasicTracer,
  MemoryTraceSink,
  type ArtifactCheckLease,
  type ArtifactCheckReport,
  type CompletedTraceSpan,
} from "@botiverse/raft-shared";
import { ARTIFACT_CONTENT_CHECK_VIEWER, artifactContentTicketKey, verifyArtifactContentTicket } from "@botiverse/raft-shared/src/artifactContentTicket";
import { getDb } from "../../db/index";
import { objectFiles } from "../../db/schema";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { installMemoryObjectFilesStorage } from "../../test/memoryObjectFilesStorage";
import { testPng } from "../../test/objectFileTestImages";
import { ARTIFACT_CHECK_LEASE_MS, checkShotFileOf, checkShotPart } from "./checks";
import { ARTIFACT_CHECK_RUN_WINDOW_MS, expireStaleChecks } from "./checkTask";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactItems, artifactVersionChecks, artifactVersions, type ArtifactVersionCheckRow, type ArtifactVersionRow } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

const CHECK_TOKEN = "k".repeat(40);
const WORKER_TOKEN = "w".repeat(40);
const RAFT_TOKEN = "r".repeat(40);
const CONTENT_DOMAIN = "content.example.test";
const originOf = (artifact: string) => `https://w-${artifact.replace(/^pt_/, "")}.${CONTENT_DOMAIN}`;
// A real PNG (core keeps only images whose header parses).
const PNG = (label: string) => testPng(label);

let storage: ReturnType<typeof installMemoryObjectFilesStorage>;
beforeEach(() => {
  storage = installMemoryObjectFilesStorage();
});
afterEach(() => {
  storage.restore();
  vi.unstubAllEnvs();
});

/** The check Worker's token and the content origin configured (unless `token: null`). */
function configure(opts: { token?: string | null; contentOrigin?: boolean } = {}) {
  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", opts.token === null ? "" : opts.token ?? CHECK_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", opts.contentOrigin === false ? "" : WORKER_TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", opts.contentOrigin === false ? "" : CONTENT_DOMAIN);
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", RAFT_TOKEN);
}

/** A server with Artifacts on, its owner, and a way to push versions with a pending check. */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const makeItem = async () => {
    const id = `pt_${randomUUID()}`;
    const [item] = await db.insert(artifactItems).values({ id, serverId, urlKey: id, name: id, title: id, homeKind: "server", createdByType: "user", createdById: owner.id }).returning();
    return item!;
  };
  /** Version `number` of `itemId`, published and current, with its check (`pending` unless `check` says otherwise). */
  const push = async (itemId: string, number: number, check: Partial<typeof artifactVersionChecks.$inferInsert> = {}) => {
    const [version] = await db.insert(artifactVersions).values({
      id: `v_${randomUUID()}`, itemId, number, entry: "index.html", fileCount: 1, sizeBytes: 1,
      publishDigest: "digest", status: "published", publisherType: "user", publisherId: owner.id, position: number,
    }).returning();
    await db.update(artifactItems).set({ currentVersionId: version!.id, lastPosition: number }).where(eq(artifactItems.id, itemId));
    const [row] = await db.insert(artifactVersionChecks).values({ versionId: version!.id, status: "pending", ...check }).returning();
    return { version: version!, check: row! };
  };
  return { owner, server, serverId, makeItem, push };
}

const rowOf = async (checkId: string): Promise<ArtifactVersionCheckRow> =>
  (await getDb().select().from(artifactVersionChecks).where(eq(artifactVersionChecks.id, checkId)).limit(1))[0]!;

// ---- HTTP ------------------------------------------------------------------------------

async function lease(baseUrl: string, token: string | null = CHECK_TOKEN) {
  const res = await fetch(`${baseUrl}${artifactCheckWorkerPaths.lease}`, {
    method: "POST",
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, cacheControl: res.headers.get("cache-control"), body: text === "" ? null : JSON.parse(text) as ArtifactCheckLease & { error?: string } };
}

const okReport = (leased: ArtifactCheckLease, overrides: Partial<ArtifactCheckReport> = {}): ArtifactCheckReport => ({
  checkId: leased.checkId,
  lease: leased.lease,
  load: { outcome: "ok" },
  consoleErrors: [{ message: "Uncaught TypeError: x is undefined", source: "index.html", line: 12 }],
  blockedResources: ["https://cdn.example.com/lib.js"],
  blank: false,
  phoneOverflow: { contentWidth: 640, viewportWidth: 390 },
  ...overrides,
});

async function result(
  baseUrl: string,
  checkId: string,
  report: unknown,
  shots: { desktop?: Buffer; phone?: Buffer } = {},
  token: string | null = CHECK_TOKEN,
) {
  const form = new FormData();
  form.set("report", typeof report === "string" ? report : JSON.stringify(report));
  for (const [name, bytes] of Object.entries(shots)) form.set(name, new Blob([new Uint8Array(bytes)], { type: "image/png" }), `${name}.png`);
  const res = await fetch(`${baseUrl}${artifactCheckWorkerPaths.result(checkId)}`, {
    method: "POST",
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json() as { status?: string; error?: string } };
}

const filesOf = (versionId: string) => getDb().select().from(objectFiles)
  .where(and(eq(objectFiles.objectKind, ARTIFACT_OBJECT_KIND), eq(objectFiles.parent, checkShotPart(versionId))));
const allFiles = () => getDb().select({ id: objectFiles.id }).from(objectFiles);

/** Records the app's traces from here on. */
function traced(app: { app: { set(key: string, value: unknown): unknown } }): MemoryTraceSink {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  return sink;
}

/** The spans named `name`, oldest first, each checked to be a child of its request's span and timed. */
function spansOf(sink: MemoryTraceSink, name: string): CompletedTraceSpan[] {
  const spans = sink.getAllSpans().filter((span) => span.name === name);
  for (const span of spans) {
    const parent = sink.getAllSpans().find((candidate) => candidate.context.spanId === span.context.parentSpanId);
    assert.equal(parent?.name, "server.http.request", `${name} is a child of its request's span`);
    assert.equal(typeof span.attrs?.duration_ms, "number");
  }
  return spans;
}

// ---- the token -------------------------------------------------------------------------

test("auth: without ARTIFACTS_CHECK_WORKER_TOKEN (or with an unusable one) every route is 503 and nothing is leased; a missing or wrong token 401", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const { check } = await world.push((await world.makeItem()).id, 1);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    configure({ token: null });
    assert.equal((await lease(app.baseUrl)).status, 503, "unset");
    assert.equal((await result(app.baseUrl, check.id, { checkId: check.id })).status, 503);
    configure({ token: "short" });
    assert.equal((await lease(app.baseUrl, "short")).status, 503, "shorter than 32 bytes");
    configure({ token: WORKER_TOKEN });
    assert.equal((await lease(app.baseUrl, WORKER_TOKEN)).status, 503, "the content Worker's ticket token: each caller its own");
    configure({ token: RAFT_TOKEN });
    assert.equal((await lease(app.baseUrl, RAFT_TOKEN)).status, 503, "one of the content Worker's tokens to Raft");
    assert.equal((await rowOf(check.id)).status, "pending", "nothing leased");

    configure();
    assert.equal((await lease(app.baseUrl, null)).status, 401, "no token");
    assert.equal((await lease(app.baseUrl, "x".repeat(40))).status, 401, "a wrong one");
    assert.equal((await lease(app.baseUrl, RAFT_TOKEN)).status, 401, "the content Worker's token is not the check Worker's");
    assert.equal((await result(app.baseUrl, check.id, { checkId: check.id }, {}, "x".repeat(40))).status, 401);
    assert.equal((await rowOf(check.id)).status, "pending", "still nothing leased");
    const logged = JSON.stringify(warn.mock.calls);
    assert.ok(!logged.includes("x".repeat(40)) && !logged.includes(CHECK_TOKEN), "never a token in a log");
  } finally {
    warn.mockRestore();
  }
});

// ---- the lease -------------------------------------------------------------------------

test("lease: the oldest pending check moves to running and its answer is the version's check ticket (no ancestor, its own subject); then 204", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  const first = await world.push(item.id, 1, { createdAt: new Date(Date.now() - 60_000) });
  const second = await world.push(item.id, 2);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const before = Date.now();
    const leased = await lease(app.baseUrl);
    assert.equal(leased.status, 200, JSON.stringify(leased.body));
    assert.equal(leased.cacheControl, "no-store", "it carries a ticket");
    const body = leased.body!;
    assert.deepEqual(Object.keys(body).sort(), ["artifactId", "checkId", "lease", "leaseExpiresAt", "url", "versionId", "viewports"]);
    assert.equal(body.checkId, first.check.id, "the oldest first");
    assert.equal(body.artifactId, item.id);
    assert.equal(body.versionId, first.version.id);
    assert.deepEqual(body.viewports.map((viewport) => viewport.shot), ["desktop", "phone"]);
    assert.ok(body.viewports.every((viewport) => viewport.width > 0 && viewport.height > 0));
    assert.ok(body.viewports.find((viewport) => viewport.shot === "phone")!.mobile);

    // The ticket, verified exactly as the content Worker verifies one: no ancestor to expect.
    const url = new URL(body.url);
    assert.equal(url.origin, originOf(item.id));
    assert.equal(url.pathname, "/_raft/open");
    const verified = await verifyArtifactContentTicket(url.searchParams.get("ticket")!, [await artifactContentTicketKey(WORKER_TOKEN)], { origin: url.origin });
    assert.ok(verified.ok, JSON.stringify(verified));
    assert.equal(verified.claims.viewer, ARTIFACT_CONTENT_CHECK_VIEWER);
    assert.equal(verified.claims.subject, `v1:check:${item.id}:${first.version.id}`);
    assert.equal(verified.claims.version, first.version.id);
    assert.equal(verified.claims.artifact, item.id);
    assert.equal("ancestor" in verified.claims, false);

    const row = await rowOf(first.check.id);
    assert.equal(row.status, "running");
    assert.equal(row.leaseExpiresAt!.toISOString(), body.lease);
    assert.equal(body.leaseExpiresAt, body.lease);
    assert.ok(row.leaseExpiresAt!.getTime() >= before + ARTIFACT_CHECK_LEASE_MS - 1000 && row.leaseExpiresAt!.getTime() <= Date.now() + ARTIFACT_CHECK_LEASE_MS);
    // Its subject reads the version now (contentRoutes.ts decideCheck: running, within the lease).
    const authorize = await fetch(`${app.baseUrl}/internal/artifacts-content/authorize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RAFT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ artifact: item.id, version: first.version.id, subject: verified.claims.subject }),
    });
    assert.deepEqual(await authorize.json(), { allow: true });

    // The next lease takes the next one; then there is none.
    assert.equal((await lease(app.baseUrl)).body!.checkId, second.check.id);
    const none = await lease(app.baseUrl);
    assert.equal(none.status, 204);
    assert.equal(none.body, null);
    // Ids only in the log, never the url or its ticket.
    const logged = JSON.stringify(info.mock.calls);
    assert.ok(!logged.includes(body.url) && !logged.includes(url.searchParams.get("ticket")!), "never the ticket in a log");
  } finally {
    info.mockRestore();
  }
});

test("lease: no pending check is 204; finished, skipped and live-leased rows are never leased", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  await world.push(item.id, 1, { status: "done", finishedAt: new Date() });
  await world.push(item.id, 2, { status: "skipped", skipReason: "unchanged", finishedAt: new Date() });
  await world.push(item.id, 3, { status: "failed", errorClass: "load_timeout", finishedAt: new Date() });
  await world.push(item.id, 4, { status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) });
  assert.equal((await lease(app.baseUrl)).status, 204);
});

test("lease: with Artifacts off for its server, the Artifact or version gone, or a PDF, nothing is leased and the row fails", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const artifactsOff = await world.push((await world.makeItem()).id, 1);
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
    assert.equal((await lease(app.baseUrl)).status, 204, "Artifacts off: nothing leased");
    assert.deepEqual([(await rowOf(artifactsOff.check.id)).status, (await rowOf(artifactsOff.check.id)).errorClass], ["failed", "disabled"]);
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);

    const revokedItem = await world.makeItem();
    const revoked = await world.push(revokedItem.id, 1);
    await getDb().update(artifactItems).set({ revokedAt: new Date() }).where(eq(artifactItems.id, revokedItem.id));
    const revokedVersion = await world.push((await world.makeItem()).id, 1);
    await getDb().update(artifactVersions).set({ revokedAt: new Date() }).where(eq(artifactVersions.id, revokedVersion.version.id));
    assert.equal((await lease(app.baseUrl)).status, 204);
    assert.equal((await rowOf(revoked.check.id)).errorClass, "not_readable");
    assert.equal((await rowOf(revokedVersion.check.id)).errorClass, "not_readable");

    // A PDF's pending check (recorded before checks left PDFs out, shared ARTIFACT_CHECKED_KINDS): never leased, failed `not_checked`.
    const pdf = await world.push((await world.makeItem()).id, 1);
    await getDb().update(artifactVersions).set({ entry: "report.pdf" }).where(eq(artifactVersions.id, pdf.version.id));
    assert.equal((await lease(app.baseUrl)).status, 204, "a PDF: nothing leased");
    assert.deepEqual([(await rowOf(pdf.check.id)).status, (await rowOf(pdf.check.id)).errorClass], ["failed", "not_checked"]);

    // A Markdown version's pending check (recorded before Markdown stopped being checked): the same.
    const markdown = await world.push((await world.makeItem()).id, 1);
    await getDb().update(artifactVersions).set({ entry: "README.md" }).where(eq(artifactVersions.id, markdown.version.id));
    assert.equal((await lease(app.baseUrl)).status, 204, "Markdown: nothing leased");
    assert.deepEqual([(await rowOf(markdown.check.id)).status, (await rowOf(markdown.check.id)).errorClass], ["failed", "not_checked"]);

    // Reverse control: with Artifacts on, a live version's check is leased.
    const live = await world.push((await world.makeItem()).id, 1);
    assert.equal((await lease(app.baseUrl)).body!.checkId, live.check.id);
  } finally {
    info.mockRestore();
  }
});

/** `count` past times a minute apart, oldest first, all on one UTC day: the last a minute ago, or before midnight just after it. */
function sameUtcDayMinutes(count: number, now = Date.now()): Date[] {
  const midnight = new Date(now).setUTCHours(0, 0, 0, 0);
  const last = now - midnight > (count + 1) * 60_000 ? now - 60_000 : midnight - 60_000;
  return Array.from({ length: count }, (_, index) => new Date(last - (count - 1 - index) * 60_000));
}

test("sameUtcDayMinutes: one UTC day, in the past, a minute apart, also just after midnight", () => {
  for (const now of [Date.UTC(2026, 10, 13, 12, 0), Date.UTC(2026, 10, 13, 0, 2), Date.UTC(2026, 10, 13, 0, 0, 30)]) {
    const times = sameUtcDayMinutes(3, now);
    assert.equal(new Set(times.map((time) => time.toISOString().slice(0, 10))).size, 1, new Date(now).toISOString());
    assert.ok(times.every((time) => time.getTime() < now));
    assert.deepEqual(times.slice(1).map((time, index) => time.getTime() - times[index]!.getTime()), [60_000, 60_000]);
  }
});

test("lease: the daily caps as they are now: past the server's cap a pending check is skipped with it, the first of the day still run", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  // The caps count by the UTC day a check was recorded on (mayStartCheck), so the three are recorded on one day:
  // minutes ago, or, in the first minutes after midnight, just before it (on CI at 00:0x UTC the third fell on the
  // new day and ran as the first of it).
  const sameDay = sameUtcDayMinutes(3);
  const first = await world.push(item.id, 1, { createdAt: sameDay[0]! });
  const second = await world.push(item.id, 2, { createdAt: sameDay[1]! });
  const third = await world.push(item.id, 3, { createdAt: sameDay[2]! });
  // The cap lowered after they were recorded.
  vi.stubEnv("ARTIFACTS_CHECK_DAILY_PER_SERVER", "2");
  assert.equal((await lease(app.baseUrl)).body!.checkId, first.check.id);
  assert.equal((await lease(app.baseUrl)).body!.checkId, second.check.id);
  assert.equal((await lease(app.baseUrl)).status, 204, "the third is over the cap");
  const skipped = await rowOf(third.check.id);
  assert.deepEqual([skipped.status, skipped.skipReason], ["skipped", "server_daily_cap"]);
  assert.ok(skipped.finishedAt !== null);
  // The platform's cap the same way, named after the server's.
  vi.stubEnv("ARTIFACTS_CHECK_DAILY_PER_SERVER", "100");
  vi.stubEnv("ARTIFACTS_CHECK_DAILY_TOTAL", "0");
  const fourth = await world.push(item.id, 4);
  assert.equal((await lease(app.baseUrl)).status, 204);
  assert.equal((await rowOf(fourth.check.id)).skipReason, "platform_daily_cap");
});

test("lease: fair between servers: the server with the fewest checks running first, then the oldest, so a busy server doesn't starve another", async ({ app, seed }) => {
  configure();
  const busy = await seedWorld(seed);
  const quiet = await seedWorld(seed);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const busyItem = await busy.makeItem();
  const quietItem = await quiet.makeItem();
  // The busy server pushed first and most; the quiet one's checks are all newer.
  const b1 = await busy.push(busyItem.id, 1, { createdAt: at(5) });
  const b2 = await busy.push(busyItem.id, 2, { createdAt: at(4) });
  const b3 = await busy.push(busyItem.id, 3, { createdAt: at(3) });
  const q1 = await quiet.push(quietItem.id, 1, { createdAt: at(2) });
  const q2 = await quiet.push(quietItem.id, 2, { createdAt: at(1) });
  const leased: string[] = [];
  for (let count = 0; count < 5; count += 1) {
    const answer = await lease(app.baseUrl);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    leased.push(answer.body!.checkId);
  }
  // Oldest first alone would have been b1, b2, b3, q1, q2.
  assert.deepEqual(leased, [b1, q1, b2, q2, b3].map((pushed) => pushed.check.id), "servers take turns, each its oldest first");
  assert.equal((await lease(app.baseUrl)).status, 204);
});

test("lease: no per-server cap, fewest running first: another server's newer check goes before a busy server's older ones, and a lost lease doesn't count as running", async ({ app, seed }) => {
  configure();
  const busy = await seedWorld(seed);
  const other = await seedWorld(seed);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const item = await busy.makeItem();
  const otherItem = await other.makeItem();
  const pushed: Array<Awaited<ReturnType<typeof busy.push>>> = [];
  for (let number = 1; number <= 5; number += 1) pushed.push(await busy.push(item.id, number, { createdAt: at(9 - number) }));
  const leaseOf = async () => {
    const answer = await lease(app.baseUrl);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body!;
  };
  const leases: ArtifactCheckLease[] = [];
  for (let count = 0; count < 2; count += 1) leases.push(await leaseOf());
  assert.deepEqual(leases.map((each) => each.checkId), pushed.slice(0, 2).map((each) => each.check.id));

  // Another server's check, newer than all of the busy server's waiting ones, goes first (it has
  // none running, the busy server two); oldest first alone would take the busy server's third.
  const e1 = await other.push(otherItem.id, 1, { createdAt: at(1) });
  assert.equal((await leaseOf()).checkId, e1.check.id);
  for (const waiting of pushed.slice(2)) {
    const row = await rowOf(waiting.check.id);
    assert.deepEqual([row.status, row.leaseExpiresAt, row.finishedAt], ["pending", null, null], "left waiting, not finished");
  }
  // Nothing else waits: the busy server leases on.
  assert.equal((await leaseOf()).checkId, pushed[2]!.check.id);
  // The other server's next check goes first again (one running to three).
  const e2 = await other.push(otherItem.id, 2, { createdAt: at(0.5) });
  assert.equal((await leaseOf()).checkId, e2.check.id);

  // Two of the busy server's leases run out (lost): it has one running to the other's two, so its
  // oldest lost one goes before the other server's newer check. Were lost leases counted (three
  // running to two), the other's would go first.
  for (const lost of leases) await getDb().update(artifactVersionChecks).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(artifactVersionChecks.id, lost.checkId));
  const e3 = await other.push(otherItem.id, 3);
  assert.equal((await leaseOf()).checkId, leases[0]!.checkId);
  // Two running each: the oldest goes, the busy server's other lost one.
  assert.equal((await leaseOf()).checkId, leases[1]!.checkId);
  // The other server has fewer running now.
  assert.equal((await leaseOf()).checkId, e3.check.id);
  // The rest, nothing else waiting.
  assert.deepEqual([(await leaseOf()).checkId, (await leaseOf()).checkId], pushed.slice(3).map((each) => each.check.id));
  assert.equal((await lease(app.baseUrl)).status, 204);
});

test("lease: alone, a server's checks all lease, 8 of them running at once (no per-server cap)", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);
  const pushed: Array<Awaited<ReturnType<typeof world.push>>> = [];
  for (let number = 1; number <= 8; number += 1) pushed.push(await world.push(item.id, number, { createdAt: at(60 - number) }));
  const leased: string[] = [];
  for (let count = 0; count < 8; count += 1) {
    const answer = await lease(app.baseUrl);
    // A cap of fewer than eight a server would answer 204 here.
    assert.equal(answer.status, 200, `lease ${count + 1}: ${JSON.stringify(answer.body)}`);
    leased.push(answer.body!.checkId);
  }
  assert.deepEqual(leased, pushed.map((each) => each.check.id), "oldest first, none held back");
  for (const each of pushed) assert.equal((await rowOf(each.check.id)).status, "running");
  assert.equal((await lease(app.baseUrl)).status, 204);
});

test("lease: without a content origin to sign for it is 503 and the check stays pending", async ({ app, seed }) => {
  configure({ contentOrigin: false });
  const world = await seedWorld(seed);
  const { check } = await world.push((await world.makeItem()).id, 1);
  assert.equal((await lease(app.baseUrl)).status, 503);
  const row = await rowOf(check.id);
  assert.deepEqual([row.status, row.leaseExpiresAt], ["pending", null], "rolled back: nothing leased");
});

// ---- the result ------------------------------------------------------------------------

test("result: two screenshots stored as the publisher's files of the Artifact, hung on the version, and the row done in one go", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  const { version, check } = await world.push(item.id, 1);
  const leased = (await lease(app.baseUrl)).body!;
  const shots = { desktop: PNG("desktop"), phone: PNG("phone") };
  const answer = await result(app.baseUrl, check.id, okReport(leased), shots);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { status: "done" });

  const row = await rowOf(check.id);
  assert.equal(row.status, "done");
  assert.ok(row.finishedAt !== null);
  assert.equal(row.leaseExpiresAt, null, "the lease is gone with the check");
  assert.deepEqual(row.findings, {
    consoleErrors: [{ message: "Uncaught TypeError: x is undefined", source: "index.html", line: 12 }],
    blockedResources: ["https://cdn.example.com/lib.js"],
    blank: false,
    phoneOverflow: { contentWidth: 640, viewportWidth: 390 },
  });
  const files = await filesOf(version.id);
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.equal(file.objectId, item.id);
    assert.equal(file.state, "claimed");
    assert.deepEqual([file.uploadedByType, file.uploadedById], ["user", world.owner.id], "uploaded by the version's publisher");
    assert.equal(file.contentType, "image/png");
  }
  assert.equal(await checkShotFileOf(version.id, "desktop"), row.desktopFileId);
  assert.equal(await checkShotFileOf(version.id, "phone"), row.phoneFileId);
  const stored = [...storage.objects.values()].map((object) => object.bytes.toString("latin1")).sort();
  assert.deepEqual(stored, [shots.desktop.toString("latin1"), shots.phone.toString("latin1")].sort());
});

test("result: a late, repeated or another lease's result is 409 and writes nothing", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const { version, check } = await world.push((await world.makeItem()).id, 1);
    const leased = (await lease(app.baseUrl)).body!;
    const shots = { desktop: PNG("desktop"), phone: PNG("phone") };

    // Another lease's token (a stale holder's), then a lease that ran out.
    assert.equal((await result(app.baseUrl, check.id, okReport(leased, { lease: new Date(Date.parse(leased.lease) - 1000).toISOString() }), shots)).status, 409);
    await getDb().update(artifactVersionChecks).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(artifactVersionChecks.id, check.id));
    const expired = (await rowOf(check.id)).leaseExpiresAt!.toISOString();
    assert.equal((await result(app.baseUrl, check.id, okReport(leased, { lease: expired }), shots)).status, 409, "past its lease");
    assert.equal((await rowOf(check.id)).status, "running");
    assert.deepEqual(await allFiles(), [], "nothing stored");
    assert.equal(storage.objects.size, 0);

    // A fresh lease, its result, then the same result again.
    await getDb().update(artifactVersionChecks).set({ status: "pending", leaseExpiresAt: null }).where(eq(artifactVersionChecks.id, check.id));
    const again = (await lease(app.baseUrl)).body!;
    assert.equal((await result(app.baseUrl, check.id, okReport(again), shots)).status, 200);
    const done = await rowOf(check.id);
    const repeated = await result(app.baseUrl, check.id, okReport(again), { desktop: PNG("other"), phone: PNG("other") });
    assert.equal(repeated.status, 409);
    assert.deepEqual(await rowOf(check.id), done, "the row unchanged");
    assert.equal((await filesOf(version.id)).length, 2, "no file added");
    assert.equal((await allFiles()).length, 2);
    // No such check.
    assert.equal((await result(app.baseUrl, randomUUID(), okReport({ ...again, checkId: randomUUID() }))).status, 400, "a report naming another check than its path");
    const unknown = randomUUID();
    assert.equal((await result(app.baseUrl, unknown, okReport({ ...again, checkId: unknown }))).status, 404);
  } finally {
    info.mockRestore();
  }
});

test("result: a page that didn't load fails the check with its cause and keeps no screenshot", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const timedOut = await world.push((await world.makeItem()).id, 1);
  const leased = (await lease(app.baseUrl)).body!;
  assert.deepEqual((await result(app.baseUrl, timedOut.check.id, okReport(leased, { load: { outcome: "timeout" } }), { desktop: PNG("half") })).body, { status: "failed" });
  const row = await rowOf(timedOut.check.id);
  assert.deepEqual([row.status, row.errorClass, row.desktopFileId, row.findings], ["failed", "load_timeout", null, null]);
  assert.deepEqual(await allFiles(), []);

  const crashed = await world.push((await world.makeItem()).id, 1);
  const second = (await lease(app.baseUrl)).body!;
  await result(app.baseUrl, crashed.check.id, okReport(second, { load: { outcome: "error", errorClass: "navigation.net_error" } }));
  assert.equal((await rowOf(crashed.check.id)).errorClass, "load_error:navigation.net_error");
});

test("result: the report is capped (ten console errors, twenty blocked URLs, each cut) and a body that isn't one is refused", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const { check } = await world.push((await world.makeItem()).id, 1);
  const leased = (await lease(app.baseUrl)).body!;
  // Refused, nothing written: not JSON, not a report, not a PNG, too large.
  assert.equal((await result(app.baseUrl, check.id, "{not json")).status, 400);
  assert.equal((await result(app.baseUrl, check.id, { checkId: check.id, lease: leased.lease })).status, 400);
  assert.equal((await result(app.baseUrl, check.id, okReport(leased), { desktop: Buffer.from("GIF89a not a png") })).status, 400);
  assert.equal((await result(app.baseUrl, check.id, okReport(leased), { desktop: Buffer.concat([PNG("big"), Buffer.alloc(ARTIFACT_CHECK_SHOT_MAX_BYTES)]) })).status, 413);
  assert.equal((await rowOf(check.id)).status, "running");

  // Long enough to be cut, short enough for the report's 64 KiB field.
  const long = "e".repeat(1_000);
  const answer = await result(app.baseUrl, check.id, okReport(leased, {
    consoleErrors: Array.from({ length: 12 }, (_, at) => ({ message: `${at}\u0000${long}`, source: null, line: null })),
    blockedResources: Array.from({ length: 25 }, (_, at) => `https://cdn.example.com/${at}/${long}`),
    blank: true,
    phoneOverflow: null,
  }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const findings = (await rowOf(check.id)).findings!;
  assert.equal(findings.consoleErrors.length, 10);
  assert.equal(findings.blockedResources.length, 20);
  assert.ok(findings.consoleErrors.every((entry) => [...entry.message].length === 300 && !entry.message.includes("\u0000")));
  assert.ok(findings.blockedResources.every((entry) => entry.length === 300));
  assert.equal(findings.consoleErrors[0]!.message.slice(0, 2), "0 ", "the first ones kept, control characters as spaces");
  assert.equal(findings.blank, true);
  assert.equal(findings.phoneOverflow, null);
  assert.equal((await rowOf(check.id)).desktopFileId, null, "no screenshot sent: none kept");
});

// ---- retry and expiry ------------------------------------------------------------------

test("a lost lease is leased again within the run window, the stale holder's result refused; past the window the expiry fails it", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const { check } = await world.push((await world.makeItem()).id, 1);
    const firstLease = (await lease(app.baseUrl)).body!;
    // The first attempt died: its lease ran out.
    await getDb().update(artifactVersionChecks).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(artifactVersionChecks.id, check.id));
    const retry = await lease(app.baseUrl);
    assert.equal(retry.status, 200);
    assert.equal(retry.body!.checkId, check.id, "the same check again");
    assert.notEqual(retry.body!.lease, firstLease.lease, "under a new lease");
    assert.equal((await result(app.baseUrl, check.id, okReport(firstLease))).status, 409, "the first attempt's result is stale");
    assert.equal((await result(app.baseUrl, check.id, okReport(retry.body!))).status, 200);

    // Past the window: neither a pending check nor a lost one is leased, and the expiry fails both.
    const old = new Date(Date.now() - ARTIFACT_CHECK_RUN_WINDOW_MS - 60_000);
    const pending = await world.push((await world.makeItem()).id, 1, { createdAt: old });
    const lost = await world.push((await world.makeItem()).id, 1, { createdAt: old, status: "running", leaseExpiresAt: new Date(Date.now() - 1000) });
    const live = await world.push((await world.makeItem()).id, 1, { createdAt: old, status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) });
    assert.equal((await lease(app.baseUrl)).status, 204, "too old to run");
    assert.equal(await expireStaleChecks(), 2);
    assert.deepEqual([(await rowOf(pending.check.id)).status, (await rowOf(pending.check.id)).errorClass], ["failed", "expired"]);
    assert.deepEqual([(await rowOf(lost.check.id)).status, (await rowOf(lost.check.id)).errorClass], ["failed", "lease_expired"]);
    assert.equal((await rowOf(live.check.id)).status, "running", "a lease still held runs out first");
    assert.equal(await expireStaleChecks(), 0, "once");
  } finally {
    info.mockRestore();
  }
});

// ---- the spans -------------------------------------------------------------------------

test("spans: a finished result says how long the whole check and its run took, and the version's kind; no span of either route carries an id", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    // Recorded 45 s ago (the push), leased now; then the lease moved 20 s back, as if taken that long ago.
    const queued = await world.push(item.id, 1, { createdAt: new Date(Date.now() - 45_000) });
    const sink = traced(app);
    const leased = (await lease(app.baseUrl)).body!;
    const expiry = new Date(Date.parse(leased.lease) - 20_000);
    await getDb().update(artifactVersionChecks).set({ leaseExpiresAt: expiry }).where(eq(artifactVersionChecks.id, queued.check.id));
    assert.deepEqual((await result(app.baseUrl, queued.check.id, okReport(leased, { lease: expiry.toISOString() }), { desktop: PNG("desktop") })).body, { status: "done" });

    const [leaseSpan] = spansOf(sink, "server.artifacts.check.lease");
    assert.deepEqual([leaseSpan!.attrs?.outcome, leaseSpan!.status], ["leased", "ok"]);

    const [done, ...more] = spansOf(sink, "server.artifacts.check.result");
    assert.equal(more.length, 0);
    const row = await rowOf(queued.check.id);
    const { load, outcome, kind, check_ms, run_ms, duration_ms: requestMs } = done!.attrs as Record<string, unknown>;
    const attrs = { load, outcome, kind, check_ms, run_ms };
    assert.deepEqual(attrs, {
      load: "ok",
      outcome: "done",
      kind: "html",
      // The row's own times: recorded to finished, and this lease taken (its expiry less the lease's length) to finished.
      check_ms: row.finishedAt!.getTime() - row.createdAt.getTime(),
      run_ms: row.finishedAt!.getTime() - (expiry.getTime() - ARTIFACT_CHECK_LEASE_MS),
    });
    assert.ok((attrs.check_ms as number) >= 45_000 && (attrs.check_ms as number) < 60_000, `the whole check, waiting included: ${attrs.check_ms}`);
    assert.ok((attrs.run_ms as number) >= 20_000 && (attrs.run_ms as number) < (attrs.check_ms as number), `the run alone: ${attrs.run_ms}`);
    assert.ok((requestMs as number) < 20_000, "duration_ms is still the result request's own time");

    // A check that failed to load is finished too: the same attributes.
    const failing = await world.push(item.id, 2);
    const second = (await lease(app.baseUrl)).body!;
    assert.deepEqual((await result(app.baseUrl, failing.check.id, okReport(second, { load: { outcome: "timeout" } }))).body, { status: "failed" });
    const failedRow = await rowOf(failing.check.id);
    const failed = spansOf(sink, "server.artifacts.check.result")[1]!;
    assert.deepEqual(
      [failed.attrs?.load, failed.attrs?.outcome, failed.attrs?.kind, failed.attrs?.check_ms, failed.attrs?.run_ms],
      ["timeout", "failed", "html", failedRow.finishedAt!.getTime() - failedRow.createdAt.getTime(), failedRow.finishedAt!.getTime() - (Date.parse(second.lease) - ARTIFACT_CHECK_LEASE_MS)],
    );

    // A result that finished nothing (the same one again: 409) carries no kind and no times; a lease never does.
    assert.equal((await result(app.baseUrl, failing.check.id, okReport(second, { load: { outcome: "timeout" } }))).status, 409);
    const refused = spansOf(sink, "server.artifacts.check.result")[2]!;
    assert.deepEqual([refused.attrs?.load, refused.attrs?.outcome], ["timeout", "conflict"]);
    for (const key of ["kind", "check_ms", "run_ms"]) assert.equal(key in refused.attrs!, false, `no ${key} on a result that finished nothing`);
    assert.equal((await lease(app.baseUrl)).status, 204);
    const leases = spansOf(sink, "server.artifacts.check.lease");
    assert.deepEqual(leases.map((span) => span.attrs?.outcome), ["leased", "leased", "none"]);
    for (const span of leases) for (const key of ["kind", "check_ms", "run_ms"]) assert.equal(key in span.attrs!, false, `no ${key} on a lease`);

    // Never an id in a span of either route: not itself, and no attribute is added to say one (a hash of one neither).
    const all = [...leases, ...spansOf(sink, "server.artifacts.check.result")];
    const said = JSON.stringify(all.map((span) => span.attrs));
    for (const id of [item.id, queued.version.id, queued.check.id, failing.version.id, failing.check.id]) assert.ok(!said.includes(id), "never a raw id");
    for (const span of all) assert.deepEqual(Object.keys(span.attrs ?? {}).filter((key) => /hash|^version|^artifact|_id$/.test(key)), [], "no attribute names a version, an Artifact or a check");
  } finally {
    info.mockRestore();
  }
});

test("spans: a finished result also says where the Worker's run went, stage by stage; a timing that isn't one is left out and the check still finishes", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const sink = traced(app);
    const stages = ["browser_ms", "prepare_ms", "load_ms", "settle_ms", "shots_ms"];
    const timed = await world.push(item.id, 1);
    const first = (await lease(app.baseUrl)).body!;
    const timing = { browserMs: 2_100, prepareMs: 40, loadMs: 900, settleMs: 5_500, shotsMs: 6_300 };
    assert.deepEqual((await result(app.baseUrl, timed.check.id, okReport(first, { timing }), { desktop: PNG("desktop") })).body, { status: "done" });
    const [said] = spansOf(sink, "server.artifacts.check.result");
    assert.deepEqual(stages.map((key) => said!.attrs?.[key]), [2_100, 40, 900, 5_500, 6_300]);
    assert.ok((said!.attrs?.run_ms as number) >= 0, "beside the run's own time, as before");

    // Not times (a fraction, a negative, one past the contract's most, a stage missing): the report stands, the span says no stage.
    let version = 1;
    for (const bad of [
      { ...timing, loadMs: 1.5 },
      { ...timing, settleMs: -1 },
      { ...timing, shotsMs: ARTIFACT_CHECK_TIMING_MAX_MS + 1 },
      { browserMs: 1, prepareMs: 1, loadMs: 1, settleMs: 1 },
      "fast",
    ]) {
      version += 1;
      const next = await world.push(item.id, version);
      const leased = (await lease(app.baseUrl)).body!;
      assert.deepEqual((await result(app.baseUrl, next.check.id, okReport(leased, { timing: bad as never }), { desktop: PNG("desktop") })).body, { status: "done" }, JSON.stringify(bad));
      const span = spansOf(sink, "server.artifacts.check.result").at(-1)!;
      for (const key of stages) assert.equal(key in span.attrs!, false, `no ${key} from ${JSON.stringify(bad)}`);
      assert.equal(span.attrs?.outcome, "done");
    }
  } finally {
    info.mockRestore();
  }
});

test("result: only the newest three versions keep their screenshots once a check finishes", async ({ app, seed }) => {
  configure();
  const world = await seedWorld(seed);
  const item = await world.makeItem();
  const versions: ArtifactVersionRow[] = [];
  for (let number = 1; number <= 4; number += 1) {
    const { version, check } = await world.push(item.id, number);
    const leased = (await lease(app.baseUrl)).body!;
    assert.equal(leased.checkId, check.id);
    assert.equal((await result(app.baseUrl, check.id, okReport(leased), { desktop: PNG(`d${number}`), phone: PNG(`p${number}`) })).status, 200);
    versions.push(version);
  }
  assert.equal(await checkShotFileOf(versions[0]!.id, "desktop"), null, "the oldest let go");
  for (const version of versions.slice(1)) assert.ok(await checkShotFileOf(version.id, "desktop"));
});
