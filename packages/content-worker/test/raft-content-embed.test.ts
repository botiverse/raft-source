import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  EMBED_AUTHORIZE_TTL_SECONDS,
  EMBED_LIVE_POLL_SECONDS,
  EMBED_TAKEDOWN_BOUND_SECONDS,
  EMBEDDABLE_TTL_SECONDS,
  embedderOf,
} from "../src/services/embed";
import { signTicket, startRaftContent, type Published, type RaftContentApp } from "./raftContentHarness";

/**
 * Public Artifacts embedded on any site (Porthole P143; src/services/embed.ts and
 * raftContentService.ts `embedHost`, `openEmbed`). The bounds Tenny set:
 * - only a public, current Artifact of a framed kind embeds (Raft's answer); every other case,
 *   and every malformed id, is the one 404, byte for byte, on the embed host and on `/_raft/embed`;
 * - `/_raft/open` and the door never answer `frame-ancestors *`, and never mint an embed session;
 * - EMBEDS off (the kill switch): the embed host and `/_raft/embed` are the one 404, Raft unasked;
 * - a member's session on the same Artifact is unchanged while an embed session exists;
 * - past a budget (per Artifact, per embedding site, per viewer) the embed is Porthole's embed
 *   status page (429), never a 5xx;
 * - the embedder is logged by its registrable domain alone.
 */

/** raftContentService.ts's budgets (the service imports pdf.js's assets as modules: not loadable in Node). */
const EMBEDS_PER_ARTIFACT_PER_MINUTE = 600;
const EMBEDS_PER_SITE_PER_MINUTE = 1_200;
const EMBEDS_PER_VIEWER_PER_MINUTE = 120;

const HTML = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1>Embedded page</h1></body></html>`;
/** What a browser sends for the outer page's frame of `/_raft/embed` (the embed host is the content domain's site). */
const embedFrameHeaders = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" };
const frameHeaders = { "sec-fetch-dest": "iframe" };

async function setup(t: test.TestContext, options: { embeds?: boolean; bindings?: Record<string, string> } = { embeds: true }) {
  const app = await startRaftContent(options);
  t.after(() => app.close());
  return app;
}

const frameAncestorsOf = (response: Response): string =>
  /frame-ancestors ([^;]+)/.exec(response.headers.get("content-security-policy") ?? "")?.[1]?.trim() ?? "";

/** The sealed files address a served document carries. */
const baseOf = (app: RaftContentApp, published: Published, body: string): string | null =>
  new RegExp(`${app.originOf(published).replaceAll(".", "\\.")}/__porthole/f/[A-Za-z0-9_-]+/`).exec(body)?.[0] ?? null;

/** Status, headers (but `date`) and body: what must be the same for every hidden case. */
async function shapeOf(response: Response) {
  const headers = [...response.headers].filter(([name]) => name !== "date").sort(([a], [b]) => a.localeCompare(b));
  return { status: response.status, headers, body: await response.text() };
}

async function openEmbedSession(app: RaftContentApp, published: Published, headers: Record<string, string> = embedFrameHeaders) {
  const served = await app.contentFetch(app.embedOpenUrl(published), { headers });
  const body = await served.text();
  return { served, body, base: baseOf(app, published, body) };
}

test("the outer page of a public, current Artifact: Raft's code only, framed by any page, framing its own label alone, no cookie", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  app.embedPublic(published, { title: `Q3 <script>alert("x")</script> & 'more'` });
  const page = await app.contentFetch(app.embedUrl(published.artifact), { headers: { referer: "https://www.blog.example.co.uk/posts/1?utm=secret" } });
  const body = await page.text();
  assert.equal(page.status, 200, body.slice(0, 300));
  const origin = app.originOf(published);
  assert.equal(
    page.headers.get("content-security-policy"),
    `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src ${origin}; base-uri 'none'; form-action 'none'; frame-ancestors *`,
  );
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(page.headers.get("permissions-policy") ?? "", /camera=\(\).*geolocation=\(\).*microphone=\(\)/);
  assert.equal(page.headers.get("cache-control"), "no-cache", "the browser keeps nothing: the takedown bound is the isolate's cache alone");
  assert.equal(page.headers.get("x-frame-options"), null);
  assert.deepEqual(page.headers.getSetCookie(), []);
  // The content frame is the label's own embed route; the title only as escaped text.
  assert.ok(body.includes(`src="${origin}/_raft/embed"`), body);
  assert.ok(body.includes(`sandbox="allow-scripts allow-same-origin"`));
  assert.ok(!body.includes("<script>alert"), "the title is never markup");
  assert.ok(body.includes("Q3 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;more&#39;"));
  assert.ok(body.includes(`href="${app.appOrigin}/artifacts/${published.artifact}" target="_blank" rel="noopener noreferrer">Open in Raft</a>`), "Open in Raft");
  // The Raft logo, inline, linked to Raft's website; no bare "Raft" word for a mark.
  assert.match(body, /<a class="brand" href="https:\/\/raft\.build" target="_blank" rel="noopener noreferrer" aria-label="Raft"><svg class="logo"/);
  assert.ok(!body.includes(`class="mark"`));
  assert.ok(body.includes(`<p class="gone" role="status" hidden>`) && body.includes(`class="title" dir="auto"`));
  assert.match(body, /<html lang="en">/);
  assert.ok(!body.includes("addEventListener(\"message\"") && !body.includes("onmessage"), "no message listener");
  // Its script and style, from itself.
  const script = await app.contentFetch(`http://${app.embedDomain}/_embed/embed.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/);
  const code = await script.text();
  assert.ok(!code.includes("message"), "the script listens to no message");
  assert.ok(code.includes(`setInterval(check, ${EMBED_LIVE_POLL_SECONDS * 1_000})`) && code.includes("visibilitychange") && code.includes("clearInterval"), "polls while visible, stops while hidden");
  // Still public: the liveness answer, never kept by the browser either.
  const live = await app.contentFetch(`${app.embedUrl(published.artifact)}/live`);
  assert.equal(live.status, 204);
  assert.equal(live.headers.get("cache-control"), "no-cache");
  // Logged with the embedder's registrable domain only: no path, query or address.
  const views = app.logs.filter((line) => line.includes("raft-content.embed-view"));
  assert.equal(views.length, 1);
  assert.deepEqual(JSON.parse(views[0]!), { evt: "raft-content.embed-view", artifact: published.artifact, kind: "html", embedder: "example.co.uk" });
  assert.ok(!app.logs.some((line) => line.includes("utm=secret") || line.includes("/posts/1") || line.includes("www.blog")));
});

