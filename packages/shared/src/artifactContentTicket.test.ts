// The content ticket's format and checks (artifactContentTicket.ts): what
// Raft's server signs and the content Worker verifies. The Worker's own tests
// (packages/content-worker) open tickets signed apart from this code.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  ARTIFACT_CONTENT_CHECK_VIEWER,
  artifactContentTicketKey,
  artifactContentTicketNonce,
  artifactContentTicketPage,
  isArtifactContentTicketPage,
  signArtifactContentTicket,
  verifyArtifactContentTicket,
  type ArtifactContentTicketClaims,
} from "./artifactContentTicket";

const CURRENT = "c".repeat(40);
const PREVIOUS = "p".repeat(40);
const ARTIFACT = "pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a";
const ORIGIN = "https://w-0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a.w.example.test";
const NOW = 1_800_000_000_000;

const claims = (overrides: Partial<ArtifactContentTicketClaims> = {}): ArtifactContentTicketClaims => ({
  artifact: ARTIFACT,
  version: "v_1a2b3c4d-0000-4000-8000-000000000001",
  viewer: "user:11111111-1111-4111-8111-111111111111",
  subject: "v1:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111:-",
  origin: ORIGIN,
  expires: NOW / 1000 + 60,
  nonce: artifactContentTicketNonce(),
  ...overrides,
});

test("a ticket verifies with its key, and with the current and previous keys listed; the kid is the secret's, derived", async () => {
  const [current, previous] = await Promise.all([artifactContentTicketKey(CURRENT), artifactContentTicketKey(PREVIOUS)]);
  assert.match(current.kid, /^[A-Za-z0-9_-]{12}$/);
  assert.notEqual(current.kid, previous.kid);
  // The kid is HMAC-SHA-256 of a label under the secret, never the secret or its plain hash.
  const expectedKid = createHmac("sha256", CURRENT).update("raft/artifact-content-ticket/kid/v1").digest().subarray(0, 9).toString("base64url");
  assert.equal(current.kid, expectedKid);
  const said = claims();
  for (const [why, key] of [["current", current], ["previous", previous]] as const) {
    const ticket = await signArtifactContentTicket(key, said);
    assert.equal(ticket.split(".")[1], key.kid, why);
    assert.ok(!ticket.includes(CURRENT) && !ticket.includes(PREVIOUS), "never the secret");
    assert.deepEqual(await verifyArtifactContentTicket(ticket, [previous, current], { origin: ORIGIN, now: NOW }), { ok: true, claims: said }, why);
  }
  assert.deepEqual(
    await verifyArtifactContentTicket(await signArtifactContentTicket(previous, said), [current], { origin: ORIGIN, now: NOW }),
    { ok: false, reason: "unknown-kid" },
    "the previous key removed",
  );
});

test("each refusal, in order: format, kid, MAC, expiry, lifetime, origin, the Artifact's own label", async () => {
  const key = await artifactContentTicketKey(CURRENT);
  const good = await signArtifactContentTicket(key, claims());
  const [prefix, kid, payload, mac] = good.split(".") as [string, string, string, string];
  const forged = (await signArtifactContentTicket(key, claims({ viewer: "anonymous" }))).split(".")[2]!;
  const refused = async (ticket: string, origin = ORIGIN) => {
    const answer = await verifyArtifactContentTicket(ticket, [key], { origin, now: NOW });
    return answer.ok ? "ok" : answer.reason;
  };
  assert.equal(await refused(good), "ok");
  assert.equal(await refused(""), "malformed");
  assert.equal(await refused(`rct2.${kid}.${payload}.${mac}`), "malformed");
  assert.equal(await refused(`${prefix}.${kid}.${payload}`), "malformed");
  assert.equal(await refused(`${prefix}.other-kid000.${payload}.${mac}`), "unknown-kid");
  assert.equal(await refused(`${prefix}.${kid}.${forged}.${mac}`), "bad-signature");
  assert.equal(await refused(`${prefix}.${kid}.${payload}.${mac.slice(0, -4)}AAAA`), "bad-signature");
  assert.equal(await refused(`${prefix}.${kid}.${payload}.not+base64`), "bad-signature");
  assert.equal(await refused(await signArtifactContentTicket(key, claims({ expires: NOW / 1000 }))), "expired");
  assert.equal(await refused(await signArtifactContentTicket(key, claims({ expires: NOW / 1000 + 301 }))), "too-long");
  assert.equal(await refused(good, ORIGIN.replace("https:", "http:")), "wrong-origin");
  assert.equal(await refused(good, "https://w-0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5b.w.example.test"), "wrong-origin");
  const otherOrigin = "https://w-99999999-8f5d-4a52-9d2e-0f1e2d3c4b5a.w.example.test";
  assert.equal(await refused(await signArtifactContentTicket(key, claims({ origin: otherOrigin })), otherOrigin), "wrong-artifact");
  // A secret under 32 bytes makes no key.
  await assert.rejects(artifactContentTicketKey("short"));
});

