// The per-server move from the standalone app (legacyBulkImport.ts), against
// a fake of the standalone app's import API (an injected fetch, as
// import.api.test.ts): plan counts and writes nothing; run freezes first,
// then imports in the standalone app's id order as the ops actor (audited
// with the operator) into the whole server; public, versionless and
// already-imported Artifacts are skipped with their reasons; one that fails is
// reported and the rest go on; a run stopped (max, stop-at, a failed list)
// resumes from its state file; a rerun skips what it imported; and the
// imported bytes don't count against the monthly file upload quota
// (storeBlob's `quota: "exempt"`), while a normal store still does. The
// author is the old creator when Raft confirms it (a live agent of the
// server, or a member of any role, of exactly the type the standalone app
// gave), else the ops actor; the plan counts those fallbacks. Old comments
// (legacyComments.ts): a run copies each imported page's right after it, no
// one woken, a failure counted and the page standing; `comments plan` /
// `comments run` copy those of pages imported before, under an approval
// bound to the plan's digest, idempotently by the copies' ids.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { AGENT_API_ARTIFACT_MAX_COMMENT_CHARS, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, artifactLinkId, asArtifactId, asServerId, type ServerId } from "@botiverse/raft-shared";
import { getAppUrl } from "../../config/appUrl";
import { getDb } from "../../db/index";
import { agents, objectEventRecipients, objectEvents, serverFileUploadUsageMonths, serverMembers, servers, users } from "../../db/schema";
import { PLATFORM_SERVER_ID } from "../../platform/actors";
import { canManageObject } from "../../platform/visibility";
import { createAgent } from "../../services/agentService";
import { createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { billingUsageMonth } from "../../services/fileUploadQuotaService";
import { seedBoundGuest } from "../../test/guestFixture";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { storeBlob } from "./blobs";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { ARTIFACT_OPS_IMPORT_ACTOR, importLegacyArtifactAsOps } from "./import";
import { __settlePublicTextFillsForTests } from "./publicText";
import { canViewArtifactsAnonymously } from "./visibility";
import {
  fileLegacyMoveStateStore,
  formatLegacyCommentsPlan,
  formatLegacyCommentsReport,
  formatLegacyMovePlan,
  formatLegacyMovePublicSet,
  formatLegacyMoveReport,
  legacyMovePublicSet,
  legacyMoveSetDigest,
  planLegacyComments,
  planLegacyMove,
  runLegacyComments,
  runLegacyMove,
  runLegacyMoves,
  type LegacyMoveServer,
  type LegacyMoveState,
  type LegacyMoveStateStore,
} from "./legacyBulkImport";
import { __setLegacyWorkerFetchForTests } from "./legacyWorker";
import { artifactAudit, artifactBlobs, artifactComments, artifactItems, artifactPendingNotices, artifactReadPositions, artifactSubscriptions, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const linkOf = (id: string) => `${getAppUrl()}/artifacts/${artifactLinkId(asArtifactId(id))}`;

const LEGACY_BASE = "https://legacy-import.example.test";
const LEGACY_TOKEN = "legacy-import-token-0123456789-abcdefghij";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const page = (text: string) => Buffer.from(`<html><title>${text}</title><body>${text}</body></html>`);

beforeEach(() => {
  vi.stubEnv("ARTIFACTS_LEGACY_IMPORT_URL", LEGACY_BASE);
  vi.stubEnv("ARTIFACTS_LEGACY_IMPORT_TOKEN", LEGACY_TOKEN);
});
afterEach(async () => {
  // A public import fills its signed-out text in the background (publicText.ts): settled before the next test.
  await __settlePublicTextFillsForTests();
  vi.unstubAllEnvs();
  __setLegacyWorkerFetchForTests(undefined);
  __setArtifactR2StoreForTests(undefined);
});

function memoryR2(objects: Map<string, Buffer>): ArtifactR2Store {
  return {
    async read() {
      return null;
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

// ---- the standalone app, faked ---------------------------------------------------

type LegacyFile = { path: string; bytes: Buffer; sha256?: string };
type LegacyCreator = { type: "agent" | "user"; raftId: string; name: string };
type LegacyOldComment = { id: string; author: { type: "agent" | "user"; raftId: string | null; name: string }; body: string; path: string | null; replyTo: string | null; createdAt: number };
interface LegacyArtifact {
  artifactId: string;
  name: string;
  title: string;
  creator: LegacyCreator | null;
  visibility: "private" | "public";
  importedTo: string | null;
  /** null: no published version. */
  version: number | null;
  files: LegacyFile[];
  /** Its comments there, oldest first (`comments`). */
  comments?: LegacyOldComment[];
}
type Request = { method: string; path: string; query: Record<string, string>; body: unknown };

/**
 * The standalone app's import API for one Raft server (keyed by its id, as the
 * real one): list (stable id order, cursor = the last id), freeze, manifest,
 * blob, imported. Every request is recorded. `failList`: the list request
 * with that cursor answers 500 (once).
 */
function fakeLegacyApp(serverId: string) {
  const artifacts: LegacyArtifact[] = [];
  const requests: Request[] = [];
  const state = {
    frozenAt: null as string | null, failFreeze: false, failListAt: undefined as string | undefined, onBlob: undefined as (() => Promise<void>) | undefined,
    /** A manifest that answers another artifactId for that name. */
    manifestIdFor: {} as Record<string, string>,
    /** `comments` of that name answers this status instead (409 SERVER_NOT_FROZEN, 413 TOO_MANY_COMMENTS, else INTERNAL_ERROR). */
    commentsStatusFor: {} as Record<string, number>,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const notFound = () => json({ error: { code: "NOT_FOUND" } }, 404);
  const fileSha = (file: LegacyFile) => file.sha256 ?? sha(file.bytes);
  const fetcher = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, LEGACY_BASE, "only ever the configured address");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${LEGACY_TOKEN}`);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request: Request = { method: init?.method ?? "GET", path: url.pathname.replace("/internal/raft-import/", ""), query: Object.fromEntries(url.searchParams), body };
    requests.push(request);
    const sorted = [...artifacts].sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1));
    const found = (name: string | undefined) => (request.query.server === serverId || (body as { server?: string })?.server === serverId) ? sorted.find((a) => a.name === name) : undefined;
    switch (request.path) {
      case "freeze": {
        if (state.failFreeze) return json({ error: { code: "INTERNAL_ERROR" } }, 500);
        state.frozenAt ??= new Date("2026-10-26T10:00:00Z").toISOString();
        return json({ server: (body as { server: string }).server, frozen: true, frozenAt: state.frozenAt });
      }
      case "list": {
        const cursor = request.query.cursor ?? "";
        if (state.failListAt !== undefined && state.failListAt === cursor) {
          state.failListAt = undefined;
          return json({ error: { code: "INTERNAL_ERROR" } }, 500);
        }
        const limit = Number(request.query.limit ?? 50);
        const rows = request.query.server === serverId ? sorted.filter((a) => !cursor || a.artifactId > cursor) : [];
        const items = rows.slice(0, limit);
        return json({
          items: items.map((a) => ({
            artifactId: a.artifactId, name: a.name, title: a.title, visibility: a.visibility, importedTo: a.importedTo,
            currentVersion: a.version, sizeBytes: a.files.reduce((sum, f) => sum + f.bytes.length, 0), creator: a.creator,
          })),
          nextCursor: rows.length > limit ? items[items.length - 1]!.artifactId : null,
        });
      }
      case "manifest": {
        const a = found(request.query.name);
        if (!a || a.version === null) return notFound();
        return json({
          artifactId: state.manifestIdFor[a.name] ?? a.artifactId, name: a.name, title: a.title, description: null, entry: a.files[0]!.path, importedTo: a.importedTo, creator: a.creator,
          version: { number: a.version, files: a.files.map((f) => ({ path: f.path, sha256: fileSha(f), size: f.bytes.length, type: "text/html" })) },
        });
      }
      case "blob": {
        await state.onBlob?.();
        const file = found(request.query.name)?.files.find((f) => fileSha(f) === request.query.sha256);
        if (!file) return notFound();
        return new Response(new Uint8Array(file.bytes), { status: 200 });
      }
      case "comments": {
        // 404 before 409, as the real one.
        const a = found(request.query.name);
        if (!a) return notFound();
        const status = state.commentsStatusFor[a.name] ?? (state.frozenAt ? 200 : 409);
        if (status === 409) return json({ error: { code: "SERVER_NOT_FROZEN" } }, 409);
        if (status === 413) return json({ error: { code: "TOO_MANY_COMMENTS" } }, 413);
        if (status !== 200) return json({ error: { code: "INTERNAL_ERROR" } }, status);
        return json({ comments: a.comments ?? [] });
      }
      case "imported": {
        const a = found((body as { name: string }).name);
        if (!a) return notFound();
        a.importedTo = (body as { newUrl: string }).newUrl;
        return new Response(null, { status: 204 });
      }
    }
    return notFound();
  }) as typeof fetch;
  __setLegacyWorkerFetchForTests(fetcher);
  let next = 0;
  return {
    fetcher,
    artifacts,
    requests,
    state,
    /** Ids sort in the order they are put. */
    put(artifact: Partial<LegacyArtifact> & Pick<LegacyArtifact, "name">): LegacyArtifact {
      const full: LegacyArtifact = {
        artifactId: `pt_${String(next++).padStart(4, "0")}`, title: artifact.name, visibility: "private", importedTo: null, version: 1, creator: null,
        files: [{ path: "index.html", bytes: page(artifact.name) }], ...artifact,
      };
      artifacts.push(full);
      return full;
    },
    paths: () => requests.map((r) => r.path),
  };
}

/** Several servers' fakes of the standalone app at once: each request goes to the one of the server it names. */
function routeLegacyApps(apps: Record<string, ReturnType<typeof fakeLegacyApp>>) {
  __setLegacyWorkerFetchForTests((async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { server?: string } : undefined;
    const app = apps[url.searchParams.get("server") ?? body?.server ?? ""];
    assert.ok(app, "a request names one of the servers");
    return app.fetcher(input, init);
  }) as typeof fetch);
}

// ---- the world -------------------------------------------------------------------

/**
 * A Raft platform owner or admin (the approver of a move): a person with this
 * role in Botiverse, the platform's own Server (PLATFORM_SERVER_ID, made
 * here when the database doesn't have it yet).
 */
async function platformPerson(seed: ReturnType<typeof createSeed>, role: "owner" | "admin" | "member" | "guest" = "admin") {
  const [existing] = await getDb().select({ id: servers.id }).from(servers).where(eq(servers.id, PLATFORM_SERVER_ID));
  if (!existing) {
    const founder = await seed.human();
    await getDb().insert(servers).values({ id: PLATFORM_SERVER_ID, name: "Botiverse", slug: `botiverse-${randomUUID().slice(0, 8)}`, ownerId: founder.id });
  }
  const person = await seed.human();
  if (role === "guest") await seedBoundGuest({ serverId: PLATFORM_SERVER_ID, userId: person.id });
  else await getDb().insert(serverMembers).values({ serverId: PLATFORM_SERVER_ID, userId: person.id, role });
  return person;
}

async function seedServer(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const row = await seed.server({ owner });
  const server: LegacyMoveServer = { id: asServerId(row.id), slug: row.slug };
  const r2 = new Map<string, Buffer>();
  __setArtifactR2StoreForTests(memoryR2(r2));
  return { owner, server, row, r2 };
}

const itemsOf = (serverId: ServerId) => getDb().select().from(artifactItems).where(eq(artifactItems.serverId, serverId)).orderBy(artifactItems.createdAt);
const auditOf = (serverId: ServerId) => getDb().select({ audit: artifactAudit }).from(artifactAudit)
  .innerJoin(artifactItems, eq(artifactItems.id, artifactAudit.itemId)).where(eq(artifactItems.serverId, serverId)).orderBy(artifactAudit.id).then((rows) => rows.map((r) => r.audit));

async function setUploadUsage(serverId: ServerId, usedBytes: number) {
  await getDb().insert(serverFileUploadUsageMonths)
    .values({ serverId, month: billingUsageMonth(), usedBytes, reservedBytes: 0 })
    .onConflictDoUpdate({ target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month], set: { usedBytes, reservedBytes: 0 } });
}
async function uploadUsage(serverId: ServerId): Promise<{ usedBytes: number; reservedBytes: number }> {
  const [row] = await getDb().select().from(serverFileUploadUsageMonths)
    .where(and(eq(serverFileUploadUsageMonths.serverId, serverId), eq(serverFileUploadUsageMonths.month, billingUsageMonth())));
  return { usedBytes: row?.usedBytes ?? 0, reservedBytes: row?.reservedBytes ?? 0 };
}

/** An Artifact of the server, as an earlier on-demand import would have left it (with its audit row unless `audit: false`). */
async function earlierImport(serverId: ServerId, owner: { id: string }, legacy: { artifactId: string; name: string }, opts: { audit?: boolean; deleted?: boolean } = {}) {
  const id = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({
    id, serverId, urlKey: id, name: legacy.name, title: legacy.name, homeKind: "server", createdByType: "user", createdById: owner.id,
    ...(opts.deleted ? { deletedAt: new Date() } : {}),
  });
  if (opts.audit !== false) {
    await getDb().insert(artifactAudit).values({ itemId: id, actorType: "user", actorId: owner.id, action: "import", before: null, after: { legacyArtifactId: legacy.artifactId } });
  }
  return { id, url: linkOf(id) };
}

function memoryState(): LegacyMoveStateStore & { current: LegacyMoveState | null } {
  const store = {
    current: null as LegacyMoveState | null,
    async load() {
      return store.current ? structuredClone(store.current) : null;
    },
    async save(state: LegacyMoveState) {
      store.current = structuredClone(state);
    },
  };
  return store;
}

// ---- plan ------------------------------------------------------------------------

test("plan: per server the count, total size, already imported, public and versionless (skipped), to import; it asks only `list` and writes nothing", async ({ seed }) => {
  const { owner, server } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  legacy.put({ name: "alpha", files: [{ path: "index.html", bytes: Buffer.alloc(1000, 1) }] });
  const imported = legacy.put({ name: "beta", files: [{ path: "index.html", bytes: Buffer.alloc(200, 2) }] });
  legacy.put({ name: "gamma", visibility: "public", files: [{ path: "index.html", bytes: Buffer.alloc(30, 3) }] });
  legacy.put({ name: "delta", version: null, files: [{ path: "index.html", bytes: Buffer.alloc(4, 4) }] });
  // importedTo names an Artifact deleted since: imported again.
  const gone = legacy.put({ name: "epsilon", files: [{ path: "index.html", bytes: Buffer.alloc(500, 5) }] });
  const standing = await earlierImport(server.id, owner, imported, { audit: false });
  imported.importedTo = standing.url;
  gone.importedTo = (await earlierImport(server.id, owner, gone, { audit: false, deleted: true })).url;
  // The audit alone (the standalone app was never told) counts too.
  const audited = legacy.put({ name: "zeta", files: [{ path: "index.html", bytes: Buffer.alloc(7, 6) }] });
  await earlierImport(server.id, owner, audited);
  const before = { items: (await itemsOf(server.id)).length, audit: (await auditOf(server.id)).length };

  const plan = await planLegacyMove(server, { pageSize: 2 });
  assert.deepEqual(plan, {
    server,
    artifactsEnabled: false,
    total: 6,
    totalBytes: 1000 + 200 + 30 + 4 + 500 + 7,
    toImport: { count: 2, bytes: 1500 },
    systemAuthor: { count: 2, noCreator: 2, notInServer: 0 },
    skipped: { already_imported: 2, public: 1, public_refused: 0, no_version: 1, no_name: 0 },
    public: null,
  });
  assert.deepEqual(legacy.paths(), ["list", "list", "list"], "three pages of two; no freeze, no manifest, no blob");
  assert.deepEqual(legacy.requests.map((r) => r.query.cursor ?? null), [null, "pt_0001", "pt_0003"]);
  assert.equal(legacy.state.frozenAt, null, "not frozen");
  assert.deepEqual({ items: (await itemsOf(server.id)).length, audit: (await auditOf(server.id)).length }, before, "nothing written");
  assert.match(formatLegacyMovePlan(plan), /to import: +2 /);
  assert.match(formatLegacyMovePlan(plan), /author falls back to the system identity: 2 \(no creator 2, creator deleted or not in the server 0\)/);
});

// ---- run -------------------------------------------------------------------------

test("run: freezes first, then imports each private versioned Artifact in id order as the ops actor into the whole server, audited with the operator; skips public, versionless and imported ones with reasons", async ({ seed }) => {
  const { owner, server, r2 } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  const a = legacy.put({ name: "alpha", files: [{ path: "index.html", bytes: page("alpha") }, { path: "app.js", bytes: Buffer.from("console.log(1)") }] });
  const pub = legacy.put({ name: "public-one", visibility: "public" });
  const versionless = legacy.put({ name: "draft", version: null });
  const b = legacy.put({ name: "beta", version: 4 });
  const done = legacy.put({ name: "done-before" });
  const earlier = await earlierImport(server.id, owner, done);
  done.importedTo = earlier.url;

  const state = memoryState();
  const report = await runLegacyMove(server, { operator: "alice", state, pageSize: 2 });

  assert.equal(legacy.requests[0]!.path, "freeze", "the freeze is the first request");
  assert.deepEqual(legacy.requests[0]!.body, { server: server.id });
  assert.deepEqual(legacy.paths(), [
    "freeze",
    "list", "manifest", "blob", "blob", "imported", "comments",
    "list", "manifest", "blob", "imported", "comments",
    "list",
  ]);
  assert.equal(report.done, true);
  assert.equal(report.stopped, null);
  assert.equal(report.frozenAt, "2026-10-26T10:00:00.000Z");
  assert.deepEqual(report.imported.map((i) => [i.artifactId, i.name, i.author]), [[a.artifactId, "alpha", "ops"], [b.artifactId, "beta", "ops"]]);
  assert.deepEqual(report.skipped, [
    { artifactId: pub.artifactId, name: "public-one", reason: "public" },
    { artifactId: versionless.artifactId, name: "draft", reason: "no_version" },
    { artifactId: done.artifactId, name: "done-before", reason: "already_imported", importedAs: earlier },
  ]);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.counts, { imported: 2, systemAuthor: 2, public: 0, skipped: { already_imported: 1, public: 1, public_refused: 0, no_version: 1, no_name: 0 }, failed: 0 });

  const created = (await itemsOf(server.id)).filter((item) => item.id !== earlier.id);
  assert.deepEqual(created.map((item) => item.name), ["alpha", "beta"]);
  for (const item of created) {
    assert.equal(item.homeKind, "server");
    assert.equal(item.homeChannelId, null);
    assert.deepEqual({ type: item.createdByType, id: item.createdById }, ARTIFACT_OPS_IMPORT_ACTOR);
    const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, item.id));
    assert.deepEqual({ type: version!.publisherType, id: version!.publisherId }, ARTIFACT_OPS_IMPORT_ACTOR);
    assert.equal(version!.note, `Imported from https://raft-artifacts.com/p/${server.slug}/${item.name}`);
  }
  const audit = (await auditOf(server.id)).filter((row) => row.itemId !== earlier.id);
  assert.deepEqual(audit.map((row) => ({ actor: { type: row.actorType, id: row.actorId }, action: row.action, after: row.after })), [
    { actor: ARTIFACT_OPS_IMPORT_ACTOR, action: "import", after: { legacyArtifactId: a.artifactId, from: `https://raft-artifacts.com/p/${server.slug}/alpha`, server: server.slug, name: "alpha", version: 1, ops: { operator: "alice" }, legacyCreator: null } },
    { actor: ARTIFACT_OPS_IMPORT_ACTOR, action: "import", after: { legacyArtifactId: b.artifactId, from: `https://raft-artifacts.com/p/${server.slug}/beta`, server: server.slug, name: "beta", version: 4, ops: { operator: "alice" }, legacyCreator: null } },
  ]);
  // The ops actor is no one: it reads and follows nothing.
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.actorId, ARTIFACT_OPS_IMPORT_ACTOR.id))).length, 0);
  assert.equal((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.actorId, ARTIFACT_OPS_IMPORT_ACTOR.id))).length, 0);
  // The standalone app is told, by "Raft migration".
  const told = legacy.requests.filter((r) => r.path === "imported").map((r) => r.body as { name: string; importedBy: string; newUrl: string; public: boolean });
  assert.deepEqual(told.map((t) => [t.name, t.importedBy, t.public]), [["alpha", "Raft migration", false], ["beta", "Raft migration", false]]);
  assert.equal(a.importedTo, report.imported[0]!.url);
  assert.equal(r2.size, 3, "alpha's two files and beta's one");
  assert.deepEqual(state.current?.cursor, done.artifactId);
  assert.equal(state.current?.done, true);
  assert.match(formatLegacyMoveReport(report), /imported: 2/);
});