test("the outer page follows Raft's design system: Space Grotesk from the embed host itself, Raft's tokens light and dark, 44 px targets on touch, the focus ring", async (t) => {
  const app = await setup(t);
  const css = await (await app.contentFetch(`http://${app.embedDomain}/_embed/embed.css`)).text();
  assert.match(css, /font-family:'Space Grotesk'.*src:url\(\/_embed\/fonts\/space-grotesk-latin\.woff2\) format\('woff2'\)/);
  assert.match(css, /--sans-font:\s*"Space Grotesk", Arial/);
  assert.match(css, /font:400 13px\/18px var\(--sans-font\)/);
  assert.ok(!/system-ui,-apple-system|#0969da|#f6f8fa|#0d1117/.test(css), "no system-ui-first stack, no Primer colours");
  // raft-ui foundation.css: foreground, foreground-link, layer-canvas (light only for now).
  for (const token of ["--foreground:oklch(0.1813 0.005 17.62)", "--foreground-link:oklch(0.4327 0.1282 256.54)", "--layer-canvas:oklch(1 0 0)", "color-scheme:light;"])
    assert.ok(css.includes(token), token);
  assert.doesNotMatch(css, /prefers-color-scheme/); // light only, as the embedded page is (follow-up: both follow the visitor)
  assert.match(css, /\.bar a:focus-visible\{box-shadow:var\(--focus-ring\)\}/);
  assert.match(css, /@media \(pointer:coarse\)\{\.bar a\{min-height:44px;min-width:44px\}/);
  // The fonts, the Markdown page's own bytes, from the embed host; nothing else under /_embed/fonts/.
  const font = await app.contentFetch(`http://${app.embedDomain}/_embed/fonts/space-grotesk-latin.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.ok(Buffer.from(await font.arrayBuffer()).equals(readFileSync(new URL("../src/fonts/space-grotesk-latin.woff2", import.meta.url))));
  for (const other of ["space-mono-latin-400.woff2", "nope.woff2", "x/space-grotesk-latin.woff2"])
    assert.equal((await app.contentFetch(`http://${app.embedDomain}/_embed/fonts/${other}`)).status, 404, other);
  // A CJK title: the page's lang follows it, so the CJK font stack picks the right glyphs.
  const published = await app.publish({ "index.html": HTML });
  app.embedPublic(published, { title: "季度报告：设计系统的更新" });
  assert.match(await (await app.contentFetch(app.embedUrl(published.artifact))).text(), /<html lang="zh-CN">/);
});

test("each chain of caches sums to the 30 s takedown bound", () => {
  assert.equal(EMBED_TAKEDOWN_BOUND_SECONDS, 30);
  // The outer page and /live: the browser keeps nothing (`no-cache`, tested above), the isolate EMBEDDABLE_TTL_SECONDS.
  assert.ok(0 + EMBEDDABLE_TTL_SECONDS <= EMBED_TAKEDOWN_BOUND_SECONDS);
  // An embed session's requests: Porthole's per-session copy dies with its memo (raft-content-embed-bound.test.ts).
  assert.ok(EMBED_AUTHORIZE_TTL_SECONDS <= EMBED_TAKEDOWN_BOUND_SECONDS);
  assert.ok(EMBED_LIVE_POLL_SECONDS <= EMBED_TAKEDOWN_BOUND_SECONDS);
});

test("every Artifact that doesn't embed is the one 404, the same bytes on the embed host and on /_raft/embed; a malformed id never reaches Raft", async (t) => {
  const app = await setup(t);
  const hidden = await app.publish({ "index.html": HTML }); // private, server-only, taken down, not current, unframed: Raft says 404
  const ghost: Published = { artifact: `pt_${randomUUID()}`, version: `v_${randomUUID()}`, number: 1 }; // nonexistent
  const shapes = [];
  for (const artifact of [hidden.artifact, ghost.artifact]) shapes.push(await shapeOf(await app.contentFetch(app.embedUrl(artifact))));
  for (const artifact of [hidden.artifact, ghost.artifact]) shapes.push(await shapeOf(await app.contentFetch(`${app.embedUrl(artifact)}/live`)));
  for (const published of [hidden, ghost]) shapes.push(await shapeOf(await app.contentFetch(app.embedOpenUrl(published), { headers: embedFrameHeaders })));
  const malformed = ["pt_nope", `pt_${randomUUID().toUpperCase()}`, `${hidden.artifact}x`, "", "index.html", `${hidden.artifact}/other`, "_embed/nothing.js"];
  for (const path of malformed) shapes.push(await shapeOf(await app.contentFetch(app.embedUrl(path))));
  // A method the routes don't take.
  shapes.push(await shapeOf(await app.contentFetch(app.embedUrl(hidden.artifact), { method: "POST", body: "x" })));
  const [first, ...rest] = shapes;
  assert.equal(first!.status, 404);
  assert.match(first!.body, /data-porthole-reason="not-found"/);
  assert.match(first!.body, /data-porthole-hosts="\[\]"/);
  assert.equal(first!.headers.find(([name]) => name === "cache-control")?.[1], "no-store");
  assert.match(first!.headers.find(([name]) => name === "content-security-policy")?.[1] ?? "", /frame-ancestors \*$/);
  for (const [index, shape] of rest.entries()) assert.deepEqual(shape, first, `case ${index + 1}`);
  assert.deepEqual([...new Set(app.raft.embedCalls)].sort(), [hidden.artifact, ghost.artifact].sort(), "only well-formed ids were asked about");
  assert.equal(app.raft.authorizeCalls.length, 0);
  assert.equal(app.raft.manifestCalls.length, 0);
});

test("Raft's yes is reused 30 s and its no 10 s per isolate; a Raft that can't answer is a 503 page, never cached, never a 404", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  app.embedPublic(published);
  for (let i = 0; i < 3; i += 1) assert.equal((await app.contentFetch(app.embedUrl(published.artifact))).status, 200);
  assert.equal(app.raft.embedCalls.length, 1, "one question for three loads");
  const down = await app.publish({ "index.html": HTML });
  app.raft.embedStatus = 500;
  const unavailable = await app.contentFetch(app.embedUrl(down.artifact));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.equal(frameAncestorsOf(unavailable), "*");
  app.raft.embedStatus = 0;
  app.embedPublic(down);
  assert.equal((await app.contentFetch(app.embedUrl(down.artifact))).status, 200, "a failure isn't cached");
  // An answer that isn't one (another Artifact, a kind that isn't framed): never served.
  const odd = await app.publish({ "index.html": HTML });
  app.raft.embeddable.set(odd.artifact, { artifact: odd.artifact, version: odd.version, kind: "image", title: "x" });
  assert.equal((await app.contentFetch(app.embedUrl(odd.artifact))).status, 503);
});

test("/_raft/embed opens an embed session of the label's own current version: anonymous with `embed`, any ancestor, no host, no door, nothing in D1", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  app.embedPublic(published);
  const { served, body, base } = await openEmbedSession(app, published);
  assert.equal(served.status, 200, body.slice(0, 300));
  assert.ok(body.includes("Embedded page"));
  assert.equal(frameAncestorsOf(served), "*");
  assert.ok(body.includes(`"origins":[]`), "its plan names no host");
  assert.ok(!body.includes("__porthole/door/"), "no door");
  assert.ok(base, "a sealed files address");
  assert.ok(served.headers.getSetCookie().every((cookie) => cookie.startsWith("__Host-porthole-e-") && !/domain=/i.test(cookie)), "a cookie, if any, is the embed session's own, host-only");
  // Raft decided for the embed subject of this very version.
  assert.deepEqual(app.raft.authorizeCalls.map((call) => call.body), [{ artifact: published.artifact, version: published.version, subject: `v1:embed:${published.artifact}:${published.version}` }]);
  const style = await app.contentFetch(`${base}style.css`);
  assert.equal(style.status, 200);
  assert.equal(frameAncestorsOf(style), "*");
  // No ticket, opened or minted, in D1.
  const db = await app.mf.getD1Database("TICKETS");
  assert.equal(((await db.prepare("SELECT count(*) AS n FROM porthole_tickets").first()) as { n: number }).n, 0);
  // A second viewer's session: Raft's answer for the embed subject is reused, not asked again.
  assert.equal((await openEmbedSession(app, published)).served.status, 200);
  assert.equal(app.raft.authorizeCalls.length, 1);
});

test("/_raft/embed refuses a foreign page's request and reads nothing but its own label", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const other = await app.publish({ "index.html": HTML });
  app.embedPublic(other);
  const notFound = await shapeOf(await app.contentFetch(app.embedUrl(published.artifact)));
  for (const site of ["cross-site", "same-origin", "none"]) {
    const refused = await openEmbedSession(app, other, { ...frameHeaders, "sec-fetch-site": site });
    assert.equal(refused.served.status, 404, site);
    assert.equal(refused.body, notFound.body, site);
  }
  // No Fetch Metadata at all (an old browser): served.
  assert.equal((await openEmbedSession(app, other, frameHeaders)).served.status, 200);
  // The label decides; nothing in the request names another Artifact.
  const asked = app.raft.embedCalls.length;
  const elsewhere = await app.contentFetch(`${app.embedOpenUrl(published)}?artifact=${other.artifact}&version=${other.version}`, { headers: embedFrameHeaders });
  assert.equal(elsewhere.status, 404);
  assert.ok(!app.raft.embedCalls.slice(asked).includes(other.artifact), "the query names nothing");
  // Only GET.
  assert.equal((await app.contentFetch(app.embedOpenUrl(other), { method: "HEAD", headers: embedFrameHeaders })).status, 404);
});

