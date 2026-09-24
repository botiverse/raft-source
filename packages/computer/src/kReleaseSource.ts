// kReleaseSource — Hands active releases adapted to K's ReleaseSource.
// (@botiverse/k-carrier) ReleaseSource boundary (#wg-k task #2).
//
// Hands owns active/published selection and the exact artifact identity.
// K remains the sole byte owner: it downloads, streams, verifies size/SHA-256,
// fsyncs and stages. Calling Hands prepareUpdate here would double-download
// the binary and create a second staging owner, so this adapter deliberately
// consumes checkUpdate only.
//
// Fail-closed notes:
//  - checkForUpdate() answers K's POLICY question. `null` strictly means
//    "already current" — a network/publishing failure THROWS instead, so
//    "could not look" can never read as "nothing to do".
//  - An older latest-pointer is NOT an update (K: automatic downgrade never
//    happens). Explicit downgrade stays available via fetchRelease(version)
//    → upgradeTo(version).
//  - `size` is required from the manifest. A target without an attested
//    size fails typed rather than borrowing Content-Length — the byte
//    server vouching for its own payload is not attestation. Current
//    production manifests already carry size; this guard prevents a future
//    producer regression from silently weakening the evidence contract.
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { getHandsDeviceId } from "@botiverse/hands-node";
import {
  HandsUpdateError,
  createHandsUpdater,
  type HandsUpdater,
  type UpdateCandidate,
  type UpdateChannel,
} from "@botiverse/hands-node/updater";
import type {
  Release,
  ReleaseContext,
  ReleaseSource,
} from "@botiverse/k-carrier";
import { ComputerServiceError } from "./services/errors.js";
import { readChannel, type Channel } from "./lib/channelState.js";
import { resolveRaftHome } from "./paths.js";
import { HANDS_API_ORIGIN, HANDS_COMPUTER_APP_SLUG } from "./releaseAuthority.js";

export { HANDS_API_ORIGIN, HANDS_COMPUTER_APP_SLUG } from "./releaseAuthority.js";

export type KReleaseContext = ReleaseContext;
export type KRelease = Release;
export type KReleaseSource = ReleaseSource;

// --- deps seam --------------------------------------------------------------

export interface KReleaseSourceDeps {
  fetchFn?: typeof fetch;
  /** Per-request deadline; the release authority answers in ms or is broken. */
  timeoutMs?: number;
  /** Legacy CDN is opt-in; Hands is the production default. */
  backend?: "hands" | "legacy-cdn";
  handsApiOrigin?: string;
  handsAppSlug?: string;
  channelProvider?: () => Channel | Promise<Channel>;
  createHandsUpdaterFn?: typeof createHandsUpdater;
  getHandsDeviceIdFn?: typeof getHandsDeviceId;
}

export const RELEASE_BACKEND_ENV = "RAFT_COMPUTER_RELEASE_BACKEND";

function resolveBackend(deps: KReleaseSourceDeps): "hands" | "legacy-cdn" {
  const configured = deps.backend ?? process.env[RELEASE_BACKEND_ENV] ?? "hands";
  if (configured === "hands" || configured === "legacy-cdn") return configured;
  throw new ComputerServiceError(
    "K_SOURCE_BACKEND_INVALID",
    `K_SOURCE_BACKEND_INVALID: ${RELEASE_BACKEND_ENV} must be "hands" or "legacy-cdn"`,
  );
}

function toHandsChannel(channel: Channel): UpdateChannel {
  return channel === "latest" ? "main" : channel;
}

function parsePlatformKey(platformKey: string): { platform: NodeJS.Platform; arch: string } {
  const match = /^(aix|android|darwin|freebsd|haiku|linux|openbsd|sunos|win32)-([A-Za-z0-9_]+)$/u.exec(platformKey);
  if (!match) {
    throw new ComputerServiceError(
      "K_SOURCE_TARGET_UNSUPPORTED",
      `K_SOURCE_TARGET_UNSUPPORTED: invalid platform target "${platformKey}"`,
    );
  }
  return { platform: match[1] as NodeJS.Platform, arch: match[2]! };
}

type CandidateIdentity = Readonly<{
  appId: string;
  appSlug: string;
  releaseId: string;
  releaseRevision: number;
  selectedChannel: string;
  channelId: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  artifactId: string;
  url: string;
  size: number;
  sha256: string;
  gzipUrl: string | null;
  gzipSize: number | null;
  gzipSha256: string | null;
}>;

