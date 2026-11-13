import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ARTIFACT_CONTENT_TICKET_MAX_SECONDS,
  artifactContentTicketKey,
  artifactContentTicketNonce,
  signArtifactContentTicket,
} from "@botiverse/raft-shared/src/artifactContentTicket";

import { artifactFramedPagePath } from "@botiverse/raft-shared/src/artifactFiles";

import { renderedPagePath } from "../src/files";
import { samplePdf } from "./samplePdf";
import {
  FAMILY_ID,
  PREVIOUS_RAFT_TOKEN,
  RAFT_TOKEN,
  SERVER_ID,
  signTicket,
  startRaftContent,
  type Published,
  type RaftContentApp,
} from "./raftContentHarness";

/** raftContentService.ts OPENS_PER_VIEWER_PER_MINUTE (the service imports pdf.js's assets as modules: not loadable in Node). */
const OPENS_PER_VIEWER_PER_MINUTE = 120;

/**
 * A frame's first load with a ticket Raft's server signed itself
 * (`<origin>/_raft/open?ticket=…`; shared artifactContentTicket.ts): the
 * Worker checks it (a key of RAFT_TOKENS by its kid, the MAC, the expiry, the
 * origin, the Artifact's own label, the claims), opens it once (D1), and hands
 * it to Porthole as a ticket of its own, kept in the isolate's memory. Raft's
 * authorize is still asked on that first load. The tickets here are signed
 * with node:crypto (the harness's `signTicket`), apart from the shared
 * WebCrypto code the Worker verifies with, and once with that code itself.
 */

