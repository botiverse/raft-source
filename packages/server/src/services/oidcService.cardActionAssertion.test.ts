import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { test } from "vitest";
import { CardActionPastDeadlineError, getOidcJwks, oidcIssuer, serverRoleClaim, signAppLinkPreviewAssertion, signCardActionAssertion } from "./oidcService";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

test("card action assertion: own typ/audience/token_use, phase and server_role, 30 s, bound to URL and body", () => {
  process.env.JWT_SECRET ??= "card-action-assertion-test-secret-at-least-32-bytes";
  const url = "https://vault.raft.build/requests?source=s1&request=r1";
  const body = JSON.stringify({ version: 2, phase: "execute", operation_id: "op-1" });
  const now = new Date("2026-10-20T22:00:00Z");
  const token = signCardActionAssertion({
    clientKey: "vault-50e32c", userId: "user-1", serverId: "server-1", serverRole: "admin",
    installationId: "install-1", messageId: "message-1", urlSha256: createHash("sha256").update(url).digest("hex"), phase: "execute", body, jti: "jti-1", now,
    notAfter: new Date(now.getTime() + 600_000),
  });
  const [h, p, s] = token.split(".");
  const header = decode(h!);
  const claims = decode(p!);
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "raft-card-action+jwt");
  assert.equal(claims.aud, "urn:raft:card-action:vault-50e32c");
  assert.equal(claims.iss, oidcIssuer(undefined, "server-1"), "iss names the Server by id, never a slug (addendum 1 §5)");
  assert.equal(claims.server_id, "server-1");
  assert.equal(claims.token_use, "card_action");
  assert.equal(claims.type, "human");
  assert.equal(claims.phase, "execute");
  assert.equal(claims.server_role, "admin");
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.message_id, "message-1");
  assert.equal(claims.installation_id, "install-1");
  assert.equal(claims.jti, "jti-1");
  assert.equal(Number(claims.exp) - Number(claims.iat), 30);
  assert.equal(claims.url_sha256, createHash("sha256").update(url).digest("hex"));
  assert.equal(claims.body_sha256, createHash("sha256").update(body).digest("hex"));
  const jwk = getOidcJwks().keys.find((key) => key.kid === header.kid);
  assert.ok(jwk, "signed with a key published in the JWKS");
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")));

  // body_sha256 covers the exact bytes sent; a non-hex URL digest is refused.
  const bytes = Buffer.from(body, "utf8");
  const fromBytes = decode(signCardActionAssertion({ clientKey: "vault-50e32c", userId: "user-1", serverId: "server-1", serverRole: "admin",
    installationId: "install-1", messageId: "message-1", urlSha256: String(claims.url_sha256), phase: "status", body: bytes, jti: "jti-2", now }).split(".")[1]!);
  assert.equal(fromBytes.body_sha256, claims.body_sha256);
  assert.equal(fromBytes.phase, "status");
  assert.throws(() => signCardActionAssertion({ clientKey: "vault-50e32c", userId: "user-1", serverId: "server-1", serverRole: "admin",
    installationId: "install-1", messageId: "message-1", urlSha256: url, phase: "status", body, jti: "jti-3", now }));

  // The read-only preview credential is distinguishable on every field an App checks.
  const preview = signAppLinkPreviewAssertion({ issuer: "https://api.example/oidc/raft", clientKey: "vault-50e32c", userId: "user-1", serverId: "server-1",
    serverRole: "member", installationId: "install-1", url, requestId: "req-1", now });
  const [ph, pp] = preview.split(".");
  assert.notEqual(decode(ph!).typ, header.typ);
  assert.notEqual(decode(pp!).aud, claims.aud);
  assert.notEqual(decode(pp!).token_use, claims.token_use);
});