function candidateIdentity(candidate: UpdateCandidate): CandidateIdentity {
  return {
    appId: candidate.appId,
    appSlug: candidate.appSlug,
    releaseId: candidate.releaseId,
    releaseRevision: candidate.releaseRevision,
    selectedChannel: candidate.selectedChannel,
    channelId: candidate.channelId,
    version: candidate.version,
    platform: candidate.target.platform,
    arch: candidate.target.arch,
    artifactId: candidate.artifact.artifactId,
    url: candidate.artifact.url,
    size: candidate.artifact.size,
    sha256: candidate.artifact.sha256,
    gzipUrl: candidate.artifact.gzip?.url ?? null,
    gzipSize: candidate.artifact.gzip?.size ?? null,
    gzipSha256: candidate.artifact.gzip?.sha256 ?? null,
  };
}

function sameIdentity(left: CandidateIdentity, right: CandidateIdentity): boolean {
  return (Object.keys(left) as Array<keyof CandidateIdentity>)
    .every((key) => left[key] === right[key]);
}

function mapHandsError(error: unknown): ComputerServiceError {
  if (!(error instanceof HandsUpdateError)) {
    return new ComputerServiceError(
      "K_SOURCE_UNAVAILABLE",
      "K_SOURCE_UNAVAILABLE: Hands update resolution failed",
      error,
    );
  }
  const target = error.code === "UPDATE_NO_COMPATIBLE_ARTIFACT"
    ? "K_SOURCE_TARGET_UNSUPPORTED"
    : error.code === "UPDATE_IDENTITY_DRIFT" || error.code === "UPDATE_IDENTITY_CONFLICT" || error.code === "UPDATE_RESPONSE_INVALID"
      ? "K_SOURCE_IDENTITY_DRIFT"
      : "K_SOURCE_UNAVAILABLE";
  return new ComputerServiceError(target, `${target}: Hands ${error.code}`, error);
}

/**
 * Strict `x.y.z` / `x.y.z-pre` compare (negative / 0 / positive). Computer
 * versions are plain semver; anything unparsable fails typed rather than
 * being silently ordered.
 */
export function compareComputerVersions(a: string, b: string): number {
  const parse = (v: string): { nums: bigint[]; pre: string[] | null } => {
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v);
    if (!m) {
      throw new ComputerServiceError(
        "K_SOURCE_VERSION_UNPARSABLE",
        `K_SOURCE_VERSION_UNPARSABLE: "${v}" is not x.y.z(-pre) semver`,
      );
    }
    const pre = m[4]?.split(".") ?? null;
    if (pre?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
      throw new ComputerServiceError(
        "K_SOURCE_VERSION_UNPARSABLE",
        `K_SOURCE_VERSION_UNPARSABLE: "${v}" has a zero-padded numeric pre-release identifier`,
      );
    }
    return { nums: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])], pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const left = pa.nums[i] ?? 0n;
    const right = pb.nums[i] ?? 0n;
    if (left !== right) return left < right ? -1 : 1;
  }
  // A pre-release sorts below its release. Within pre-release identifiers,
  // numeric compares numerically and below non-numeric; otherwise compare
  // lexically. Equal prefixes sort shorter first (SemVer 2.0.0 §11).
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const count = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < count; i += 1) {
    const left = pa.pre[i] ?? "";
    const right = pb.pre[i] ?? "";
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1;
}

