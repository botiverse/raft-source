import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { normalizeIdpCertificate, parseSsoConnectionInput, parseSsoRulesInput, SsoConnectionInputError } from "./ssoConnections";
import { isSealedUnderCurrentKey, isSsoSecretStoreConfigured, openSsoClientSecret, resealSsoClientSecret, sealSsoClientSecret, SSO_SECRET_KEY_ENV, SSO_SECRET_PREVIOUS_KEY_ENV, SsoSecretUnavailableError } from "./ssoConnectionSecret";

// A self-signed certificate (CN=idp.acme.test, valid to 2036) standing in for an IdP's signing certificate.
const CERT = readFileSync(new URL("../../test/fixtures/ssoIdpTestCertificate.pem", import.meta.url), "utf8");
const BODY = CERT.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/gu, "");

function inputError(fn: () => unknown, field: string) {
  assert.throws(fn, (error: unknown) => error instanceof SsoConnectionInputError && error.field === field);
}

describe("parseSsoConnectionInput", () => {
  const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

  test("an OIDC connection: the issuer exactly as typed, the secret kept apart and untrimmed", () => {
    const parsed = parseSsoConnectionInput({
      protocol: "oidc", displayName: " Acme ", issuer: "https://acme.auth0.com/", clientId: "raft", clientSecret: " s3cret ",
    }, env);
    // OIDC compares the issuer exactly; Auth0's ends in "/".
    assert.deepEqual(parsed.config, { protocol: "oidc", issuer: "https://acme.auth0.com/", clientId: "raft" });
    assert.equal(parsed.displayName, "Acme");
    assert.equal(parsed.clientSecret, " s3cret ");
    assert.equal(parseSsoConnectionInput({ protocol: "oidc", displayName: "Acme", issuer: "https://acme.okta.com", clientId: "raft" }, env).clientSecret, null);
  });

  test("IdP URLs must be https, with no credentials, fragment or (for an issuer) query", () => {
    const base = { protocol: "oidc", displayName: "Acme", clientId: "raft" };
    inputError(() => parseSsoConnectionInput({ ...base, issuer: "http://acme.okta.com" }, env), "issuer");
    inputError(() => parseSsoConnectionInput({ ...base, issuer: "https://u:p@acme.okta.com" }, env), "issuer");
    inputError(() => parseSsoConnectionInput({ ...base, issuer: "https://acme.okta.com?x=1" }, env), "issuer");
    inputError(() => parseSsoConnectionInput({ ...base, issuer: "not a url" }, env), "issuer");
  });

  test("an Entra connection must name its tenant", () => {
    const base = { protocol: "oidc", displayName: "Acme", clientId: "raft" };
    for (const path of ["common", "organizations", "consumers"]) {
      inputError(() => parseSsoConnectionInput({ ...base, issuer: `https://login.microsoftonline.com/${path}/v2.0` }, env), "issuer");
    }
    assert.equal(parseSsoConnectionInput({ ...base, issuer: "https://login.microsoftonline.com/6f1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d/v2.0" }, env).config.protocol, "oidc");
  });

  test("http is allowed only for a local IdP outside production", () => {
    const body = { protocol: "oidc", displayName: "Local", issuer: "http://localhost:8080/realms/raft", clientId: "raft" };
    assert.equal(parseSsoConnectionInput(body, { NODE_ENV: "test", RAFT_SSO_ALLOW_HTTP_IDP: "1" } as NodeJS.ProcessEnv).config.protocol, "oidc");
    inputError(() => parseSsoConnectionInput(body, { NODE_ENV: "production", RAFT_SSO_ALLOW_HTTP_IDP: "1" } as NodeJS.ProcessEnv), "issuer");
  });

  test("a SAML connection: certificates normalised to PEM, one or two, no client secret", () => {
    const parsed = parseSsoConnectionInput({
      protocol: "saml", displayName: "Acme", idpEntityId: "http://www.okta.com/exk1", idpSsoUrl: "https://acme.okta.com/app/sso/saml?x=1", idpCertificates: [BODY],
    }, env);
    assert.equal(parsed.config.protocol, "saml");
    assert.equal(parsed.config.protocol === "saml" ? parsed.config.idpSsoUrl : "", "https://acme.okta.com/app/sso/saml?x=1");
    assert.match(parsed.config.protocol === "saml" ? parsed.config.idpCertificates[0]! : "", /^-----BEGIN CERTIFICATE-----\n/u);
    const saml = { protocol: "saml", displayName: "Acme", idpEntityId: "x", idpSsoUrl: "https://acme.okta.com/sso" };
    inputError(() => parseSsoConnectionInput({ ...saml, idpCertificates: [] }, env), "idpCertificates");
    inputError(() => parseSsoConnectionInput({ ...saml, idpCertificates: [CERT, CERT, CERT] }, env), "idpCertificates");
    inputError(() => parseSsoConnectionInput({ ...saml, idpCertificates: [CERT], clientSecret: "x" }, env), "clientSecret");
  });

  test("secrets are limited in UTF-8 bytes, certificates in size", () => {
    const base = { protocol: "oidc", displayName: "Acme", issuer: "https://acme.okta.com", clientId: "raft" };
    inputError(() => parseSsoConnectionInput({ ...base, clientSecret: "密".repeat(1400) }, env), "clientSecret");
    assert.equal(parseSsoConnectionInput({ ...base, clientSecret: "a".repeat(4096) }, env).clientSecret?.length, 4096);
    inputError(() => normalizeIdpCertificate("A".repeat(17 * 1024)), "idpCertificates");
  });

  test("an unreadable certificate and an unknown protocol are refused", () => {
    inputError(() => normalizeIdpCertificate("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"), "idpCertificates");
    inputError(() => parseSsoConnectionInput({ protocol: "ldap", displayName: "Acme" }, env), "protocol");
    inputError(() => parseSsoConnectionInput({ protocol: "oidc", displayName: "" }, env), "displayName");
  });
});

