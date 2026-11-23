import assert from "node:assert/strict";

import {
  androidApkKeyHashOrigin,
  effectivePasskeyRpId,
  parsePasskeyRpGroup,
  passkeyRpGroup,
  readWebauthnRelyingParty,
  WebauthnConfigError,
} from "./webauthn";

// The relying party is explicit (an RP ID cannot change once passkeys are
// registered under it): unset = passkeys unavailable; set but inconsistent
// = the server refuses to start (server.ts calls readWebauthnRelyingParty).

const env = (vars: Record<string, string | undefined>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

const previousAppUrl = process.env.APP_URL;
afterEach(() => {
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
});

test("unset: passkeys are off, nothing to validate", () => {
  process.env.APP_URL = "https://app.raft.build";
  assert.equal(readWebauthnRelyingParty(env({})), null);
  assert.equal(readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: " ", WEBAUTHN_ORIGINS: "" })), null);
});

test("valid pairs: production, staging, local", () => {
  process.env.APP_URL = "https://app.raft.build";
  assert.deepEqual(
    readWebauthnRelyingParty(env({ NODE_ENV: "production", WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build" })),
    { rpID: "raft.build", origins: ["https://app.raft.build"], androidOrigins: [] },
  );
  assert.deepEqual(
    readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: "app.raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build/, https://app.raft.build" })),
    { rpID: "app.raft.build", origins: ["https://app.raft.build"], androidOrigins: [] },
  );
  process.env.APP_URL = "https://app-staging.slock.ai";
  assert.deepEqual(
    readWebauthnRelyingParty(env({ NODE_ENV: "production", WEBAUTHN_RP_ID: "app-staging.slock.ai", WEBAUTHN_ORIGINS: "https://app-staging.slock.ai" })),
    { rpID: "app-staging.slock.ai", origins: ["https://app-staging.slock.ai"], androidOrigins: [] },
  );
  process.env.APP_URL = "http://localhost:5173";
  assert.deepEqual(
    readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: "http://localhost:5173" })),
    { rpID: "localhost", origins: ["http://localhost:5173"], androidOrigins: [] },
  );
  // A local stack mirroring the move to a subdomain RP ID. Not under bare
  // `localhost`: Chrome refuses rpId "localhost" from app.localhost (a
  // single-label public suffix to it), so the legacy RP ID is pk.localhost.
  process.env.APP_URL = "http://app.pk.localhost:5173";
  assert.deepEqual(
    readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: "app.pk.localhost", WEBAUTHN_LEGACY_RP_ID: "pk.localhost", WEBAUTHN_ORIGINS: "http://app.pk.localhost:5173" })),
    { rpID: "app.pk.localhost", origins: ["http://app.pk.localhost:5173"], androidOrigins: [], legacyRpID: "pk.localhost" },
  );
});

test("inconsistent: refused with a reason", () => {
  process.env.APP_URL = "https://app.raft.build";
  const refused: Array<[Record<string, string>, RegExp]> = [
    [{ WEBAUTHN_RP_ID: "raft.build" }, /WEBAUTHN_ORIGINS is not/],
    [{ WEBAUTHN_ORIGINS: "https://app.raft.build" }, /WEBAUTHN_RP_ID is not/],
    [{ WEBAUTHN_RP_ID: "build", WEBAUTHN_ORIGINS: "https://app.raft.build" }, /not a domain/],
    [{ WEBAUTHN_RP_ID: "other.build", WEBAUTHN_ORIGINS: "https://app.other.build" }, /APP_URL hostname/],
    [{ WEBAUTHN_RP_ID: "notraft.build", WEBAUTHN_ORIGINS: "https://app.raft.build" }, /APP_URL hostname/],
    [{ WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "https://evil.example" }, /is not on WEBAUTHN_RP_ID/],
    [{ WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "https://app.notraft.build" }, /is not on WEBAUTHN_RP_ID/],
    [{ WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "http://app.raft.build" }, /must be https/],
    [{ WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "app://raft" }, /must be https|bare origin/],
    [{ WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build/path" }, /bare origin/],
  ];
  for (const [vars, reason] of refused) {
    assert.throws(() => readWebauthnRelyingParty(env(vars)), (err: unknown) => err instanceof WebauthnConfigError && reason.test(err.message), JSON.stringify(vars));
  }
  process.env.APP_URL = "http://localhost:5173";
  assert.throws(
    () => readWebauthnRelyingParty(env({ NODE_ENV: "production", WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: "http://localhost:5173" })),
    /must be https/,
    "plain http only outside production",
  );
  process.env.APP_URL = "http://app.localhost:5173";
  assert.throws(
    () => readWebauthnRelyingParty(env({ NODE_ENV: "production", WEBAUTHN_RP_ID: "app.localhost", WEBAUTHN_ORIGINS: "http://app.localhost:5173" })),
    /must be https/,
    "*.localhost too: plain http only outside production",
  );
  process.env.APP_URL = "http://app.notlocalhost:5173";
  assert.throws(
    () => readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: "app.notlocalhost", WEBAUTHN_ORIGINS: "http://app.notlocalhost:5173" })),
    /must be https/,
    "only the localhost name itself, not a lookalike",
  );
});

