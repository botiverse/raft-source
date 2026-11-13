// #proj-raft-computer:#68 (readiness PR 1): the login facts this runner
// observed, persisted and reported to its server (`machine:runtime_readiness`).
//
// One file per runner, `<raft home>/machines/<machine id>/runtime-readiness.json`
// (next to runtime-processes.json), in the shared `RuntimeReadinessFile`
// format, written atomically (temp file + rename) by this runner only: one
// writer, no lock. It holds every login this runner saw a fact on: the
// machine logins (`shared:<runtime>`) and its agents' own (`agent:<id>`), each
// with its state, since and recordedAt, and the report `seq`. Never a secret,
// a path, an account or error text.
//
// The ProviderLimitLedger stays what enforces a login block (the daemon is
// the one that sees it, so the daemon enforces it): the store mirrors the
// ledger's invalid records that carry a readiness code
// (`CredentialInvalidRecord.code`) and, at startup, puts them back into it, so
// a restart clears nothing. A record ends as any ledger record does: model
// output from a turn started after it, a credential change, or a person's
// Retry (the recheck until a later step makes Retry one).
//
// #proj-raft-computer:#69, a Computer with several runners (one per connected
// server): the machine login is the same account for all of them, so each
// runner also reads the `shared:*` evidence in the other runners' files (the
// sibling directories under `machines/`) and merges it with its own
// (`mergeSharedLoginEvidence`: the latest real call wins). A finding another
// runner made later than anything this runner knows is taken over (its agents
// on that login are held without each having to fail); an end another runner
// saw later than this runner's finding ends it here too. For that, when a
// hold on a machine login ends, the file keeps when and why (`ended`). Each
// runner still writes only its own file: no lock, and no runner depends on
// another being alive.

import fs from "node:fs";
import path from "node:path";
import {
  READINESS_CODE_SPEC,
  RUNTIME_READINESS_END_CAUSES,
  isReadinessCode,
  mergeSharedLoginEvidence,
  type CredentialInvalidReason,
  type ReadinessCode,
  type ReadinessFact,
  type RuntimeReadinessFile,
  type RuntimeReadinessEndCause,
  type RuntimeReadinessFileEnd,
  type RuntimeReadinessFileEntry,
  type RuntimeReadinessReport,
} from "@botiverse/raft-shared";
import { logger } from "./logger";
import type { ProviderLimitChange, ProviderLimitCredentialKey, ProviderLimitLedger } from "./providerLimitLedger";

/** Atomic replace: write a private temp file, then rename over the target; a failed write leaves the old file. */
function writeJsonFileAtomic(file: string, contents: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(contents)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    // The other runners read this file: a write that did not land is worth a line.
    logger.warn(`[Daemon] runtime readiness file not written: ${error instanceof Error ? error.message : String(error)}`);
    fs.rmSync(tmp, { force: true });
  }
}

export const RUNTIME_READINESS_FILE = "runtime-readiness.json";

type StoredEntry = RuntimeReadinessFileEntry & { state: ReadinessCode };

/** The ledger reason a persisted login state holds agents with (the existing hold, and the old-server copy). */
function credentialInvalidReasonFor(state: ReadinessCode): CredentialInvalidReason | null {
  return state === "verification_required" ? "user_reauth" : null;
}

function isCredentialKey(key: string): key is ProviderLimitCredentialKey {
  return /^(?:shared|agent):.+/.test(key);
}

function isSharedKey(key: string): boolean {
  return key.startsWith("shared:");
}

/** How often a runner reads the other runners' files. */
export const SHARED_LOGIN_SYNC_INTERVAL_MS = 10_000;

/**
 * How old another runner's finding may be and still be taken over. A runner
 * that is gone (its server detached, its key rotated) leaves its directory
 * behind, with whatever it last saw: without a bound, a login fixed long ago
 * would hold a new runner's agents before any of them made a call. Past it,
 * this runner finds out by itself, at the cost of one call. Ends have no bound.
 */
