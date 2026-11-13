// Reconciler step 15 (B7 / B8 / B9, task #48): a credential held invalid is
// released when it changes on disk (a terminal `codex login`, `claude login`,
// `grok login` ...), the same way a web login releases it.
//
// While any invalid record is held (only then), every
// CREDENTIAL_DISK_CHECK_INTERVAL_MS the source of each held credential is
// checked: a file's `stat` first, its content read and hashed only when the
// stat changed (a `touch` with the same bytes is no change); a directory's
// entries; a macOS Keychain item's modification date (attributes only, never
// the secret). What is compared is the fingerprint taken when the credential
// was first recorded invalid: a present source that differs from it releases
// the credential (`releaseInvalid(key, "credentials_changed")`, the cause a
// web login releases with: both hosts' release paths, the server lift and the
// account-switch restart follow from it). A missing source (a logout) never
// releases. Provider limits are not released (Q-3: a token refresh is the
// same account with the same quota).
//
// PR 3 (shared homes): after a daemon restart no record is held, but the
// server may still pause agents on a runtime's machine-shared sign-in. While
// `setSharedHomesActive(true)` (a connected server that reads the change),
// the same tick also checks the shared credential source of each runtime in
// `setSharedHomes`, the same way (stat first, hash on a stat change, Keychain
// attributes only). Here what is compared is the last state seen: each
// present source that differs from it calls `onSharedCredentialsChanged`
// once (a missing source never does), at most once per runtime every
// SHARED_CREDENTIALS_CHANGE_MIN_GAP_MS (a change within the gap is reported
// when it ends), so a source that churns costs one status query per gap.
//
// Fingerprints, digests and paths stay in this object's memory: a trace
// carries the runtime, the key kind and the source kind only.

import os from "node:os";
import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";
import {
  agentCredentialEnv,
  credentialSourceFor,
  credentialSourceKinds,
  dirState,
  fileDigest,
  fileStatKey,
  keychainState,
  NODE_CREDENTIAL_FS,
  onOwnCredentialWrite,
  raftRuntimeOfAuthRuntime,
  type CredentialEnv,
  type CredentialFs,
  type CredentialPartState,
  type CredentialSource,
  type CredentialSourcePart,
  type SecurityCommandRunner,
} from "./credentialSource";
import {
  providerLimitCredentialKeyKind,
  type ProviderLimitChange,
  type ProviderLimitCredentialKey,
  type ProviderLimitLedger,
} from "./providerLimitLedger";
import { logger } from "./logger";

export const CREDENTIAL_DISK_CHECK_INTERVAL_MS = 30_000;
/** The least time between two shared-home changes reported for one runtime (each costs a status query). */
export const SHARED_CREDENTIALS_CHANGE_MIN_GAP_MS = 5 * 60_000;

export interface CredentialDiskWatchDeps {
  ledger: ProviderLimitLedger;
  recordEvent: (name: string, attrs: Record<string, unknown>) => void;
  /** The daemon's own env (a shared sign-in's, and the base under an agent's own env vars). */
  baseEnv: () => CredentialEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  fs?: CredentialFs;
  /** `/usr/bin/security` with attribute-only args (macOS Claude). */
  runSecurity?: SecurityCommandRunner;
  intervalMs?: number;
  /**
   * A runtime's machine-shared credential changed on disk (present and
   * different from the last state seen). Only while the shared homes are active.
   */
  onSharedCredentialsChanged?: (runtime: RuntimeAuthRuntime) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface WatchedPart {
  part: CredentialSourcePart;
  /** The state when the credential was recorded invalid (or the daemon's own last write): what a change is measured from. */
  baseline: CredentialPartState | null;
  /** File parts: the stat key the last digest was taken at, and that digest. */
  lastStatKey?: string;
  lastState?: CredentialPartState;
}

interface WatchedCredential {
  key: ProviderLimitCredentialKey;
  source: CredentialSource;
  parts: WatchedPart[];
}

/** A runtime's machine-shared credential source; `baseline` on each part is the last state seen. */
interface WatchedSharedHome {
  runtime: RuntimeAuthRuntime;
  source: CredentialSource;
  parts: WatchedPart[];
  /** A change not reported yet (inside the gap after the last report). */
  pending: boolean;
  lastReportedAtMs: number | null;
}

function sameState(a: CredentialPartState, b: CredentialPartState): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "present" || a.digest === (b as Extract<CredentialPartState, { kind: "present" }>).digest;
}

