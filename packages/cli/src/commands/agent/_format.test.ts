import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAlreadyLoggedIn,
  formatBridgeRecovered,
  formatBridgeStreamFallback,
  formatBridgeTransientFailure,
  formatCredentialRemintNotice,
  formatLoginStateMissing,
  formatVerificationHandoff,
} from "./_format.js";

// Byte pins: expected strings below are copied from the PRE-MOVE inline
// literals in login.ts/list.ts/bridge.ts (print-seam S3), not from the new
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

test("formatCredentialRemintNotice matches pre-move login.ts bytes", () => {
  assert.equal(
    formatCredentialRemintNotice("alice"),
    "Existing credential for profile 'alice' is no longer valid. Provide a replacement agent token.\n",
  );
});

test("bridge diagnostics match pre-move bridge.ts bytes", () => {
  assert.equal(formatBridgeRecovered(3), "bridge: recovered after 3 transient failure(s); bridge resumed.\n");
  assert.equal(formatBridgeStreamFallback(), "bridge: wake-hint stream unavailable; falling back to polling.\n");
  assert.equal(
    formatBridgeTransientFailure("SERVER_5XX", "boom", 2, 4000),
    "bridge: transient failure (SERVER_5XX: boom); retry #2 in 4s. Pending wakes are not lost; `raft message check` still works directly.\n",
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
      { verificationUri: "https://v", verificationUriComplete: "https://v?c=1", userCode: "AB-12", expiresInSeconds: 90 },
      { enterOpensBrowser: true },
    ),
    "Press Enter to open the browser authorization URL: https://v?c=1\n" +
      "  Code is pre-filled. Approve the login in the browser; this command will continue automatically.\n" +
      "  Expires in ~1m.\n",
  );
});
