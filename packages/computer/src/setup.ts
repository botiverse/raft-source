// `raft-computer setup <serverSlug>` — task #41 PR-J3 + RFC v9.9 §X.
//
// Thin orchestration over the existing primitives:
//   login → (detect + picker / --machine?) → attach → start
//
// This command deliberately does not introduce a second CLI flow. It decides
// which primitive to call from local state +
// roster intersection, then lets that primitive own auth, preflight,
// credential hygiene, and lifecycle invariants.
//
// §X.4 setup picker (RFC v9.9 — post Jianwei FAIL `msg=ecc2e57e`):
//   - After login, fetch `GET /api/computer/legacy-machines` for the
//     target server and intersect with local
//     `<installRoot>/machines/machine-<fp>/owner.json` evidence on
//     `apiKeyFingerprint` (`detectLegacyMigration`).
//   - `no_local_evidence` → fresh attach (no prompt). Trigger #1
//     (`empty-intersection`).
//   - `zero_match` → R2 explain/refuse; explicit `--fresh` is the
//     duplicate-risk escape hatch.
//   - `roster_unavailable` → fresh attach. Trigger #4
//     (`server-unavailable`, best-effort; legacy name kept in setup event
//     attrs for compatibility).
//   - Non-empty + non-TTY → hard-fail with guidance. Automation must pass
//     `--machine <machineId>` so setup never silently creates a duplicate
//     Computer identity.
//   - Non-empty + TTY → numbered picker (loops on invalid input or
//     only the `--machine` flag
//     hard-fails):
//       1..N — adopt that legacy daemon through the logged-in user's
//             legacy-machine roster identity (no raw legacy key prompt)
//       <Enter> — reprompt; changing state requires an explicit choice
//       new — fresh attach; consequence-worded and separated from the
//             recommended existing Computer action (Trigger #2)
//       EOF — fresh attach (Trigger #2, `eof`)
//             failed gate surfaces the token and returns to the
//             picker (operator can retry, type a different path, or
//             type `new` for fresh attach).
//       any other input — reprompt (NEVER silently falls through to
//             fresh attach; that was the pre-fix B1/B4 drift).
//   - `--machine <machineId>` flag bypasses detection entirely and
//     hard-fails on any of the three gates
//     (`MIGRATE_FROM_NOT_FOUND` / `_INVALID` / `_NOT_OWNED`) and on
//     roster unavailability (`MIGRATE_FROM_ROSTER_UNAVAILABLE`).
//
// `services/adoptLegacy.ts` preserves the legacy raw-key path internally, but
// setup's normal picker branches use roster-fingerprint adoption after
// user login so the operator is not asked to paste LEGACY_KEY.
import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LegacyMachinesClient,
  ServersClient,
  type LegacyMachineManualEntry,
  type LegacyMachineManualRosterResult,
} from "./apiClient.js";
import { runAttach } from "./attach.js";
import {
  detectLegacyMigration,
} from "./lib/migration.js";
import {
  dismissedEvidenceKeys,
  evidenceKey,
  recordZeroMatchDismissal,
  zeroMatchDismissalIdentity,
  type MigrationDismissalEvidence,
  type ZeroMatchDismissalIdentity,
} from "./lib/migrationDismissals.js";
import type { LegacyMachineCandidate } from "./lib/types.js";
import { runLogin } from "./login.js";
import { CliExit, info, present } from "./output.js";
import { ComputerError } from "./lib/errors.js";
import type { ComputerTracer } from "./lib/traceTypes.js";
import { formatUpgradeLogTimestamp, resolveRaftHome, serverAttachmentPath } from "./paths.js";
import { resolveServerUrl, resolveServerUrlEnv } from "./serverUrl.js";
import { formatServerSlugDisplay, migrateKnownServerUrl, normalizeServerSlug, resolveAttachedServerSlug } from "./serverState.js";
import {
  adoptLegacyByDaemonId as adoptLegacyByDaemonIdService,
  adoptLegacyByFingerprint as adoptLegacyByFingerprintService,
} from "./services/adoptLegacy.js";
import {
  diagnosticsPush as diagnosticsPushService,
  type DiagnosticsPushResult,
} from "./services/diagnosticsPush.js";
import type { ComputerApiEvent } from "./lib/events.js";
import { ComputerServiceError } from "./services/errors.js";
import { start as startService, type StartDeps } from "./services/start.js";
import { stop as stopService, type StopDeps } from "./services/stop.js";
import { runStart, runStop } from "./startStop.js";
import { readTerminalUnlinked } from "./health.js";
import { attach as attachService } from "./services/attach.js";
import { createComputerApi } from "./lib/api.js";
import { createComputerTracer } from "./lib/computerTracer.js";
import {
  hasUnexpiredUserSessionShape,
  readUserSessionIdentity,
  readUserSessionAuth,
  refreshUserSession,
} from "./lib/userSession.js";
import { noopTracer } from "@botiverse/raft-shared";
import {
  accountUnavailableMessage,
  type AccountUnavailableMessageInput,
} from "./accountUnavailable.js";

export interface SetupOptions {
  serverSlug: string;
  serverUrl?: string;
  name?: string;
  start?: boolean;
  foreground?: boolean;
  yes?: boolean;
  verbose?: boolean;
  /**
   * Explicit duplicate-risk escape hatch for the zero-match migration branch:
   * setup prints the local evidence/exclusion table and then proceeds with a
   * fresh attach instead of hard-failing. It does not bypass the matched
   * candidate safety gate.
   */
  fresh?: boolean;
  /**
   * Adopt the web Computers page's row id instead of local-evidence matching
   * (v2.3 §19). Server-side authority is `manageMachines` plus target-Server
   * row binding; caller row ownership and local owner.json are not required.
   */
  machine?: string;
}

export interface SetupDeps {
  isTty?: boolean;
  runLogin?: typeof runLogin;
  runAttach?: typeof runAttach;
  runStart?: typeof runStart;
  runStop?: typeof runStop;
  startService?: typeof startService;
  attachService?: typeof attachService;
  stopService?: typeof stopService;
  startDeps?: StartDeps;
  stopDeps?: StopDeps;
  refreshUserSession?: typeof refreshUserSession;
  detectLegacyMigration?: typeof detectLegacyMigration;
  /**
   * Roster client factory — defaults to `new LegacyMachinesClient(...)`.
   * Tests stub this to feed a fake roster without booting undici.
   */
  buildRosterClient?: (baseUrl: string, accessToken: string) => {
    list: LegacyMachinesClient["list"];
    listAll?: LegacyMachinesClient["listAll"];
  };
  /**
   * Signed-in user server list client — defaults to `new ServersClient(...)`.
   * Setup uses this immediately after login to prove the target server is in
   * the user's accessible server list and that the user can attach before
   * migration/adoption work starts.
   */
  buildServersClient?: (baseUrl: string, accessToken: string) => {
    list: ServersClient["list"];
  };
  buildAccountUnavailableMessage?: (input: AccountUnavailableMessageInput) => string;
  /**
   * Picker prompt — returns the operator's selection. Defaults to a
   * stdin reader. Each return value drives a distinct branch:
   *   - `{ kind: "candidate"; index: number }` — adopt picker entry 1..N
   *   - `{ kind: "fresh" }` — explicit fresh setup
   *   - `{ kind: "quit" }` — operator chose to leave local state unchanged
   */
  pickMigrationCandidate?: (
    candidates: LegacyMachineCandidate[],
    serverLabel: string,
  ) => Promise<PickerSelection>;
  pickZeroMatchMigration?: (
    excluded: SetupExcludedCandidate[],
    serverCandidates: LegacyMachineManualEntry[],
  ) => Promise<ZeroMatchSelection>;
  pickRosterUnavailable?: (localCount: number | null) => Promise<RosterUnavailableSelection>;
  /**
   * Roster-fingerprint adoption service injection — defaults to
   * `adoptLegacyByFingerprintService`. Tests stub this to verify picker
   * wiring without hitting the network. Normal setup never reads a raw
   * legacy key; the selected candidate's roster identity is the authority.
   */
  adoptLegacyByFingerprint?: typeof adoptLegacyByFingerprintService;
  adoptLegacyByDaemonId?: typeof adoptLegacyByDaemonIdService;
  /**
   * Forced migration diagnostics hook. The default writes a scrubbed
   * diagnostics marker and, when a runner is available, immediately uploads
   * the migration trace bundle. Tests inject this to prove the product setup
   * path invokes diagnostics instead of only exposing the helper.
   */
  diagnosticsPush?: typeof diagnosticsPushService;
}

export type PickerSelection =
  | { kind: "candidate"; index: number }
  | { kind: "fresh" }
  | { kind: "quit" };

export type ZeroMatchSelection =
  | { kind: "server-candidate"; index: number }
  | { kind: "fresh" }
  | { kind: "quit" };

