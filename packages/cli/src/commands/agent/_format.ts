// Canonical agent login/bridge reply formatting for agent-facing output.
// Strings moved verbatim from login.ts/list.ts/bridge.ts (print-seam S3);
// byte-pin tests in _format.test.ts copy the pre-move inline literals.
// This is an AX contract, not an implementation detail.

import type { DeviceAuthorization } from "../../agentLogin/deviceAuthClient.js";
import { sampleLoginOptions, sampleProfilePaths } from "../_axExampleFixtures.js";
import { axSurface } from "../../core/renderer.js";

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

export const formatAuthorizedLoginReport = axSurface(
  "Login success report with profile usage and manual-get next steps.",
  (input: {
  agentName: string;
  server: string;
  credentialPath: string;
  profileSlug: string;
}): string => {
  const manualCommand = "raft manual get raft-cli-overview "
    + "--intent \"Get productive on Raft as a new agent\" "
    + "--reason \"Just logged in, need the CLI basics\"";
  return (
    `state: authorized\n` +
      `Logged in as '${input.agentName}' on ${input.server}. Credential saved to ${input.credentialPath}.\n` +
      `Next (if you are the human operator): start your agent with RAFT_PROFILE=${input.profileSlug} in its environment, and let the agent run \`${manualCommand}\` to learn the Raft CLI.\n` +
      `Next (if you are the agent): run \`${manualCommand}\`, then use \`raft --profile ${input.profileSlug} …\` for all commands.\n`
  );
},
  {
    examples: [{ args: [{ agentName: "alice", server: "https://raft.example", credentialPath: "/p/alice/credential.json", profileSlug: "alice" }] }],
  },
);

/** Human-readable verification handoff used by the device-code paths (stderr). */
export const formatVerificationHandoff = axSurface(
  "Device-code browser handoff prompt (stderr), pre-filled and manual-code variants.",
  (action: {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresInSeconds: number;
}, options: { enterOpensBrowser: boolean }): string => {
  const mins = Math.max(0, Math.floor(action.expiresInSeconds / 60));
  const url = action.verificationUriComplete ?? action.verificationUri;
  const openLine = options.enterOpensBrowser
    ? `Press Enter to open the browser authorization URL: ${url}\n`
    : `Open this browser authorization URL: ${url}\n`;
  if (action.verificationUriComplete) {
    return (
      openLine +
      `  Code is pre-filled. Approve the login in the browser; this command will continue automatically.\n` +
      `  Expires in ~${mins}m.\n`
    );
  }
  return (
    openLine +
    `  Enter code ${action.userCode} and approve the login in the browser; this command will continue automatically.\n` +
    `  Expires in ~${mins}m.\n`
  );
},
  {
    examples: [{ title: "manual code", args: [{ verificationUri: "https://github.example/device", userCode: "AB-12", expiresInSeconds: 600 }, { enterOpensBrowser: false }] }, { title: "pre-filled + Enter opens browser", args: [{ verificationUri: "https://github.example/device", verificationUriComplete: "https://github.example/device?c=1", userCode: "AB-12", expiresInSeconds: 90 }, { enterOpensBrowser: true }] }],
  },
);

/** `login start` handoff report (stdout, text-first). */
export const formatStartHandoff = axSurface(
  "login start report with authorization URL, code and wait command.",
  (
  authorization: DeviceAuthorization,
  options: { server: string; agent: string },
  paths: LoginProfilePaths,
): string => {
  const mins = Math.max(0, Math.floor(authorization.expiresInSeconds / 60));
  let out = `state: pending_human_action\n`;
  out += `Login started for profile '${paths.profileSlug}'. Ask the user to approve in a browser:\n`;
  if (authorization.verificationUriComplete) {
    out += `  Browser authorization URL (code pre-filled): ${authorization.verificationUriComplete}\n`;
  } else {
    out += `  Browser authorization URL: ${authorization.verificationUri}\n`;
    out += `  Enter code ${authorization.userCode} and approve the login.\n`;
  }
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

export const formatAgentTokenPrompt = axSurface(
  "Hidden terminal prompt for an existing agent token.",
  (): string => "Agent token (input hidden): ",
  { examples: [{ args: [] }] },
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
    `bridge: transient failure (${errorCode}: ${message}); retry #${consecutiveFailures} in ${Math.round(delayMs / 1000)}s. Pending wakes are not lost; \`raft message check\` still works directly.\n`
  );
},
  {
    examples: [{ args: ["SERVER_5XX", "boom", 2, 4000] }],
  },
);
