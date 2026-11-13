import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import keyVectors from "@botiverse/raft-shared/src/testVectors/appObjectKeys.vectors.json" with { type: "json" };

import { pdfjsAssetsSource } from "../scripts/pdfjs-assets";
import { MARKDOWN_FONT_FACES } from "../src/markdown";
import {
  ARTIFACTS_PREFIX,
  FAMILY_ID,
  R2_BUCKET,
  R2_READ_ACCESS_KEY_ID,
  R2_READ_SECRET_ACCESS_KEY,
  RAFT_TOKEN,
  SERVER_ID,
  startRaftContent,
  USER_ID,
  WORKER_TOKEN,
  type Published,
  type RaftContentApp,
} from "./raftContentHarness";
import { samplePdf } from "./samplePdf";

/**
 * The content Worker for Raft's workspace Artifacts (src/raftContent.ts; slock
 * docs/development/workspace-artifacts-content-origin.md): Raft asks it for a
 * frame (`POST /_raft/frames`, a bearer from RAFT_TOKENS), Porthole mints the
 * one-time ticket for Raft's grant, the page is served on `w-<uuid>.<domain>`
 * under the frame's sandbox, and every request after asks Raft again
 * (`/internal/artifacts-content/authorize`), its bytes from R2 by the keys of
 * Raft's manifest, read through R2's S3 API with a read-only token (the
 * harness's stub checks every request's signature).
 */

const HTML = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1>Raft page</h1><img src="img/dot.svg"><script src="app.js"></script></body></html>`;
const frameHeaders = { "sec-fetch-dest": "iframe" };

async function setup(t: test.TestContext, bindings?: Record<string, string>) {
  const app = await startRaftContent(bindings ? { bindings } : {});
  t.after(() => app.close());
  return app;
}

/** A frame location for a version, as Raft gets it. */
async function locate(app: RaftContentApp, published: Published): Promise<{ url: string; origin: string; reports?: boolean }> {
  const response = await app.issue(app.bodyFor(published));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { url: string; origin: string; reports?: boolean };
}

/** The frame's first load (the ticket's answer), and the sealed files address it carries. */
async function open(app: RaftContentApp, published: Published) {
  const location = await locate(app, published);
  const served = await app.contentFetch(location.url, { headers: frameHeaders });
  const body = await served.text();
  const base = new RegExp(`${location.origin.replaceAll(".", "\\.")}/__porthole/f/[A-Za-z0-9_-]+/`).exec(body)?.[0] ?? null;
  return { location, served, body, base };
}

const directivesOf = (csp: string) =>
  Object.fromEntries(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name = "", ...values]) => [name, values]));

/** Every cookie an answer sets is Porthole's own kind: HttpOnly, and `__Host-`/Secure over https. */
function assertCookies(response: Response, https: boolean) {
  for (const cookie of response.headers.getSetCookie()) {
    assert.match(cookie, /;\s*HttpOnly/i, cookie);
    if (https) assert.match(cookie, /^__Host-porthole-[^=]*=.*;\s*Secure/i, cookie);
  }
}

test("the issue route refuses a missing or wrong token (401) and a bad body (400), logging route and source only, once a minute per address", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const body = app.bodyFor(published);

  for (const token of [null, "", "wrong-token-of-enough-length-0123456789abcdef", "short", WORKER_TOKEN, `${RAFT_TOKEN}x`]) {
    const response = await app.issue(body, token);
    assert.equal(response.status, 401, `token ${token}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  // Not a Bearer: Basic, or the token with something after it.
  for (const authorization of [`Basic ${RAFT_TOKEN}`, `Bearer ${RAFT_TOKEN} extra`, `bearer${RAFT_TOKEN}`]) {
    const response = await fetch(`${app.workerUrl}/_raft/frames`, { method: "POST", headers: { authorization }, body: JSON.stringify(body) });
    assert.equal(response.status, 401, authorization);
  }
  // From two more addresses, three times each.
  for (const address of ["203.0.113.7", "203.0.113.8"])
    for (let each = 0; each < 3; each += 1)
      assert.equal((await fetch(`${app.workerUrl}/_raft/frames`, { method: "POST", headers: { "cf-connecting-ip": address, authorization: "Bearer nope" } })).status, 401);
  const refused = app.logs.filter((line) => line.includes("raft-content.refused-token")).map((line) => JSON.parse(line) as Record<string, string>);
  const sources = refused.map((line) => line.source!);
  assert.equal(new Set(sources).size, sources.length, `at most one line a minute per address: ${sources.join(", ")}`);
  assert.ok(sources.includes("203.0.113.7") && sources.includes("203.0.113.8"), sources.join(", "));
  for (const line of refused) {
    assert.deepEqual(Object.keys(line).sort(), ["evt", "route", "source"]);
    assert.equal(line.route, "/_raft/frames");
    for (const secret of [RAFT_TOKEN, "wrong-token", WORKER_TOKEN, "nope"]) assert.ok(!JSON.stringify(line).includes(secret), "never the token");
  }

  const bad: unknown[] = [
    "not json",
    "",
    [],
    null,
    { ...body, extra: 1 },
    { artifact: body.artifact, version: body.version, viewer: body.viewer },
    { ...body, artifact: body.artifact.toUpperCase() },
    { ...body, artifact: body.artifact.replace("pt_", "pt-") },
    { ...body, version: body.artifact },
    { ...body, viewer: `agent:${USER_ID}` },
    { ...body, viewer: "user:me" },
    { ...body, subject: `v2:${SERVER_ID}:${USER_ID}:-` },
    { ...body, subject: `v1:${SERVER_ID}:${FAMILY_ID}:-` }, // another user than the viewer
    { ...body, subject: `v1:${SERVER_ID}:${USER_ID}:not-a-family` },
    { ...body, artifact: 7 },
    { ...body, subject: `${body.subject}${" ".repeat(5000)}` }, // past the body's bound
  ];
  for (const each of bad) {
    const response = await app.issue(typeof each === "string" ? each : JSON.stringify(each));
    assert.equal(response.status, 400, JSON.stringify(each)?.slice(0, 120));
  }
  // A signed-out session family is `-`: a good body.
  assert.equal((await app.issue({ ...body, subject: `v1:${SERVER_ID}:${USER_ID}:-` })).status, 201);
  assert.equal((await fetch(`${app.workerUrl}/_raft/frames`, { headers: { authorization: `Bearer ${RAFT_TOKEN}` } })).status, 405);
});

