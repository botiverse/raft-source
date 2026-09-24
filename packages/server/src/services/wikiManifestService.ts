import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  getStorage,
  isStorageNotFoundError,
  isStoragePreconditionFailedError,
  type StorageBackend,
} from "./storageService.js";

type VersionedStorageBackend = StorageBackend & Required<
  Pick<StorageBackend, "getVersioned" | "putConditional">
>;

export const WIKI_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_WIKI_MANIFEST_BYTES = 1024 * 1024;
export const MAX_WIKI_REVISION_BYTES = 2 * 1024 * 1024;

export type WikiSourceRef = {
  channelId: string;
  messageId: string;
  seq: number;
  slockRef: string;
};

export type WikiManifestRevision = {
  id: string;
  key: string;
  sha256: string;
  bytes: number;
};

export type WikiManifestArtifact = {
  id: string;
  artifactType: "index" | "log" | "page";
  slug: string;
  title: string;
  summary: string | null;
  currentUnderstanding: string | null;
  status: "current" | "tentative" | "contested" | "superseded" | "stale" | "archived";
  confidence: "low" | "medium" | "high";
  sourcePolicy: "cached_summary" | "prefer_live_source";
  sourceRefs: WikiSourceRef[];
  revision: WikiManifestRevision;
  updatedAt: string;
};

export type WikiLintReceipt = {
  receiptId: string;
  outcome: "repaired";
  repairedArtifactIds: string[];
  publishedAt: string;
};

/**
 * Coverage is two-dimensional: which channel, over which sequence ranges. A
 * single scalar cursor could only say "everything below N", which forces a run
 * that read one channel to claim every other channel was read to the same
 * point — the silent loss this model exists to prevent. Ranges are inclusive,
 * disjoint, and ascending; a channel absent from the map is uncovered.
 *
 * A channel's coverage stands for the channel *and all of its threads*, so
 * thread replies need no separate accounting.
 */
export type WikiCoverageRange = { from: number; to: number };
export type WikiCoverage = Record<string, WikiCoverageRange[]>;

/**
 * One channel's advance in a single publication. `observedCount` is the number
 * of messages the publisher saw in that range; the server counts the same range
 * itself and rejects a mismatch, which is what makes "I read it" refutable
 * rather than self-asserted.
 */
export type WikiCoverageAdvance = {
  channelId: string;
  from: number;
  to: number;
  observedCount: number;
};

export type WikiManifest = {
  schemaVersion: typeof WIKI_MANIFEST_SCHEMA_VERSION;
  serverId: string;
  wikiSpaceId: string;
  revision: number;
  coverage: WikiCoverage;
  publishedAt: string;
  publishedByAgentId: string;
  index: WikiManifestArtifact;
  log: WikiManifestArtifact;
  pages: WikiManifestArtifact[];
  lastIngest: {
    receiptId: string;
    added: WikiCoverageAdvance[];
    outcome: "published" | "no_changes";
    publishedAt: string;
  };
  lastLint: WikiLintReceipt | null;
};

export type WikiManifestSnapshot = {
  manifest: WikiManifest;
  etag: string;
};

export type WikiRevisionBody = {
  artifactId: string;
  revisionId: string;
  markdown: string;
};

export class WikiManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiManifestValidationError";
  }
}

