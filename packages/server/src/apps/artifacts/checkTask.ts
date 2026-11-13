// The publish check's durable task (task #proj-workspace:#130;
// docs/development/workspace-artifacts.md, "The check Worker's API"): the
// one module that signs a check's ticket (it alone imports checkFrame.ts,
// checkFrame.structure.test.ts), driven by the check Worker, which pulls.
//
// The task is the check's own row, `app_artifacts.version_checks`, written
// `pending` in the push's transaction (checks.ts recordVersionCheck), and it
// follows RFC 073's model (services/durableTasks.ts) on that row rather than
// a `durable_tasks` row beside it: the work is the check Worker's, outside
// the server, so there is no inline run and no handler here, only the claim,
// the lease and the fenced outcome.
//
// - leaseCheck (`POST /internal/artifacts-check/lease`): one transaction
//   claims a check that may run, `FOR UPDATE SKIP LOCKED` (RFC 073's
//   claim): pending, or running with its lease run out (a lost attempt: the
//   retry), recorded less than ARTIFACT_CHECK_RUN_WINDOW_MS ago. Fair between
//   servers (the check Worker runs many checks at once, task
//   #proj-workspace:#185): the candidates are taken from the server with the
//   fewest checks running under a live lease first, then oldest first, so
//   servers take turns and one busy server never starves the others. There is
//   no per-server cap: the order is the fairness, and it is work-conserving (a
//   server's waiting check takes the next browser whenever no server with
//   fewer running has one waiting), so a lone server can use every browser the
//   Worker runs. The count is the statement's (a CTE beside the claim). Each
//   candidate, in that order, is checked as authorize would and finished
//   where it can never run: the Artifact or version gone (`not_readable`),
//   Artifacts off for its server (`disabled`), a kind the shell draws
//   (`not_framed`), a framed kind a check doesn't open (`not_checked`:
//   shared ARTIFACT_CHECKED_KINDS, Markdown, PDF for now), over a daily cap now
//   (`skipped` with the cap: mayStartCheck, pending ones only). The first that may run moves to `running` with
//   `lease_expires_at` now + ARTIFACT_CHECK_LEASE_MS, and its ticket is
//   signed (signCheckFrame); unsigned (no content origin, or a signature that
//   failed) the transaction rolls back and nothing is leased. The lease's
//   fencing token is its `lease_expires_at` (ISO, milliseconds).
// - finishCheck (`POST …/:checkId/result`): only while that lease is
//   current (running, the same `lease_expires_at`, not past). Screenshots are
//   stored first, outside any transaction (putObjectFile: the bytes, uploaded
//   by the version's publisher, as unclaimed drafts of the Artifact), then
//   one transaction holds the row, checks the fence again, hangs them on the
//   version (claimObjectFile, parent checkShotPart) and finishes it: `done`
//   with its findings, or `failed` with the load's cause. A late or repeated
//   result writes nothing (409); a draft stored for a result that lost the
//   race is never claimed, and core's sweep deletes it within the hour. Then
//   keepNewestCheckShots.
// - expireStaleChecks (the app's `check_expiry` job, every minute): the
//   bound on retries without an attempts column. A check runs within
//   ARTIFACT_CHECK_RUN_WINDOW_MS of its push or not at all: past it a
//   pending one fails `expired` and a running one whose lease ran out
//   `lease_expired` (at most window / lease attempts, five).
//
// Logs carry ids and codes only: never the ticket's url.
import { and, asc, eq, gt, gte, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES,
  ARTIFACT_CHECK_MAX_CONSOLE_ERRORS,
  ARTIFACT_CHECK_SHOT_MAX_BYTES,
  ARTIFACT_CHECK_TEXT_MAX_CHARS,
  ARTIFACT_CHECK_TIMING_MAX_MS,
  ARTIFACT_CHECK_TIMING_STAGES,
  ARTIFACT_CHECK_VIEWPORTS,
  artifactFileType,
  currentDate,
  isArtifactCheckedKind,
  isArtifactFramedKind,
  type ArtifactCheckLease,
  type ArtifactCheckShot,
  type ArtifactCheckTiming,
  type ArtifactKind,
  type ObjectFileId,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { claimObjectFile, ObjectFileRefusedError, putObjectFile } from "../../platform/objectFiles";
import { AppObjectStorageUnavailableError } from "../../platform/storage";
import { recordAppEvent } from "../../platform/tracing";
import { itemServerEnabled } from "./apiCommon";
import { signCheckFrame } from "./checkFrame";
import { ARTIFACT_CHECK_LEASE_MS, artifactFileObject, checkShotPart, keepNewestCheckShots, mayStartCheck } from "./checks";
import {
  artifactItems,
  artifactVersionChecks,
  artifactVersions,
  type ArtifactCheckFindings,
  type ArtifactCheckSkipReason,
  type ArtifactItemRow,
  type ArtifactVersionCheckRow,
  type ArtifactVersionRow,
} from "./schema";

/** A check runs within this long of its push, or never (expireStaleChecks): with ARTIFACT_CHECK_LEASE_MS, at most five attempts. */
export const ARTIFACT_CHECK_RUN_WINDOW_MS = 10 * 60 * 1000;
/** How far back expireStaleChecks looks: a day, so it reads a bounded range of the created index. */
const EXPIRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Candidates a lease looks at, in its order (fewest running for their server, then oldest); those that can never run are finished on the way. */
const LEASE_CANDIDATES = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A load error's class as the Worker names it: code-shaped, short. */
const ERROR_CLASS = /^[a-z][a-z0-9_.-]{0,47}$/;
/** The error classes the check task writes itself (a check that never ran or never reported). */
export type ArtifactCheckTaskError = "not_readable" | "not_framed" | "not_checked" | "disabled" | "expired" | "lease_expired";

// ---- lease -------------------------------------------------------------------------

export type ArtifactCheckLeaseOutcome =
  | { kind: "leased"; lease: ArtifactCheckLease }
  | { kind: "none" }
  /** No content origin configured: nothing can be signed, so nothing is leased. */
  | { kind: "not_configured" }
  /** The signature failed (our bug): nothing is leased. */
  | { kind: "failed"; errorClass: string };

/** Rolls the lease's transaction back when its ticket can't be signed. */
class UnsignedLease extends Error {
  constructor(readonly outcome: Extract<ArtifactCheckLeaseOutcome, { kind: "not_configured" | "failed" }>) {
    super(outcome.kind);
  }
}

type Candidate = { check: ArtifactVersionCheckRow; version: ArtifactVersionRow; item: ArtifactItemRow };
type Verdict = { kind: "lease" } | { kind: "fail"; errorClass: ArtifactCheckTaskError } | { kind: "skip"; reason: Extract<ArtifactCheckSkipReason, "server_daily_cap" | "platform_daily_cap"> };

/** Whether a candidate may run now, checked as authorize (contentRoutes.ts decideCheck) and the caps would. */
async function verdictOf(tx: DatabaseExecutor, { check, version, item }: Candidate, env: NodeJS.ProcessEnv | undefined): Promise<Verdict> {
  if (item.deletedAt !== null || item.revokedAt !== null || version.revokedAt !== null || version.position === null) return { kind: "fail", errorClass: "not_readable" };
  const kind = artifactFileType(version.entry).kind;
  if (!isArtifactFramedKind(kind)) return { kind: "fail", errorClass: "not_framed" };
  // A Markdown or PDF version recorded before checks left it out (shared ARTIFACT_CHECKED_KINDS).
  if (!isArtifactCheckedKind(kind)) return { kind: "fail", errorClass: "not_checked" };
  if (!(await itemServerEnabled(item))) return { kind: "fail", errorClass: "disabled" };
  // A retry (running, its lease run out) passed the caps when it first started.
  if (check.status === "pending") {
    const allowance = await mayStartCheck(tx, check, item.serverId, { env });
    if (!allowance.ok) return { kind: "skip", reason: allowance.reason };
  }
  return { kind: "lease" };
}

/**
 * Lease one check for the check Worker (the file's header): its ticket url,
 * signed just now, and the lease. None (`none`) when no check may run.
 */
export async function leaseCheck(opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<ArtifactCheckLeaseOutcome> {
  const now = opts.now ?? currentDate();
  try {
    return await getDb().transaction(async (tx): Promise<ArtifactCheckLeaseOutcome> => {
      const since = new Date(now.getTime() - ARTIFACT_CHECK_RUN_WINDOW_MS);
      // Each server's checks running now, under a live lease (a lost one, run out, doesn't count).
      // A check leased late in its window holds its lease past it: look back a lease further.
      const inFlight = tx.$with("in_flight").as(
        tx.select({ serverId: artifactItems.serverId, running: sql<number>`count(*)::int`.as("in_flight_running") })
          .from(artifactVersionChecks)
          .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionChecks.versionId))
          .innerJoin(artifactItems, eq(artifactItems.id, artifactVersions.itemId))
          .where(and(
            gte(artifactVersionChecks.createdAt, new Date(since.getTime() - ARTIFACT_CHECK_LEASE_MS)),
            eq(artifactVersionChecks.status, "running"),
            gt(artifactVersionChecks.leaseExpiresAt, now),
          ))
          .groupBy(artifactItems.serverId),
      );
      const running = sql<number>`coalesce(${inFlight.running}, 0)`;
      // `FOR UPDATE OF` takes a table name or an alias, never a schema-qualified one (checks.ts keepNewestCheckShots).
      const held = alias(artifactVersionChecks, "leased_checks");
      const candidates = await tx.with(inFlight).select({ check: held, version: artifactVersions, item: artifactItems })
        .from(held)
        .innerJoin(artifactVersions, eq(artifactVersions.id, held.versionId))
        .innerJoin(artifactItems, eq(artifactItems.id, artifactVersions.itemId))
        .leftJoin(inFlight, eq(inFlight.serverId, artifactItems.serverId))
        .where(and(
          gte(held.createdAt, since),
          or(eq(held.status, "pending"), and(eq(held.status, "running"), lt(held.leaseExpiresAt, now))),
        ))
        // Fair between servers, and work-conserving: the server with the fewest checks running first,
        // then the oldest check; each lease raises its server's count, so servers take turns, and a
        // server alone takes every browser. No per-server cap.
        .orderBy(running, asc(held.createdAt), asc(held.id))
        .limit(LEASE_CANDIDATES)
        .for("update", { of: held, skipLocked: true });
      for (const candidate of candidates) {
        const { check, version, item } = candidate;
        const verdict = await verdictOf(tx, candidate, opts.env);
        if (verdict.kind === "fail") {
          await tx.update(artifactVersionChecks)
            .set({ status: "failed", errorClass: verdict.errorClass, finishedAt: now, leaseExpiresAt: null })
            .where(eq(artifactVersionChecks.id, check.id));
          console.info("[artifacts] publish check not run", { checkId: check.id, errorClass: verdict.errorClass });
          continue;
        }
        if (verdict.kind === "skip") {
          await tx.update(artifactVersionChecks)
            .set({ status: "skipped", skipReason: verdict.reason, finishedAt: now, leaseExpiresAt: null })
            .where(eq(artifactVersionChecks.id, check.id));
          continue;
        }
        const leaseExpiresAt = new Date(now.getTime() + ARTIFACT_CHECK_LEASE_MS);
        await tx.update(artifactVersionChecks).set({ status: "running", leaseExpiresAt }).where(eq(artifactVersionChecks.id, check.id));
        const frame = await signCheckFrame(item, version);
        if (frame.kind === "not_configured") throw new UnsignedLease({ kind: "not_configured" });
        if (frame.kind !== "signed") throw new UnsignedLease({ kind: "failed", errorClass: frame.kind === "failed" ? frame.errorClass : frame.kind });
        return {
          kind: "leased",
          lease: {
            checkId: check.id,
            artifactId: item.id,
            versionId: version.id,
            url: frame.url,
            viewports: ARTIFACT_CHECK_VIEWPORTS.map((viewport) => ({ ...viewport })),
            lease: leaseExpiresAt.toISOString(),
            leaseExpiresAt: leaseExpiresAt.toISOString(),
          },
        };
      }
      return { kind: "none" };
    });
  } catch (error) {
    if (error instanceof UnsignedLease) return error.outcome;
    throw error;
  }
}