test("run: a failed freeze imports nothing and asks nothing else", async ({ seed }) => {
  const { server } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  legacy.put({ name: "alpha" });
  legacy.state.failFreeze = true;
  const state = memoryState();
  await assert.rejects(runLegacyMove(server, { operator: "alice", state }), /did not freeze the server \(bad_answer\); nothing imported/);
  assert.deepEqual(legacy.paths(), ["freeze"]);
  assert.equal((await itemsOf(server.id)).length, 0);
  assert.equal(state.current, null, "no state saved");
});

test("run: one Artifact failing (a file not what its manifest says, a name taken) is reported with its reason; the rest are imported", async ({ seed }) => {
  const { owner, server } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  legacy.put({ name: "first" });
  const listed = page("what the manifest promised");
  const tampered = legacy.put({ name: "tampered", files: [{ path: "index.html", bytes: Buffer.from(listed.toString().replace("promised", "tampered")), sha256: sha(listed) }] });
  const taken = legacy.put({ name: "taken" });
  legacy.put({ name: "last" });
  const holder = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({ id: holder, serverId: server.id, urlKey: holder, name: "taken", title: "Other", homeKind: "server", createdByType: "user", createdById: owner.id });

  const report = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.equal(report.done, true);
  assert.deepEqual(report.imported.map((i) => i.name), ["first", "last"]);
  assert.deepEqual(report.failed.map((f) => [f.artifactId, f.name, f.code]), [[tampered.artifactId, "tampered", "IMPORT_MISMATCH"], [taken.artifactId, "taken", "NAME_TAKEN"]]);
  assert.deepEqual(report.failed[0]!.details, { path: "index.html", reason: "sha256" });
  assert.deepEqual(report.failed[1]!.details, { name: "taken", existing: { id: holder, url: linkOf(holder) } });
  assert.equal(report.counts.failed, 2);
  // The failed import's bytes are gone at once.
  const blobs = await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, server.id));
  assert.equal(blobs.length, 2, "first's and last's only");
  assert.match(formatLegacyMoveReport(report), /tampered \(pt_0001\): IMPORT_MISMATCH/);

  // An unexpected error (a store that fails) is reported too, and the run goes on.
  const legacy2 = fakeLegacyApp(server.id);
  legacy2.put({ name: "broken-store", artifactId: "pt_broken" });
  __setArtifactR2StoreForTests({ ...memoryR2(new Map()), async put() { throw new Error("r2 put failed"); } });
  const again = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(again.failed.map((f) => [f.name, f.code, f.message]), [["broken-store", "ERROR", "r2 put failed"]]);
  assert.equal(again.done, true);
});

