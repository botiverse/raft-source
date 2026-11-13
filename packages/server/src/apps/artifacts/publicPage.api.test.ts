// The public Artifact page's HTML (publicPage.ts) through the whole server, with the real visibility check
// (publicPageOf: publicItemOf's checks) and the real database, as app.raft.build's CloudFront sends
// `/artifacts/<id>` here behind the edge marker (#proj-workspace:#242, the metadata review). publicPage.test.ts
// has what the router writes, on fake data; this proves which Artifacts get it:
// - a public one: `<title>` (`<title> | Raft`), description, Open Graph, Twitter and canonical tags, noindex, every
//   value escaped (a title and an entry text that try to leave their tag or attribute);
// - one that isn't public (its server's home, a private channel's, revoked) or no Artifact at all (an unknown id,
//   a malformed one): the shell exactly as the web serves it, "Raft", nothing of the Artifact anywhere in it.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { artifactLinkId, asArtifactId, asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { APP_EDGE_HEADER } from "../../routes/firstPartyAppRoutes";
import { appUrl } from "../../platform/links";
import { createApiTest } from "../../test/integration/apiTest";
import { __setArtifactR2StoreForTests, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { __settlePublicTextFillsForTests } from "./publicText";
import { artifactBlobs, artifactItems, artifactVersionFiles, artifactVersions } from "./schema";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

const EDGE = "edge-test-1";
const API = "https://api.example.test";
// The web's built shell, as the web serves it (`#root` with its attributes).
const SHELL = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\" />\n<meta name=\"theme-color\" content=\"#FFD440\" />\n<title>Raft</title>\n</head>\n<body><div id=\"root\" translate=\"no\" class=\"notranslate\"></div></body>\n</html>\n";
const HOSTILE_TITLE = "Q3 </title><script>alert(1)</script> \"plan\" & 'notes'";
const HOSTILE_TEXT = "<p>Revenue grew \"12%\" & margins held; <img src=x onerror=alert(2)></p>";

const objects = new Map<string, Buffer>();
const memoryR2: ArtifactR2Store = {
  async put(key, bytes) { objects.set(key, bytes); },
  async delete(key) { objects.delete(key); },
  async read(blob) {
    const bytes = blob.r2Key ? objects.get(blob.r2Key) : undefined;
    return bytes ? { stream: Readable.from([bytes]), size: bytes.length } : null;
  },
  async presign() { return null; },
};

let shellSite: http.Server | null = null;

beforeEach(async () => {
  shellSite = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(SHELL);
  });
  await new Promise<void>((resolve) => shellSite!.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ARTIFACT_PAGE_SHELL_URL", `http://127.0.0.1:${(shellSite.address() as AddressInfo).port}/`);
  vi.stubEnv("RAFT_APP_EDGE_HEADER_VALUE", EDGE);
  vi.stubEnv("SERVER_URL", API);
  __setArtifactR2StoreForTests(memoryR2);
});

afterEach(async () => {
  await __settlePublicTextFillsForTests();
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
  await new Promise<void>((resolve) => (shellSite ? shellSite.close(() => resolve()) : resolve()));
  shellSite = null;
});

type Home = "public" | "server" | { channelId: string };

/** An Artifact of `serverId` at `home`, its one published version current: an HTML entry of `html`. */
async function made(serverId: ServerId, authorId: string, home: Home, opts: { title?: string; html?: string; revoked?: boolean } = {}) {
  const db = getDb();
  const id = `pt_${randomUUID()}`;
  const title = opts.title ?? `Artifact ${id.slice(3, 11)}`;
  await db.insert(artifactItems).values({
    id,
    serverId,
    urlKey: id,
    name: `page-${id.slice(3, 11)}`,
    title,
    homeKind: typeof home === "string" ? home : "conversation",
    homeChannelId: typeof home === "string" ? null : home.channelId,
    createdByType: "user",
    createdById: authorId,
    revokedAt: opts.revoked ? new Date() : null,
  });
  const bytes = Buffer.from(`<!doctype html><html><body>${opts.html ?? `<p>The body of ${id}.</p>`}</body></html>`);
  const versionId = `v_${randomUUID()}`;
  await db.insert(artifactVersions).values({
    id: versionId, itemId: id, number: 1, entry: "index.html", title: null, fileCount: 1, sizeBytes: bytes.length,
    publishDigest: "digest", status: "published", publisherType: "user", publisherId: authorId, position: 1,
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobId = `b_${randomUUID()}`;
  const r2Key = r2KeyOf(serverId, sha256, blobId);
  objects.set(r2Key, bytes);
  await db.insert(artifactBlobs).values({ id: blobId, serverId, sha256, sizeBytes: bytes.length, state: "ready", r2Key });
  await db.insert(artifactVersionFiles).values({ versionId, path: "index.html", sha256, sizeBytes: bytes.length, blobId });
  await db.update(artifactItems).set({ currentVersionId: versionId, lastPosition: 1 }).where(eq(artifactItems.id, id));
  return { id, title, short: artifactLinkId(asArtifactId(id)) };
}

async function page(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { [APP_EDGE_HEADER]: EDGE, Accept: "text/html" }, redirect: "manual" });
  return { response, body: await response.text() };
}