export const SHARED_LOGIN_FINDING_MAX_AGE_MS = 24 * 60 * 60_000;

/** The file, read leniently: an entry this build cannot use is left out. */
export function readRuntimeReadinessFile(file: string): {
  seq: number;
  credentials: Map<ProviderLimitCredentialKey, StoredEntry>;
  ended: Map<ProviderLimitCredentialKey, RuntimeReadinessFileEnd>;
} {
  const credentials = new Map<ProviderLimitCredentialKey, StoredEntry>();
  const ended = new Map<ProviderLimitCredentialKey, RuntimeReadinessFileEnd>();
  let doc: Partial<RuntimeReadinessFile> | null = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RuntimeReadinessFile>;
  } catch {
    return { seq: 0, credentials, ended };
  }
  const seq = typeof doc?.seq === "number" && Number.isSafeInteger(doc.seq) && doc.seq > 0 ? doc.seq : 0;
  for (const [key, entry] of Object.entries(doc?.credentials && typeof doc.credentials === "object" ? doc.credentials : {})) {
    if (!isCredentialKey(key) || !entry || !isReadinessCode(entry.state)) continue;
    if (READINESS_CODE_SPEC[entry.state].resource !== "login") continue;
    if (typeof entry.since !== "number" || !Number.isFinite(entry.since)) continue;
    if (typeof entry.recordedAt !== "number" || !Number.isFinite(entry.recordedAt)) continue;
    credentials.set(key, { state: entry.state, since: entry.since, recordedAt: entry.recordedAt });
  }
  for (const [key, end] of Object.entries(doc?.ended && typeof doc.ended === "object" ? doc.ended : {})) {
    if (!isCredentialKey(key) || !isSharedKey(key) || !end) continue;
    if (typeof end.at !== "number" || !Number.isFinite(end.at)) continue;
    if (!(RUNTIME_READINESS_END_CAUSES as readonly unknown[]).includes(end.cause)) continue;
    ended.set(key, { at: end.at, cause: end.cause });
  }
  return { seq, credentials, ended };
}

/**
 * What the other runners on this Computer saw of the machine logins: the
 * `shared:*` findings and ends of every `<machines>/<dir>/runtime-readiness.json`
 * except `ownFile`. A handful of small files, read whole each time: no change
 * tracking to get wrong. A missing or unreadable file reads as empty.
 */
export function readSiblingSharedLogins(ownFile: string): Map<ProviderLimitCredentialKey, { findings: StoredEntry[]; ends: RuntimeReadinessFileEnd[] }> {
  const byKey = new Map<ProviderLimitCredentialKey, { findings: StoredEntry[]; ends: RuntimeReadinessFileEnd[] }>();
  const at = (key: ProviderLimitCredentialKey) => {
    let seen = byKey.get(key);
    if (!seen) byKey.set(key, seen = { findings: [], ends: [] });
    return seen;
  };
  const machinesDir = path.dirname(path.dirname(ownFile));
  let dirs: string[];
  try {
    dirs = fs.readdirSync(machinesDir);
  } catch {
    return byKey;
  }
  for (const dir of dirs) {
    const file = path.join(machinesDir, dir, path.basename(ownFile));
    if (path.resolve(file) === path.resolve(ownFile)) continue;
    const sibling = readRuntimeReadinessFile(file);
    for (const [key, entry] of sibling.credentials) if (isSharedKey(key)) at(key).findings.push(entry);
    for (const [key, end] of sibling.ended) at(key).ends.push(end);
  }
  return byKey;
}

