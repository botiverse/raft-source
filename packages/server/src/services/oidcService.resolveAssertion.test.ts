import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { test } from "vitest";
import { getOidcJwks, signResourceResolveAssertion } from "./oidcService";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

test("resource resolve assertion: own typ/audience/token_use, 60 s, bound to the body, verifiable with the JWKS", () => {
  process.env.JWT_SECRET ??= "resolve-assertion-test-secret-at-least-32-bytes";
  const body = JSON.stringify({ refs: ["raft:v1/s/artifact/pt_1"] });
  const now = new Date("2026-10-19T14:00:00Z");
  const token = signResourceResolveAssertion({
    issuer: "https://api.example/oidc/acme", clientKey: "raft-artifacts", actorType: "agent", actorId: "agent-1",
    serverId: "server-1", serverRole: "member", installationId: "install-1", body, requestId: "req-1", now,
  });
  const [h, p, s] = token.split(".");
  const header = decode(h);
  const claims = decode(p);
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "raft-resolve+jwt");
  assert.equal(claims.aud, "urn:raft:resolve:raft-artifacts");
  assert.equal(claims.token_use, "resolve");
  assert.equal(claims.type, "agent");
  assert.equal(claims.sub, "agent-1");
  assert.equal(claims.server_id, "server-1");
  assert.equal(claims.server_role, "member");
  assert.equal(claims.installation_id, "install-1");
  assert.equal(claims.jti, "req-1");
  assert.equal(Number(claims.exp) - Number(claims.iat), 60);
  assert.equal(claims.body_sha256, createHash("sha256").update(body).digest("hex"));
  const jwk = getOidcJwks().keys.find((key) => key.kid === header.kid);
  assert.ok(jwk, "signed with a key published in the JWKS");
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
});