test("resume: stopped by --max and by --stop-at, and by a failed list, a run resumes from its state file after the last Artifact done; nothing twice", async ({ seed }) => {
  const { server } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  for (const name of ["a1", "a2", "a3", "a4", "a5"]) legacy.put({ name });
  const dir = await mkdtemp(path.join(tmpdir(), "artifacts-legacy-move-"));
  try {
    const file = path.join(dir, "state.json");
    const state = fileLegacyMoveStateStore(file);

    const first = await runLegacyMove(server, { operator: "alice", state, max: 2, pageSize: 2 });
    assert.equal(first.done, false);
    assert.equal(first.stopped, "max");
    assert.deepEqual(first.imported.map((i) => i.name), ["a1", "a2"]);
    const saved = JSON.parse(await readFile(file, "utf8")) as LegacyMoveState;
    assert.equal(saved.cursor, "pt_0001");
    assert.equal(saved.done, false);

    // Past --stop-at: nothing new is started (the freeze is asked again, idempotent).
    legacy.requests.length = 0;
    const stopAt = new Date("2026-10-26T12:00:00Z");
    const late = await runLegacyMove(server, { operator: "alice", state, stopAt, now: () => new Date("2026-10-26T12:00:01Z") });
    assert.equal(late.stopped, "stop_at");
    assert.equal(late.resumed, true);
    assert.deepEqual(legacy.paths(), ["freeze", "list"]);
    assert.equal(late.imported.length, 2);

    // The list fails on the next page: the run throws, its state kept.
    legacy.state.failListAt = "pt_0002";
    await assert.rejects(runLegacyMove(server, { operator: "alice", state, pageSize: 1 }), /list failed/);
    assert.equal((JSON.parse(await readFile(file, "utf8")) as LegacyMoveState).cursor, "pt_0002");

    legacy.requests.length = 0;
    const rest = await runLegacyMove(server, { operator: "alice", state });
    assert.equal(rest.done, true);
    assert.equal(rest.resumed, true);
    assert.deepEqual(legacy.requests.find((r) => r.path === "list")?.query.cursor, "pt_0002", "resumed after the last Artifact done");
    assert.deepEqual(rest.imported.map((i) => i.name), ["a1", "a2", "a3", "a4", "a5"], "the report covers the whole pass");
    assert.deepEqual((await itemsOf(server.id)).map((item) => item.name).sort(), ["a1", "a2", "a3", "a4", "a5"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rerun: a finished run starts a new pass that skips everything imported (no file fetched) and imports what is new; a state of another server is refused", async ({ seed }) => {
  const { server, owner } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  legacy.put({ name: "a1" });
  legacy.put({ name: "a2" });
  const state = memoryState();
  assert.equal((await runLegacyMove(server, { operator: "alice", state })).imported.length, 2);

  legacy.put({ name: "a3" });
  legacy.requests.length = 0;
  const again = await runLegacyMove(server, { operator: "bob", state });
  assert.equal(again.resumed, false, "a new pass");
  assert.deepEqual(again.skipped.map((s) => [s.name, s.reason]), [["a1", "already_imported"], ["a2", "already_imported"]]);
  assert.deepEqual(again.imported.map((i) => i.name), ["a3"]);
  assert.deepEqual(legacy.paths(), ["freeze", "list", "manifest", "blob", "imported", "comments"], "only a3 is asked for");
  assert.equal((await itemsOf(server.id)).length, 3);

  // Imported before but the standalone app was never told (and the state lost): the audit row finds it.
  legacy.artifacts.find((a) => a.name === "a3")!.importedTo = null;
  const lost = await runLegacyMove(server, { operator: "bob", state: memoryState() });
  assert.deepEqual(lost.skipped.map((s) => s.reason), ["already_imported", "already_imported", "already_imported"]);
  assert.equal((await itemsOf(server.id)).length, 3);

  const other = await seed.server({ owner });
  await assert.rejects(runLegacyMove({ id: asServerId(other.id), slug: other.slug }, { operator: "bob", state }), /the state is of another server/);
});

test("quota: the move's bytes don't count against a Free server's monthly file upload quota, even when it is full; a normal store still counts and is refused", async ({ seed }) => {
  const { server, r2 } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  const big = Buffer.alloc(64 * 1024, 7);
  legacy.put({ name: "big", files: [{ path: "index.html", bytes: big }] });
  await setUploadUsage(server.id, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);

  const report = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.imported.map((i) => i.name), ["big"]);
  assert.deepEqual(await uploadUsage(server.id), { usedBytes: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reservedBytes: 0 }, "nothing counted, nothing held");
  const [blob] = await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, server.id));
  assert.equal(blob!.state, "ready");
  assert.equal(blob!.quotaMonth, null);

  // storeBlob directly: exempt stores, the default is refused, with the month full.
  const store = memoryR2(r2);
  const one = Buffer.from("exempt bytes");
  assert.equal((await storeBlob(store, server.id, sha(one), one, { quota: "exempt" })).kind, "stored");
  const two = Buffer.from("counted bytes");
  assert.equal((await storeBlob(store, server.id, sha(two), two)).kind, "file_upload_quota_exceeded");
  // With room, the default counts and exempt doesn't.
  await setUploadUsage(server.id, 0);
  assert.equal((await storeBlob(store, server.id, sha(two), two)).kind, "stored");
  const three = Buffer.from("more exempt bytes");
  assert.equal((await storeBlob(store, server.id, sha(three), three, { quota: "exempt" })).kind, "stored");
  assert.deepEqual(await uploadUsage(server.id), { usedBytes: two.length, reservedBytes: 0 });
});

test("system author: an Artifact the ops actor is the author of (no creator Raft confirms) is followed by the server's live human owners, every one of them, in the whole server and the public home alike (a followed row, read up to version 1); not by a retired owner, an admin, a member or an agent; a server with no live owner: by no one", async ({ seed }) => {
  const { owner, server, member, agent, legacy, as } = await publicWorld(seed);
  const coOwner = await seed.human();
  const retiredOwner = await seed.human();
  const admin = await seed.human();
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: coOwner.id, role: "owner" }, { serverId: server.id, userId: retiredOwner.id, role: "owner" }, { serverId: server.id, userId: admin.id, role: "admin" },
  ]);
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, retiredOwner.id));
  const approver = await platformPerson(seed);
  legacy.put({ name: "private-by-nobody", creator: null });
  legacy.put({ name: "private-by-leaver", creator: as("user", randomUUID()) });
  legacy.put({ name: "public-by-nobody", visibility: "public", creator: null });
  legacy.put({ name: "by-agent", creator: as("agent", agent.id) });
  legacy.put({ name: "by-member", creator: as("user", member.id) });
  const digest = (await planLegacyMove(server, { public: true })).public!.digest;
  const report = await runLegacyMove(server, { operator: "alice", state: memoryState(), public: true, approval: { approvedBy: approver.id, planDigest: digest, approvalRef: "msg-1" } });
  assert.deepEqual(report.imported.map((i) => [i.name, i.author, i.home]), [
    ["private-by-nobody", "ops", "server"], ["private-by-leaver", "ops", "server"], ["public-by-nobody", "ops", "public"], ["by-agent", "creator", "server"], ["by-member", "creator", "server"],
  ]);
  const byName = new Map((await itemsOf(server.id)).map((item) => [item.name, item]));
  const followers = async (name: string) => (await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, byName.get(name)!.id)))
    .map((r) => [r.actorType, r.actorId, r.reason]).sort();
  const readers = async (name: string) => (await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, byName.get(name)!.id)))
    .map((r) => [r.actorId, r.position]).sort();
  const owners = [owner.id, coOwner.id].sort();
  for (const name of ["private-by-nobody", "private-by-leaver", "public-by-nobody"]) {
    assert.deepEqual(await followers(name), owners.map((id) => ["user", id, "followed"]), name);
    assert.deepEqual(await readers(name), owners.map((id) => [id, byName.get(name)!.lastPosition]), name);
  }
  assert.deepEqual(await followers("by-agent"), [["agent", agent.id, "published"]], "a confirmed creator's: the creator alone");
  assert.deepEqual(await followers("by-member"), [["user", member.id, "published"]]);

  // No live owner: no one follows it.
  await getDb().update(users).set({ retiredAt: new Date() }).where(inArray(users.id, [owner.id, coOwner.id]));
  legacy.put({ name: "late-by-nobody", creator: null });
  const late = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(late.imported.map((i) => [i.name, i.author]), [["late-by-nobody", "ops"]]);
  const lateItem = (await itemsOf(server.id)).find((item) => item.name === "late-by-nobody")!;
  assert.equal((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, lateItem.id))).length, 0);
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, lateItem.id))).length, 0);
});

test("importLegacyArtifactAsOps: an earlier import in a conversation the ops actor isn't in is that one (already_imported), not ALREADY_IMPORTED; no flag needed; a name no link can carry is INVALID_NAME", async ({ seed }) => {
  const { owner, server, row } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  const old = legacy.put({ name: "private-plan" });
  const channel = await seed.channel({ server: row, members: [owner], visibility: "private" });
  const id = `pt_${randomUUID()}`;
  await getDb().insert(artifactItems).values({ id, serverId: server.id, urlKey: id, name: "private-plan", title: "Plan", homeKind: "conversation", homeChannelId: channel.id, createdByType: "user", createdById: owner.id });
  await getDb().insert(artifactAudit).values({ itemId: id, actorType: "user", actorId: owner.id, action: "import", before: null, after: { legacyArtifactId: old.artifactId } });

  const outcome = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name: "private-plan", operator: "alice" });
  assert.deepEqual(outcome, { kind: "already_imported", item: { id, url: linkOf(id) } });
  assert.equal((await itemsOf(server.id)).length, 1);

  const invalid = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name: "a/b", operator: "alice" });
  assert.equal(invalid.kind, "failed");
  assert.equal(invalid.kind === "failed" && invalid.code, "INVALID_NAME");
});

// ---- the author ------------------------------------------------------------------