test("Raft's deny ends an embed session's access, and the denial page is the embed's (any ancestor)", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  app.embedPublic(published);
  app.raft.authorize = { status: 200, body: { allow: false, code: "not-public" } };
  const { served, body } = await openEmbedSession(app, published);
  assert.equal(served.status, 403, body.slice(0, 200));
  assert.ok(!body.includes("Embedded page"));
  assert.equal(frameAncestorsOf(served), "*");
});

test("/_raft/open and the door never answer `frame-ancestors *` and never open an embed session, with embeds on", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{}" });
  app.embedPublic(published);
  const anonymous = app.anonymousBodyFor(published);
  const tickets = {
    reader: app.claimsFor(published),
    visitor: app.claimsFor(published, { viewer: anonymous.viewer, subject: anonymous.subject }),
    check: app.claimsFor(published, { viewer: "system:check", subject: `v1:check:${published.artifact}:${published.version}` }),
  };
  const readersOnly = (response: Response, who: string) => {
    const ancestors = frameAncestorsOf(response);
    assert.ok(!ancestors.includes("*") && ancestors.split(/\s+/).includes(app.appOrigin), `${who}: ${ancestors}`);
  };
  for (const [who, claims] of Object.entries(tickets)) {
    const headers = who === "check" ? { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" } : frameHeaders;
    const served = await app.contentFetch(app.openUrl(published, signTicket(claims)), { headers });
    const body = await served.text();
    assert.equal(served.status, 200, `${who}: ${body.slice(0, 200)}`);
    readersOnly(served, who);
    assert.ok(served.headers.getSetCookie().every((cookie) => !cookie.includes("porthole-e-")), who);
    const base = baseOf(app, published, body);
    if (base) readersOnly(await app.contentFetch(`${base}style.css`), `${who}'s files`);
  }
  for (const who of ["reader", "visitor"] as const) {
    const overrides = who === "visitor" ? { viewer: anonymous.viewer, subject: anonymous.subject } : {};
    const door = await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { ...overrides, door: true }))), { headers: frameHeaders });
    assert.equal(door.status, 200, who);
    readersOnly(door, `${who}'s door`);
  }
  // A ticket naming an embed subject (Raft's server never signs one) is refused at both.
  const embedSubject = `v1:embed:${published.artifact}:${published.version}`;
  for (const viewer of ["anonymous", "embed"]) {
    const claims = app.claimsFor(published, { viewer, subject: embedSubject });
    assert.equal((await app.contentFetch(app.openUrl(published, signTicket(claims)), { headers: frameHeaders })).status, 401, viewer);
    const doorClaims = app.claimsFor(published, { viewer, subject: embedSubject, door: true });
    assert.equal((await app.contentFetch(app.doorUrl(published, signTicket(doorClaims)), { headers: frameHeaders })).status, 401, viewer);
  }
  // Nor does the legacy issue route take one.
  assert.equal((await app.issue({ ...anonymous, subject: embedSubject })).status, 400);
});

