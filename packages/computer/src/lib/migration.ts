// `@botiverse/raft-computer/lib` §X migration detection — RFC v9.9 §X.2.
//
// Lib-pure detection entry point for the §X migration capability. The
// CLI wrapper (`setup.ts`) calls this after successful login, before
// fresh attach, to decide whether to surface a setup picker or proceed
// to fresh attach. D-stage IPC handlers can delegate via mechanical
// surface (no env reads, no `info()`/`fail()`, no `process.exit`).
//
// Detection model — evidence collection followed by pure adjudication:
//   1. Local: scan `<installRoot>/machines/machine-*` and collect one
//      evidence record per local candidate. A parseable owner.json with a
//      16-hex-char `apiKeyFingerprint` contributes owner evidence. If the
//      owner file is absent, or it is valid JSON but lacks a usable
//      fingerprint, detection may fall back to a 16-hex fingerprint encoded
//      in the `machine-<fp>` directory name. Present-but-unreadable or
//      malformed owner files are excluded instead of silently overridden.
//   2. Server: GET `/api/computer/legacy-machines?serverSlug=<slug>`
//      (auth = JWT on the supplied client). Server filters to
//      (userId, serverId, apiKeyFingerprint NOT NULL) and emits one row
//      per mutually-known legacy daemon — see
//      `services/legacyMachineService.ts` and
//      `routes/computerLegacyMachines.ts` server-side. Already-migrated
//      rows are kept so setup can resume an adoption that committed on
//      the server before local Computer state was written.
//   3. Adjudication: classify local evidence against the roster into one
//      of `matched`, `zero_match`, `no_local_evidence`, or
//      `roster_unavailable`. Matched results pair each surviving local
//      fingerprint with the server's display-only `daemonId` /
//      `machineName` / `hostname` / `lastSeenAt`; excluded rows preserve
//      structured reasons for setup diagnostics.
//
// Cody msg=ec68c27f redline (apiKeyFingerprint as sensitive identity):
//   - Never logged.
//   - Only flowed through this scoped authenticated request path.
//   - The server SELECT-whitelists; the client never reads any
//     credential field (`apiKeyHash` / `apiKeyPrefix` / raw key).
//
// Trust-gate (roster-selected setup adoption):
//   - The intersection proves the server has a roster row for the same
//     fingerprint that appears in this host's owner.json under this
//     logged-in user + server context. The server still enforces the
//     authority boundary during adoption: session_user_id must own that
//     machine row; fingerprint is only the selector/disambiguator.
//
// `roster_unavailable` outcome (best-effort detection):
//   - When the roster fetch fails (network / 5xx / surface gate off /
//     auth lapse), detection returns `{ kind: "roster_unavailable" }`.
//     The setup driver falls through to fresh attach in that case —
//     a transient server problem must NOT block fresh setup.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LegacyMachineRosterEntry, LegacyMachineRosterResult } from "../apiClient.js";
import { listServerAttachments } from "../serverState.js";
import { canonicalizeServerUrl } from "../serverUrl.js";
import type {
  ExcludedCandidate,
  ExclusionReason,
  LegacyMachineCandidate,
  LocalCandidateEvidence,
  MigrationDetection,
  OwnerFileState,
} from "./types.js";

const MACHINE_DIR_PREFIX = "machine-";
const FINGERPRINT_HEX_RE = /^[0-9a-f]{16}$/;

interface RawOwner {
  apiKeyFingerprint?: unknown;
  serverUrl?: unknown;
  schemaVersion?: unknown;
  kind?: unknown;
  serverId?: unknown;
  serverMachineId?: unknown;
}

/**
 * Roster fetcher contract — `LegacyMachinesClient.list(serverSlug)`
 * satisfies this structurally. Defining it as an interface here lets
 * tests stub the network call without instantiating undici.
 */
export interface LegacyMachineRosterClient {
  targetServerUrl?: string;
  list(serverSlug: string): Promise<LegacyMachineRosterResult>;
}

export type LegacyMachineRosterClientFactory = () => LegacyMachineRosterClient;

export interface MigrationDetectionEvidence {
  localCandidates: LocalCandidateEvidence[];
  roster:
    | { status: "success"; entries: LegacyMachineRosterEntry[] }
    | { status: "unavailable"; reason: string };
  targetServerUrl?: string;
}

function dirFingerprint(dirName: string): string | null {
  if (!dirName.startsWith(MACHINE_DIR_PREFIX)) return null;
  const fromDir = dirName.slice(MACHINE_DIR_PREFIX.length);
  return FINGERPRINT_HEX_RE.test(fromDir) ? fromDir : null;
}

function canonicalUrlOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return canonicalizeServerUrl(raw);
  } catch {
    return raw.trim();
  }
}