test("server_role: both assertions carry it, and anything outside the four roles is signed as guest", () => {
  process.env.JWT_SECRET ??= "card-action-assertion-test-secret-at-least-32-bytes";
  const now = new Date("2026-10-20T22:00:00Z");
  const preview = (serverRole: unknown) => decode(signAppLinkPreviewAssertion({ issuer: "https://api.example/oidc/raft", clientKey: "vault-50e32c", userId: "user-1",
    serverId: "server-1", serverRole: serverRole as "member", installationId: "install-1", url: "https://vault.raft.build/r/1", requestId: "req-1", now }).split(".")[1]!);
  const action = (serverRole: unknown) => decode(signCardActionAssertion({ clientKey: "vault-50e32c", userId: "user-1",
    serverId: "server-1", serverRole: serverRole as "member", installationId: "install-1", messageId: "message-1", urlSha256: "a".repeat(64), phase: "status",
    body: "{}", jti: "jti-1", now }).split(".")[1]!);
  for (const role of ["owner", "admin", "member", "guest"]) {
    assert.equal(preview(role).server_role, role);
    assert.equal(action(role).server_role, role);
  }
  for (const odd of ["superadmin", "", null, undefined, "Admin"]) {
    assert.equal(preview(odd).server_role, "guest", String(odd));
    assert.equal(action(odd).server_role, "guest", String(odd));
  }
  assert.equal(serverRoleClaim("admin"), "admin");
  assert.equal(serverRoleClaim({ toString: () => "admin" }), "guest");
});

test("notAfter caps exp at the first-send deadline and refuses to sign at or after it", () => {
  process.env.JWT_SECRET ??= "card-action-assertion-test-secret-at-least-32-bytes";
  const now = new Date("2026-10-20T22:00:00.900Z");
  const iat = Math.floor(now.getTime() / 1000);
  const base = { clientKey: "vault-50e32c", userId: "user-1", serverId: "server-1", serverRole: "member",
    installationId: "install-1", messageId: "message-1", urlSha256: "a".repeat(64), body: "{}", jti: "jti-1", now } as const;
  const sign = (notAfter: Date) => decode(signCardActionAssertion({ ...base, phase: "execute", notAfter }).split(".")[1]!);
  assert.equal(decode(signCardActionAssertion({ ...base, phase: "status" }).split(".")[1]!).exp, iat + 30, "no deadline (status): the usual 30 s");
  assert.equal(sign(new Date((iat + 600) * 1000)).exp, iat + 30, "a far deadline does not extend it");
  assert.equal(sign(new Date((iat + 10) * 1000)).exp, iat + 10, "a near deadline cuts it");
  assert.equal(sign(new Date((iat + 1) * 1000 + 999)).exp, iat + 1, "whole seconds, rounded down");
  assert.throws(() => sign(new Date(iat * 1000)), CardActionPastDeadlineError, "at the deadline: never signed");
  assert.throws(() => sign(new Date(iat * 1000 - 1)), CardActionPastDeadlineError);
});

test("execute requires notAfter, in the type and at run time; prepare and status do not", () => {
  process.env.JWT_SECRET ??= "card-action-assertion-test-secret-at-least-32-bytes";
  const now = new Date("2026-10-20T22:00:00Z");
  const base = { clientKey: "vault-50e32c", userId: "user-1", serverId: "server-1", serverRole: "member",
    installationId: "install-1", messageId: "message-1", urlSha256: "a".repeat(64), body: "{}", jti: "jti-1", now } as const;
  // @ts-expect-error execute without its first-send deadline does not type-check
  assert.throws(() => signCardActionAssertion({ ...base, phase: "execute" }), /needs notAfter/);
  const untyped = { ...base, phase: "execute", notAfter: undefined } as unknown as Parameters<typeof signCardActionAssertion>[0];
  assert.throws(() => signCardActionAssertion(untyped), /needs notAfter/, "an explicit undefined is refused too");
  for (const phase of ["prepare", "status"] as const) {
    assert.equal(decode(signCardActionAssertion({ ...base, phase }).split(".")[1]!).phase, phase);
  }
  assert.equal(decode(signCardActionAssertion({ ...base, phase: "execute", notAfter: new Date(now.getTime() + 600_000) }).split(".")[1]!).phase, "execute");
});