test("a valid issue answers a FrameLocation on w-<uuid>.<domain>; a version Raft doesn't frame is a 404", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const uuid = published.artifact.slice("pt_".length);
  const response = await app.issue(app.bodyFor(published));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const location = (await response.json()) as Record<string, unknown>;
  const origin = `http://w-${uuid}.${app.contentDomain}`;
  assert.equal(location.origin, origin);
  assert.match(String(location.url), new RegExp(`^${origin.replaceAll(".", "\\.")}/__porthole/d/[a-z0-9]+\\?ticket=[a-z0-9_]+$`));
  assert.equal(location.reports, true);
  assert.deepEqual(Object.keys(location).sort(), ["origin", "reports", "url", "viewer"], "nothing but Porthole's FrameLocation");
  // The least level (P087), for the runtime's `comments` (P090): no id, no name.
  assert.deepEqual(location.viewer, { level: "view" });

  // Another version of the same Artifact shares its origin; another Artifact never does.
  const second = await app.publish({ "index.html": HTML }, { artifact: published.artifact });
  assert.equal((await locate(app, second)).origin, origin);
  assert.notEqual((await locate(app, await app.publish({ "index.html": HTML }))).origin, origin);

  // Raft's manifest decides what is framed: unknown (404), another Artifact's, another kind.
  const text = await app.publish({ "notes.txt": "plain" }, { kind: "text" });
  for (const each of [
    { ...published, version: `v_${crypto.randomUUID()}` },
    { ...published, artifact: `pt_${crypto.randomUUID()}` },
    text,
  ]) {
    const refused = await app.issue(app.bodyFor(each));
    assert.equal(refused.status, 404, JSON.stringify(each));
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "not-framed");
  }
  // Raft not answering is a 503, not a 404.
  app.raft.manifestStatus = 500;
  assert.equal((await app.issue(app.bodyFor(await app.publish({ "index.html": HTML })))).status, 503);
  app.raft.manifestStatus = 0;
  // Every manifest call carried the Worker's own token; a version's manifest is asked once (immutable).
  const calls = app.raft.manifestCalls.filter((each) => each === published.version).length;
  await locate(app, published);
  assert.equal(app.raft.manifestCalls.filter((each) => each === published.version).length, calls, "cached per isolate");

  // Only the issue route answers off the content domain, and it never answers on it.
  assert.equal((await fetch(`${app.workerUrl}/`)).status, 404);
  assert.equal((await fetch(`${app.workerUrl}/porthole/frames`, { method: "POST" })).status, 404);
  const onContent = await app.contentFetch(`${origin}/_raft/frames`, {
    method: "POST",
    headers: { authorization: `Bearer ${RAFT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(app.bodyFor(published)),
  });
  assert.equal(onContent.status, 404, "the content domain is Porthole's alone");
});

test("a subject without a session family gets a 10-minute session; one with a family Porthole's hour", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const tickets = await app.mf.getD1Database("TICKETS");
  for (const [family, seconds] of [["-", 600], [FAMILY_ID, 3600]] as const) {
    await tickets.prepare("DELETE FROM porthole_tickets").run();
    const location = (await (await app.issue({ ...app.bodyFor(published), subject: `v1:${SERVER_ID}:${USER_ID}:${family}` })).json()) as { url: string };
    // The ticket carries the grant's session (Porthole's default, an hour, when the grant sets none).
    const row = (await tickets.prepare("SELECT record FROM porthole_tickets").first()) as { record: string };
    assert.equal(JSON.parse(row.record).sessionSeconds ?? 3600, seconds, family);
    // And the frame's sealed files address ends with it: the shell is told when.
    const before = Date.now();
    const body = await (await app.contentFetch(location.url, { headers: frameHeaders })).text();
    const expires = Number(/\\?"expires\\?":\s*(\d+)/.exec(body)?.[1]);
    assert.ok(expires >= before + seconds * 1000 - 5_000 && expires <= Date.now() + seconds * 1000, `${family}: ${expires - before} ms`);
  }
});

test("the issue route is rate limited per caller, before Raft is asked anything", async (t) => {
  const app = await setup(t, { RAFT_ISSUES_PER_MINUTE: "2" });
  const [first, second, third] = [await app.publish({ "index.html": HTML }), await app.publish({ "index.html": HTML }), await app.publish({ "index.html": HTML })];
  assert.equal((await app.issue(app.bodyFor(first!))).status, 201);
  assert.equal((await app.issue(app.bodyFor(second!))).status, 201);
  const limited = await app.issue(app.bodyFor(third!));
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: { code: string } }).error.code, "rate-limited");
  assert.ok(!app.raft.manifestCalls.includes(third!.version), "a caller past its budget costs Raft no manifest call");
  // A bad body counts too, and is refused as limited before it is read.
  assert.equal((await app.issue("not json")).status, 429);
});

test("a manifest Raft answers for another Artifact or version is refused, and no ticket is minted", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const tickets = await app.mf.getD1Database("TICKETS");
  const count = async () => ((await tickets.prepare("SELECT count(*) AS n FROM porthole_tickets").first()) as { n: number }).n;
  for (const rewrite of [
    (manifest: any) => ({ ...manifest, artifact: `pt_${crypto.randomUUID()}` }),
    (manifest: any) => ({ ...manifest, version: `v_${crypto.randomUUID()}` }),
    (manifest: any) => ({ ...manifest, artifact: undefined, version: undefined }),
  ]) {
    app.raft.manifestRewrite = rewrite;
    const refused = await app.issue(app.bodyFor(published));
    assert.equal(refused.status, 503, String(rewrite));
    assert.equal(await count(), 0, "no ticket");
  }
  // Nor is it served from the cache afterwards: Raft's own answer for the version frames it.
  app.raft.manifestRewrite = null;
  assert.equal((await app.issue(app.bodyFor(published))).status, 201);
  assert.equal(await count(), 1);
});

test("a manifest whose R2 keys aren't Raft's blob keys for those files is refused, and no ticket is minted", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const tickets = await app.mf.getD1Database("TICKETS");
  const count = async () => ((await tickets.prepare("SELECT count(*) AS n FROM porthole_tickets").first()) as { n: number }).n;
  const withKey = (key: (file: any) => string) => (manifest: any) => ({ ...manifest, files: manifest.files.map((file: any) => ({ ...file, key: key(file) })) });
  const blobs = `servers/${SERVER_ID}/blobs`;
  const refusals: Array<[string, (file: any) => string]> = [
    ["not a blob key", () => "artifacts/other/object"],
    ["another file's hash", () => `${blobs}/${"0".repeat(64)}/b_x`],
    ["a hash in capitals", (file) => `${blobs}/${file.sha256.toUpperCase()}/b_x`],
    ["`..` after the hash", (file) => `${blobs}/${file.sha256}/../../x`],
    ["`..` as the blob id", (file) => `${blobs}/${file.sha256}/..`],
    ["`..` before the key", (file) => `../${blobs}/${file.sha256}/b_x`],
    ["`..` out of the server", (file) => `servers/${SERVER_ID}/../${crypto.randomUUID()}/blobs/${file.sha256}/b_x`],
    ["no blob id", (file) => `${blobs}/${file.sha256}/`],
    ["a blob id with a slash", (file) => `${blobs}/${file.sha256}/b_x/y`],
    ["not a server uuid", (file) => `servers/not-a-uuid/blobs/${file.sha256}/b_x`],
    ["a leading slash", (file) => `/${blobs}/${file.sha256}/b_x`],
    ["a doubled slash", (file) => `servers//${SERVER_ID}/blobs/${file.sha256}/b_x`],
    ["a doubled slash before the blob id", (file) => `${blobs}/${file.sha256}//b_x`],
    // A full path in the platform bucket: the Worker adds Artifacts' prefix itself and never
    // takes one from Raft, so a key that already starts with `apps/` is no key.
    ["Artifacts' prefix in the key", (file) => `${ARTIFACTS_PREFIX}${blobs}/${file.sha256}/b_x`],
    ["another app's prefix", (file) => `apps/other/${blobs}/${file.sha256}/b_x`],
    ["`apps/` climbing out", (file) => `apps/artifacts/../../${blobs}/${file.sha256}/b_x`],
    ["`apps/` with a leading slash", (file) => `/${ARTIFACTS_PREFIX}${blobs}/${file.sha256}/b_x`],
  ];
  // Every key the platform refuses for any app's object (the shared cases its object storage is
  // held to), and an Artifacts key that would be too long once prefixed.
  assert.equal(keyVectors.prefix, ARTIFACTS_PREFIX);
  for (const { why, key, problem } of keyVectors.cases)
    if (problem !== null) refusals.push([`the platform's rule: ${why}`, () => key]);
  const longest = (file: any) => `${blobs}/${file.sha256}/${"b".repeat(1024 - `${ARTIFACTS_PREFIX}${blobs}/${file.sha256}/`.length)}`;
  refusals.push(["longer than 1024 bytes once prefixed", (file) => `${longest(file)}b`]);
  for (const [why, key] of refusals) {
    app.raft.manifestRewrite = withKey(key);
    const refused = await app.issue(app.bodyFor(published));
    assert.equal(refused.status, 503, why);
    assert.equal(await count(), 0, `no ticket: ${why}`);
  }
  // Keys of Raft's shape are accepted, whatever the server and blob id (each on a version of its
  // own: a version's manifest is cached once found).
  for (const [why, key] of [
    ["another server's uuid", (file: any) => `servers/${crypto.randomUUID()}/blobs/${file.sha256}/b_x`],
    ["a blob id of letters, digits, `_` and `-`", (file: any) => `${blobs}/${file.sha256}/Blob_09-z`],
    ["exactly 1024 bytes once prefixed", longest],
  ] as Array<[string, (file: any) => string]>) {
    const other = await app.publish({ "index.html": HTML });
    app.raft.manifestRewrite = withKey(key);
    assert.equal((await app.issue(app.bodyFor(other))).status, 201, why);
  }
  app.raft.manifestRewrite = null;
  const before = await count();
  assert.equal((await app.issue(app.bodyFor(published))).status, 201, "Raft's own keys are accepted");
  assert.equal(await count(), before + 1);
});

