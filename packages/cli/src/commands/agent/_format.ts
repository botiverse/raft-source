// Canonical agent login/bridge reply formatting for agent-facing output.
// Strings moved verbatim from login.ts/list.ts/bridge.ts (print-seam S3);
// byte-pin tests in _format.test.ts copy the pre-move inline literals.
// This is an AX contract, not an implementation detail.

import type { DeviceAuthorization } from "../../agentLogin/deviceAuthClient";
import { sampleLoginOptions, sampleProfilePaths } from "../_axExampleFixtures";
import { axSurface } from "../../core/renderer";

export interface LoginProfilePaths {
  profileSlug: string;
  profileDir: string;
  credentialPath: string;
}

export type LoginCredentialOutcome = "already_logged_in" | "mismatch" | "expired" | "unverified" | "invalid";

export function startCommandLine(options: { server: string; agent: string }, paths: LoginProfilePaths): string {
  const slugFlag = paths.profileSlug !== options.agent ? ` --profile-slug ${paths.profileSlug}` : "";
  return `raft agent login start --server ${options.server} --agent ${options.agent}${slugFlag}`;
}

export function waitCommandLine(
  options: { server: string; agent: string },
  paths: LoginProfilePaths,
  deviceCode: string,
): string {
  const slugFlag = paths.profileSlug !== options.agent ? ` --profile-slug ${paths.profileSlug}` : "";
  return `raft agent login wait --server ${options.server} --agent ${options.agent} --device-code ${deviceCode}${slugFlag}`;
}

/**
 * What happened to the key a `login wait` re-login replaced: revoked with
 * itself, already refused by the server (401), or still active (revoke
 * refused, unsupported, or failed) and the user has to revoke it.
 */
export type PreviousKeyOutcome = "revoked" | "already_inactive" | "still_active";

function formatPreviousKeyLine(previous: { credentialId: string; outcome: PreviousKeyOutcome }): string {
  const subject = `The key this profile held before (credential ${previous.credentialId})`;
  switch (previous.outcome) {
    case "revoked":
      return `${subject} was revoked.\n`;
    case "already_inactive":
      return `${subject} was already not active on the server; nothing to revoke.\n`;
    case "still_active":
    default:
      return `${subject} is still active; if nothing else uses it, ask the user to revoke it in the token list on the agent's External setup card.\n`;
  }
}

export const formatAuthorizedLoginReport = axSurface(
  "Login success report with profile usage and manual-get next steps.",
  (input: {
  agentName: string;
  server: string;
  credentialPath: string;
  profileSlug: string;
  /**
   * The key this profile held before (login wait cannot rotate it), and what
   * revoking it with itself did after the new key was saved.
   */
  previousKey?: { credentialId: string; outcome: PreviousKeyOutcome };
}): string => {
  const manualCommand = "raft manual get raft-cli-overview "
    + "--intent \"Get productive on Raft as a new agent\" "
    + "--reason \"Just logged in, need the CLI basics\"";
  const previousKeyLine = input.previousKey ? formatPreviousKeyLine(input.previousKey) : "";
  return (
    `state: authorized\n` +
      `Logged in as '${input.agentName}' on ${input.server}. Credential saved to ${input.credentialPath}.\n` +
      previousKeyLine +
      `Next (if you are the human operator): start your agent with RAFT_PROFILE=${input.profileSlug} in its environment, and let the agent run \`${manualCommand}\` to learn the Raft CLI.\n` +
      `Next (if you are the agent): run \`${manualCommand}\`, then use \`raft --profile ${input.profileSlug} …\` for all commands.\n`
  );
},
  {
    examples: [
      { args: [{ agentName: "alice", server: "https://raft.example", credentialPath: "/p/alice/credential.json", profileSlug: "alice" }] },
      { title: "previous key revoked", args: [{ agentName: "alice", server: "https://raft.example", credentialPath: "/p/alice/credential.json", profileSlug: "alice", previousKey: { credentialId: "cred-old", outcome: "revoked" } }] },
      { title: "previous key already not active", args: [{ agentName: "alice", server: "https://raft.example", credentialPath: "/p/alice/credential.json", profileSlug: "alice", previousKey: { credentialId: "cred-old", outcome: "already_inactive" } }] },
      { title: "previous key still active", args: [{ agentName: "alice", server: "https://raft.example", credentialPath: "/p/alice/credential.json", profileSlug: "alice", previousKey: { credentialId: "cred-old", outcome: "still_active" } }] },
    ],
  },
);