/** Every `<meta>` and `<link>` of the head, by its name or property (rel for a link). */
function headTags(body: string): Map<string, string> {
  const head = body.slice(0, body.indexOf("</head>"));
  const tags = new Map<string, string>();
  for (const match of head.matchAll(/<meta (?:name|property)="([^"]+)" content="([^"]*)">/g)) tags.set(match[1]!, match[2]!);
  for (const match of head.matchAll(/<link rel="canonical" href="([^"]*)">/g)) tags.set("canonical", match[1]!);
  return tags;
}

test("a public Artifact's page: its title, description, Open Graph, Twitter and canonical, noindex, every value escaped", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const open = await made(asServerId(server.id), owner.id, "public", { title: HOSTILE_TITLE, html: HOSTILE_TEXT });

  for (const path of [`/artifacts/${open.short}`, `/artifacts/${open.short}/v/1`]) {
    const { response, body } = await page(app.baseUrl, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-raft-artifact-diagnostic"), "injected", path);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(response.headers.get("cache-control"), "no-store");
    // The one title, escaped: the title can't close it and open a script.
    assert.deepEqual([...body.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]), [
      "Q3 &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &quot;plan&quot; &amp; &#39;notes&#39; | Raft",
    ]);
    assert.ok(!body.includes("<script>alert(1)"), "no tag of the title's anywhere in the page");
    assert.ok(!body.includes("<img src=x"), "nor of the entry's text");
    const tags = headTags(body);
    const title = "Q3 &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &quot;plan&quot; &amp; &#39;notes&#39;";
    // The deployment's web origin (app.raft.build in production), never the request's Host.
    const canonical = `${appUrl()}/artifacts/${open.short}`;
    assert.equal(tags.get("og:title"), title);
    assert.equal(tags.get("twitter:title"), title);
    assert.equal(tags.get("og:url"), canonical, "the Artifact's address, a pinned version's too");
    assert.equal(tags.get("canonical"), canonical);
    assert.equal(tags.get("og:type"), "article");
    assert.equal(tags.get("robots"), "noindex, nofollow", "indexing as before: none");
    // The entry's readable text, as the card's: its words, its markup gone, what's left escaped.
    assert.match(tags.get("og:description") ?? "", /^Revenue grew &quot;12%&quot; &amp; margins held;/);
    assert.equal(tags.get("description"), tags.get("og:description"));
    assert.equal(tags.get("twitter:description"), tags.get("og:description"));
    // No publicly servable screenshot (core's object route checks the reader): the app icon, a small card.
    assert.equal(tags.get("og:image"), `${appUrl()}/android-chrome-512x512.png`);
    assert.equal(tags.get("twitter:card"), "summary");
    assert.ok(!body.includes("/api/objects/"), "no screenshot's private address");
  }
});

test("not public, no Artifact at all, or Artifacts off: the shell exactly as the web serves it, nothing of the Artifact in it", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const room = await createChannel(server.id, `meta-room-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(room.id, owner.id);
  const serverId = asServerId(server.id);
  const secret = (name: string) => ({ title: `Secret ${name} ${randomUUID().slice(0, 8)}`, html: `<p>Secret text of ${name}.</p>` });
  const serverHome = await made(serverId, owner.id, "server", secret("server"));
  const privateChannel = await made(serverId, owner.id, { channelId: room.id }, secret("room"));
  const revoked = await made(serverId, owner.id, "public", { ...secret("revoked"), revoked: true });

  const cases: Array<[string, string, string | null]> = [
    ["server home", `/artifacts/${serverHome.short}`, serverHome.title],
    ["private channel", `/artifacts/${privateChannel.short}`, privateChannel.title],
    ["revoked", `/artifacts/${revoked.short}`, revoked.title],
    ["unknown id", `/artifacts/${artifactLinkId(asArtifactId(`pt_${randomUUID()}`))}`, null],
    ["pinned version of a private one", `/artifacts/${privateChannel.short}/v/1`, privateChannel.title],
  ];
  const shellOnly = async (name: string, path: string, title: string | null) => {
    const { response, body } = await page(app.baseUrl, path);
    assert.equal(response.status, 200, name);
    assert.equal(body, SHELL, `${name}: the shell as it is`);
    assert.equal(response.headers.get("x-raft-artifact-diagnostic"), "skipped=not_public", name);
    assert.equal(response.headers.get("x-raft-artifact-preview"), null, `${name}: not marked as a preview`);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", name);
    if (title) assert.ok(!body.includes(title), `${name}: its title nowhere`);
    assert.ok(!body.includes("Secret"), `${name}: nothing of any hidden Artifact`);
  };
  for (const [name, path, title] of cases) await shellOnly(name, path, title);
  // Artifacts off: a public Artifact's page is the shell as it is too.
  const open = await made(serverId, owner.id, "public", { title: `Open ${randomUUID().slice(0, 8)}` });
  assert.equal((await page(app.baseUrl, `/artifacts/${open.short}`)).response.headers.get("x-raft-artifact-diagnostic"), "injected", "witness: with Artifacts on its page names it");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  await shellOnly("Artifacts off", `/artifacts/${open.short}`, open.title);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  // A malformed id: the app's address, the shell as it is too.
  const malformed = await page(app.baseUrl, "/artifacts/not-an-artifact");
  assert.equal(malformed.response.status, 200);
  assert.equal(malformed.body, SHELL);
});
