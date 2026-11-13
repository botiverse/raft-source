import assert from "node:assert/strict";
import test from "node:test";

import { startRaftContent } from "./raftContentHarness";

/**
 * A revocation against an open session (Tenny's review): Porthole reuses Raft's authorize
 * answer for AUTHORIZE_TTL_SECONDS (30 s) per session, then asks again. This waits 31 s in real
 * time (workerd has no fake clock), so it is a file of its own: `node --test` runs each file in
 * its own process. In one process with test/raft-content.test.ts, a later test's request to
 * another Miniflare could hang after this one's idle wait (also with a bare open, fetch and wait,
 * none of the Worker's code involved): a harness effect, kept apart here.
 */

const HTML = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1>Raft page</h1><script src="app.js"></script></body></html>`;

test("an open session is refused once the 30 s authorize answer expires and Raft says deny", async (t) => {
  const app = await startRaftContent();
  t.after(() => app.close());
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{color:red}", "app.js": "document.title='ran'" });
  const issued = await app.issue(app.bodyFor(published));
  assert.equal(issued.status, 201, await issued.clone().text());
  const location = (await issued.json()) as { url: string; origin: string };
  const served = await app.contentFetch(location.url, { headers: { "sec-fetch-dest": "iframe" } });
  const body = await served.text();
  const base = new RegExp(`${location.origin.replaceAll(".", "\\.")}/__porthole/f/[A-Za-z0-9_-]+/`).exec(body)?.[0] ?? null;
  assert.ok(base, "the frame's sealed files address");
  assert.equal(served.status, 200);
  const style = await app.contentFetch(`${base}style.css`);
  assert.equal(style.status, 200);
  // A file once loaded is the browser's for a year: only requests that reach the Worker are asked about.
  assert.equal(style.headers.get("cache-control"), "private, max-age=31536000, immutable");
  // Raft revokes: within the session's 30 s the cached allow still answers, and Raft is not asked.
  const askedAt = app.raft.authorizeCalls.length;
  app.raft.authorize = { status: 200, body: { allow: false, code: "not-visible" } };
  assert.equal((await app.contentFetch(`${base}app.js`)).status, 200, "the cached answer, inside 30 s");
  assert.equal(app.raft.authorizeCalls.length, askedAt);
  // Past AUTHORIZE_TTL_SECONDS the session's next request asks Raft again, and is refused.
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  const refused = await app.contentFetch(`${base}style.css`);
  assert.equal(refused.status, 403);
  assert.ok((await refused.text()).includes("not-visible"));
  assert.equal(app.raft.authorizeCalls.length, askedAt + 1, "Raft asked again once the answer expired");
  assert.equal((await app.contentFetch(`${base}app.js`)).status, 403, "the deny holds for the session");
});
