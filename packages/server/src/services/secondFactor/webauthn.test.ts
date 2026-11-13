import assert from "node:assert/strict";

import { readWebauthnRelyingParty, WebauthnConfigError } from "./webauthn";

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
    { rpID: "raft.build", origins: ["https://app.raft.build"] },
  );
  assert.deepEqual(
    readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: "app.raft.build", WEBAUTHN_ORIGINS: "https://app.raft.build/, https://app.raft.build" })),
    { rpID: "app.raft.build", origins: ["https://app.raft.build"] },
  );
  process.env.APP_URL = "https://app-staging.slock.ai";
  assert.deepEqual(
    readWebauthnRelyingParty(env({ NODE_ENV: "production", WEBAUTHN_RP_ID: "app-staging.slock.ai", WEBAUTHN_ORIGINS: "https://app-staging.slock.ai" })),
    { rpID: "app-staging.slock.ai", origins: ["https://app-staging.slock.ai"] },
  );
  process.env.APP_URL = "http://localhost:5173";
  assert.deepEqual(
    readWebauthnRelyingParty(env({ WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGINS: "http://localhost:5173" })),
    { rpID: "localhost", origins: ["http://localhost:5173"] },
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
});