function serverUrlMismatch(ownerServerUrl: string | null, targetServerUrl: string | undefined): boolean {
  if (!ownerServerUrl || !targetServerUrl) return false;
  return canonicalUrlOrNull(ownerServerUrl) !== canonicalUrlOrNull(targetServerUrl);
}

function isManagedV2Owner(owner: RawOwner, ownerFingerprint: string | null): boolean {
  return owner.schemaVersion === 2
    && owner.kind === "managed_computer_runner"
    && ownerFingerprint !== null
    && typeof owner.serverId === "string"
    && owner.serverId.trim().length > 0
    && typeof owner.serverMachineId === "string"
    && owner.serverMachineId.trim().length > 0;
}

function attachmentFingerprints(
  attachments: Awaited<ReturnType<typeof listServerAttachments>>,
): Set<string> {
  const fingerprints = new Set<string>();
  for (const attachment of attachments) {
    fingerprints.add(createHash("sha256").update(attachment.apiKey).digest("hex").slice(0, 16));
    if (attachment.legacyApiKeyFingerprint
      && FINGERPRINT_HEX_RE.test(attachment.legacyApiKeyFingerprint)) {
      fingerprints.add(attachment.legacyApiKeyFingerprint);
    }
  }
  return fingerprints;
}

async function collectLocalCandidateEvidence(installRoot: string): Promise<LocalCandidateEvidence[]> {
  const machinesDir = join(installRoot, "machines");
  let entries: string[];
  try {
    entries = await readdir(machinesDir);
  } catch {
    return [];
  }

  const managedV1Fingerprints = attachmentFingerprints(await listServerAttachments(installRoot));
  const candidates: LocalCandidateEvidence[] = [];
  for (const name of entries) {
    if (!name.startsWith(MACHINE_DIR_PREFIX)) continue;
    const machineDir = join(machinesDir, name);
    const fallbackFingerprint = dirFingerprint(name);
    const ownerPath = join(machinesDir, name, "daemon.lock", "owner.json");
    let raw: string;
    try {
      raw = await readFile(ownerPath, "utf8");
    } catch (err) {
      const ownerState: OwnerFileState = (err as NodeJS.ErrnoException)?.code === "ENOENT"
        ? "absent"
        : "unreadable";
      candidates.push({
        dirName: name,
        dirFingerprint: fallbackFingerprint,
        ownerState,
        ownerFingerprint: null,
        ownerServerUrl: null,
        effectiveFingerprint: ownerState === "absent" ? fallbackFingerprint : null,
        localPath: ownerState === "absent" ? machineDir : ownerPath,
      });
      continue;
    }
    let parsed: RawOwner;
    try {
      parsed = JSON.parse(raw) as RawOwner;
    } catch {
      candidates.push({
        dirName: name,
        dirFingerprint: fallbackFingerprint,
        ownerState: "malformed_json",
        ownerFingerprint: null,
        ownerServerUrl: null,
        effectiveFingerprint: null,
        localPath: ownerPath,
      });
      continue;
    }
    const fp = parsed.apiKeyFingerprint;
    const ownerFingerprint = typeof fp === "string" && FINGERPRINT_HEX_RE.test(fp) ? fp : null;
    if (isManagedV2Owner(parsed, ownerFingerprint)) continue;
    if (parsed.schemaVersion === undefined
      && ownerFingerprint
      && managedV1Fingerprints.has(ownerFingerprint)) continue;
    const ownerServerUrl = typeof parsed.serverUrl === "string" && parsed.serverUrl.length > 0 ? parsed.serverUrl : null;
    const ownerState: OwnerFileState = ownerFingerprint ? "ok" : "missing_fingerprint";
    candidates.push({
      dirName: name,
      dirFingerprint: fallbackFingerprint,
      ownerState,
      ownerFingerprint,
      ownerServerUrl,
      effectiveFingerprint: ownerFingerprint ?? (ownerState === "missing_fingerprint" ? fallbackFingerprint : null),
      localPath: ownerPath,
    });
  }
  return candidates;
}

export async function collectDetectionEvidence(
  installRoot: string,
  serverSlug: string,
  clientFactory: LegacyMachineRosterClientFactory,
): Promise<MigrationDetectionEvidence> {
  const localCandidates = await collectLocalCandidateEvidence(installRoot);

  if (localCandidates.length === 0) {
    return {
      localCandidates,
      roster: { status: "success", entries: [] },
    };
  }

  const client = clientFactory();
  const result = await client.list(serverSlug);
  return {
    localCandidates,
    roster: result.status === "success"
      ? { status: "success", entries: result.entries }
      : { status: "unavailable", reason: result.status === "error" ? result.code : result.status },
    ...(client.targetServerUrl ? { targetServerUrl: client.targetServerUrl } : {}),
  };
}

function indexRosterByFingerprint(roster: LegacyMachineRosterEntry[]): Map<string, LegacyMachineRosterEntry> {
  const map = new Map<string, LegacyMachineRosterEntry>();
  for (const entry of roster) {
    if (!map.has(entry.apiKeyFingerprint)) {
      map.set(entry.apiKeyFingerprint, entry);
    }
  }
  return map;
}