export class WikiManifestConflictError extends Error {
  constructor(message = "Wiki manifest changed before it could be published") {
    super(message);
    this.name = "WikiManifestConflictError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WikiManifestValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!UUID_RE.test(parsed)) throw new WikiManifestValidationError(`${field} must be a UUID`);
  return parsed;
}

function requiredInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new WikiManifestValidationError(`${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function requiredDate(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new WikiManifestValidationError(`${field} must be an ISO timestamp`);
  }
  return parsed;
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new WikiManifestValidationError(`${field} is invalid`);
  }
  return value as T;
}

function parseSourceRef(value: unknown, field: string): WikiSourceRef {
  if (!isRecord(value)) throw new WikiManifestValidationError(`${field} must be an object`);
  return {
    channelId: requiredUuid(value.channelId, `${field}.channelId`),
    messageId: requiredUuid(value.messageId, `${field}.messageId`),
    seq: requiredInteger(value.seq, `${field}.seq`, 1),
    slockRef: requiredString(value.slockRef, `${field}.slockRef`),
  };
}

function parseRevision(value: unknown, field: string): WikiManifestRevision {
  if (!isRecord(value)) throw new WikiManifestValidationError(`${field} must be an object`);
  const sha256 = requiredString(value.sha256, `${field}.sha256`).toLowerCase();
  if (!SHA256_RE.test(sha256)) {
    throw new WikiManifestValidationError(`${field}.sha256 must be lowercase SHA-256 hex`);
  }
  return {
    id: requiredUuid(value.id, `${field}.id`),
    key: requiredString(value.key, `${field}.key`),
    sha256,
    bytes: requiredInteger(value.bytes, `${field}.bytes`, 1),
  };
}

function parseArtifact(
  value: unknown,
  field: string,
  expectedType: WikiManifestArtifact["artifactType"],
): WikiManifestArtifact {
  if (!isRecord(value)) throw new WikiManifestValidationError(`${field} must be an object`);
  const slug = requiredString(value.slug, `${field}.slug`);
  if (!SLUG_RE.test(slug)) throw new WikiManifestValidationError(`${field}.slug is invalid`);
  const artifactType = enumValue(
    value.artifactType,
    `${field}.artifactType`,
    ["index", "log", "page"] as const,
  );
  if (artifactType !== expectedType) {
    throw new WikiManifestValidationError(`${field}.artifactType must be ${expectedType}`);
  }
  if (!Array.isArray(value.sourceRefs)) {
    throw new WikiManifestValidationError(`${field}.sourceRefs must be an array`);
  }
  return {
    id: requiredUuid(value.id, `${field}.id`),
    artifactType,
    slug,
    title: requiredString(value.title, `${field}.title`),
    summary: value.summary == null ? null : requiredString(value.summary, `${field}.summary`),
    currentUnderstanding: value.currentUnderstanding == null
      ? null
      : requiredString(value.currentUnderstanding, `${field}.currentUnderstanding`),
    status: enumValue(
      value.status,
      `${field}.status`,
      ["current", "tentative", "contested", "superseded", "stale", "archived"] as const,
    ),
    confidence: enumValue(value.confidence, `${field}.confidence`, ["low", "medium", "high"] as const),
    sourcePolicy: enumValue(
      value.sourcePolicy,
      `${field}.sourcePolicy`,
      ["cached_summary", "prefer_live_source"] as const,
    ),
    sourceRefs: value.sourceRefs.map((sourceRef, index) => parseSourceRef(sourceRef, `${field}.sourceRefs[${index}]`)),
    revision: parseRevision(value.revision, `${field}.revision`),
    updatedAt: requiredDate(value.updatedAt, `${field}.updatedAt`),
  };
}


/**
 * Ranges are stored in a canonical form: ascending, non-overlapping, and not
 * merely adjacent. Canonical form is enforced rather than repaired so that two
 * manifests describing the same coverage are byte-identical, and so a
 * publisher cannot hide a gap inside a sloppy encoding.
 */
function parseWikiCoverageRanges(value: unknown, field: string): WikiCoverageRange[] {
  if (!Array.isArray(value)) {
    throw new WikiManifestValidationError(`${field} must be an array`);
  }
  const ranges = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new WikiManifestValidationError(`${field}[${index}] must be an object`);
    }
    const from = requiredInteger(entry.from, `${field}[${index}].from`);
    const to = requiredInteger(entry.to, `${field}[${index}].to`);
    if (from > to) {
      throw new WikiManifestValidationError(`${field}[${index}].from cannot exceed to`);
    }
    return { from, to };
  });
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i]!.from <= ranges[i - 1]!.to + 1) {
      throw new WikiManifestValidationError(
        `${field} must be ascending, disjoint, and merged; [${i - 1}] and [${i}] are not`,
      );
    }
  }
  return ranges;
}

function parseWikiCoverage(value: unknown): WikiCoverage {
  if (!isRecord(value)) {
    throw new WikiManifestValidationError("manifest.coverage must be an object");
  }
  const coverage: WikiCoverage = {};
  for (const [channelId, ranges] of Object.entries(value)) {
    if (!UUID_RE.test(channelId)) {
      throw new WikiManifestValidationError(`manifest.coverage key ${channelId} must be a UUID`);
    }
    const parsed = parseWikiCoverageRanges(ranges, `manifest.coverage[${channelId}]`);
    if (parsed.length === 0) {
      throw new WikiManifestValidationError(
        `manifest.coverage[${channelId}] must not be empty; omit the channel instead`,
      );
    }
    coverage[channelId] = parsed;
  }
  return coverage;
}

function parseWikiCoverageAdvances(value: unknown): WikiCoverageAdvance[] {
  if (!Array.isArray(value)) {
    throw new WikiManifestValidationError("manifest.lastIngest.added must be an array");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const field = `manifest.lastIngest.added[${index}]`;
    if (!isRecord(entry)) {
      throw new WikiManifestValidationError(`${field} must be an object`);
    }
    const channelId = requiredUuid(entry.channelId, `${field}.channelId`);
    if (seen.has(channelId)) {
      throw new WikiManifestValidationError(`${field}.channelId is listed twice`);
    }
    seen.add(channelId);
    const from = requiredInteger(entry.from, `${field}.from`);
    const to = requiredInteger(entry.to, `${field}.to`);
    if (from > to) {
      throw new WikiManifestValidationError(`${field}.from cannot exceed to`);
    }
    return {
      channelId,
      from,
      to,
      observedCount: requiredInteger(entry.observedCount, `${field}.observedCount`),
    };
  });
}

function coverageContains(
  ranges: WikiCoverageRange[] | undefined,
  span: { from: number; to: number },
): boolean {
  return (ranges ?? []).some((range) => range.from <= span.from && span.to <= range.to);
}

/** The parts of `span` that `before` does not already cover. */
function coverageGaps(
  before: WikiCoverageRange[],
  span: WikiCoverageRange,
): WikiCoverageRange[] {
  let gaps: WikiCoverageRange[] = [span];
  for (const covered of before) {
    const next: WikiCoverageRange[] = [];
    for (const gap of gaps) {
      if (covered.to < gap.from || covered.from > gap.to) { next.push(gap); continue; }
      if (covered.from > gap.from) next.push({ from: gap.from, to: covered.from - 1 });
      if (covered.to < gap.to) next.push({ from: covered.to + 1, to: gap.to });
    }
    gaps = next;
  }
  return gaps;
}

/**
 * True when this publication carries a current ingest receipt, rather than a
 * lint receipt with the previous ingest receipt preserved beside it.
 *
 * Only a current receipt describes work this publication actually did. A
 * carried receipt is history: re-auditing it against today's eligible source
 * blocks every later publication as soon as one of the channels it names is
 * archived.
 */
export function isIngestPublication(manifest: WikiManifest): boolean {
  return manifest.lastIngest.publishedAt === manifest.publishedAt;
}

/**
 * Every widening of coverage must be declared in `lastIngest.added`. Otherwise
 * a publication could quietly claim ranges it never reported, and the
 * observed-count check would have nothing to verify.
 *
 * The first publication is the same law with no prior coverage, so it shares
 * this implementation: expressing it twice is what let the two copies drift,
 * leaving the first publication — the cold start this model exists to fix —
 * accepting coverage far wider than it declared.
 */
function assertCoverageGrowthDeclared(manifest: WikiManifest, previousCoverage: WikiCoverage): void {
  const declared = new Map(
    manifest.lastIngest.added.map((advance) => [advance.channelId, advance] as const),
  );
  for (const [channelId, ranges] of Object.entries(manifest.coverage)) {
    const before = previousCoverage[channelId] ?? [];
    const advance = declared.get(channelId);
    for (const range of ranges) {
      // Check the newly added sequences, not the range as a whole: a range that
      // merely overlaps a declaration would otherwise let undeclared growth
      // through on either side of it.
      for (const gap of coverageGaps(before, range)) {
        if (!advance || !coverageContains([advance], gap)) {
          throw new WikiManifestValidationError(
            `manifest.coverage[${channelId}] grew over ${gap.from}-${gap.to} without a matching lastIngest.added entry`,
          );
        }
      }
    }
  }
}

/** True when every sequence covered before is still covered. Coverage only grows. */
function coverageOnlyGrew(previous: WikiCoverage, next: WikiCoverage): boolean {
  return Object.entries(previous).every(([channelId, ranges]) =>
    ranges.every((range) => coverageContains(next[channelId], range))
  );
}

export function coverageIncludesSeq(coverage: WikiCoverage, channelId: string, seq: number): boolean {
  return coverageContains(coverage[channelId], { from: seq, to: seq });
}

export function coverageHighWater(coverage: WikiCoverage, channelId: string): number {
  const ranges = coverage[channelId] ?? [];
  return ranges.length === 0 ? 0 : ranges[ranges.length - 1]!.to;
}

export function parseWikiManifest(value: unknown): WikiManifest {
  if (!isRecord(value)) throw new WikiManifestValidationError("manifest must be an object");
  if (value.schemaVersion !== WIKI_MANIFEST_SCHEMA_VERSION) {
    throw new WikiManifestValidationError(`manifest.schemaVersion must be ${WIKI_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.pages)) {
    throw new WikiManifestValidationError("manifest.pages must be an array");
  }
  if (!isRecord(value.lastIngest)) {
    throw new WikiManifestValidationError("manifest.lastIngest must be an object");
  }
  const manifest: WikiManifest = {
    schemaVersion: WIKI_MANIFEST_SCHEMA_VERSION,
    serverId: requiredUuid(value.serverId, "manifest.serverId"),
    wikiSpaceId: requiredUuid(value.wikiSpaceId, "manifest.wikiSpaceId"),
    revision: requiredInteger(value.revision, "manifest.revision", 1),
    coverage: parseWikiCoverage(value.coverage),
    publishedAt: requiredDate(value.publishedAt, "manifest.publishedAt"),
    publishedByAgentId: requiredUuid(value.publishedByAgentId, "manifest.publishedByAgentId"),
    index: parseArtifact(value.index, "manifest.index", "index"),
    log: parseArtifact(value.log, "manifest.log", "log"),
    pages: value.pages.map((page, index) => parseArtifact(page, `manifest.pages[${index}]`, "page")),
    lastIngest: {
      receiptId: requiredUuid(value.lastIngest.receiptId, "manifest.lastIngest.receiptId"),
      added: parseWikiCoverageAdvances(value.lastIngest.added),
      outcome: enumValue(
        value.lastIngest.outcome,
        "manifest.lastIngest.outcome",
        ["published", "no_changes"] as const,
      ),
      publishedAt: requiredDate(value.lastIngest.publishedAt, "manifest.lastIngest.publishedAt"),
    },
    lastLint: value.lastLint == null
      ? null
      : parseWikiLintReceipt(value.lastLint),
  };
  for (const advance of manifest.lastIngest.added) {
    if (!coverageContains(manifest.coverage[advance.channelId], advance)) {
      throw new WikiManifestValidationError(
        `manifest.lastIngest.added[${advance.channelId}] is not contained in manifest.coverage`,
      );
    }
  }
  const ingestPublishedNow = isIngestPublication(manifest);
  const lintPublishedNow = manifest.publishedAt === manifest.lastLint?.publishedAt;
  if (ingestPublishedNow === lintPublishedNow) {
    throw new WikiManifestValidationError(
      "manifest publication must identify exactly one current ingest or lint receipt",
    );
  }
  if (manifest.pages.length === 0) {
    throw new WikiManifestValidationError("manifest must contain at least one Wiki page");
  }
  if (!manifest.pages.some((page) => page.status !== "archived")) {
    throw new WikiManifestValidationError(
      "manifest must contain at least one non-archived Wiki page",
    );
  }
  const artifacts = listManifestArtifacts(manifest);
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const revisionIds = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) throw new WikiManifestValidationError(`duplicate artifact id ${artifact.id}`);
    if (slugs.has(artifact.slug)) throw new WikiManifestValidationError(`duplicate artifact slug ${artifact.slug}`);
    if (revisionIds.has(artifact.revision.id)) {
      throw new WikiManifestValidationError(`duplicate revision id ${artifact.revision.id}`);
    }
    ids.add(artifact.id);
    slugs.add(artifact.slug);
    revisionIds.add(artifact.revision.id);
    const expectedKey = wikiRevisionKey(
      manifest.serverId,
      artifact.id,
      artifact.revision.id,
    );
    if (artifact.revision.key !== expectedKey) {
      throw new WikiManifestValidationError(`revision key for ${artifact.slug} is not canonical`);
    }
    if (Date.parse(artifact.updatedAt) > Date.parse(manifest.publishedAt)) {
      throw new WikiManifestValidationError(
        `artifact updatedAt for ${artifact.slug} cannot exceed manifest.publishedAt`,
      );
    }
  }
  return manifest;
}