const HTML = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1>Raft page</h1></body></html>`;
const frameHeaders = { "sec-fetch-dest": "iframe" };

async function setup(t: test.TestContext, bindings?: Record<string, string>) {
  const app = await startRaftContent(bindings ? { bindings } : {});
  t.after(() => app.close());
  return app;
}

/** Opens a signed ticket as the frame does; the page, and its sealed files address. */
async function openSigned(app: RaftContentApp, published: Published, ticket: string, origin?: string) {
  const served = await app.contentFetch(app.openUrl(published, ticket, origin), { headers: frameHeaders });
  const body = await served.text();
  const base = new RegExp(`${app.originOf(published).replaceAll(".", "\\.")}/__porthole/f/[A-Za-z0-9_-]+/`).exec(body)?.[0] ?? null;
  return { served, body, base };
}

/** The rows of the ticket table. */
async function ticketRows(app: RaftContentApp): Promise<{ id: string; record: string }[]> {
  const db = await app.mf.getD1Database("TICKETS");
  return (await db.prepare("SELECT id, record FROM porthole_tickets").all<{ id: string; record: string }>()).results;
}

/** A refusal: Porthole's used-ticket page (401, reason `session`), none of the page, nothing asked of Raft or R2. */
async function assertRefused(app: RaftContentApp, response: Response, why: string) {
  const body = await response.text();
  assert.equal(response.status, 401, `${why}: ${body.slice(0, 200)}`);
  assert.match(body, /data-porthole-reason="session"/, why);
  assert.ok(!body.includes("Raft page"), why);
  assert.equal(response.headers.get("cache-control"), "no-store", why);
  assert.deepEqual(response.headers.getSetCookie(), [], why);
}

test("a ticket Raft signed opens its page once: the frame's document, Raft's authorize asked, no Porthole ticket in D1", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  const claims = app.claimsFor(published);
  const ticket = signTicket(claims);
  const { served, body, base } = await openSigned(app, published, ticket);
  assert.equal(served.status, 200, body.slice(0, 300));
  assert.ok(body.includes("Raft page"), "the page travels in the shell");
  assert.equal(served.headers.get("cache-control"), "no-store");
  assert.equal(served.headers.get("referrer-policy"), "no-referrer");
  const csp = served.headers.get("content-security-policy") ?? "";
  assert.match(csp, /sandbox allow-scripts allow-same-origin/);
  assert.match(csp, new RegExp(`frame-ancestors ${app.appOrigin.replaceAll(".", "\\.")}`));
  assert.ok(base, "the frame's sealed files address");
  assert.ok(!body.includes(ticket), "the signed ticket is not in the page");
  // Its files load from the sealed address, as after a ticket Porthole minted.
  const style = await app.contentFetch(`${base}style.css`);
  assert.equal(style.status, 200);
  assert.equal(await style.text(), "h1{color:red}");

  // Raft decided again on this first load, for the signed subject.
  assert.deepEqual(app.raft.authorizeCalls[0]?.body, { artifact: published.artifact, version: published.version, subject: claims.subject });
  // D1 holds that the ticket was opened, and no Porthole ticket: that one stayed in memory and was taken.
  const rows = await ticketRows(app);
  assert.deepEqual(rows.map((row) => row.id), [`raft-open:${claims.nonce}`]);

  await assertRefused(app, await app.contentFetch(app.openUrl(published, ticket), { headers: frameHeaders }), "opened twice");
  assert.ok(app.logs.some((line) => line.includes("raft-content.ticket-refused") && line.includes('"opened"')));
  assert.ok(!app.logs.some((line) => line.includes(ticket) || line.includes(claims.nonce)), "never the ticket or its nonce in a log");
});

test("an opened ticket's row outlives its expiry by a ticket's longest life: no open sweeps it early, so a machine whose clock is behind can't open it again", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  // Far enough ahead that the first open lands before it on a busy machine (a second ahead was 0 to 1 s of
  // room after the floor, and CI's open came after it: 401), near enough that waiting past it stays short.
  const expires = Math.floor(Date.now() / 1000) + 4;
  const claims = app.claimsFor(published, { expires });
  const first = await openSigned(app, published, signTicket(claims));
  assert.equal(first.served.status, 200, first.body.slice(0, 300));
  const keptUntil = async () => {
    const db = await app.mf.getD1Database("TICKETS");
    return (await db.prepare("SELECT expires_at FROM porthole_tickets WHERE id = ?").bind(`raft-open:${claims.nonce}`).first<{ expires_at: number }>())?.expires_at ?? null;
  };
  assert.equal(await keptUntil(), (expires + ARTIFACT_CONTENT_TICKET_MAX_SECONDS) * 1_000);
  // This machine's clock past the expiry (within the grace); another open sweeps expired rows.
  while (Date.now() <= expires * 1_000 + 100) await sleep(50);
  assert.equal((await openSigned(app, published, signTicket(app.claimsFor(published)))).served.status, 200);
  assert.equal(await keptUntil(), (expires + ARTIFACT_CONTENT_TICKET_MAX_SECONDS) * 1_000, "not swept at the ticket's expiry");
  // A machine whose clock is behind still takes the ticket as unexpired: as it sees it, the same
  // nonce with its expiry ahead. The row refuses it.
  const replay = signTicket({ ...claims, expires: Math.floor(Date.now() / 1000) + 30 });
  await assertRefused(app, await app.contentFetch(app.openUrl(published, replay), { headers: frameHeaders }), "replayed past expiry");
  assert.ok(app.logs.some((line) => line.includes("raft-content.ticket-refused") && line.includes('"opened"')));
});

test("the Porthole ticket an open mints never reaches D1: Porthole's issue puts it before it awaits anything (what `handingOff` relies on)", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  // D1 refuses any Porthole ticket (a write that changes no row, so the open's own insert counts as before).
  const db = await app.mf.getD1Database("TICKETS");
  await db.prepare("CREATE TRIGGER no_porthole_ticket BEFORE INSERT ON porthole_tickets WHEN NEW.id NOT LIKE 'raft-open:%' BEGIN SELECT RAISE(ABORT, 'a Porthole ticket in D1'); END").run();
  const claims = app.claimsFor(published);
  const { served, body } = await openSigned(app, published, signTicket(claims));
  assert.equal(served.status, 200, body.slice(0, 300));
  assert.ok(body.includes("Raft page"), "Porthole's own ticket stayed in memory and was taken");
  assert.deepEqual((await ticketRows(app)).map((row) => row.id), [`raft-open:${claims.nonce}`]);
  // Witness: a ticket the legacy issue route mints goes to D1, which now refuses it.
  assert.notEqual((await app.issue(app.bodyFor(published))).status, 200);
});

test("opens are limited per viewer (429, Porthole's too-many-requests page, before D1), replays of one ticket included; another viewer and a signed-out visitor elsewhere unaffected", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const ticket = signTicket(app.claimsFor(published));
  const url = app.openUrl(published, ticket);
  assert.equal((await app.contentFetch(url, { headers: frameHeaders })).status, 200);
  // The same ticket replayed: refused as opened, each counted, until the budget is spent.
  for (let replay = 1; replay < OPENS_PER_VIEWER_PER_MINUTE; replay += 1) {
    const refused = await app.contentFetch(url, { headers: frameHeaders });
    await refused.arrayBuffer();
    assert.equal(refused.status, 401, `replay ${replay}`);
  }
  const db = await app.mf.getD1Database("TICKETS");
  const limited = await app.contentFetch(app.openUrl(published, signTicket(app.claimsFor(published))), { headers: frameHeaders });
  const body = await limited.text();
  assert.equal(limited.status, 429, body.slice(0, 200));
  assert.match(body, /data-porthole-reason="error"/);
  assert.ok(!body.includes("Raft page"));
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM porthole_tickets").first<{ n: number }>())?.n, 1, "a fresh ticket past the budget writes nothing");
  assert.equal(app.raft.authorizeCalls.length, 1, "nor asks Raft");
  assert.ok(app.logs.some((line) => line.includes("raft-content.ticket-refused") && line.includes('"rate-limited"')));

  // Another reader has their own budget.
  const other = "33333333-3333-4333-8333-333333333333";
  const theirs = signTicket(app.claimsFor(published, { viewer: `user:${other}`, subject: `v1:${SERVER_ID}:${other}:${FAMILY_ID}` }));
  assert.equal((await openSigned(app, published, theirs)).served.status, 200);
  // Signed-out visitors count by client address.
  const anonymous = app.anonymousBodyFor(published);
  const anonymousOpen = (address: string) => app.contentFetch(
    app.openUrl(published, signTicket(app.claimsFor(published, { viewer: anonymous.viewer, subject: anonymous.subject }))),
    { headers: { ...frameHeaders, "cf-connecting-ip": address } },
  );
  for (let open = 0; open < OPENS_PER_VIEWER_PER_MINUTE; open += 1) {
    const answer = await anonymousOpen("192.0.2.1");
    await answer.arrayBuffer();
    assert.equal(answer.status, 200, `anonymous open ${open}`);
  }
  const anonymousLimited = await anonymousOpen("192.0.2.1");
  await anonymousLimited.arrayBuffer();
  assert.equal(anonymousLimited.status, 429);
  const elsewhere = await anonymousOpen("192.0.2.2");
  await elsewhere.arrayBuffer();
  assert.equal(elsewhere.status, 200, "another address");
});

test("a signed ticket opened twice at once opens its page once", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  for (let round = 0; round < 5; round += 1) {
    const url = app.openUrl(published, signTicket(app.claimsFor(published)));
    // Each body read as its answer arrives (see openFrame in raft-content-app-origins.test.ts).
    const answers = await Promise.all([0, 1].map(async () => {
      const answer = await app.contentFetch(url, { headers: frameHeaders });
      return { status: answer.status, body: await answer.text() };
    }));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 401], `round ${round}`);
    const bodies = answers.map((answer) => answer.body);
    assert.equal(bodies.filter((body) => body.includes("Raft page")).length, 1);
  }
});

test("the Worker refuses an expired ticket, a bad signature, an unknown kid, another origin, another Artifact's claims and bad claims", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const other = await app.publish({ "index.html": HTML });
  const now = Math.floor(Date.now() / 1000);
  const good = signTicket(app.claimsFor(published));
  const [prefix, kid, payload, mac] = good.split(".") as [string, string, string, string];
  const flipped = `${mac.slice(0, -2)}${mac.at(-2) === "A" ? "B" : "A"}${mac.at(-1)}`;
  const otherPayload = signTicket(app.claimsFor(published, { viewer: "anonymous" })).split(".")[2]!;
  const cases: Array<[why: string, ticket: string, origin?: string]> = [
    ["expired", signTicket(app.claimsFor(published, { expires: now - 1 }))],
    ["expiring too far ahead", signTicket(app.claimsFor(published, { expires: now + 3600 }))],
    ["a bad signature (a MAC changed)", `${prefix}.${kid}.${payload}.${flipped}`],
    ["a bad signature (the claims changed under the MAC)", `${prefix}.${kid}.${otherPayload}.${mac}`],
    ["a bad signature (no MAC)", `${prefix}.${kid}.${payload}.`],
    ["an unknown kid (a token not in RAFT_TOKENS)", signTicket(app.claimsFor(published), "a-token-the-worker-was-never-given-0123456789")],
    ["an unknown kid (a short token the Worker ignores)", signTicket(app.claimsFor(published), "short")],
    ["another origin (another Artifact's label)", good, app.originOf(other)],
    ["another origin (signed for another content domain)", signTicket(app.claimsFor(published, { origin: `https://w-${published.artifact.slice(3)}.evil.example` }))],
    ["another Artifact's claims on this origin", signTicket(app.claimsFor(other, { origin: app.originOf(published) }))],
    ["a version that isn't a version id", signTicket(app.claimsFor(published, { version: published.artifact }))],
    ["an anonymous subject of another version", signTicket(app.claimsFor(published, { viewer: "anonymous", subject: `v1:anon:${published.artifact}:${other.version}` }))],
    ["a subject of another user than the viewer", signTicket(app.claimsFor(published, { viewer: "user:33333333-3333-4333-8333-333333333333" }))],
    ["an agent viewer", signTicket(app.claimsFor(published, { viewer: "agent:33333333-3333-4333-8333-333333333333" }))],
    ["a claim more", signTicket({ ...app.claimsFor(published), level: "edit" })],
    ["a claim missing", signTicket({ ...app.claimsFor(published), nonce: undefined })],
    ["another format", good.replace(/^rct1\./, "rct2.")],
    ["no ticket", ""],
  ];
  for (const [why, ticket, origin] of cases) {
    await assertRefused(app, await app.contentFetch(app.openUrl(published, ticket, origin), { headers: frameHeaders }), why);
  }
  assert.equal(app.raft.authorizeCalls.length, 0, "Raft is never asked for a refused ticket");
  assert.equal(app.r2.requests.length, 0, "nor R2");
  assert.deepEqual(await ticketRows(app), [], "nothing is recorded for a refused ticket");
  const reasons = new Set(app.logs.filter((line) => line.includes("raft-content.ticket-refused")).map((line) => (JSON.parse(line) as { reason: string }).reason));
  for (const reason of ["expired", "too-long", "bad-signature", "unknown-kid", "wrong-origin", "wrong-artifact", "bad-claims", "malformed"]) assert.ok(reasons.has(reason), `${reason} logged: ${[...reasons].join(", ")}`);
  // Only GET opens a ticket.
  await assertRefused(app, await app.contentFetch(app.openUrl(published, good), { method: "POST", headers: frameHeaders }), "POST");
  // Witness: the good ticket itself still opens (it was never opened above: every refusal came first).
  assert.equal((await openSigned(app, published, good)).served.status, 200);
});

