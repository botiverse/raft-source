import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import type { AgentTokenSigningAlg, AgentTokenType } from "@botiverse/raft-shared";
import {
  getOidcJwks,
  oidcDiscoveryDocument,
  OidcRs256SigningKeyUnavailableError,
  signAgentAccessJwt,
  signAppLinkPreviewAssertion,
  signCardActionAssertion,
  signOidcIdToken,
  signResourceResolveAssertion,
} from "./oidcService";

const names = ["JWT_SECRET", "RAFT_OIDC_SIGNING_PRIVATE_KEY", "RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS", "RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY", "NODE_ENV", "VITEST"] as const;
function restore(values: (string | undefined)[]) {
  names.forEach((name, index) => { if (values[index] === undefined) delete process.env[name]; else process.env[name] = values[index]; });
}
function cleanEnv() {
  process.env.JWT_SECRET = "synthetic-old-signing-fixture";
  delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
  delete process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS;
  delete process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY;
}
function agentToken(alg: AgentTokenSigningAlg = "ES256", typ: AgentTokenType = "at+jwt") {
  return signAgentAccessJwt({ issuer: "https://issuer.test/oidc/demo", agentId: "00000000-0000-4000-8000-000000000001", clientId: "test-rp", serverId: "server", serverSlug: "demo", serverRole: "member", agentName: "Agent", displayName: "Agent", jti: "fixture", now: new Date("2026-10-05T00:00:00Z"), alg, typ });
}
function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}
/** Verifies with the JWKS key the header's kid names, which must also carry the header's alg. */
function verifyWithPublishedKey(token: string) {
  const [header, payload, signature] = token.split(".");
  const { kid, alg } = decode(header);
  const key = getOidcJwks().keys.find((candidate) => candidate.kid === kid);
  assert.ok(key);
  assert.equal(key.alg, alg, "the published key's alg is the token's alg");
  const publicKey = createPublicKey({ key, format: "jwk" });
  const verified = alg === "RS256"
    ? verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))
    : verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  assert.equal(verified, true);
}
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
function assertPublicOnly(keys: object[]) {
  for (const key of keys) {
    for (const member of PRIVATE_JWK_MEMBERS) assert.equal(member in key, false, `no private member ${member} is published`);
  }
  assert.equal(JSON.stringify(keys).includes("PRIVATE KEY"), false);
}
function rsaPem(modulusLength = 2048) {
  return generateKeyPairSync("rsa", { modulusLength }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}
function rsaKid(jwk: object) {
  const der = createPublicKey({ key: jwk as never, format: "jwk" }).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest().subarray(0, 16).toString("base64url");
}

test("OIDC key rotation prepublishes and retains keys for both Agent JWT and existing ID tokens", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    const oldKey = getOidcJwks().keys[0];
    const oldToken = agentToken();
    const idToken = signOidcIdToken({ issuer: "https://issuer.test", expiresInSeconds: 3600, identity: { sub: "human", clientId: "rp", scopes: ["openid"], type: "human", serverId: "server", serverSlug: "demo", serverRole: "member" } });
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = pem;
    const newKey = getOidcJwks().keys[0];
    const rsaKey = getOidcJwks().keys[1];
    delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
    process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = JSON.stringify([newKey]);
    assert.deepEqual(getOidcJwks().keys.map((key) => key.kid), [oldKey.kid, rsaKey.kid, newKey.kid]);
    verifyWithPublishedKey(oldToken);
    process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = pem;
    process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = JSON.stringify([oldKey]);
    const newToken = agentToken();
    verifyWithPublishedKey(newToken);
    verifyWithPublishedKey(oldToken);
    verifyWithPublishedKey(idToken);
    assert.equal(JSON.stringify(getOidcJwks()).includes('"d"'), false);
    assert.equal(JSON.stringify(getOidcJwks()).includes("PRIVATE KEY"), false);
    const claims = JSON.parse(Buffer.from(newToken.split(".")[1], "base64url").toString());
    assert.equal(claims.token_use, "agent_access");
    const idClaims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    assert.equal(idClaims.token_use, undefined, "an ID token cannot pass receiver token_use expectation");
    assert.equal(idClaims.exp - idClaims.iat, 3600);
  } finally { restore(previous); }
});

test("invalid or private publication material fails closed without echoing key data", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    const key = getOidcJwks().keys[0];
    for (const value of ["not-json", JSON.stringify([{ ...key, d: "private-bytes" }]), JSON.stringify([{ ...key, kid: "mismatch" }])]) {
      process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = value;
      assert.throws(agentToken, { message: "Invalid OIDC public key configuration" });
    }
    delete process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS;
    process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = "private-invalid-pem";
    assert.throws(agentToken, { message: "Invalid OIDC signing key configuration" });
  } finally { restore(previous); }
});