function parseWikiLintReceipt(value: unknown): WikiLintReceipt {
  if (!isRecord(value)) {
    throw new WikiManifestValidationError("manifest.lastLint must be an object");
  }
  if (!Array.isArray(value.repairedArtifactIds) || value.repairedArtifactIds.length === 0) {
    throw new WikiManifestValidationError(
      "manifest.lastLint.repairedArtifactIds must be a non-empty array",
    );
  }
  const repairedArtifactIds = value.repairedArtifactIds.map((artifactId, index) =>
    requiredUuid(artifactId, `manifest.lastLint.repairedArtifactIds[${index}]`)
  );
  if (new Set(repairedArtifactIds).size !== repairedArtifactIds.length) {
    throw new WikiManifestValidationError(
      "manifest.lastLint.repairedArtifactIds must not contain duplicates",
    );
  }
  return {
    receiptId: requiredUuid(value.receiptId, "manifest.lastLint.receiptId"),
    outcome: enumValue(value.outcome, "manifest.lastLint.outcome", ["repaired"] as const),
    repairedArtifactIds,
    publishedAt: requiredDate(value.publishedAt, "manifest.lastLint.publishedAt"),
  };
}

export function wikiManifestKey(serverId: string): string {
  return `servers/${serverId}/wiki/manifest.json`;
}