test("a version Raft's manifest doesn't give for that Artifact serves nothing, though signed", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const other = await app.publish({ "index.html": HTML });
  // Signed for this Artifact with another Artifact's version: Raft's manifest says 404.
  const { served, body } = await openSigned(app, published, signTicket(app.claimsFor(published, { version: other.version })));
  assert.equal(served.status, 404, body.slice(0, 200));
  assert.ok(!body.includes("Raft page"));
  assert.equal(app.r2.requests.length, 0);
});

test("while rotating, tickets signed with the previous token and with the current one both open", async (t) => {
  const app = await setup(t, { RAFT_TOKENS: `${PREVIOUS_RAFT_TOKEN}, ${RAFT_TOKEN}` });
  const published = await app.publish({ "index.html": HTML });
  for (const [why, secret] of [["previous", PREVIOUS_RAFT_TOKEN], ["current", RAFT_TOKEN]] as const) {
    const { served, body } = await openSigned(app, published, signTicket(app.claimsFor(published), secret));
    assert.equal(served.status, 200, `${why}: ${body.slice(0, 200)}`);
    assert.ok(body.includes("Raft page"), why);
  }
});

test("a ticket the shared WebCrypto code signs (as Raft's server does) opens; an anonymous one opens with no viewer", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const key = await artifactContentTicketKey(RAFT_TOKEN);
  const signed = await signArtifactContentTicket(key, { ...app.claimsFor(published), nonce: artifactContentTicketNonce() });
  assert.equal((await openSigned(app, published, signed)).served.status, 200);

  const anonymous = app.anonymousBodyFor(published);
  const ticket = await signArtifactContentTicket(key, { ...app.claimsFor(published), viewer: anonymous.viewer, subject: anonymous.subject, nonce: artifactContentTicketNonce() });
  const { served, body } = await openSigned(app, published, ticket);
  assert.equal(served.status, 200, body.slice(0, 200));
  assert.deepEqual(app.raft.authorizeCalls.at(-1)?.body, { artifact: published.artifact, version: published.version, subject: anonymous.subject });
});