// Native Android passkeys (Credential Manager) carry
// `android:apk-key-hash:<base64url SHA-256 of the signing certificate>`. Only
// fingerprints listed in WEBAUTHN_ANDROID_APK_KEY_HASHES become origins.
const PLAY_SIGNING = "D7:70:71:84:A6:BE:7F:0C:EC:D6:2E:3F:F9:E0:89:D4:58:A8:4F:AF:A3:BD:8E:2F:AE:4B:3B:60:D8:C5:6A:D6";
const UPLOAD_ROTATED = "5f:08:bb:e8:2a:27:cc:da:d2:6c:13:52:3a:60:b5:67:0d:3a:a7:63:3e:8e:d2:fd:71:fa:6b:57:51:f9:b0:b1";

test("android: each listed fingerprint is exactly one apk-key-hash origin; web origins unchanged", () => {
  process.env.APP_URL = "https://app.raft.build";
  assert.equal(androidApkKeyHashOrigin(PLAY_SIGNING), "android:apk-key-hash:13BxhKa-fwzs1i4_-eCJ1FioT6-jvY4vrks7YNjFatY");
  assert.equal(androidApkKeyHashOrigin(UPLOAD_ROTATED), "android:apk-key-hash:Xwi76ConzNrSbBNSOmC1Zw06p2M-jtL9cfprV1H5sLE");
  assert.deepEqual(
    readWebauthnRelyingParty(env({
      NODE_ENV: "production",
      WEBAUTHN_RP_ID: "raft.build",
      WEBAUTHN_ORIGINS: "https://app.raft.build,https://raft.build",
      WEBAUTHN_ANDROID_APK_KEY_HASHES: ` ${PLAY_SIGNING}, ${UPLOAD_ROTATED},${PLAY_SIGNING.toLowerCase()}`,
    })),
    {
      rpID: "raft.build",
      origins: ["https://app.raft.build", "https://raft.build"],
      androidOrigins: [
        "android:apk-key-hash:13BxhKa-fwzs1i4_-eCJ1FioT6-jvY4vrks7YNjFatY",
        "android:apk-key-hash:Xwi76ConzNrSbBNSOmC1Zw06p2M-jtL9cfprV1H5sLE",
      ],
    },
  );
});

test("android: an apk-key-hash is never a web origin, a malformed fingerprint fails startup", () => {
  process.env.APP_URL = "https://app.raft.build";
  const base = { WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build" };
  const refused: Array<[Record<string, string>, RegExp]> = [
    [{ ...base, WEBAUTHN_ORIGINS: androidApkKeyHashOrigin(PLAY_SIGNING) }, /must be https|bare origin|not a URL/],
    [{ ...base, WEBAUTHN_ANDROID_APK_KEY_HASHES: androidApkKeyHashOrigin(PLAY_SIGNING) }, /not a SHA-256 fingerprint/],
    [{ ...base, WEBAUTHN_ANDROID_APK_KEY_HASHES: PLAY_SIGNING.replace(/:/g, "") }, /not a SHA-256 fingerprint/],
    [{ ...base, WEBAUTHN_ANDROID_APK_KEY_HASHES: PLAY_SIGNING.slice(0, -3) }, /not a SHA-256 fingerprint/],
    [{ ...base, WEBAUTHN_ANDROID_APK_KEY_HASHES: `${PLAY_SIGNING.slice(0, -2)}ZZ` }, /not a SHA-256 fingerprint/],
    [{ ...base, WEBAUTHN_ANDROID_APK_KEY_HASHES: "*" }, /not a SHA-256 fingerprint/],
    [{ WEBAUTHN_ANDROID_APK_KEY_HASHES: PLAY_SIGNING }, /WEBAUTHN_RP_ID is not/],
  ];
  for (const [vars, reason] of refused) {
    assert.throws(() => readWebauthnRelyingParty(env(vars)), (err: unknown) => err instanceof WebauthnConfigError && reason.test(err.message), JSON.stringify(vars));
  }
});

// Moving the RP ID (raft.build -> app.raft.build): WEBAUTHN_LEGACY_RP_ID keeps
// the passkeys registered under the old one verifiable; it never adds an origin.
test("legacy RP ID: a strict parent of the RP ID; present only when set", () => {
  process.env.APP_URL = "https://app.raft.build";
  assert.deepEqual(
    readWebauthnRelyingParty(env({
      NODE_ENV: "production",
      WEBAUTHN_RP_ID: "app.raft.build",
      WEBAUTHN_LEGACY_RP_ID: " Raft.Build ",
      WEBAUTHN_ORIGINS: "https://app.raft.build",
      WEBAUTHN_ANDROID_APK_KEY_HASHES: PLAY_SIGNING,
    })),
    {
      rpID: "app.raft.build",
      origins: ["https://app.raft.build"],
      androidOrigins: ["android:apk-key-hash:13BxhKa-fwzs1i4_-eCJ1FioT6-jvY4vrks7YNjFatY"],
      legacyRpID: "raft.build",
    },
  );
  assert.equal("legacyRpID" in readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: "app.raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build", WEBAUTHN_LEGACY_RP_ID: " " }))!, false);
});

