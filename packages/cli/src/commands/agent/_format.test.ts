import assert from "node:assert/strict";

import {
  describeLogoutRevokeFailure,
  formatAlreadyLoggedIn,
  formatAuthorizedLoginReport,
  formatLoginStateMissing,
  formatLogoutNotLoggedIn,
  formatLogoutReport,
  formatVerificationHandoff,
} from "./_format";

// Byte pins: expected strings below are copied from the PRE-MOVE inline
// literals in login.ts/list.ts (print-seam S3), not from the new
// formatter code. The move must not change a single output byte.
// (formatAuthorizedLoginReport/formatStartHandoff/formatLoginStatus moved
// with bodies unchanged and keep their pre-existing assertions in
// login.test.ts via the login.ts re-export.)

const paths = { profileSlug: "alice", profileDir: "/p", credentialPath: "/p/alice/credential.json" };
const options = { server: "https://raft.example", agent: "alice" };

test("formatLoginStateMissing matches pre-move login.ts bytes", () => {
  assert.equal(
    formatLoginStateMissing(options, paths),
    "state: missing\n" +
      "No credential for profile 'alice' at /p/alice/credential.json.\n" +
      "Next: run `raft agent login start --server https://raft.example --agent alice` to log in.\n",
  );
});

test("formatAlreadyLoggedIn matches pre-move login.ts bytes", () => {
  assert.equal(
    formatAlreadyLoggedIn("alice"),
    "state: already_logged_in\n" +
      "Profile 'alice' is already logged in and its credential is valid. No action needed.\n" +
      "Next: use `raft --profile alice …` to act as this agent.\n",
  );
});

test("formatVerificationHandoff matches the pre-move inline list.ts bytes (both variants)", () => {
  assert.equal(
    formatVerificationHandoff(
      { verificationUri: "https://v", userCode: "AB-12", expiresInSeconds: 600 },
      { enterOpensBrowser: false },
    ),
    "Open this browser authorization URL: https://v\n" +
      "  Enter code AB-12 and approve the login in the browser; this command will continue automatically.\n" +
      "  Expires in ~10m.\n",
  );
  assert.equal(
    formatVerificationHandoff(
      { verificationUri: "https://v", userCode: "AB-12", expiresInSeconds: 90 },
      { enterOpensBrowser: true },
    ),
    "Press Enter to open the browser authorization URL: https://v\n" +
      "  Enter code AB-12 and approve the login in the browser; this command will continue automatically.\n" +
      "  Expires in ~1m.\n",
  );
});

// Re-login's previous key and `raft agent logout` (#wg-device-auth:#1): one
// line about the old key, before the Next lines; logout copy never names the key.
test("login report names what became of the previous key in one line before the Next lines", () => {
  const base = { agentName: "alice", server: "https://raft.example", credentialPath: "/p/alice/credential.json", profileSlug: "alice" };
  const line = (outcome: "revoked" | "already_inactive" | "still_active") =>
    formatAuthorizedLoginReport({ ...base, previousKey: { credentialId: "cred-old", outcome } }).split("\n")[2];
  assert.equal(line("revoked"), "The key this profile held before (credential cred-old) was revoked.");
  assert.equal(line("already_inactive"), "The key this profile held before (credential cred-old) was already not active on the server; nothing to revoke.");
  assert.equal(line("still_active"), "The key this profile held before (credential cred-old) is still active; if nothing else uses it, ask the user to revoke it in the token list on the agent's External setup card.");
  assert.equal(formatAuthorizedLoginReport(base).split("\n")[2]!.startsWith("Next (if you are the human operator)"), true);
});

test("logout copy", () => {
  assert.equal(
    formatLogoutReport("revoked", "cred-1", options, paths),
    "state: logged_out\n"
      + "This profile's key (credential cred-1) was revoked. Removed /p/alice/credential.json.\n"
      + "Next: to use this agent from this machine again, run `raft agent login start --server https://raft.example --agent alice`.\n",
  );
  assert.equal(
    formatLogoutReport("already_inactive", null, options, paths).split("\n")[1],
    "This profile's key was already not active on the server. Removed /p/alice/credential.json.",
  );
  assert.equal(
    formatLogoutNotLoggedIn(paths),
    "state: not_logged_in\nNo credential for profile 'alice' at /p/alice/credential.json. Nothing to log out; no action needed.\n",
  );
  assert.deepEqual(describeLogoutRevokeFailure("failed", "cred-1", paths), {
    code: "CREDENTIAL_REVOKE_FAILED",
    message: "Could not revoke this profile's key (credential cred-1): network or server error. It may still be active; /p/alice/credential.json was kept.",
    suggestedNextAction: "Retry `raft --profile alice agent logout` when the server is reachable. If it keeps failing, ask the user to revoke credential cred-1 in the token list on the agent's External setup card, then run `raft --profile alice agent logout` again to remove the file.",
  });
  assert.equal(describeLogoutRevokeFailure("unsupported", "cred-1", paths).code, "UNSUPPORTED_BY_SERVER");
  assert.equal(describeLogoutRevokeFailure("not_self_revocable", "cred-1", paths).code, "credential_not_self_revocable");
});