test("no RAFT_TOKENS: no ticket opens", async (t) => {
  const app = await setup(t, { RAFT_TOKENS: "" });
  const published = await app.publish({ "index.html": HTML });
  await assertRefused(app, await app.contentFetch(app.openUrl(published, signTicket(app.claimsFor(published))), { headers: frameHeaders }), "no keys");
});

// --- The door (Porthole P125, P126) ---------------------------------------------

/** A door's word, as Porthole's door page carries it: `open`, or the status page's reason. */
async function doorSays(response: Response): Promise<{ status: number; open: boolean; reason: string | null; code: string | null; body: string }> {
  const body = await response.text();
  return {
    status: response.status,
    open: body.includes("data-porthole-door="),
    reason: /data-porthole-reason="([^"]*)"/.exec(body)?.[1] ?? null,
    code: /data-porthole-code="([^"]*)"/.exec(body)?.[1] ?? null,
    body,
  };
}

test("a door ticket Raft signed opens the frame's door once: open, the door's CSP and no cookie, Raft's authorize asked, its own nonce in D1", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const claims = app.claimsFor(published, { door: true });
  const ticket = signTicket(claims);
  const answered = await app.contentFetch(app.doorUrl(published, ticket));
  const csp = answered.headers.get("content-security-policy") ?? "";
  const said = await doorSays(answered);
  assert.equal(said.status, 200, said.body.slice(0, 300));
  assert.ok(said.open, "the door says open");
  assert.ok(!said.body.includes("Raft page"), "nothing of the content");
  assert.match(csp, /sandbox allow-scripts(;|$)/, "the door's sandbox: opaque");
  assert.match(csp, new RegExp(`frame-ancestors ${app.appOrigin.replaceAll(".", "\\.")}`));
  assert.equal(answered.headers.get("cache-control"), "no-store");
  assert.deepEqual(answered.headers.getSetCookie(), []);
  assert.deepEqual(app.raft.authorizeCalls.at(-1)?.body, { artifact: published.artifact, version: published.version, subject: claims.subject });
  assert.deepEqual((await ticketRows(app)).map((row) => row.id), [`raft-open:${claims.nonce}`]);

  const again = await doorSays(await app.contentFetch(app.doorUrl(published, ticket)));
  assert.deepEqual([again.status, again.open, again.reason], [401, false, "session"], "opened twice");
  assert.ok(app.logs.some((line) => line.includes("raft-content.ticket-refused") && line.includes('"opened"') && line.includes('"door":true')));
  assert.ok(!app.logs.some((line) => line.includes(ticket) || line.includes(claims.nonce)), "never the ticket or its nonce in a log");
});

