import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  LINK_CARD_TOKEN_MAX_TTL_SECONDS, linkCardActionEndpointSha256, linkCardExecuteJti, linkCardMessageContentSha256, nativeInstallationKey, newLinkCardViewNonce,
  linkCardSelectorMatchesHandle, readLinkCardHandleSelector, signLinkCardHandle, signLinkCardOperationsCursor, signLinkCardReadTicket, verifyLinkCardHandle,
  verifyLinkCardOperationsCursor, verifyLinkCardReadTicket,
  type LinkCardHandleClaims, type LinkCardOperationsCursorClaims, type LinkCardReadTicketClaims, type LinkCardViewBinding,
} from "./linkCardTokens";

beforeAll(() => { process.env.JWT_SECRET ??= "link-card-token-test-secret-at-least-32-bytes"; });

const now = new Date("2026-10-20T22:00:00Z");
const iat = Math.floor(now.getTime() / 1000);
const binding: LinkCardViewBinding = {
  viewerId: "u1", serverId: "s1", providerKind: "app", providerKey: "vault-50e32c", installationKey: "inst-1",
  messageId: "m1", urlSha256: "a".repeat(64), registrationRevision: "rev-1", capabilities: ["card.v2", "button.v1"],
};
const ticketClaims: LinkCardReadTicketClaims = { viewInstanceId: "view-1", viewNonce: newLinkCardViewNonce(), epoch: 1, binding, iat, exp: iat + 600 };
const handleClaims: LinkCardHandleClaims = {
  ...ticketClaims, actionId: "approve", cardRevision: "cr-1", businessRevision: "br-1", descriptorSha256: "d".repeat(64), messageContentSha256: "c".repeat(64),
  requiresPrepare: true,
};
const sorted = { ...binding, capabilities: ["button.v1", "card.v2"] };

test("a read ticket and a handle round-trip with the identity domain in the clear", () => {
  const ticket = signLinkCardReadTicket(ticketClaims);
  const handle = signLinkCardHandle(handleClaims);
  assert.deepEqual(verifyLinkCardReadTicket(ticket, now), { ...ticketClaims, binding: sorted });
  const verified = verifyLinkCardHandle(handle, now);
  assert.ok(verified);
  assert.deepEqual(verified.claims, { ...handleClaims, binding: sorted });
  assert.equal(verified.handle, handle);
  assert.match(verified.handleSha256, /^[0-9a-f]{64}$/);
  // Execute looks up the client request by the domain before anything else (RFC 076 §3.5).
  assert.equal(verified.claims.binding.installationKey, "inst-1");
});

test("a ticket never verifies as a handle, nor a handle as a ticket", () => {
  assert.equal(verifyLinkCardHandle(signLinkCardReadTicket(ticketClaims), now), null);
  assert.equal(verifyLinkCardReadTicket(signLinkCardHandle(handleClaims), now), null);
});

