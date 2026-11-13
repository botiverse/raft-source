import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { entraTenantOf, isEmailVerifiedBy } from "./ssoOidc";

// When an IdP's email counts as verified (rfcs/083-server-sso.md §5.7).
const TENANT = "6f1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d";
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;

describe("entraTenantOf", () => {
  test("names the single tenant of an Entra issuer", () => {
    assert.equal(entraTenantOf(ENTRA), TENANT);
    assert.equal(entraTenantOf(`https://LOGIN.microsoftonline.com/${TENANT.toUpperCase()}/v2.0/`), TENANT);
  });
  test("an Entra issuer that names no single tenant is multi", () => {
    for (const path of ["common", "organizations", "consumers", "contoso.onmicrosoft.com"]) {
      assert.equal(entraTenantOf(`https://login.microsoftonline.com/${path}/v2.0`), "multi", path);
    }
  });
  test("other issuers are not Entra", () => {
    assert.equal(entraTenantOf("https://acme.okta.com"), null);
    assert.equal(entraTenantOf("https://accounts.google.com"), null);
  });
});

describe("isEmailVerifiedBy", () => {
  test("Entra: xms_edov and the configured tenant, both", () => {
    assert.equal(isEmailVerifiedBy(ENTRA, { xms_edov: true, tid: TENANT }), true);
    assert.equal(isEmailVerifiedBy(ENTRA, { xms_edov: true, tid: "00000000-0000-4000-8000-000000000000" }), false, "another tenant");
    assert.equal(isEmailVerifiedBy(ENTRA, { tid: TENANT }), false, "no xms_edov");
    assert.equal(isEmailVerifiedBy(ENTRA, { xms_edov: true, tid: TENANT, email_verified: false }), false);
    assert.equal(isEmailVerifiedBy(ENTRA, { email_verified: true, tid: TENANT }), false, "email_verified is not Entra's signal");
    assert.equal(isEmailVerifiedBy("https://login.microsoftonline.com/common/v2.0", { xms_edov: true, tid: TENANT }), false);
  });
  test("other OIDC: exactly email_verified true", () => {
    assert.equal(isEmailVerifiedBy("https://acme.okta.com", { email_verified: true }), true);
    assert.equal(isEmailVerifiedBy("https://acme.okta.com", { email_verified: "true" }), false);
    assert.equal(isEmailVerifiedBy("https://acme.okta.com", {}), false);
    assert.equal(isEmailVerifiedBy("https://acme.okta.com", { xms_edov: true }), false);
  });
});