test("the door says what the content would: denied with Raft's code, not-found for a version Raft doesn't give", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const other = await app.publish({ "index.html": HTML });
  app.raft.authorize = { status: 200, body: { allow: false, code: "deleted" } };
  const denied = await doorSays(await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { door: true })))));
  assert.deepEqual([denied.status, denied.reason, denied.code], [403, "denied", "deleted"]);
  app.raft.authorize = { status: 200, body: { allow: true } };
  const missing = await doorSays(await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { door: true, version: other.version })))));
  assert.deepEqual([missing.status, missing.reason], [404, "not-found"]);
  assert.equal(app.r2.requests.length, 0, "the door reads no file");
});

test("a door ticket opens no content, and a content ticket opens no door; a refused door says session", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  await assertRefused(app, await app.contentFetch(app.openUrl(published, signTicket(app.claimsFor(published, { door: true }))), { headers: frameHeaders }), "a door ticket at /_raft/open");
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<[why: string, ticket: string]> = [
    ["a content ticket", signTicket(app.claimsFor(published))],
    ["door: false", signTicket({ ...app.claimsFor(published), door: false })],
    ["expired", signTicket(app.claimsFor(published, { door: true, expires: now - 1 }))],
    ["an unknown kid", signTicket(app.claimsFor(published, { door: true }), "a-token-the-worker-was-never-given-0123456789")],
    ["no ticket", ""],
  ];
  for (const [why, ticket] of cases) {
    const said = await doorSays(await app.contentFetch(app.doorUrl(published, ticket)));
    assert.deepEqual([said.status, said.open, said.reason], [401, false, "session"], why);
  }
  const posted = await doorSays(await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { door: true }))), { method: "POST" }));
  assert.deepEqual([posted.status, posted.reason], [401, "session"], "only GET");
  assert.equal(app.raft.authorizeCalls.length, 0, "Raft is never asked for a refused door");
  assert.deepEqual(await ticketRows(app), [], "nothing is recorded for a refused door");
  // Porthole's own door route answers its own keys; ours is `_raft` alone.
  const theirs = await app.contentFetch(`${app.originOf(published)}/__porthole/door/_raft2?ticket=${signTicket(app.claimsFor(published, { door: true }))}`);
  await theirs.arrayBuffer();
  assert.notEqual(theirs.status, 200);
});

