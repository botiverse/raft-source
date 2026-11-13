// A push whose pages hold themselves to one screen is published and warned
// (task #71; scrollLock.ts, Porthole's scroll-lock rule): from the request's
// inline bytes, from storage for files carried over, a stylesheet the page
// links found by its path; a normal page has no `warnings`; a version past the
// check's byte budget isn't checked. A page's own frames are warned too
// (`nested-frame`): in its markup (Porthole's rule) and created by its own
// scripts; the word in its text or in a comment isn't. A pushed copy of a
// common library is warned (`bundled-library`, bundledLibraries.ts) with the
// pinned jsDelivr address to load instead: by its name, or by its banner read
// from the request or, for bytes the server already has, its first bytes from
// storage; the page's own scripts and a vendor file not listed aren't, nor is
// a copy carried over from an earlier version.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { getDb } from "../../db/index";
import { featureFlagRules } from "../../db/schema";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";
import { LIBRARY_MIN_BYTES } from "./bundledLibraries";
import { SCROLL_CHECK_BYTES } from "./scrollLock";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";

const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-scroll-lock-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);

/** R2 in memory, counting reads. */
function memoryR2(objects: Map<string, Buffer>, reads: string[]): ArtifactR2Store {
  return {
    async read(blob) {
      reads.push(blob.r2Key);
      const bytes = objects.get(blob.r2Key);
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

/** A server with Artifacts on, an agent in a channel, its key, and R2 in memory. */
async function seedWorld(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `scroll-${label()}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `scroll-${label()}`);
  await addAgent(channel.id, agent.id);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const key = (await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: `scroll-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const reads: string[] = [];
  __setArtifactR2StoreForTests(memoryR2(new Map(), reads));
  return { channel, key, reads };
}

async function publish(app: { baseUrl: string }, apiKey: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/artifacts/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const text = (path: string, content: string) => ({ path, content });
const page = (head: string) => `<!doctype html>\n<html>\n<head>${head}</head>\n<body>\n<main><h1>Report</h1><p>A long page.</p></main>\n</body>\n</html>\n`;
const LOCKED = "<style>html,body{height:100%;overflow:hidden}</style>";

test("a page held to one screen is pushed with a scroll-lock warning; a normal page has none", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const held = await publish(app, world.key, { target: `#${world.channel.name}`, title: "Held", files: [text("index.html", page(LOCKED))] });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  assert.equal(held.body.version.number, 1, "published all the same");
  assert.equal(held.body.warnings?.length, 1, JSON.stringify(held.body.warnings));
  const [warning] = held.body.warnings;
  assert.equal(warning.rule, "scroll-lock");
  assert.equal(warning.path, "index.html");
  assert.equal(typeof warning.line, "number");
  assert.match(warning.message, /won't scroll in its frame/);
  assert.deepEqual(world.reads, [], "the inline bytes: no storage read");

  const normal = await publish(app, world.key, { target: `#${world.channel.name}`, title: "Normal", files: [text("index.html", page("<style>body{margin:0}</style>"))] });
  assert.equal(normal.status, 201, JSON.stringify(normal.body));
  assert.equal("warnings" in normal.body, false);
});

test("a page that embeds a frame of its own is pushed with a nested-frame warning", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const framed = await publish(app, world.key, { target: `#${world.channel.name}`, title: "Framed", files: [text("index.html", page('<div class="stage"><iframe title="demo" srcdoc="<p>hi</p>"></iframe></div>'))] });
  assert.equal(framed.status, 201, JSON.stringify(framed.body));
  assert.equal(framed.body.version.number, 1, "published all the same");
  assert.equal(framed.body.warnings?.length, 1, JSON.stringify(framed.body.warnings));
  const [warning] = framed.body.warnings;
  assert.equal(warning.rule, "nested-frame");
  assert.equal(warning.path, "index.html");
  assert.equal(warning.line, 3);
  assert.match(warning.message, /<iframe>/);
});

test("a page's own script that creates a frame is pushed with a nested-frame warning naming the call", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const created = await publish(app, world.key, {
    target: `#${world.channel.name}`,
    title: "Scripted",
    files: [
      text("index.html", page("<script>\nconst stage = document.createElement( 'IFRAME' );\nstage.srcdoc = '<p>hi</p>';\n</script>")),
      text("other.html", page('<script type="module">\nconst plugin = document.createElementNS("http://www.w3.org/1999/xhtml", `embed`);\n</script>')),
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.version.number, 1, "published all the same");
  const warnings = (created.body.warnings ?? []) as { rule: string; path: string; line?: number; message: string }[];
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  const [index, other] = [warnings.find((entry) => entry.path === "index.html"), warnings.find((entry) => entry.path === "other.html")];
  assert.ok(index && other, JSON.stringify(warnings));
  assert.equal(index.rule, "nested-frame");
  assert.equal(index.line, 4);
  assert.match(index.message, /createElement\("iframe"\)/);
  assert.match(index.message, /the rest of that script doesn't run/);
  assert.equal(other.rule, "nested-frame");
  assert.equal(other.line, 4);
  assert.match(other.message, /createElementNS\(…, "embed"\)/);
});

test("the word iframe in a page's text, a comment or a commented-out frame doesn't warn", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const head = [
    "<!-- The stages were an iframe each: <iframe srcdoc=\"<p>old</p>\"></iframe> -->",
    "<script>",
    "// document.createElement(\"iframe\") left the stages blank; they are drawn inline now.",
    "/* createElement('object') too */",
    "const stage = document.createElement(\"div\");",
    "</script>",
  ].join("\n");
  const quiet = await publish(app, world.key, {
    target: `#${world.channel.name}`,
    title: "Quiet",
    files: [text("index.html", page(head).replace("<p>A long page.</p>", "<p>No iframe or embed here: an iframe never loads.</p><pre><code>document.createElement(\"iframe\")</code></pre>"))],
  });
  assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
  assert.equal("warnings" in quiet.body, false, JSON.stringify(quiet.body.warnings));
});

test("a stylesheet the page links, read from storage when the page carries over, is checked too", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const v1 = await publish(app, world.key, {
    target: `#${world.channel.name}`,
    title: "Linked",
    files: [text("index.html", page(`<link rel="stylesheet" href="./assets/app.css">`)), text("assets/app.css", "main { padding: 1rem }\n"), text("notes.txt", "not read")],
  });
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  assert.equal("warnings" in v1.body, false);

  // Only the sheet changes: the page is read from storage, the sheet from the request.
  const v2 = await publish(app, world.key, { artifact: v1.body.artifact.id, base: 1, files: [text("assets/app.css", "main { padding: 1rem }\nhtml, body { height: 100vh; overflow: hidden }\n")] });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.warnings?.length, 1, JSON.stringify(v2.body.warnings));
  assert.equal(v2.body.warnings[0].path, "assets/app.css");
  assert.equal(v2.body.warnings[0].line, 2);
  assert.equal(world.reads.length, 1, "the page alone from storage; never notes.txt");
});

test("a version past the check's byte budget isn't checked: published, no warning", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const filler = `<p>${"x".repeat(SCROLL_CHECK_BYTES)}</p>`;
  const res = await publish(app, world.key, { target: `#${world.channel.name}`, title: "Big", files: [text("index.html", page(LOCKED).replace("<main>", `<main>${filler}`))] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal("warnings" in res.body, false);
});

/** A script of at least LIBRARY_MIN_BYTES: `start`, then filler code. */
const script = (start: string) => `${start}\n${"var a=1;".repeat(LIBRARY_MIN_BYTES / 8)}\n`;
const JQUERY = script("/*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors | jquery.org/license */");

test("a pushed copy of jQuery is warned (bundled-library) with its pinned jsDelivr address; the page's own script and a vendor file not listed aren't", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const res = await publish(app, world.key, {
    target: `#${world.channel.name}`,
    title: "Vendored",
    files: [
      text("index.html", page('<script src="./vendor/jquery-3.7.1.min.js"></script><script src="./vendor/tiny-lib.min.js"></script><script src="./app.js"></script>')),
      text("vendor/jquery-3.7.1.min.js", JQUERY),
      text("vendor/tiny-lib.min.js", script("/*! tiny-lib v1.0.0 | MIT */")),
      text("app.js", script("// The report's own code.")),
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.version.number, 1, "published all the same");
  assert.deepEqual(res.body.warnings, [{
    rule: "bundled-library",
    path: "vendor/jquery-3.7.1.min.js",
    message: "This is a copy of jQuery 3.7.1: point the page's src (or href) at https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js and delete this file. A copied library counts against the server's monthly upload quota each time its bytes change; an address doesn't.",
  }]);
  assert.deepEqual(world.reads, [], "the inline bytes: no storage read");
});

test("a copy the server already has is read from storage by its first bytes; one carried over isn't warned again", async ({ app, seed }) => {
  const world = await seedWorld(seed);
  const chart = script("/*!\n * Chart.js v4.4.1\n * https://www.chartjs.org\n */");
  const v1 = await publish(app, world.key, { target: `#${world.channel.name}`, title: "Charts", files: [text("index.html", page('<script src="./lib/a.js"></script>')), text("lib/a.js", chart)] });
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  assert.equal(v1.body.warnings?.[0]?.message.startsWith("This is a copy of Chart.js 4.4.1: point the page's src (or href) at https://cdn.jsdelivr.net/npm/chart.js@4.4.1 "), true, JSON.stringify(v1.body.warnings));

  // The same bytes under another name, by their sha256: the server reads their start from storage.
  const sha256 = createHash("sha256").update(chart, "utf8").digest("hex");
  const v2 = await publish(app, world.key, { artifact: v1.body.artifact.id, base: 1, files: [{ path: "lib/b.js", sha256, size: Buffer.byteLength(chart) }] });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.deepEqual(v2.body.warnings?.map((warning: { rule: string; path: string }) => [warning.rule, warning.path]), [["bundled-library", "lib/b.js"]], "lib/a.js carried over: not again");
  assert.equal(world.reads.length, 2, "the page for its checks, and lib/b.js's start");
});
