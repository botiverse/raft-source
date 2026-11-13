import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  clearClockTimeout,
  compareComputerVersions,
  type DaemonInstallKind,
  isComputerSemver,
  REMOTE_COMPUTER_UPGRADE_PLATFORM_HOLD_FEATURE_FLAG_KEYS,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { evaluateFeatureFlag } from "./featureFlagService";
import { isPrivacyModeOn } from "../config/privacyMode";

// Keep the existing response/snapshot field names for older Web/Computer clients.
// They describe a Hands release selection now, not a Server-maintained allowlist.
export interface ComputerPlatform {
  os: "linux" | "macos" | "windows";
  architecture: "x64" | "arm64";
}
// stored_report: the version this machine last reported, read from its row
// because no live connection fact is available yet (the window between a
// reconnect and this replica seeing the new connection's `ready`). Display
// fallback only; checks that need a live answer require owner_connection.
export type ComputerSourceFactProvenance = "owner_connection" | "replica_meta" | "stored_report";
export interface ComputerSourceFact {
  version: string | null;
  observedAt: string | null;
  provenance: ComputerSourceFactProvenance | null;
}
export interface ComputerHandsReleaseIdentity {
  releaseId: string;
  buildId: string;
  channel: "main";
  version: string;
  sha256: string;
  size: number;
  url: string;
}
export interface ComputerBroadcastPolicyDecision {
  eligibility: "eligible" | "no_broadcast";
  reasonCode: "eligible" | "source_missing" | "source_unparseable" | "platform_unknown"
    | "hands_unavailable" | "hands_response_invalid" | "hands_artifact_missing"
    | "already_current" | "requested_target_mismatch"
    // A per-platform hold flag could not be read: fail closed.
    | "broadcast_gate_unavailable"
    // An operator held web upgrades for this machine's OS
    // (remote_computer_upgrade_hold_<os>).
    | "platform_held"
    // The Computer said it cannot reach its own service, which relays web
    // upgrades (COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE): manual commands.
    | "service_unreachable"
    // The Computer runs inside Raft Desktop (`ready.installKind` "electron"):
    // Desktop updates its bundled Computer itself, and the standalone
    // installer a web upgrade drives cannot replace it.
    | "managed_by_desktop"
    // Historical reason codes remain readable in stored receipts and clients.
    // broadcast_disabled: the retired remote_computer_upgrade_v2 gate was off.
    | "broadcast_disabled" | "policy_row_missing" | "policy_expired";
  policyRevision: string | null;
  sourceVersion: string | null;
  sourceObservedAt: string | null;
  sourceProvenance: ComputerSourceFactProvenance | null;
  platform: ComputerPlatform | null;
  targetVersion: string | null;
  targetRole: "K" | "post_K" | "independent_bugfix" | null;
  migrationClass: "controlled_reinstall_repair" | "seamless" | null;
  policyRow: null;
  handsRelease?: ComputerHandsReleaseIdentity;
}
export interface EvaluateComputerBroadcastPolicyInput {
  source: ComputerSourceFact | null;
  platform: ComputerPlatform | null;
  requestedTargetVersion?: string | null;
  now: Date;
  /**
   * Server the machine belongs to; the per-platform hold flags are evaluated
   * for it. Required: without it a hold flag cannot be evaluated and the
   * platform would read as not held.
   */
  serverId: string;
  /**
   * The connected Computer reported that its runner cannot reach its service
   * (`COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE`). Absent or false: offered
   * as before (older Computers never report it).
   */
  serviceUnreachable?: boolean;
  /**
   * How the Computer's daemon runs, from its latest `ready` (machine row
   * `install_kind`). "electron" (Raft Desktop's bundled Computer) is never
   * offered a web upgrade; null/absent (older daemons) and "sea"/"node" are
   * evaluated as before.
   */
  installKind?: DaemonInstallKind | null;
}
export interface ComputerHandsResolutionDependencies {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /**
   * Override for the per-platform hold. Tests inject this; production leaves
   * it unset and the real feature flags are read.
   */
  isPlatformHeld?: (serverId: string | null, os: ComputerPlatform["os"]) => boolean | Promise<boolean>;
}
// Task #805 (artin, 2026-09-13): the Server-driven check that users see on the
// Computer page always resolves the STABLE channel (`main`). Alpha is a manual
// path (`install.sh --channel alpha`) and is never broadcast from here. This one
// function feeds the machine list, the control POST, lifecycle-operation
// creation and orchestrator dispatch, so there is exactly one place to change.
export const COMPUTER_HANDS_MAIN_URL =
  "https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=main&product_type=cli-binary";

