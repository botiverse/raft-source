/**
 * Whether this deployment runs with RAFT_PRIVACY_MODE on: then the page sends
 * no telemetry (web traces, product analytics, public visit counts). Learned
 * from the per-deploy client config (`privacyMode`, store/clientConfig.ts).
 *
 * Three states, so privacy-on cannot leak before the answer:
 *   - `unknown` (page load until the config answers): telemetry is held in
 *     memory, nothing is sent, urgent events included. Nothing else waits.
 *   - `on` (the answer says `privacyMode: true`): everything held is dropped
 *     and nothing is ever sent.
 *   - `off` (any other answer, a missing field from an older server, or a
 *     failed read): everything held goes out, then sends are as before.
 * It changes once per page: unknown, then on or off.
 *
 * No imports on purpose: webAuthTrace.ts and analytics/track.ts read it and
 * must not pull app modules in (see webAuthTrace.ts's import note).
 */
export type PrivacyModeState = "unknown" | "on" | "off";

let state: PrivacyModeState = "unknown";
const listeners = new Set<(state: PrivacyModeState) => void>();

export function privacyModeState(): PrivacyModeState {
  return state;
}

export function isPrivacyModeOn(): boolean {
  return state === "on";
}

/** Not answered yet: hold telemetry, send nothing. */
export function isPrivacyModeUnknown(): boolean {
  return state === "unknown";
}

/**
 * Takes the client config's `privacyMode`: only `true` is on; anything else
 * (missing, a failed read) is off. Decided once: a later call never turns an
 * answered "on" off.
 */
export function setPrivacyMode(value: unknown): void {
  if (state !== "unknown") return;
  state = value === true ? "on" : "off";
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // A holder's release must never break the others.
    }
  }
}

/** Told when the state is decided (once per page: unknown to on or off). */
export function subscribePrivacyMode(listener: (state: PrivacyModeState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests: back to `unknown` (listeners stay: they belong to the modules). */
export function resetPrivacyModeForTests(): void {
  state = "unknown";
}
