import assert from "node:assert/strict";
import test from "node:test";

import { appOriginsOf, DESKTOP_APP_ORIGIN, extraAppOriginsOf, framedByOriginsOf } from "../src/appOrigins";
import { signTicket, startRaftContent, type RaftContentApp } from "./raftContentHarness";

/**
 * EXTRA_APP_ORIGINS (src/appOrigins.ts): Raft's other clients that frame pages, Raft Desktop's
 * `app://raft` first among them. Each is a frame ancestor beside APP_ORIGIN and an origin the
 * shell takes messages from (its plan's `origins`); a bad entry fails closed.
 *
 * FRAMED_BY_ORIGINS: Deck, which frames the Raft app itself. An ancestor of every page above the
 * app (Porthole's `framedBy`, P141), in `frame-ancestors` after the app origins, and never an
 * origin the shell or a door hears or tells; a bad entry fails closed too.
 */

const HTML = `<!doctype html><html><head><title>t</title></head><body><h1>Raft page</h1></body></html>`;
const frameHeaders = { "sec-fetch-dest": "iframe" };

async function setup(t: test.TestContext, bindings?: Record<string, string>) {
  const app = await startRaftContent(bindings ? { bindings } : {});
  t.after(() => app.close());
  return app;
}

const frameAncestorsOf = (response: Response) =>
  /(?:^|;)\s*frame-ancestors\s+([^;]*)/.exec(response.headers.get("content-security-policy") ?? "")?.[1]?.trim().split(/\s+/) ?? [];

/** The shell's plan, as the page carries it (a JSON object in the document). */
function planOriginsOf(body: string): string[] {
  const match = /"origins":(\[[^\]]*\])/.exec(body.replaceAll('\\"', '"'));
  assert.ok(match, `the shell's plan names its origins: ${body.slice(0, 300)}`);
  return JSON.parse(match[1]!) as string[];
}

async function openFrame(app: RaftContentApp) {
  const published = await app.publish({ "index.html": HTML });
  const ticket = signTicket(app.claimsFor(published));
  const served = await app.contentFetch(app.openUrl(published, ticket), { headers: frameHeaders });
  // Read each body before awaiting anything else: Miniflare wraps undici's response, and undici
  // cancels the dropped original's body when it is garbage collected, so a body left unread
  // across another await can read as "already read".
  const body = await served.text();
  const again = await app.contentFetch(app.openUrl(published, ticket), { headers: frameHeaders });
  await again.text();
  return { served, body, again };
}

test("EXTRA_APP_ORIGINS takes exact https origins and app://raft only, after APP_ORIGIN, without repeats", () => {
  assert.equal(DESKTOP_APP_ORIGIN, "app://raft");
  assert.deepEqual(extraAppOriginsOf(undefined), []);
  assert.deepEqual(extraAppOriginsOf(" , "), []);
  assert.deepEqual(extraAppOriginsOf("app://raft, https://desk.example.com ,app://raft"), ["app://raft", "https://desk.example.com"]);
  assert.deepEqual(appOriginsOf("https://app.example.com", "app://raft,https://app.example.com"), ["https://app.example.com", "app://raft"]);
  assert.deepEqual(appOriginsOf("https://app.example.com", undefined), ["https://app.example.com"]);
  for (const junk of [
    "http://x",
    "*",
    "app://evil",
    "app://raft/",
    "APP://RAFT",
    "app://raft:1",
    "null",
    "file:///",
    "https://*.example.com",
    "https://desk.example.com/",
    "https://desk.example.com/path",
    "https://user@desk.example.com",
    "https://DESK.example.com",
    "ws://desk.example.com",
    "desk.example.com",
    // As Porthole 0.15.1 (P145) refuses them: a port outside 1-65535 or with a leading zero, a
    // host the URL parser rewrites; a default port isn't the origin a browser sends either.
    "https://desk.example.com:0",
    "https://desk.example.com:0443",
    "https://desk.example.com:99999",
    "https://desk.example.com:443",
    "https://0x7f.0.0.1",
  ])
    assert.throws(() => extraAppOriginsOf(`app://raft,${junk}`), /EXTRA_APP_ORIGINS/, junk);
});

test("with EXTRA_APP_ORIGINS=app://raft, the frame's page may be framed by the app and the desktop, and its shell hears both", async (t) => {
  const app = await setup(t, { EXTRA_APP_ORIGINS: "app://raft" });
  const { served, body, again } = await openFrame(app);
  assert.equal(served.status, 200, body.slice(0, 300));
  assert.deepEqual(frameAncestorsOf(served), [app.appOrigin, "app://raft"]);
  assert.deepEqual(planOriginsOf(body), [app.appOrigin, "app://raft"]);
  // The Worker's own refusal page (a ticket opened twice) is framed and told to the same origins.
  assert.equal(again.status, 401);
  assert.deepEqual(frameAncestorsOf(again), [app.appOrigin, "app://raft"]);
});

