import assert from "node:assert/strict";
import test from "node:test";

import { FAMILY_ID, SERVER_ID, signTicket, startRaftContent, USER_ID, type Published, type RaftContentApp } from "./raftContentHarness";

/** raftContentService.ts CHECK_OPENS_PER_VERSION_PER_MINUTE (the service imports pdf.js's assets as modules: not loadable in Node). */
const CHECK_OPENS_PER_VERSION_PER_MINUTE = 10;

/**
 * A publish check's ticket (task #proj-workspace:#130; the server's checkFrame.ts): a ticket Raft's
 * server signs with viewer `system:check` and subject `v1:check:<artifact>:<version>`, which the
 * check's headless browser opens top-level (Tenny's design change: no check host page, no
 * CHECK_HOST_ORIGIN). The Worker opens it only when it names no ancestor, with Porthole's anonymous
 * grant for that one version (no viewer, no level), asks Raft's authorize with the check subject as
 * for anyone, counts it against a budget of its own (by version), and answers `no-store`. Every
 * response keeps the reader's `frame-ancestors`: nothing widens them any more. A check ticket with an
 * ancestor or a door, and every mix of a check's viewer or subject with a reader's, is refused
 * before D1, Raft or R2 are touched; the door route (Porthole P125, P126) refuses a check ticket. Tickets are signed with node:crypto (the harness's `signTicket`);
 * the shared WebCrypto signer the server uses signs a check ticket in shared's artifactContentTicket.test.ts, and a
 * reader's and a visitor's against this Worker in raft-content-signed-ticket.test.ts.
 */