export class RuntimeReadinessStore {
  private credentials = new Map<ProviderLimitCredentialKey, StoredEntry>();
  /** `shared:*` only: when this runner last saw a hold on that machine login end (#69). */
  private ended = new Map<ProviderLimitCredentialKey, RuntimeReadinessFileEnd>();
  private seq = 0;
  private unsubscribe: (() => void) | null = null;
  private ledger: ProviderLimitLedger | null = null;
  /** Set while the store itself changes the ledger (seeding it, or applying another runner's evidence): that echo is not a new finding. */
  private seeding = false;
  private syncTimer: unknown = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: {
    file: string;
    now?: () => number;
    /** The repeating timer of `startSharedLoginSync`; tests replace it. */
    timers?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };
  }) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Reads the file. `seq` continues from the stored one and never falls
   * behind the clock, so it keeps growing across restarts even when the
   * file was lost.
   */
  load(): void {
    const stored = readRuntimeReadinessFile(this.options.file);
    this.credentials = stored.credentials;
    this.ended = stored.ended;
    this.seq = stored.seq;
    this.bumpSeq();
  }

  /** Puts the stored facts back into `ledger` (holding their agents again) and mirrors its changes from now on. */
  attach(ledger: ProviderLimitLedger): void {
    this.unsubscribe?.();
    this.ledger = ledger;
    this.applyToLedger(() => {
      for (const [key, entry] of this.credentials) {
        const invalidReason = credentialInvalidReasonFor(entry.state);
        if (invalidReason) ledger.recordInvalid(key, { invalidReason, recordedAtMs: entry.recordedAt, code: entry.state }, { host: "legacy" });
      }
    });
    this.unsubscribe = ledger.subscribe((change) => this.onLedgerChange(change));
    // What the other runners know, before any agent of this one starts.
    this.syncSharedLogins();
  }

  /**
   * #69: merge what the other runners saw of each machine login with what
   * this runner saw. Per key the latest evidence wins (mergeSharedLoginEvidence):
   * - another runner's finding is the latest: taken over here with its
   *   `recordedAt`, and the ledger holds this runner's agents on that login;
   * - another runner saw it end after this runner's finding: ended here too,
   *   with that end's time and cause (a changed credential is applied as one,
   *   so the hosts run their account check);
   * - this runner's own evidence is the latest: nothing changes.
   * Times are only copied, never made newer, so runners cannot keep handing
   * the same evidence back and forth. Returns whether anything changed.
   */
  syncSharedLogins(): boolean {
    const ledger = this.ledger;
    if (!ledger) return false;
    const freshFrom = this.now() - SHARED_LOGIN_FINDING_MAX_AGE_MS;
    let changedAny = false;
    for (const [key, foreign] of readSiblingSharedLogins(this.options.file)) {
      const own = this.credentials.get(key);
      const ownEnd = this.ended.get(key);
      const merged = mergeSharedLoginEvidence(
        [...(own ? [own] : []), ...foreign.findings.filter((finding) => finding.recordedAt >= freshFrom)],
        [...(ownEnd ? [ownEnd] : []), ...foreign.ends],
      );
      if (!merged) continue;
      if (merged.kind === "finding") {
        const winner = merged.entry as StoredEntry;
        if (winner === own) continue;
        const invalidReason = credentialInvalidReasonFor(winner.state);
        if (!invalidReason) continue;
        // What this runner's ledger found itself at that time or later stands, also when it carries no code.
        const held = ledger.invalidFor(key, null);
        if (held && held.invalidReason !== "user_model_access" && held.recordedAtMs >= winner.recordedAt) continue;
        this.applyToLedger(() => ledger.recordInvalid(key, { invalidReason, recordedAtMs: winner.recordedAt, code: winner.state }, { host: "legacy" }));
        this.ended.delete(key);
        this.set(key, { state: winner.state, since: own?.state === winner.state ? Math.min(own.since, winner.since) : winner.since, recordedAt: winner.recordedAt });
        changedAny = true;
      } else if (own) {
        // Ended elsewhere after this runner's finding (a tie goes to the finding): it ends here too.
        const end = merged.end;
        this.applyToLedger(() => ledger.releaseInvalid(key, end.cause, { host: "legacy" }, (record) => record.code === own.state, end.at));
        this.ended.set(key, { at: end.at, cause: end.cause });
        this.set(key, null);
        changedAny = true;
      }
    }
    return changedAny;
  }

  /** Reads the other runners' files every `intervalMs`. */
  startSharedLoginSync(intervalMs: number = SHARED_LOGIN_SYNC_INTERVAL_MS): void {
    if (this.syncTimer !== null) return;
    const tick = () => {
      try {
        this.syncSharedLogins();
      } catch (error) {
        logger.warn(`[Daemon] shared login sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (this.options.timers) {
      this.syncTimer = this.options.timers.setInterval(tick, intervalMs);
      return;
    }
    const timer = setInterval(tick, intervalMs);
    // Never the reason the process stays alive.
    timer.unref?.();
    this.syncTimer = timer;
  }

  private applyToLedger(change: () => void): void {
    const before = this.seeding;
    this.seeding = true;
    try {
      change();
    } finally {
      this.seeding = before;
    }
  }

  /** The full snapshot to send: one login fact per stored entry. */
  report(): RuntimeReadinessReport {
    const facts: ReadinessFact[] = [...this.credentials].map(([key, entry]) => ({
      resource: { kind: "login", key },
      code: entry.state,
      behaviour: READINESS_CODE_SPEC[entry.state].behaviour,
      since: entry.since,
    }));
    return { seq: this.seq, facts };
  }

  entry(key: ProviderLimitCredentialKey): StoredEntry | undefined {
    return this.credentials.get(key);
  }

  /** Called after each change of the report (with a new `seq`). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    if (this.syncTimer !== null) {
      if (this.options.timers) this.options.timers.clearInterval(this.syncTimer);
      else clearInterval(this.syncTimer as ReturnType<typeof setInterval>);
      this.syncTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ledger = null;
  }

  private onLedgerChange(change: ProviderLimitChange): void {
    if (this.seeding) return;
    if (change.kind === "invalid_recorded") {
      // A finding for the whole credential replaces whatever the credential had.
      if (change.record.invalidReason === "user_model_access") return;
      const code = change.record.code;
      const current = this.credentials.get(change.key);
      if (!code) {
        // Replaced by a finding the readiness model does not track: the login
        // is still refused, so this is no end and leaves none for the other runners.
        if (current) this.set(change.key, null);
        return;
      }
      // A finding after an end: the end is history.
      this.ended.delete(change.key);
      this.set(change.key, { state: code, since: current?.state === code ? current.since : this.now(), recordedAt: change.record.recordedAtMs });
      return;
    }
    if (change.kind === "invalid_released") {
      const current = this.credentials.get(change.key);
      if (!current || change.record.code !== current.state) return;
      if (isSharedKey(change.key)) {
        // Kept for the other runners. Strictly after the finding it ends: at
        // the same instant a finding wins, and a copy of this finding in
        // another runner's file would then never end.
        const cause: RuntimeReadinessEndCause = change.cause === "model_changed" ? "model_output" : change.cause;
        this.ended.set(change.key, { at: Math.max(change.evidenceAtMs ?? this.now(), current.recordedAt + 1), cause });
      }
      this.set(change.key, null);
    }
  }

  /**
   * One entry changes; the file is written. Only a change of the report (a
   * state or since, not a newer recordedAt alone) takes a new `seq` and tells
   * the listeners, who send it.
   */
  private set(key: ProviderLimitCredentialKey, entry: StoredEntry | null): void {
    const before = this.credentials.get(key);
    if (entry) this.credentials.set(key, entry);
    else this.credentials.delete(key);
    const reportChanged = !before || !entry || before.state !== entry.state || before.since !== entry.since;
    if (!reportChanged) {
      this.persist();
      return;
    }
    this.bumpSeq();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        logger.error("[Daemon] runtime readiness listener failed", error);
      }
    }
  }

  private bumpSeq(): void {
    this.seq = Math.max(this.seq + 1, this.now());
    this.persist();
  }

  private persist(): void {
    const doc: RuntimeReadinessFile = {
      version: 1,
      seq: this.seq,
      credentials: Object.fromEntries(this.credentials),
      ...(this.ended.size > 0 ? { ended: Object.fromEntries(this.ended) } : {}),
    };
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
    writeJsonFileAtomic(this.options.file, doc);
  }
}
