import assert from "node:assert/strict";
import test from "node:test";

import { FAMILY_ID, SERVER_ID, startRaftContent, USER_ID, type Published, type RaftContentApp } from "./raftContentHarness";
import { samplePdf } from "./samplePdf";

/**
 * A signed-out visitor of a public Artifact (Raft's `/api/public/artifacts/:id/frame`): Raft asks
 * the content Worker for an anonymous frame, viewer `anonymous` and subject
 * `v1:anon:<artifact>:<version>`; the Worker mints it with Porthole's anonymous grant (P046) for
 * that one version, and every request after still asks Raft's authorize (the same 30 s reuse).
 */

const HTML = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1>Public page</h1><script src="app.js"></script></body></html>`;
const frameHeaders = { "sec-fetch-dest": "iframe" };
const anonymousSubject = ({ artifact, version }: Published) => `v1:anon:${artifact}:${version}`;

async function setup(t: test.TestContext) {
  const app = await startRaftContent();
  t.after(() => app.close());
  return app;
}

const ticketsOf = async (app: RaftContentApp) => {
  const tickets = await app.mf.getD1Database("TICKETS");
  return {
    count: async () => ((await tickets.prepare("SELECT count(*) AS n FROM porthole_tickets").first()) as { n: number }).n,
    clear: () => tickets.prepare("DELETE FROM porthole_tickets").run(),
    only: async () => JSON.parse(((await tickets.prepare("SELECT record FROM porthole_tickets").first()) as { record: string }).record) as Record<string, unknown>,
    rewrite: (record: Record<string, unknown>) => tickets.prepare("UPDATE porthole_tickets SET record = ?").bind(JSON.stringify(record)).run(),
  };
};

/** An anonymous frame's first load, and the sealed files address it carries. */
async function openAnonymous(app: RaftContentApp, published: Published) {
  const issued = await app.issue(app.anonymousBodyFor(published));
  assert.equal(issued.status, 201, await issued.clone().text());
  const location = (await issued.json()) as { url: string; origin: string };
  const served = await app.contentFetch(location.url, { headers: frameHeaders });
  const body = await served.text();
  const base = new RegExp(`${location.origin.replaceAll(".", "\\.")}/__porthole/f/[A-Za-z0-9_-]+/`).exec(body)?.[0] ?? null;
  return { issued, location, served, body, base };
}

test("an anonymous issue is accepted only as viewer `anonymous` with the subject of that very version", async (t) => {
  const app = await setup(t);
  const tickets = await ticketsOf(app);
  const published = await app.publish({ "index.html": HTML });
  const other = await app.publish({ "index.html": HTML });
  const second = await app.publish({ "index.html": HTML }, { artifact: published.artifact });
  const good = app.anonymousBodyFor(published);
  assert.equal(good.subject, anonymousSubject(published));

  const bad: unknown[] = [
    // Mixed: an anonymous viewer with a user's subject, a user with an anonymous subject.
    { ...good, subject: `v1:${SERVER_ID}:${USER_ID}:${FAMILY_ID}` },
    { ...good, subject: `v1:${SERVER_ID}:${USER_ID}:-` },
    { ...good, viewer: `user:${USER_ID}` },
    // Another Artifact's or another version's subject; the parts swapped, missing or added to.
    { ...good, subject: anonymousSubject(other) },
    { ...good, subject: anonymousSubject(second) },
    { ...good, subject: `v1:anon:${published.version}:${published.artifact}` },
    { ...good, subject: `v1:anon:${published.artifact}` },
    { ...good, subject: `v1:anon:${published.artifact}:${published.version}:x` },
    { ...good, subject: `v1:anon:${published.artifact}:-` },
    { ...good, subject: `v2:anon:${published.artifact}:${published.version}` },
    { ...good, subject: `anon1:${published.artifact}:${published.version}` },
    { ...good, subject: anonymousSubject(published).toUpperCase() },
    // Another spelling of nobody.
    { ...good, viewer: "Anonymous" },
    { ...good, viewer: "anon" },
    { ...good, viewer: "" },
    { ...good, viewer: "user:anonymous" },
    // Not exactly the four keys.
    { ...good, anonymous: true },
    { artifact: good.artifact, version: good.version, subject: good.subject },
    { artifact: good.artifact, version: good.version, anonymous: true, subject: good.subject },
    // The body's own ids still checked.
    { ...good, artifact: good.artifact.toUpperCase(), subject: `v1:anon:${good.artifact.toUpperCase()}:${good.version}` },
    { ...good, version: good.artifact, subject: `v1:anon:${good.artifact}:${good.artifact}` },
  ];
  for (const each of bad) {
    const response = await app.issue(each);
    assert.equal(response.status, 400, JSON.stringify(each));
  }
  assert.equal(await tickets.count(), 0, "no ticket for any refused body");

  // The good one: Porthole's FrameLocation on the Artifact's own origin, an anonymous ticket.
  const issued = await app.issue(good);
  assert.equal(issued.status, 201, await issued.clone().text());
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const location = (await issued.json()) as Record<string, unknown>;
  // No `viewer` (no level): the frame's bridge refuses the runtime's host functions, `comments` among them.
  assert.deepEqual(Object.keys(location).sort(), ["origin", "reports", "url"], "Porthole's FrameLocation, with no viewer level");
  assert.equal(location.origin, `http://w-${published.artifact.slice(3)}.${app.contentDomain}`);
  const record = await tickets.only();
  assert.equal(record.anonymous, true);
  assert.equal(record.viewer, "", "no viewer in an anonymous ticket");
  assert.equal(record.subject, good.subject);
  assert.equal(record.sessionSeconds, 600, "a signed-out visitor's session: ten minutes");
  assert.deepEqual(record.instance, { scope: published.artifact.slice(3), document: { kind: "artifact", id: published.artifact, version: published.version } });

  // A version Raft doesn't frame is the same 404 for nobody as for anyone.
  const text = await app.publish({ "notes.txt": "plain" }, { kind: "text" });
  assert.equal((await app.issue(app.anonymousBodyFor(text))).status, 404);
});