test("the door ticket Porthole's issue mints, beside an open's own or the issue route's, is dropped, never written to D1 nor answered", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML });
  const before = (await ticketRows(app)).length;
  const { served } = await openSigned(app, published, signTicket(app.claimsFor(published)));
  assert.equal(served.status, 200);
  const rows = await ticketRows(app);
  assert.equal(rows.length, before + 1, "only the open's row");
  assert.ok(!rows.some((row) => row.record.includes('"door":true')), "no door ticket in D1");
  // The legacy issue route's too: its content ticket goes to D1 (the store still writes), its door
  // neither to D1 nor into its answer (Raft's server is the only door signer).
  const issued = await app.issue(app.bodyFor(published));
  assert.equal(issued.status, 201);
  const location = (await issued.json()) as Record<string, unknown>;
  assert.equal(location.door, undefined, "the issue route's location carries no door");
  const after = await ticketRows(app);
  assert.equal(after.length, rows.length + 1, "only the issue's content ticket");
  assert.ok(!after.some((row) => row.record.includes('"door":true')), "no door ticket in D1");
});

// A page ticket (#proj-workspace:#272): a reader opened another page of the version from the app's
// Files. Its frame opens at that page instead of the entry, and its door answers for that page.
const ABOUT = `<!doctype html><html><head><title>a</title><link rel="stylesheet" href="../style.css"></head><body><h1>About page</h1></body></html>`;

test("a page ticket opens the version at its page, not the entry: the page's own address below the sealed base, its files beside it", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "docs/about us.html": ABOUT });
  const claims = app.claimsFor(published, { page: "docs/about%20us.html" });
  const ticket = signTicket(claims);
  const { served, body, base } = await openSigned(app, published, ticket);
  assert.equal(served.status, 200, body.slice(0, 300));
  assert.ok(body.includes("About page"), "the page it names");
  assert.ok(!body.includes("Raft page"), "not the entry");
  assert.ok(base, "the frame's sealed files address");
  assert.ok(body.includes(`${base}docs/about%20us.html`), "the frame moves to the page's own address, so its relative links are its own");
  assert.ok(!body.includes(ticket), "the signed ticket is not in the page");
  const style = await app.contentFetch(`${base}style.css`);
  assert.equal(style.status, 200);
  // Raft decided on this load as on an entry's, for the signed subject; the ticket opens once.
  assert.deepEqual(app.raft.authorizeCalls[0]?.body, { artifact: published.artifact, version: published.version, subject: claims.subject });
  assert.deepEqual((await ticketRows(app)).map((row) => row.id), [`raft-open:${claims.nonce}`]);
  await assertRefused(app, await app.contentFetch(app.openUrl(published, ticket), { headers: frameHeaders }), "opened twice");

  // A signed-out visitor's page ticket opens the same way.
  const visitor = await openSigned(app, published, signTicket({ ...app.claimsFor(published, { page: "docs/about%20us.html" }), ...app.anonymousBodyFor(published) }));
  assert.equal(visitor.served.status, 200, visitor.body.slice(0, 300));
  assert.ok(visitor.body.includes("About page"));
});