async function fetchJson(
  url: string,
  deps: Required<Pick<KReleaseSourceDeps, "fetchFn" | "timeoutMs">>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setClockTimeout(() => controller.abort(), deps.timeoutMs);
  let res: Response;
  try {
    res = await deps.fetchFn(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new ComputerServiceError(
      "K_SOURCE_UNAVAILABLE",
      `K_SOURCE_UNAVAILABLE: could not read ${url} — a failed look is not "nothing to do"`,
      error,
    );
  } finally {
    clearClockTimeout(timeoutId);
  }
  if (!res.ok) {
    throw new ComputerServiceError(
      "K_SOURCE_UNAVAILABLE",
      `K_SOURCE_UNAVAILABLE: ${url} answered HTTP ${res.status}`,
    );
  }
  try {
    return await res.json();
  } catch (error) {
    throw new ComputerServiceError(
      "K_SOURCE_UNAVAILABLE",
      `K_SOURCE_UNAVAILABLE: ${url} did not return JSON`,
      error,
    );
  }
}

function createLegacyComputerReleaseSource(
  baseUrl: string,
  deps: KReleaseSourceDeps = {},
): KReleaseSource {
  const base = baseUrl.replace(/\/$/, "");
  const resolved: Required<Pick<KReleaseSourceDeps, "fetchFn" | "timeoutMs">> = {
    fetchFn: deps.fetchFn ?? fetch,
    timeoutMs: deps.timeoutMs ?? 10_000,
  };

  async function fetchRelease(version: string, ctx: KReleaseContext): Promise<KRelease> {
    // Named downgrade is explicit, but it is never an arbitrary URL segment.
    compareComputerVersions(version, version);
    const manifestUrl = `${base}/${version}/manifest.json`;
    const data = await fetchJson(manifestUrl, resolved);
    const targets =
      typeof data === "object" && data !== null
        ? (data as { targets?: unknown }).targets
        : undefined;
    const target =
      typeof targets === "object" && targets !== null
        ? (targets as Record<string, unknown>)[ctx.platformKey]
        : undefined;
    if (target === undefined) {
      throw new ComputerServiceError(
        "K_SOURCE_TARGET_UNSUPPORTED",
        `K_SOURCE_TARGET_UNSUPPORTED: ${manifestUrl} has no target for "${ctx.platformKey}"`,
      );
    }
    const file = (target as { file?: unknown }).file;
    const sha256 = (target as { sha256?: unknown }).sha256;
    const size = (target as { size?: unknown }).size;
    if (typeof file !== "string" || file.length === 0 || typeof sha256 !== "string" || sha256.length === 0) {
      throw new ComputerServiceError(
        "K_SOURCE_MANIFEST_INVALID",
        `K_SOURCE_MANIFEST_INVALID: target "${ctx.platformKey}" in ${manifestUrl} lacks file/sha256`,
      );
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
      throw new ComputerServiceError(
        "K_SOURCE_SIZE_UNATTESTED",
        `K_SOURCE_SIZE_UNATTESTED: target "${ctx.platformKey}" in ${manifestUrl} carries no attested size; ` +
          "refusing to substitute the byte server's own Content-Length",
      );
    }
    return { version, url: `${base}/${version}/${file}`, sha256, size };
  }

  return {
    async checkForUpdate(ctx) {
      const data = await fetchJson(`${base}/manifest.json`, resolved);
      const latest =
        typeof data === "object" && data !== null
          ? (data as { version?: unknown }).version
          : undefined;
      if (typeof latest !== "string" || latest.length === 0) {
        throw new ComputerServiceError(
          "K_SOURCE_UNAVAILABLE",
          `K_SOURCE_UNAVAILABLE: ${base}/manifest.json has no version pointer (still publishing?)`,
        );
      }
      if (latest === ctx.currentVersion) return null;
      // An older pointer is not an update: automatic downgrade never
      // happens. (Explicit downgrade = upgradeTo(version) via fetchRelease.)
      if (compareComputerVersions(latest, ctx.currentVersion) < 0) return null;
      return fetchRelease(latest, ctx);
    },
    fetchRelease,
  };
}

function releaseFromCandidate(candidate: UpdateCandidate, ctx: KReleaseContext, expectedAppSlug: string): KRelease {
  const identity = candidateIdentity(candidate);
  const gzip = candidate.artifact.gzip;
  if (gzip !== undefined && (!gzip || typeof gzip.url !== "string" || !gzip.url ||
      !Number.isSafeInteger(gzip.size) || gzip.size <= 0 || !/^[a-f0-9]{64}$/u.test(gzip.sha256))) {
    throw new ComputerServiceError("K_SOURCE_IDENTITY_DRIFT", "K_SOURCE_IDENTITY_DRIFT: Hands gzip identity is invalid");
  }
  if (candidate.appSlug !== expectedAppSlug
    || candidate.target.platform + "-" + candidate.target.arch !== ctx.platformKey
    || candidate.version.length === 0
    || identity.url.length === 0
    || identity.size <= 0
    || !/^[a-f0-9]{64}$/u.test(identity.sha256)) {
    throw new ComputerServiceError(
      "K_SOURCE_IDENTITY_DRIFT",
      `K_SOURCE_IDENTITY_DRIFT: Hands candidate does not match ${ctx.platformKey}`,
    );
  }
  return {
    version: candidate.version,
    url: identity.url,
    sha256: identity.sha256,
    size: identity.size,
    ...(gzip ? { gzip: { url: gzip.url, size: gzip.size, sha256: gzip.sha256 } } : {}),
  };
}

function createHandsComputerReleaseSource(
  deps: Required<Pick<KReleaseSourceDeps, "handsApiOrigin" | "handsAppSlug" | "channelProvider" | "createHandsUpdaterFn" | "getHandsDeviceIdFn">> & KReleaseSourceDeps,
): KReleaseSource {
  const updater: HandsUpdater = deps.createHandsUpdaterFn({
    appSlug: deps.handsAppSlug,
    apiOrigin: deps.handsApiOrigin,
    fetch: deps.fetchFn,
    timeoutMs: deps.timeoutMs,
  });
  const observed = new Map<string, CandidateIdentity>();
  // One ReleaseSource represents one Computer process. Resolve the Hands-owned
  // OS-user identity once and share the exact value across main/alpha/pinned.
  const deviceIdPromise = Promise.resolve()
    .then(() => deps.getHandsDeviceIdFn())
    .then((deviceId) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(deviceId)) {
        throw new ComputerServiceError(
          "K_SOURCE_DEVICE_ID_INVALID",
          "K_SOURCE_DEVICE_ID_INVALID: Hands returned a malformed DeveloperDeviceId",
        );
      }
      return deviceId;
    })
    .catch((error: unknown) => {
      if (error instanceof ComputerServiceError) throw error;
      throw new ComputerServiceError(
        "K_SOURCE_DEVICE_ID_INVALID",
        "K_SOURCE_DEVICE_ID_INVALID: Hands DeveloperDeviceId could not be resolved",
        error,
      );
    });

  async function resolve(version: string | undefined, ctx: KReleaseContext): Promise<KRelease | null> {
    const channel = version === undefined ? await deps.channelProvider() : `pinned:${version}` as Channel;
    const requestedChannel = toHandsChannel(channel);
    const target = parsePlatformKey(ctx.platformKey);
    const deviceId = await deviceIdPromise;
    let result;
    try {
      result = await updater.checkUpdate({
        currentVersion: version === undefined ? ctx.currentVersion : "0.0.0",
        channel: requestedChannel,
        target,
        deviceId,
      });
    } catch (error) {
      throw mapHandsError(error);
    }
    if (result.kind === "up_to_date") {
      if (version !== undefined) {
        throw new ComputerServiceError(
          "K_SOURCE_VERSION_UNAVAILABLE",
          `K_SOURCE_VERSION_UNAVAILABLE: Hands did not return pinned ${version}`,
        );
      }
      return null;
    }
    if (result.candidate.channel !== requestedChannel) {
      throw new ComputerServiceError(
        "K_SOURCE_IDENTITY_DRIFT",
        `K_SOURCE_IDENTITY_DRIFT: Hands candidate was resolved for a different release cohort`,
      );
    }
    if (version !== undefined && result.candidate.version !== version) {
      throw new ComputerServiceError(
        "K_SOURCE_IDENTITY_DRIFT",
        `K_SOURCE_IDENTITY_DRIFT: requested ${version}, got ${result.candidate.version}`,
      );
    }
    if (version === undefined
      && compareComputerVersions(result.candidate.version, ctx.currentVersion) <= 0) {
      return null;
    }
    const identity = candidateIdentity(result.candidate);
    const identityKey = `${identity.version}\0${identity.platform}\0${identity.arch}`;
    const prior = observed.get(identityKey);
    if (prior && !sameIdentity(prior, identity)) {
      throw new ComputerServiceError(
        "K_SOURCE_IDENTITY_DRIFT",
        `K_SOURCE_IDENTITY_DRIFT: Hands changed exact ${identity.version}/${ctx.platformKey} between resolve calls`,
      );
    }
    observed.set(identityKey, identity);
    return releaseFromCandidate(result.candidate, ctx, deps.handsAppSlug);
  }

  return {
    async checkForUpdate(ctx) {
      const resolved = await resolve(undefined, ctx);
      return resolved;
    },
    async fetchRelease(version, ctx) {
      const release = await resolve(version, ctx);
      if (release === null) {
        throw new ComputerServiceError(
          "K_SOURCE_VERSION_UNAVAILABLE",
          `K_SOURCE_VERSION_UNAVAILABLE: Hands returned no pinned ${version}`,
        );
      }
      return release;
    },
  };
}