export type RosterUnavailableSelection =
  | { kind: "retry" }
  | { kind: "fresh" }
  | { kind: "quit" };

export type SetupExcludedCandidate = {
  localPath?: string;
  effectiveFingerprint?: string | null;
  ownerFingerprint?: string | null;
  dirFingerprint?: string | null;
  ownerState?: string;
  reasons: string[];
  hasDirFingerprint?: boolean;
  serverUrlHost?: string | null;
  rosterMatch?: boolean;
};

type SetupAdjudication =
  | { kind: "matched"; candidates: LegacyMachineCandidate[]; excluded: SetupExcludedCandidate[] }
  | { kind: "zero_match"; excluded: SetupExcludedCandidate[] }
  | { kind: "no_local_evidence" }
  | { kind: "roster_unavailable"; localCount: number | null };

/**
 * Closed-set enumeration of the §X.4 fresh-attach triggers. Used in
 * setup info() lines so QA can grep for "fresh trigger: <name>" and
 * test mocks can assert that ONLY these inputs route to fresh attach
 * (Cody NIT `msg=9102a817`). The picker function itself only emits
 * `typed-new` / `eof`; the other three are decided upstream in
 * `runSetup` before the picker ever fires.
 */
export const MIGRATION_FRESH_TRIGGERS = [
  "empty-intersection",
  "typed-new",
  "eof",
  "non-tty",
  "server-unavailable",
  "zero-match-explicit-fresh",
] as const;
export type MigrationFreshTrigger = (typeof MIGRATION_FRESH_TRIGGERS)[number];

export { hasUnexpiredUserSessionShape, refreshUserSession };

/**
 * Pure picker grammar — extracted so it can be exercised by unit tests
 * without stubbing global stdin/stdout. RFC v9.9 §X.4 (post-Jianwei FAIL
 * `msg=ecc2e57e` / Cody NIT `msg=9102a817`):
 *   - `1`..`N` / `<Enter>` → adopt that candidate (1-indexed; Enter picks
 *     the first candidate, since the operator already saw the
 *     intersection list).
 *   - `new` → fresh attach; consequence-worded and separated from the
 *     recommended existing Computer action (Trigger #2: typed-new).
 *   - EOF (Ctrl-D / closed stdin) → fresh attach (Trigger #2: eof).
 *   - Anything else → reprompt. The picker NEVER silently falls through
 *     to fresh attach on unrecognized input — that was the B1/B4 contract
 *     drift that QA rejected.
 */
export async function pickMigrationCandidateFromInput(
  serverLabel: string,
  candidates: LegacyMachineCandidate[],
  read: () => Promise<{ line: string; eof: boolean }>,
  write: (s: string) => void,
): Promise<PickerSelection> {
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const oldComputer = Boolean(candidate.legacyKeyMigratedAt);
    if (oldComputer) {
      write(`This computer was connected to ${serverLabel} before:\n`);
    } else {
      write("Found this computer's previous setup (old Raft daemon):\n");
    }
    write(`  ● ${uniqueCandidateSummary(candidate)}\n`);
    while (true) {
      write(oldComputer ? "Reconnect? [y/n]: " : "Migrate it to Raft Computer? [y/n]  (keeps your agents · `new` = set up separately): ");
      const { line, eof } = await read();
      if (eof) return { kind: "quit" };
      const trimmed = line.trim();
      const norm = trimmed.toLowerCase();
      if (norm === "y") return { kind: "candidate", index: 0 };
      if (norm === "n") return { kind: "quit" };
      if (!oldComputer && norm === "new") return { kind: "fresh" };
      if (norm.length === 0) {
        write("Pressing Enter does not choose an action here. Type y or n.\n");
      } else {
        write(`Invalid selection "${trimmed}". Type y or n${oldComputer ? "" : ", or new"}.\n`);
      }
    }
  }

  const legacyDaemonCandidates = candidates.some((candidate) => !candidate.legacyKeyMigratedAt);
  write(
    legacyDaemonCandidates
      ? `Found ${candidates.length} old daemons on this computer that can migrate to ${serverLabel}:\n`
      : `Found ${candidates.length} previous Raft Computer connections for ${serverLabel}:\n`,
  );
  const displayNames = candidates.map(candidatePickerDisplayName);
  const duplicateNames = new Set(
    displayNames.filter((name, index) => displayNames.indexOf(name) !== index),
  );
  candidates.forEach((candidate, index) => {
    const displayName = displayNames[index]!;
    const disambiguator = duplicateNames.has(displayName) ? ` (${candidate.apiKeyFingerprint.slice(0, 8)}…)` : "";
    const seen = candidate.lastSeenAt ? ` — last seen ${candidate.lastSeenAt}` : "";
    const marker = index === 0 ? " ← most recent" : "";
    write(`  ${index + 1}. ${displayName}${disambiguator}${seen}${marker}\n`);
  });
  write(
    legacyDaemonCandidates
      ? `Type 1-${candidates.length} to migrate one (keeps its agents · new = separate computer · q = quit)\n`
      : `Type 1-${candidates.length} to reconnect one (new = separate computer · q = quit)\n`,
  );
  while (true) {
    write("Choose: ");
    const { line, eof } = await read();
    if (eof) return { kind: "fresh" };
    const trimmed = line.trim();
    const norm = trimmed.toLowerCase();
    if (norm === "q") return { kind: "quit" };
    if (norm.length === 0) {
      write(`Pressing Enter does not choose an action here. Type 1..${candidates.length}, new, or q.\n`);
      continue;
    }
    if (norm === "new") {
      return { kind: "fresh" };
    }
    const n = Number.parseInt(norm, 10);
    if (Number.isFinite(n) && String(n) === norm && n >= 1 && n <= candidates.length) {
      return { kind: "candidate", index: n - 1 };
    }
    write(`Invalid selection "${trimmed}". Type 1..${candidates.length}, new, or q.\n`);
  }
}

function uniqueCandidateSummary(candidate: { machineName: string; hostname?: string | null; lastSeenAt?: string | null }): string {
  const name = candidatePickerDisplayName(candidate);
  const seen = candidate.lastSeenAt ? ` — last seen ${candidate.lastSeenAt}` : "";
  return `${name}${seen}`;
}

function candidatePickerDisplayName(candidate: { machineName: string; hostname?: string | null }): string {
  if (!candidate.hostname || candidate.hostname === candidate.machineName) return candidate.machineName;
  return `${candidate.machineName} (${candidate.hostname})`;
}

function candidateDisplayName(candidate: { machineName: string; hostname?: string | null; lastSeenAt?: string | null }): string {
  const host = candidate.hostname ? ` (${candidate.hostname})` : "";
  const seen = candidate.lastSeenAt ? ` last seen ${candidate.lastSeenAt}` : "";
  return `${candidate.machineName}${host}${seen}`;
}