// ---- the report --------------------------------------------------------------------

/** What finishCheck takes: the report as checked (findingsOf), the lease it names. */
export interface ParsedCheckReport {
  checkId: string;
  lease: Date;
  load: { outcome: "ok" } | { outcome: "timeout" } | { outcome: "error"; errorClass: string };
  findings: ArtifactCheckFindings;
  /** Where the check's time went, for the result's span alone; null from a Worker that sends none, or one whose numbers aren't times. */
  timing: ArtifactCheckTiming | null;
}

/**
 * The report's timing as sent, or null: every stage a whole number of milliseconds within
 * ARTIFACT_CHECK_TIMING_MAX_MS. It is a measurement for the span, so a bad one is left out and
 * the report still stands (an older or newer Worker never loses a check to it).
 */
function parsedTiming(value: unknown): ArtifactCheckTiming | null {
  if (!isRecord(value)) return null;
  const stage = (name: (typeof ARTIFACT_CHECK_TIMING_STAGES)[number]) => {
    const ms = value[name];
    return isCount(ms) && ms <= ARTIFACT_CHECK_TIMING_MAX_MS ? ms : null;
  };
  const [browserMs, prepareMs, loadMs, settleMs, shotsMs] = ARTIFACT_CHECK_TIMING_STAGES.map(stage);
  if (browserMs == null || prepareMs == null || loadMs == null || settleMs == null || shotsMs == null) return null;
  return { browserMs, prepareMs, loadMs, settleMs, shotsMs };
}