/** Human-readable verification handoff used by the device-code paths (stderr). */
export const formatVerificationHandoff = axSurface(
  "Device-code browser handoff prompt (stderr): the approval page and the code to type there.",
  (action: {
  verificationUri: string;
  userCode: string;
  expiresInSeconds: number;
}, options: { enterOpensBrowser: boolean }): string => {
  const mins = Math.max(0, Math.floor(action.expiresInSeconds / 60));
  const openLine = options.enterOpensBrowser
    ? `Press Enter to open the browser authorization URL: ${action.verificationUri}\n`
    : `Open this browser authorization URL: ${action.verificationUri}\n`;
  return (
    openLine +
    `  Enter code ${action.userCode} and approve the login in the browser; this command will continue automatically.\n` +
    `  Expires in ~${mins}m.\n`
  );
},
  {
    examples: [{ title: "manual code", args: [{ verificationUri: "https://github.example/device", userCode: "AB-12", expiresInSeconds: 600 }, { enterOpensBrowser: false }] }, { title: "Enter opens browser", args: [{ verificationUri: "https://github.example/device", userCode: "AB-12", expiresInSeconds: 90 }, { enterOpensBrowser: true }] }],
  },
);

/** `login start` handoff report (stdout, text-first). */
export const formatStartHandoff = axSurface(
  "login start report with authorization URL, code, agent pick and wait command.",
  (
  authorization: DeviceAuthorization,
  options: { server: string; agent: string },
  paths: LoginProfilePaths,
): string => {
  const mins = Math.max(0, Math.floor(authorization.expiresInSeconds / 60));
  let out = `state: pending_human_action\n`;
  out += `Login started for profile '${paths.profileSlug}'. Ask the user to give this agent a key in a browser:\n`;
  out += `  Browser authorization URL: ${authorization.verificationUri}\n`;
  out += `  Enter code ${authorization.userCode}, choose this agent as the one the key is for, and approve.\n`;
  out += `  Code expires in ~${mins}m.\n`;
  out += `Next: after the user approves, run \`${waitCommandLine(options, paths, authorization.deviceCode)}\` to finish.\n`;
  return (out);
},
  {
    examples: [{ args: [{ deviceCode: "dev-code-1", userCode: "AB-12", verificationUri: "https://github.example/device", expiresInSeconds: 600 } as never, sampleLoginOptions, sampleProfilePaths] }],
  },
);