test("legacy RP ID: refused when not a strict parent, the same, set alone, or when an origin is off either RP ID", () => {
  process.env.APP_URL = "https://app.raft.build";
  const moved = { WEBAUTHN_RP_ID: "app.raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build" };
  const refused: Array<[Record<string, string>, RegExp]> = [
    [{ WEBAUTHN_LEGACY_RP_ID: "raft.build" }, /WEBAUTHN_LEGACY_RP_ID is set but WEBAUTHN_RP_ID is not/],
    [{ ...moved, WEBAUTHN_LEGACY_RP_ID: "app.raft.build" }, /same as WEBAUTHN_RP_ID/],
    [{ ...moved, WEBAUTHN_LEGACY_RP_ID: "other.build" }, /must be a parent domain/],
    [{ ...moved, WEBAUTHN_LEGACY_RP_ID: "ft.build" }, /must be a parent domain/],
    [{ ...moved, WEBAUTHN_LEGACY_RP_ID: "x.app.raft.build" }, /must be a parent domain/],
    [{ ...moved, WEBAUTHN_LEGACY_RP_ID: "build" }, /not a domain/],
    [{ ...moved, WEBAUTHN_LEGACY_RP_ID: "raft.build/" }, /not a domain/],
    // The legacy RP ID never brings its own origin in: https://raft.build is not on app.raft.build.
    [{ ...moved, WEBAUTHN_ORIGINS: "https://app.raft.build,https://raft.build", WEBAUTHN_LEGACY_RP_ID: "raft.build" }, /"https:\/\/raft.build" is not on WEBAUTHN_RP_ID/],
    [{ WEBAUTHN_RP_ID: "raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build", WEBAUTHN_LEGACY_RP_ID: "app.raft.build" }, /must be a parent domain/],
  ];
  for (const [vars, reason] of refused) {
    assert.throws(() => readWebauthnRelyingParty(env(vars)), (err: unknown) => err instanceof WebauthnConfigError && reason.test(err.message), JSON.stringify(vars));
  }
});

test("RP groups: a stored rp_id (NULL = before the column) answers under one configured RP ID or none", () => {
  const moved = { rpID: "app.raft.build", origins: ["https://app.raft.build"], androidOrigins: [], legacyRpID: "raft.build" };
  const unmoved = { rpID: "raft.build", origins: ["https://app.raft.build"], androidOrigins: [] };
  assert.equal(passkeyRpGroup(moved, null), "legacy");
  assert.equal(effectivePasskeyRpId(moved, null), "raft.build");
  assert.equal(passkeyRpGroup(moved, "raft.build"), "legacy");
  assert.equal(passkeyRpGroup(moved, "app.raft.build"), "current");
  assert.equal(passkeyRpGroup(unmoved, null), "current", "unset: as before");
  assert.equal(passkeyRpGroup(unmoved, "raft.build"), "current");
  // Rolled back: passkeys from after the move answer nowhere until it is set again.
  assert.equal(passkeyRpGroup(unmoved, "app.raft.build"), null);
  assert.equal(parsePasskeyRpGroup(undefined), undefined);
  assert.equal(parsePasskeyRpGroup("legacy"), "legacy");
  assert.equal(parsePasskeyRpGroup("raft.build"), null);
});