/** What the old design's check ticket named as its ancestor (the check host page): now refused like any. */
const OLD_CHECK_HOST = "https://check.raft-check.example";
const HTML = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1>Raft page</h1></body></html>`;
/** A headless browser's navigation of a tab of its own: the check's. */
const topLevelHeaders = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };
/** The app's frame: a reader's. */
const frameHeaders = { "sec-fetch-dest": "iframe" };
const checkSubject = ({ artifact, version }: Published) => `v1:check:${artifact}:${version}`;

async function setup(t: test.TestContext, bindings: Record<string, string> = {}) {
  const app = await startRaftContent({ bindings });
  t.after(() => app.close());
  return app;
}

/** The claims the server's check task signs for `published` (checkFrame.ts), with `overrides`: no ancestor. */
const checkClaimsFor = (app: RaftContentApp, published: Published, overrides: Record<string, unknown> = {}) => ({
  ...app.claimsFor(published, { viewer: "system:check", subject: checkSubject(published) }),
  ...overrides,
});

const frameAncestorsOf = (response: Response) =>
  /(?:^|;)\s*frame-ancestors\s+([^;]*)/.exec(response.headers.get("content-security-policy") ?? "")?.[1]?.trim().split(/\s+/) ?? [];

/** Opens a signed ticket, top-level as the check does unless `headers` say otherwise; the page, and its sealed files address. */
async function openSigned(app: RaftContentApp, published: Published, ticket: string, headers: Record<string, string> = topLevelHeaders) {
  const served = await app.contentFetch(app.openUrl(published, ticket), { headers });
  const body = await served.text();
  const base = new RegExp(`${app.originOf(published).replaceAll(".", "\\.")}/__porthole/f/[A-Za-z0-9_-]+/`).exec(body)?.[0] ?? null;
  return { served, body, base };
}

async function ticketRows(app: RaftContentApp): Promise<string[]> {
  const db = await app.mf.getD1Database("TICKETS");
  return (await db.prepare("SELECT id FROM porthole_tickets").all<{ id: string }>()).results.map((row) => row.id);
}

/** A refusal: Porthole's used-ticket page (401, reason `session`), none of the page, `no-store`, framed by the app at most. */
async function assertRefused(app: RaftContentApp, response: Response, why: string) {
  const body = await response.text();
  assert.equal(response.status, 401, `${why}: ${body.slice(0, 200)}`);
  assert.match(body, /data-porthole-reason="session"/, why);
  assert.ok(!body.includes("Raft page"), why);
  assert.equal(response.headers.get("cache-control"), "no-store", why);
  assert.ok(frameAncestorsOf(response).every((each) => each === app.appOrigin), `${why}: nothing widens frame-ancestors`);
}

const refusalReasons = (app: RaftContentApp) =>
  new Set(app.logs.filter((line) => line.includes("raft-content.ticket-refused")).map((line) => (JSON.parse(line) as { reason: string }).reason));

test("a check ticket without an ancestor opens its version top-level, once, no-store; Raft's authorize asked with the check subject", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  const claims = checkClaimsFor(app, published);
  assert.equal("ancestor" in claims, false);
  const ticket = signTicket(claims);
  const { served, body, base } = await openSigned(app, published, ticket);
  assert.equal(served.status, 200, body.slice(0, 300));
  assert.ok(body.includes("Raft page"));
  assert.equal(served.headers.get("cache-control"), "no-store");
  assert.deepEqual(frameAncestorsOf(served), [app.appOrigin], "the reader's frame-ancestors, unchanged: nothing is added for a check");
  assert.match(served.headers.get("content-security-policy") ?? "", /sandbox allow-scripts allow-same-origin/, "the reader's sandbox, unchanged, on a tab of its own too");
  assert.ok(!body.includes(ticket), "the signed ticket is not in the page");
  // Raft decides, as for anyone; its check subject reached it, so the session is an anonymous one
  // (`subjectFits` takes a check subject on an anonymous session only, and refuses it before Raft
  // is asked on any other): no viewer, no level, no runtime host function.
  assert.deepEqual(app.raft.authorizeCalls.map((call) => call.body), [{ artifact: published.artifact, version: published.version, subject: claims.subject }]);
  assert.deepEqual(await ticketRows(app), [`raft-open:${claims.nonce}`], "opened once, no Porthole ticket in D1");

  // The session's files load as a reader's do.
  assert.ok(base, "the page's sealed files address");
  const style = await app.contentFetch(`${base}style.css`);
  assert.equal(style.status, 200);
  assert.equal(await style.text(), "h1{color:red}");

  await assertRefused(app, await app.contentFetch(app.openUrl(published, ticket), { headers: topLevelHeaders }), "opened twice");
  assert.ok(!app.logs.some((line) => line.includes(ticket) || line.includes(claims.nonce)), "never the ticket or its nonce in a log");
});

test("reverse control: readers open framed by the app alone, before and after a check; no reader's ticket carries an ancestor", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  assert.equal((await openSigned(app, published, signTicket(checkClaimsFor(app, published)))).served.status, 200);

  const reader = await openSigned(app, published, signTicket(app.claimsFor(published)), frameHeaders);
  assert.equal(reader.served.status, 200, reader.body.slice(0, 200));
  assert.deepEqual(frameAncestorsOf(reader.served), [app.appOrigin], "a signed-in reader: the app alone");
  const anonymous = app.anonymousBodyFor(published);
  const visitor = await openSigned(app, published, signTicket(app.claimsFor(published, { viewer: anonymous.viewer, subject: anonymous.subject })), frameHeaders);
  assert.equal(visitor.served.status, 200, visitor.body.slice(0, 200));
  assert.deepEqual(frameAncestorsOf(visitor.served), [app.appOrigin], "a signed-out visitor: the app alone");

  // A reader's or an anonymous ticket with an ancestor is refused (the shared verifier: `malformed`).
  await assertRefused(app, await app.contentFetch(app.openUrl(published, signTicket({ ...app.claimsFor(published), ancestor: OLD_CHECK_HOST })), { headers: frameHeaders }), "a reader's ticket with an ancestor");
  await assertRefused(
    app,
    await app.contentFetch(app.openUrl(published, signTicket({ ...app.claimsFor(published, { viewer: anonymous.viewer, subject: anonymous.subject }), ancestor: OLD_CHECK_HOST })), { headers: frameHeaders }),
    "an anonymous ticket with an ancestor",
  );
  assert.ok(refusalReasons(app).has("malformed"));
});

test("Raft's answers are never shared between a check and a reader: each session is asked for itself", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  // The check is allowed; then Raft denies (the version is no longer public, say): a signed-out
  // visitor of the same version within the 30 s reuse gets Raft's deny, not the check's allow.
  assert.equal((await openSigned(app, published, signTicket(checkClaimsFor(app, published)))).served.status, 200);
  app.raft.authorize = { status: 200, body: { allow: false, code: "not-public" } };
  const anonymous = app.anonymousBodyFor(published);
  const visitor = await openSigned(app, published, signTicket(app.claimsFor(published, { viewer: anonymous.viewer, subject: anonymous.subject })), frameHeaders);
  assert.equal(visitor.served.status, 403, visitor.body.slice(0, 200));
  assert.ok(!visitor.body.includes("Raft page"));
  // And the other way: a reader allowed, then the check denied (its check no longer runs).
  app.raft.authorize = { status: 200, body: { allow: true } };
  assert.equal((await openSigned(app, published, signTicket(app.claimsFor(published)), frameHeaders)).served.status, 200);
  app.raft.authorize = { status: 200, body: { allow: false, code: "not-checking" } };
  const check = await openSigned(app, published, signTicket(checkClaimsFor(app, published)));
  assert.equal(check.served.status, 403, check.body.slice(0, 200));
  assert.ok(check.body.includes("not-checking"), "Raft's code, for the check to record");
  assert.ok(!check.body.includes("Raft page"));
  assert.equal(check.served.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    app.raft.authorizeCalls.map((call) => call.body.subject),
    [checkSubject(published), anonymous.subject, `v1:${SERVER_ID}:${USER_ID}:${FAMILY_ID}`, checkSubject(published)],
    "one question per session, each with its own subject",
  );
});

test("mixed and mismatched check tickets are refused before D1, Raft or R2: a reader's subject on a check ticket, a check subject on a reader's, another version's or Artifact's", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const other = await app.publish({ "index.html": HTML });
  const second = await app.publish({ "index.html": HTML }, { artifact: published.artifact });
  const readerSubject = `v1:${SERVER_ID}:${USER_ID}:${FAMILY_ID}`;
  const cases: Array<[why: string, claims: Record<string, unknown>, reason: string]> = [
    // A check ticket with someone else's subject.
    ["a check ticket with a reader's subject", checkClaimsFor(app, published, { subject: readerSubject }), "bad-claims"],
    ["a check ticket with an anonymous subject", checkClaimsFor(app, published, { subject: `v1:anon:${published.artifact}:${published.version}` }), "bad-claims"],
    ["a check ticket with another version's check subject", checkClaimsFor(app, published, { subject: checkSubject(second) }), "bad-claims"],
    ["a check ticket with another Artifact's check subject", checkClaimsFor(app, published, { subject: checkSubject(other) }), "bad-claims"],
    ["a check subject with its parts swapped", checkClaimsFor(app, published, { subject: `v1:check:${published.version}:${published.artifact}` }), "bad-claims"],
    ["a check subject in uppercase", checkClaimsFor(app, published, { subject: checkSubject(published).toUpperCase() }), "bad-claims"],
    ["a check subject with more after it", checkClaimsFor(app, published, { subject: `${checkSubject(published)}:x` }), "bad-claims"],
    ["a check ticket for a version that isn't a version id", checkClaimsFor(app, published, { version: published.artifact, subject: `v1:check:${published.artifact}:${published.artifact}` }), "bad-claims"],
    // A check subject on someone else's ticket.
    ["a reader's ticket with a check subject", app.claimsFor(published, { subject: checkSubject(published) }), "bad-claims"],
    ["an anonymous ticket with a check subject", app.claimsFor(published, { viewer: "anonymous", subject: checkSubject(published) }), "bad-claims"],
    ["another spelling of the check viewer", checkClaimsFor(app, published, { viewer: "system:Check" }), "malformed"],
    // An ancestor on a check ticket, mixed or not.
    ["a check ticket with an ancestor", checkClaimsFor(app, published, { ancestor: OLD_CHECK_HOST }), "malformed"],
    ["a check ticket with a reader's subject and an ancestor", checkClaimsFor(app, published, { subject: readerSubject, ancestor: OLD_CHECK_HOST }), "malformed"],
    // A door on a check ticket (Porthole P125, P126): a check ticket never has one.
    ["a check ticket with a door", checkClaimsFor(app, published, { door: true }), "malformed"],
    ["a check ticket with door: false", checkClaimsFor(app, published, { door: false }), "malformed"],
  ];
  for (const [why, claims] of cases) await assertRefused(app, await app.contentFetch(app.openUrl(published, signTicket(claims)), { headers: topLevelHeaders }), why);
  const reasons = refusalReasons(app);
  for (const reason of new Set(cases.map(([, , each]) => each))) assert.ok(reasons.has(reason), `${reason} logged: ${[...reasons].join(", ")}`);
  assert.equal(app.raft.authorizeCalls.length, 0, "Raft is never asked for a refused ticket");
  assert.equal(app.r2.requests.length, 0, "nor R2");
  assert.deepEqual(await ticketRows(app), [], "nothing is recorded for a refused ticket");
  // Witness: the good one opens.
  assert.equal((await openSigned(app, published, signTicket(checkClaimsFor(app, published)))).served.status, 200);
});

test("a check ticket opens no door: with or without a door claim, the door route refuses it (session) before D1, Raft or R2", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const cases: Array<[why: string, claims: Record<string, unknown>, reason: string]> = [
    // The shared verifier refuses a check ticket's door before the Worker reads the claims.
    ["a check ticket with a door", checkClaimsFor(app, published, { door: true }), "malformed"],
    // A check ticket as the server signs it is no door's ticket.
    ["a check ticket without a door", checkClaimsFor(app, published), "bad-claims"],
  ];
  for (const [why, claims] of cases) {
    const answered = await app.contentFetch(app.doorUrl(published, signTicket(claims)));
    const body = await answered.text();
    assert.equal(answered.status, 401, `${why}: ${body.slice(0, 200)}`);
    assert.match(body, /data-porthole-reason="session"/, why);
    assert.ok(!body.includes("data-porthole-door="), `${why}: the door never says open`);
  }
  const reasons = refusalReasons(app);
  for (const [, , reason] of cases) assert.ok(reasons.has(reason), `${reason} logged: ${[...reasons].join(", ")}`);
  assert.equal(app.raft.authorizeCalls.length, 0, "Raft is never asked for a refused door");
  assert.equal(app.r2.requests.length, 0, "nor R2");
  assert.deepEqual(await ticketRows(app), [], "nothing is recorded for a refused door");
  // Witness: the same check ticket without a door opens at /_raft/open.
  assert.equal((await openSigned(app, published, signTicket(checkClaimsFor(app, published)))).served.status, 200);
});

test("the legacy issue route never mints a check's frame: a check body is a 400", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const response = await app.issue({ artifact: published.artifact, version: published.version, viewer: "system:check", subject: checkSubject(published) });
  assert.equal(response.status, 400, await response.text());
});

test("a check's opens have a budget of their own, by its version (not by client address): past it a 429 before D1; readers and other versions unaffected", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const other = await app.publish({ "index.html": HTML });
  const open = (version: Published, address: string) =>
    app.contentFetch(app.openUrl(version, signTicket(checkClaimsFor(app, version))), { headers: { ...topLevelHeaders, "cf-connecting-ip": address } });
  for (let each = 0; each < CHECK_OPENS_PER_VERSION_PER_MINUTE; each += 1) {
    const answer = await open(published, `192.0.2.${each + 1}`);
    await answer.arrayBuffer();
    assert.equal(answer.status, 200, `check open ${each}`);
  }
  const rows = (await ticketRows(app)).length;
  const asked = app.raft.authorizeCalls.length;
  const limited = await open(published, "198.51.100.1");
  const body = await limited.text();
  assert.equal(limited.status, 429, body.slice(0, 200));
  assert.match(body, /data-porthole-reason="error"/);
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal((await ticketRows(app)).length, rows, "past the budget, nothing is written");
  assert.equal(app.raft.authorizeCalls.length, asked, "nor is Raft asked");
  assert.ok(refusalReasons(app).has("rate-limited"));
  // Another version's check, and readers of this very version, count against budgets of their own.
  const elsewhere = await open(other, "198.51.100.1");
  await elsewhere.arrayBuffer();
  assert.equal(elsewhere.status, 200, "another version's check");
  assert.equal((await openSigned(app, published, signTicket(app.claimsFor(published)), frameHeaders)).served.status, 200, "a signed-in reader");
  const anonymous = app.anonymousBodyFor(published);
  const visitor = await openSigned(app, published, signTicket(app.claimsFor(published, { viewer: anonymous.viewer, subject: anonymous.subject })), { ...frameHeaders, "cf-connecting-ip": "198.51.100.1" });
  assert.equal(visitor.served.status, 200, "a signed-out visitor at the same address");
});
