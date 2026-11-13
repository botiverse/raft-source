import { appendFileSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { errorCodeOf } from "@botiverse/raft-shared";
import type { CompletedTraceSpan, TraceAttributes, TraceEvent, TraceLogEvent, TraceSink } from "@botiverse/raft-shared";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILE_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FILES = 8;
// CLI span files (one per `raft` process that wrote a span: transport errors,
// `cli.draft.resolved`) are ~0.5 KB each, and the uploader drains at most ~19
// of them per 5-minute interval. Keeping only 8 dropped spans whenever more
// than 8 waited at a rotation (they are counts the telemetry reads); 64 keeps
// a few intervals of backlog for ~32 KB.
const DEFAULT_MAX_CLI_TRANSPORT_FILES = 64;
const DEFAULT_MAX_DIAG_FILES = 8;
const DEFAULT_MAX_OTHER_FILES = 8;

const TRACE_FILE_PREFIX = "daemon-trace-";
const CLI_TRANSPORT_FILE_PREFIX = "daemon-trace-cli-transport-";
const DIAG_FILE_PREFIX = "daemon-trace-diag-";

/** At most one warning per interval, so a failing disk cannot flood the log. */
const WRITE_FAILURE_WARN_INTERVAL_MS = 60 * 1000;

/**
 * Distinct dropped key NAMES retained. Names, never values — the value is the
 * reason the attribute was dropped in the first place. The cap exists because
 * a key name lands in telemetry and an unbounded set of them is a cardinality
 * problem; keys beyond it are counted in `droppedAttrNamesOverflow`, so a full
 * table degrades the NAME list to a sample while the TOTALS stay exact.
 */
const MAX_TRACKED_DROPPED_ATTR_NAMES = 32;

/**
 * Pruned filenames retained for the uploader to check against its receipts.
 *
 * The sink never asks whether a file was uploaded — it has no way to resolve
 * the third state ("not yet"), and a deletion decision must not depend on the
 * uploader's progress. It records the one thing it knows for certain, that it
 * deleted these names, and the side holding the receipts does the judging
 * (@Manjusaka).
 *
 * The cap is the resolution limit of that count: past it the excess is counted
 * but unnamed, so `prunedWithoutReceipt` degrades to a LOWER BOUND rather than
 * silently under-reporting. Say so wherever the number is read (@Leiysky).
 */
const MAX_TRACKED_PRUNED_NAMES = 128;

/**
 * Salt for the machine-scoped session hash.
 *
 * Deliberately OUTSIDE `machineDir/traces`. That directory is uploaded whole
 * (`traceBundleUpload`), and the feedback/evidence collectors read from it too.
 * All three select by the `daemon-trace-*.jsonl` shape rather than excluding
 * known-bad names, so a file here is out of reach by construction rather than
 * by a rule someone has to remember to update (@Stone, @Leiysky, task #422).
 *
 * Once the salt escapes, the hash is enumerable again and the whole exercise
 * was pointless — so this location is load-bearing, not tidiness.
 */
const SESSION_SALT_DIR = "secrets";
const SESSION_SALT_FILE = "trace-session-salt";
const SESSION_HASH_HEX_LENGTH = 12;

/**
 * How long to wait before looking for the salt again after failing to get one.
 *
 * A permanent `null` would be a trap: one process that loses the create race at
 * the wrong instant, or one crash that leaves a half-written file, would stop
 * that process — or every process on the machine — from ever hashing again.
 * Retrying bounds the damage to a window instead of a lifetime (@Stone).
 */
const SESSION_SALT_RETRY_MS = 60_000;

/** Keys that carry a runtime session identifier, in either naming convention. */
const SESSION_ID_KEYS: ReadonlySet<string> = new Set(["session_id", "sessionId"]);

/**
 * Producer presence flags this sink removes, because what they claim is not
 * true of the record it writes.
 *
 * @Leiysky's rule for membership (#422 item 3). The test is NOT whether a key
 * ends in `_present` — it is WHAT THE FLAG CLAIMS:
 *
 *   A. "this value is on this record", and it is not => FALSE. Remove it, or
 *      replace it with a claim this side can stand behind.
 *   B. "the source had this value" => that is true even when the value never
 *      reaches disk, so the flag MAY STAY, on two conditions: (i) the comment
 *      says it is a source-side fact, not a disk-side one; and (ii) no
 *      similarly-named value travels with it, or a reader goes looking for
 *      something that is not there.
 *   C. the value is on the same record => merely REDUNDANT. May stay, but say
 *      so, or a later reader takes it for an independent piece of evidence.
 *
 * Class A, and therefore in this set:
 *
 *   `session_id_present` — superseded by `session_id_hash_present`, which this
 *   sink writes from what it actually did.
 *
 *   `producer_fact_id_present` — the value is scrubbed by the #460 ruling. The
 *   fact id is also generated on every event, so the flag is constant and
 *   carries no information even before the scrub.
 *
 * Class B, and therefore deliberately NOT in this set:
 *
 *   `runtime_session_id_present` (`daemon/src/drivers/piToolExecutionObservability.ts`)
 *   says a pi tool had a session when it got stuck. That is a source-side fact
 *   and, unlike `session_id`, it has NO OTHER CARRIER: `runtime_session_id` is
 *   neither written nor hashed. It is also pinned by the `stuck_tool_v0`
 *   identity contract (`core.ts`). The reason it is treated differently from
 *   `session_id_present` is not the name — it is that `session_id` has a hash
 *   form able to carry the fact and `runtime_session_id` does not.
 *
 *   If `runtime_session_id` is ever hashed, this flag moves from B to A and
 *   must be replaced by that value. It would need ITS OWN key,
 *   `runtime_session_id_hash`. Do NOT add it to `SESSION_ID_KEYS`: every key in
 *   that set is written out as the SAME `session_id_hash`, so a second one
 *   overwrites the real session's hash and yields a value that joins
 *   successfully to the wrong session — worse than a missing one, because the
 *   reader gets an answer (@Stone).
 *
 * Class C is why the server's own `producer_fact_id_present`
 * (`agentOrchestrator.ts`) is absent here: that span carries the raw
 * `producer_fact_id` beside the flag, and it is a surface this sink cannot
 * reach anyway. `client_seq_present` is the in-test control for the boundary.
 *
 * Removals here do NOT go through `onDrop`: this is a planned replacement, not
 * an unexpected drop, so it would inflate the counter that exists to find the
 * unexpected ones (@Stone).
 */
const PRODUCER_PRESENCE_FLAGS_SUPERSEDED_BY_SINK: ReadonlySet<string> = new Set([
  "session_id_present",
  "sessionIdPresent",
  "producer_fact_id_present",
  "producerFactIdPresent",
]);

/**
 * Delegates to the shared bounded classifier (task #421).
 *
 * This used to be a private allowlist here. Two allowlists for the same concept
 * drift: the local one only read `err.code`, which is empty for every `fetch`
 * failure — the code lives on `err.cause` — so the shared version walks the
 * cause chain. `"none"` keeps the by-code map keyed on strings when an error
 * carries no code at all, which is distinct from a code we do not recognise
 * (`"other"`).
 */
function reportedErrorCode(error: unknown): string {
  return errorCodeOf(error) ?? "none";
}

/**
 * What the failed write left behind. Closed set — reported as a trace attribute.
 *
 * The distinction that matters to a reader is whether the damaged line was
 * cleaned up, and how: `append_partial_truncated` means the fragment was
 * removed, `append_partial_rotated` means it was left alone at the end of a
 * file we stopped writing to. Both keep the fragment from merging with the next
 * good record; only the first loses nothing else.
 */
export type TraceWriteFailureOutcome =
  | "serialize_failed"
  | "ensure_failed"
  | "append_no_bytes"
  | "append_complete"
  | "append_partial_truncated"
  | "append_partial_rotated";

const TRACE_WRITE_FAILURE_OUTCOMES: readonly TraceWriteFailureOutcome[] = [
  "serialize_failed", "ensure_failed", "append_no_bytes",
  "append_complete", "append_partial_truncated", "append_partial_rotated",
];

export interface TraceWriteFailureStats {
  readonly total: number;
  readonly byOutcome: Readonly<Record<TraceWriteFailureOutcome, number>>;
  readonly byCode: Readonly<Record<string, number>>;
  readonly lastOutcome: TraceWriteFailureOutcome | null;
  readonly lastCode: string | null;
  /** Partial records removed so the file still parses. */
  readonly rollbacks: number;
  /** Files abandoned because the fragment could not be removed safely. */
  readonly rotations: number;
  /**
   * Retention failures, counted separately from write failures: the record
   * still landed, only the old files could not be reclaimed.
   */
  readonly pruneFailures: number;
  readonly lastPruneCode: string | null;
  /** Attributes removed by the sanitizer, by reason. Exact. */
  readonly droppedAttrsByReason: Readonly<Record<AttrDropReason, number>>;
  /**
   * Key names dropped as `id_not_allowlisted` only — the actionable reason.
   * Bounded by MAX_TRACKED_DROPPED_ATTR_NAMES; a sample once that is exceeded.
   */
  readonly droppedAttrNames: Readonly<Record<string, number>>;
  readonly droppedAttrNamesOverflow: number;
}

/**
 * Injectable fs surface. Only the calls a test needs to fault-inject are here;
 * a partial write followed by a throw cannot be provoked with a real disk.
 */
export interface TraceSinkFsOps {
  appendFileSync: typeof appendFileSync;
  writeFileSync: typeof writeFileSync;
  statSync: typeof statSync;
  truncateSync: typeof truncateSync;
  readdirSync: typeof readdirSync;
  rmSync: typeof rmSync;
}

const DEFAULT_FS_OPS: TraceSinkFsOps = { appendFileSync, writeFileSync, statSync, truncateSync, readdirSync, rmSync };

/**
 * Families sharing the `daemon-trace-` prefix but NOT the rotation lifecycle.
 *
 * They are written by other producers entirely — `packages/cli/src/transportTrace.ts`
 * (one file per CLI process that writes a span: a transport error, or a held
 * draft resolved as `cli.draft.resolved`) and the diagnostics push
 * path (one file per correlation id) — and neither producer prunes. Before this
 * split, `pruneOldFiles` matched them with the shared prefix and ordered every
 * candidate lexicographically, which is why they mattered:
 *
 *   'daemon-trace-2…' < 'daemon-trace-cli-transport-…' < 'daemon-trace-diag-…'
 *
 * Rotating names begin with a digit, so they sorted FIRST and were therefore
 * always the deletion victims, while the non-rotating families were reached only
 * once every rotating file was already gone. With N non-rotating files present
 * the surviving rotating count was `max(0, maxFiles - N)`, so N >= maxFiles left
 * zero, and N >= maxFiles - 1 left only the in-progress file. The uploader skips
 * the file currently being written, so such a registration produced no
 * upload-eligible trace at all — permanently, since nothing reduces N.
 *
 * Budgets are therefore per family. A family that is not the rotating one can no
 * longer consume rotating slots, and every family still has an owner that
 * reclaims it. Do NOT collapse these back into one budget, and do NOT fix a
 * future recurrence by excluding a family from the glob: this prune is that
 * family's only deletion path, so excluding it trades starvation for unbounded
 * growth.
 *
 * KNOWN BOUNDARY: these budgets bound the file COUNT of a non-rotating family,
 * never its BYTES. Only the rotating family has a byte ceiling
 * (`maxFileBytes`); the others have none at any size.
 *
 * Today that is tolerable on measured magnitude alone — @Kabi and @Manjusaka
 * read two hosts on 2026-09-17 and found the largest such file at 582 B, with 22
 * files totalling 12.7 KB. Take that as a reading of current USAGE and nothing
 * more (@Manjusaka's own framing, correcting an earlier draft of this comment
 * that cited them for a structural guarantee they had not claimed).
 *
 * It is NOT a design guarantee, and specifically these producers do not "write
 * once": `packages/cli/src/transportTrace.ts` memoises one path per process and
 * appends on every span it emits, so one long-lived or error-looping process
 * grows a single file without bound. The files are small because CLI processes
 * are short and usually write one span (fail once, or resolve one held draft) —
 * a usage pattern, not an invariant. A byte budget per family is the real fix
 * whenever that pattern stops holding. Held-draft spans also make the file
 * COUNT follow held sends, not only transport errors: past the family budget,
 * prune deletes files whether or not they were uploaded.
 *
 * Recorded here rather than only in review because the change that would break
 * it gets made in the producer, where this constraint is invisible.
 */
type TraceFileFamily = "rotating" | "cli-transport" | "diag" | "other";

export function traceFileFamily(name: string): TraceFileFamily {
  if (name.startsWith(CLI_TRANSPORT_FILE_PREFIX)) return "cli-transport";
  if (name.startsWith(DIAG_FILE_PREFIX)) return "diag";
  // Rotating files are `daemon-trace-<ISO timestamp>-<pid>-<seq>.jsonl`, so the
  // first character after the shared prefix is a digit for this family alone.
  // Anything else is an unrecognised producer and gets its own budget rather
  // than defaulting into the rotating one — an unknown future family must not be
  // able to starve rotation the way these two did.
  if (/^daemon-trace-\d/.test(name)) return "rotating";
  return "other";
}
// Contract v0 permits only schema-owned raw IDs; other IDs need explicit review.
const DIAGNOSTIC_ID_ATTRS = new Set([
  "serverId",
  "machineId",
  "agentId",
  "messageId",
  "launchId",
  "uploadId",
  "bundleId",
  "deliveryId",
  "deliveryCorrelationId",
  "delivery_correlation_id",
  "agent_id",
  "server_id",
  "machine_id",
  "process_instance_id",
  "launch_id",
  "correlation_id",
  "migration_attempt_id",
  "operation_id",
  // Added by the per-key determination on task #422 (@Leiysky, corrected by
  // @Stone on two of them). Each is an opaque identifier this side generates or
  // receives, carrying no user content:
  //   start_dispatch_id          server-minted, same class as launch_id
  //   runtime_turn_id            daemon-generated randomUUID; identifies a TURN,
  //                              not a session — it was first grouped with the
  //                              session family on name similarity alone
  //   tool_execution_instance_id daemon-generated, scopes one execution
  //   request_id                 the single spelling kept; `requestId` is dropped
  "start_dispatch_id",
  "runtime_turn_id",
  "tool_execution_instance_id",
  "request_id",
  // Task #424 (@Leiysky). Both are daemon/server-minted and neither carries user
  // content. The decisive reason is not "it is one of our ids" but that
  // launchPhaseTransition.ts documents `(agent_launch_id, state_instance_id)` as
  // the enter/close PAIRING KEY — dropping either makes that pairing impossible
  // to reconstruct on disk, which is the whole purpose of those spans.
  // `state_instance_id` is `randomUUID()` (agentNoProcessResidency.ts).
  "agent_launch_id",
  "state_instance_id",
  // Task #424, the app family (12 spans: daemon.app_config.* / app_inbox.* /
  // app_source.* / app_schedule.* / agent.app_inbox_notice). Values are minted
  // in shared/src/appRuntimeTrace.ts. @Leiysky ruled each one; the wording
  // below is deliberately his, because the tempting shorter version is wrong:
  //
  //   owner_agent_id     minted by us, same value class as the allowed agent_id.
  //   app_id             minted by us or by the injecting package, and `mint`
  //                      fails closed on it. NOT "it is a closed set" — the
  //                      registry is injected and a future package can extend it.
  //   source_id          ALLOWED PER APP. Each app's normalizer must constrain
  //   item_id            its id. The registry today holds exactly two apps:
  //                      `system.reminder` (id must be a UUID) and
  //                      `system.cleaner` (its sourceRef has no `id` at all), so
  //                      these keys are only OBSERVED on those two branches.
  //                      ⛔ Do not restate this as "the value space is
  //                      controlled" — it is not; it is unconstrained at the
  //                      type layer (z.string().trim().min(1)).
  //   app_correlation_id FOLLOWS ITS HOST. It interpolates sourceRef.id into its
  //                      own value, so it is a wrapper around source_id, not an
  //                      independent identifier, and must share source_id's fate
  //                      on the same branch.
  //
  // `registryManifestApps.test.ts` pins the registry to those two apps, so
  // adding a third trips a test and forces this list to be revisited.
  "owner_agent_id",
  "app_id",
  "source_id",
  "item_id",
  "app_correlation_id",
  // 2026-10-21, ruled by @Tenny (#wg-ax:d98f2a2c, PR #10675): the RFC 072
  // model context id on `daemon.runtime.turn` (glimpse layer 2). Daemon-minted
  // randomUUID, replaced at spawn, compaction and session rebind; it names no
  // user, channel or message and carries no content. Spelled `model_context_id`
  // on purpose: the bare `context_id` on `daemon.agent.server_context.*`
  // events holds a server-context message id and stays dropped.
  "model_context_id",
]);

/**
 * Task #424, class (b): NOT identifiers, but closed enumerable non-content
 * values that the id rule would otherwise drop for ending in `_id`.
 *
 * @Leiysky's admission test is "closed + enumerable + non-content", NOT "useful".
 * A free-text field from a provider does not qualify however useful it is. And
 * @Stone's operable form of it: a RUNTIME GUARD must exist (or be added) —
 * "closed set" is an assertion, "a guard exists" is a checkable fact, true at
 * every assignment rather than at one declaration.
 *
 * `provider_id` — every route is closed and guarded: preset =>
 *   BuiltInRuntimeProviderId, gateway => BuiltInRuntimeGatewayProviderId,
 *   and the connection fallback => ProviderConnectionProviderId, guarded at
 *   runtime by `isProviderConnectionProviderId` (shared/providerConnections.ts).
 * `model_id`   — written only when `model.kind === "preset"`, and builtin+preset
 *   additionally passes `isBuiltInProviderModel`.
 *
 * Why they must stay: these ride `daemon.builtin.session.*`, whose whole job is
 * to answer "which provider/model failed to resolve". `runtime` only says "pi",
 * and pi is multi-provider, so dropping them removes the question the events
 * exist for (@Stone, overturning the first proposal to delete them).
 */
const CLOSED_SET_NON_ID_ATTRS: ReadonlySet<string> = new Set([
  "provider_id",
  "model_id",
]);

const DIAGNOSTIC_ERROR_ATTRS = new Set([
  "runtime_error_class",
  "runtime_error_fingerprint",
  "runtime_error_http_status",
  "runtime_error_message_present",
  "runtime_error_message_length_bucket",
  "runtime_error_message_truncated",
  "runtime_error_message_excerpt",
  "original_message",
]);

export interface LocalRotatingTraceSinkOptions {
  machineDir: string;
  maxFileBytes?: number;
  maxFileAgeMs?: number;
  /**
   * Stable per-machine jitter added to `maxFileAgeMs`. Keeps the age-rotation
   * tick out of phase across daemons so a synchronized restart does not pin
   * every machine to the same 5-minute rotation boundary. Applied once at
   * construction time (deterministic — same machine always gets the same
   * effective age). See `traceJitter.ts`.
   */
  maxFileAgeJitterMs?: number;
  /** Budget for rotating trace files, counting the one being written. */
  maxFiles?: number;
  /** Budget for `daemon-trace-cli-transport-*` files, written by the CLI. */
  maxCliTransportFiles?: number;
  /** Budget for `daemon-trace-diag-*` files, written by diagnostics push. */
  maxDiagFiles?: number;
  /** Budget for any other `daemon-trace-*` producer we do not recognise. */
  maxOtherFiles?: number;
  nowMsProvider?: () => number;
  /** Test seam for fault injection; defaults to node:fs. */
  fsOps?: Partial<TraceSinkFsOps>;
}

export class LocalRotatingTraceSink implements TraceSink {
  private readonly machineDir: string;
  private readonly traceDir: string;
  private readonly maxFileBytes: number;
  private readonly maxFileAgeMs: number;
  private readonly maxFiles: number;
  private readonly maxCliTransportFiles: number;
  private readonly maxDiagFiles: number;
  private readonly maxOtherFiles: number;
  private readonly nowMsProvider: () => number;
  private currentFile: string | null = null;
  private currentFileOpenedAtMs: number | null = null;
  private currentSize = 0;
  private sequence = 0;
  private readonly fs: TraceSinkFsOps;
  private lastWarnAtMs: number | null = null;
  private pruneFailures = 0;
  private readonly droppedAttrsByReason: Record<AttrDropReason, number> =
    Object.fromEntries(ATTR_DROP_REASONS.map((r) => [r, 0])) as Record<AttrDropReason, number>;
  private readonly droppedAttrNames = new Map<string, number>();
  private droppedAttrNamesOverflow = 0;
  private readonly windowDroppedByReason: Record<AttrDropReason, number> =
    Object.fromEntries(ATTR_DROP_REASONS.map((r) => [r, 0])) as Record<AttrDropReason, number>;
  private windowNamesFull = false;
  private attrDropReportsUndelivered = 0;
  private readonly prunedNames: string[] = [];
  private prunedNamesOverflow = 0;
  private prunedTotal = 0;
  /** `undefined` = not looked for yet; `null` = looked and unavailable. */
  private sessionSalt: Buffer | null = null;
  /** When to look again after a failure; null means "look now". */
  private sessionSaltRetryAtMs: number | null = null;
  private readonly sanitizeHooks: SanitizeHooks = {
    onDrop: (key, reason) => this.noteDroppedAttr(key, reason),
    sessionIdHash: (value) => this.sessionIdHash(value),
  };
  private lastPruneCode: string | null = null;
  private readonly writeFailures = {
    total: 0,
    byOutcome: Object.fromEntries(TRACE_WRITE_FAILURE_OUTCOMES.map((o) => [o, 0])) as Record<TraceWriteFailureOutcome, number>,
    byCode: {} as Record<string, number>,
    lastOutcome: null as TraceWriteFailureOutcome | null,
    lastCode: null as string | null,
  };

  constructor(options: LocalRotatingTraceSinkOptions) {
    this.machineDir = options.machineDir;
    this.traceDir = path.join(options.machineDir, "traces");
    this.maxFileBytes = Math.max(1024, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
    const baseAgeMs = Math.max(1000, Math.floor(options.maxFileAgeMs ?? DEFAULT_MAX_FILE_AGE_MS));
    const ageJitterMs = Math.max(0, Math.floor(options.maxFileAgeJitterMs ?? 0));
    this.maxFileAgeMs = baseAgeMs + ageJitterMs;
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
    this.maxCliTransportFiles = Math.max(1, Math.floor(options.maxCliTransportFiles ?? DEFAULT_MAX_CLI_TRANSPORT_FILES));
    this.maxDiagFiles = Math.max(1, Math.floor(options.maxDiagFiles ?? DEFAULT_MAX_DIAG_FILES));
    this.maxOtherFiles = Math.max(1, Math.floor(options.maxOtherFiles ?? DEFAULT_MAX_OTHER_FILES));
    this.nowMsProvider = options.nowMsProvider ?? Date.now;
    this.fs = { ...DEFAULT_FS_OPS, ...options.fsOps };
  }

  /** Exposed for observability — the effective rotation age after jitter. */
  getMaxFileAgeMs(): number {
    return this.maxFileAgeMs;
  }

  record(span: CompletedTraceSpan): void {
    this.writeLine(toLocalTraceRecord(span, this.sanitizeHooks));
  }

  recordLogEvent(event: TraceLogEvent): void {
    this.writeLine(toLocalEventRecord(event, this.sanitizeHooks));
  }

  private writeLine(record: Record<string, unknown>): void {
    let line: string;
    let bytes: number;
    try {
      line = `${JSON.stringify(record)}\n`;
      bytes = Buffer.byteLength(line);
    } catch (err) {
      this.noteWriteFailure("serialize_failed", err);
      return;
    }

    // `ensureFile` is deliberately OUTSIDE the append's try, and its failure
    // never reaches the repair path. It assigns `currentFile` to the new path
    // BEFORE creating that file and BEFORE refreshing `currentSize`, so a throw
    // in there — ENOSPC while creating the next rotation file is the realistic
    // case — leaves `currentFile` pointing at the new file while `currentSize`
    // still describes the previous one. Truncating to `currentSize` there would
    // ftruncate a 0-byte file UP to the old length, and POSIX zero-fills an
    // extension: that injects a run of NUL bytes into a trace file, in
    // precisely the disk-full scenario this repair exists to survive.
    try {
      this.ensureFile(bytes);
    } catch (err) {
      // Drop the handle as well. `currentFile` already names a path that may
      // never have been created, and `!this.currentFile` would be false, so the
      // next write would skip rotation and let `appendFileSync` create that file
      // itself — with the default mode instead of 0o600, silently undoing the
      // "trace files are 0600" guarantee from #308 (@Stone).
      this.abandonCurrentFile();
      this.noteWriteFailure("ensure_failed", err);
      return;
    }

    const file = this.currentFile!;
    const sizeBeforeAppend = this.currentSize;
    try {
      this.fs.appendFileSync(file, line, { encoding: "utf8" });
      this.currentSize += bytes;
    } catch (err) {
      // Local tracing must never affect daemon/runtime behavior — but it must
      // no longer be silent about it either.
      this.noteWriteFailure(this.repairPartialAppend(file, sizeBeforeAppend, bytes), err);
    }
  }

  /**
   * Decide what the failed append left behind, and make the file safe again.
   *
   * Ingest rejects a bundle at its first unparseable line, so a fragment left
   * in place costs every span in the file, not just the one that failed.
   *
   * Removing the fragment is preferred, but it is only safe when we can prove
   * the excess bytes are ours: `ftruncate` past EOF zero-fills, and truncating
   * over a co-writer's records would delete them. When we cannot prove it — or
   * the truncate itself fails — we abandon the file instead. That still stops
   * the fragment merging with the next good record, which is what would happen
   * if we simply kept appending (no newline separates them). @Stone.
   */
  private repairPartialAppend(file: string, sizeBeforeAppend: number, attemptedBytes: number): TraceWriteFailureOutcome {
    let landed: number;
    try {
      landed = this.fs.statSync(file).size - sizeBeforeAppend;
    } catch {
      this.abandonCurrentFile();
      return "append_partial_rotated";
    }

    if (landed <= 0) return "append_no_bytes";
    if (landed === attemptedBytes) {
      // The record landed whole and the throw came after; the file still
      // parses. Keep the accounting honest — the success path never ran.
      this.currentSize = sizeBeforeAppend + landed;
      return "append_complete";
    }
    if (landed > attemptedBytes) {
      // More bytes than we attempted: another writer is appending here, so a
      // truncate would destroy its records.
      this.abandonCurrentFile();
      return "append_partial_rotated";
    }

    try {
      this.fs.truncateSync(file, sizeBeforeAppend);
      return "append_partial_truncated";
    } catch {
      this.abandonCurrentFile();
      return "append_partial_rotated";
    }
  }

  /**
   * Stop writing to the current file. The next write re-enters rotation, which
   * creates a fresh file with an explicit 0o600 mode.
   */
  private abandonCurrentFile(): void {
    this.currentFile = null;
    this.currentFileOpenedAtMs = null;
    this.currentSize = 0;
  }

  /**
   * Load the machine salt, creating it exactly once.
   *
   * `O_CREAT | O_EXCL` is the whole concurrency story: several writers share a
   * machineDir (the daemon and the CLI transport sink among them), and whoever
   * loses the race gets EEXIST and reads what the winner wrote. There is no
   * check-then-create window to lose.
   *
   * On ANY failure this returns null and the caller drops the field. It must
   * never fall back to the raw id, and never to an unhashed or unsalted digest:
   * a session id is low entropy, so an unsalted digest is a lookup table and is
   * strictly worse than writing nothing (@Leiysky).
   */
  private loadSessionSalt(): Buffer | null {
    if (this.sessionSalt) return this.sessionSalt;
    const nowMs = this.nowMsProvider();
    if (this.sessionSaltRetryAtMs !== null && nowMs < this.sessionSaltRetryAtMs) return null;

    const dir = path.join(this.machineDir, SESSION_SALT_DIR);
    const file = path.join(dir, SESSION_SALT_FILE);

    // Read first: after the first run this is the only branch that runs.
    const existing = this.readSessionSalt(file);
    if (existing) {
      this.sessionSalt = existing;
      this.sessionSaltRetryAtMs = null;
      return existing;
    }

    // Create via a complete temp file plus `link`, never by opening the target
    // and filling it in afterwards. `open(…,"wx")` publishes the final name
    // while it is still empty, so a racing reader — or a crash — leaves a
    // zero-length salt that every later reader treats as unusable. With `link`
    // the target appears only once it already has its content (@Stone).
    const tmp = path.join(dir, `.${SESSION_SALT_FILE}-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const salt = randomBytes(32);
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, salt.toString("hex"));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(tmp, file);
        this.sessionSalt = salt;
        this.sessionSaltRetryAtMs = null;
      } catch {
        // Someone else published first; theirs is authoritative.
        const winner = this.readSessionSalt(file);
        this.sessionSalt = winner;
        this.sessionSaltRetryAtMs = winner ? null : nowMs + SESSION_SALT_RETRY_MS;
      }
      return this.sessionSalt ?? null;
    } catch {
      this.sessionSaltRetryAtMs = nowMs + SESSION_SALT_RETRY_MS;
      return null;
    } finally {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  /** Returns the salt only if the file holds a complete one. */
  private readSessionSalt(file: string): Buffer | null {
    try {
      const salt = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
      return salt.length > 0 ? salt : null;
    } catch {
      return null;
    }
  }

  /**
   * Machine-scoped session reference, or null when the salt is unavailable.
   *
   * HMAC rather than a digest of `salt + id`: concatenation leaves an ambiguity
   * argument on the table that HMAC simply does not have (@Stone).
   */
  private sessionIdHash = (value: string): string | null => {
    const salt = this.loadSessionSalt();
    if (!salt) return null;
    return createHmac("sha256", salt).update(value).digest("hex").slice(0, SESSION_HASH_HEX_LENGTH);
  };

  /**
   * Record that the sanitizer removed an attribute. Never throws, and never
   * records the value: the value is why it was dropped.
   */
  /**
   * A file was deleted by prune. Recorded only on success: a victim that could
   * not be removed is still on disk and still uploadable, so counting it would
   * report a loss that did not happen.
   */
  private notePruned(name: string): void {
    this.prunedTotal += 1;
    if (this.prunedNames.length < MAX_TRACKED_PRUNED_NAMES) {
      this.prunedNames.push(name);
      return;
    }
    this.prunedNamesOverflow += 1;
  }

  private noteDroppedAttr = (key: string, reason: AttrDropReason): void => {
    this.droppedAttrsByReason[reason] += 1;
    this.windowDroppedByReason[reason] += 1;
    // Only the allowlist-miss reason needs a name to be actionable. The other
    // two are the filter working as designed, and their key names are the very
    // thing we do not want to accumulate.
    if (reason !== "id_not_allowlisted") return;
    const existing = this.droppedAttrNames.get(key);
    if (existing !== undefined) {
      this.droppedAttrNames.set(key, existing + 1);
      return;
    }
    if (this.droppedAttrNames.size >= MAX_TRACKED_DROPPED_ATTR_NAMES) {
      this.droppedAttrNamesOverflow += 1;
      this.windowNamesFull = true;
      return;
    }
    this.droppedAttrNames.set(key, 1);
  };

  private noteWriteFailure(outcome: TraceWriteFailureOutcome, err: unknown): void {
    const code = reportedErrorCode(err);
    this.writeFailures.total += 1;
    this.writeFailures.byOutcome[outcome] += 1;
    this.writeFailures.byCode[code] = (this.writeFailures.byCode[code] ?? 0) + 1;
    this.writeFailures.lastOutcome = outcome;
    this.writeFailures.lastCode = code;
    this.warnRateLimited(outcome, code);
  }

  private warnRateLimited(outcome: TraceWriteFailureOutcome, code: string): void {
    try {
      const nowMs = this.nowMsProvider();
      if (this.lastWarnAtMs !== null && nowMs - this.lastWarnAtMs < WRITE_FAILURE_WARN_INTERVAL_MS) return;
      this.lastWarnAtMs = nowMs;
      // No path in the message: the tracing contract fails paths closed.
      console.warn(
        `[LocalRotatingTraceSink] trace write failed (outcome=${outcome} code=${code} total=${this.writeFailures.total}); tracing continues`,
      );
    } catch {
      // Reporting a failure must not become one.
    }
  }

  /**
   * Take this window's attribute drops and start a new window.
   *
   * The name table is cleared here rather than aged by recency: the window
   * boundary is an event that already exists (a successful upload reading the
   * stats), so "which window was this name seen in" becomes a property of where
   * the reading sits, and no per-entry timestamp or ordering is needed
   * (@Stone). A name that filled the table in one window therefore cannot keep
   * a newly dropped key out of the next one.
   */
  drainAttrDropReport(): AttrDropReport {
    const report: AttrDropReport = {
      windowByReason: { ...this.windowDroppedByReason },
      windowNames: Object.fromEntries(this.droppedAttrNames),
      windowNamesFull: this.windowNamesFull,
      cumulativeByReason: { ...this.droppedAttrsByReason },
      reportsUndelivered: this.attrDropReportsUndelivered,
      prunedNames: [...this.prunedNames],
      prunedNamesOverflow: this.prunedNamesOverflow,
      prunedTotal: this.prunedTotal,
    };
    for (const reason of ATTR_DROP_REASONS) this.windowDroppedByReason[reason] = 0;
    this.droppedAttrNames.clear();
    this.windowNamesFull = false;
    this.prunedNames.length = 0;
    this.prunedNamesOverflow = 0;
    this.prunedTotal = 0;
    return report;
  }

  /**
   * One call produces everything a report needs, and advances the window.
   *
   * Deliberately a single method rather than two reads. If the write-failure
   * snapshot and the attribute window were fetched separately, a name dropped
   * between the two calls would have no defined window, and a reader could not
   * say which report it belongs to (@Leiysky, @Stone).
   */
  drainSinkReport(): { writeFailures: TraceWriteFailureStats; attrDrops: AttrDropReport } {
    return { writeFailures: this.getWriteFailureStats(), attrDrops: this.drainAttrDropReport() };
  }

  /** A drained report never reached anyone. See `reportsUndelivered`. */
  noteAttrDropReportUndelivered(): void {
    this.attrDropReportsUndelivered += 1;
  }

  /**
   * Snapshot of write failures. Every count is CUMULATIVE since process start,
   * never a delta — summing them across uploads over-counts (@Stone).
   *
   * The sink cannot report its own failure through a span — it *is* the span
   * writer, and the file it would write to is the one that just failed. So the
   * count is pulled by the uploader and attached to the next successful upload.
   */
  getWriteFailureStats(): TraceWriteFailureStats {
    return {
      total: this.writeFailures.total,
      byOutcome: { ...this.writeFailures.byOutcome },
      byCode: { ...this.writeFailures.byCode },
      lastOutcome: this.writeFailures.lastOutcome,
      lastCode: this.writeFailures.lastCode,
      rollbacks: this.writeFailures.byOutcome.append_partial_truncated,
      rotations: this.writeFailures.byOutcome.append_partial_rotated,
      pruneFailures: this.pruneFailures,
      lastPruneCode: this.lastPruneCode,
      droppedAttrsByReason: { ...this.droppedAttrsByReason },
      droppedAttrNames: Object.fromEntries(this.droppedAttrNames),
      droppedAttrNamesOverflow: this.droppedAttrNamesOverflow,
    };
  }

  getCurrentFile(): string | null {
    return this.currentFile;
  }

  private ensureFile(nextBytes: number): void {
    mkdirSync(this.traceDir, { recursive: true, mode: 0o700 });

    const nowMs = this.nowMsProvider();
    const shouldRotateForAge = this.currentFileOpenedAtMs !== null && nowMs - this.currentFileOpenedAtMs >= this.maxFileAgeMs;
    if (!this.currentFile || this.currentSize + nextBytes > this.maxFileBytes || shouldRotateForAge) {
      this.currentFile = path.join(
        this.traceDir,
        `daemon-trace-${safeTimestamp(nowMs)}-${process.pid}-${String(this.sequence++).padStart(4, "0")}.jsonl`,
      );
      this.fs.writeFileSync(this.currentFile, "", { flag: "a", mode: 0o600 });
      this.currentSize = this.fs.statSync(this.currentFile).size;
      this.currentFileOpenedAtMs = nowMs;
      // Pruning runs AFTER the new file exists and is sized, so its failure must
      // NOT propagate to the caller's `ensure_failed` handling. If it did, the
      // record would be dropped and the file abandoned; the next write would
      // create yet another file, prune would fail on the same undeletable
      // victim again, and the file count would grow without bound while every
      // record was lost — strictly worse than the defect this class fixes.
      // A victim that cannot be removed (EPERM/EBUSY/EACCES; `force: true` only
      // swallows ENOENT) is a retention problem, not a write problem. @Stone.
      try {
        this.pruneOldFiles();
      } catch (err) {
        this.pruneFailures += 1;
        this.lastPruneCode = reportedErrorCode(err);
      }
    }
  }

  private pruneOldFiles(): void {
    const names = this.fs.readdirSync(this.traceDir)
      .filter((name) => name.startsWith(TRACE_FILE_PREFIX) && name.endsWith(".jsonl"));
    const buckets: Record<TraceFileFamily, string[]> = {
      rotating: [],
      "cli-transport": [],
      diag: [],
      other: [],
    };
    for (const name of names) buckets[traceFileFamily(name)].push(name);

    // Rotating and cli-transport names both carry an ISO timestamp immediately
    // after their prefix, so a plain name sort is chronological. Diag names are
    // `daemon-trace-diag-<correlationId>.jsonl` with no time component at all —
    // sorting those by name would evict an arbitrary file rather than the
    // oldest, so that family (and any unrecognised one) is ordered by mtime.
    this.pruneFamily(buckets.rotating, this.maxFiles, "name");
    this.pruneFamily(buckets["cli-transport"], this.maxCliTransportFiles, "name");
    this.pruneFamily(buckets.diag, this.maxDiagFiles, "mtime");
    this.pruneFamily(buckets.other, this.maxOtherFiles, "mtime");
  }

  private pruneFamily(names: string[], budget: number, order: "name" | "mtime"): void {
    const currentName = this.currentFile ? path.basename(this.currentFile) : null;
    const victims = selectPruneVictims(names, budget, currentName, order, (name) => {
      try {
        return this.fs.statSync(path.join(this.traceDir, name)).mtimeMs;
      } catch {
        // Raced with another writer or already gone. Treat as oldest so it sorts
        // first; the rmSync below tolerates it having vanished.
        return 0;
      }
    });
    for (const name of victims) {
      // Each victim gets its own try. `selectPruneVictims` returns them oldest
      // first, so a single undeletable file would otherwise throw on every
      // rotation and block every victim behind it — permanently, not
      // intermittently. This family's reclamation would stop and the file count
      // would grow by one per rotation, unbounded. Skipping the bad one costs
      // exactly one retained file (@Stone, task #421).
      try {
        this.fs.rmSync(path.join(this.traceDir, name), { force: true });
        this.notePruned(name);
      } catch (err) {
        this.pruneFailures += 1;
        this.lastPruneCode = reportedErrorCode(err);
      }
    }
  }
}

/**
 * Chooses which files in ONE family to delete.
 *
 * Pure and exported so the load-bearing guarantee can be asserted on the
 * decision itself rather than on what the filesystem looks like afterwards:
 * **the file currently being written is never returned.** That distinction is
 * not pedantic. Under the previous implementation the current file WAS selected
 * and deleted, and `appendFileSync` then recreated it on the next write — so
 * every externally observable check ("does it exist?", "is it non-empty?")
 * passed while the bug was live. A test written against the aftermath cannot
 * see this class of defect at all.
 */
export function selectPruneVictims(
  names: readonly string[],
  budget: number,
  currentName: string | null,
  order: "name" | "mtime",
  mtimeOf: (name: string) => number,
): string[] {
  const holdsCurrent = currentName !== null && names.includes(currentName);
  // Excluding the current file from the candidate set — rather than trusting it
  // to sort last — is what makes its deletion unreachable by any budget
  // arithmetic, however large the excess grows.
  const candidates = names.filter((name) => name !== currentName);
  // The current file still occupies one slot in its own family's budget.
  const keep = Math.max(0, budget - (holdsCurrent ? 1 : 0));
  const excess = candidates.length - keep;
  if (excess <= 0) return [];
  const ordered = order === "mtime"
    ? candidates
      .map((name) => ({ name, mtimeMs: mtimeOf(name) }))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => entry.name)
    : [...candidates].sort();
  return ordered.slice(0, excess);
}

function safeTimestamp(timeMs: number): string {
  return new Date(timeMs).toISOString().replace(/[:.]/g, "-");
}

function toLocalTraceRecord(span: CompletedTraceSpan, hooks?: SanitizeHooks): Record<string, unknown> {
  return {
    type: "span",
    schema_version: 1,
    trace_id: span.context.traceId,
    span_id: span.context.spanId,
    parent_span_id: span.context.parentSpanId,
    name: span.name,
    surface: span.surface,
    kind: span.kind,
    status: span.status,
    start_time: new Date(span.startTimeMs).toISOString(),
    end_time: new Date(span.endTimeMs).toISOString(),
    duration_ms: span.durationMs,
    attrs: sanitizeAttrs(span.attrs, hooks),
    events: span.events.map((event) => sanitizeEvent(event, hooks)),
  };
}

function toLocalEventRecord(event: TraceLogEvent, hooks?: SanitizeHooks): Record<string, unknown> {
  return {
    type: "event",
    schema_version: 1,
    name: event.name,
    surface: event.surface,
    time: new Date(event.timeMs).toISOString(),
    ...(event.context ? { trace_id: event.context.traceId, span_id: event.context.spanId } : {}),
    attrs: sanitizeAttrs(event.attrs, hooks),
  };
}

function sanitizeEvent(event: TraceEvent, hooks?: SanitizeHooks): Record<string, unknown> {
  return {
    name: event.name,
    time: new Date(event.timeMs).toISOString(),
    attrs: sanitizeAttrs(event.attrs, hooks),
  };
}

function sanitizeAttrs(attrs: TraceAttributes | undefined, hooks?: SanitizeHooks): TraceAttributes | undefined {
  if (!attrs) return undefined;
  const sanitized: TraceAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === "") continue;
    if (isDiagnosticIdAttr(key)) {
      sanitized[key] = sanitizeValue(value);
      continue;
    }
    if (isDiagnosticErrorAttr(key)) {
      sanitized[key] = sanitizeDiagnosticErrorValue(key, value);
      continue;
    }
    if (SESSION_ID_KEYS.has(key)) {
      // A session id never reaches disk in the clear. Either it becomes a
      // machine-scoped reference or it goes, and the loss is counted — there is
      // no third branch that writes a weaker form of the same value.
      const reference = typeof value === "string" ? hooks?.sessionIdHash?.(value) ?? null : null;
      if (reference) {
        sanitized.session_id_hash = reference;
        sanitized.session_id_hash_scope = "machine";
        sanitized.session_id_hash_present = true;
      } else {
        // Written false rather than omitted: "we had a session id and could not
        // reference it" is a different fact from "there was no session".
        sanitized.session_id_hash_present = false;
        hooks?.onDrop?.(key, "session_hash_unavailable");
      }
      continue;
    }
    if (PRODUCER_PRESENCE_FLAGS_SUPERSEDED_BY_SINK.has(key)) {
      // Dropped, not renamed. A producer flag says "the source had one"; the
      // question a reader asks is "did it land", and only this side knows that.
      // Keeping both spellings would let them disagree, which is worse than
      // having neither (task #422 item 3).
      continue;
    }
    const dropReason = attrDropReason(key);
    if (dropReason) {
      // Only reached for attrs the filter removes. Values skipped above for
      // being null/undefined/"" are NOT reported: they were never carrying
      // anything, and counting them would inflate the figure with non-losses.
      hooks?.onDrop?.(key, dropReason);
      continue;
    }
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return { items_count: value.length };
  }
  if (typeof value === "object") {
    return { object_present: true };
  }
  return String(value);
}

function sanitizeDiagnosticErrorValue(key: string, value: unknown): unknown {
  if (key !== "original_message" || typeof value !== "string") return sanitizeValue(value);
  const normalized = value
    .replace(/sk_(?:agent|machine|computer)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/sap_[A-Za-z0-9_-]+/g, "sap_[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

/**
 * Why an attribute was dropped. Closed set — it is reported as a trace attribute.
 *
 * The three reasons are NOT equivalent and must not be summed into one number:
 * `secret_like` and `content_like` are the filter doing its job, and a count is
 * all anyone needs. `id_not_allowlisted` is the actionable one — the key was a
 * plain identifier that simply is not in `DIAGNOSTIC_ID_ATTRS`, which is a hand
 * maintained list, so every new id-shaped attribute is a chance to lose a field
 * silently. Only that reason records key NAMES (task #422).
 */
export type AttrDropReporter = (key: string, reason: AttrDropReason) => void;

/** Hooks the sink supplies to the pure record builders. */
/**
 * One reporting window's worth of attribute drops.
 *
 * Both halves are sampled at the SAME moment — the drain — on purpose. If the
 * totals were sampled on one schedule and the name table cleared on another, a
 * reader holding one report could not tell which slice of the totals the names
 * belong to (@Leiysky). `cumulativeByReason` is kept alongside so "how much in
 * this window" and "how much since start" are both answerable from one report.
 */
export interface AttrDropReport {
  readonly windowByReason: Readonly<Record<AttrDropReason, number>>;
  readonly windowNames: Readonly<Record<string, number>>;
  /**
   * The window's name table hit its cap, so `windowNames` is a sample.
   * Distinguishes "only these were dropped" from "more than listed" — without
   * it an empty-looking list reads the same as a complete one.
   */
  readonly windowNamesFull: boolean;
  readonly cumulativeByReason: Readonly<Record<AttrDropReason, number>>;
  /**
   * Reports drained but never carried by any span, cumulative.
   *
   * The window advances when it is READ, not when a report is delivered.
   * Rewinding after a failure would let the same name be reported twice once
   * retries overlap, and "reported twice" is indistinguishable from "dropped in
   * two windows". Draining only on success is no better: while uploads keep
   * failing the window grows past its cap and the names are lost to overflow —
   * the very thing this exists to prevent.
   *
   * **Boundary, because it has already changed once and will be asked again**
   * (@Leiysky). The report now rides the upload PASS span, which is emitted
   * whether or not any upload in that pass succeeds. So a pass whose uploads all
   * fail still reports its window — deliberately, since a run of failing uploads
   * is exactly when the dropped names matter most, and tying the report to
   * success would blank out precisely that stretch.
   *
   * What this counter covers is therefore one step further out than it was: not
   * "an upload failed", but "the pass produced no span at all" — no tracer, or a
   * pass that never ran. That case still needs a reading of its own, because
   * nothing else can say that a window which should have been reported was not.
   */
  readonly reportsUndelivered: number;
  /** Files this window's prune deleted, for the uploader to check receipts against. */
  readonly prunedNames: readonly string[];
  /** Prunes in this window whose names did not fit; the count becomes a lower bound. */
  readonly prunedNamesOverflow: number;
  /** Every file deleted by prune this window, named or not — the denominator. */
  readonly prunedTotal: number;
}

export interface SanitizeHooks {
  onDrop?: AttrDropReporter;
  /** Returns a machine-scoped reference, or null when it cannot be produced. */
  sessionIdHash?: (value: string) => string | null;
}

export type AttrDropReason =
  | "secret_like"
  | "path_like"
  | "content_like"
  | "id_not_allowlisted"
  /** A session id that could not be hashed, because the salt was unavailable. */
  | "session_hash_unavailable";

const ATTR_DROP_REASONS: readonly AttrDropReason[] = [
  "secret_like", "path_like", "content_like", "id_not_allowlisted", "session_hash_unavailable",
];

function attrDropReason(key: string): AttrDropReason | null {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (/(^|_)(api_key|auth_token|token|secret|password|cookie|credential)(_|$)/i.test(normalized)) {
    return "secret_like";
  }
  if (/(^|_)(count|present|kind|mode|source|outcome|reason|class|status|bucket|ms|code|truncated)$/.test(normalized)) {
    return null;
  }
  if (/(^|_)id$/.test(normalized)) {
    return "id_not_allowlisted";
  }
  // Split out from the content family on its own label. @Kabi's `exit_path` was
  // removed by this rule and was invisible in the first survey, which only
  // looked at the id family — the drop reasons are plural, so the labels are
  // too (task #422, @Manjusaka).
  if (/(^|_)(cwd|path|file)(_|$)/i.test(normalized)) {
    return "path_like";
  }
  return /(^|_)(prompt|content|text|message|body|request|response|command|argv|env|tool_args|tool_input|tool_output|stdout|stderr|error)(_|$)/i
    .test(normalized)
    ? "content_like"
    : null;
}

function shouldDropAttr(key: string): boolean {
  return attrDropReason(key) !== null;
}

function isDiagnosticIdAttr(key: string): boolean {
  // Class (b) rides the same gate: these are not identifiers at all, they just
  // end in `_id`, so the id rule would drop them for their spelling. Keeping the
  // two sets separate (rather than merging them) is deliberate — the reason a
  // key is allowed is part of the contract, and "opaque id we minted" and
  // "closed enumerable non-content value" are different warrants (#424).
  return DIAGNOSTIC_ID_ATTRS.has(key) || CLOSED_SET_NON_ID_ATTRS.has(key);
}

function isDiagnosticErrorAttr(key: string): boolean {
  return DIAGNOSTIC_ERROR_ATTRS.has(key);
}