function candidateFrom(entry: LegacyMachineRosterEntry, local: LocalCandidateEvidence): LegacyMachineCandidate {
  return {
    apiKeyFingerprint: entry.apiKeyFingerprint,
    daemonId: entry.daemonId,
    localPath: local.localPath,
    machineName: entry.machineName,
    ...(entry.hostname ? { hostname: entry.hostname } : {}),
    ...(entry.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}),
    ...(entry.legacyKeyMigratedAt ? { legacyKeyMigratedAt: entry.legacyKeyMigratedAt } : {}),
  };
}

function sortCandidates(out: LegacyMachineCandidate[]): LegacyMachineCandidate[] {
  // RFC v9.9 §X.2 ordering: lastSeenAt DESC, apiKeyFingerprint ASC tiebreak.
  // Missing lastSeenAt sorts to the end (treated as -∞ for DESC).
  out.sort((a, b) => {
    const aSeen = a.lastSeenAt ?? "";
    const bSeen = b.lastSeenAt ?? "";
    if (aSeen !== bSeen) {
      if (aSeen === "") return 1;
      if (bSeen === "") return -1;
      return aSeen < bSeen ? 1 : -1;
    }
    return a.apiKeyFingerprint < b.apiKeyFingerprint ? -1 : a.apiKeyFingerprint > b.apiKeyFingerprint ? 1 : 0;
  });
  return out;
}

function exclusionReasons(
  local: LocalCandidateEvidence,
  rosterByFingerprint: Map<string, LegacyMachineRosterEntry>,
  targetServerUrl: string | undefined,
): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (local.ownerState === "unreadable") reasons.push("owner_unreadable");
  if (local.ownerState === "malformed_json") reasons.push("owner_malformed");
  if (!local.effectiveFingerprint) reasons.push("no_fingerprint_evidence");
  if (local.effectiveFingerprint && !rosterByFingerprint.has(local.effectiveFingerprint)) {
    reasons.push("not_in_roster");
  }
  if (serverUrlMismatch(local.ownerServerUrl, targetServerUrl)) {
    reasons.push("server_url_mismatch");
  }
  return reasons;
}

export function adjudicate(evidence: MigrationDetectionEvidence): MigrationDetection {
  if (evidence.localCandidates.length === 0) {
    return { kind: "no_local_evidence" };
  }

  if (evidence.roster.status === "unavailable") {
    return { kind: "roster_unavailable", localCount: evidence.localCandidates.length };
  }

  const rosterByFingerprint = indexRosterByFingerprint(evidence.roster.entries);
  const candidates: LegacyMachineCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  const usedFingerprints = new Set<string>();

  for (const local of evidence.localCandidates) {
    const match = local.effectiveFingerprint ? rosterByFingerprint.get(local.effectiveFingerprint) : undefined;
    const reasons = exclusionReasons(local, rosterByFingerprint, evidence.targetServerUrl);
    const fatalReasons = reasons.filter((reason) => reason !== "server_url_mismatch");
    if (match && fatalReasons.length === 0) {
      if (!usedFingerprints.has(match.apiKeyFingerprint)) {
        candidates.push(candidateFrom(match, local));
        usedFingerprints.add(match.apiKeyFingerprint);
      }
    } else {
      excluded.push({ evidence: local, reasons });
    }
  }

  if (candidates.length > 0) {
    return { kind: "matched", candidates: sortCandidates(candidates), excluded };
  }
  return { kind: "zero_match", excluded };
}

/**
 * Detect whether the logged-in user has a legacy `@slock-ai/daemon`
 * machine on the target server that matches a local install on this
 * host (intersection on `apiKeyFingerprint`).
 *
 * Returns:
 *   - `{ kind: "matched"; candidates; excluded }` — one-or-more
 *     mutually-known legacy daemons, plus any local evidence excluded
 *     from the picker with structured reasons.
 *   - `{ kind: "zero_match"; excluded }` — local evidence exists, but
 *     none matched the server roster.
 *   - `{ kind: "no_local_evidence" }` — no legacy machine candidates
 *     were found locally; caller can fresh-attach without a roster call.
 *   - `{ kind: "roster_unavailable"; localCount }` — roster fetch failed
 *     transiently after local evidence was found. Caller falls through
 *     to fresh attach.
 *
 * Lib-pure: no env reads, no terminal IO, no `process.exit`. Local
 * filesystem errors are swallowed; only the roster-fetch outcome can
 * change the discriminator.
 */
export async function detectLegacyMigration(
  installRoot: string,
  serverSlug: string,
  clientFactory: LegacyMachineRosterClientFactory,
): Promise<MigrationDetection> {
  return adjudicate(await collectDetectionEvidence(installRoot, serverSlug, clientFactory));
}