/** A page's text as kept: no control characters (so the stored JSON stays near its length), cut to ARTIFACT_CHECK_TEXT_MAX_CHARS code points. */
function keptText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return [...value.replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, ARTIFACT_CHECK_TEXT_MAX_CHARS).join("");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The check Worker's report (shared ArtifactCheckReport), checked: ids and
 * the lease as sent, the load's outcome, and the findings cut to their caps
 * (the first ones kept). Null for anything that isn't one.
 */
export function parseCheckReport(value: unknown): ParsedCheckReport | null {
  if (!isRecord(value)) return null;
  const { checkId, lease, load, consoleErrors, blockedResources, blank, phoneOverflow, timing } = value;
  if (typeof checkId !== "string" || typeof lease !== "string" || !isRecord(load)) return null;
  const leaseAt = new Date(lease);
  if (Number.isNaN(leaseAt.getTime()) || leaseAt.toISOString() !== lease) return null;
  let parsedLoad: ParsedCheckReport["load"];
  if (load.outcome === "ok" || load.outcome === "timeout") parsedLoad = { outcome: load.outcome };
  else if (load.outcome === "error" && typeof load.errorClass === "string") parsedLoad = { outcome: "error", errorClass: ERROR_CLASS.test(load.errorClass) ? load.errorClass : "other" };
  else return null;
  if (!Array.isArray(consoleErrors) || !Array.isArray(blockedResources)) return null;
  const errors: ArtifactCheckFindings["consoleErrors"] = [];
  for (const entry of consoleErrors.slice(0, ARTIFACT_CHECK_MAX_CONSOLE_ERRORS)) {
    if (!isRecord(entry) || typeof entry.message !== "string") return null;
    if (entry.source !== null && entry.source !== undefined && typeof entry.source !== "string") return null;
    if (entry.line !== null && entry.line !== undefined && !isCount(entry.line)) return null;
    errors.push({ message: keptText(entry.message), source: typeof entry.source === "string" ? keptText(entry.source) : null, line: isCount(entry.line) ? entry.line : null });
  }
  const blocked: string[] = [];
  for (const entry of blockedResources.slice(0, ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES)) {
    if (typeof entry !== "string") return null;
    blocked.push(keptText(entry));
  }
  if (blank !== undefined && typeof blank !== "boolean") return null;
  let overflow: ArtifactCheckFindings["phoneOverflow"] = null;
  if (phoneOverflow !== undefined && phoneOverflow !== null) {
    if (!isRecord(phoneOverflow) || !isCount(phoneOverflow.contentWidth) || !isCount(phoneOverflow.viewportWidth)) return null;
    overflow = { contentWidth: phoneOverflow.contentWidth, viewportWidth: phoneOverflow.viewportWidth };
  }
  return { checkId, lease: leaseAt, load: parsedLoad, findings: { consoleErrors: errors, blockedResources: blocked, blank: blank ?? false, phoneOverflow: overflow }, timing: parsedTiming(timing) };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether `bytes` is a screenshot the check keeps: a PNG of at most ARTIFACT_CHECK_SHOT_MAX_BYTES. */
export function isCheckShot(bytes: Buffer): boolean {
  return bytes.length > PNG_MAGIC.length && bytes.length <= ARTIFACT_CHECK_SHOT_MAX_BYTES && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

// ---- finishing -----------------------------------------------------------------------

export type ArtifactCheckFinishOutcome =
  | {
    kind: "finished";
    status: "done" | "failed";
    /** For the result's span (trace.ts), never the answer: the kind of the version checked. */
    artifactKind: ArtifactKind;
    /** Whole milliseconds from the check's row being recorded (`created_at`) to this finish (`finished_at`). */
    checkMs: number;
    /** Whole milliseconds from this result's lease being taken (its expiry less ARTIFACT_CHECK_LEASE_MS) to this finish. */
    runMs: number;
    /** Where the Worker says that run's time went (the report's `timing`); null when it said nothing usable. */
    timing: ArtifactCheckTiming | null;
  }
  /** No such check. */
  | { kind: "not_found" }
  /** The lease isn't current (finished, expired, or another lease's): nothing written. */
  | { kind: "conflict" }
  /** A screenshot core won't keep (not an image it takes): nothing finished. */
  | { kind: "invalid"; error: string }
  /** No bucket for the screenshots: nothing finished, the Worker may retry within the lease. */
  | { kind: "unavailable" };

/** The fence on a check's lease (RFC 073's `claimed_by` and `attempts`): its id, running, that very lease, and not past it. */
const leaseHolds = (checkId: string, lease: Date, now: Date) => and(
  eq(artifactVersionChecks.id, checkId),
  eq(artifactVersionChecks.status, "running"),
  eq(artifactVersionChecks.leaseExpiresAt, lease),
  gt(artifactVersionChecks.leaseExpiresAt, now),
);

/** Rolls the finishing transaction back when the fence no longer holds there. */
class LeaseLost extends Error {}

/** Why a check finished (or didn't) without a screenshot the Worker sent. */
type ShotDropReason = "load_not_ok" | "server_quota_exceeded" | "uploader_quota_exceeded" | "lease_lost";

/** Never silently: a structured log (ids and codes) and a trace event (codes only) for each screenshot not kept. */
function shotDropped(checkId: string, shot: ArtifactCheckShot, reason: ShotDropReason): void {
  console.warn("[artifacts] publish check screenshot not kept", { checkId, shot, reason });
  recordAppEvent("server.artifacts.check_shot_dropped", { shot, reason });
}

/**
 * Finish the check `checkId` with `report` and its screenshots (by `shot`),
 * while the report's lease is current (the file's header). A load that
 * wasn't `ok` finishes `failed` (`load_timeout`, `load_error:<class>`) and
 * keeps no screenshot.
 */
export async function finishCheck(
  checkId: string,
  report: ParsedCheckReport,
  shots: Partial<Record<ArtifactCheckShot, Buffer>>,
  opts: { now?: Date } = {},
): Promise<ArtifactCheckFinishOutcome> {
  if (!UUID.test(checkId)) return { kind: "not_found" };
  const now = opts.now ?? currentDate();
  const [found] = await getDb().select({ check: artifactVersionChecks, version: artifactVersions })
    .from(artifactVersionChecks)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionChecks.versionId))
    .where(eq(artifactVersionChecks.id, checkId))
    .limit(1);
  if (!found) return { kind: "not_found" };
  const { check, version } = found;
  const current = check.status === "running" && check.leaseExpiresAt !== null
    && check.leaseExpiresAt.getTime() === report.lease.getTime() && check.leaseExpiresAt.getTime() > now.getTime();
  if (!current) return { kind: "conflict" };

  const object = artifactFileObject(version.itemId);
  const publisher = { type: version.publisherType, id: version.publisherId };
  const drafts: Partial<Record<ArtifactCheckShot, ObjectFileId>> = {};
  if (report.load.outcome !== "ok") {
    // A load that wasn't `ok` keeps no screenshot (the file's header): said, not silent.
    for (const viewport of ARTIFACT_CHECK_VIEWPORTS) {
      if (shots[viewport.shot] !== undefined) shotDropped(checkId, viewport.shot, "load_not_ok");
    }
  } else {
    for (const viewport of ARTIFACT_CHECK_VIEWPORTS) {
      const bytes = shots[viewport.shot];
      if (bytes === undefined) continue;
      try {
        // The platform's own screenshots (`exempt`): the Artifact's server's, under none of the
        // uploads' caps (its total, an uploader's share, the monthly quota); bounded by the checks
        // themselves (two a version, the newest three checked versions: keepNewestCheckShots) and
        // reported apart (core's objectFilesUsage).
        drafts[viewport.shot] = (await putObjectFile({ object, parent: null, bytes, uploadedBy: publisher, quota: "exempt" })).id;
      } catch (error) {
        if (error instanceof AppObjectStorageUnavailableError) return { kind: "unavailable" };
        if (!(error instanceof ObjectFileRefusedError)) throw error;
        // The Artifact is gone: the check can't finish (its row goes with it).
        if (error.reason === "object_not_found") return { kind: "conflict" };
        // A cap (`exempt` files reach none today; kept should that change): the check finishes
        // without that screenshot, logged and traced.
        // TODO(#proj-workspace:#184): screenshots are exempt from the server's object file cap
        // (Tenny's call); revisit here if they get a bound of their own.
        if (error.reason === "server_quota_exceeded" || error.reason === "uploader_quota_exceeded") {
          shotDropped(checkId, viewport.shot, error.reason);
          continue;
        }
        return { kind: "invalid", error: `${viewport.shot}: ${error.reason}` };
      }
    }
  }

  const status = report.load.outcome === "ok" ? "done" : "failed";
  try {
    await getDb().transaction(async (tx) => {
      // One table, so a plain FOR UPDATE (no `OF`, which can't name a schema-qualified table).
      const [locked] = await tx.select({ id: artifactVersionChecks.id }).from(artifactVersionChecks).where(leaseHolds(checkId, report.lease, now)).for("update");
      if (!locked) throw new LeaseLost();
      for (const [shot, fileId] of Object.entries(drafts) as Array<[ArtifactCheckShot, ObjectFileId]>) {
        const claimed = await claimObjectFile({ object, fileId, parent: checkShotPart(version.id), by: publisher, executor: tx });
        if (!claimed) throw new Error(`publish check screenshot ${shot} could not be claimed`);
      }
      const set = report.load.outcome === "ok"
        ? { status: "done" as const, desktopFileId: drafts.desktop ?? null, phoneFileId: drafts.phone ?? null, findings: report.findings }
        : { status: "failed" as const, errorClass: report.load.outcome === "timeout" ? "load_timeout" : `load_error:${report.load.errorClass}` };
      await tx.update(artifactVersionChecks).set({ ...set, finishedAt: now, leaseExpiresAt: null }).where(eq(artifactVersionChecks.id, checkId));
    });
  } catch (error) {
    // Lost the race (another result, or the lease ran out meanwhile): the drafts stay unclaimed for core's sweep.
    if (error instanceof LeaseLost) {
      for (const shot of Object.keys(drafts) as ArtifactCheckShot[]) shotDropped(checkId, shot, "lease_lost");
      return { kind: "conflict" };
    }
    throw error;
  }
  if (Object.keys(drafts).length > 0) {
    await keepNewestCheckShots(version.itemId).catch((error: unknown) => {
      console.warn("[artifacts] keeping the newest publish check screenshots failed; the next check retries", { checkId, errorClass: error instanceof Error ? error.name : typeof error });
    });
  }
  return {
    kind: "finished",
    status,
    artifactKind: artifactFileType(version.entry).kind,
    checkMs: Math.max(0, now.getTime() - check.createdAt.getTime()),
    // leaseCheck set this lease's expiry to its own `now` + ARTIFACT_CHECK_LEASE_MS: no column says when a check started.
    runMs: Math.max(0, now.getTime() - (report.lease.getTime() - ARTIFACT_CHECK_LEASE_MS)),
    timing: report.timing,
  };
}