function shortDate(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function appServerUrl(serverSlug: string): string {
  return `https://app.raft.build/${normalizeServerSlug(serverSlug)}`;
}

function serverUrlHost(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

function getExcludedLocalPath(excluded: Record<string, unknown>): string | undefined {
  if (typeof excluded.localPath === "string") return excluded.localPath;
  const evidence = excluded.evidence;
  if (evidence && typeof evidence === "object") {
    const localPath = (evidence as Record<string, unknown>).localPath;
    if (typeof localPath === "string") return localPath;
  }
  return undefined;
}

function normalizeExcludedCandidate(raw: unknown): SetupExcludedCandidate {
  if (!raw || typeof raw !== "object") return { reasons: ["unknown"] };
  const record = raw as Record<string, unknown>;
  const evidence = record.evidence && typeof record.evidence === "object"
    ? record.evidence as Record<string, unknown>
    : record;
  const rawReasons = Array.isArray(record.reasons) ? record.reasons : [];
  const reasons = rawReasons
    .filter((reason): reason is string => typeof reason === "string" && reason.length > 0);
  const ownerState = typeof evidence.ownerState === "string"
    ? evidence.ownerState
    : typeof evidence.owner_state === "string"
      ? evidence.owner_state
      : undefined;
  const ownerServerUrl = typeof evidence.ownerServerUrl === "string"
    ? evidence.ownerServerUrl
    : typeof evidence.owner_server_url === "string"
      ? evidence.owner_server_url
      : undefined;
  const hasDirFingerprint =
    typeof evidence.dirFingerprint === "string" ||
    typeof evidence.dir_fingerprint === "string" ||
    evidence.hasDirFingerprint === true ||
    evidence.has_dir_fp === true;
  const effectiveFingerprint = typeof evidence.effectiveFingerprint === "string"
    ? evidence.effectiveFingerprint
    : typeof evidence.effective_fingerprint === "string"
      ? evidence.effective_fingerprint
      : null;
  const ownerFingerprint = typeof evidence.ownerFingerprint === "string"
    ? evidence.ownerFingerprint
    : typeof evidence.owner_fingerprint === "string"
      ? evidence.owner_fingerprint
      : null;
  const dirFingerprint = typeof evidence.dirFingerprint === "string"
    ? evidence.dirFingerprint
    : typeof evidence.dir_fingerprint === "string"
      ? evidence.dir_fingerprint
      : null;
  const rosterMatch = record.rosterMatch === true || record.roster_match === true;
  return {
    localPath: getExcludedLocalPath(record),
    effectiveFingerprint,
    ownerFingerprint,
    dirFingerprint,
    ownerState,
    reasons: reasons.length > 0 ? reasons : ["excluded"],
    hasDirFingerprint,
    serverUrlHost: serverUrlHost(ownerServerUrl),
    rosterMatch,
  };
}

function normalizeMigrationDetection(detection: unknown): SetupAdjudication {
  if (!detection || typeof detection !== "object") {
    return { kind: "no_local_evidence" };
  }
  const record = detection as Record<string, unknown>;
  switch (record.kind) {
    case "matched":
      return {
        kind: "matched",
        candidates: Array.isArray(record.candidates)
          ? (record.candidates as LegacyMachineCandidate[])
          : [],
        excluded: Array.isArray(record.excluded)
          ? record.excluded.map(normalizeExcludedCandidate)
          : [],
      };
    case "zero_match":
      return {
        kind: "zero_match",
        excluded: Array.isArray(record.excluded)
          ? record.excluded.map(normalizeExcludedCandidate)
          : [],
      };
    case "no_local_evidence":
      return { kind: "no_local_evidence" };
    case "roster_unavailable":
      return {
        kind: "roster_unavailable",
        localCount: typeof record.localCount === "number" ? record.localCount : null,
      };
    case "server-unavailable":
      return { kind: "roster_unavailable", localCount: null };
    case "candidates": {
      const candidates = Array.isArray(record.candidates)
        ? (record.candidates as LegacyMachineCandidate[])
        : [];
      return candidates.length > 0
        ? { kind: "matched", candidates, excluded: [] }
        : { kind: "no_local_evidence" };
    }
    default:
      return { kind: "no_local_evidence" };
  }
}

function setupRequiresAdminMessage(targetLabel: string): string {
  return `Attaching a Computer to ${targetLabel} requires the admin or owner role on this server. You are a member, but only admins/owners can attach — ask a server admin to attach this Computer or grant you admin, then run \`raft-computer setup ${targetLabel}\`.`;
}

function formatExcludedCandidates(excluded: SetupExcludedCandidate[]): string[] {
  if (excluded.length === 0) return ["  (no local candidate details were available)"];
  return excluded.map((candidate, index) => {
    const path = candidate.localPath ? ` ${candidate.localPath}` : "";
    const owner = formatOwnerState(candidate.ownerState);
    const reason = formatExcludedReason(candidate);
    return `  ${index + 1}. local daemon${path} — ${owner} — ${reason}`;
  });
}

function formatOwnerState(ownerState: string | undefined): string {
  if (ownerState === "ok") return "owner file ok";
  if (ownerState === "absent") return "owner file absent";
  if (ownerState === "unreadable") return "owner file unreadable";
  if (ownerState === "malformed_json") return "owner file malformed";
  if (ownerState === "missing_fingerprint") return "old daemon format";
  return "owner state unknown";
}

function formatExcludedReason(candidate: SetupExcludedCandidate): string {
  if (candidate.reasons.includes("server_url_mismatch") && candidate.serverUrlHost) {
    return `belongs to ${candidate.serverUrlHost}`;
  }
  if (candidate.ownerState === "unreadable" || candidate.reasons.includes("owner_unreadable")) {
    return "owner file unreadable";
  }
  if (candidate.ownerState === "malformed_json" || candidate.reasons.includes("owner_malformed")) {
    return "owner file malformed";
  }
  if (candidate.ownerState === "absent" || candidate.ownerState === "missing_fingerprint") {
    return "old daemon format (no fingerprint) — dir-name fallback not known either";
  }
  if (candidate.reasons.includes("not_in_roster")) return "fingerprint not known to this server";
  if (candidate.reasons.includes("no_fingerprint_evidence")) return "no fingerprint evidence";
  return "not recognized by this server";
}

function formatCountByHost(candidates: SetupExcludedCandidate[]): string {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.serverUrlHost ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([host, count]) => `${host} ×${count}`)
    .join(", ");
}

function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function zeroMatchGroups(excluded: SetupExcludedCandidate[]): string[] {
  const otherServer = excluded.filter((candidate) => candidate.reasons.includes("server_url_mismatch"));
  const incomplete = excluded.filter((candidate) =>
    candidate.ownerState === "absent" ||
    candidate.ownerState === "unreadable" ||
    candidate.ownerState === "malformed_json" ||
    candidate.reasons.includes("no_fingerprint_evidence") ||
    candidate.reasons.includes("owner_unreadable") ||
    candidate.reasons.includes("owner_malformed")
  );
  const unmatchedHere = excluded.filter((candidate) =>
    !otherServer.includes(candidate) && !incomplete.includes(candidate)
  );
  const lines: string[] = [];
  if (otherServer.length > 0) {
    lines.push(`  ${otherServer.length} ${pluralize(otherServer.length, "belongs", "belong")} to other servers (${formatCountByHost(otherServer)})`);
  }
  if (incomplete.length > 0) {
    lines.push(`  ${incomplete.length} ${pluralize(incomplete.length, "is", "are")} incomplete (missing or unreadable state)`);
  }
  if (unmatchedHere.length > 0) {
    lines.push(`  ${unmatchedHere.length} ${pluralize(unmatchedHere.length, "looks", "look")} like this server but ${pluralize(unmatchedHere.length, "is", "are")} not recognized`);
  }
  return lines.slice(0, 3);
}

function isSuspiciousZeroMatch(excluded: SetupExcludedCandidate[]): boolean {
  // Deliberately classify old-schema traces without serverUrl as suspicious:
  // if they look local to this server but the server does not recognize them,
  // setup must stop instead of risking a duplicate or stranded agents.
  return excluded.some((candidate) =>
    !candidate.reasons.includes("server_url_mismatch") &&
    (candidate.ownerState === "ok" || candidate.ownerState === "missing_fingerprint")
  );
}

function emitZeroMatchSummary(
  emit: (line: string) => void,
  excluded: SetupExcludedCandidate[],
  label: string,
): void {
  emit(`Found ${excluded.length} ${pluralize(excluded.length, "trace", "traces")} of old daemons on this computer, but none can migrate to ${label}:`);
  for (const line of zeroMatchGroups(excluded)) emit(line);
}

function zeroMatchSummaryMessage(excluded: SetupExcludedCandidate[], label = "this server"): string {
  return [
    `Found ${excluded.length} ${pluralize(excluded.length, "trace", "traces")} of old daemons on this computer, but none can migrate to ${label}.`,
    ...zeroMatchGroups(excluded).map((line) => line.trim()),
  ].join("\n");
}

function emitExcludedTable(
  emit: (line: string) => void,
  excluded: SetupExcludedCandidate[],
  intro: string,
): void {
  emit(intro);
  for (const line of formatExcludedCandidates(excluded)) emit(line);
}

function zeroMatchErrorMessage(excluded: SetupExcludedCandidate[]): string {
  return [
    zeroMatchSummaryMessage(excluded),
    "Refusing to create a new Computer connection silently because that may duplicate an existing daemon identity.",
    "Inspect the local evidence with `raft-computer doctor --migration-details`, retry on a TTY to choose a server row, pass --machine <machineId> (the id from the web Computers page) to adopt a specific row, or pass --fresh to accept a new setup.",
  ].join("\n");
}

function migrationDiscoveryAttrs(adjudication: SetupAdjudication): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    outcome: adjudication.kind,
    local_candidate_count:
      adjudication.kind === "roster_unavailable"
        ? (adjudication.localCount ?? -1)
        : adjudication.kind === "no_local_evidence"
          ? 0
          : adjudication.kind === "matched"
            ? adjudication.candidates.length + adjudication.excluded.length
            : adjudication.excluded.length,
    matched_count: adjudication.kind === "matched" ? adjudication.candidates.length : 0,
    excluded_count:
      adjudication.kind === "matched"
        ? adjudication.excluded.length
        : adjudication.kind === "zero_match"
          ? adjudication.excluded.length
          : 0,
    candidate_already_migrated_count:
      adjudication.kind === "matched"
        ? adjudication.candidates.filter((candidate) => Boolean(candidate.legacyKeyMigratedAt)).length
        : 0,
  };
  const excluded = adjudication.kind === "matched" || adjudication.kind === "zero_match"
    ? adjudication.excluded
    : [];
  excluded.slice(0, 20).forEach((candidate, index) => {
    const ordinal = index + 1;
    attrs[`excluded_${ordinal}_owner_state`] = candidate.ownerState ?? "unknown";
    attrs[`excluded_${ordinal}_reasons`] = candidate.reasons.join(",");
    attrs[`excluded_${ordinal}_has_dir_fp`] = candidate.hasDirFingerprint === true;
    attrs[`excluded_${ordinal}_server_url_host`] = candidate.serverUrlHost ?? "";
    attrs[`excluded_${ordinal}_roster_match`] = candidate.rosterMatch === true;
  });
  return attrs;
}

