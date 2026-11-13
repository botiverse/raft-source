import assert from "node:assert/strict";
import test from "node:test";

import { startRaftContent } from "./raftContentHarness";

/**
 * The takedown bound end to end for an open embed session (Tenny's review of #13989). Porthole keeps
 * each session's authorize answer for AUTHORIZE_TTL_SECONDS (30 s) from when it got it, and the Worker
 * reuses Raft's answer for an embed subject across sessions for EMBED_AUTHORIZE_TTL_SECONDS (30 s).
 * Stacked, a session that took a 20 s old memo would keep it 50 s; the Worker drops Porthole's copies
 * of a subject the moment its memo expires, so every request is refused within 30 s of Raft's change.
 * Waits ~31 s in real time (workerd has no fake clock): a file of its own, as
 * raft-content-authorize-expiry.test.ts.
 */

const HTML = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="style.css"></head><body><h1>Embedded page</h1></body></html>`;
const embedFrameHeaders = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" };
const sleepUntil = (at: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));

test("a session that took a late memo is refused within 30 s of Raft's deny: the caches never stack", async (t) => {
  const app = await startRaftContent({ embeds: true });
  t.after(() => app.close());
  const published = await app.publish({ "index.html": HTML, "style.css": "h1{}" });
  app.embedPublic(published);
  const open = async () => {
    const served = await app.contentFetch(app.embedOpenUrl(published), { headers: embedFrameHeaders });
    const body = await served.text();
    assert.equal(served.status, 200, body.slice(0, 200));
    return new RegExp(`${app.originOf(published).replaceAll(".", "\\.")}/__porthole/f/[A-Za-z0-9_-]+/`).exec(body)![0];
  };
  // t0: the first viewer; Raft is asked once, its allow kept as the subject's memo.
  const t0 = Date.now();
  await open();
  assert.equal(app.raft.authorizeCalls.length, 1);
  // Raft now says no (unpublished, taken down).
  app.raft.authorize = { status: 200, body: { allow: false, code: "not-public" } };
  // t0 + 20 s: a second viewer opens. Its session takes the memo's allow (20 s old), Raft unasked.
  await sleepUntil(t0 + 20_000);
  const late = await open();
  assert.equal(app.raft.authorizeCalls.length, 1, "the memo answered");
  assert.equal((await app.contentFetch(`${late}style.css`)).status, 200, "inside the memo's life");
  // Past t0 + 30 s (the memo's end) the late session is refused, though Porthole got its copy 10 s ago.
  await sleepUntil(t0 + 30_500);
  const refused = await app.contentFetch(`${late}style.css`);
  assert.equal(refused.status, 403, "refused within the bound, not at t0 + 50 s");
  assert.ok(Date.now() - t0 < 32_000);
  assert.equal(app.raft.authorizeCalls.length, 2, "Raft asked again once");
});