test("a bad EXTRA_APP_ORIGINS serves nothing: the generic 503, the reason in the log only", async (t) => {
  for (const junk of ["http://x", "*", "app://evil"]) {
    const app = await setup(t, { EXTRA_APP_ORIGINS: `app://raft,${junk}` });
    const published = await app.publish({ "index.html": HTML });
    const page = await app.contentFetch(app.openUrl(published, signTicket(app.claimsFor(published))), { headers: frameHeaders });
    assert.equal(page.status, 503, junk);
    assert.equal(await page.text(), "Content is unavailable.", junk);
    assert.ok(app.logs.some((line) => line.includes("misconfigured") && line.includes("EXTRA_APP_ORIGINS")), app.logs.join(" | "));
    assert.equal((await app.issue(app.bodyFor(published))).status, 503, `${junk}: the issue route too`);
  }
});

const DECK = "https://deck.example.com";

test("FRAMED_BY_ORIGINS takes exact https origins only, none an app origin, without repeats", () => {
  assert.deepEqual(framedByOriginsOf(undefined), []);
  assert.deepEqual(framedByOriginsOf(" , "), []);
  assert.deepEqual(framedByOriginsOf(`${DECK}, https://deck-dev.example.com ${DECK}`), [DECK, "https://deck-dev.example.com"]);
  assert.deepEqual(framedByOriginsOf("https://deck.example.com:8443"), ["https://deck.example.com:8443"]);
  for (const junk of ["app://raft", "http://deck.example.com", "*", "'self'", "null", "https://*.example.com", "https://deck.example.com/", "https://DECK.example.com", "https://user@deck.example.com", "deck.example.com", "https://deck.example.com:0", "https://deck.example.com:0443", "https://deck.example.com:99999", "https://deck.example.com:443", "https://0x7f.0.0.1"])
    assert.throws(() => framedByOriginsOf(`${DECK},${junk}`), /FRAMED_BY_ORIGINS/, junk);
  assert.throws(() => framedByOriginsOf("https://app.example.com", ["https://app.example.com", "app://raft"]), /app origin already/);
});

test("with FRAMED_BY_ORIGINS, Deck may be an ancestor of the page, the refusal page and the door, and is never an origin the shell or door talks to", async (t) => {
  const app = await setup(t, { EXTRA_APP_ORIGINS: "app://raft", FRAMED_BY_ORIGINS: DECK });
  const { served, body, again } = await openFrame(app);
  assert.equal(served.status, 200, body.slice(0, 300));
  assert.deepEqual(frameAncestorsOf(served), [app.appOrigin, "app://raft", DECK]);
  // The shell's plan: whom it takes messages from. The app origins alone.
  assert.deepEqual(planOriginsOf(body), [app.appOrigin, "app://raft"]);
  assert.ok(!body.includes("deck.example.com"), "Deck is in the header alone");
  assert.equal(again.status, 401);
  assert.deepEqual(frameAncestorsOf(again), [app.appOrigin, "app://raft", DECK]);

  const published = await app.publish({ "index.html": HTML });
  const door = await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { door: true }))));
  const doorBody = await door.text();
  assert.equal(door.status, 200, doorBody.slice(0, 300));
  assert.deepEqual(frameAncestorsOf(door), [app.appOrigin, "app://raft", DECK]);
  assert.match(doorBody, /data-porthole-hosts="([^"]*)"/);
  assert.ok(!doorBody.includes("deck.example.com"), "never in the door's data-porthole-hosts");
  // A desktop scheme is a host origin, so the door's `*` fallback is live: held to a parent named as a host.
  assert.ok(doorBody.includes("data-porthole-strict-parent"));
  const usedDoor = await app.contentFetch(app.doorUrl(published, signTicket(app.claimsFor(published, { door: true }))));
  const usedBody = await usedDoor.text();
  assert.deepEqual(frameAncestorsOf(usedDoor), [app.appOrigin, "app://raft", DECK]);
  assert.ok(!usedBody.includes("deck.example.com"));
});

test("a bad FRAMED_BY_ORIGINS serves nothing: the generic 503, the reason in the log only", async (t) => {
  for (const junk of ["app://raft", "https://*.example.com", "http://deck.example.com"]) {
    const app = await setup(t, { FRAMED_BY_ORIGINS: `${DECK},${junk}` });
    const published = await app.publish({ "index.html": HTML });
    const page = await app.contentFetch(app.openUrl(published, signTicket(app.claimsFor(published))), { headers: frameHeaders });
    assert.equal(page.status, 503, junk);
    assert.equal(await page.text(), "Content is unavailable.", junk);
    assert.ok(app.logs.some((line) => line.includes("misconfigured") && line.includes("FRAMED_BY_ORIGINS")), app.logs.join(" | "));
  }
});