test("author: the old creator Raft confirms (a live agent of the server, a member of any role, of the type given) is the author, may manage it (D13) and, when it sees it, follows it and has read it; a deleted agent, another server's, someone who left, a type that doesn't match the id, an id that isn't one, or none: the ops actor; the plan counts those first", async ({ seed }) => {
  const { owner, server } = await seedServer(seed);
  const member = await seed.human();
  const guest = await seed.human();
  const left = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  const agent = await createAgent(server.id, `writer-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const gone = await createAgent(server.id, `gone-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));
  const other = await seed.server({ owner });
  const foreign = await createAgent(other.id, `foreign-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const legacy = fakeLegacyApp(server.id);
  const as = (type: "agent" | "user", raftId: string, name = "Old name") => ({ type, raftId, name });
  legacy.put({ name: "by-agent", creator: as("agent", agent.id, "Writer") });
  legacy.put({ name: "by-member", creator: as("user", member.id) });
  legacy.put({ name: "by-deleted-agent", creator: as("agent", gone.id) });
  legacy.put({ name: "by-foreign-agent", creator: as("agent", foreign.id) });
  legacy.put({ name: "by-guest", creator: as("user", guest.id) });
  legacy.put({ name: "by-leaver", creator: as("user", left.id) });
  legacy.put({ name: "by-agent-as-user", creator: as("user", agent.id) });
  legacy.put({ name: "by-member-as-agent", creator: as("agent", member.id) });
  legacy.put({ name: "by-not-an-id", creator: as("agent", "not-a-uuid") });
  legacy.put({ name: "by-nobody", creator: null });
  // Skipped ones are not counted.
  legacy.put({ name: "public-by-nobody", visibility: "public" });

  const plan = await planLegacyMove(server);
  assert.deepEqual(plan.toImport.count, 10);
  assert.deepEqual(plan.systemAuthor, { count: 7, noCreator: 1, notInServer: 6 });

  const report = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(report.imported.map((i) => [i.name, i.author]), [
    ["by-agent", "creator"], ["by-member", "creator"], ["by-deleted-agent", "ops"], ["by-foreign-agent", "ops"], ["by-guest", "creator"],
    ["by-leaver", "ops"], ["by-agent-as-user", "ops"], ["by-member-as-agent", "ops"], ["by-not-an-id", "ops"], ["by-nobody", "ops"],
  ]);
  assert.equal(report.counts.systemAuthor, 7);
  assert.match(formatLegacyMoveReport(report), /imported: 10 \(author the system identity: 7\)/);
  const byName = new Map((await itemsOf(server.id)).map((item) => [item.name, item]));
  const authorOf = (name: string) => ({ type: byName.get(name)!.createdByType, id: byName.get(name)!.createdById });
  assert.deepEqual(authorOf("by-agent"), { type: "agent", id: agent.id });
  assert.deepEqual(authorOf("by-member"), { type: "user", id: member.id });
  assert.deepEqual(authorOf("by-guest"), { type: "user", id: guest.id });
  for (const name of ["by-deleted-agent", "by-foreign-agent", "by-leaver", "by-agent-as-user", "by-member-as-agent", "by-not-an-id", "by-nobody"]) {
    assert.deepEqual(authorOf(name), ARTIFACT_OPS_IMPORT_ACTOR, name);
  }

  const mine = byName.get("by-agent")!;
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, mine.id));
  assert.deepEqual({ type: version!.publisherType, id: version!.publisherId }, { type: "agent", id: agent.id }, "version 1 is the creator's");
  // It follows its Artifact (notices reach it) and has read it: nothing unread.
  assert.deepEqual((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, mine.id))).map((r) => [r.actorType, r.actorId, r.reason, r.unsubscribedAt]), [["agent", agent.id, "published", null]]);
  assert.deepEqual((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, mine.id))).map((r) => [r.actorType, r.actorId, r.position]), [["agent", agent.id, mine.lastPosition]]);
  // The author's rights (D13): it may delete and widen it; the ops actor's Artifacts are the owners' and admins'.
  const agentActor = { type: "agent" as const, id: agent.id, serverId: server.id };
  assert.equal(await canManageObject(agentActor, { serverId: server.id, author: authorOf("by-agent") }, "delete"), true);
  assert.equal(await canManageObject(agentActor, { serverId: server.id, author: authorOf("by-agent") }, "widen"), true);
  assert.equal(await canManageObject(agentActor, { serverId: server.id, author: authorOf("by-nobody") }, "delete"), false);
  assert.equal(await canManageObject({ type: "user", id: owner.id, serverId: server.id }, { serverId: server.id, author: authorOf("by-nobody") }, "delete"), true);
  // A fallback is followed by the server's owner (the ops actor follows nothing), read up to version 1.
  const nobody = byName.get("by-nobody")!;
  assert.deepEqual((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, nobody.id))).map((r) => [r.actorType, r.actorId, r.reason, r.unsubscribedAt]), [["user", owner.id, "followed", null]]);
  assert.deepEqual((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, nobody.id))).map((r) => [r.actorType, r.actorId, r.position]), [["user", owner.id, nobody.lastPosition]]);
  // A confirmed creator's is followed by the creator alone.
  assert.ok(!(await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, mine.id))).some((r) => r.actorId === owner.id));
  // A guest author doesn't see the whole server's Artifacts: it may delete its own (D13), never widen, and follows and reads nothing.
  const guestActor = { type: "user" as const, id: guest.id, serverId: server.id };
  assert.equal(await canManageObject(guestActor, { serverId: server.id, author: authorOf("by-guest") }, "delete"), true);
  assert.equal(await canManageObject(guestActor, { serverId: server.id, author: authorOf("by-guest") }, "widen"), false);
  assert.equal((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, byName.get("by-guest")!.id))).length, 0);
  assert.equal((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, byName.get("by-guest")!.id))).length, 0);
  // A member author follows its Artifact too.
  assert.deepEqual((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, byName.get("by-member")!.id))).map((r) => [r.actorType, r.actorId]), [["user", member.id]]);

  // The audit row is still the ops actor's, with the operator and the old creator.
  const audit = new Map((await auditOf(server.id)).map((r) => [r.itemId, r]));
  const rowOf = (name: string) => audit.get(byName.get(name)!.id)!;
  assert.deepEqual({ type: rowOf("by-agent").actorType, id: rowOf("by-agent").actorId }, ARTIFACT_OPS_IMPORT_ACTOR);
  assert.deepEqual((rowOf("by-agent").after as { ops: unknown }).ops, { operator: "alice" });
  assert.deepEqual((rowOf("by-agent").after as { legacyCreator: unknown }).legacyCreator, { type: "agent", raftId: agent.id, name: "Writer", author: true });
  assert.deepEqual((rowOf("by-guest").after as { legacyCreator: unknown }).legacyCreator, { type: "user", raftId: guest.id, name: "Old name", author: true });
  assert.deepEqual((rowOf("by-member-as-agent").after as { legacyCreator: unknown }).legacyCreator, { type: "agent", raftId: member.id, name: "Old name", author: false });
  assert.equal((rowOf("by-nobody").after as { legacyCreator: unknown }).legacyCreator, null);
});

test("author: a standalone app that sends no creator field at all reads as none (the ops actor)", async ({ seed }) => {
  const { server } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  legacy.put({ name: "old-shape", creator: undefined as never });
  const plan = await planLegacyMove(server);
  assert.deepEqual(plan.systemAuthor, { count: 1, noCreator: 1, notInServer: 0 });
  const report = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(report.imported.map((i) => i.author), ["ops"]);
});

// ---- public Artifacts (--public) ------------------------------------------------

/** Artifacts on (the deployment's answer for workspace_artifacts_v0). */
function artifactsOn() {
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
}

/** A server (Artifacts on unless `flag: false`) with a member, a guest, an agent and someone who isn't in it, and the standalone app's public Artifacts by each. */
async function publicWorld(seed: ReturnType<typeof createSeed>, opts: { flag?: boolean } = {}) {
  const world = await seedServer(seed);
  if (opts.flag !== false) artifactsOn();
  const member = await seed.human();
  const guest = await seed.human();
  const outsider = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: world.server.id, userId: member.id, role: "member" });
  await seedBoundGuest({ serverId: world.server.id, userId: guest.id });
  const agent = await createAgent(world.server.id, `writer-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const legacy = fakeLegacyApp(world.server.id);
  const as = (type: "agent" | "user", raftId: string, name = "Old name") => ({ type, raftId, name });
  return { ...world, member, guest, outsider, agent, legacy, as };
}

test("plan --public: each Artifact public on raft-artifacts.com listed apart (old link, name and title, size, author, new home and visibility, or why Raft's rule refuses it); without --public they stay skipped as public; read only", async ({ seed }) => {
  const { owner, server, member, guest, outsider, agent, legacy, as } = await publicWorld(seed, { flag: false });
  legacy.put({ name: "private-one", creator: as("user", member.id), files: [{ path: "index.html", bytes: Buffer.alloc(100, 1) }] });
  const byMember = legacy.put({ name: "by-member", title: "Launch notes", visibility: "public", creator: as("user", member.id), files: [{ path: "index.html", bytes: Buffer.alloc(1000, 2) }] });
  legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id), files: [{ path: "index.html", bytes: Buffer.alloc(10, 3) }] });
  legacy.put({ name: "by-guest", visibility: "public", creator: as("user", guest.id), files: [{ path: "index.html", bytes: Buffer.alloc(10, 4) }] });
  legacy.put({ name: "by-nobody", visibility: "public", creator: null, files: [{ path: "index.html", bytes: Buffer.alloc(10, 5) }] });
  legacy.put({ name: "by-outsider", visibility: "public", creator: as("user", outsider.id), files: [{ path: "index.html", bytes: Buffer.alloc(10, 6) }] });
  legacy.put({ name: "public-draft", visibility: "public", version: null, creator: as("user", member.id) });
  const done = legacy.put({ name: "public-done", visibility: "public", creator: as("user", member.id) });
  const earlier = await earlierImport(server.id, owner, done);
  const before = { items: (await itemsOf(server.id)).length, audit: (await auditOf(server.id)).length };

  const without = await planLegacyMove(server);
  assert.equal(without.public, null);
  assert.deepEqual(without.skipped, { already_imported: 1, public: 6, public_refused: 0, no_version: 0, no_name: 0 });
  assert.deepEqual(without.toImport, { count: 1, bytes: 100 });
  assert.match(formatLegacyMovePlan(without), /public \(skipped; plan --public lists them\): 6/);

  legacy.requests.length = 0;
  const plan = await planLegacyMove(server, { public: true });
  assert.deepEqual(plan.toImport, { count: 1, bytes: 100 }, "the private ones only");
  assert.deepEqual(plan.systemAuthor, { count: 0, noCreator: 0, notInServer: 0 });
  assert.deepEqual(plan.skipped, { already_imported: 1, public: 0, public_refused: 4, no_version: 1, no_name: 0 });
  assert.deepEqual(plan.public!.toImport, { count: 1, bytes: 1000 });
  assert.deepEqual(plan.public!.refused, { count: 4, system_author: 2, agent_author: 1, may_not_make_public: 1 });
  assert.deepEqual(plan.public!.artifacts[0], {
    artifactId: byMember.artifactId,
    link: `https://raft-artifacts.com/p/${server.slug}/by-member`,
    name: "by-member",
    title: "Launch notes",
    sizeBytes: 1000,
    version: 1,
    author: { kind: "creator", type: "user", id: member.id },
    decision: "import",
    to: { home: "public", visibility: "anyone_with_the_link" },
  });
  assert.deepEqual(plan.public!.artifacts.map((entry) => [entry.name, entry.decision, entry.refusal ?? null, entry.author.kind === "system" ? entry.author.reason : entry.author.type, entry.to?.home ?? null]), [
    ["by-member", "import", null, "user", "public"],
    ["by-agent", "public_refused", "agent_author", "agent", null],
    ["by-guest", "public_refused", "may_not_make_public", "user", null],
    ["by-nobody", "public_refused", "system_author", "noCreator", null],
    ["by-outsider", "public_refused", "system_author", "notInServer", null],
    ["public-draft", "no_version", null, "user", null],
    ["public-done", "already_imported", null, "user", null],
  ]);
  assert.deepEqual(plan.public!.artifacts[6]!.importedAs, earlier);
  assert.deepEqual(legacy.paths(), ["list"], "no freeze, no manifest, no blob");
  assert.deepEqual({ items: (await itemsOf(server.id)).length, audit: (await auditOf(server.id)).length }, before, "nothing written");
  const text = formatLegacyMovePlan(plan);
  assert.match(text, /to import, kept public \(anyone with the link\): 1 /);
  assert.match(text, /refused by Raft's rule for making an Artifact public \(skipped\): 4 \(no author Raft confirms 2, agent author 1, author may not make it public 1\)/);
  assert.ok(text.includes(`https://raft-artifacts.com/p/${server.slug}/by-member  "Launch notes" (by-member, 0.0 MiB); author person ${member.id}; → public home, anyone with the link`), text);
  assert.match(text, /by-agent .*skipped: its author is an agent \(only a person turns on link sharing\)/);
  assert.match(text, /the Artifacts flag is off: run --public refuses to import them until it is on/);
});

test("run --public: the public one a person of the server may make public goes to the public home and stays public (signed out too), audited import + made_public by the ops actor; the refused ones are skipped with the reason and nothing fetched for them; the standalone app is told the short link; a rerun is already_imported", async ({ seed }) => {
  const { server, member, agent, legacy, as } = await publicWorld(seed);
  const priv = legacy.put({ name: "private-one", creator: as("user", member.id) });
  const pub = legacy.put({ name: "by-member", title: "Launch notes", visibility: "public", creator: as("user", member.id, "Mia") });
  const byAgent = legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id) });
  const byNobody = legacy.put({ name: "by-nobody", visibility: "public", creator: null });

  const state = memoryState();
  const report = await runLegacyMove(server, { operator: "alice", state, public: true });
  await __settlePublicTextFillsForTests();
  assert.deepEqual(legacy.paths(), ["freeze", "list", "manifest", "blob", "imported", "comments", "manifest", "blob", "imported", "comments"], "nothing asked for the refused ones");
  assert.deepEqual(legacy.requests.filter((r) => r.path === "manifest").map((r) => r.query.name), ["private-one", "by-member"]);
  assert.equal(report.public, true);
  assert.deepEqual(report.imported.map((i) => [i.artifactId, i.name, i.author, i.home]), [[priv.artifactId, "private-one", "creator", "server"], [pub.artifactId, "by-member", "creator", "public"]]);
  assert.deepEqual(report.skipped, [
    { artifactId: byAgent.artifactId, name: "by-agent", reason: "public_refused", refusal: "agent_author" },
    { artifactId: byNobody.artifactId, name: "by-nobody", reason: "public_refused", refusal: "system_author" },
  ]);
  assert.deepEqual(report.counts, { imported: 2, systemAuthor: 0, public: 1, skipped: { already_imported: 0, public: 0, public_refused: 2, no_version: 0, no_name: 0 }, failed: 0 });
  assert.match(formatLegacyMoveReport(report), /public, anyone with the link: 1/);

  const byName = new Map((await itemsOf(server.id)).map((item) => [item.name, item]));
  assert.deepEqual([...byName.keys()].sort(), ["by-member", "private-one"]);
  assert.equal(byName.get("private-one")!.homeKind, "server");
  const item = byName.get("by-member")!;
  assert.deepEqual([item.homeKind, item.homeChannelId, item.originalHomeChannelId, item.title], ["public", null, null, "Launch notes"]);
  assert.deepEqual({ type: item.createdByType, id: item.createdById }, { type: "user", id: member.id });
  assert.deepEqual(canViewArtifactsAnonymously([item]), [true], "anyone with the link, signed out too");
  const [version] = await getDb().select().from(artifactVersions).where(eq(artifactVersions.itemId, item.id));
  assert.equal(version!.note, `Imported from https://raft-artifacts.com/p/${server.slug}/by-member`);
  assert.deepEqual(version!.provenance, { importedFrom: { link: `https://raft-artifacts.com/p/${server.slug}/by-member`, legacyArtifactId: pub.artifactId, version: 1 } });
  const audit = (await auditOf(server.id)).filter((row) => row.itemId === item.id);
  assert.deepEqual(audit.map((row) => ({ actor: { type: row.actorType, id: row.actorId }, action: row.action, before: row.before, after: row.after })), [
    {
      actor: ARTIFACT_OPS_IMPORT_ACTOR, action: "import", before: null,
      after: { legacyArtifactId: pub.artifactId, from: `https://raft-artifacts.com/p/${server.slug}/by-member`, server: server.slug, name: "by-member", version: 1, ops: { operator: "alice" }, legacyCreator: { type: "user", raftId: member.id, name: "Mia", author: true }, home: "public" },
    },
    {
      actor: ARTIFACT_OPS_IMPORT_ACTOR, action: "made_public", before: null,
      after: { home_kind: "public", home_channel_id: null, via: "import", author: { type: "user", id: member.id }, ops: { operator: "alice" } },
    },
  ]);
  // The private one's audit is as before: no home, no made_public.
  assert.deepEqual((await auditOf(server.id)).filter((row) => row.itemId === byName.get("private-one")!.id).map((row) => [row.action, "home" in (row.after ?? {})]), [["import", false]]);
  // The standalone app is told the new address in its short form (what its 301 sends the old link to).
  const told = legacy.requests.filter((r) => r.path === "imported").map((r) => (r.body as { name: string; newUrl: string; public: boolean }));
  // And whether its home here is public: only then may the old link answer 301.
  assert.deepEqual(told.map((t) => [t.name, t.public]), [["private-one", false], ["by-member", true]]);
  assert.equal(told[1]!.name, "by-member");
  assert.equal(told[1]!.newUrl, linkOf(item.id));
  assert.match(told[1]!.newUrl, /\/artifacts\/[1-9A-HJ-NP-Za-km-z]{22}$/);
  assert.ok(!told[1]!.newUrl.includes("pt_"));
  assert.equal(pub.importedTo, linkOf(item.id));

  // A rerun (a new pass): already imported, nothing fetched; the refused ones are refused again.
  legacy.requests.length = 0;
  const again = await runLegacyMove(server, { operator: "bob", state, public: true });
  assert.deepEqual(again.skipped.map((entry) => [entry.name, entry.reason, entry.refusal ?? null]), [
    ["private-one", "already_imported", null], ["by-member", "already_imported", null], ["by-agent", "public_refused", "agent_author"], ["by-nobody", "public_refused", "system_author"],
  ]);
  assert.deepEqual(again.skipped[1]!.importedAs, { id: item.id, url: linkOf(item.id) });
  assert.deepEqual(again.imported, []);
  assert.deepEqual(legacy.paths(), ["freeze", "list"]);
  assert.equal((await itemsOf(server.id)).length, 2);
});