test("each token has exactly one valid spelling, so its SHA-256 is stable for one-time use", () => {
  const handle = signLinkCardHandle(handleClaims);
  const last = handle.at(-1)!;
  const flipped = `${handle.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  for (const variant of [`${handle}=`, `${handle}==`, `${handle}=x`, `${handle} `, ` ${handle}`, flipped, handle.toUpperCase()]) {
    assert.equal(verifyLinkCardHandle(variant, now), null, JSON.stringify(variant.slice(-4)));
  }
});

test("tampering, expiry, a future iat and over-long lifetimes fail closed", () => {
  const handle = signLinkCardHandle(handleClaims);
  const [v, kid, payload, mac] = handle.split(".");
  const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
  forged.businessRevision = "br-2";
  assert.equal(verifyLinkCardHandle(`${v}.${kid}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`, now), null, "a changed claim breaks the MAC");
  assert.equal(verifyLinkCardHandle(handle, new Date((iat + 600) * 1000)), null, "expired at exp");
  assert.ok(verifyLinkCardHandle(handle, new Date((iat + 599) * 1000)));
  assert.equal(verifyLinkCardHandle(handle, new Date((iat - 31) * 1000)), null, "issued in the future beyond the skew");
  assert.ok(verifyLinkCardHandle(handle, new Date((iat - 30) * 1000)));
  assert.throws(() => signLinkCardHandle({ ...handleClaims, exp: iat + LINK_CARD_TOKEN_MAX_TTL_SECONDS + 1 }), RangeError);
  for (const junk of [undefined, 42, "", "v1.k1.", "v2.k1.x.y", "x".repeat(5000)]) assert.equal(verifyLinkCardHandle(junk, now), null);
});

test("sign refuses anything verify would refuse", () => {
  assert.throws(() => signLinkCardHandle({ ...handleClaims, actionId: "a".repeat(513) }), RangeError);
  assert.throws(() => signLinkCardHandle({ ...handleClaims, epoch: 0 }), RangeError);
  assert.throws(() => signLinkCardHandle({ ...handleClaims, binding: { ...binding, providerKind: "native", installationKey: "native:other:vault" } }), RangeError);
  assert.throws(() => signLinkCardHandle({ ...handleClaims, binding: { ...binding, installationKey: "native:s1:vault-50e32c" } }), RangeError, "an app may not claim a native key");
  assert.throws(() => signLinkCardHandle({ ...handleClaims, binding: { ...binding, capabilities: Array.from({ length: 17 }, (_, i) => `c${i}`) } }), RangeError);
  const native = signLinkCardHandle({ ...handleClaims, binding: { ...binding, providerKind: "native", providerKey: "workspace", installationKey: nativeInstallationKey("s1", "workspace") } });
  assert.equal(verifyLinkCardHandle(native, now)?.claims.binding.installationKey, "native:s1:workspace");
});

test("requiresPrepare is signed: it round-trips both ways, and a flipped or missing value never verifies", () => {
  assert.equal(verifyLinkCardHandle(signLinkCardHandle(handleClaims), now)?.claims.requiresPrepare, true);
  assert.equal(verifyLinkCardHandle(signLinkCardHandle({ ...handleClaims, requiresPrepare: false }), now)?.claims.requiresPrepare, false);
  const [v, kid, payload, mac] = signLinkCardHandle(handleClaims).split(".");
  const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
  forged.requiresPrepare = false;
  assert.equal(verifyLinkCardHandle(`${v}.${kid}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`, now), null, "a client cannot drop the prepare requirement");
  assert.throws(() => signLinkCardHandle({ ...handleClaims, requiresPrepare: "yes" as unknown as boolean }), RangeError);
  const { requiresPrepare: _omitted, ...withoutFlag } = handleClaims;
  assert.throws(() => signLinkCardHandle(withoutFlag as LinkCardHandleClaims), RangeError, "the flag is required, not defaulted");
});

test("only named fields are signed", () => {
  const wider = { ...handleClaims, extra: "x", binding: { ...binding, extra: "y" } } as LinkCardHandleClaims;
  const claims = verifyLinkCardHandle(signLinkCardHandle(wider), now)?.claims as unknown as Record<string, unknown>;
  assert.equal(claims.extra, undefined);
  assert.equal((claims.binding as Record<string, unknown>).extra, undefined);
});

test("a different signing secret rejects every earlier token", () => {
  const handle = signLinkCardHandle(handleClaims);
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "another-link-card-token-secret-at-least-32b";
  try { assert.equal(verifyLinkCardHandle(handle, now), null); } finally { process.env.JWT_SECRET = previous; }
  assert.ok(verifyLinkCardHandle(handle, now));
  assert.notEqual(newLinkCardViewNonce(), newLinkCardViewNonce());
});

test("the selector is read from the plain text without the MAC, only to pick a client request; anything without one is null", () => {
  const handle = signLinkCardHandle(handleClaims);
  assert.deepEqual(readLinkCardHandleSelector(handle), {
    providerKind: "app", providerKey: "vault-50e32c", installationKey: "inst-1", urlSha256: "a".repeat(64), actionId: "approve",
    handleSha256: verifyLinkCardHandle(handle, now)!.handleSha256,
  });
  const [v, kid, payload, mac] = handle.split(".");
  const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
  forged.binding.providerKey = "someone-else";
  const forgedHandle = `${v}.${kid}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`;
  assert.equal(readLinkCardHandleSelector(forgedHandle)?.providerKey, "someone-else", "a forged selector still selects: the stored request digest decides");
  assert.equal(verifyLinkCardHandle(forgedHandle, now), null, "and never verifies");
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const bad of [null, 7, "", "garbage", "v1.k1.", "v1.k1.mac", "v1.k1.!!!.mac", "v2.k1.x.y", signLinkCardReadTicket(ticketClaims),
    `v1.k1.${b64({ kind: "handle" })}.mac`, `v1.k1.${b64({ kind: "handle", actionId: "a", binding: { providerKind: "other", providerKey: "k", installationKey: "i", urlSha256: "u" } })}.mac`,
    `v1.k1.${b64([1])}.mac`, `${handle}${"x".repeat(4096)}`]) {
    assert.equal(readLinkCardHandleSelector(bad), null, String(bad).slice(0, 40));
  }
});

test("after the MAC, the selector that keyed the lookup must be the signed binding, field for field, and the handle that verified", () => {
  const handle = signLinkCardHandle(handleClaims);
  const verified = verifyLinkCardHandle(handle, now)!;
  const selector = readLinkCardHandleSelector(handle)!;
  assert.equal(linkCardSelectorMatchesHandle(selector, verified), true);
  const other = verifyLinkCardHandle(signLinkCardHandle({ ...handleClaims, actionId: "reject" }), now)!;
  for (const [field, value] of [["providerKind", "native"], ["providerKey", "someone-else"], ["installationKey", "inst-2"], ["urlSha256", "b".repeat(64)],
    ["actionId", "reject"], ["handleSha256", other.handleSha256]] as const) {
    assert.equal(linkCardSelectorMatchesHandle({ ...selector, [field]: value }, verified), false, field);
  }
  assert.equal(linkCardSelectorMatchesHandle(selector, other), false, "another verified handle");
});

test("one execute jti per operation: deterministic, a UUIDv8, never a random v4 of a prepare or status attempt", () => {
  const operationId = randomUUID();
  const jti = linkCardExecuteJti(operationId);
  assert.equal(jti, linkCardExecuteJti(operationId));
  assert.notEqual(jti, linkCardExecuteJti(randomUUID()));
  assert.match(jti, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(jti, operationId);
});

test("the content and action endpoint digests: SHA-256 of the visible text, and of the endpoint's WHATWG href", () => {
  assert.equal(linkCardMessageContentSha256("see https://a.example/pr/1 ✓"), createHash("sha256").update("see https://a.example/pr/1 ✓", "utf8").digest("hex"));
  assert.equal(linkCardActionEndpointSha256("https://A.example:443/card-actions"), linkCardActionEndpointSha256("https://a.example/card-actions"));
  assert.equal(linkCardActionEndpointSha256("https://a.example/card-actions"), createHash("sha256").update("https://a.example/card-actions", "utf8").digest("hex"));
});

test("the by-URL lookup cursor: signed with its own key, round-trips its binding and last sort key, and never verifies as a ticket or handle (nor they as it)", () => {
  const cursorClaims: LinkCardOperationsCursorClaims = {
    viewerId: "u1", serverId: "s1", providerKind: "app", providerKey: "vault-50e32c", installationKey: "inst-1", messageId: "m1", urlSha256: "a".repeat(64),
    lastCreatedAt: iat - 60, lastOperationId: randomUUID(), iat, exp: iat + LINK_CARD_TOKEN_MAX_TTL_SECONDS,
  };
  const cursor = signLinkCardOperationsCursor(cursorClaims);
  assert.deepEqual(verifyLinkCardOperationsCursor(cursor, now), cursorClaims);
  assert.equal(verifyLinkCardHandle(cursor, now), null);
  assert.equal(verifyLinkCardReadTicket(cursor, now), null);
  assert.equal(verifyLinkCardOperationsCursor(signLinkCardHandle(handleClaims), now), null);
  assert.equal(verifyLinkCardOperationsCursor(signLinkCardReadTicket(ticketClaims), now), null);
  const [v, kid, payload, mac] = cursor.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
  for (const change of [{ viewerId: "u2" }, { urlSha256: "b".repeat(64) }, { installationKey: "inst-2" }, { lastCreatedAt: 0 }]) {
    assert.equal(verifyLinkCardOperationsCursor(`${v}.${kid}.${Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url")}.${mac}`, now), null, JSON.stringify(change));
  }
  assert.equal(verifyLinkCardOperationsCursor(cursor, new Date((iat + LINK_CARD_TOKEN_MAX_TTL_SECONDS) * 1000)), null, "it lives as long as a handle");
  assert.throws(() => signLinkCardOperationsCursor({ ...cursorClaims, exp: iat + LINK_CARD_TOKEN_MAX_TTL_SECONDS + 1 }), RangeError);
  assert.throws(() => signLinkCardOperationsCursor({ ...cursorClaims, lastCreatedAt: 1.5 }), RangeError);
});