// A publish check's ticket (viewer system:check) is opened top-level by the
// check's headless browser (Tenny's design change, task #130): it names no
// ancestor, as no ticket does. The signer signs it without one and refuses it
// with one; the verifier refuses any ticket that carries one, under a good MAC.
describe("the check ticket names no ancestor", () => {
  const ANCESTOR = "https://check.example.test";
  const check = (overrides: Partial<ArtifactContentTicketClaims> = {}) => claims({
    viewer: ARTIFACT_CONTENT_CHECK_VIEWER,
    subject: "v1:check:pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a:v_1a2b3c4d-0000-4000-8000-000000000001",
    ...overrides,
  });
  /** `claims` with an `ancestor` beside them, as the old check signer wrote them (the type no longer has one). */
  const withAncestor = (said: ArtifactContentTicketClaims, ancestor: unknown = ANCESTOR) => ({ ...said, ancestor }) as unknown as ArtifactContentTicketClaims;

  test("a check ticket without an ancestor is signed and verified like any other, its payload exactly the claims", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    const said = check();
    const ticket = await signArtifactContentTicket(key, said);
    assert.deepEqual(await verifyArtifactContentTicket(ticket, [key], { origin: ORIGIN, now: NOW }), { ok: true, claims: said });
    const payload = JSON.parse(Buffer.from(ticket.split(".")[2]!, "base64url").toString()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["artifact", "expires", "nonce", "origin", "subject", "version", "viewer"]);
    // Reverse control: a reader's ticket, unchanged.
    const reader = claims();
    assert.deepEqual(await verifyArtifactContentTicket(await signArtifactContentTicket(key, reader), [key], { origin: ORIGIN, now: NOW }), { ok: true, claims: reader });
  });

  test("the signer refuses a check ticket with an ancestor, any other ticket with one, and any field beyond the claims", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    await assert.rejects(signArtifactContentTicket(key, withAncestor(check())), /no ticket names an ancestor/);
    await assert.rejects(signArtifactContentTicket(key, withAncestor(check(), undefined)), /no ticket names an ancestor/, "even an undefined one");
    await assert.rejects(signArtifactContentTicket(key, withAncestor(claims())), /no ticket names an ancestor/, "a reader's");
    await assert.rejects(signArtifactContentTicket(key, withAncestor(claims({ viewer: "anonymous" }))), /no ticket names an ancestor/, "an anonymous one");
    await assert.rejects(signArtifactContentTicket(key, { ...check(), level: "edit" } as unknown as ArtifactContentTicketClaims), /exactly its claims/);
  });

  test("claims with an ancestor are malformed even under a good MAC, a check's first of all", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    // Sign the claims as a buggy (or the old) signer would (the payload as it is), with the real key.
    const raw = async (body: Record<string, unknown>) => {
      const signed = `rct1.${key.kid}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
      const mac = Buffer.from(await crypto.subtle.sign("HMAC", key.key, new TextEncoder().encode(signed))).toString("base64url");
      return `${signed}.${mac}`;
    };
    const verify = async (ticket: string) => {
      const answer = await verifyArtifactContentTicket(ticket, [key], { origin: ORIGIN, now: NOW });
      return answer.ok ? "ok" : answer.reason;
    };
    assert.equal(await verify(await raw({ ...check(), ancestor: ANCESTOR })), "malformed", "a check ticket with an ancestor");
    assert.equal(await verify(await raw({ ...check(), ancestor: null })), "malformed", "a null one");
    assert.equal(await verify(await raw({ ...claims(), ancestor: ANCESTOR })), "malformed", "a reader's ticket with an ancestor");
    assert.equal(await verify(await raw({ ...claims({ viewer: "anonymous" }), ancestor: ANCESTOR })), "malformed", "an anonymous ticket with an ancestor");
    assert.equal(await verify(await raw({ ...check() })), "ok", "witness: the same check ticket without one");
  });
});

// A door ticket (Porthole P125, P126) is a reader's or a visitor's claims
// with `door: true`: the one field a ticket may carry beyond the seven claims,
// and only as `true`. A check ticket never has one.
describe("the door ticket (Porthole P125, P126)", () => {
  const check = (overrides: Partial<ArtifactContentTicketClaims> = {}) => claims({
    viewer: ARTIFACT_CONTENT_CHECK_VIEWER,
    subject: "v1:check:pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a:v_1a2b3c4d-0000-4000-8000-000000000001",
    ...overrides,
  });
  // Sign the claims as a buggy signer would (the payload as it is), with the real key.
  const raw = async (key: Awaited<ReturnType<typeof artifactContentTicketKey>>, body: Record<string, unknown>) => {
    const signed = `rct1.${key.kid}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
    const mac = Buffer.from(await crypto.subtle.sign("HMAC", key.key, new TextEncoder().encode(signed))).toString("base64url");
    return `${signed}.${mac}`;
  };

  test("signed and verified with door: true, for a reader and a visitor, its payload the claims and door; a content ticket has no door", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    for (const said of [
      claims({ door: true }),
      claims({ door: true, viewer: "anonymous", subject: "v1:anon:pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a:v_1a2b3c4d-0000-4000-8000-000000000001" }),
    ]) {
      const ticket = await signArtifactContentTicket(key, said);
      assert.deepEqual(await verifyArtifactContentTicket(ticket, [key], { origin: ORIGIN, now: NOW }), { ok: true, claims: said });
      const payload = JSON.parse(Buffer.from(ticket.split(".")[2]!, "base64url").toString()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(payload).sort(), ["artifact", "door", "expires", "nonce", "origin", "subject", "version", "viewer"]);
    }
    const content = await signArtifactContentTicket(key, claims());
    assert.equal(Object.hasOwn(JSON.parse(Buffer.from(content.split(".")[2]!, "base64url").toString()), "door"), false, "absent, not false");
  });

  test("the signer refuses a door on a check ticket, a door other than true, and a door beside an ancestor", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    await assert.rejects(signArtifactContentTicket(key, check({ door: true })), /a door ticket/, "a check's door");
    for (const door of [false, "true", 1, null, undefined]) {
      await assert.rejects(signArtifactContentTicket(key, { ...claims(), door } as unknown as ArtifactContentTicketClaims), /a door ticket/, JSON.stringify(door) ?? "undefined");
    }
    await assert.rejects(signArtifactContentTicket(key, { ...claims({ door: true }), ancestor: "https://check.example.test" } as unknown as ArtifactContentTicketClaims), /no ticket names an ancestor/);
    await assert.rejects(signArtifactContentTicket(key, { ...claims({ door: true }), level: "edit" } as unknown as ArtifactContentTicketClaims), /exactly its claims/);
  });

  test("a check ticket with a door is malformed under a good MAC; the strict-fields verifier takes door only as true", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    const verify = async (ticket: string) => {
      const answer = await verifyArtifactContentTicket(ticket, [key], { origin: ORIGIN, now: NOW });
      return answer.ok ? "ok" : answer.reason;
    };
    assert.equal(await verify(await raw(key, { ...check(), door: true })), "malformed", "a check's door");
    assert.equal(await verify(await raw(key, { ...check() })), "ok", "witness: the same check ticket without one");
    for (const door of [false, "true", 1, 0, null, {}, [true]]) assert.equal(await verify(await raw(key, { ...claims(), door })), "malformed", JSON.stringify(door));
    assert.equal(await verify(await raw(key, { ...claims(), door: true, ancestor: "https://check.example.test" })), "malformed", "a door does not open the field set further");
    assert.equal(await verify(await raw(key, { ...claims(), door: true, level: "edit" })), "malformed", "nor any other field");
    assert.equal(await verify(await raw(key, { ...claims(), door: true })), "ok", "a reader's door");
    assert.equal(await verify(await raw(key, { ...claims({ viewer: "anonymous" }), door: true })), "ok", "a visitor's door");
  });
});