export async function pickZeroMatchMigrationFromInput(
  excluded: SetupExcludedCandidate[],
  serverCandidates: LegacyMachineManualEntry[],
  read: () => Promise<{ line: string; eof: boolean }>,
  write: (s: string) => void,
): Promise<ZeroMatchSelection> {
  if (serverCandidates.length > 0) {
    write("You can migrate a computer this server already knows, or set this up as new:\n");
  } else {
    write("No matching computers on this server. Type new to set up as a new computer, or q to quit without changing local state.\n");
  }
  let visibleCount = Math.min(serverCandidates.length, 5);
  const writeCandidates = () => {
    serverCandidates.slice(0, visibleCount).forEach((candidate, index) => {
      write(`  ${index + 1}. ${candidate.machineName.padEnd(20)} — last seen ${shortDate(candidate.lastSeenAt)}\n`);
    });
    if (serverCandidates.length > visibleCount) {
      write(`  (${serverCandidates.length - visibleCount} more: type \`a\` to show all)\n`);
    }
  };
  if (serverCandidates.length > 0) {
    writeCandidates();
  }
  write("Full evidence: rerun with --verbose, or `raft-computer doctor --migration-details`\n");
  while (true) {
    write(
      serverCandidates.length > 0
        ? `Choose 1-${visibleCount}${serverCandidates.length > visibleCount ? "/a" : ""}:  (\`new\` = set up as a new computer · \`q\` = quit, nothing changed) `
        : "Choose:  (`new` = set up as a new computer · `q` = quit, nothing changed) ",
    );
    const { line, eof } = await read();
    if (eof) return { kind: "quit" };
    const norm = line.trim().toLowerCase();
    if (norm === "new") return { kind: "fresh" };
    if (norm === "q") return { kind: "quit" };
    if (norm.length === 0) {
      write("Pressing Enter does not choose an action here. Type new or q.\n");
      continue;
    }
    if (norm === "a" && serverCandidates.length > visibleCount) {
      visibleCount = serverCandidates.length;
      writeCandidates();
      continue;
    }
    const n = Number.parseInt(norm, 10);
    if (Number.isFinite(n) && String(n) === norm && n >= 1 && n <= visibleCount) {
      return { kind: "server-candidate", index: n - 1 };
    }
    write(`Invalid selection "${line.trim()}". Type ${serverCandidates.length > 0 ? `1..${visibleCount}, ` : ""}new, or q.\n`);
  }
}

async function defaultPickZeroMatchMigration(
  excluded: SetupExcludedCandidate[],
  serverCandidates: LegacyMachineManualEntry[],
): Promise<ZeroMatchSelection> {
  return pickZeroMatchMigrationFromInput(
    excluded,
    serverCandidates,
    () => readLine(false),
    (s) => {
      process.stdout.write(s);
    },
  );
}

export async function pickRosterUnavailableFromInput(
  localCount: number | null,
  read: () => Promise<{ line: string; eof: boolean }>,
  write: (s: string) => void,
): Promise<RosterUnavailableSelection> {
  const localText = typeof localCount === "number" && localCount >= 0
    ? `${localCount} local daemon(s)`
    : "local daemon evidence";
  write(`Migration: legacy machine roster unavailable while ${localText} exist. Fresh setup may create a duplicate Computer identity.\n`);
  write("Choices:\n");
  write("  r. Retry roster discovery\n");
  write("  f. Create a new Computer connection anyway (fresh attach)\n");
  write("  q. Quit without changing local state\n");
  while (true) {
    write("Choose [r/f/q]: ");
    const { line, eof } = await read();
    if (eof) return { kind: "quit" };
    const norm = line.trim().toLowerCase();
    if (norm === "r") return { kind: "retry" };
    if (norm === "f") return { kind: "fresh" };
    if (norm === "q" || norm.length === 0) return { kind: "quit" };
    write(`Invalid selection "${line.trim()}". Type r, f, or q.\n`);
  }
}

async function defaultPickRosterUnavailable(localCount: number | null): Promise<RosterUnavailableSelection> {
  return pickRosterUnavailableFromInput(
    localCount,
    () => readLine(false),
    (s) => {
      process.stdout.write(s);
    },
  );
}

async function defaultPickMigrationCandidate(
  candidates: LegacyMachineCandidate[],
  serverLabel: string,
): Promise<PickerSelection> {
  return pickMigrationCandidateFromInput(
    serverLabel,
    candidates,
    () => readLine(false),
    (s) => {
      process.stdout.write(s);
    },
  );
}

/**
 * One-shot single-line stdin read. When `masked` is true and stdin is a
 * raw-mode-capable TTY, terminal echo is suppressed for the duration of
 * the read so the legacy key never appears in the user's scrollback.
 *
 * Returns `{ line, eof }` so the §X.4 picker can distinguish
 * Enter-with-empty-line (`line: ""`, `eof: false` → first candidate)
 * from EOF / closed stdin (`line: ""`, `eof: true` → fresh attach
 * Trigger #2). RFC v9.9 §X.4.
 */