/** `login status` report (stdout, text-first). */
export const formatLoginStatus = axSurface(
  "login status classification (usable/expired/mismatch/invalid/unverified).",
  (
  outcome: LoginCredentialOutcome,
  options: { server: string; agent: string },
  paths: LoginProfilePaths,
): string => {
  const slug = paths.profileSlug;
  switch (outcome) {
    case "already_logged_in":
      return (
        `state: usable\n` +
        `Profile '${slug}' is logged in and the credential is valid. No action needed.\n` +
        `Next: use \`raft --profile ${slug} …\` to act as this agent.\n`
      );
    case "expired":
      return (
        `state: expired\n` +
        `The credential for profile '${slug}' is no longer valid (revoked or expired on the server).\n` +
        `Next: run \`${startCommandLine(options, paths)}\` to re-login.\n`
      );
    case "mismatch":
      return (
        `state: mismatch\n` +
        `Profile '${slug}' is bound to a different agent or server than requested.\n` +
        `Next: re-check --agent / --server, or use a different \`--profile-slug <slug>\`.\n`
      );
    case "invalid":
      return (
        `state: invalid\n` +
        `The credential file for profile '${slug}' is malformed or missing required fields (${paths.credentialPath}).\n` +
        `Next: run \`${startCommandLine(options, paths)}\` to re-login.\n`
      );
    case "unverified":
    default:
      return (
        `state: unverified\n` +
        `Could not reach the server to verify profile '${slug}' (network or server error). The credential may still be valid — do not assume it is invalid.\n` +
        `Next: retry \`raft agent login status\` when connectivity is restored.\n`
      );
  }
},
  {
    examples: [{ title: "usable", args: ["already_logged_in", sampleLoginOptions, sampleProfilePaths] }, { title: "expired", args: ["expired", sampleLoginOptions, sampleProfilePaths] }],
  },
);

export const formatLoginStateMissing = axSurface(
  "Missing-credential status with the exact start command.",
  (
  options: { server: string; agent: string },
  paths: LoginProfilePaths,
): string => {
  return (
    `state: missing\n` +
      `No credential for profile '${paths.profileSlug}' at ${paths.credentialPath}.\n` +
      `Next: run \`${startCommandLine(options, paths)}\` to log in.\n`
  );
},
  {
    examples: [{ args: [sampleLoginOptions, sampleProfilePaths] }],
  },
);

export const formatAlreadyLoggedIn = axSurface(
  "Idempotent-login short-circuit notice.",
  (profileSlug: string): string => {
  return (
    `state: already_logged_in\n` +
      `Profile '${profileSlug}' is already logged in and its credential is valid. No action needed.\n` +
      `Next: use \`raft --profile ${profileSlug} …\` to act as this agent.\n`
  );
},
  {
    examples: [{ args: ["alice"] }],
  },
);

export const formatCredentialRemintNotice = axSurface(
  "Invalid-credential re-mint notice (stderr).",
  (profileSlug: string): string => {
  return (
    `Existing credential for profile '${profileSlug}' is no longer valid. Provide a replacement agent token.\n`
  );
},
  {
    examples: [{ args: ["alice"] }],
  },
);

// ---------------------------------------------------------------------------
// `raft agent logout`
// ---------------------------------------------------------------------------

/** The command that logs this profile out, as the agent would run it again. */
export function logoutCommandLine(profileSlug: string): string {
  return `raft --profile ${profileSlug} agent logout`;
}

function profileKeySubject(credentialId: string | null): string {
  return credentialId ? `This profile's key (credential ${credentialId})` : "This profile's key";
}

/** What logout did with the key before it removed the file (only these two remove it). */
export type LogoutRevokeOutcome = "revoked" | "already_inactive";

export const formatLogoutReport = axSurface(
  "agent logout report: the profile's key was revoked (or was already not active) and its credential file removed.",
  (
  outcome: LogoutRevokeOutcome,
  credentialId: string | null,
  options: { server: string; agent: string },
  paths: LoginProfilePaths,
): string => {
  const key = profileKeySubject(credentialId);
  const what = outcome === "revoked" ? `${key} was revoked` : `${key} was already not active on the server`;
  return (
    `state: logged_out\n` +
      `${what}. Removed ${paths.credentialPath}.\n` +
      `Next: to use this agent from this machine again, run \`${startCommandLine(options, paths)}\`.\n`
  );
},
  {
    examples: [
      { title: "revoked", args: ["revoked", "cred-1", sampleLoginOptions, sampleProfilePaths] },
      { title: "already not active", args: ["already_inactive", "cred-1", sampleLoginOptions, sampleProfilePaths] },
    ],
  },
);

