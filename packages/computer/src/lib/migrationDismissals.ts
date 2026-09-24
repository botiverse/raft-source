import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CURRENT_SCHEMA_VERSION, formatUpgradeLogTimestamp, migrationDismissalsPath } from "../paths.js";
import { canonicalizeServerUrl } from "../serverUrl.js";
import { normalizeServerSlug } from "../serverState.js";

export interface MigrationDismissalEvidence {
  effectiveFingerprint?: string | null;
  ownerFingerprint?: string | null;
  dirFingerprint?: string | null;
  localPath?: string;
}

export interface MigrationDismissalRecord {
  kind: "zero-match-fresh-dismissal";
  schemaVersion?: number;
  serverSlug: string;
  serverUrl: string;
  evidenceSetKey: string;
  evidenceKeys: string[];
  dismissedAt: string;
  source: "setup --fresh";
}

export interface MigrationDismissalsState {
  schemaVersion: number;
  dismissals: MigrationDismissalRecord[];
}

export interface ZeroMatchDismissalIdentity {
  serverSlug: string;
  serverUrl: string;
  evidenceSetKey: string;
  evidenceKeys: string[];
}

const MAX_DISMISSAL_RECORDS = 200;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalServerUrl(raw: string): string {
  try {
    return canonicalizeServerUrl(raw);
  } catch {
    return raw.trim().replace(/\/+$/, "");
  }
}

export function evidenceKey(evidence: MigrationDismissalEvidence): string | null {
  const fp = evidence.effectiveFingerprint ?? evidence.ownerFingerprint ?? evidence.dirFingerprint ?? null;
  if (typeof fp === "string" && fp.length > 0) return `fp:${fp}`;
  if (typeof evidence.localPath === "string" && evidence.localPath.length > 0) {
    return `path-sha256:${sha256(evidence.localPath)}`;
  }
  return null;
}

export function evidenceKeys(evidence: MigrationDismissalEvidence[]): string[] {
  return [...new Set(evidence.map(evidenceKey).filter((key): key is string => Boolean(key)))].sort();
}

export function evidenceSetKey(keys: string[]): string {
  return `sha256:${sha256(keys.join("\n"))}`;
}

export function zeroMatchDismissalIdentity(
  serverSlug: string,
  serverUrl: string,
  evidence: MigrationDismissalEvidence[],
): ZeroMatchDismissalIdentity | null {
  const keys = evidenceKeys(evidence);
  if (keys.length === 0) return null;
  return {
    serverSlug: normalizeServerSlug(serverSlug),
    serverUrl: canonicalServerUrl(serverUrl),
    evidenceSetKey: evidenceSetKey(keys),
    evidenceKeys: keys,
  };
}

function parseState(raw: string): MigrationDismissalsState {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawDismissals = Array.isArray(parsed.dismissals) ? parsed.dismissals : [];
    const dismissals: MigrationDismissalRecord[] = [];
    for (const item of rawDismissals) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (
        record.kind !== "zero-match-fresh-dismissal" ||
        typeof record.serverSlug !== "string" ||
        typeof record.serverUrl !== "string" ||
        typeof record.evidenceSetKey !== "string" ||
        !Array.isArray(record.evidenceKeys) ||
        typeof record.dismissedAt !== "string" ||
        record.source !== "setup --fresh"
      ) {
        continue;
      }
      const keys = record.evidenceKeys.filter((key): key is string => typeof key === "string" && key.length > 0).sort();
      if (keys.length === 0) continue;
      dismissals.push({
        kind: "zero-match-fresh-dismissal",
        schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : CURRENT_SCHEMA_VERSION,
        serverSlug: normalizeServerSlug(record.serverSlug),
        serverUrl: canonicalServerUrl(record.serverUrl),
        evidenceSetKey: record.evidenceSetKey,
        evidenceKeys: keys,
        dismissedAt: record.dismissedAt,
        source: "setup --fresh",
      });
    }
    return { schemaVersion: CURRENT_SCHEMA_VERSION, dismissals };
  } catch {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, dismissals: [] };
  }
}

export async function readMigrationDismissals(slockHome: string): Promise<MigrationDismissalsState> {
  try {
    return parseState(await readFile(migrationDismissalsPath(slockHome), "utf8"));
  } catch {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, dismissals: [] };
  }
}

export async function isZeroMatchDismissed(
  slockHome: string,
  identity: ZeroMatchDismissalIdentity | null,
): Promise<boolean> {
  if (!identity) return false;
  const dismissed = await dismissedEvidenceKeys(slockHome, identity.serverSlug, identity.serverUrl);
  return identity.evidenceKeys.every((key) => dismissed.has(key));
}

export async function dismissedEvidenceKeys(
  slockHome: string,
  serverSlug: string,
  serverUrl: string,
): Promise<Set<string>> {
  const state = await readMigrationDismissals(slockHome);
  const canonicalSlug = normalizeServerSlug(serverSlug);
  const canonicalUrl = canonicalServerUrl(serverUrl);
  const out = new Set<string>();
  for (const record of state.dismissals) {
    if (
      record.kind !== "zero-match-fresh-dismissal" ||
      record.serverSlug !== canonicalSlug ||
      record.serverUrl !== canonicalUrl
    ) {
      continue;
    }
    for (const key of record.evidenceKeys) out.add(key);
  }
  return out;
}

export async function recordZeroMatchDismissal(
  slockHome: string,
  identity: ZeroMatchDismissalIdentity | null,
  dismissedAt = formatUpgradeLogTimestamp(),
): Promise<void> {
  if (!identity) return;
  const file = migrationDismissalsPath(slockHome);
  const state = await readMigrationDismissals(slockHome);
  const nextRecord: MigrationDismissalRecord = {
    kind: "zero-match-fresh-dismissal",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    serverSlug: identity.serverSlug,
    serverUrl: identity.serverUrl,
    evidenceSetKey: identity.evidenceSetKey,
    evidenceKeys: identity.evidenceKeys,
    dismissedAt,
    source: "setup --fresh",
  };
  const remaining = state.dismissals.filter((record) =>
    !(
      record.kind === nextRecord.kind &&
      record.serverSlug === nextRecord.serverSlug &&
      record.serverUrl === nextRecord.serverUrl &&
      record.evidenceSetKey === nextRecord.evidenceSetKey
    )
  );
  const dismissals = [...remaining, nextRecord].slice(-MAX_DISMISSAL_RECORDS);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, dismissals }, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}
