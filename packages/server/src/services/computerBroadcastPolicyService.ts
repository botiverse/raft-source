import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";

// Keep the existing response/snapshot field names for older Web/Computer clients.
// They describe a Hands release selection now, not a Server-maintained allowlist.
export interface ComputerPlatform {
  os: "linux" | "macos" | "windows";
  architecture: "x64" | "arm64";
}
export type ComputerSourceFactProvenance = "owner_connection" | "replica_meta";
export interface ComputerSourceFact {
  version: string | null;
  observedAt: string | null;
  provenance: ComputerSourceFactProvenance | null;
}
export interface ComputerHandsReleaseIdentity {
  releaseId: string;
  buildId: string;
  channel: "alpha";
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
    // Historical reason codes remain readable in stored receipts and clients.
    | "policy_row_missing" | "policy_expired";
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
}
export interface ComputerHandsResolutionDependencies {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}
export const COMPUTER_HANDS_ALPHA_URL =
  "https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=alpha&product_type=cli-binary";

const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/)
  .refine((value) => {
    const pre = value.split("+", 1)[0]!.split("-").slice(1).join("-");
    return !pre.split(".").some((part) => /^0\d+$/.test(part));
  });
const releaseSchema = z.object({
  app: z.object({ slug: z.literal("raft-computer-cli"), platform: z.literal("node") }),
  channel: z.literal("alpha"),
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
    const response = await (deps.fetchFn ?? fetch)(COMPUTER_HANDS_ALPHA_URL, {
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
  if (deps.fetchFn || deps.timeoutMs !== undefined) return fetchRelease(deps);
  pendingRelease ??= fetchRelease(deps).finally(() => { pendingRelease = null; });
  return pendingRelease;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const withoutBuild = value.split("+", 1)[0]!;
    const separator = withoutBuild.indexOf("-");
    return {
      core: (separator < 0 ? withoutBuild : withoutBuild.slice(0, separator)).split(".").map(BigInt),
      pre: separator < 0 ? null : withoutBuild.slice(separator + 1).split("."),
    };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
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
  if (!input.source?.version) return { ...decision, reasonCode: "source_missing" };
  if (!versionSchema.safeParse(input.source.version).success) return { ...decision, reasonCode: "source_unparseable" };
  if (!input.platform) return { ...decision, reasonCode: "platform_unknown" };
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
    policyRevision: `hands:alpha:${release.scoped.release_id}`,
    targetVersion: release.build.version, targetRole: "post_K", migrationClass: "seamless",
    handsRelease: { releaseId: release.scoped.release_id, buildId: release.build.id, channel: "alpha",
      version: release.build.version, sha256: asset.sha256, size: asset.size_bytes, url: asset.download_url },
  };
  if (input.requestedTargetVersion != null && input.requestedTargetVersion !== release.build.version) {
    return { ...selected, reasonCode: "requested_target_mismatch" };
  }
  if (compareVersions(release.build.version, input.source.version) <= 0) {
    return { ...selected, reasonCode: "already_current" };
  }
  return { ...selected, eligibility: "eligible", reasonCode: "eligible" };
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
// alpha or changed artifact must not silently retarget an existing operation.
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