async function readLine(masked: boolean): Promise<{ line: string; eof: boolean }> {
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY === true && stdin.isRaw === true;
  const enterRaw = masked && stdin.isTTY === true && typeof stdin.setRawMode === "function";
  if (enterRaw) stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<{ line: string; eof: boolean }>((resolve) => {
    let buf = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      if (enterRaw) stdin.setRawMode(wasRaw);
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          resolve({ line: buf, eof: false });
          return;
        }
        if (ch === "") {
          // Ctrl-D in raw mode — treat as EOF (picker Trigger #2).
          cleanup();
          resolve({ line: buf, eof: true });
          return;
        }
        if (ch === "") {
          // Ctrl-C in raw mode — treat as cancel (empty line).
          cleanup();
          resolve({ line: "", eof: false });
          return;
        }
        if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const onEnd = () => {
      cleanup();
      resolve({ line: buf, eof: true });
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

/**
 * Shared stop-safety warning: picker uses user-scoped roster + local owner;
 * --machine uses `manageMachines` + Server binding without caller ownership.
 * Neither branch reads a raw legacy key.
 */
function emitUnverifiedLegacyStopWarning(
  serverSlug: string,
  emit: (line: string) => void,
  detail: string,
): void {
  emit(`WARNING: legacy daemon stop was NOT verified. ${detail}`);
  emit(
    `  Stop and disable the old daemon with its OS service controls, confirm its process and log are quiet, then run \`raft-computer restart ${formatServerSlugDisplay(serverSlug)}\` and \`raft-computer doctor ${formatServerSlugDisplay(serverSlug)}\`.`,
  );
}

async function runRosterAdoption(
  opts: SetupOptions,
  candidate: LegacyMachineCandidate,
  adoptLegacyByFingerprintImpl: typeof adoptLegacyByFingerprintService,
  emit: (line: string) => void,
  tracer: ComputerTracer = noopTracer,
  migrationAttemptId?: string,
): Promise<void> {
  const span = tracer.startSpan("computer.migration.adopt", {
    surface: "computer",
    kind: "internal",
    attrs: {
      ...(migrationAttemptId ? { migration_attempt_id: migrationAttemptId } : {}),
      mode: "roster-fingerprint",
      candidate_already_migrated: Boolean(candidate.legacyKeyMigratedAt),
    },
  });
  const where = candidate.hostname ? ` (${candidate.hostname})` : "";
  const seen = candidate.lastSeenAt ? ` last seen ${candidate.lastSeenAt}` : "";
  emit(`Migration: adopting legacy daemon "${candidate.machineName}"${where}${seen} using logged-in user authorization.`);
  emit(`  local owner.json: ${candidate.localPath}`);
  emit("  legacy api key: not required for setup after user login.");

  try {
    const result = await adoptLegacyByFingerprintImpl(
      {
        serverSlug: opts.serverSlug,
        ...(opts.serverUrl ? { serverUrl: opts.serverUrl } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        legacyMachineId: candidate.daemonId,
        apiKeyFingerprint: candidate.apiKeyFingerprint,
        legacyOwnerPath: candidate.localPath,
      },
      {
        onEvent: (event) => {
          if (event.type === "adopting") {
            emit(
              `Adopting legacy daemon for ${formatServerSlugDisplay(event.serverSlug)} via user-scoped legacy roster…`,
            );
          } else if (event.type === "preflight") {
            emit(
              event.resumed
                ? "Adopted (resumed prior attachment); running preflight…"
                : "Adopted; running preflight…",
            );
          } else if (event.type === "adopted") {
            emit(`Adopted. Computer state written to ${event.attachmentPath}`);
            emit(`  server:        ${formatServerSlugDisplay(event.serverSlug)}`);
            emit(`  serverMachine: ${event.serverMachineId}`);
            emit(`  legacyMachine: ${event.legacyMachineId}`);
            switch (event.legacyStop.outcome) {
              case "absent":
                emit("  legacy daemon: not detected on this Computer (no local lock file)");
                break;
              case "already_dead":
                emit(`  legacy daemon: already stopped (pid ${event.legacyStop.pid} not running)`);
                break;
              case "stopped":
                emit(`  legacy daemon: stopped (pid ${event.legacyStop.pid}, SIGTERM)`);
                break;
            }
          }
        },
      },
    );
    if (result.legacyStop.outcome === "absent") {
      emitUnverifiedLegacyStopWarning(
        result.serverSlug,
        emit,
        "A custom launchd/systemd/service wrapper may still be running and auto-restarting it.",
      );
    }
    span.end("ok", {
      attrs: {
        resumed: result.resumed,
        legacy_stop_outcome: result.legacyStop.outcome,
      },
    });
  } catch (err) {
    span.end("error", {
      attrs: {
        error_code: err instanceof ComputerServiceError ? err.code : "unexpected",
      },
    });
    if (err instanceof ComputerServiceError) {
      throw new ComputerError(err.code, err.message);
    }
    throw err;
  }
}

async function runRosterDaemonIdAdoption(
  opts: SetupOptions,
  candidate: LegacyMachineManualEntry,
  adoptLegacyByDaemonIdImpl: typeof adoptLegacyByDaemonIdService,
  emit: (line: string) => void,
  tracer: ComputerTracer = noopTracer,
  migrationAttemptId?: string,
): Promise<void> {
  const span = tracer.startSpan("computer.migration.adopt", {
    surface: "computer",
    kind: "internal",
    attrs: {
      ...(migrationAttemptId ? { migration_attempt_id: migrationAttemptId } : {}),
      mode: "roster-daemon-id",
      candidate_already_migrated: Boolean(candidate.legacyKeyMigratedAt),
    },
  });
  emit(`Migration: adopting server legacy daemon "${candidateDisplayName(candidate)}" using logged-in user authorization.`);
  emit("  local owner.json: not required for server-row adoption.");
  emit("  legacy api key: not required for setup after user login.");

  try {
    const result = await adoptLegacyByDaemonIdImpl(
      {
        serverSlug: opts.serverSlug,
        ...(opts.serverUrl ? { serverUrl: opts.serverUrl } : {}),
        ...(opts.name ? { name: opts.name } : {}),
        legacyMachineId: candidate.daemonId,
      },
      {
        onEvent: (event) => {
          if (event.type === "adopting") {
            emit(
              `Adopting legacy daemon for ${formatServerSlugDisplay(event.serverSlug)} via server machine identity…`,
            );
          } else if (event.type === "preflight") {
            emit(
              event.resumed
                ? "Adopted (resumed prior attachment); running preflight…"
                : "Adopted; running preflight…",
            );
          } else if (event.type === "adopted") {
            emit(`Adopted. Computer state written to ${event.attachmentPath}`);
            emit(`  server:        ${formatServerSlugDisplay(event.serverSlug)}`);
            emit(`  serverMachine: ${event.serverMachineId}`);
            emit(`  legacyMachine: ${event.legacyMachineId}`);
            emit("  legacy daemon: local stop skipped (server-row adoption has no trusted local owner.json)");
          }
        },
      },
    );
    if (result.legacyStop.outcome === "absent") {
      emitUnverifiedLegacyStopWarning(
        result.serverSlug,
        emit,
        "Server-row adoption has no trusted local owner.json; stop and disable any old OS service before treating this Computer as the only host.",
      );
    }
    span.end("ok", {
      attrs: {
        resumed: result.resumed,
        legacy_stop_outcome: result.legacyStop.outcome,
      },
    });
  } catch (err) {
    span.end("error", {
      attrs: {
        error_code: err instanceof ComputerServiceError ? err.code : "unexpected",
      },
    });
    if (err instanceof ComputerServiceError) {
      throw new ComputerError(err.code, err.message);
    }
    throw err;
  }
}

function recordMigrationDecision(
  tracer: ComputerTracer,
  migrationAttemptId: string,
  attrs: Record<string, string | number | boolean>,
): void {
  const span = tracer.startSpan("computer.migration.decision", {
    surface: "computer",
    kind: "internal",
    attrs: {
      migration_attempt_id: migrationAttemptId,
      ...attrs,
    },
  });
  span.end("ok");
}

function formatMigrationDiagnosticsResult(result: DiagnosticsPushResult): string {
  if (result.status === "failed") {
    return `Migration diagnostics: forced upload failed (${result.reason}).`;
  }
  const uploads = result.uploadResults ?? [];
  if (uploads.length === 0) {
    return `Migration diagnostics: queued correlation ${result.correlationId}; no immediate upload result.`;
  }
  const attempted = uploads.reduce((sum, item) => sum + item.attempted, 0);
  const uploaded = uploads.reduce((sum, item) => sum + item.uploaded, 0);
  const failed = uploads.filter((item) => item.status === "failed").length;
  return `Migration diagnostics: forced upload ${uploaded}/${attempted} uploaded for correlation ${result.correlationId}${failed > 0 ? ` (${failed} failed)` : ""}.`;
}

function comparableServerUrl(serverUrl: string): string {
  return migrateKnownServerUrl(serverUrl).trim().replace(/\/+$/, "");
}

function assertAttachmentMatchesExplicitServerUrl(
  attachment: { serverUrl: string },
  explicitServerUrl: string | undefined,
  label: string,
): void {
  if (!explicitServerUrl) return;
  const existing = comparableServerUrl(attachment.serverUrl);
  const requested = comparableServerUrl(explicitServerUrl);
  if (existing === requested) return;
  throw new ComputerError(
    "SETUP_ATTACHMENT_SERVER_URL_MISMATCH",
    `Refusing to reuse existing local attachment for ${label}: it points to ${existing}, but this setup command explicitly targets ${requested}. Run \`raft-computer setup ${label}\` with the matching server URL, or use an isolated RAFT_HOME for a separate environment.`,
  );
}

async function forceMigrationDiagnostics(
  slockHome: string,
  diagnosticsPushImpl: typeof diagnosticsPushService,
  emit: (line: string) => void,
  migrationAttemptId: string,
  options: { emitFailure?: boolean } = {},
): Promise<void> {
  try {
    const result = await diagnosticsPushImpl(
      { slockHome },
      {
        forceUploadNow: true,
        includeComputerTraceRecords: true,
        migrationAttemptId,
        trigger: "migration",
      },
    );
    if (options.emitFailure === false && result.status === "failed") return;
    emit(formatMigrationDiagnosticsResult(result));
  } catch (err) {
    if (options.emitFailure === false) return;
    const errorClass = err instanceof Error ? err.name : "Error";
    emit(`Migration diagnostics: forced upload failed (${errorClass}).`);
  }
}

async function forceMigrationDiagnosticsQuietly(
  slockHome: string,
  diagnosticsPushImpl: typeof diagnosticsPushService,
  emit: (line: string) => void,
  migrationAttemptId: string,
): Promise<void> {
  await forceMigrationDiagnostics(slockHome, diagnosticsPushImpl, emit, migrationAttemptId, { emitFailure: false });
}


function mentionsComputerMachineUnlinked(err: unknown): boolean {
  return err instanceof Error && /computer_machine_unlinked/i.test(err.message);
}

async function isComputerMachineUnlinkedStartFailure(
  err: unknown,
  slockHome: string,
  attachment: { serverId: string; serverMachineId: string } | null,
): Promise<boolean> {
  if (err instanceof ComputerServiceError || err instanceof ComputerError) {
    if (err.code === "COMPUTER_MACHINE_UNLINKED") return true;
    if (err.code === "START_DAEMON_TIMEOUT" && mentionsComputerMachineUnlinked(err)) return true;
  }
  if (err instanceof CliExit) {
    if (err.code === "COMPUTER_MACHINE_UNLINKED") return true;
    if (err.code === "START_DAEMON_TIMEOUT" && attachment) {
      return Boolean(await readTerminalUnlinked(slockHome, attachment.serverId, attachment.serverMachineId));
    }
  }
  return false;
}

async function archiveUnlinkedRunnerState(
  slockHome: string,
  serverId: string,
): Promise<string> {
  const src = serverAttachmentPath(slockHome, serverId);
  const stamp = formatUpgradeLogTimestamp();
  const dest = `${src}.unlinked-${stamp}-${randomUUID().slice(0, 8)}.bak`;
  await mkdir(dirname(dest), { recursive: true });
  await rename(src, dest);
  return dest;
}

async function startFromSetup(
  slockHome: string,
  attachment: { serverId: string },
  opts: SetupOptions,
  deps: SetupDeps,
  options: { preferService?: boolean } = {},
): Promise<void> {
  try {
    if (options.preferService !== true && deps.runStart) {
      await deps.runStart({
        serverId: attachment.serverId,
        serverLabel: opts.serverSlug,
        foreground: opts.foreground, hostLifecycleOwner: "cli",
      });
      return;
    }
    await (deps.startService ?? startService)(
      {
        slockHome,
        serverId: attachment.serverId,
        serverLabel: opts.serverSlug,
        foreground: opts.foreground, hostLifecycleOwner: "cli",
      },
      deps.startDeps,
    );
  } catch (err) {
    if (err instanceof ComputerServiceError) {
      throw new ComputerError(err.code, err.message);
    }
    throw err;
  }
}

async function attachFromSetup(
  slockHome: string,
  opts: SetupOptions,
  deps: SetupDeps,
): Promise<void> {
  if (deps.runAttach) {
    await deps.runAttach({
      serverSlug: opts.serverSlug,
      serverUrl: opts.serverUrl,
      name: opts.name,
      start: false,
      orchestrated: true,
    });
    return;
  }
  try {
    await (deps.attachService ?? attachService)({
      slockHome,
      serverSlug: opts.serverSlug,
      ...(opts.serverUrl ? { serverUrl: opts.serverUrl } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    });
  } catch (err) {
    if (err instanceof ComputerServiceError) {
      throw new ComputerError(err.code, err.message);
    }
    throw err;
  }
}

function emitSetupRunningSummary(emit: (line: string) => void, opts: SetupOptions): void {
  emit("Raft Computer is running. Agents can now use this computer.");
  emit(`Next: chat with your agents at ${appServerUrl(opts.serverSlug)}`);
  emit("(check this computer anytime with `raft-computer status`)");
}

async function restartFromSetup(
  slockHome: string,
  attachment: { serverId: string },
  opts: SetupOptions,
  deps: SetupDeps,
): Promise<void> {
  try {
    if (deps.runStop) {
      await deps.runStop({ ...deps.stopDeps, hostLifecycleOwner: "cli" });
    } else {
      await (deps.stopService ?? stopService)({ slockHome, hostLifecycleOwner: "cli" }, deps.stopDeps);
    }
  } catch (err) {
    if (err instanceof ComputerServiceError) {
      throw new ComputerError(err.code, err.message);
    }
    throw err;
  }
  await startFromSetup(slockHome, attachment, opts, deps, { preferService: true });
}

/**
 * Pure setup orchestration (CLI-over-lib convergence). Drives
 * login → (detect + picker / --migrate-from?) → attach → start. It NEVER
 * writes to stdout directly: human lines go through the `emit` sink the
 * presenter supplies, and failures throw `ComputerError` (the presenter maps
 * them to the shared stderr error contract). Interactive bits are
 * dep-injected callbacks (`pickMigrationCandidate` = the prompt sink;
 * `runLogin`/`runAttach`/`runStart` = the sub-presenters, which own their own
 * output). The orchestration logic is byte-identical to the pre-convergence
 * `runSetup` body — only WHERE the lines/fails are produced moved.
 */
export async function setupCore(
  slockHome: string,
  opts: SetupOptions,
  deps: SetupDeps,
  onEvent: (event: ComputerApiEvent) => void,
  tracer: ComputerTracer = noopTracer,
): Promise<void> {
  // Setup emits pre-formatted human prose; wrap each line as a `log.line`
  // event so the unified `ComputerApiEvent` sink carries it byte-identical.
  const emit = (line: string): void => onEvent({ kind: "log.line", line });
  const isTty = deps.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const login = deps.runLogin ?? runLogin;
  const attach = deps.runAttach ?? runAttach;
  const refreshSession = deps.refreshUserSession ?? refreshUserSession;
  const detectMigration = deps.detectLegacyMigration ?? detectLegacyMigration;
  const buildRoster =
    deps.buildRosterClient ??
    ((baseUrl: string, accessToken: string) => new LegacyMachinesClient(baseUrl, accessToken));
  const buildServers =
    deps.buildServersClient ??
    ((baseUrl: string, accessToken: string) => new ServersClient(baseUrl, accessToken));
  const buildAccountUnavailableMessage =
    deps.buildAccountUnavailableMessage ?? accountUnavailableMessage;
  const pickCandidate = deps.pickMigrationCandidate ?? defaultPickMigrationCandidate;
  const pickZeroMatch = deps.pickZeroMatchMigration ?? defaultPickZeroMatchMigration;
  const pickRosterUnavailable = deps.pickRosterUnavailable ?? defaultPickRosterUnavailable;
  const adoptLegacyByFingerprint =
    deps.adoptLegacyByFingerprint ?? adoptLegacyByFingerprintService;
  const adoptLegacyByDaemonId =
    deps.adoptLegacyByDaemonId ?? adoptLegacyByDaemonIdService;
  const diagnosticsPush = deps.diagnosticsPush ?? diagnosticsPushService;

  if (!isTty && !opts.yes) {
    throw new ComputerError(
      "NON_INTERACTIVE_SETUP_REQUIRES_FLAGS",
      "Non-interactive setup requires --yes after you have confirmed the login/attach/start actions. Run `raft-computer login`, `raft-computer attach`, and `raft-computer start` separately for fully explicit automation.",
    );
  }

  // Normalize the server slug to the bare DB form (`/foo` and `foo` → `foo`)
  // ONCE at the entry boundary, so every downstream consumer sees the same
  // canonical slug: roster `list()`, `detectMigration`, the picker re-fetch,
  // `--migrate-from` validation, `attach`, and `resolveAttachedServerSlug`.
  // Without this, `setup /foo` sent `?serverSlug=/foo` to the legacy-machines
  // roster → 403 → `server-unavailable` → silent fresh attach instead of the
  // migration picker (Jianwei real-staging E2E). `attach` already
  // normalized via resolveTargetServerId; `setup`'s roster path did not.
  opts = { ...opts, serverSlug: normalizeServerSlug(opts.serverSlug) };
  const migrationAttemptId = randomUUID();

  const label = formatServerSlugDisplay(opts.serverSlug);

  if (!(await hasUnexpiredUserSessionShape(slockHome))) {
    if (await refreshSession(slockHome, opts.serverUrl)) {
      emit("Logging in… done (session refreshed).");
    } else {
      if (!isTty) {
        throw new ComputerError(
          "NON_INTERACTIVE_SETUP_REQUIRES_FLAGS",
          "No valid user session is available and setup is running non-interactively. Run `raft-computer login` in a terminal first, then re-run setup with --yes.",
        );
      }
      await login({ serverUrl: opts.serverUrl, orchestrated: true });
      emit("Logging in… done.");
    }
  } else {
    emit("Logging in… done (already logged in).");
  }

  const session = await readUserSessionAuth(slockHome);
  const baseUrl = resolveServerUrl(
    opts.serverUrl,
    session.serverUrl,
    resolveServerUrlEnv(),
  );
  const serversResult = await buildServers(baseUrl, session.accessToken).list();
  if (serversResult.status === "auth_required") {
    throw new ComputerError(
      "USER_SESSION_EXPIRED",
      "Your login session expired. Run `raft-computer login`, then retry setup.",
    );
  }
  if (serversResult.status !== "success") {
    throw new ComputerError(
      "SETUP_SERVER_LIST_FAILED",
      `Could not list your servers (${serversResult.code}). Check --server-url / network connectivity, then retry.`,
    );
  }
  const targetServer = serversResult.servers.find((server) => normalizeServerSlug(server.slug) === opts.serverSlug);
  if (!targetServer) {
    throw new ComputerError(
      "SETUP_SERVER_UNAVAILABLE_TO_ACCOUNT",
      buildAccountUnavailableMessage({
        serverLabel: label,
        serverSlug: opts.serverSlug,
        slockHome,
        identity: await readUserSessionIdentity(slockHome),
      }),
    );
  }

  let shouldPushMigrationDiagnosticsAfterStart = false;
  let migratedDuringSetup = false;
  let recoveredUnlinkedState = false;
  let pendingZeroMatchFreshDismissal: ZeroMatchDismissalIdentity | null = null;
  let attachment = await resolveAttachedServerSlug(slockHome, opts.serverSlug);
  setupAttachmentLoop: while (true) {
    shouldPushMigrationDiagnosticsAfterStart = false;
    migratedDuringSetup = false;
    pendingZeroMatchFreshDismissal = null;
    attachment = await resolveAttachedServerSlug(slockHome, opts.serverSlug);
    if (attachment) {
      assertAttachmentMatchesExplicitServerUrl(attachment, opts.serverUrl, label);
      if (typeof opts.machine === "string" && opts.machine.length > 0) {
        throw new ComputerError(
          "SETUP_MACHINE_ALREADY_ATTACHED",
          `Cannot use --machine for ${label}: this Computer already has a local attachment for the target server. Remove the existing attachment first if you intend to replace it.`,
        );
      }
      emit(`Attachment: already attached to ${label}.`);
    } else {
      if (targetServer.role !== "owner" && targetServer.role !== "admin") {
        throw new ComputerError(
          "SETUP_REQUIRES_ADMIN",
          setupRequiresAdminMessage(label),
        );
      }

    // §X.4 migration decision — RFC v9.9.
    //
    // Managed-only/no-local/--machine setup must not create a client or issue a roster request.
    let rosterClient: ReturnType<typeof buildRoster> | null = null;
    const getRosterClient = () => (rosterClient ??= buildRoster(baseUrl, session.accessToken));

    let migrated = false;

    if (typeof opts.machine === "string" && opts.machine.length > 0) {
      // Identity-carried entry (v2.3 §19): carry the web machine row id and
      // skip fingerprint matching. Server-side authority is `manageMachines`
      // plus target-Server row binding; caller ownership and local evidence are
      // not required, so wiped state and brand-new checkouts remain supported.
      const machineId = opts.machine.trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machineId)) {
        throw new ComputerError(
          "SETUP_MACHINE_INVALID",
          `--machine expects the machine id shown on the web Computers page (a UUID), got: ${machineId}. Open https://app.raft.build/s/${encodeURIComponent(opts.serverSlug)}/computers and copy the id from your computer's Migrate command.`,
        );
      }
      recordMigrationDecision(tracer, migrationAttemptId, {
        decision: "adopt",
        reason: "machine-flag",
      });
      try {
        await runRosterDaemonIdAdoption(
          opts,
          { daemonId: machineId, machineName: machineId, hostname: null, lastSeenAt: null, legacyKeyMigratedAt: null, hasFingerprint: false },
          adoptLegacyByDaemonId,
          emit,
          tracer,
          migrationAttemptId,
        );
      } catch (err) {
        await forceMigrationDiagnosticsQuietly(slockHome, diagnosticsPush, emit, migrationAttemptId);
        throw err;
      }
      migrated = true;
      migratedDuringSetup = true;
      shouldPushMigrationDiagnosticsAfterStart = true;
    } else {
      let adjudication: SetupAdjudication = { kind: "no_local_evidence" };
      discoveryLoop: while (true) {
        const discoverySpan = tracer.startSpan("computer.migration.discovery", {
          surface: "computer",
          kind: "internal",
          attrs: { migration_attempt_id: migrationAttemptId, mode: "setup" },
        });
        try {
          const detection = await detectMigration(slockHome, opts.serverSlug, getRosterClient);
          adjudication = normalizeMigrationDetection(detection);
          discoverySpan.end("ok", {
            attrs: migrationDiscoveryAttrs(adjudication),
          });
        } catch (err) {
          discoverySpan.end("error", { attrs: { error_code: "unexpected" } });
          throw err;
        }

        if (adjudication.kind !== "roster_unavailable" || !isTty || opts.fresh === true) {
          break discoveryLoop;
        }

        const selection = await pickRosterUnavailable(adjudication.localCount);
        if (selection.kind === "retry") {
          continue discoveryLoop;
        }
        if (selection.kind === "quit") {
          recordMigrationDecision(tracer, migrationAttemptId, {
            decision: "fail",
            reason: "roster-unavailable-quit",
            local_candidate_count: adjudication.localCount ?? -1,
          });
          throw new ComputerError(
            "MIGRATION_ROSTER_UNAVAILABLE",
            "Migration: legacy machine roster unavailable; setup stopped without changing local state.",
          );
        }
        recordMigrationDecision(tracer, migrationAttemptId, {
          decision: "fresh",
          reason: "roster-unavailable-picker-fresh",
          local_candidate_count: adjudication.localCount ?? -1,
        });
        emit("WARNING: Migration roster unavailable; fresh attach selected explicitly and may duplicate an existing legacy daemon.");
        break discoveryLoop;
      }

      if (adjudication.kind === "roster_unavailable") {
        // Trigger #4 — non-interactive best-effort detection remains allowed,
        // but it is now visible instead of silently creating fresh state.
        recordMigrationDecision(tracer, migrationAttemptId, {
          decision: "fresh",
          reason: opts.fresh === true ? "server-unavailable-explicit-fresh" : "server-unavailable",
          local_candidate_count: adjudication.localCount ?? -1,
        });
        emit(
          opts.fresh === true
            ? "WARNING: Migration roster unavailable; --fresh requested, falling back to fresh attach."
            : "WARNING: Migration: legacy machine roster unavailable (fresh trigger: server-unavailable); falling back to fresh attach.",
        );
      } else if (adjudication.kind === "no_local_evidence") {
        // Trigger #1 — no local legacy evidence. No prompt.
        recordMigrationDecision(tracer, migrationAttemptId, {
          decision: "fresh",
          reason: "empty-intersection",
          candidate_count: 0,
        });
      } else if (adjudication.kind === "zero_match") {
        const evidenceFromExcluded = (candidate: SetupExcludedCandidate): MigrationDismissalEvidence => ({
          effectiveFingerprint: candidate.effectiveFingerprint,
          ownerFingerprint: candidate.ownerFingerprint,
          dirFingerprint: candidate.dirFingerprint,
          localPath: candidate.localPath,
        });
        const dismissedKeys = await dismissedEvidenceKeys(slockHome, opts.serverSlug, baseUrl);
        const activeExcluded = adjudication.excluded.filter((candidate) => {
          const key = evidenceKey(evidenceFromExcluded(candidate));
          return key === null || !dismissedKeys.has(key);
        });
        if (activeExcluded.length === 0) {
          recordMigrationDecision(tracer, migrationAttemptId, {
            decision: "fresh",
            reason: "zero-match-dismissed-fresh",
            excluded_count: adjudication.excluded.length,
          });
        } else {
          const dismissalIdentity = zeroMatchDismissalIdentity(
            opts.serverSlug,
            baseUrl,
            activeExcluded.map(evidenceFromExcluded),
          );
          const suspiciousZeroMatch = isSuspiciousZeroMatch(activeExcluded);
          if (opts.verbose === true) {
            emitExcludedTable(
              emit,
              activeExcluded,
              "Migration: local legacy daemon evidence was found, but no daemon automatically matches this server.",
            );
          } else if (!suspiciousZeroMatch || opts.fresh === true) {
            emitZeroMatchSummary(emit, activeExcluded, label);
          }
          if (opts.fresh === true) {
            recordMigrationDecision(tracer, migrationAttemptId, {
              decision: "fresh",
              reason: "zero-match-explicit-fresh",
              excluded_count: activeExcluded.length,
            });
            emit("WARNING: --fresh requested after zero-match evidence; creating a new Computer connection may duplicate an existing legacy daemon.");
            pendingZeroMatchFreshDismissal = dismissalIdentity;
          } else if (!isTty) {
            recordMigrationDecision(tracer, migrationAttemptId, {
              decision: "fail",
              reason: "zero-match-non-tty",
              excluded_count: activeExcluded.length,
            });
            await forceMigrationDiagnosticsQuietly(slockHome, diagnosticsPush, emit, migrationAttemptId);
            throw new ComputerError(
              "MIGRATION_LOCAL_EVIDENCE_UNMATCHED",
              zeroMatchErrorMessage(activeExcluded),
            );
          } else if (suspiciousZeroMatch) {
            recordMigrationDecision(tracer, migrationAttemptId, {
              decision: "fail",
              reason: "zero-match-suspicious",
              excluded_count: activeExcluded.length,
            });
            throw new ComputerError(
              "MIGRATION_LOCAL_EVIDENCE_UNMATCHED",
              `This computer has traces of a ${label} connection, but the server does not recognize any of them. Common causes: you are signed in as a different account than the one that set up this computer, the traces belong to a different server, the computer's connect command was regenerated on the web (which rotates its key), or the computer was removed on the server. Setting up a new computer now could leave your agents stranded.`,
            );
          } else {
            let serverCandidates: LegacyMachineManualEntry[] = [];
            const activeRosterClient = getRosterClient();
            if (typeof activeRosterClient.listAll === "function") {
              const manualRoster: LegacyMachineManualRosterResult = await activeRosterClient.listAll(opts.serverSlug);
              if (manualRoster.status === "success") {
                serverCandidates = manualRoster.entries;
              } else if (manualRoster.status === "disabled" || manualRoster.status === "error") {
                emit("Migration: server-row manual adoption is unavailable on this server; choose fresh or quit.");
              } else {
                emit(`Migration: server-row manual adoption unavailable (${manualRoster.status}); choose fresh or quit.`);
              }
            }
            const selection = await pickZeroMatch(activeExcluded, serverCandidates);
            if (selection.kind === "quit") {
              recordMigrationDecision(tracer, migrationAttemptId, {
                decision: "fail",
                reason: "zero-match-quit",
                excluded_count: activeExcluded.length,
              });
              emit(`Nothing was changed. Run raft-computer setup ${label} when ready.`);
              throw new ComputerError(
                "MIGRATION_LOCAL_EVIDENCE_UNMATCHED",
                "Migration: setup stopped after unmatched local legacy evidence.",
              );
            }
            if (selection.kind === "server-candidate") {
              const candidate = serverCandidates[selection.index];
              if (!candidate) {
                throw new ComputerError(
                  "MIGRATE_PICKER_OUT_OF_RANGE",
                  `Picker returned server candidate index ${selection.index} but only ${serverCandidates.length} candidate(s) were listed.`,
                );
              }
              recordMigrationDecision(tracer, migrationAttemptId, {
                decision: "adopt",
                reason: "server-row-picker",
                candidate_already_migrated: Boolean(candidate.legacyKeyMigratedAt),
              });
              try {
                await runRosterDaemonIdAdoption(opts, candidate, adoptLegacyByDaemonId, emit, tracer, migrationAttemptId);
              } catch (err) {
                await forceMigrationDiagnosticsQuietly(slockHome, diagnosticsPush, emit, migrationAttemptId);
                throw err;
              }
              migrated = true;
              migratedDuringSetup = true;
              shouldPushMigrationDiagnosticsAfterStart = true;
            } else {
              recordMigrationDecision(tracer, migrationAttemptId, {
                decision: "fresh",
                reason: "zero-match-picker-fresh",
                excluded_count: activeExcluded.length,
              });
              emit("Migration: fresh attach selected after unmatched local legacy evidence.");
              await forceMigrationDiagnosticsQuietly(slockHome, diagnosticsPush, emit, migrationAttemptId);
            }
          }
        }
      } else if (!isTty) {
        recordMigrationDecision(tracer, migrationAttemptId, {
          decision: "fail",
          reason: "non-tty-candidates",
          candidate_count: adjudication.candidates.length,
        });
        await forceMigrationDiagnosticsQuietly(slockHome, diagnosticsPush, emit, migrationAttemptId);
        throw new ComputerError(
          "MIGRATION_CANDIDATE_REQUIRES_INTERACTIVE",
          `Migration: ${adjudication.candidates.length} legacy daemon(s) match this server but setup is non-interactive. Refusing to fresh attach because that would create a duplicate Computer identity. Re-run on a TTY to choose a legacy daemon, or pass --migrate-from <path> to adopt a specific install.`,
        );
      } else {
        if (adjudication.excluded.length > 0) {
          emitExcludedTable(
            emit,
            adjudication.excluded,
            "Migration: some local daemon evidence could not be auto-matched; matching candidates remain available below.",
          );
        }
        // §X.4 picker loop — RFC v9.9 (post-Jianwei FAIL `msg=ecc2e57e`
        // B2). Interactive `m` validation failures surface their token
        // then return to the picker so the operator can correct a typo
        // without losing the whole setup run. Only the `--migrate-from`
        // flag form (above) hard-fails on validation errors.
        pickerLoop: while (true) {
          const selection = await pickCandidate(adjudication.candidates, label);
          if (selection.kind === "candidate") {
            const candidate = adjudication.candidates[selection.index];
            if (!candidate) {
              // Defensive — picker promises 0..N-1 but we double-check at
              // the boundary so an out-of-range index can never index
              // into undefined and surface a misleading adoption error.
              throw new ComputerError(
                "MIGRATE_PICKER_OUT_OF_RANGE",
                `Picker returned candidate index ${selection.index} but only ${adjudication.candidates.length} candidate(s) were detected.`,
              );
            }
            recordMigrationDecision(tracer, migrationAttemptId, {
              decision: "adopt",
              reason: "picker",
              candidate_already_migrated: Boolean(candidate.legacyKeyMigratedAt),
            });
            try {
              await runRosterAdoption(opts, candidate, adoptLegacyByFingerprint, emit, tracer, migrationAttemptId);
            } catch (err) {
              await forceMigrationDiagnosticsQuietly(slockHome, diagnosticsPush, emit, migrationAttemptId);
              throw err;
            }
            migrated = true;
            migratedDuringSetup = true;
            shouldPushMigrationDiagnosticsAfterStart = true;
            break pickerLoop;
          } else if (selection.kind === "quit") {
            recordMigrationDecision(tracer, migrationAttemptId, {
              decision: "fail",
              reason: "picker-quit",
              candidate_count: adjudication.candidates.length,
            });
            emit(`Nothing was changed. Run raft-computer setup ${label} when ready.`);
            throw new ComputerError(
              "SETUP_CANCELED",
              "Setup stopped without changing local state.",
            );
          } else {
            // selection.kind === "fresh" — Trigger #2 (typed-new / eof).
            recordMigrationDecision(tracer, migrationAttemptId, {
              decision: "fresh",
              reason: "picker-fresh",
              candidate_count: adjudication.candidates.length,
            });
            emit("Migration: fresh attach selected.");
            await forceMigrationDiagnostics(slockHome, diagnosticsPush, emit, migrationAttemptId);
            break pickerLoop;
          }
        }
      }
    }

    if (!migrated) {
      await attachFromSetup(slockHome, opts, deps);
      emit(`Connecting this computer to ${label}… done.`);
    }

    attachment = await resolveAttachedServerSlug(slockHome, opts.serverSlug);
    if (!attachment) {
      throw new ComputerError(
        "SETUP_ATTACHMENT_MISSING",
        `Setup did not produce a local attachment for ${label}. Re-run \`raft-computer attach ${label}\`.`,
      );
    }
    await recordZeroMatchDismissal(slockHome, pendingZeroMatchFreshDismissal);
    }

  if (opts.start === false) {
    if (shouldPushMigrationDiagnosticsAfterStart) {
      await forceMigrationDiagnostics(slockHome, diagnosticsPush, emit, migrationAttemptId);
    }
    emit(`Start: skipped (--no-start). Run \`raft-computer start ${label}\` when ready.`);
    return;
  }

  try {
    await startFromSetup(slockHome, attachment, opts, deps);
  } catch (err) {
    if (
      !recoveredUnlinkedState &&
      !migratedDuringSetup &&
      await isComputerMachineUnlinkedStartFailure(err, slockHome, attachment)
    ) {
      const archivedPath = await archiveUnlinkedRunnerState(slockHome, attachment.serverId);
      recoveredUnlinkedState = true;
      emit(`Recovery: archived stale unlinked runner state to ${archivedPath}.`);
      emit("Recovery: returning to the existing Computer picker so you can reconnect the old local connection.");
      continue setupAttachmentLoop;
    }
    if (
      migratedDuringSetup &&
      await isComputerMachineUnlinkedStartFailure(err, slockHome, attachment)
    ) {
      emit("Recovery: adopted connection was written, but the running service still held the deleted runner in memory; restarting service to reload Computer state.");
      await restartFromSetup(slockHome, attachment, opts, deps);
      if (shouldPushMigrationDiagnosticsAfterStart) {
        await forceMigrationDiagnostics(slockHome, diagnosticsPush, emit, migrationAttemptId);
      }
      return;
    }
    if (shouldPushMigrationDiagnosticsAfterStart) {
      await forceMigrationDiagnostics(slockHome, diagnosticsPush, emit, migrationAttemptId);
    }
    throw err;
  }
  if (shouldPushMigrationDiagnosticsAfterStart) {
    await forceMigrationDiagnostics(slockHome, diagnosticsPush, emit, migrationAttemptId);
  }
  emitSetupRunningSummary(emit, opts);
  return;
  }
}

/**
 * `raft-computer setup <serverSlug>` — CLI presenter over the setup
 * orchestration (`setupCore`). Supplies the `emit` sink (→ `info()`) and the
 * dep-injected sub-presenters / picker prompt, and `present()` maps a thrown
 * `ComputerError` → the shared stderr error contract (+ `CliExit`).
 * The deps shape is preserved for the test harness.
 */
export async function runSetup(opts: SetupOptions, deps: SetupDeps = {}): Promise<void> {
  const slockHome = resolveRaftHome();
  const api = createComputerApi(slockHome, { tracer: createComputerTracer(slockHome, "computer.cli") });
  await present(async () => {
    await api.setup(opts, deps, (event) => {
      if (event.kind === "log.line") info(event.line);
    });
  });
}