describe("parseSsoRulesInput", () => {
  test("auto-join and the max age, within 1 to 30 days", () => {
    assert.deepEqual(parseSsoRulesInput({ autoJoin: true, sessionMaxAgeDays: 14 }), { autoJoin: true, sessionMaxAgeDays: 14 });
    inputError(() => parseSsoRulesInput({ sessionMaxAgeDays: 0 }), "sessionMaxAgeDays");
    inputError(() => parseSsoRulesInput({ sessionMaxAgeDays: 31 }), "sessionMaxAgeDays");
    inputError(() => parseSsoRulesInput({ sessionMaxAgeDays: 1.5 }), "sessionMaxAgeDays");
    inputError(() => parseSsoRulesInput({ autoJoin: "yes" }), "autoJoin");
    inputError(() => parseSsoRulesInput({}), "rules");
  });

  test("require SSO is a boolean (who may turn it on is the route's check)", () => {
    inputError(() => parseSsoRulesInput({ required: "yes" }), "required");
    assert.deepEqual(parseSsoRulesInput({ required: true }), { required: true });
  });
});

describe("SSO client secret at rest", () => {
  const key = () => randomBytes(32).toString("base64");
  const scope = { connectionId: "c1", serverId: "s1" };

  test("seals and opens for the same connection only", () => {
    const env = { [SSO_SECRET_KEY_ENV]: key() } as NodeJS.ProcessEnv;
    const sealed = sealSsoClientSecret("s3cret", scope, env);
    assert.doesNotMatch(sealed, /s3cret/u);
    assert.equal(openSsoClientSecret(sealed, scope, env), "s3cret");
    assert.equal(openSsoClientSecret(sealed, { connectionId: "c2", serverId: "s1" }, env), null);
    assert.equal(openSsoClientSecret(sealed, { connectionId: "c1", serverId: "s2" }, env), null);
  });

  test("during a rotation the previous key still opens old rows", () => {
    const oldKey = key();
    const sealed = sealSsoClientSecret("s3cret", scope, { [SSO_SECRET_KEY_ENV]: oldKey } as NodeJS.ProcessEnv);
    const rotated = { [SSO_SECRET_KEY_ENV]: key(), [SSO_SECRET_PREVIOUS_KEY_ENV]: oldKey } as NodeJS.ProcessEnv;
    assert.equal(openSsoClientSecret(sealed, scope, rotated), "s3cret");
    assert.equal(openSsoClientSecret(sealed, scope, { [SSO_SECRET_KEY_ENV]: rotated[SSO_SECRET_KEY_ENV] } as NodeJS.ProcessEnv), null);
  });

  test("a stored secret names the key that sealed it", () => {
    const env = { [SSO_SECRET_KEY_ENV]: key() } as NodeJS.ProcessEnv;
    const sealed = sealSsoClientSecret("s3cret", scope, env);
    assert.match(sealed, /^[0-9a-f]{16}:env-aes-256-gcm:v1:/u);
    assert.equal(isSealedUnderCurrentKey(sealed, env), true);
    assert.equal(isSealedUnderCurrentKey(sealed, { [SSO_SECRET_KEY_ENV]: key() } as NodeJS.ProcessEnv), false);
    assert.equal(openSsoClientSecret(sealed.slice(17), scope, env), null, "no key id: not ours");
  });

  test("re-sealing moves a row to the current key", () => {
    const oldKey = key();
    const sealed = sealSsoClientSecret("s3cret", scope, { [SSO_SECRET_KEY_ENV]: oldKey } as NodeJS.ProcessEnv);
    const current = key();
    const resealed = resealSsoClientSecret(sealed, scope, { [SSO_SECRET_KEY_ENV]: current, [SSO_SECRET_PREVIOUS_KEY_ENV]: oldKey } as NodeJS.ProcessEnv);
    assert.equal(openSsoClientSecret(resealed!, scope, { [SSO_SECRET_KEY_ENV]: current } as NodeJS.ProcessEnv), "s3cret");
  });

  test("a missing or malformed key is 'unavailable', and a malformed previous key spares current rows", () => {
    assert.throws(() => sealSsoClientSecret("s3cret", scope, {} as NodeJS.ProcessEnv), SsoSecretUnavailableError);
    assert.throws(() => sealSsoClientSecret("s3cret", scope, { [SSO_SECRET_KEY_ENV]: "not-a-key" } as NodeJS.ProcessEnv), SsoSecretUnavailableError);
    assert.equal(isSsoSecretStoreConfigured({ [SSO_SECRET_KEY_ENV]: "not-a-key" } as NodeJS.ProcessEnv), false);
    const env = { [SSO_SECRET_KEY_ENV]: key(), [SSO_SECRET_PREVIOUS_KEY_ENV]: "not-a-key" } as NodeJS.ProcessEnv;
    assert.equal(openSsoClientSecret(sealSsoClientSecret("s3cret", scope, env), scope, env), "s3cret");
  });
});