test("run --public: a pass keeps the choice it started with (resuming with the other one is refused; --restart starts a new pass)", async ({ seed }) => {
  const { server, member, legacy, as } = await publicWorld(seed);
  legacy.put({ name: "a1", creator: as("user", member.id) });
  legacy.put({ name: "a2", creator: as("user", member.id) });
  legacy.put({ name: "pub", visibility: "public", creator: as("user", member.id) });
  const state = memoryState();
  assert.equal((await runLegacyMove(server, { operator: "alice", state, max: 1 })).stopped, "max");
  await assert.rejects(runLegacyMove(server, { operator: "alice", state, public: true }), /started without --public: resume it the same way, or start a new pass \(--restart\)/);
  const restarted = await runLegacyMove(server, { operator: "alice", state, public: true, restart: true });
  assert.deepEqual(restarted.imported.map((i) => [i.name, i.home]), [["a2", "server"], ["pub", "public"]]);
  assert.deepEqual(restarted.skipped.map((s) => [s.name, s.reason]), [["a1", "already_imported"]]);
  await __settlePublicTextFillsForTests();
});

test("importLegacyArtifactAsOps home public: the import itself applies Raft's rule (not only the plan), before any byte and again in its transaction; refused, nothing is made and its bytes are gone", async ({ seed }) => {
  const { server, member, guest, legacy, as } = await publicWorld(seed);
  legacy.put({ name: "by-guest", visibility: "public", creator: as("user", guest.id) });
  const outcome = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name: "by-guest", operator: "alice", home: "public" });
  assert.deepEqual(outcome, { kind: "refused_public", reason: "may_not_make_public" });
  assert.deepEqual(legacy.paths(), ["manifest"], "refused before any byte is fetched");

  // The author is a member at the first check and a guest by the commit: the transaction's check refuses it.
  legacy.put({ name: "demoted", visibility: "public", creator: as("user", member.id) });
  // Its channel made beforehand: the demotion in the middle of the import is the one write.
  const demotedHome = await createChannel(server.id, `demoted-home-${randomUUID().slice(0, 8)}`, undefined, "private");
  legacy.state.onBlob = async () => {
    await seedBoundGuest({ serverId: server.id, userId: member.id, channelId: demotedHome.id, member: false });
  };
  const late = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name: "demoted", operator: "alice", home: "public" });
  assert.deepEqual(late, { kind: "refused_public", reason: "may_not_make_public" });
  assert.ok(legacy.paths().includes("blob"), "it got as far as the bytes");
  assert.ok(!legacy.paths().includes("imported"), "the standalone app is told nothing");
  assert.equal((await itemsOf(server.id)).length, 0);
  assert.equal((await getDb().select().from(artifactBlobs).where(eq(artifactBlobs.serverId, server.id))).length, 0, "the bytes it stored are gone");
  // Into the whole server (no --public) the same Artifact imports as before: the rule is the public home's.
  legacy.state.onBlob = undefined;
  const privately = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name: "demoted", operator: "alice" });
  assert.equal(privately.kind, "imported");
  assert.equal((await itemsOf(server.id))[0]!.homeKind, "server");
});

test("run --public with the server's Artifacts flag off: refused before the freeze when a public one would be imported (nothing asked but the list, nothing saved); none to import, or without --public, it runs", async ({ seed }) => {
  const { server, member, agent, legacy, as } = await publicWorld(seed, { flag: false });
  legacy.put({ name: "private-one", creator: as("user", member.id) });
  legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id) });
  const pub = legacy.put({ name: "by-member", visibility: "public", creator: as("user", member.id) });
  const state = memoryState();
  await assert.rejects(runLegacyMove(server, { operator: "alice", state, public: true }), /the Artifacts flag \(workspace_artifacts_v0\) is off on .*: --public would import 1 public Artifact\(s\).*nothing frozen or imported/);
  assert.deepEqual(legacy.paths(), ["list"], "no freeze, no manifest");
  assert.equal(legacy.state.frozenAt, null);
  assert.equal(state.current, null, "no state saved");
  assert.equal((await itemsOf(server.id)).length, 0);

  // Only refused public ones: nothing public would be imported, so it runs (private ones as before).
  legacy.artifacts.splice(legacy.artifacts.indexOf(pub), 1);
  const report = await runLegacyMove(server, { operator: "alice", state, public: true });
  assert.deepEqual(report.imported.map((i) => [i.name, i.home]), [["private-one", "server"]]);
  assert.deepEqual(report.skipped.map((i) => [i.name, i.reason]), [["by-agent", "public_refused"]]);

  // Without --public the flag doesn't matter (the move runs before it is on).
  legacy.put({ name: "later", creator: as("user", member.id) });
  legacy.put({ name: "later-public", visibility: "public", creator: as("user", member.id) });
  const plain = await runLegacyMove(server, { operator: "alice", state });
  assert.deepEqual(plain.imported.map((i) => i.name), ["later"]);
  // And once Artifacts are on, --public imports it.
  artifactsOn();
  const on = await runLegacyMove(server, { operator: "alice", state: memoryState(), public: true });
  assert.deepEqual(on.imported.map((i) => [i.name, i.home]), [["later-public", "public"]]);
});

// ---- an approval (--approved-by) ---------------------------------------------------

test("approval: plan --public counts both ways (with approval: N more) and prints a digest; run --approved-by a Raft platform owner or admin with the plan's digest and the approval's message keeps the agent's and the system identity's public pages public, the approver's made_public row naming the operator and the message; a guest author's stays refused", async ({ seed }) => {
  const { server, member, guest, agent, legacy, as } = await publicWorld(seed);
  const approver = await platformPerson(seed, "owner");
  const byMember = legacy.put({ name: "by-member", visibility: "public", creator: as("user", member.id) });
  const byAgent = legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id), files: [{ path: "index.html", bytes: Buffer.alloc(300, 1) }] });
  const byNobody = legacy.put({ name: "by-nobody", visibility: "public", creator: null, files: [{ path: "index.html", bytes: Buffer.alloc(200, 2) }] });
  const byGuest = legacy.put({ name: "by-guest", visibility: "public", creator: as("user", guest.id) });
  legacy.put({ name: "private-one", creator: as("agent", agent.id) });

  const plan = await planLegacyMove(server, { public: true });
  assert.deepEqual(plan.public!.toImport.count, 1, "on their author's right: by-member");
  assert.deepEqual(plan.public!.withApproval, { count: 2, bytes: 500 }, "by-agent and by-nobody");
  assert.deepEqual(plan.public!.artifacts.map((e) => [e.name, e.decision, e.withApproval ?? false]), [
    ["by-member", "import", false], ["by-agent", "public_refused", true], ["by-nobody", "public_refused", true], ["by-guest", "public_refused", false],
  ]);
  assert.match(plan.public!.digest, /^[0-9a-f]{64}$/);
  assert.equal((await planLegacyMove(server, { public: true })).public!.digest, plan.public!.digest, "the same plan, the same digest");
  const text = formatLegacyMovePlan(plan);
  assert.match(text, /with approval \(run --approved-by, a Raft platform owner or admin\): 2 more \(0\.0 MiB\), kept public/);
  assert.ok(text.includes(`plan digest (run --plan-digest): ${plan.public!.digest}`));
  assert.match(text, /by-agent .*; with approval → public home, anyone with the link/);

  legacy.requests.length = 0;
  const approval = { approvedBy: approver.name, planDigest: plan.public!.digest, approvalRef: "#proj-move:msg-42" };
  const report = await runLegacyMove(server, { operator: "alice", state: memoryState(), public: true, approval });
  assert.equal(legacy.requests[0]!.path, "list", "the plan checked first");
  assert.ok(legacy.paths().includes("freeze"));
  assert.deepEqual(report.imported.map((i) => [i.name, i.home, i.publicBasis ?? null, i.author]), [
    ["by-member", "public", "author", "creator"], ["by-agent", "public", "approval", "creator"], ["by-nobody", "public", "approval", "ops"], ["private-one", "server", null, "creator"],
  ]);
  assert.deepEqual(report.skipped.map((e) => [e.name, e.reason, e.refusal]), [["by-guest", "public_refused", "may_not_make_public"]]);
  assert.deepEqual(report.approval, { approver: { id: approver.id, name: approver.name }, planDigest: plan.public!.digest, approvalRef: "#proj-move:msg-42", imported: 2 });
  assert.match(formatLegacyMoveReport(report), /on the approval of .* \(#proj-move:msg-42\): 2/);

  const byName = new Map((await itemsOf(server.id)).map((item) => [item.name, item]));
  for (const name of ["by-member", "by-agent", "by-nobody"]) assert.equal(byName.get(name)!.homeKind, "public", name);
  const madePublic = async (name: string) => (await auditOf(server.id)).filter((row) => row.itemId === byName.get(name)!.id && row.action === "made_public")
    .map((row) => ({ actor: { type: row.actorType, id: row.actorId }, after: row.after }));
  assert.deepEqual(await madePublic("by-agent"), [{
    actor: { type: "user", id: approver.id },
    after: {
      home_kind: "public", home_channel_id: null, via: "import", author: { type: "agent", id: agent.id }, ops: { operator: "alice" },
      approvedBy: { type: "user", id: approver.id, name: approver.name }, approvalRef: "#proj-move:msg-42",
    },
  }]);
  assert.deepEqual((await madePublic("by-nobody"))[0]!.after?.author, ARTIFACT_OPS_IMPORT_ACTOR);
  // On its author's right: the ops actor's row, as without an approval.
  assert.deepEqual(await madePublic("by-member"), [{ actor: ARTIFACT_OPS_IMPORT_ACTOR, after: { home_kind: "public", home_channel_id: null, via: "import", author: { type: "user", id: member.id }, ops: { operator: "alice" } } }]);
  assert.ok(byMember && byAgent && byNobody && byGuest);
});