test("a page ticket's door answers for its page: open for a page of the version, not-found for a file that is none or isn't there", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "about.html": ABOUT });
  const door = async (page: string) => doorSays(await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { door: true, page })))));
  const open = await door("about.html");
  assert.deepEqual([open.status, open.open], [200, true], open.body.slice(0, 300));
  for (const page of ["missing.html", "style.css"]) {
    const said = await door(page);
    assert.deepEqual([said.status, said.open, said.reason], [404, false, "not-found"], page);
    const { served, body } = await openSigned(app, published, signTicket(app.claimsFor(published, { page })));
    assert.equal(served.status, 404, `${page}: ${body.slice(0, 200)}`);
    assert.ok(!body.includes("Raft page") && !body.includes("About page") && !body.includes("color:red"), `${page}: nothing of the version`);
  }
});

test("the Worker refuses a page that is no path below the version, a page on a check ticket, and reads no page from the address", async (t) => {
  const app = await setup(t);
  const published = await app.publish({ "index.html": HTML, "about.html": ABOUT });
  for (const page of ["", "/about.html", "../about.html", "%2e%2e/about.html", "docs//about.html", "about.html?x=1", "about us.html", 1, null, true]) {
    await assertRefused(app, await app.contentFetch(app.openUrl(published, signTicket({ ...app.claimsFor(published), page })), { headers: frameHeaders }), `page ${JSON.stringify(page)}`);
    const said = await doorSays(await app.contentFetch(app.doorUrl(published, signTicket({ ...app.claimsFor(published, { door: true }), page }))));
    assert.deepEqual([said.status, said.open, said.reason], [401, false, "session"], `door, page ${JSON.stringify(page)}`);
  }
  const check = { ...app.claimsFor(published), viewer: "system:check", subject: `v1:check:${published.artifact}:${published.version}` };
  await assertRefused(app, await app.contentFetch(app.openUrl(published, signTicket({ ...check, page: "about.html" })), { headers: frameHeaders }), "a check ticket with a page");
  assert.equal(app.raft.authorizeCalls.length, 0, "Raft is never asked for a refused ticket");
  assert.deepEqual(await ticketRows(app), [], "nothing is recorded for one");
  // Only the signed claim names a page: a `page` in the address is not read, the entry opens.
  const entry = await app.contentFetch(`${app.openUrl(published, signTicket(app.claimsFor(published)))}&page=about.html`, { headers: frameHeaders });
  const body = await entry.text();
  assert.equal(entry.status, 200, body.slice(0, 200));
  assert.ok(body.includes("Raft page") && !body.includes("About page"));
});

// A Markdown file or a PDF that isn't the entry (#proj-workspace:#272): the Worker makes its page
// beside it, as it does for an entry of that kind, and a page ticket opens the frame there.
/** The frame's document as the shell carries it (a JSON string), unescaped enough to read its markup. */
const carried = (body: string) => body.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replaceAll('\\"', '"');