test("an RS256 agent token is signed with the published RSA key; ES256 stays the default", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    const jwks = getOidcJwks();
    assert.deepEqual(jwks.keys.map((key) => [key.kty, key.alg, key.use]), [["EC", "ES256", "sig"], ["RSA", "RS256", "sig"]], "JWKS publishes the ES256 and the RS256 key");
    const rsa = jwks.keys[1];
    assert.deepEqual(Object.keys(rsa).sort(), ["alg", "e", "kid", "kty", "n", "use"], "the RSA JWK carries public members only");
    assertPublicOnly(jwks.keys);
    assert.equal(createPublicKey({ key: rsa, format: "jwk" }).asymmetricKeyDetails?.modulusLength, 2048);
    assert.equal(rsa.kid, rsaKid(rsa), "kid is derived from the public key");
    assert.notEqual(rsa.kid, jwks.keys[0].kid);

    const rs256 = agentToken("RS256");
    assert.deepEqual(decode(rs256.split(".")[0]), { alg: "RS256", kid: rsa.kid, typ: "at+jwt" });
    verifyWithPublishedKey(rs256);
    assert.equal(decode(rs256.split(".")[1]).token_use, "agent_access");
    const es256 = agentToken();
    assert.deepEqual(decode(es256.split(".")[0]), { alg: "ES256", kid: jwks.keys[0].kid, typ: "at+jwt" });
    verifyWithPublishedKey(es256);
    assert.deepEqual(decode(rs256.split(".")[1]), decode(es256.split(".")[1]), "only the signature differs");

    assert.throws(() => agentToken("HS256" as AgentTokenSigningAlg), { message: "Unsupported agent token signing algorithm" });
    assert.throws(() => agentToken("none" as AgentTokenSigningAlg), { message: "Unsupported agent token signing algorithm" });

    assert.deepEqual(oidcDiscoveryDocument("demo").id_token_signing_alg_values_supported, ["ES256", "RS256"]);
    assert.deepEqual(oidcDiscoveryDocument().id_token_signing_alg_values_supported, ["ES256", "RS256"]);
  } finally { restore(previous); }
});

test("an agent token's typ is the App's setting, at+jwt or JWT, and nothing else in it changes", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    const jwks = getOidcJwks();
    for (const alg of ["ES256", "RS256"] as const) {
      const kid = jwks.keys[alg === "ES256" ? 0 : 1].kid;
      const atJwt = agentToken(alg);
      const jwt = agentToken(alg, "JWT");
      assert.deepEqual(decode(atJwt.split(".")[0]), { alg, kid, typ: "at+jwt" }, `${alg}: the default`);
      assert.deepEqual(decode(jwt.split(".")[0]), { alg, kid, typ: "JWT" }, `${alg}: a token-only App's`);
      verifyWithPublishedKey(jwt);
      assert.deepEqual(decode(jwt.split(".")[1]), decode(atJwt.split(".")[1]), `${alg}: the claims are the same`);
    }
    for (const typ of ["jwt", "at+JWT", "none", ""]) {
      assert.throws(() => agentToken("ES256", typ as AgentTokenType), { message: "Unsupported agent token type" }, typ);
    }
  } finally { restore(previous); }
});

test("the dev/test RS256 key is derived from JWT_SECRET: stable across calls, distinct per secret", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    const first = getOidcJwks().keys[1];
    assert.deepEqual(getOidcJwks().keys[1], first);
    process.env.JWT_SECRET = "synthetic-other-signing-fixture";
    const other = getOidcJwks().keys[1];
    assert.equal(other.kty, "RSA");
    assert.notEqual(other.kid, first.kid);
    process.env.JWT_SECRET = "synthetic-old-signing-fixture";
    assert.deepEqual(getOidcJwks().keys[1], first, "the same secret derives the same key again");
  } finally { restore(previous); }
});

test("RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY configures the RS256 key and is strictly validated", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    const derived = getOidcJwks().keys[1];
    process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY = rsaPem();
    const configured = getOidcJwks().keys[1];
    assert.equal(configured.kty, "RSA");
    assert.notEqual(configured.kid, derived.kid);
    assert.equal(configured.kid, rsaKid(configured));
    assertPublicOnly(getOidcJwks().keys);
    const token = agentToken("RS256");
    assert.equal(decode(token.split(".")[0]).kid, configured.kid);
    verifyWithPublishedKey(token);

    const ecPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const pssPem = generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const smallExponentPem = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 3 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    for (const invalid of ["private-invalid-pem", rsaPem(1024), ecPem, pssPem, smallExponentPem]) {
      process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY = invalid;
      assert.throws(() => agentToken("RS256"), { message: "Invalid OIDC RS256 signing key configuration" });
      assert.throws(() => getOidcJwks(), { message: "Invalid OIDC RS256 signing key configuration" }, "an invalid RS256 key is never published");
      assert.throws(() => agentToken("ES256"), { message: "Invalid OIDC RS256 signing key configuration" }, "every signer validates the publication first");
    }
  } finally { restore(previous); }
});