// A page ticket (#proj-workspace:#272) is a reader's or a visitor's claims with `page`: the page of
// the version's files the frame opens at instead of the entry. Its door ticket says the same page.
// A check ticket never has one.
describe("the page ticket", () => {
  const check = (overrides: Partial<ArtifactContentTicketClaims> = {}) => claims({
    viewer: ARTIFACT_CONTENT_CHECK_VIEWER,
    subject: "v1:check:pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a:v_1a2b3c4d-0000-4000-8000-000000000001",
    ...overrides,
  });
  // Sign the claims as a buggy signer would (the payload as it is), with the real key.
  const raw = async (key: Awaited<ReturnType<typeof artifactContentTicketKey>>, body: Record<string, unknown>) => {
    const signed = `rct1.${key.kid}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
    const mac = Buffer.from(await crypto.subtle.sign("HMAC", key.key, new TextEncoder().encode(signed))).toString("base64url");
    return `${signed}.${mac}`;
  };
  const BAD_PAGES = ["", "/about.html", "docs//about.html", "docs/", "../about.html", "docs/../about.html", "./about.html", "%2e%2e/about.html", "docs/%2E/about.html", "about.html?x=1", "about.html#top", "about us.html", "关于.html", "a\\b.html", "x".repeat(2_049)];

  test("a file's path as a page: each segment percent-encoded; null for a path no address names", () => {
    assert.equal(artifactContentTicketPage("about.html"), "about.html");
    assert.equal(artifactContentTicketPage("docs/about us.html"), "docs/about%20us.html");
    assert.equal(artifactContentTicketPage("docs/关于?#.html"), "docs/%E5%85%B3%E4%BA%8E%3F%23.html");
    assert.equal(artifactContentTicketPage("a%2e/b.html"), "a%252e/b.html", "a literal percent is escaped, never read as an escape");
    for (const path of ["", "/about.html", "docs//about.html", "docs/", "..", "docs/../about.html", "./about.html", "\ud800.html", "长".repeat(300)]) {
      assert.equal(artifactContentTicketPage(path), null, JSON.stringify(path.slice(0, 20)));
    }
    for (const page of ["about.html", "docs/about%20us.html", "a/b/c.html", "..a/b...html"]) assert.equal(isArtifactContentTicketPage(page), true, page);
    for (const page of [...BAD_PAGES, undefined, null, 1, true, ["about.html"]]) assert.equal(isArtifactContentTicketPage(page), false, JSON.stringify(page)?.slice(0, 30));
  });

  test("signed and verified with its page, alone and on a door ticket, for a reader and a visitor; a ticket for the entry has no page", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    const visitor = { viewer: "anonymous", subject: "v1:anon:pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a:v_1a2b3c4d-0000-4000-8000-000000000001" };
    for (const [said, keys] of [
      [claims({ page: "docs/about%20us.html" }), ["artifact", "expires", "nonce", "origin", "page", "subject", "version", "viewer"]],
      [claims({ page: "about.html", door: true }), ["artifact", "door", "expires", "nonce", "origin", "page", "subject", "version", "viewer"]],
      [claims({ page: "about.html", ...visitor }), ["artifact", "expires", "nonce", "origin", "page", "subject", "version", "viewer"]],
      [claims({ page: "about.html", door: true, ...visitor }), ["artifact", "door", "expires", "nonce", "origin", "page", "subject", "version", "viewer"]],
    ] as const) {
      const ticket = await signArtifactContentTicket(key, said);
      assert.deepEqual(await verifyArtifactContentTicket(ticket, [key], { origin: ORIGIN, now: NOW }), { ok: true, claims: said });
      // The payload's keys in the order they are signed: sorted, so a verifier reads one spelling.
      assert.deepEqual(Object.keys(JSON.parse(Buffer.from(ticket.split(".")[2]!, "base64url").toString()) as object), keys);
    }
    const entry = await signArtifactContentTicket(key, claims());
    assert.equal(Object.hasOwn(JSON.parse(Buffer.from(entry.split(".")[2]!, "base64url").toString()), "page"), false, "absent, not empty");
  });

  test("the signer refuses a page on a check ticket and anything that isn't a page", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    await assert.rejects(signArtifactContentTicket(key, check({ page: "about.html" })), /a page ticket/, "a check's page");
    for (const page of [...BAD_PAGES, undefined, null, 1]) {
      await assert.rejects(signArtifactContentTicket(key, { ...claims(), page } as unknown as ArtifactContentTicketClaims), /a page ticket/, JSON.stringify(page)?.slice(0, 30) ?? "undefined");
    }
    await assert.rejects(signArtifactContentTicket(key, { ...claims({ page: "about.html" }), level: "edit" } as unknown as ArtifactContentTicketClaims), /exactly its claims/);
  });

  test("under a good MAC: a check ticket with a page, a page that isn't one and any further field are malformed", async () => {
    const key = await artifactContentTicketKey(CURRENT);
    const verify = async (ticket: string) => {
      const answer = await verifyArtifactContentTicket(ticket, [key], { origin: ORIGIN, now: NOW });
      return answer.ok ? "ok" : answer.reason;
    };
    assert.equal(await verify(await raw(key, { ...check(), page: "about.html" })), "malformed", "a check's page");
    for (const page of [...BAD_PAGES, null, 1, true, ["about.html"]]) assert.equal(await verify(await raw(key, { ...claims(), page })), "malformed", JSON.stringify(page).slice(0, 30));
    assert.equal(await verify(await raw(key, { ...claims(), page: "about.html", ancestor: "https://check.example.test" })), "malformed", "a page does not open the field set further");
    assert.equal(await verify(await raw(key, { ...claims(), page: "about.html", level: "edit" })), "malformed", "nor any other field");
    assert.equal(await verify(await raw(key, { ...claims(), page: "about.html" })), "ok", "a reader's page");
    assert.equal(await verify(await raw(key, { ...claims(), page: "about.html", door: true })), "ok", "its door");
    assert.equal(await verify(await raw(key, { ...claims({ viewer: "anonymous" }), page: "about.html" })), "ok", "a visitor's page");
  });
});