// Full SemVer, shared with the web so both read a version the same way.
const versionSchema = z.string().refine(isComputerSemver);
const releaseSchema = z.object({
  app: z.object({ slug: z.literal("raft-computer-cli"), platform: z.literal("node") }),
  // Fail closed on any other channel: a response for `alpha` (or an alias that
  // echoes a different name) must never be projected as the stable target.
  channel: z.literal("main"),
  build: z.object({ id: z.string().min(1), version: versionSchema }),
  scoped: z.object({ release_id: z.string().min(1) }),
  assets: z.array(z.object({
    platform: z.string(), arch: z.string(), variant: z.string().nullable(), filetype: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().positive().safe(),
    download_url: z.string().url().refine((url) => new URL(url).protocol === "https:"),
  })),
});
type HandsRelease = z.infer<typeof releaseSchema>;

// Only collapse concurrent reads (e.g. a machine-list response). No stale cache
// can keep a withdrawn release eligible at a later dispatch attempt.
let pendingRelease: Promise<HandsRelease> | null = null;
async function fetchRelease(deps: ComputerHandsResolutionDependencies): Promise<HandsRelease> {
  const controller = new AbortController();
  const timer = setClockTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
  try {
    const response = await (deps.fetchFn ?? fetch)(COMPUTER_HANDS_MAIN_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) throw new Error("Hands unavailable");
    return releaseSchema.parse(await response.json());
  } finally {
    clearClockTimeout(timer);
  }
}
function readRelease(deps: ComputerHandsResolutionDependencies): Promise<HandsRelease> {
  // RAFT_PRIVACY_MODE: Hands is never asked; the decision is `hands_unavailable`.
  if (isPrivacyModeOn()) return Promise.reject(new Error("Hands not contacted (privacy mode)"));
  if (deps.fetchFn || deps.timeoutMs !== undefined) return fetchRelease(deps);
  pendingRelease ??= fetchRelease(deps).finally(() => { pendingRelease = null; });
  return pendingRelease;
}

export function normalizeComputerPlatform(rawOs: string | null | undefined): ComputerPlatform | null {
  if (!rawOs) return null;
  const normalized = rawOs.trim().toLowerCase().replace(/[_-]+/g, " ");
  const architecture = /\barm64\b|\baarch64\b/.test(normalized)
    ? "arm64"
    : /\bx64\b|\bx86 64\b|\bamd64\b/.test(normalized)
      ? "x64"
      : null;
  if (!architecture) return null;
  const os = /\bdarwin\b|\bmacos\b|\bmac os\b/.test(normalized)
    ? "macos"
    : /\blinux\b/.test(normalized)
      ? "linux"
      : /\bwindows\b|\bwin32\b/.test(normalized)
        ? "windows"
        : null;
  return os ? { os, architecture } : null;
}

/**
 * Refusal code of a web upgrade request for a Computer whose OS is held
 * (`platform_held`). Informative (not in REFUSAL_CODES): clients show the
 * Server's sentence and refresh the machine list, which shows the commands.
 */
export const COMPUTER_UPGRADE_PAUSED_FOR_PLATFORM_CODE = "COMPUTER_UPGRADE_PAUSED_FOR_PLATFORM";

async function readPlatformHoldFlag(serverId: string | null, os: ComputerPlatform["os"]): Promise<boolean> {
  return (await evaluateFeatureFlag({
    key: REMOTE_COMPUTER_UPGRADE_PLATFORM_HOLD_FEATURE_FLAG_KEYS[os],
    serverId,
  })).enabled;
}

/** `null`: not held. An unreadable hold is not permission to broadcast. */
async function readPlatformHold(
  serverId: string | null,
  os: ComputerPlatform["os"],
  deps: ComputerHandsResolutionDependencies,
): Promise<"platform_held" | "broadcast_gate_unavailable" | null> {
  try {
    const held = deps.isPlatformHeld
      ? await deps.isPlatformHeld(serverId, os)
      : await readPlatformHoldFlag(serverId, os);
    return held ? "platform_held" : null;
  } catch {
    return "broadcast_gate_unavailable";
  }
}