export function createComputerReleaseSource(
  baseUrl: string,
  deps: KReleaseSourceDeps = {},
): KReleaseSource {
  if (resolveBackend(deps) === "legacy-cdn") {
    return createLegacyComputerReleaseSource(baseUrl, deps);
  }
  return createHandsComputerReleaseSource({
    ...deps,
    handsApiOrigin: deps.handsApiOrigin ?? HANDS_API_ORIGIN,
    handsAppSlug: deps.handsAppSlug ?? HANDS_COMPUTER_APP_SLUG,
    channelProvider: deps.channelProvider ?? (() => readChannel(resolveRaftHome())),
    createHandsUpdaterFn: deps.createHandsUpdaterFn ?? createHandsUpdater,
    getHandsDeviceIdFn: deps.getHandsDeviceIdFn ?? getHandsDeviceId,
  });
}

/**
 * Resolve the exact version an ordinary upgrade command may consent and send
 * to the service/K. This deliberately adapts the same ReleaseSource used by K
 * instead of maintaining a second CLI release authority.
 */
export async function resolveComputerUpgradeTargetVersion(
  channel: Channel,
  context: KReleaseContext,
  legacyBaseUrl: string,
  deps: KReleaseSourceDeps = {},
): Promise<string> {
  const source = createComputerReleaseSource(legacyBaseUrl, {
    ...deps,
    channelProvider: () => channel,
  });
  if (channel.startsWith("pinned:")) {
    return (await source.fetchRelease(channel.slice("pinned:".length), context)).version;
  }
  return (await source.checkForUpdate(context))?.version ?? context.currentVersion;
}