test("approval: refused, before anything is frozen, unless the approver is a Raft platform owner or admin (a human owner or admin of Botiverse, by handle, email or id; the moved server's own owner or admin is not one) and all three of --approved-by, --plan-digest and --approval-ref are given", async ({ seed }) => {
  const { owner, server, member, guest, agent, legacy, as } = await publicWorld(seed);
  legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id) });
  const admin = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  const platformAdmin = await platformPerson(seed, "admin");
  const platformOwner = await platformPerson(seed, "owner");
  const platformMember = await platformPerson(seed, "member");
  const platformGuest = await platformPerson(seed, "guest");
  const elsewhere = await seed.human();
  const other = await seed.server({ owner: elsewhere });
  assert.ok(other);
  const digest = (await planLegacyMove(server, { public: true })).public!.digest;
  const run = (approval: { approvedBy: string; planDigest?: string; approvalRef?: string }, extra: { public?: boolean } = { public: true }) =>
    runLegacyMove(server, { operator: "alice", state: memoryState(), ...extra, approval: { planDigest: digest, approvalRef: "msg-1", ...approval } });

  // The moved server's own owner and admin (by handle, email and id) are no approvers now: the approval is the platform's.
  for (const who of [owner.name, owner.email, owner.id, admin.name, admin.id, member.name, guest.name, elsewhere.name, platformMember.name, platformGuest.id, agent.name, agent.id, "no-such-person", ""]) {
    legacy.requests.length = 0;
    await assert.rejects(run({ approvedBy: who }), who ? /is not a Raft platform owner or admin \(a human owner or admin of Botiverse, .*\) now: the approval is refused; nothing frozen or imported/ : /all three/, who);
    assert.deepEqual(legacy.paths(), [], `${who}: nothing asked, nothing frozen`);
  }
  await assert.rejects(run({ approvedBy: platformAdmin.name, approvalRef: "" }), /--approved-by needs --plan-digest and --approval-ref \(all three\)/);
  await assert.rejects(run({ approvedBy: platformAdmin.name, planDigest: " " }), /all three/);
  await assert.rejects(run({ approvedBy: platformAdmin.name }, {}), /--approved-by is for --public only/);
  assert.equal(legacy.state.frozenAt, null);
  assert.equal((await itemsOf(server.id)).length, 0);

  // A platform owner by id resolves (and is no member of the moved server); a platform admin by email runs it.
  await assert.rejects(run({ approvedBy: platformOwner.id, planDigest: "0".repeat(64) }), /the plan changed since it was approved/);
  const byAdmin = await run({ approvedBy: platformAdmin.email });
  assert.deepEqual(byAdmin.approval?.approver, { id: platformAdmin.id, name: platformAdmin.name });
  assert.deepEqual(byAdmin.imported.map((i) => [i.name, i.publicBasis]), [["by-agent", "approval"]]);
});

test("approval: bound to the exact plan: the plan's digest runs; any changed entry (a new public page, a new version, another author, a page no longer public) refuses it before the freeze, nothing imported", async ({ seed }) => {
  const { server, member, agent, legacy, as } = await publicWorld(seed);
  const approver = await platformPerson(seed);
  const a = legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id) });
  legacy.put({ name: "by-member", visibility: "public", creator: as("user", member.id) });
  const approved = (await planLegacyMove(server, { public: true })).public!.digest;
  const run = () => runLegacyMove(server, { operator: "alice", state: memoryState(), public: true, approval: { approvedBy: approver.id, planDigest: approved, approvalRef: "msg-7" } });

  const changes: Array<[string, () => void, () => void]> = [
    ["a new version", () => { a.version = 2; }, () => { a.version = 1; }],
    ["another author", () => { a.creator = null; }, () => { a.creator = as("agent", agent.id); }],
    ["no longer public", () => { a.visibility = "private"; }, () => { a.visibility = "public"; }],
    ["another name", () => { a.name = "by-agent-renamed"; }, () => { a.name = "by-agent"; }],
  ];
  let extra: ReturnType<typeof legacy.put> | null = null;
  changes.push(["a new public page", () => { extra = legacy.put({ name: "late", visibility: "public", creator: as("agent", agent.id) }); }, () => { legacy.artifacts.splice(legacy.artifacts.indexOf(extra!), 1); }]);
  for (const [label, change, undo] of changes) {
    change();
    legacy.requests.length = 0;
    await assert.rejects(run(), /the plan changed since it was approved .*: plan --public again and have it approved again; nothing frozen or imported/, label);
    assert.ok(!legacy.paths().includes("freeze"), `${label}: not frozen`);
    undo();
  }
  assert.equal((await itemsOf(server.id)).length, 0);
  assert.equal(legacy.state.frozenAt, null);
  await assert.rejects(runLegacyMove(server, { operator: "alice", state: memoryState(), public: true, approval: { approvedBy: approver.id, planDigest: "0".repeat(64), approvalRef: "msg-7" } }), /the plan changed/);

  // Unchanged: it runs.
  const report = await run();
  assert.deepEqual(report.imported.map((i) => [i.name, i.publicBasis]), [["by-agent", "approval"], ["by-member", "author"]]);
});

test("approval: the import keeps a page public on it only while the standalone app answers it public (not public or not known: the rule alone), for an author's refusal only, and only while the approver is a Raft platform owner or admin", async ({ seed }) => {
  const { owner, server, member, guest, agent, legacy, as } = await publicWorld(seed);
  const approver = await platformPerson(seed);
  legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id) });
  legacy.put({ name: "by-guest", visibility: "public", creator: as("user", guest.id) });
  const approval = (legacyVisibility: "public" | "private" | null, approverId = approver.id) => ({ approver: { id: approverId, name: "approver" }, ref: "msg-9", legacyVisibility });
  const importAs = (name: string, approvalValue: ReturnType<typeof approval>) =>
    importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name, operator: "alice", home: "public", approval: approvalValue });

  assert.deepEqual(await importAs("by-agent", approval("private")), { kind: "refused_public", reason: "agent_author" }, "not public there: never widened");
  assert.deepEqual(await importAs("by-agent", approval(null)), { kind: "refused_public", reason: "agent_author" }, "not known: the rule alone");
  assert.deepEqual(await importAs("by-agent", approval("public", member.id)), { kind: "refused_public", reason: "agent_author" }, "a member is no approver");
  assert.deepEqual(await importAs("by-agent", approval("public", owner.id)), { kind: "refused_public", reason: "agent_author" }, "the server's owner is no platform approver");
  assert.deepEqual(await importAs("by-guest", approval("public")), { kind: "refused_public", reason: "may_not_make_public" }, "a guest author's isn't lifted");
  assert.equal((await itemsOf(server.id)).length, 0);
  const ok = await importAs("by-agent", approval("public"));
  assert.equal(ok.kind, "imported");
  assert.equal(ok.kind === "imported" && ok.publicBasis, "approval");
});

test("approval: a pass keeps it (resuming under another approval, or none, is refused); the saved approved ids are what it covers", async ({ seed }) => {
  const { server, agent, legacy, as } = await publicWorld(seed);
  const approver = await platformPerson(seed);
  legacy.put({ name: "a1", visibility: "public", creator: as("agent", agent.id) });
  legacy.put({ name: "a2", visibility: "public", creator: as("agent", agent.id) });
  const digest = (await planLegacyMove(server, { public: true })).public!.digest;
  const approval = { approvedBy: approver.name, planDigest: digest, approvalRef: "msg-1" };
  const state = memoryState();
  const first = await runLegacyMove(server, { operator: "alice", state, public: true, approval, max: 1 });
  assert.equal(first.stopped, "max");
  assert.deepEqual(state.current?.approval?.artifactIds.length, 2);
  await assert.rejects(runLegacyMove(server, { operator: "alice", state, public: true }), /started with --approved-by/);
  await assert.rejects(runLegacyMove(server, { operator: "alice", state, public: true, approval: { ...approval, approvalRef: "msg-2" } }), /under another approval/);
  // Resumed the same way: the fresh plan has changed (a1 is imported now), the saved approval still covers a2.
  const rest = await runLegacyMove(server, { operator: "alice", state, public: true, approval });
  assert.deepEqual(rest.imported.map((i) => [i.name, i.publicBasis]), [["a1", "approval"], ["a2", "approval"]]);
  // Finished under it: not run again under it (a fresh plan has changed); its report is the saved one.
  legacy.requests.length = 0;
  const again = await runLegacyMove(server, { operator: "alice", state, public: true, approval });
  assert.deepEqual(again.imported.map((i) => i.name), ["a1", "a2"]);
  assert.ok(!legacy.paths().includes("freeze"), "not frozen again, nothing imported");
});

test("approval: system_author is lifted only with truly no creator or a creator id confirmed an agent of the server; a guest (whatever type it was given), a former member, a member typed as an agent, another server's agent: never", async ({ seed }) => {
  const { server, member, guest, outsider, agent, legacy, as } = await publicWorld(seed);
  const approver = await platformPerson(seed);
  const gone = await createAgent(server.id, `gone-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));
  const other = await seed.server({ owner: outsider });
  const foreign = await createAgent(other.id, `foreign-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const cases: Array<[string, ReturnType<typeof as> | null, boolean]> = [
    ["no-creator", null, true],
    ["deleted-agent", as("agent", gone.id), true],
    ["agent-typed-user", as("user", agent.id), true],
    ["guest-typed-agent", as("agent", guest.id), false],
    ["guest-as-user", as("user", guest.id), false],
    ["former-member", as("user", outsider.id), false],
    ["member-typed-agent", as("agent", member.id), false],
    ["foreign-agent", as("agent", foreign.id), false],
    ["not-an-id", as("agent", "not-a-uuid"), false],
  ];
  for (const [name, creator] of cases) legacy.put({ name, visibility: "public", creator });

  const plan = await planLegacyMove(server, { public: true });
  assert.deepEqual(plan.public!.artifacts.map((e) => [e.name, e.withApproval === true]), cases.map(([name, , ok]) => [name, ok]));
  const report = await runLegacyMove(server, { operator: "alice", state: memoryState(), public: true, approval: { approvedBy: approver.name, planDigest: plan.public!.digest, approvalRef: "msg-3" } });
  assert.deepEqual(report.imported.map((i) => i.name), cases.filter(([, , ok]) => ok).map(([name]) => name));
  assert.deepEqual(report.skipped.map((e) => e.name), cases.filter(([, , ok]) => !ok).map(([name]) => name));

  // The import's own check, called directly with an approval: a guest typed as an agent is refused.
  legacy.put({ name: "guest-again", visibility: "public", creator: as("agent", guest.id) });
  const direct = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name: "guest-again", operator: "alice", home: "public", approval: { approver: { id: approver.id, name: approver.name }, ref: "msg-3", legacyVisibility: "public" } });
  assert.deepEqual(direct, { kind: "refused_public", reason: "system_author" });
});

test("approval: a retired platform owner is no approver: the whole run is refused before anything is frozen, and the import refuses it too", async ({ seed }) => {
  const { server, agent, legacy, as } = await publicWorld(seed);
  const approver = await platformPerson(seed, "owner");
  legacy.put({ name: "by-agent", visibility: "public", creator: as("agent", agent.id) });
  const digest = (await planLegacyMove(server, { public: true })).public!.digest;
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, approver.id));
  for (const who of [approver.name, approver.email, approver.id]) {
    legacy.requests.length = 0;
    await assert.rejects(runLegacyMove(server, { operator: "alice", state: memoryState(), public: true, approval: { approvedBy: who, planDigest: digest, approvalRef: "msg-4" } }), /is not a Raft platform owner or admin/, who);
    assert.deepEqual(legacy.paths(), [], `${who}: nothing asked, nothing frozen`);
  }
  const direct = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name: "by-agent", operator: "alice", home: "public", approval: { approver: { id: approver.id, name: approver.name }, ref: "msg-4", legacyVisibility: "public" } });
  assert.deepEqual(direct, { kind: "refused_public", reason: "agent_author" });
  assert.equal((await itemsOf(server.id)).length, 0);
});

