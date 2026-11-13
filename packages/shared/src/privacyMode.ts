// Self-hosted privacy mode (`RAFT_PRIVACY_MODE`). When on, a deployment sends
// nothing to Raft's own services: no trace export, no product analytics or
// public visit counts, no feedback or diagnostic uploads, no automatic update
// checks against hands.build, no Raft-hosted template logos. Traffic the
// operator configured themselves (AI providers, their own integrations and
// managed MCP Apps) is not affected, and a manual pinned upgrade still works.
//
// Read once at startup. An unrecognised value is a configuration error and
// must stop startup, never be guessed at inside a request.

export const PRIVACY_MODE_ENV = "RAFT_PRIVACY_MODE";

const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["", "0", "false", "off", "no"]);

export class PrivacyModeConfigError extends Error {
  constructor(value: string) {
    super(`${PRIVACY_MODE_ENV} must be one of on/off (also 1/0, true/false, yes/no); got "${value}"`);
    this.name = "PrivacyModeConfigError";
  }
}

/** Parse `RAFT_PRIVACY_MODE`. Unset or empty is off; anything unrecognised throws. */
export function parsePrivacyMode(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (ON.has(value)) return true;
  if (OFF.has(value)) return false;
  throw new PrivacyModeConfigError(raw ?? "");
}

/** Read and validate `RAFT_PRIVACY_MODE` from an environment. Throws on an invalid value. */
export function privacyModeFromEnv(env: Record<string, string | undefined>): boolean {
  return parsePrivacyMode(env[PRIVACY_MODE_ENV]);
}