test("a member's session on the same Artifact is unchanged while an embed session of it exists", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  app.embedPublic(published);
  const reader = await app.contentFetch(app.openUrl(published, signTicket(app.claimsFor(published))), { headers: frameHeaders });
  const readerBody = await reader.text();
  const readerBase = baseOf(app, published, readerBody)!;
  assert.ok(readerBase);
  const before = await app.contentFetch(`${readerBase}style.css`);
  assert.ok(readerBody.includes(`"origins":["${app.appOrigin}"]`), "the reader's plan names the app");

  const embed = await openEmbedSession(app, published);
  assert.equal(embed.served.status, 200);
  assert.ok(embed.base && embed.base !== readerBase, "a session of its own");

  // The reader's session, while the embed session exists: the reader's answers, as before.
  const after = await app.contentFetch(`${readerBase}style.css`);
  assert.equal(after.status, 200);
  assert.ok(!frameAncestorsOf(after).includes("*"));
  const comparable = (response: Response) => [...response.headers].filter(([name]) => !["date", "set-cookie"].includes(name)).sort();
  assert.deepEqual(comparable(after), comparable(before));
  // And the embed session's own files say any ancestor.
  assert.equal(frameAncestorsOf(await app.contentFetch(`${embed.base}style.css`)), "*");
});