test("a signed-in issue is unchanged: its grant is the viewer's, never anonymous", async (t) => {
  const app = await setup(t);
  const tickets = await ticketsOf(app);
  const published = await app.publish({ "index.html": HTML });
  for (const [family, session] of [[FAMILY_ID, undefined], ["-", 600]] as const) {
    await tickets.clear();
    const body = { ...app.bodyFor(published), subject: `v1:${SERVER_ID}:${USER_ID}:${family}` };
    const issued = await app.issue(body);
    assert.equal(issued.status, 201);
    assert.deepEqual(((await issued.json()) as { viewer?: unknown }).viewer, { level: "view" }, "the signed-in grant's level, as on main");
    const record = await tickets.only();
    assert.equal(record.anonymous, undefined);
    assert.equal(record.viewer, `user:${USER_ID}`);
    assert.equal(record.subject, body.subject);
    assert.equal(record.sessionSeconds, session, family);
  }
});

test("an anonymous frame asks Raft on every request with its subject; a deny refuses it", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "app.js": "document.title='ran'" });
  const opened = await openAnonymous(app, published);
  assert.equal(opened.served.status, 200, opened.body);
  assert.ok(opened.body.includes("Public page"));
  assert.deepEqual(opened.served.headers.getSetCookie(), [], "no cookie: a file set's frame carries its access in the sealed path");
  const asked = app.raft.authorizeCalls.at(-1)!;
  assert.equal(asked.token, true);
  assert.deepEqual(asked.body, { artifact: published.artifact, version: published.version, subject: anonymousSubject(published) });

  // Raft's answer is reused for the session (30 s, unchanged), as for anyone.
  const before = app.raft.authorizeCalls.length;
  assert.equal((await app.contentFetch(`${opened.base}style.css`)).status, 200);
  assert.equal(app.raft.authorizeCalls.length, before, "cached for the session");

  // No longer public: a new frame is refused with Raft's code, nothing of the page.
  app.raft.authorize = { status: 200, body: { allow: false, code: "not-public" } };
  const refused = await openAnonymous(app, published);
  assert.equal(refused.served.status, 403);
  assert.ok(!refused.body.includes("Public page"));
  assert.ok(refused.body.includes("not-public"));
});