export async function evaluateBroadcastPolicy(
  input: EvaluateComputerBroadcastPolicyInput,
  deps: ComputerHandsResolutionDependencies = {},
): Promise<ComputerBroadcastPolicyDecision> {
  const decision: ComputerBroadcastPolicyDecision = {
    eligibility: "no_broadcast", reasonCode: "hands_unavailable", policyRevision: null,
    sourceVersion: input.source?.version ?? null,
    sourceObservedAt: input.source?.observedAt ?? null,
    sourceProvenance: input.source?.provenance ?? null,
    platform: input.platform, targetVersion: null, targetRole: null, migrationClass: null, policyRow: null,
  };
  // Raft Desktop's bundled Computer: Desktop updates it, so it is never
  // offered a web upgrade. It reads one input and contacts nothing.
  if (input.installKind === "electron") return { ...decision, reasonCode: "managed_by_desktop" };

  if (!input.source?.version) return { ...decision, reasonCode: "source_missing" };
  if (!versionSchema.safeParse(input.source.version).success) return { ...decision, reasonCode: "source_unparseable" };
  if (!input.platform) return { ...decision, reasonCode: "platform_unknown" };
  // Per-platform emergency hold (10-24): before Hands is contacted, so a held
  // platform causes no outbound request. A missing flag is not held.
  const hold = await readPlatformHold(input.serverId ?? null, input.platform.os, deps);
  if (hold) return { ...decision, reasonCode: hold };
  if (input.serviceUnreachable) return { ...decision, reasonCode: "service_unreachable" };
  let release: HandsRelease;
  try {
    release = await readRelease(deps);
  } catch (error) {
    return { ...decision, reasonCode: error instanceof z.ZodError || error instanceof SyntaxError
      ? "hands_response_invalid" : "hands_unavailable" };
  }
  const os = { macos: "darwin", linux: "linux", windows: "win32" }[input.platform.os];
  const assets = release.assets.filter((asset) => asset.platform === os
    && asset.arch === input.platform!.architecture && asset.variant === null && asset.filetype === "binary");
  if (assets.length !== 1) return { ...decision, reasonCode: "hands_artifact_missing" };
  const asset = assets[0]!;
  const selected: ComputerBroadcastPolicyDecision = {
    ...decision,
    policyRevision: `hands:main:${release.scoped.release_id}`,
    targetVersion: release.build.version, targetRole: "post_K", migrationClass: "seamless",
    handsRelease: { releaseId: release.scoped.release_id, buildId: release.build.id, channel: "main",
      version: release.build.version, sha256: asset.sha256, size: asset.size_bytes, url: asset.download_url },
  };
  if (input.requestedTargetVersion != null && input.requestedTargetVersion !== release.build.version) {
    return { ...selected, reasonCode: "requested_target_mismatch" };
  }
  if (compareComputerVersions(release.build.version, input.source.version) <= 0) {
    return { ...selected, reasonCode: "already_current" };
  }
  return { ...selected, eligibility: "eligible", reasonCode: "eligible" };
}

/**
 * Evaluator for callers that decide many machines in one request (the machine
 * list). A platform hold depends only on serverId and OS, so it is read once
 * per pair and shared. A failed read is shared too, so every machine of that
 * server and OS reports `broadcast_gate_unavailable`, as it would one by one.
 * Not a cache: create one per request so a flag change is seen next request.
 */
export function createBatchBroadcastPolicyEvaluator(
  deps: ComputerHandsResolutionDependencies = {},
): (input: EvaluateComputerBroadcastPolicyInput) => Promise<ComputerBroadcastPolicyDecision> {
  const holds = new Map<string, Promise<boolean>>();
  const readHold = deps.isPlatformHeld ?? readPlatformHoldFlag;
  const isPlatformHeld = (serverId: string | null, os: ComputerPlatform["os"]): Promise<boolean> => {
    const key = `${serverId ?? ""}\0${os}`;
    let hold = holds.get(key);
    if (!hold) {
      hold = (async () => readHold(serverId, os))();
      holds.set(key, hold);
    }
    return hold;
  };
  return (input) => evaluateBroadcastPolicy(input, { ...deps, isPlatformHeld });
}

export function projectComputerBroadcastPolicyDecision(
  decision: ComputerBroadcastPolicyDecision,
): Pick<
  ComputerBroadcastPolicyDecision,
  "eligibility" | "targetVersion" | "targetRole" | "migrationClass" | "policyRevision" | "reasonCode"
> {
  return {
    eligibility: decision.eligibility,
    targetVersion: decision.targetVersion,
    targetRole: decision.targetRole,
    migrationClass: decision.migrationClass,
    policyRevision: decision.policyRevision,
    reasonCode: decision.reasonCode,
  };
}

// Revalidate an unsent queued command against the same Hands identity. A new
// stable release or changed artifact must not silently retarget an existing operation.
export function isQueuedComputerUpgradePolicyCompatible(
  persistedSnapshot: unknown,
  currentDecision: ComputerBroadcastPolicyDecision,
): boolean {
  if (!persistedSnapshot || typeof persistedSnapshot !== "object" || Array.isArray(persistedSnapshot)) return false;
  const persisted = persistedSnapshot as Partial<ComputerBroadcastPolicyDecision>;
  return persisted.eligibility === "eligible" && currentDecision.eligibility === "eligible"
    && persisted.reasonCode === "eligible" && currentDecision.reasonCode === "eligible"
    && persisted.sourceVersion === currentDecision.sourceVersion
    && persisted.targetVersion === currentDecision.targetVersion
    && isDeepStrictEqual(persisted.platform, currentDecision.platform)
    && Boolean(persisted.handsRelease) && Boolean(currentDecision.handsRelease)
    && isDeepStrictEqual(persisted.handsRelease, currentDecision.handsRelease);
}