test("a file is read from R2 under Artifacts' prefix at the manifest's relative key, and only there", async (t) => {
  const app = await setup(t);
  const bucket = app.r2.objects;
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  const listed: string[] = [];
  app.raft.manifestRewrite = (manifest: any) => (listed.push(...manifest.files.map((file: any) => file.key)), manifest);
  const { served, body, base } = await open(app, published);
  assert.equal(served.status, 200, body);
  assert.ok(body.includes("Raft page"), "the page's bytes, from under the prefix");
  assert.equal(await (await app.contentFetch(`${base}style.css`)).text(), "h1{color:red}");
  // The manifest carries relative keys; the objects sit at the prefix plus those keys.
  assert.equal(listed.length, 2);
  for (const key of listed) {
    assert.match(key, new RegExp(`^servers/${SERVER_ID}/blobs/[0-9a-f]{64}/b_[0-9a-f-]+$`));
    assert.ok(bucket.has(`${ARTIFACTS_PREFIX}${key}`), `stored at ${ARTIFACTS_PREFIX}${key}`);
    assert.ok(app.r2.requests.some((read) => read.path === `/${R2_BUCKET}/${ARTIFACTS_PREFIX}${key}`), `read at ${ARTIFACTS_PREFIX}${key}`);
  }
  app.raft.manifestRewrite = null;

  // Reverse: bytes only at the relative key itself (outside the prefix) are never read.
  const css = "h1{color:blue}";
  const sha = createHash("sha256").update(css).digest("hex");
  const other = await app.publish({ "index.html": HTML, "style.css": css });
  const prefixed = [...bucket.keys()].filter((key) => key.startsWith(`${ARTIFACTS_PREFIX}servers/${SERVER_ID}/blobs/${sha}/`));
  assert.equal(prefixed.length, 1);
  bucket.set(prefixed[0]!.slice(ARTIFACTS_PREFIX.length), new TextEncoder().encode(css));
  bucket.delete(prefixed[0]!);
  const moved = await open(app, other);
  assert.equal(moved.served.status, 200, moved.body);
  assert.equal((await app.contentFetch(`${moved.base}style.css`)).status, 404, "an object outside the prefix is not read");
});