test("an anonymous grant is that one Artifact and version's: a subject for another is refused before Raft is asked", async (t) => {
  const app = await setup(t);
  const tickets = await ticketsOf(app);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  const second = await app.publish({ "index.html": HTML, "only-second.css": "p{}" }, { artifact: published.artifact });
  const other = await app.publish({ "index.html": HTML });

  // Its sealed files address serves only its version's files, and only on its own origin.
  const opened = await openAnonymous(app, published);
  assert.equal(opened.served.status, 200);
  assert.equal((await app.contentFetch(`${opened.base}style.css`)).status, 200);
  assert.equal((await app.contentFetch(`${opened.base}only-second.css`)).status, 404, "another version's file");
  const foreign = opened.base!.replace(/w-[0-9a-f-]{36}/, `w-${other.artifact.slice(3)}`);
  assert.equal((await app.contentFetch(`${foreign}style.css`)).status, 401, "another Artifact's origin");

  // A ticket whose grant doesn't fit its instance (as no issue mints it): the Worker's authorize
  // refuses it, and Raft is never asked.
  const forged: [string, (record: Record<string, unknown>) => Record<string, unknown>][] = [
    ["another version's subject", (record) => ({ ...record, subject: anonymousSubject(second) })],
    ["another Artifact's subject", (record) => ({ ...record, subject: anonymousSubject(other) })],
    ["anonymous with a user's subject", (record) => ({ ...record, subject: `v1:${SERVER_ID}:${USER_ID}:${FAMILY_ID}` })],
    ["anonymous with no subject", ({ subject: _subject, ...record }) => record],
  ];
  for (const [name, rewrite] of forged) {
    await tickets.clear();
    const issued = (await (await app.issue(app.anonymousBodyFor(published))).json()) as { url: string };
    await tickets.rewrite(rewrite(await tickets.only()));
    const calls = app.raft.authorizeCalls.length;
    const served = await app.contentFetch(issued.url, { headers: frameHeaders });
    const body = await served.text();
    assert.equal(served.status, 403, name);
    assert.ok(body.includes("bad-subject") && !body.includes("Public page"), name);
    assert.equal(app.raft.authorizeCalls.length, calls, `${name}: Raft not asked`);
  }
  // And a signed-in ticket carrying an anonymous subject.
  await tickets.clear();
  const signedIn = (await (await app.issue(app.bodyFor(published))).json()) as { url: string };
  await tickets.rewrite({ ...(await tickets.only()), subject: anonymousSubject(published) });
  const calls = app.raft.authorizeCalls.length;
  const mixed = await app.contentFetch(signedIn.url, { headers: frameHeaders });
  assert.equal(mixed.status, 403);
  assert.ok((await mixed.text()).includes("bad-subject"));
  assert.equal(app.raft.authorizeCalls.length, calls, "Raft not asked");
  // A deny Raft was never asked about is said in the log (#proj-workspace:#280): once for the minute, the reason alone.
  const notAsked = app.logs.filter((line) => line.includes("raft-content.authorize-unanswered")).map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
  assert.deepEqual(notAsked, [{ evt: "raft-content.authorize-unanswered", why: "not-asked" }]);
});

test("anonymous content is never shared-cacheable and is noindex", async (t) => {
  const app = await setup(t);
  const versions = [
    await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "app.js": "1" }),
    await app.publish({ "notes.md": "# Notes\n\n![dot](dot.svg)", "dot.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" }, { kind: "markdown", entry: "notes.md" }),
    await app.publish({ "report.pdf": samplePdf(["One"]) }, { kind: "pdf", entry: "report.pdf" }),
  ];
  const paths = [["style.css", "app.js", "index.html", "missing.css"], ["notes.md", "notes.md.html", "dot.svg"], ["report.pdf", "report.pdf.html", "_raft-pdf/pdf.min.mjs"]];
  const responses: [string, Response][] = [];
  for (const [at, published] of versions.entries()) {
    const opened = await openAnonymous(app, published);
    assert.equal(opened.served.status, 200, opened.body);
    responses.push([`issue ${at}`, opened.issued], [`shell ${at}`, opened.served]);
    for (const path of paths[at]!) {
      const response = await app.contentFetch(`${opened.base}${path}`);
      responses.push([`${at} ${path} (${response.status})`, response]);
      responses.push([`${at} HEAD ${path}`, await app.contentFetch(`${opened.base}${path}`, { method: "HEAD" })]);
    }
  }
  // A refused frame and a ticket used twice.
  app.raft.authorize = { status: 200, body: { allow: false, code: "not-public" } };
  const refused = await openAnonymous(app, versions[0]!);
  responses.push(["refused", refused.served], ["ticket again", await app.contentFetch(refused.location.url, { headers: frameHeaders })]);

  for (const [name, response] of responses) {
    const cacheControl = response.headers.get("cache-control") ?? "";
    assert.ok(cacheControl !== "", `${name}: says how it may be cached`);
    assert.doesNotMatch(cacheControl, /\bpublic\b|s-maxage/i, `${name}: ${cacheControl}`);
    assert.match(cacheControl, /\bprivate\b|\bno-store\b/i, `${name}: ${cacheControl}`);
    for (const header of ["cdn-cache-control", "cloudflare-cdn-cache-control", "surrogate-control"])
      assert.equal(response.headers.get(header), null, `${name}: ${header}`);
    if (!name.startsWith("issue")) assert.match(response.headers.get("x-robots-tag") ?? "", /\bnoindex\b/, `${name}: x-robots-tag`);
    if (!response.bodyUsed) await response.body?.cancel();
  }
});