export function wikiRevisionKey(serverId: string, artifactId: string, revisionId: string): string {
  return `servers/${serverId}/wiki/revisions/${artifactId}/${revisionId}.md`;
}

export function listManifestArtifacts(manifest: WikiManifest): WikiManifestArtifact[] {
  return [manifest.index, manifest.log, ...manifest.pages];
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function storageOrThrow(storage?: StorageBackend | null): VersionedStorageBackend {
  const resolved = storage ?? getStorage();
  if (!resolved) throw new Error("Wiki storage is not configured");
  if (!resolved.getVersioned || !resolved.putConditional) {
    throw new Error("Wiki storage does not support conditional object versions");
  }
  return resolved as VersionedStorageBackend;
}

export type WikiManifestResetReceipt = {
  key: string;
  existed: boolean;
  previousEtag: string | null;
};

/**
 * Remove only the current server's canonical Wiki entry point.
 *
 * Reset is also the recovery path for malformed and legacy manifests, so
 * this operation must never download or parse the object body. Immutable
 * revisions live under a different prefix and are deliberately untouched.
 */
export async function resetWikiManifest(
  serverId: string,
  storage?: StorageBackend | null,
): Promise<WikiManifestResetReceipt> {
  const backend = storageOrThrow(storage);
  const key = wikiManifestKey(serverId);
  const previous = backend.head ? await backend.head(key) : null;
  await backend.delete(key);
  return {
    key,
    existed: previous !== null,
    previousEtag: previous?.etag ?? null,
  };
}

export async function readWikiManifest(
  serverId: string,
  storage?: StorageBackend | null,
): Promise<WikiManifestSnapshot | null> {
  const backend = storageOrThrow(storage);
  try {
    const object = await backend.getVersioned(wikiManifestKey(serverId));
    const data = await streamToBuffer(object.body);
    if (data.byteLength > MAX_WIKI_MANIFEST_BYTES) {
      throw new WikiManifestValidationError("Wiki manifest is too large");
    }
    const parsed = parseWikiManifest(JSON.parse(data.toString("utf8")) as unknown);
    if (parsed.serverId !== serverId) {
      throw new WikiManifestValidationError("Wiki manifest serverId does not match its storage prefix");
    }
    return { manifest: parsed, etag: object.etag };
  } catch (error) {
    if (isStorageNotFoundError(error)) return null;
    if (error instanceof SyntaxError) {
      throw new WikiManifestValidationError("Wiki manifest is not valid JSON");
    }
    throw error;
  }
}

async function writeImmutableRevision(
  backend: VersionedStorageBackend,
  key: string,
  data: Buffer,
): Promise<void> {
  try {
    await backend.putConditional(key, data, "text/markdown; charset=utf-8", { ifNoneMatch: "*" });
  } catch (error) {
    if (!isStoragePreconditionFailedError(error)) throw error;
    const existing = await backend.getVersioned(key);
    const existingData = await streamToBuffer(existing.body);
    if (existingData.byteLength !== data.byteLength || sha256(existingData) !== sha256(data)) {
      throw new WikiManifestConflictError(`Immutable Wiki revision already exists with different content: ${key}`);
    }
  }
}

export async function publishWikiManifest(input: {
  serverId: string;
  wikiSpaceId: string;
  agentId: string;
  expectedEtag: string | null;
  manifest: unknown;
  revisionBodies: WikiRevisionBody[];
  storage?: StorageBackend | null;
}): Promise<WikiManifestSnapshot> {
  const backend = storageOrThrow(input.storage);
  const manifest = parseWikiManifest(input.manifest);
  if (manifest.serverId !== input.serverId) {
    throw new WikiManifestValidationError("manifest.serverId does not match the authenticated server");
  }
  if (manifest.wikiSpaceId !== input.wikiSpaceId) {
    throw new WikiManifestValidationError("manifest.wikiSpaceId does not match the configured Wiki space");
  }
  if (manifest.publishedByAgentId !== input.agentId) {
    throw new WikiManifestValidationError("manifest.publishedByAgentId does not match the authenticated Wiki Agent");
  }

  const previous = await readWikiManifest(input.serverId, backend);
  if (
    (previous && previous.etag !== input.expectedEtag)
    || (!previous && input.expectedEtag !== null)
  ) {
    throw new WikiManifestConflictError();
  }
  if (previous) {
    if (manifest.revision !== previous.manifest.revision + 1) {
      throw new WikiManifestValidationError("manifest.revision must advance by exactly one");
    }
    if (Date.parse(manifest.publishedAt) <= Date.parse(previous.manifest.publishedAt)) {
      throw new WikiManifestValidationError("manifest.publishedAt must move forwards");
    }
    if (isIngestPublication(manifest)) {
      if (manifest.lastIngest.receiptId === previous.manifest.lastIngest.receiptId) {
        throw new WikiManifestValidationError("ingest publication must use a new receipt id");
      }
      if (!coverageOnlyGrew(previous.manifest.coverage, manifest.coverage)) {
        throw new WikiManifestValidationError("manifest coverage cannot shrink");
      }
      assertCoverageGrowthDeclared(manifest, previous.manifest.coverage);
      if (JSON.stringify(manifest.lastLint) !== JSON.stringify(previous.manifest.lastLint)) {
        throw new WikiManifestValidationError(
          "ingest publication must preserve the previous lint receipt",
        );
      }
    } else {
      if (
        !manifest.lastLint
        || manifest.lastLint.receiptId === previous.manifest.lastLint?.receiptId
      ) {
        throw new WikiManifestValidationError("lint publication must use a new receipt id");
      }
      if (JSON.stringify(manifest.coverage) !== JSON.stringify(previous.manifest.coverage)) {
        throw new WikiManifestValidationError("lint publication cannot change source coverage");
      }
      if (JSON.stringify(manifest.lastIngest) !== JSON.stringify(previous.manifest.lastIngest)) {
        throw new WikiManifestValidationError(
          "lint publication must preserve the previous ingest receipt",
        );
      }
    }
  } else {
    if (manifest.revision !== 1) {
      throw new WikiManifestValidationError("the first manifest revision must be 1");
    }
    // A first publication starts from no coverage at all, so every range it
    // claims must be declared. The server deliberately does not constrain which
    // ranges those are: coverage records intervals, so any order is
    // representable and a gap is visible rather than hidden. Reading order is
    // an Agent-side discipline instead — the ingest skill requires starting at
    // a channel's beginning, because nothing here drives a later backfill.
    assertCoverageGrowthDeclared(manifest, {});
    if (manifest.lastIngest.outcome === "no_changes") {
      throw new WikiManifestValidationError("the first manifest publication cannot be no_changes");
    }
    if (manifest.lastLint !== null) {
      throw new WikiManifestValidationError("the first manifest publication cannot be a lint repair");
    }
  }

  const artifactsByRevision = new Map(
    listManifestArtifacts(manifest).map((artifact) => [artifact.revision.id, artifact]),
  );
  const previousArtifacts = previous ? listManifestArtifacts(previous.manifest) : [];
  const previousArtifactsByRevision = new Map(
    previousArtifacts.map((artifact) => [artifact.revision.id, artifact]),
  );
  const previousArtifactsById = new Map(previousArtifacts.map((artifact) => [artifact.id, artifact]));
  const previousArtifactsBySlug = new Map(previousArtifacts.map((artifact) => [artifact.slug, artifact]));
  const currentArtifacts = listManifestArtifacts(manifest);
  const currentArtifactsById = new Map(currentArtifacts.map((artifact) => [artifact.id, artifact]));
  if (previous) {
    for (const previousPage of previous.manifest.pages) {
      if (!currentArtifactsById.has(previousPage.id)) {
        throw new WikiManifestValidationError(
          `Wiki page ${previousPage.slug} cannot be removed; publish an archived redirect to preserve topic identity`,
        );
      }
    }
  }
  for (const artifact of currentArtifacts) {
    const previousById = previousArtifactsById.get(artifact.id);
    if (
      previousById
      && (
        artifact.slug !== previousById.slug
        || artifact.artifactType !== previousById.artifactType
      )
    ) {
      throw new WikiManifestValidationError(`artifact identity for ${artifact.id} cannot change`);
    }
    const previousBySlug = previousArtifactsBySlug.get(artifact.slug);
    if (previousBySlug && artifact.id !== previousBySlug.id) {
      throw new WikiManifestValidationError(`artifact id for ${artifact.slug} cannot change`);
    }
    const previousByRevision = previousArtifactsByRevision.get(artifact.revision.id);
    if (
      previousByRevision
      && (
        artifact.id !== previousByRevision.id
        || artifact.revision.key !== previousByRevision.revision.key
        || artifact.revision.sha256 !== previousByRevision.revision.sha256
        || artifact.revision.bytes !== previousByRevision.revision.bytes
      )
    ) {
      throw new WikiManifestValidationError(
        `published revision ${artifact.revision.id} cannot be reused with different identity or receipt`,
      );
    }
    if (
      previousById
      && artifact.revision.id === previousById.revision.id
      && JSON.stringify(artifact) !== JSON.stringify(previousById)
    ) {
      throw new WikiManifestValidationError(
        `unchanged revision for ${artifact.slug} must reuse the complete artifact entry`,
      );
    }
    if (
      previousById
      && artifact.revision.id !== previousById.revision.id
      && Date.parse(artifact.updatedAt) <= Date.parse(previousById.updatedAt)
    ) {
      throw new WikiManifestValidationError(
        `artifact updatedAt for ${artifact.slug} must move forwards with a new revision`,
      );
    }
  }
  if (
    previous
    && manifest.lastIngest.outcome === "no_changes"
    && manifest.lastIngest.publishedAt === manifest.publishedAt
    && JSON.stringify(listManifestArtifacts(manifest)) !== JSON.stringify(previousArtifacts)
  ) {
    throw new WikiManifestValidationError("no_changes publication must reuse the current document inventory");
  }
  if (previous && manifest.lastLint?.publishedAt === manifest.publishedAt) {
    const repairedArtifactIds = currentArtifacts
      .filter((artifact) => {
        const previousArtifact = previousArtifactsById.get(artifact.id);
        return !previousArtifact || previousArtifact.revision.id !== artifact.revision.id;
      })
      .map((artifact) => artifact.id)
      .sort();
    const claimedArtifactIds = [...manifest.lastLint.repairedArtifactIds].sort();
    if (JSON.stringify(repairedArtifactIds) !== JSON.stringify(claimedArtifactIds)) {
      throw new WikiManifestValidationError(
        "lint receipt must name exactly the artifacts changed by the repair",
      );
    }
  }

  const bodiesByRevision = new Map<string, WikiRevisionBody>();
  for (const body of input.revisionBodies) {
    if (bodiesByRevision.has(body.revisionId)) {
      throw new WikiManifestValidationError(`duplicate revision body ${body.revisionId}`);
    }
    const artifact = artifactsByRevision.get(body.revisionId);
    if (!artifact || artifact.id !== body.artifactId) {
      throw new WikiManifestValidationError(`revision body ${body.revisionId} is not referenced by the manifest`);
    }
    if (previousArtifactsByRevision.has(body.revisionId)) {
      throw new WikiManifestValidationError(`revision body ${body.revisionId} was already published`);
    }
    bodiesByRevision.set(body.revisionId, body);
  }

  const revisionWrites: Array<{ key: string; data: Buffer }> = [];
  for (const artifact of listManifestArtifacts(manifest)) {
    if (previousArtifactsByRevision.has(artifact.revision.id)) continue;
    const body = bodiesByRevision.get(artifact.revision.id);
    if (!body) {
      throw new WikiManifestValidationError(`missing revision body for ${artifact.slug}`);
    }
    const data = Buffer.from(body.markdown, "utf8");
    if (data.byteLength === 0 || data.byteLength > MAX_WIKI_REVISION_BYTES) {
      throw new WikiManifestValidationError(`revision body for ${artifact.slug} has an invalid size`);
    }
    if (artifact.revision.bytes !== data.byteLength || artifact.revision.sha256 !== sha256(data)) {
      throw new WikiManifestValidationError(`revision receipt for ${artifact.slug} does not match its bytes`);
    }
    revisionWrites.push({ key: artifact.revision.key, data });
  }

  const encodedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (encodedManifest.byteLength > MAX_WIKI_MANIFEST_BYTES) {
    throw new WikiManifestValidationError("Wiki manifest is too large");
  }
  // Finish every deterministic validation before the first storage write. A
  // bad body or oversized manifest is then a safe rejected attempt, not a
  // partial set of unreachable immutable objects that the Agent must reason
  // about on retry.
  for (const write of revisionWrites) {
    await writeImmutableRevision(backend, write.key, write.data);
  }
  try {
    const receipt = await backend.putConditional(
      wikiManifestKey(input.serverId),
      encodedManifest,
      "application/json; charset=utf-8",
      input.expectedEtag === null
        ? { ifNoneMatch: "*" }
        : { ifMatch: input.expectedEtag },
    );
    if (!receipt.etag) {
      const written = await backend.getVersioned(wikiManifestKey(input.serverId));
      return { manifest, etag: written.etag };
    }
    return { manifest, etag: receipt.etag };
  } catch (error) {
    if (isStoragePreconditionFailedError(error)) throw new WikiManifestConflictError();
    throw error;
  }
}

export async function readWikiArtifactMarkdown(
  manifest: WikiManifest,
  artifactId: string,
  storage?: StorageBackend | null,
): Promise<{ artifact: WikiManifestArtifact; markdown: string }> {
  const artifact = listManifestArtifacts(manifest).find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new WikiManifestValidationError("Wiki artifact is not in the current manifest");
  const data = await streamToBuffer(await storageOrThrow(storage).get(artifact.revision.key));
  if (data.byteLength !== artifact.revision.bytes || sha256(data) !== artifact.revision.sha256) {
    throw new WikiManifestValidationError("Wiki artifact bytes do not match the manifest receipt");
  }
  return { artifact, markdown: data.toString("utf8") };
}