test("production without an RS256 key: JWKS and discovery list only ES256 and RS256 signing fails closed", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    // Synchronous: no other test code runs while the worker looks like production.
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    assert.deepEqual(getOidcJwks().keys.map((key) => key.alg), ["ES256"]);
    assert.deepEqual(oidcDiscoveryDocument("demo").id_token_signing_alg_values_supported, ["ES256"]);
    assert.throws(() => agentToken("RS256"), (error: unknown) => error instanceof OidcRs256SigningKeyUnavailableError
      && /RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY/.test(error.message));
    verifyWithPublishedKey(agentToken("ES256"));
    process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY = rsaPem();
    assert.deepEqual(getOidcJwks().keys.map((key) => key.alg), ["ES256", "RS256"]);
    assert.deepEqual(oidcDiscoveryDocument("demo").id_token_signing_alg_values_supported, ["ES256", "RS256"]);
    verifyWithPublishedKey(agentToken("RS256"));
  } finally { restore(previous); }
});

test("additional RSA public keys are published for rotation and validated like EC ones", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY = rsaPem();
    const retiring = getOidcJwks().keys[1];
    const retiringToken = agentToken("RS256");
    process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY = rsaPem(3072);
    process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = JSON.stringify([retiring]);
    assert.deepEqual(getOidcJwks().keys.map((key) => key.alg), ["ES256", "RS256", "RS256"]);
    assert.equal(getOidcJwks().keys[2].kid, retiring.kid);
    verifyWithPublishedKey(retiringToken);
    verifyWithPublishedKey(agentToken("RS256"));
    assertPublicOnly(getOidcJwks().keys);

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateJwk = privateKey.export({ format: "jwk" });
    const small = createPublicKey(generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey).export({ format: "jwk" });
    const paddedN = Buffer.concat([Buffer.from([0]), Buffer.from((retiring as { n: string }).n, "base64url")]).toString("base64url");
    for (const invalid of [
      { ...privateJwk, kid: retiring.kid, alg: "RS256", use: "sig" },
      { ...retiring, d: "private-bytes" },
      { ...retiring, kid: "mismatch" },
      { ...retiring, alg: "ES256" },
      { ...retiring, alg: "PS256" },
      { ...retiring, use: "enc" },
      { ...retiring, n: paddedN },
      { kty: "RSA", n: small.n, e: small.e, alg: "RS256", use: "sig", kid: rsaKid(small) },
    ]) {
      process.env.RAFT_OIDC_ADDITIONAL_PUBLIC_KEYS = JSON.stringify([invalid]);
      assert.throws(() => getOidcJwks(), { message: "Invalid OIDC public key configuration" });
      assert.throws(() => agentToken("RS256"), { message: "Invalid OIDC public key configuration" });
    }
  } finally { restore(previous); }
});

test("ID tokens and card, link preview and resolve assertions stay ES256 next to an RS256 key", () => {
  const previous = names.map((name) => process.env[name]);
  try {
    cleanEnv();
    process.env.RAFT_OIDC_RS256_SIGNING_PRIVATE_KEY = rsaPem();
    const [ecKey, rsaKey] = getOidcJwks().keys;
    assert.equal(rsaKey.alg, "RS256");
    const now = new Date("2026-10-05T00:00:00Z");
    const tokens = {
      idToken: signOidcIdToken({ issuer: "https://issuer.test", expiresInSeconds: 3600, identity: { sub: "human", clientId: "rp", scopes: ["openid"], type: "human", serverId: "server", serverSlug: "demo", serverRole: "member" } }),
      cardAction: signCardActionAssertion({ phase: "prepare", clientKey: "test-rp", userId: "human", serverId: "server", serverRole: "member", installationId: "install", messageId: "message", urlSha256: "a".repeat(64), body: "{}", jti: "jti", now }),
      linkPreview: signAppLinkPreviewAssertion({ issuer: "https://issuer.test/oidc/demo", clientKey: "test-rp", userId: "human", serverId: "server", serverRole: "member", installationId: "install", url: "https://example.test/x", requestId: "req", now }),
      resolve: signResourceResolveAssertion({ issuer: "https://issuer.test/oidc/demo", clientKey: "test-rp", actorType: "agent", actorId: "agent", serverId: "server", serverRole: "member", installationId: "install", body: "{}", requestId: "req", now }),
    };
    for (const [name, token] of Object.entries(tokens)) {
      const header = decode(token.split(".")[0]);
      assert.equal(header.alg, "ES256", `${name} stays ES256`);
      assert.equal(header.kid, ecKey.kid, `${name} uses the ES256 key`);
      verifyWithPublishedKey(token);
    }
  } finally { restore(previous); }
});