test("EMBEDS off (the kill switch): the embed host and /_raft/embed are the one 404, Raft never asked, no embed session minted", async (t) => {
  const cases: Record<string, string>[] = [
    { EMBEDS: "0", EMBED_DOMAIN: "raftembed.localhost" },
    { EMBEDS: "", EMBED_DOMAIN: "raftembed.localhost" },
    { EMBEDS: "yes", EMBED_DOMAIN: "raftembed.localhost" },
    // On, but no usable embed host (unset; under the content domain): off, fail closed.
    { EMBEDS: "1" },
    { EMBEDS: "1", EMBED_DOMAIN: "w-x.raftcontent.localhost" },
  ];
  for (const bindings of cases) {
    const app = await startRaftContent({ bindings });
    t.after(() => app.close());
    const published = await app.publish({ "index.html": HTML });
    app.embedPublic(published);
    const what = JSON.stringify(bindings);
    if (bindings.EMBED_DOMAIN && bindings.EMBEDS !== "1") {
      const page = await app.contentFetch(`http://${bindings.EMBED_DOMAIN}/${published.artifact}`);
      assert.equal(page.status, 404, what);
    }
    const { served, body } = await openEmbedSession(app, published);
    assert.equal(served.status, 404, what);
    assert.match(body, /data-porthole-reason="not-found"/, what);
    assert.deepEqual(served.headers.getSetCookie(), [], what);
    assert.deepEqual(app.raft.embedCalls, [], what);
    assert.equal(app.raft.authorizeCalls.length, 0, what);
    // The content domain is as it was.
    const reader = await app.contentFetch(app.openUrl(published, signTicket(app.claimsFor(published))), { headers: frameHeaders });
    assert.equal(reader.status, 200, what);
  }
});