test("each read is one GetObject signed with the read-only token: /<bucket>/apps/artifacts/<key>, the endpoint's host, nothing else", async (t) => {
  const app = await setup(t);
  // Bytes of every value, larger than one chunk: streamed through whole, and a range cut from them.
  const blob = new Uint8Array(3 * 1024 * 1024 + 7).map((_, at) => (at * 31 + (at >> 11)) & 0xff);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "data.bin": blob });
  const { served, base } = await open(app, published);
  assert.equal(served.status, 200);
  const css = await app.contentFetch(`${base}style.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8", "Porthole's type for the path, not R2's");
  assert.equal(css.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(await css.text(), "h1{color:red}");
  const whole = await app.contentFetch(`${base}data.bin`);
  assert.equal(whole.status, 200);
  assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), blob, "the bytes, whole");
  const range = await app.contentFetch(`${base}data.bin`, { headers: { range: "bytes=1048570-1048585" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 1048570-1048585/${blob.byteLength}`);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), blob.slice(1048570, 1048586));

  const host = new URL(app.r2.url).host;
  assert.ok(app.r2.requests.length >= 4, "the page, the stylesheet, the file and its range");
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  for (const read of app.r2.requests) {
    assert.equal(read.answer, "200", `R2 took the signature: ${read.answer}`);
    assert.equal(read.method, "GET");
    assert.match(read.path, new RegExp(`^/${R2_BUCKET}/${ARTIFACTS_PREFIX}servers/${SERVER_ID}/blobs/[0-9a-f]{64}/b_[0-9a-f-]+$`));
    assert.equal(read.headers.host, host);
    assert.match(read.headers["x-amz-date"] ?? "", new RegExp(`^${day}T\\d{6}Z$`));
    assert.equal(read.headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.match(
      read.headers.authorization ?? "",
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${R2_READ_ACCESS_KEY_ID}/${day}/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`),
    );
    assert.ok(!JSON.stringify(read.headers).includes(R2_READ_SECRET_ACCESS_KEY), "the secret never travels");
    assert.equal(read.headers.range, undefined, "the whole object is read; Porthole cuts a range");
  }
  assert.ok(!app.logs.some((line) => line.includes(R2_READ_SECRET_ACCESS_KEY)), "nor is it logged");
});

test("R2 refusing or failing a read is Porthole's generic error, never R2's answer; NoSuchKey is a 404", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "gone.css": "x" }, { missing: ["gone.css"] });
  const { served, base } = await open(app, published);
  assert.equal(served.status, 200);
  assert.equal((await app.contentFetch(`${base}gone.css`)).status, 404, "NoSuchKey: the file is gone");
  for (const fail of [
    { status: 403, code: "AccessDenied" },
    { status: 403, code: "SignatureDoesNotMatch" },
    { status: 404, code: "NoSuchBucket" },
    { status: 500, code: "InternalError" },
    { status: 503, code: "SlowDown" },
    { status: 301, code: "PermanentRedirect" },
  ]) {
    app.r2.fail = fail;
    const before = app.logs.length;
    const response = await app.contentFetch(`${base}style.css`);
    const text = await response.text();
    assert.equal(response.status, 500, `${fail.code}: never served as the file, nor as a 404`);
    assert.ok(text.includes("<h1>Something went wrong</h1>") && text.includes('data-porthole-reason="error"'), text);
    assert.ok(!text.includes("stub detail") && !text.includes(fail.code), `${fail.code}: nothing of R2's answer`);
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("cache-control"), "no-store", "a failure is never cached as the file");
    const logged = app.logs.slice(before).filter((line) => line.includes("raft-content.r2-read-failed"));
    assert.equal(logged.length, 1, `${fail.code} logged once: ${app.logs.slice(before).join(" | ")}`);
    assert.ok(logged[0]!.includes(`"status":${fail.status}`) && logged[0]!.includes(`"code":"${fail.code}"`), logged[0]);
    assert.ok(!logged[0]!.includes("stub detail") && !logged[0]!.includes("servers/"), "status and code only: no body, no key");
  }
  app.r2.fail = null;
  assert.equal(await (await app.contentFetch(`${base}style.css`)).text(), "h1{color:red}", "served again once R2 is");
});

test("a read token R2 doesn't take (a wrong secret) serves nothing", async (t) => {
  const app = await setup(t, { R2_READ_SECRET_ACCESS_KEY: "not-the-token-s-secret-0123456789abcdef0123456789abcdef" });
  const published = await app.publish({ "index.html": HTML });
  const location = await locate(app, published);
  const page = await app.contentFetch(location.url, { headers: frameHeaders });
  const text = await page.text();
  assert.equal(page.status, 500);
  assert.ok(!text.includes("Raft page") && !text.includes("SignatureDoesNotMatch"), text);
  assert.ok(app.r2.requests.length > 0 && app.r2.requests.every((read) => read.answer === "SignatureDoesNotMatch"));
  assert.ok(app.logs.some((line) => line.includes("raft-content.r2-read-failed") && line.includes("SignatureDoesNotMatch")));
});