export class CredentialDiskWatch {
  private readonly watched = new Map<ProviderLimitCredentialKey, WatchedCredential>();
  private readonly shared = new Map<RuntimeAuthRuntime, WatchedSharedHome>();
  private sharedActive = false;
  private readonly fs: CredentialFs;
  private readonly intervalMs: number;
  private timer: unknown = null;
  private checking: Promise<void> | null = null;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: CredentialDiskWatchDeps) {
    this.fs = deps.fs ?? NODE_CREDENTIAL_FS;
    this.intervalMs = deps.intervalMs ?? CREDENTIAL_DISK_CHECK_INTERVAL_MS;
    this.unsubscribe.push(deps.ledger.subscribe((change) => this.onLedgerChange(change)));
    this.unsubscribe.push(onOwnCredentialWrite((target) => this.onOwnWrite(target)));
  }

  /** Whether the periodic check runs (only while a watched credential is held, or shared homes are active). */
  get running(): boolean {
    return this.timer !== null;
  }

  /** The runtimes whose shared credential source is watched now (empty while inactive). */
  get sharedRuntimes(): RuntimeAuthRuntime[] {
    return this.sharedActive ? [...this.shared.keys()] : [];
  }

  /**
   * The runtimes whose machine-shared credential source to watch (detected
   * here and read by the server). A runtime kept from the previous set keeps
   * its last state, so a sign-in while the server was away is still seen; a
   * new one is read now, and only a change after this counts.
   */
  setSharedHomes(runtimes: readonly RuntimeAuthRuntime[]): void {
    const wanted = new Set(runtimes);
    for (const runtime of [...this.shared.keys()]) if (!wanted.has(runtime)) this.shared.delete(runtime);
    for (const runtime of wanted) {
      if (this.shared.has(runtime)) continue;
      const source = credentialSourceFor(raftRuntimeOfAuthRuntime(runtime), this.locationContext(this.deps.baseEnv()));
      if (!source) continue;
      const home: WatchedSharedHome = { runtime, source, parts: source.parts.map((part) => ({ part, baseline: null })), pending: false, lastReportedAtMs: null };
      this.shared.set(runtime, home);
      this.takeBaselines(home.parts, () => this.shared.get(runtime) === home);
    }
    this.syncTimer();
  }

  /** Whether the shared homes are checked: only while a connected server reads the change. */
  setSharedHomesActive(active: boolean): void {
    this.sharedActive = active;
    this.syncTimer();
  }

  /** How many held credentials have a watched source. */
  get watchedCount(): number {
    return this.watched.size;
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.watched.clear();
    this.shared.clear();
    this.syncTimer();
  }

  /** One check of every watched source (the timer's tick; tests call it directly). */
  check(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.checkAll().finally(() => { this.checking = null; });
    return this.checking;
  }

  private onLedgerChange(change: ProviderLimitChange): void {
    if (change.kind === "invalid_recorded") {
      // The first record of a held credential fixes the fingerprint: a
      // rejection recorded again while it is held (a turn already in flight
      // with the old token) must not take a re-login's new file as the bad one.
      if (!this.watched.has(change.key)) this.watch(change);
      return;
    }
    if (change.kind === "invalid_released" && !this.deps.ledger.hasInvalid(change.key)) {
      this.watched.delete(change.key);
      this.syncTimer();
    }
  }

  private watch(change: Extract<ProviderLimitChange, { kind: "invalid_recorded" }>): void {
    const source = this.sourceOf(change);
    if (!source) return;
    const watched: WatchedCredential = { key: change.key, source, parts: source.parts.map((part) => ({ part, baseline: null })) };
    this.watched.set(change.key, watched);
    this.takeBaselines(watched.parts, () => this.watched.get(change.key) === watched);
    this.syncTimer();
  }

  private takeBaselines(parts: WatchedPart[], stillWatched: () => boolean): void {
    for (const part of parts) {
      if (part.part.kind === "keychain") {
        // Async: until it answers, the check takes its first answer as the baseline.
        void this.readPart(part).then((state) => {
          if (stillWatched() && part.baseline === null) part.baseline = state;
        });
      } else {
        part.baseline = this.readPartSync(part);
      }
    }
  }

  private locationContext(env: CredentialEnv) {
    return {
      env,
      homeDir: this.deps.homeDir ?? os.homedir(),
      platform: this.deps.platform ?? process.platform,
      cwd: this.deps.cwd ?? process.cwd(),
    };
  }

  private sourceOf(change: Extract<ProviderLimitChange, { kind: "invalid_recorded" }>): CredentialSource | null {
    const baseEnv = this.deps.baseEnv();
    const ctx = (env: CredentialEnv) => this.locationContext(env);
    if (providerLimitCredentialKeyKind(change.key) === "shared") {
      // A shared sign-in is the daemon's own (its web login writes there).
      const authRuntime = change.key.slice("shared:".length) as RuntimeAuthRuntime;
      return credentialSourceFor(raftRuntimeOfAuthRuntime(authRuntime), ctx(baseEnv));
    }
    // An agent's own credential: where its runtime looks, under its own env (B8).
    const config = change.recorderConfig;
    if (!config) return null;
    return credentialSourceFor(config.runtime || "claude", ctx(agentCredentialEnv(config, baseEnv)));
  }

  private syncTimer(): void {
    const wanted = this.watched.size > 0 || (this.sharedActive && this.shared.size > 0);
    if (wanted && this.timer === null) {
      const set = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
      this.timer = set(() => { void this.check(); }, this.intervalMs);
      (this.timer as { unref?: () => void } | null)?.unref?.();
    } else if (!wanted && this.timer !== null) {
      (this.deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.timer);
      this.timer = null;
    }
  }

  /** A file: hashed only when its stat changed since the last read; a directory: its entries. */
  private readPartSync(watched: WatchedPart): CredentialPartState {
    const { part } = watched;
    if (part.kind === "dir") return dirState(part.path, part.entries, this.fs);
    if (part.kind === "keychain") return { kind: "unreadable" };
    const statKey = fileStatKey(part.path, this.fs);
    if (statKey === "absent") return this.remember(watched, statKey, { kind: "absent" });
    if (statKey === "unreadable") return { kind: "unreadable" };
    if (watched.lastStatKey === statKey && watched.lastState) return watched.lastState;
    return this.remember(watched, statKey, fileDigest(part.path, this.fs));
  }

  private remember(watched: WatchedPart, statKey: string, state: CredentialPartState): CredentialPartState {
    watched.lastStatKey = statKey;
    watched.lastState = state;
    return state;
  }

  private async readPart(watched: WatchedPart): Promise<CredentialPartState> {
    if (watched.part.kind !== "keychain") return this.readPartSync(watched);
    if (!this.deps.runSecurity) return { kind: "unreadable" };
    return keychainState(watched.part.service, this.deps.runSecurity);
  }

  private async checkAll(): Promise<void> {
    for (const watched of [...this.watched.values()]) {
      if (this.watched.get(watched.key) !== watched) continue;
      let changed = false;
      for (const part of watched.parts) {
        const now = await this.readPart(part);
        if (this.watched.get(watched.key) !== watched) break;
        if (part.baseline === null || part.baseline.kind === "unreadable") {
          // Nothing known to compare with yet: this answer is the baseline.
          part.baseline = now;
          continue;
        }
        // A missing source is a logout: it never releases. An unreadable one tells nothing.
        if (now.kind === "present" && !sameState(now, part.baseline)) changed = true;
      }
      if (changed && this.watched.get(watched.key) === watched) this.release(watched);
    }
    if (this.sharedActive) await this.checkSharedHomes();
  }

  private async checkSharedHomes(): Promise<void> {
    for (const home of [...this.shared.values()]) {
      if (this.shared.get(home.runtime) !== home) continue;
      for (const part of home.parts) {
        const now = await this.readPart(part);
        if (this.shared.get(home.runtime) !== home) break;
        // An unreadable answer tells nothing and keeps the last state.
        if (now.kind === "unreadable") continue;
        const before = part.baseline;
        part.baseline = now;
        if (before === null || before.kind === "unreadable") continue;
        // A missing source is a logout: never reported.
        if (now.kind === "present" && !sameState(now, before)) home.pending = true;
      }
      if (!this.sharedActive || this.shared.get(home.runtime) !== home || !home.pending) continue;
      const nowMs = (this.deps.now ?? Date.now)();
      if (home.lastReportedAtMs !== null && nowMs - home.lastReportedAtMs < SHARED_CREDENTIALS_CHANGE_MIN_GAP_MS) continue;
      home.pending = false;
      home.lastReportedAtMs = nowMs;
      this.deps.recordEvent("daemon.credential.shared_disk_change", {
        runtime: home.source.runtime,
        credential_key_kind: "shared",
        source_kind: credentialSourceKinds(home.source),
      });
      try {
        this.deps.onSharedCredentialsChanged?.(home.runtime);
      } catch (error) {
        logger.warn(`[Daemon] ${home.source.runtime} shared credential change not handled: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private release(watched: WatchedCredential): void {
    let released: ReturnType<ProviderLimitLedger["releaseInvalid"]> = [];
    try {
      released = this.deps.ledger.releaseInvalid(watched.key, "credentials_changed", { host: "legacy" });
    } finally {
      // Released (the listener already dropped it), or nothing was left to release.
      if (this.watched.get(watched.key) === watched) {
        this.watched.delete(watched.key);
        this.syncTimer();
      }
    }
    if (released.length === 0) return;
    this.deps.recordEvent("daemon.credential.disk_change_release", {
      runtime: watched.source.runtime,
      credential_key_kind: providerLimitCredentialKeyKind(watched.key),
      source_kind: credentialSourceKinds(watched.source),
      release_cause: "credentials_changed",
      credential_invalid_released: released.length,
      credential_invalid_reason: released.map((each) => each.invalidReason).join(","),
    });
    logger.info(`[Daemon] ${watched.source.runtime} credentials changed on disk; ${released.length} invalid record(s) released`);
  }

  /** The daemon rewrote `target` itself (Kimi's token refresh): that content is the new baseline, not a user's sign-in. */
  private onOwnWrite(target: string): void {
    for (const watched of [...this.watched.values(), ...this.shared.values()]) {
      for (const part of watched.parts) {
        if (part.part.kind === "keychain") continue;
        const covers = part.part.kind === "file" ? part.part.path === target : target.startsWith(`${part.part.path}/`) || target.startsWith(`${part.part.path}\\`);
        if (covers) part.baseline = this.readPartSync(part);
      }
    }
  }
}