test("a Markdown file and a PDF that aren't the entry open at the page made beside each, with Raft's fonts and pdf.js beside them", async (t) => {
  const app = await setup(t);
  const pdf = samplePdf(["One"]);
  const published = await app.publish({ "index.html": HTML, "docs/release notes.md": "# Release notes\n\nSome *text*.", "reports/q3.pdf": pdf });
  // One rule names the page, for the server that signs the frame and for the Worker that makes it.
  assert.equal(artifactFramedPagePath("docs/release notes.md"), renderedPagePath("docs/release notes.md"));
  assert.equal(artifactFramedPagePath("reports/q3.pdf"), "reports/q3.pdf.html");
  assert.equal(artifactFramedPagePath("index.html"), "index.html");
  assert.equal(artifactFramedPagePath("data.csv"), null);

  const notes = await openSigned(app, published, signTicket(app.claimsFor(published, { page: "docs/release%20notes.md.html" })));
  assert.equal(notes.served.status, 200, notes.body.slice(0, 300));
  const page = carried(notes.body);
  assert.match(page, /<h1 id="release-notes"/, "rendered by the Worker's renderer");
  assert.ok(page.includes("<em>text</em>") && !notes.body.includes("Raft page"), "the file's page, not the entry");
  assert.ok(page.includes("<title>release notes.md</title>"), "named after its file");
  assert.ok(page.includes("url(./../_raft-fonts/space-grotesk-latin.woff2)"), "the fonts by a path relative to the page");
  assert.equal((await app.contentFetch(`${notes.base}_raft-fonts/space-grotesk-latin.woff2`)).status, 200);
  assert.equal((await app.contentFetch(`${notes.base}docs/release%20notes.md`)).headers.get("content-type"), "text/markdown; charset=utf-8", "its source stays beside it");

  const report = await openSigned(app, published, signTicket(app.claimsFor(published, { page: "reports/q3.pdf.html" })));
  assert.equal(report.served.status, 200, report.body.slice(0, 300));
  assert.ok(report.body.includes("../_raft-pdf/pdf.min.mjs") && report.body.includes("./q3.pdf"), "the viewer page, its library and its PDF by relative paths");
  assert.equal((await app.contentFetch(`${report.base}_raft-pdf/pdf.min.mjs`)).status, 200);
  assert.deepEqual(new Uint8Array(await (await app.contentFetch(`${report.base}reports/q3.pdf`)).arrayBuffer()), pdf);

  // The door answers for those pages as the content does; the entry still opens as it did.
  for (const at of ["docs/release%20notes.md.html", "reports/q3.pdf.html"]) {
    const said = await doorSays(await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { door: true, page: at })))));
    assert.deepEqual([said.status, said.open], [200, true], at);
  }
  const entry = await openSigned(app, published, signTicket(app.claimsFor(published)));
  assert.ok(entry.body.includes("Raft page"));
});

test("a page made for a file that isn't the entry fills an empty path only: a version's own files stay where they are", async (t) => {
  const app = await setup(t);
  const published = await app.publish({
    "index.html": HTML,
    "notes.md": "# Rendered heading",
    "notes.md.html": "<!doctype html><p>VERSION OWN PAGE</p>",
    "other.md": "# Other heading",
    "_raft-fonts/space-grotesk-latin.woff2": "VERSION OWN FONT",
    "report.pdf": samplePdf(["One"]),
    "_raft-pdf/pdf.min.mjs": "window.versionOwnPdfjs = 1;",
  });
  const own = await openSigned(app, published, signTicket(app.claimsFor(published, { page: "notes.md.html" })));
  assert.equal(own.served.status, 200, own.body.slice(0, 300));
  assert.ok(own.body.includes("VERSION OWN PAGE") && !carried(own.body).includes("Rendered heading"), "the version's own page at that path");
  const other = await openSigned(app, published, signTicket(app.claimsFor(published, { page: "other.md.html" })));
  assert.match(carried(other.body), /<h1 id="other-heading"/, "a Markdown file with no page of the version's own gets one");
  assert.equal(await (await app.contentFetch(`${other.base}_raft-fonts/space-grotesk-latin.woff2`)).text(), "VERSION OWN FONT", "the version's own file at a font's path");
  assert.equal((await app.contentFetch(`${other.base}_raft-fonts/space-mono-latin-400.woff2`)).status, 200, "Raft's font where the version has none");
  assert.equal(await (await app.contentFetch(`${other.base}_raft-pdf/pdf.min.mjs`)).text(), "window.versionOwnPdfjs = 1;", "the version's own file at a viewer file's path");
  assert.equal((await app.contentFetch(`${other.base}_raft-pdf/pdf.worker.min.mjs`)).status, 200);

  // A version with no Markdown file or PDF beside its entry gets nothing new.
  const plain = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}" });
  const opened = await openSigned(app, plain, signTicket(app.claimsFor(plain)));
  for (const path of ["_raft-fonts/space-grotesk-latin.woff2", "_raft-pdf/pdf.min.mjs", "index.html.html", "style.css.html"]) {
    assert.equal((await app.contentFetch(`${opened.base}${path}`)).status, 404, path);
  }
});