test("the frame's page: the sandbox and frame-ancestors in its CSP, no-store, no cookie, a ticket good once", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "app.js": "document.title='ran'", "img/dot.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
  const { location, served, body, base } = await open(app, published);
  assert.equal(served.status, 200, body);
  assert.equal(served.headers.get("content-type"), "text/html; charset=utf-8");
  const directives = directivesOf(served.headers.get("content-security-policy") ?? "");
  assert.deepEqual(directives.sandbox, ["allow-scripts", "allow-same-origin"], "the frame's own tokens (P099)");
  assert.deepEqual(directives["frame-ancestors"], [app.appOrigin], "only the Raft app may frame it");
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.ok(!directives["script-src"]!.includes("'self'"));
  assert.equal(served.headers.get("cache-control"), "no-store");
  assert.equal(served.headers.get("referrer-policy"), "no-referrer");
  // A version is a file set: its frame keeps no cookie; its files' sealed path carries the access (P083).
  assert.deepEqual(served.headers.getSetCookie(), []);
  assert.ok(base, "the frame's sealed files address");
  assert.ok(body.includes("Raft page"), "the page travels in the shell");
  const again = await app.contentFetch(location.url, { headers: frameHeaders });
  assert.equal(again.status, 401, "a ticket opens its page once");
  assert.ok(!(await again.text()).includes("Raft page"));
  // Nothing at the frame's address without a ticket; nothing on another label.
  assert.equal((await app.contentFetch(location.url.replace(/\?ticket=.*$/, ""), { headers: frameHeaders })).status, 401);
  assert.equal((await app.contentFetch(`http://w-${crypto.randomUUID()}.${app.contentDomain}/`, { headers: frameHeaders })).status, 404);
  assert.equal((await app.contentFetch(`http://a-x.${app.contentDomain}/`, { headers: frameHeaders })).status, 404);

  // Raft was asked with the version, the subject and the Worker's own token.
  const asked = app.raft.authorizeCalls.at(-1)!;
  assert.equal(asked.token, true);
  assert.deepEqual(asked.body, { artifact: published.artifact, version: published.version, subject: app.bodyFor(published).subject });
  // It names itself: Cloudflare in front of the API may refuse a request with no User-Agent (1010).
  assert.equal(asked.userAgent, "RaftContentWorker/1 (+https://raft.build)");
});

test("a ticket redeemed twice at once opens its page once", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  for (let round = 0; round < 5; round += 1) {
    const location = await locate(app, published);
    // Both redemptions in flight together: the ticket is taken by one atomic DELETE ... RETURNING.
    // Each body read as its answer arrives (see openFrame in raft-content-app-origins.test.ts).
    const answers = await Promise.all([0, 1].map(async () => {
      const answer = await app.contentFetch(location.url, { headers: frameHeaders });
      return { status: answer.status, body: await answer.text() };
    }));
    const statuses = answers.map((answer) => answer.status).sort();
    assert.deepEqual(statuses, [200, 401], `round ${round}: one page, one refusal`);
    const bodies = answers.map((answer) => answer.body);
    assert.equal(bodies.filter((body) => body.includes("Raft page")).length, 1);
  }
});

test("over https Porthole's cookies would be __Host- and HttpOnly; a file set's frame sets none", async (t) => {
  const app = await setup(t, { CONTENT_DOMAIN: "raftcontent.test" });
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  const { location, served, base } = await open(app, published);
  assert.equal(served.status, 200);
  assert.match(location.origin, /^https:\/\/w-[0-9a-f-]{36}\.raftcontent\.test$/);
  assertCookies(served, true);
  assert.deepEqual(served.headers.getSetCookie(), []);
  const file = await app.contentFetch(`${base}style.css`);
  assert.equal(file.status, 200);
  assertCookies(file, true);
  assert.deepEqual(file.headers.getSetCookie(), []);
});

test("authorize: every request asks Raft; an error, a timeout, a non-200 or anything but { allow: true } denies", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });

  const cases: { answer: typeof app.raft.authorize; status: number; code?: string }[] = [
    { answer: { status: 200, body: { allow: true } }, status: 200 },
    { answer: { status: 200, body: { allow: false, code: "signed-out" } }, status: 403, code: "signed-out" },
    { answer: { status: 200, body: { allow: false, code: "not-visible" } }, status: 403, code: "not-visible" },
    { answer: { status: 200, body: { allow: "true" } }, status: 403 },
    { answer: { status: 200, body: { allow: 1 } }, status: 403 },
    { answer: { status: 200, body: null }, status: 403 },
    { answer: { status: 201, body: { allow: true } }, status: 403, code: "unavailable" },
    { answer: { status: 500, body: { allow: true } }, status: 403, code: "unavailable" },
    { answer: { status: 302, body: { allow: true } }, status: 403, code: "unavailable" },
    { answer: "error", status: 403, code: "unavailable" },
  ];
  for (const { answer, status, code } of cases) {
    app.raft.authorize = answer;
    const { served, body } = await open(app, published);
    assert.equal(served.status, status, JSON.stringify(answer));
    if (status === 200) assert.ok(body.includes("Raft page"));
    else {
      assert.ok(!body.includes("Raft page"), "nothing of the page");
      if (code) assert.ok(body.includes(code), `${code} in ${body.slice(0, 200)}`);
    }
  }

  // A timeout (Raft never answers) denies, after RAFT_TIMEOUT_MS.
  app.raft.authorize = "timeout";
  const started = Date.now();
  const { served } = await open(app, published);
  assert.equal(served.status, 403);
  assert.ok(Date.now() - started < 15_000);

  // A deny that is the Worker's own is said in the log (#proj-workspace:#280), with nothing of the
  // Artifact, the version, the subject, the token or Raft's address; a reader Raft refused is no such line.
  const unanswered = () => app.logs.filter((line) => line.includes("raft-content.authorize-unanswered")).map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { evt: string; why: string });
  const first = unanswered();
  assert.deepEqual(first.map((said) => Object.keys(said).sort().join(",")), first.map(() => "evt,why"));
  const errors = first.map((said) => said.why).filter((why) => why.startsWith("error:"));
  assert.equal(errors.length, 1, "the failed call, by its error's class");
  assert.match(errors[0]!, /^error:[A-Za-z0-9_]{1,40}$/);
  assert.deepEqual(first.map((said) => said.why).filter((why) => !why.startsWith("error:")).sort(), ["status:201", "status:302", "status:500", "timeout"]);
  // At most one line a minute for each way: the same status again denies again and logs nothing more.
  app.raft.authorize = { status: 500, body: { allow: true } };
  assert.equal((await open(app, published)).served.status, 403);
  assert.equal((await open(app, published)).served.status, 403);
  assert.equal(unanswered().length, first.length, "no second line for status:500 within the minute");
  for (const secret of [published.artifact, published.version, "v1:", RAFT_TOKEN, WORKER_TOKEN, app.raft.url]) {
    assert.ok(!app.logs.some((line) => line.includes("authorize-unanswered") && line.includes(secret)), "never an id, the subject, the token or Raft's address");
  }

  // An answer is reused for 30 s for the same session; a revocation reaches a new frame at once.
  app.raft.authorize = { status: 200, body: { allow: true } };
  const allowed = await open(app, published);
  assert.equal(allowed.served.status, 200);
  const before = app.raft.authorizeCalls.length;
  assert.equal((await app.contentFetch(`${allowed.base}style.css`)).status, 200);
  assert.equal(app.raft.authorizeCalls.length, before, "cached for the session");
  app.raft.authorize = { status: 200, body: { allow: false, code: "deleted" } };
  assert.equal((await open(app, published)).served.status, 403);
});