// ---- expiry --------------------------------------------------------------------------

/**
 * Fail the checks that can no longer run (the file's header): recorded a
 * day to ARTIFACT_CHECK_RUN_WINDOW_MS ago, still pending (`expired`) or
 * running with their lease run out (`lease_expired`). Returns how many.
 */
export async function expireStaleChecks(now: Date = currentDate()): Promise<number> {
  const window = and(
    gte(artifactVersionChecks.createdAt, new Date(now.getTime() - EXPIRY_LOOKBACK_MS)),
    lt(artifactVersionChecks.createdAt, new Date(now.getTime() - ARTIFACT_CHECK_RUN_WINDOW_MS)),
  );
  const db = getDb();
  const expired = await db.update(artifactVersionChecks)
    .set({ status: "failed", errorClass: "expired", finishedAt: now, leaseExpiresAt: null })
    .where(and(window, eq(artifactVersionChecks.status, "pending")))
    .returning({ id: artifactVersionChecks.id });
  const lost = await db.update(artifactVersionChecks)
    .set({ status: "failed", errorClass: "lease_expired", finishedAt: now, leaseExpiresAt: null })
    .where(and(window, eq(artifactVersionChecks.status, "running"), lt(artifactVersionChecks.leaseExpiresAt, now)))
    .returning({ id: artifactVersionChecks.id });
  return expired.length + lost.length;
}