/** Two servers, each with its standalone app's fake (one fetch routes to both), an agent of each, and a Raft platform admin to approve. */
async function twoServerWorld(seed: ReturnType<typeof createSeed>) {
  const a = await publicWorld(seed);
  const ownerB = await seed.human();
  const rowB = await seed.server({ owner: ownerB });
  const b = { owner: ownerB, server: { id: asServerId(rowB.id), slug: rowB.slug } as LegacyMoveServer };
  const agentB = await createAgent(b.server.id, `writer-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const legacyB = fakeLegacyApp(b.server.id);
  routeLegacyApps({ [a.server.id]: a.legacy, [b.server.id]: legacyB });
  const approver = await platformPerson(seed);
  const states = { [a.server.id]: memoryState(), [b.server.id]: memoryState() };
  return { a, b: { ...b, agent: agentB, legacy: legacyB }, approver, states, stateOf: (server: LegacyMoveServer) => states[server.id]! };
}

test("approval of several servers: plan --public over two prints one digest of both (in any order; one server's is its own) and the counts; run --servers verifies a fresh plan of both before freezing either and moves both, each with its own state; one entry changed in either server, a digest of one of them, or no approval: refused, nothing frozen anywhere", async ({ seed }) => {
  const { a, b, approver, states, stateOf } = await twoServerWorld(seed);
  const pageA = a.legacy.put({ name: "by-agent-a", visibility: "public", creator: a.as("agent", a.agent.id) });
  a.legacy.put({ name: "by-member-a", visibility: "public", creator: a.as("user", a.member.id) });
  a.legacy.put({ name: "by-guest-a", visibility: "public", creator: a.as("user", a.guest.id) });
  const pageB = b.legacy.put({ name: "by-agent-b", visibility: "public", creator: a.as("agent", b.agent.id) });
  b.legacy.put({ name: "private-b", creator: null });

  const [planA, planB] = [await planLegacyMove(a.server, { public: true }), await planLegacyMove(b.server, { public: true })];
  const set = legacyMovePublicSet([planA, planB]);
  assert.match(set.digest, /^[0-9a-f]{64}$/);
  assert.equal(legacyMovePublicSet([planB, planA]).digest, set.digest, "the order they are named in doesn't matter");
  assert.notEqual(set.digest, planA.public!.digest);
  assert.equal(legacyMoveSetDigest([{ serverId: a.server.id, digest: planA.public!.digest }]), planA.public!.digest, "one server's is its own");
  assert.deepEqual(set.public, { listed: 4, toImport: 1, withApproval: 2, stillRefused: 1 });
  assert.equal(set.toImport, 1);
  const text = formatLegacyMovePublicSet(set);
  assert.ok(text.includes(`plan digest of these 2 servers (run --servers ${a.server.slug},${b.server.slug} --plan-digest): ${set.digest}`));
  assert.match(text, /4 listed; kept public on their author's right: 1; with approval: 2 more, kept public; still refused with it .*: 1/);

  const approval = { approvedBy: approver.name, planDigest: set.digest, approvalRef: "#proj-workspace:e7b3e687" };
  const both = [a.server, b.server];
  const run = (over: Partial<typeof approval> = {}, servers: LegacyMoveServer[] = both) =>
    runLegacyMoves(servers, { operator: "alice", stateOf, public: true, approval: { ...approval, ...over } });
  const nothingFrozen = (label: string) => {
    assert.ok(!a.legacy.paths().includes("freeze") && !b.legacy.paths().includes("freeze"), `${label}: nothing frozen`);
    a.legacy.requests.length = 0;
    b.legacy.requests.length = 0;
  };

  const changes: Array<[string, () => void, () => void]> = [
    ["a new version in the first", () => { pageA.version = 2; }, () => { pageA.version = 1; }],
    ["another author in the second", () => { pageB.creator = null; }, () => { pageB.creator = a.as("agent", b.agent.id); }],
    ["no longer public in the second", () => { pageB.visibility = "private"; }, () => { pageB.visibility = "public"; }],
  ];
  for (const [label, change, undo] of changes) {
    change();
    await assert.rejects(run(), /the plan changed since it was approved .*: plan --public again and have it approved again; nothing frozen or imported/, label);
    nothingFrozen(label);
    undo();
  }
  await assert.rejects(run({ planDigest: planA.public!.digest }), /the plan changed since it was approved/, "one server's digest doesn't cover both");
  nothingFrozen("one server's digest");
  await assert.rejects(run({}, [a.server]), /the plan changed since it was approved/, "the set's digest doesn't stand for one of them alone");
  nothingFrozen("one of them alone");
  await assert.rejects(runLegacyMoves(both, { operator: "alice", stateOf, public: true }), /one server at a time/);
  nothingFrozen("no approval");
  await assert.rejects(run({ approvedBy: a.owner.name }), /is not a Raft platform owner or admin/, "the first server's owner is no approver");
  nothingFrozen("an owner of one of them");
  assert.equal((await itemsOf(a.server.id)).length + (await itemsOf(b.server.id)).length, 0);

  // Unchanged: both moved, the first frozen before the second.
  const result = await run();
  assert.equal(result.stopped, null);
  assert.deepEqual(result.notStarted, []);
  assert.deepEqual(result.reports.map((report) => [report.server.slug, report.imported.map((i) => [i.name, i.home, i.publicBasis ?? null])]), [
    [a.server.slug, [["by-agent-a", "public", "approval"], ["by-member-a", "public", "author"]]],
    [b.server.slug, [["by-agent-b", "public", "approval"], ["private-b", "server", null]]],
  ]);
  assert.deepEqual(result.reports[0]!.skipped.map((e) => [e.name, e.refusal]), [["by-guest-a", "may_not_make_public"]]);
  for (const report of result.reports) assert.deepEqual(report.approval, { approver: { id: approver.id, name: approver.name }, planDigest: set.digest, approvalRef: "#proj-workspace:e7b3e687", imported: 1 });
  assert.equal(states[a.server.id]!.current!.approval!.serverDigest, planA.public!.digest);
  assert.equal(states[b.server.id]!.current!.approval!.serverDigest, planB.public!.digest);
  assert.deepEqual(states[b.server.id]!.current!.approval!.serverIds, [a.server.id, b.server.id]);
  const [madePublic] = (await auditOf(b.server.id)).filter((row) => row.action === "made_public");
  assert.deepEqual({ actor: madePublic!.actorId, approvedBy: madePublic!.after?.approvedBy, ref: madePublic!.after?.approvalRef, ops: madePublic!.after?.ops },
    { actor: approver.id, approvedBy: { type: "user", id: approver.id, name: approver.name }, ref: "#proj-workspace:e7b3e687", ops: { operator: "alice" } });
});

test("approval of several servers: --max counts over the run and no server is started past it; rerun under the same approval, the server done under it is not run again and the next one is checked against the approved plan and moved", async ({ seed }) => {
  const { a, b, approver, stateOf } = await twoServerWorld(seed);
  a.legacy.put({ name: "by-agent-a", visibility: "public", creator: a.as("agent", a.agent.id) });
  const pageB = b.legacy.put({ name: "by-agent-b", visibility: "public", creator: a.as("agent", b.agent.id) });
  const digest = legacyMovePublicSet([await planLegacyMove(a.server, { public: true }), await planLegacyMove(b.server, { public: true })]).digest;
  const approval = { approvedBy: approver.id, planDigest: digest, approvalRef: "msg-1" };
  const run = () => runLegacyMoves([a.server, b.server], { operator: "alice", stateOf, public: true, approval, max: 1 });

  const first = await run();
  assert.equal(first.stopped, "max");
  assert.deepEqual(first.reports.map((report) => [report.server.slug, report.done, report.imported.map((i) => i.name)]), [[a.server.slug, true, ["by-agent-a"]]]);
  assert.deepEqual(first.notStarted, [b.server]);
  assert.ok(!b.legacy.paths().includes("freeze"), "the second isn't frozen");

  // The second changed meanwhile: the approval no longer stands for it.
  pageB.version = 2;
  await assert.rejects(run(), /the plan changed since it was approved/);
  assert.ok(!b.legacy.paths().includes("freeze"));
  pageB.version = 1;

  a.legacy.requests.length = 0;
  const rest = await run();
  assert.equal(rest.stopped, null);
  assert.ok(!a.legacy.paths().includes("freeze"), "the first is not run again");
  assert.deepEqual(rest.reports.map((report) => [report.server.slug, report.imported.map((i) => [i.name, i.publicBasis])]), [
    [a.server.slug, [["by-agent-a", "approval"]]], [b.server.slug, [["by-agent-b", "approval"]]],
  ]);
});

test("run: a manifest whose artifactId isn't the listed one (pages are fetched by name) fails IMPORT_MISMATCH artifact_id, nothing imported, the rest go on", async ({ seed }) => {
  const { server, member, legacy, as } = await publicWorld(seed);
  const swapped = legacy.put({ name: "swapped", creator: as("user", member.id) });
  legacy.put({ name: "fine", creator: as("user", member.id) });
  legacy.state.manifestIdFor.swapped = "pt_someone_else";
  const report = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(report.failed.map((f) => [f.artifactId, f.code, f.details]), [[swapped.artifactId, "IMPORT_MISMATCH", { reason: "artifact_id", expected: swapped.artifactId, actual: "pt_someone_else" }]]);
  assert.deepEqual(report.imported.map((i) => i.name), ["fine"]);
  assert.deepEqual((await itemsOf(server.id)).map((i) => i.name), ["fine"]);
});

// ---- old comments ------------------------------------------------------------------

const T0 = Date.parse("2026-09-01T08:00:00Z");
const oldComment = (id: string, author: LegacyOldComment["author"], body: string, extra: Partial<LegacyOldComment> = {}): LegacyOldComment => ({
  id, author, body, path: null, replyTo: null, createdAt: T0, ...extra,
});
const commentsOf = (itemId: string) => getDb().select().from(artifactComments).where(eq(artifactComments.itemId, itemId)).orderBy(artifactComments.position);
const itemNamed = async (serverId: ServerId, name: string) => (await itemsOf(serverId)).find((item) => item.name === name)!;
const versionOne = async (itemId: string) => (await getDb().select().from(artifactVersions).where(and(eq(artifactVersions.itemId, itemId), eq(artifactVersions.number, 1))))[0]!;

test("comments: a run copies each imported page's old comments right after it: `lc_<id>` rows at the item's next positions on version 1, the old time, no path, anchor, reply or mention; a confirmed author writes them, any other is the system identity with its name first; `On <path>:` and `Reply to <name>:` lines (none for a parent not in the answer), cut to a comment's limit; no event, notice, follow or read position", async ({ seed }) => {
  const { server } = await seedServer(seed);
  const member = await seed.human();
  const left = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const agent = await createAgent(server.id, `writer-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const legacy = fakeLegacyApp(server.id);
  const long = "x".repeat(AGENT_API_ARTIFACT_MAX_COMMENT_CHARS);
  legacy.put({
    name: "alpha",
    creator: { type: "user", raftId: member.id, name: "Mia" },
    comments: [
      oldComment("c1", { type: "user", raftId: member.id, name: "Mia" }, "  Looks good  "),
      oldComment("c2", { type: "agent", raftId: agent.id, name: "Writer" }, "On the chart", { path: "index.html", createdAt: T0 + 1000 }),
      oldComment("c3", { type: "user", raftId: left.id, name: "Lee" }, "Agreed", { replyTo: "c1", createdAt: T0 + 2000 }),
      oldComment("c4", { type: "user", raftId: null, name: "Anon\nymous" }, long, { replyTo: "not-in-the-answer", createdAt: T0 + 3000 }),
    ],
  });

  const report = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(legacy.paths(), ["freeze", "list", "manifest", "blob", "imported", "comments"], "the comments right after the page");
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.imported[0]!.comments, { outcome: "imported", comments: 4, imported: 4, alreadyImported: 0, systemAuthor: 2 });
  assert.deepEqual(report.comments, { pages: 1, imported: 4, alreadyImported: 0, systemAuthor: 2, notFound: 0, failed: 0 });
  assert.match(formatLegacyMoveReport(report), /comments: 4 copied onto 1 page\(s\) \(by the system identity: 2\); failed on 0 page\(s\)/);

  const item = await itemNamed(server.id, "alpha");
  const version = await versionOne(item.id);
  const rows = await commentsOf(item.id);
  assert.deepEqual(rows.map((row) => [row.id, row.position, { type: row.authorType, id: row.authorId }, row.createdAt.getTime()]), [
    ["lc_c1", 2, { type: "user", id: member.id }, T0],
    ["lc_c2", 3, { type: "agent", id: agent.id }, T0 + 1000],
    ["lc_c3", 4, ARTIFACT_OPS_IMPORT_ACTOR, T0 + 2000],
    ["lc_c4", 5, ARTIFACT_OPS_IMPORT_ACTOR, T0 + 3000],
  ]);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.body), [
    "Looks good",
    "On index.html:\nOn the chart",
    "Lee (from raft-artifacts.com)\nReply to Mia:\nAgreed",
  ]);
  const cut = Array.from(rows[3]!.body);
  assert.equal(cut.length, AGENT_API_ARTIFACT_MAX_COMMENT_CHARS, "cut to a comment's limit");
  assert.ok(rows[3]!.body.startsWith("Anon ymous (from raft-artifacts.com)\nxxx"), "no Reply line for a parent not in the answer");
  assert.ok(rows[3]!.body.endsWith("…"));
  for (const row of rows) {
    assert.equal(row.versionId, version.id);
    assert.deepEqual([row.path, row.anchor, row.replyTo, row.mentions, row.reviewId, row.copiedFrom, row.editedAt, row.deletedAt], [null, null, null, [], null, null, null, null]);
  }
  const [after] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, item.id));
  assert.equal(after!.lastPosition, 5);

  // Nobody is woken: the import's own version event alone (for no one), no notice, and only the import's follow and read position (the creator's, at version 1).
  const events = await getDb().select().from(objectEvents).where(eq(objectEvents.objectId, item.id));
  assert.deepEqual(events.map((event) => event.eventKind), ["version"]);
  assert.equal((await getDb().select().from(objectEventRecipients).where(inArray(objectEventRecipients.eventId, events.map((event) => event.id)))).length, 0);
  assert.equal((await getDb().select().from(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, item.id))).length, 0);
  assert.deepEqual((await getDb().select().from(artifactSubscriptions).where(eq(artifactSubscriptions.itemId, item.id))).map((row) => [row.actorType, row.actorId, row.reason]), [["user", member.id, "published"]]);
  assert.deepEqual((await getDb().select().from(artifactReadPositions).where(eq(artifactReadPositions.itemId, item.id))).map((row) => [row.actorType, row.actorId, row.position]), [["user", member.id, 1]]);
  // The copy is audited, by the ops actor, with the operator.
  const audit = (await auditOf(server.id)).filter((row) => row.action === "import_comments");
  assert.deepEqual(audit.map((row) => ({ actor: { type: row.actorType, id: row.actorId }, after: row.after })), [
    { actor: ARTIFACT_OPS_IMPORT_ACTOR, after: { legacyArtifactId: legacy.artifacts[0]!.artifactId, comments: 4, ops: { operator: "alice" } } },
  ]);
});