test("a multi-file HTML version loads its files from the sealed path; an s3 or missing file is a 404", async (t) => {
  const app = await setup(t);
  const published = await app.publish(
    {
      "index.html": HTML,
      "style.css": "h1{color:red}",
      "app.js": "document.title='ran'",
      "img/dot.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "docs/more.html": "<!doctype html><p>More</p>",
      "data.json": '{"a":1}',
      "attachment.pdf": "%PDF-1.4 stored in s3",
      "gone.png": "png bytes",
    },
    { servable: ["index.html", "style.css", "app.js", "img/dot.svg", "docs/more.html", "data.json", "gone.png"], missing: ["gone.png"] },
  );
  const { base } = await open(app, published);
  assert.ok(base);
  const expect: Record<string, [number, string | null]> = {
    "style.css": [200, "text/css; charset=utf-8"],
    "app.js": [200, "text/javascript; charset=utf-8"],
    "img/dot.svg": [200, "image/svg+xml"],
    "docs/more.html": [200, "text/html; charset=utf-8"],
    "data.json": [200, "application/json; charset=utf-8"],
    // An `s3` file (an attachment saved as an Artifact) isn't in Raft's manifest: a 404 until S5.
    "attachment.pdf": [404, null],
    // Listed, but its bytes aren't in R2.
    "gone.png": [404, null],
    "nothing.txt": [404, null],
  };
  for (const [path, [status, type]] of Object.entries(expect)) {
    const response = await app.contentFetch(`${base}${path}`);
    assert.equal(response.status, status, path);
    if (type) assert.equal(response.headers.get("content-type"), type, path);
    if (status === 200) assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(await (await app.contentFetch(`${base}style.css`)).text(), "h1{color:red}", "the bytes from R2 by key");
  const page = await app.contentFetch(`${base}docs/more.html`);
  assert.deepEqual(directivesOf(page.headers.get("content-security-policy") ?? "").sandbox, ["allow-scripts", "allow-same-origin"]);
  assert.ok((await page.text()).includes("More"));
  // A sealed path is this origin's only.
  const other = await app.publish({ "index.html": HTML });
  const foreign = base!.replace(/w-[0-9a-f-]{36}/, `w-${other.artifact.slice(3)}`);
  assert.equal((await app.contentFetch(`${foreign}style.css`)).status, 401);
});

test("Markdown renders with the Worker's renderer, beside its source", async (t) => {
  const app = await setup(t);
  const published = await app.publish(
    { "notes.md": "# Release notes\n\nSome *text* and ![chart](chart.svg).\n\n```mermaid\ngraph TD; A-->B\n```", "chart.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" },
    { kind: "markdown", entry: "notes.md", title: "Notes" },
  );
  const { served, body, base } = await open(app, published);
  assert.equal(served.status, 200);
  // The page travels in the shell's plan, as a JSON string.
  const page = body.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replaceAll('\\"', '"');
  assert.ok(page.includes("Release notes"), body.slice(0, 300));
  assert.match(page, /<h1 id="release-notes"/, "headings get ids (the renderer)");
  assert.ok(page.includes("<em>text</em>"));
  const source = await app.contentFetch(`${base}notes.md`);
  assert.equal(source.status, 200);
  assert.equal(source.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal((await app.contentFetch(`${base}chart.svg`)).status, 200);
});

test("a Markdown page sets its text in Raft's fonts, served beside it from its own origin under the frame's CSP as it was", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "docs/notes.md": "# 发布说明\n\n这个版本的字体从 Artifact 自己的源加载。" }, { kind: "markdown", entry: "docs/notes.md", title: "Notes" });
  const { location, served, body, base } = await open(app, published);
  assert.equal(served.status, 200, body);
  const page = body.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replaceAll('\\"', '"');
  assert.ok(page.includes('<html lang="zh-CN">'), "lang from the words");
  assert.ok(page.includes("src: url(./../_raft-fonts/space-grotesk-latin.woff2) format('woff2')"), "a face by a path relative to the page");
  assert.ok(page.includes("var(--sans-font)"));
  // font-src as Porthole serves every page with files: its origin's sealed files path (where the
  // fonts are), never 'self'; the same as an HTML page's, so nothing in it is new for the fonts.
  const fontSrc = directivesOf(served.headers.get("content-security-policy") ?? "")["font-src"]!;
  const sealed = `${location.origin}/__porthole/f/`;
  assert.ok(fontSrc.includes(sealed) && base!.startsWith(sealed), fontSrc.join(" "));
  assert.ok(!fontSrc.includes("'self'"));
  const html = await open(app, await app.publish({ "index.html": HTML }));
  const htmlFontSrc = directivesOf(html.served.headers.get("content-security-policy") ?? "")["font-src"]!;
  assert.deepEqual(fontSrc, htmlFontSrc.map((source) => source.replace(html.location.origin, location.origin)), "an HTML page's font-src");
  for (const { file, sha256 } of MARKDOWN_FONT_FACES) {
    const font = await app.contentFetch(`${base}_raft-fonts/${file}`);
    assert.equal(font.status, 200, file);
    assert.equal(font.headers.get("content-type"), "font/woff2", file);
    assert.equal(font.headers.get("cache-control"), "private, max-age=31536000, immutable", file);
    assert.equal(font.headers.get("etag"), `"${sha256}"`, file);
    assert.equal(font.headers.get("x-content-type-options"), "nosniff", file);
    assert.equal(font.headers.get("cross-origin-resource-policy"), "same-origin", file);
    assert.deepEqual(new Uint8Array(await font.arrayBuffer()), new Uint8Array(await readFile(`src/fonts/${file}`)), file);
  }
  for (const path of ["_raft-fonts/nope.woff2", "_raft-fonts/space-grotesk-vietnamese.woff2", "_raft-fonts/spacegrotesk-OFL.txt", "docs/_raft-fonts/space-grotesk-latin.woff2"])
    assert.equal((await app.contentFetch(`${base}${path}`)).status, 404, path);
  // Behind the sealed path like every file of the version: not at the origin's root.
  assert.notEqual((await app.contentFetch(`${location.origin}/_raft-fonts/space-grotesk-latin.woff2`)).status, 200);
});

