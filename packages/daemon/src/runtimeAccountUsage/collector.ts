import type { Runtime } from "@botiverse/oar";

import { loadOarRuntime } from "../oarLoader";

import type { RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";

import {
  projectOarAccountUsageFailure,
  projectOarAccountUsageSnapshot,
  type OarAccountUsageSnapshot,
} from "./oarAdapter";
import { RUNTIME_AUTH_OAR_ENV } from "../runtimeAuth/runtimeAuthHost";
import { resolveKimiCodeAuth, type KimiCodeAuth } from "./kimiAuth";
import { ensureFreshKimiToken, type KimiFreshness, type KimiRefreshDeps } from "./kimiTokenRefresh";


const DEFAULT_TIMEOUT_MS = 20_000;


/** Injectable for tests; production passes the real OAR runtime. */
export type OarUsageReadDeps = {
  readonly runtime?: Runtime;
  readonly timeoutMs?: number;
  /**
   * #triage:#253: Kimi Code's usage on the bundled SDK, read when OAR finds no
   * Kimi Code CLI (its reader needs one). Absent: such a Computer stays
   * `unsupported`, as before.
   */
  readonly kimiSdkUsage?: () => Promise<OarAccountUsageSnapshot>;
  /** task #1282 — seams for the kimi pre-probe refresh (production resolves the client's auth and refreshes for real). */
  readonly kimi?: {
    readonly resolveAuth?: (command: string) => Promise<KimiCodeAuth | null>;
    readonly ensureFresh?: (auth: KimiCodeAuth) => Promise<KimiFreshness>;
    readonly refresh?: KimiRefreshDeps;
    /**
     * Off until the shared-credential write-back is enabled (task #1282,
     * artin's call). While off, the kimi provider is read exactly as before
     * this change: no refresh, no file access beyond OAR's own read, and the
     * probe's outcome is projected unchanged — "refresh not enabled" can never
     * surface as a new login failure. When on, the refresh runs before the
     * probe and only a rejected or revoked token short-circuits to
     * `reauth_required`; a transient refresh failure on an expired token is
     * `error`, every other freshness lets the probe speak.
     */
    readonly enabled?: boolean;
  };
};

/**
 * task #1282 — what the kimi pre-probe refresh decided about the probe. The
 * freshness kinds that are not a verdict about the account let the probe run
 * and speak for itself.
 *
 * Contract (narrowed on review of #9802): "only an explicit rejection means
 * re-login" is a guarantee about THIS pre-step's own verdicts — it never
 * writes the client's tombstone and only an exact tombstone or a rejected
 * refresh short-circuits to `reauth_required`. Everything it hands to the
 * probe keeps OAR's existing panel result, unchanged by the gate: an absent
 * file (never logged in / logged out) and an unreadable or malformed one (a
 * damaged or foreign write) are different facts that OAR reads alike as
 * `credentials_missing`
 * (`reauth_required` on the wire); an expired token the pre-step could not
 * or did not refresh (win32, lock disabled, no refresh token) still reaches
 * the usage endpoint and reads as `credentials_rejected`; non-file storage
 * is OAR's `unsupported` before any token read — today's behavior, listed
 * as unresolved in KIMI_REFRESH_EVIDENCE.md.
 */
export function kimiProbeDecision(freshness: KimiFreshness): { kind: "probe" } | { kind: "reauth_required" } | { kind: "error" } {
  switch (freshness.kind) {
    case "rejected":
    case "revoked":
      return { kind: "reauth_required" };
    case "transient":
      // An expired token with no refresh result cannot confirm anything; a
      // still-valid token can be probed despite the failed refresh. A
      // malformed success response is one such result: nothing was written.
      return freshness.expired ? { kind: "error" } : { kind: "probe" };
    case "missing":
      // No usable token on disk (absent, unreadable, malformed, no refresh
      // token): not a verdict about the account; OAR's own read decides.
      return { kind: "probe" };
    default:
      return { kind: "probe" };
  }
}

/**
 * Reads one provider's account usage through OAR and projects it onto the Raft
 * wire shape.
 *
 * The two failure vocabularies are kept apart on purpose:
 *  - `unsupported` means Raft structurally cannot obtain a reading — the
 *    runtime exposes no probe or reader, or is not installed on this machine.
 *  - `error` means we tried and the attempt failed (threw, timed out, or
 *    returned something unusable).
 * Collapsing these would make "we never could" and "it broke just now" look
 * identical to every consumer downstream.
 */
export async function readOarAccountUsage(input: {
  provider: RuntimeAccountUsageProvider;
  localAccountSlot: string;
  collectorVersion: string;
  observedAtMs: number;
  deps?: OarUsageReadDeps;
}): Promise<RuntimeAccountUsageSnapshot> {
  const failure = (): RuntimeAccountUsageSnapshot =>
    projectOarAccountUsageFailure({
      provider: input.provider,
      localAccountSlot: input.localAccountSlot,
      collectorVersion: input.collectorVersion,
      observedAtMs: input.observedAtMs,
    });
  let runtime: Runtime;
  try {
    runtime = input.deps?.runtime ?? await loadOarRuntime(input.provider);
  } catch {
    return failure();
  }
  const project = (snapshot: OarAccountUsageSnapshot): RuntimeAccountUsageSnapshot =>
    projectOarAccountUsageSnapshot({
      provider: input.provider,
      snapshot,
      localAccountSlot: input.localAccountSlot,
      collectorVersion: input.collectorVersion,
      observedAtMs: input.observedAtMs,
    });

  const probe = runtime.installation;
  const readUsage = runtime.accountUsage;
  const kimiSdkUsage = input.provider === "kimi" ? input.deps?.kimiSdkUsage : undefined;
  // No Kimi Code CLI for OAR to read with: the SDK the agents run on reads it.
  const readOnSdk = async (): Promise<RuntimeAccountUsageSnapshot> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Kimi usage read timed out")), input.deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        timer.unref?.();
      });
      return project(await Promise.race([kimiSdkUsage!(), timedOut]));
    } catch {
      return failure();
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (!probe || !readUsage) {
    // Structural absence, not a failed attempt.
    return kimiSdkUsage ? readOnSdk() : project({ kind: "unsupported" });
  }

  try {
    const installation = await probe();
    if (installation.kind !== "available") {
      // `not_found` and `unsupported` are both "no reading is obtainable here".
      return kimiSdkUsage ? readOnSdk() : project({ kind: "unsupported" });
    }
    if (input.provider === "kimi" && input.deps?.kimi?.enabled === true) {
      // task #1282: the client's 15-minute access token is refreshed the way
      // the client refreshes it, before OAR reads the usage endpoint with it.
      const command = "command" in installation && typeof installation.command === "string" ? installation.command : "kimi";
      const resolveAuth = input.deps.kimi.resolveAuth ?? ((cmd: string) => resolveKimiCodeAuth({ command: cmd }));
      const auth = await resolveAuth(command);
      if (auth) {
        const ensureFresh = input.deps.kimi.ensureFresh ?? ((a: KimiCodeAuth) => ensureFreshKimiToken(a, input.deps?.kimi?.refresh));
        const decision = kimiProbeDecision(await ensureFresh(auth));
        if (decision.kind === "reauth_required") return project({ kind: "reauth_required", reason: "credentials_rejected" });
        if (decision.kind === "error") {
          return failure();
        }
      }
    }
    // Antigravity (OAR 0.103 runs `agy models`, then `agy -p /usage`): in the
    // environment its agents and its sign-in run in, so it reads the sign-in
    // they use (agy keeps another one under SSH).
    const env = input.provider === "antigravity" ? RUNTIME_AUTH_OAR_ENV.antigravity : undefined;
    const snapshot = await readUsage(installation, {
      ...(env ? { env } : {}),
      timeoutMs: input.deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Raft polls: the count of limit resets is enough, without Codex's
      // per-read lookup of their details (OAR falls back on an older Codex).
      limitResetDetails: false,
    });
    return project(snapshot);
  } catch {
    // A thrown read is an explicit error account with no windows. It must never
    // be rendered as zero usage.
    return failure();
  }
}

export type RuntimeAccountUsageCollector = (
  provider: RuntimeAccountUsageProvider,
) => Promise<RuntimeAccountUsageSnapshot>;

/** Read every provider through OAR and project its published usage contract. */
export function createRuntimeAccountUsageCollector(input: {
  localAccountSlot: string;
  collectorVersion: string;
  now?: () => number;
  /** Test seam for the OAR read; production uses the real runtimes. */
  oar?: OarUsageReadDeps;
}): RuntimeAccountUsageCollector {
  const now = input.now ?? Date.now;
  return (provider) => readOarAccountUsage({
    provider,
    localAccountSlot: input.localAccountSlot,
    collectorVersion: input.collectorVersion,
    observedAtMs: now(),
    ...(input.oar ? { deps: input.oar } : {}),
  });
}