test("past the per-viewer budget the embed is Porthole's embed status page (429), never a 5xx", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  app.embedPublic(published);
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  for (let i = 0; i < EMBEDS_PER_VIEWER_PER_MINUTE; i += 1) assert.equal((await app.contentFetch(app.embedUrl(published.artifact), { headers })).status, 200, `load ${i}`);
  const limited = await app.contentFetch(app.embedUrl(published.artifact), { headers });
  const body = await limited.text();
  assert.equal(limited.status, 429);
  assert.match(body, /data-porthole-hosts="\[\]"/);
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(frameAncestorsOf(limited), "*");
  // Another viewer isn't held back.
  assert.equal((await app.contentFetch(app.embedUrl(published.artifact), { headers: { "cf-connecting-ip": "203.0.113.10" } })).status, 200);
  // The embed session's open counts per viewer too.
  for (let i = 0; i < EMBEDS_PER_VIEWER_PER_MINUTE; i += 1)
    assert.equal((await openEmbedSession(app, published, { ...embedFrameHeaders, ...headers })).served.status, 200, `open ${i}`);
  assert.equal((await openEmbedSession(app, published, { ...embedFrameHeaders, ...headers })).served.status, 429);
});

test("past the per-Artifact and the per-site budgets the embed is the embed status page (429), never a 5xx; other Artifacts and sites go on", async (t) => {
  const app = await setup(t);
  const busy = await app.publish({ "index.html": HTML });
  const quiet = await app.publish({ "index.html": HTML });
  for (const each of [busy, quiet]) app.embedPublic(each);
  let address = 0;
  const load = (artifact: string, referer: string) =>
    app.contentFetch(app.embedUrl(artifact), { headers: { referer, "cf-connecting-ip": `198.18.${(address >> 8) & 255}.${address++ & 255}` } });
  for (let i = 0; i < EMBEDS_PER_ARTIFACT_PER_MINUTE; i += 1) assert.equal((await load(busy.artifact, `https://site${i % 3}.example/`)).status, 200, `load ${i}`);
  const limited = await load(busy.artifact, "https://site0.example/");
  assert.equal(limited.status, 429);
  assert.equal(frameAncestorsOf(limited), "*");
  assert.equal((await load(quiet.artifact, "https://site0.example/")).status, 200, "another Artifact");

  // One embedding site across many Artifacts.
  const pages: Published[] = [];
  for (let i = 0; i < 3; i += 1) {
    const page = await app.publish({ "index.html": HTML });
    app.embedPublic(page);
    pages.push(page);
  }
  for (let i = 0; i < EMBEDS_PER_SITE_PER_MINUTE; i += 1) {
    const status = (await load(pages[i % 3]!.artifact, `https://news${i % 2 ? "" : ".www"}.hotlinker.example/a/${i}`)).status;
    assert.equal(status, 200, `site load ${i}`);
  }
  const siteLimited = await load(pages[0]!.artifact, "https://other.hotlinker.example/");
  assert.equal(siteLimited.status, 429, "the registrable domain is the budget's key");
  assert.equal((await load(pages[0]!.artifact, "https://elsewhere.example/")).status, 200, "another site");
});

test("an embedder is its registrable domain, or none, ip or localhost: never a path, a query or an address", () => {
  const of = (headers: Record<string, string>) => embedderOf(new Request("https://embed.example/pt_x", { headers }));
  assert.equal(of({ referer: "https://www.news.example.com/a/b?c=d" }), "example.com");
  assert.equal(of({ referer: "https://shop.example.co.uk/" }), "example.co.uk");
  assert.equal(of({ referer: "https://a.b.example.com.au/x" }), "example.com.au");
  assert.equal(of({ referer: "https://example.io/" }), "example.io");
  assert.equal(of({ origin: "https://site.example.org" }), "example.org");
  assert.equal(of({ referer: "http://203.0.113.5:8080/x" }), "ip");
  assert.equal(of({ referer: "http://[2001:db8::1]/" }), "ip");
  assert.equal(of({ referer: "http://localhost:8000/embed-test.html" }), "localhost");
  assert.equal(of({ referer: "file:///tmp/x.html" }), "none");
  assert.equal(of({ referer: "not a url" }), "none");
  assert.equal(of({}), "none");
});