test("only a Markdown version carries the fonts; an HTML page's paths stay its own", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "_raft-fonts/space-grotesk-latin.woff2": "the version's own" });
  const { base } = await open(app, published);
  assert.equal(await (await app.contentFetch(`${base}_raft-fonts/space-grotesk-latin.woff2`)).text(), "the version's own");
  assert.equal((await app.contentFetch(`${base}_raft-fonts/space-mono-latin-400.woff2`)).status, 404);
});

test("a PDF opens in the viewer page, with pdf.js served from the version's own path", async (t) => {
  const app = await setup(t);
  const pdf = samplePdf(["One", "Two"]);
  const published = await app.publish({ "reports/q3 summary.pdf": pdf }, { kind: "pdf", entry: "reports/q3 summary.pdf", title: "Q3 <summary>" });
  const { served, body, base } = await open(app, published);
  assert.equal(served.status, 200);
  assert.deepEqual(directivesOf(served.headers.get("content-security-policy") ?? "").sandbox, ["allow-scripts", "allow-same-origin"]);
  assert.ok(body.includes("../_raft-pdf/pdf.min.mjs"), "the library, by a relative path from the entry's directory");
  assert.ok(body.includes("./q3%20summary.pdf"));
  assert.ok(body.includes("Q3 &lt;summary&gt;") && !body.includes("Q3 <summary>"), "the title escaped");
  const file = await app.contentFetch(`${base}reports/q3%20summary.pdf`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "application/pdf");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), pdf);
  const library = await app.contentFetch(`${base}_raft-pdf/pdf.min.mjs`);
  assert.equal(library.status, 200);
  assert.equal(library.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await library.text(), await readFile("node_modules/pdfjs-dist/build/pdf.min.mjs", "utf8"));
  for (const path of ["_raft-pdf/pdf.worker.min.mjs", "_raft-pdf/cmaps/UniGB-UCS2-H.bcmap", "_raft-pdf/standard_fonts/FoxitSerif.pfb", "_raft-pdf/wasm/openjpeg.wasm"])
    assert.equal((await app.contentFetch(`${base}${path}`)).status, 200, path);
  // PDF scripting never ships.
  assert.equal((await app.contentFetch(`${base}_raft-pdf/wasm/quickjs-eval.wasm`)).status, 404);
});