test("comments: a page whose comments can't be copied (not frozen 409, too many 413, an error) is still imported; the failure is counted and reported, none of its comments written (never part of them), the next page goes on", async ({ seed }) => {
  const { server } = await seedServer(seed);
  const legacy = fakeLegacyApp(server.id);
  const nobody = { type: "user" as const, raftId: null, name: "Old" };
  legacy.put({ name: "fine", comments: [oldComment("f1", nobody, "one")] });
  legacy.put({ name: "not-frozen", comments: [oldComment("n1", nobody, "one")] });
  legacy.put({ name: "too-many", comments: [oldComment("t1", nobody, "one"), oldComment("t2", nobody, "two")] });
  legacy.put({ name: "broken", comments: [oldComment("b1", nobody, "one")] });
  legacy.put({ name: "last", comments: [oldComment("l1", nobody, "one")] });
  legacy.state.commentsStatusFor = { "not-frozen": 409, "too-many": 413, broken: 500 };

  const report = await runLegacyMove(server, { operator: "alice", state: memoryState() });
  assert.deepEqual(report.failed, [], "no page failed");
  assert.deepEqual(report.imported.map((page) => [page.name, page.comments?.outcome, page.comments?.outcome === "failed" ? page.comments.reason : null]), [
    ["fine", "imported", null], ["not-frozen", "failed", "not_frozen"], ["too-many", "failed", "too_many"], ["broken", "failed", "bad_answer"], ["last", "imported", null],
  ]);
  assert.deepEqual(report.comments, { pages: 5, imported: 2, alreadyImported: 0, systemAuthor: 2, notFound: 0, failed: 3 });
  assert.match(formatLegacyMoveReport(report), /comments of too-many \(.*\): comments FAILED \(too_many\)/);
  for (const name of ["not-frozen", "too-many", "broken"]) {
    const item = await itemNamed(server.id, name);
    assert.ok(item, `${name} imported`);
    assert.deepEqual(await commentsOf(item.id), [], `${name}: no comment`);
    assert.equal(item.lastPosition, 1);
  }
  assert.equal((await commentsOf((await itemNamed(server.id, "last")).id)).length, 1);
});

test("comments plan / run: pages imported before (here on demand, which copies no comments, before the freeze): while the server isn't frozen there the plan has nothing (409); frozen, it lists each page that stands imported with its counts and one digest, asking only list and comments and writing nothing; a run refuses a non-owner approver and a digest that isn't a fresh plan's, before writing; approved, it writes; a rerun duplicates nothing and moves no position", async ({ seed }) => {
  const { owner, server } = await seedServer(seed);
  const member = await seed.human();
  const left = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const approver = await platformPerson(seed, "admin");
  const legacy = fakeLegacyApp(server.id);
  const mia = { type: "user" as const, raftId: member.id, name: "Mia" };
  const alpha = legacy.put({
    name: "alpha", creator: mia,
    comments: [
      oldComment("a1", mia, "first"),
      oldComment("a2", { type: "user", raftId: left.id, name: "Lee" }, "second", { createdAt: T0 + 1 }),
      oldComment("a3", mia, "third", { replyTo: "a2", createdAt: T0 + 2 }),
    ],
  });
  const beta = legacy.put({ name: "beta", comments: [] });
  legacy.put({ name: "not-imported", comments: [oldComment("x1", mia, "never")] });
  for (const name of ["alpha", "beta"]) {
    const outcome = await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name, operator: "alice" });
    assert.equal(outcome.kind, "imported");
  }
  assert.ok(!legacy.paths().includes("comments"), "the import itself (the on-demand one's steps) asks for no comments");
  const alphaItem = await itemNamed(server.id, "alpha");
  assert.deepEqual(await commentsOf(alphaItem.id), []);

  // Not frozen there: nothing served, nothing to copy.
  const unfrozen = await planLegacyComments([server]);
  assert.equal(unfrozen.plans[0]!.frozen, false);
  assert.deepEqual(unfrozen.plans[0]!.pages, []);
  assert.match(formatLegacyCommentsPlan(unfrozen), /NOT frozen in the standalone app/);

  legacy.state.frozenAt = new Date("2026-10-26T10:00:00Z").toISOString();
  legacy.requests.length = 0;
  const set = await planLegacyComments([server]);
  assert.deepEqual(new Set(legacy.paths()), new Set(["list", "comments"]), "list and comments only");
  assert.deepEqual(legacy.requests.filter((r) => r.path === "comments").map((r) => r.query.name), ["alpha", "beta"], "only the pages that stand imported");
  const [plan] = set.plans;
  assert.equal(plan!.frozen, true);
  assert.deepEqual(plan!.pages.map((page) => ({ ...page })), [
    {
      artifactId: alpha.artifactId, name: "alpha", link: `https://raft-artifacts.com/p/${server.slug}/alpha`, artifact: { id: alphaItem.id, url: linkOf(alphaItem.id) },
      fetch: "comments", comments: 3, authors: { matched: 1, unmatched: 1 }, byAuthor: { matched: 2, unmatched: 1 }, alreadyImported: 0, elsewhere: 0, toImport: 3,
    },
    {
      artifactId: beta.artifactId, name: "beta", link: `https://raft-artifacts.com/p/${server.slug}/beta`, artifact: { id: (await itemNamed(server.id, "beta")).id, url: linkOf((await itemNamed(server.id, "beta")).id) },
      fetch: "comments", comments: 0, authors: { matched: 0, unmatched: 0 }, byAuthor: { matched: 0, unmatched: 0 }, alreadyImported: 0, elsewhere: 0, toImport: 0,
    },
  ]);
  assert.deepEqual(set.totals, { pages: 2, comments: 3, toImport: 3, alreadyImported: 0, elsewhere: 0, matched: 2, unmatched: 1 });
  assert.match(set.digest, /^[0-9a-f]{64}$/);
  assert.equal(set.digest, plan!.digest, "one server's digest is its own");
  assert.notEqual(set.digest, unfrozen.digest);
  assert.equal((await planLegacyComments([server])).digest, set.digest, "the same plan, the same digest");
  assert.ok(formatLegacyCommentsPlan(set).includes(`plan digest (comments run --servers ${server.slug} --plan-digest): ${set.digest}`));
  assert.deepEqual(await commentsOf(alphaItem.id), [], "the plan wrote nothing");

  const run = (approval: Partial<{ approvedBy: string; planDigest: string; approvalRef: string }>) =>
    runLegacyComments([server], { operator: "alice", approval: { approvedBy: approver.email, planDigest: set.digest, approvalRef: "#proj-move:msg-7", ...approval } });
  // The moved server's own owner, a member: no approvers. A digest that isn't the plan's, or missing parts: refused. Nothing written.
  for (const who of [owner.name, member.id, "no-such-person"]) await assert.rejects(run({ approvedBy: who }), /is not a Raft platform owner or admin/, who);
  await assert.rejects(run({ planDigest: "0".repeat(64) }), /the comments plan changed since it was approved/);
  await assert.rejects(run({ approvalRef: " " }), /all three/);
  // The plan changes (a comment more there, as if not frozen): the approved digest no longer runs.
  alpha.comments!.push(oldComment("a4", mia, "late", { createdAt: T0 + 3 }));
  await assert.rejects(run({}), /the comments plan changed since it was approved/);
  alpha.comments!.pop();
  assert.deepEqual(await commentsOf(alphaItem.id), []);

  const report = await run({});
  assert.deepEqual(report.approval, { approver: { id: approver.id, name: approver.name }, planDigest: set.digest, approvalRef: "#proj-move:msg-7" });
  assert.deepEqual(report.counts, { pages: 2, comments: 3, imported: 3, alreadyImported: 0, failed: 0 });
  assert.deepEqual(report.servers[0]!.pages.map((page) => [page.name, page.outcome, page.imported]), [["alpha", "written", 3], ["beta", "nothing_to_do", 0]]);
  assert.match(formatLegacyCommentsReport(report), /copied 3, there before 0, failed 0/);
  const written = await commentsOf(alphaItem.id);
  assert.deepEqual(written.map((row) => [row.id, row.position, row.body]), [
    ["lc_a1", 2, "first"], ["lc_a2", 3, "Lee (from raft-artifacts.com)\nsecond"], ["lc_a3", 4, "Reply to Lee:\nthird"],
  ]);
  const audit = (await auditOf(server.id)).filter((row) => row.action === "import_comments");
  assert.deepEqual(audit.map((row) => row.after), [{
    legacyArtifactId: alpha.artifactId, comments: 3, ops: { operator: "alice" },
    approvedBy: { type: "user", id: approver.id, name: approver.name }, approvalRef: "#proj-move:msg-7",
  }]);
  // No one woken by it.
  assert.equal((await getDb().select().from(objectEvents).where(and(eq(objectEvents.objectId, alphaItem.id), eq(objectEvents.eventKind, "comment")))).length, 0);
  assert.equal((await getDb().select().from(artifactSubscriptions).where(and(eq(artifactSubscriptions.itemId, alphaItem.id), eq(artifactSubscriptions.reason, "commented")))).length, 0);

  // Again: the same digest (what is copied doesn't change it), nothing new, no position moved.
  const replan = await planLegacyComments([server]);
  assert.equal(replan.digest, set.digest);
  assert.deepEqual(replan.totals, { pages: 2, comments: 3, toImport: 0, alreadyImported: 3, elsewhere: 0, matched: 2, unmatched: 1 });
  const again = await run({});
  assert.deepEqual(again.counts, { pages: 2, comments: 3, imported: 0, alreadyImported: 3, failed: 0 });
  assert.deepEqual((await commentsOf(alphaItem.id)).map((row) => [row.id, row.position]), written.map((row) => [row.id, row.position]));
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, alphaItem.id));
  assert.equal(item!.lastPosition, 4);
  assert.equal((await auditOf(server.id)).filter((row) => row.action === "import_comments").length, 1, "nothing copied, nothing audited");
});

test("comments plan over several servers: one digest of them all (legacyMoveSetDigest), in any order; comments run --servers verifies it and writes each", async ({ seed }) => {
  const approver = await platformPerson(seed, "owner");
  const worlds: Array<{ server: LegacyMoveServer; legacy: ReturnType<typeof fakeLegacyApp> }> = [];
  for (const name of ["one", "two"]) {
    const { server } = await seedServer(seed);
    const legacy = fakeLegacyApp(server.id);
    legacy.put({ name, comments: [oldComment(`${name}-c1`, { type: "agent", raftId: null, name: "Bot" }, `hello ${name}`)] });
    assert.equal((await importLegacyArtifactAsOps({ serverId: server.id, serverSlug: server.slug, name, operator: "alice" })).kind, "imported");
    legacy.state.frozenAt = new Date("2026-10-26T10:00:00Z").toISOString();
    worlds.push({ server, legacy });
  }
  routeLegacyApps(Object.fromEntries(worlds.map((world) => [world.server.id, world.legacy])));
  const servers = worlds.map((world) => world.server);
  const set = await planLegacyComments(servers);
  assert.equal(set.digest, legacyMoveSetDigest(set.plans.map((plan) => ({ serverId: plan.server.id, digest: plan.digest }))));
  assert.equal((await planLegacyComments([...servers].reverse())).digest, set.digest, "in any order");
  await assert.rejects(
    runLegacyComments(servers, { operator: "alice", approval: { approvedBy: approver.id, planDigest: set.plans[0]!.digest, approvalRef: "m" } }),
    /the comments plan changed since it was approved/,
    "one server's digest is not the set's",
  );
  const report = await runLegacyComments(servers, { operator: "alice", approval: { approvedBy: approver.id, planDigest: set.digest, approvalRef: "m" } });
  assert.deepEqual(report.servers.map((entry) => [entry.server.id, entry.counts.imported]), servers.map((server) => [server.id, 1]));
  for (const [index, { server }] of worlds.entries()) {
    const name = index === 0 ? "one" : "two";
    assert.deepEqual((await commentsOf((await itemNamed(server.id, name)).id)).map((row) => row.body), [`Bot (from raft-artifacts.com)\nhello ${name}`]);
  }
});
