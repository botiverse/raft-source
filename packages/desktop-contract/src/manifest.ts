// packages/desktop-contract/src/manifest.ts
// Compatibility manifest schema — fetched by desktop preflight.

export interface DesktopManifest {
  /** Manifest schema version (this type). */
  manifestVersion: number;

  /** Canonical frontend release identifier. */
  frontendReleaseId: string;

  /** Exact commit SHA of the deployed frontend. */
  frontendCommitSha: string;

  /** Compatibility requirements. If ANY are not met, desktop is blocked. */
  compatibility: {
    /** Semver range of compatible desktop app versions (e.g. ">=1.0.0 <2.0.0"). */
    appSemver: string;
    /** Minimum supported desktop protocol version. */
    protocolMin: number;
    /** Maximum supported desktop protocol version. */
    protocolMax: number;
    /** Required capability IDs that desktop must advertise. */
    requiredCapabilities: string[];
  };

  /**
   * Advisory recommendation only — does NOT override compatibility.
   * "current" = this manifest's frontend release is the recommended version.
   * "recommended" = a newer release is available but current is still compatible.
   * "none" = no recommendation.
   */
  updateRecommendation: "current" | "recommended" | "none";
}

/** Preflight evaluation states. */
export type CompatibilityState = "pending" | "ready" | "blocked";

/** Reasons a preflight can be blocked. */
export type BlockReason =
  | "desktop_too_old"
  | "desktop_too_new"
  | "manifest_invalid"
  | "manifest_unreachable"
  | "handshake_mismatch";

/** Result of preflight manifest evaluation. */
export interface PreflightResult {
  state: CompatibilityState;
  reason?: BlockReason;
  /** Present when updateRecommendation !== "none" and desktop is compatible. */
  updateRecommended?: boolean;
  /** Raw manifest for diagnostic (non-sensitive fields only). */
  manifestVersion?: number;
  frontendReleaseId?: string;
}

/** Validate a manifest against the schema. Returns null if valid, error string if invalid. */
export function validateManifestSchema(m: unknown): string | null {
  if (typeof m !== "object" || m === null) return "manifest must be an object";
  const manifest = m as Record<string, unknown>;

  const manifestFields = [
    "manifestVersion",
    "frontendReleaseId",
    "frontendCommitSha",
    "compatibility",
    "updateRecommendation",
  ];
  if (!hasExactFields(manifest, manifestFields)) return "manifest fields are not closed";
  if (manifest.manifestVersion !== 1) return "manifestVersion must be exactly 1";
  if (typeof manifest.frontendReleaseId !== "string" || manifest.frontendReleaseId.length === 0) {
    return "frontendReleaseId must be a non-empty string";
  }
  if (
    typeof manifest.frontendCommitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.frontendCommitSha)
  ) {
    return "frontendCommitSha must be a full lowercase 40-character SHA";
  }

  const compat = manifest.compatibility as Record<string, unknown> | undefined;
  if (!compat || typeof compat !== "object") return "compatibility must be an object";
  if (
    !hasExactFields(compat, [
      "appSemver",
      "protocolMin",
      "protocolMax",
      "requiredCapabilities",
    ])
  ) {
    return "compatibility fields are not closed";
  }
  if (
    typeof compat.appSemver !== "string" ||
    !isSupportedRustSemverRequirement(compat.appSemver)
  ) {
    return "compatibility.appSemver must be a supported Rust semver requirement";
  }
  if (!Number.isInteger(compat.protocolMin) || (compat.protocolMin as number) < 1) {
    return "compatibility.protocolMin must be a positive integer";
  }
  if (!Number.isInteger(compat.protocolMax) || (compat.protocolMax as number) < 1) {
    return "compatibility.protocolMax must be a positive integer";
  }
  if ((compat.protocolMin as number) > (compat.protocolMax as number)) {
    return "compatibility protocol range is inverted";
  }
  if (!Array.isArray(compat.requiredCapabilities)) return "compatibility.requiredCapabilities must be an array";
  if (
    compat.requiredCapabilities.some(
      (cap) => typeof cap !== "string" || cap.length === 0,
    )
  ) {
    return "compatibility.requiredCapabilities must contain non-empty strings";
  }
  if (new Set(compat.requiredCapabilities).size !== compat.requiredCapabilities.length) {
    return "compatibility.requiredCapabilities must be unique";
  }

  const rec = manifest.updateRecommendation;
  if (rec !== "current" && rec !== "recommended" && rec !== "none") {
    return "updateRecommendation must be 'current' | 'recommended' | 'none'";
  }

  return null;
}

/**
 * Producer-side subset of semver::VersionReq.
 *
 * Phase 1A emits only comma-separated comparators over complete stable
 * versions. Keeping this validator deliberately narrower than Rust guarantees
 * that every accepted producer value is parseable by the native runtime.
 */
function isSupportedRustSemverRequirement(value: string): boolean {
  const core = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
  const comparator = `(?:>=|<=|>|<|=|\\^|~)?${core}`;
  return new RegExp(`^${comparator}(?:, *${comparator})*$`).test(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