export const formatLogoutNotLoggedIn = axSurface(
  "agent logout on a profile with no credential file: nothing to do.",
  (paths: LoginProfilePaths): string => {
  return (
    `state: not_logged_in\n` +
      `No credential for profile '${paths.profileSlug}' at ${paths.credentialPath}. Nothing to log out; no action needed.\n`
  );
},
  {
    examples: [{ args: [sampleProfilePaths] }],
  },
);

/**
 * Error copy when logout could not revoke the key: the file is kept, so the
 * profile still holds a key that may be active. The next step names who can
 * revoke it and how to finish (a rerun then sees 401 and removes the file).
 */
export function describeLogoutRevokeFailure(
  outcome: "not_self_revocable" | "unsupported" | "failed",
  credentialId: string | null,
  paths: LoginProfilePaths,
): { code: string; message: string; suggestedNextAction: string } {
  const key = profileKeySubject(credentialId);
  const userRevokes = `ask the user to revoke ${credentialId ? `credential ${credentialId}` : "this agent's key"} in the token list on the agent's External setup card, then run \`${logoutCommandLine(paths.profileSlug)}\` again to remove the file.`;
  switch (outcome) {
    case "not_self_revocable":
      return {
        code: "credential_not_self_revocable",
        message: `${key} is managed by the system that issued it and cannot revoke itself. It is still active; ${paths.credentialPath} was kept.`,
        suggestedNextAction: `To log out anyway, ${userRevokes}`,
      };
    case "unsupported":
      return {
        code: "UNSUPPORTED_BY_SERVER",
        message: `This server cannot revoke a key from the CLI yet. ${key} is still active; ${paths.credentialPath} was kept.`,
        suggestedNextAction: `To log out anyway, ${userRevokes}`,
      };
    case "failed":
    default:
      return {
        code: "CREDENTIAL_REVOKE_FAILED",
        message: `Could not revoke ${key.charAt(0).toLowerCase()}${key.slice(1)}: network or server error. It may still be active; ${paths.credentialPath} was kept.`,
        suggestedNextAction: `Retry \`${logoutCommandLine(paths.profileSlug)}\` when the server is reachable. If it keeps failing, ${userRevokes}`,
      };
  }
}

export const agentTokenStdinGuidance ="Pipe the agent token from your secret manager or redirect an existing token file into this command: raft agent login --server <url> --agent <agentId> --profile-slug <slug> < /path/to/agent-token";

export const formatAgentTokenPrompt = axSurface(
  "Hidden terminal prompt or non-TTY stdin guidance for an existing agent token.",
  (terminal = true): string => terminal
    ? "Agent token (input hidden): "
    : `No interactive terminal (TTY). Reading the agent token from stdin. ${agentTokenStdinGuidance}\n`,
  { examples: [{ args: [] }, { title: "non-TTY stdin", args: [false] }] },
);

export const formatBridgeRecovered = axSurface(
  "Bridge recovery diagnostic after transient failures.",
  (consecutiveFailures: number): string => {
  return (`bridge: recovered after ${consecutiveFailures} transient failure(s); bridge resumed.\n`);
},
  {
    examples: [{ args: [3] }],
  },
);

export const formatBridgeStreamFallback = axSurface(
  "Bridge wake-stream unavailable, polling fallback diagnostic.",
  (): string => {
  return (`bridge: wake-hint stream unavailable; falling back to polling.\n`);
},
  {
    examples: [{ args: [] }],
  },
);

export const formatBridgeTransientFailure = axSurface(
  "Bridge transient-failure retry diagnostic with backoff.",
  (
  errorCode: string,
  message: string,
  consecutiveFailures: number,
  delayMs: number,
): string => {
  return (
    `bridge: transient failure (${errorCode}: ${message}); retry #${consecutiveFailures} in ${Math.round(delayMs / 1000)}s. Pending wakes are not lost; \`raft inbox check\` still works directly.\n`
  );
},
  {
    examples: [{ args: ["SERVER_5XX", "boom", 2, 4000] }],
  },
);