test("a PDF's viewer page lays the text over each page itself, under the CSP an HTML page has", async (t) => {
  const app = await setup(t);
  const pdf = await open(app, await app.publish({ "report.pdf": samplePdf(["One"]) }, { kind: "pdf", entry: "report.pdf" }));
  const html = await open(app, await app.publish({ "index.html": "<!doctype html><p>a page</p>" }));
  // The viewer page as the shell carries it: a JSON string of the frame's document.
  const carried = (pdf.body.match(/"(?:[^"\\]|\\.)*"/g) ?? []).find((each) => each.includes("pdfjs.TextLayer"));
  assert.ok(carried, "the shell carries the viewer page");
  const viewer = JSON.parse(carried) as string;
  assert.ok(viewer.startsWith("<!doctype html>") && viewer.includes("Loading the PDF"), "the viewer page whole");
  // Nothing the viewer names is on another origin: no absolute address, no style sheet, import or url().
  assert.deepEqual(viewer.match(/https?:\/\/[^\s"'`)]+/g) ?? [], [], "no absolute address in the viewer page");
  assert.equal(/<link\b|@import|url\(/.test(viewer), false, "no style sheet, import or url() in the viewer page");
  // The same policy as any page of that kind of frame: only the per-response parts (a nonce, the Artifact's own origin) differ.
  const policy = (opened: typeof pdf) =>
    (opened.served.headers.get("content-security-policy") ?? "")
      .replaceAll(opened.location.origin, "<origin>")
      .replace(/'nonce-[^']+'/g, "'nonce'")
      .replace(/'sha256-[^']+'/g, "'sha256'");
  assert.notEqual(policy(pdf), "");
  assert.deepEqual(directivesOf(policy(pdf)), directivesOf(policy(html)), "the viewer page's CSP is an HTML page's");
});

test("the made pages and pdf.js win over a version's own files at their paths", async (t) => {
  const app = await setup(t);
  // A PDF version that carries its own viewer page and its own "pdf.js".
  const pdf = await app.publish(
    { "report.pdf": samplePdf(["One"]), "report.pdf.html": "<!doctype html><p>VERSION OWN VIEWER</p>", "_raft-pdf/pdf.min.mjs": "window.versionOwnPdfjs = 1;" },
    { kind: "pdf", entry: "report.pdf" },
  );
  const opened = await open(app, pdf);
  assert.equal(opened.served.status, 200);
  assert.ok(opened.body.includes("_raft-pdf/pdf.min.mjs") && !opened.body.includes("VERSION OWN VIEWER"), "the viewer page, not the version's");
  const viewer = await app.contentFetch(`${opened.base}report.pdf.html`);
  assert.ok(!(await viewer.text()).includes("VERSION OWN VIEWER"));
  const library = await app.contentFetch(`${opened.base}_raft-pdf/pdf.min.mjs`);
  assert.equal(await library.text(), await readFile("node_modules/pdfjs-dist/build/pdf.min.mjs", "utf8"), "the pinned pdf.js bytes");

  // A Markdown version that carries its own `<entry>.html`: the entry is still the rendered page.
  const markdown = await app.publish(
    { "notes.md": "# Rendered heading", "notes.md.html": "<!doctype html><p>VERSION OWN PAGE</p>", "_raft-fonts/space-grotesk-latin.woff2": "VERSION OWN FONT" },
    { kind: "markdown", entry: "notes.md" },
  );
  const page = await open(app, markdown);
  assert.equal(page.served.status, 200);
  assert.equal(page.served.headers.get("content-type"), "text/html; charset=utf-8", "a page in the shell, never the raw .md");
  assert.ok(page.body.includes("Rendered heading") && !page.body.includes("VERSION OWN PAGE"));
  assert.ok(!(await (await app.contentFetch(`${page.base}notes.md.html`)).text()).includes("VERSION OWN PAGE"));
  const font = await app.contentFetch(`${page.base}_raft-fonts/space-grotesk-latin.woff2`);
  assert.deepEqual(new Uint8Array(await font.arrayBuffer()), new Uint8Array(await readFile("src/fonts/space-grotesk-latin.woff2")), "Raft's font, not the version's");
});

test("pdf.js's served files are the pinned pdfjs-dist's (scripts/pdfjs-assets.ts)", async () => {
  assert.equal(await readFile("src/services/pdfjsAssets.ts", "utf8"), await pdfjsAssetsSource(), "run pnpm run generate:pdfjs-assets");
});

test("the bundled pdf.js evaluates no strings as code (no eval, no Function constructor)", async () => {
  // pdf.js 6.4 has no isEvalSupported option any more: it never compiles fonts to code. Pin that
  // property of the files the viewer serves, so an upgrade that brings it back fails here.
  for (const file of ["node_modules/pdfjs-dist/build/pdf.min.mjs", "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"]) {
    const source = await readFile(file, "utf8");
    assert.ok(!/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/.test(source), `${file} evaluates strings as code`);
  }
});

test("settings that can't be served fail closed", async (t) => {
  for (const [bindings, problem] of [
    [{ PORTHOLE_SECRET: "short" }, "PORTHOLE_SECRET"],
    [{ CONTENT_DOMAIN: "" }, "CONTENT_DOMAIN"],
    [{ RAFT_API_URL: "http://raft.example" }, "RAFT_API_URL"],
    [{ RAFT_API_TOKEN: "" }, "RAFT_API_TOKEN"],
    // No way to read R2 with the read-only token: nothing is served, rather than anything else.
    [{ R2_ENDPOINT: "" }, "R2_ENDPOINT"],
    [{ R2_ENDPOINT: "http://r2.example" }, "R2_ENDPOINT"],
    [{ R2_ENDPOINT: "https://r2.example/a-bucket" }, "R2_ENDPOINT"],
    [{ R2_BUCKET: "" }, "R2_BUCKET"],
    [{ R2_BUCKET: "Not_A_Bucket" }, "R2_BUCKET"],
    [{ R2_READ_ACCESS_KEY_ID: "" }, "R2_READ_ACCESS_KEY_ID"],
    [{ R2_READ_SECRET_ACCESS_KEY: " " }, "R2_READ_SECRET_ACCESS_KEY"],
  ] as const) {
    const app = await setup(t, bindings);
    const published = await app.publish({ "index.html": HTML });
    const issued = await app.issue(app.bodyFor(published));
    assert.equal(issued.status, 503, problem);
    assert.ok(!(await issued.text()).includes(problem), "the reason stays in the log");
    if (problem !== "CONTENT_DOMAIN") {
      // The visitor gets a generic 503, the same whatever is wrong; the reason is in the log only.
      const page = await app.contentFetch(`http://w-${published.artifact.slice(3)}.${app.contentDomain}/`);
      assert.equal(page.status, 503, problem);
      assert.equal(await page.text(), "Content is unavailable.", problem);
      assert.equal(page.headers.get("cache-control"), "no-store");
      assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.ok(app.logs.some((line) => line.includes("misconfigured") && line.includes(problem)), `${problem} logged: ${app.logs.join(" | ")}`);
    }
    assert.equal(app.r2.requests.length, 0, `${problem}: R2 is never asked`);
    assert.ok(!app.logs.some((line) => line.includes(R2_READ_SECRET_ACCESS_KEY)), "a secret is never logged");
  }
  // No RAFT_TOKENS: nobody may ask.
  const app = await setup(t, { RAFT_TOKENS: "" });
  assert.equal((await app.issue(app.bodyFor(await app.publish({ "index.html": HTML })))).status, 401);
});
