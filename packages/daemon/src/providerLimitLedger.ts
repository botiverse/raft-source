// The provider limits the daemon knows of, per provider credential
// (#proj-raft-computer:#46, reconciler step 3b), and which credentials are
// invalid (step 4a: a rejected sign-in, a plan without the model, an
// exhausted billing balance). One ledger serves both agent
// hosts (RFC 060): the legacy host (AgentProcessManager) owns it and lends it
// to the OAR host, so an agent on either host hitting a limit on a shared
// sign-in holds the agents of both hosts on that sign-in, and a release on
// either host ends the wait on both.
//
// The ledger holds only the limits and invalid credentials and announces their
// changes; each host keeps its own waits (the legacy host's delivery backoffs
// and cooldowns, the OAR host's held deliveries) and applies a change
// announced by the other.

import {
  sharedCredentialsAuthRuntime,
  type AgentConfig,
  type CredentialInvalidReason as SharedCredentialInvalidReason,
  type ReadinessCode,
  type RuntimeAuthRuntime,
} from "@botiverse/raft-shared";
import { logger } from "./logger";

/**
 * The provider credential a usage or rate limit belongs to: limits are the
 * provider account's, not one agent's.
 * - `shared:<runtime>`: the runtime's machine-shared sign-in
 *   (`sharedCredentialsAuthRuntime`). Every agent on that sign-in shares one
 *   limit: one agent hitting it holds the others' deliveries too, and a web
 *   login or provider connect for the runtime ends it for all of them.
 * - `agent:<agentId>`: the agent's own credentials (own HOME / credential home,
 *   own API key, custom provider ...). The limit is that agent's alone.
 * Never put the key itself in a trace; report `providerLimitCredentialKeyKind`
 * and the runtime.
 */
export type ProviderLimitCredentialKey = `shared:${RuntimeAuthRuntime}` | `agent:${string}`;

/** Why a credential's provider limit was ended early (trace attr `release_cause`). */
export type ProviderLimitReleaseCause = "credentials_changed" | "model_output" | "explicit_stop";

/**
 * Why the current version of a credential is invalid (trace attr
 * `credential_invalid_reason`), from the runtime's own error:
 * - `user_reauth`: the provider rejected the sign-in or key (Codex "access
 *   token could not be refreshed", "invalid api key" ...).
 * - `user_model_access`: the plan does not include the model (only for that
 *   model: an agent on the same credential with another model is not held).
 * - `billing`: the billing or credit balance is exhausted.
 * The runtime process is not broken: it is kept, and deliveries wait.
 */
export type CredentialInvalidReason = SharedCredentialInvalidReason;

/**
 * Why a credential stopped counting as invalid (trace attr `release_cause`):
 * the credentials changed (web login, provider connect), a turn on it
 * produced model output, a person stopped the agent (Retry), or the agent's
 * model changed (`user_model_access` on the agent's own credential). The
 * server is told it (`agent:credential:restored`, `CredentialRestoredReleaseCause`).
 */
export type CredentialInvalidReleaseCause = ProviderLimitReleaseCause | "model_changed";

/**
 * Reconciler step 4b: an agent that showed an invalid record, as its own
 * runtime error (`own_error`: the agent the runtime rejected; the server may
 * have blocked its automatic wakes for it) or as the held notice (`notice`).
 * Kept with the record (and moved to the record that supersedes it); when the
 * record is released, the host of each such agent tells the server
 * (`agent:credential:restored`) with the reason the agent showed.
 */
export interface CredentialInvalidShown {
  agentId: string;
  host: "legacy" | "oar";
  reason: CredentialInvalidReason;
  shownAs: "own_error" | "notice";
}

export interface CredentialInvalidRecord {
  invalidReason: CredentialInvalidReason;
  /** `user_model_access` only: the model the plan does not include (none: the runtime's default). */
  model?: string;
  /** Model output proves the credential works only from a turn started after this. */
  recordedAtMs: number;
  /**
   * #proj-raft-computer:#68: the readiness code of the finding, when the
   * readiness model tracks it (`verification_required`): persisted and
   * reported by RuntimeReadinessStore.
   */
  code?: ReadinessCode;
}

/**
 * What a live agent shows of the invalid record holding it (each host keeps
 * one per agent):
 * - `own_error`: the agent saw the rejection itself and shows that error
 *   (with its `runtimeError.requiredAction`);
 * - `notice`: the agent is held for a record it did not see itself and shows
 *   the held notice (`formatCredentialInvalidHeldNotice`) as its idle status:
 *   no runtime error, so the server neither stores it as the agent's runtime
 *   error nor blocks the agent's wakes for it. `noticeKey`
 *   (`credentialInvalidNoticeKey`) is the record it was shown for: shown once
 *   per agent per record, not again when the same rejection is recorded again.
 */
export type CredentialInvalidVisibility = { kind: "own_error" } | { kind: "notice"; noticeKey: string };

/** Which record a held notice is about: the reason, and for `user_model_access` the model. */
export function credentialInvalidNoticeKey(record: CredentialInvalidRecord): string {
  return record.invalidReason === "user_model_access" ? `user_model_access:${invalidModelKey(record.model)}` : record.invalidReason;
}

/** The model a `user_model_access` record is about: none and empty are the runtime's default. */
function invalidModelKey(model: string | null | undefined): string {
  return typeof model === "string" ? model.trim() : "";
}

/** Whether an invalid record holds an agent of `model` on its credential. */
export function credentialInvalidAppliesToModel(record: CredentialInvalidRecord, model: string | null | undefined): boolean {
  return record.invalidReason !== "user_model_access" || invalidModelKey(record.model) === invalidModelKey(model);
}

export function providerLimitCredentialKey(agentId: string, config: AgentConfig): ProviderLimitCredentialKey {
  const sharedRuntime = sharedCredentialsAuthRuntime(config);
  return sharedRuntime ? `shared:${sharedRuntime}` : `agent:${agentId}`;
}

export function sharedProviderLimitCredentialKey(runtime: RuntimeAuthRuntime): ProviderLimitCredentialKey {
  return `shared:${runtime}`;
}

export function ownProviderLimitCredentialKey(agentId: string): ProviderLimitCredentialKey {
  return `agent:${agentId}`;
}

export function providerLimitCredentialKeyKind(key: ProviderLimitCredentialKey): "shared" | "agent" {
  return key.startsWith("shared:") ? "shared" : "agent";
}

/**
 * How long a provider limit whose wait is over is remembered for its attempts:
 * the longest single wait, so the store stays bounded and a limit quiet for
 * that long starts fresh.
 */
export const PROVIDER_LIMIT_ATTEMPT_MEMORY_MS = 60 * 60_000;

export interface ProviderLimitBackoffRecord {
  attempts: number;
  reason: string;
  untilMs: number;
  providerLimitKind: "quota_exhausted" | "transient_rate_limit";
  resetsAt?: string;
  /**
   * When the limit was recorded. Model output clears a shared credential's
   * limit only from a turn that started at or after this: output streamed by
   * a turn already running when another agent hit the limit is no proof the
   * account has quota again.
   */
  recordedAtMs: number;
}

/** The host (and agent) a ledger change came from; a host applies only the other host's changes to its own agents. */
export interface ProviderLimitChangeSource {
  host: "legacy" | "oar";
  agentId?: string;
}

export type ProviderLimitChange =
  | { kind: "recorded"; key: ProviderLimitCredentialKey; record: ProviderLimitBackoffRecord; source: ProviderLimitChangeSource }
  | { kind: "released"; key: ProviderLimitCredentialKey; record: ProviderLimitBackoffRecord; cause: ProviderLimitReleaseCause; source: ProviderLimitChangeSource }
  | {
    kind: "invalid_recorded";
    key: ProviderLimitCredentialKey;
    record: CredentialInvalidRecord;
    source: ProviderLimitChangeSource;
    /**
     * Reconciler step 15: the config of the agent the runtime rejected, when
     * the host knows it: where its credential lives (credentialDiskWatch.ts).
     * In memory only, never traced or sent.
     */
    recorderConfig?: AgentConfig;
  }
  | {
    kind: "invalid_released";
    key: ProviderLimitCredentialKey;
    record: CredentialInvalidRecord;
    cause: CredentialInvalidReleaseCause;
    source: ProviderLimitChangeSource;
    /** The agents that showed the record (its own error or the held notice), one entry per agent and reason. */
    shown: readonly CredentialInvalidShown[];
    /** See `releaseInvalid`'s `evidenceAtMs`. */
    evidenceAtMs?: number;
  };

export type ProviderLimitListener = (change: ProviderLimitChange) => void;

/** `entries` added to `current`, one per agent and reason; an agent's own error wins over a notice. */
function mergeShown(current: readonly CredentialInvalidShown[], entries: readonly CredentialInvalidShown[]): CredentialInvalidShown[] {
  const byAgentReason = new Map<string, CredentialInvalidShown>();
  for (const entry of [...current, ...entries]) {
    const id = `${entry.agentId}\u0000${entry.reason}`;
    const previous = byAgentReason.get(id);
    byAgentReason.set(id, previous?.shownAs === "own_error" ? { ...entry, shownAs: "own_error" } : entry);
  }
  return [...byAgentReason.values()];
}

export class ProviderLimitLedger {
  private readonly records = new Map<ProviderLimitCredentialKey, ProviderLimitBackoffRecord>();
  /**
   * Invalid credentials: per key, at most one record for the whole credential
   * (`user_reauth` or `billing`; the latest wins) and one `user_model_access`
   * record per model. No deadline: a record lasts until it is released.
   */
  private readonly invalid = new Map<ProviderLimitCredentialKey, CredentialInvalidRecord[]>();
  /** Per stored invalid record (by identity): the agents that showed it (`CredentialInvalidShown`). */
  private readonly shown = new Map<CredentialInvalidRecord, CredentialInvalidShown[]>();
  private readonly listeners = new Set<ProviderLimitListener>();

  /**
   * The credential's provider limit. It holds deliveries only while
   * `untilMs > nowMs`; after that it is kept, elapsed, for
   * PROVIDER_LIMIT_ATTEMPT_MEMORY_MS so the next wait restores its attempts
   * and the next hit keeps growing the wait (task #379). A record past that
   * window is removed by this read.
   */
  get(key: ProviderLimitCredentialKey, nowMs: number): ProviderLimitBackoffRecord | undefined {
    const record = this.records.get(key);
    if (record && record.untilMs + PROVIDER_LIMIT_ATTEMPT_MEMORY_MS <= nowMs) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /** Whether any limit is stored (elapsed ones included). */
  hasAny(): boolean {
    return this.records.size > 0;
  }

  /** Whether a limit is stored for `key`, without the pruning read. */
  has(key: ProviderLimitCredentialKey): boolean {
    return this.records.has(key);
  }

  /** Store a limit as is, announcing nothing. */
  set(key: ProviderLimitCredentialKey, record: ProviderLimitBackoffRecord): void {
    this.records.set(key, record);
  }

  /** Forget a limit, announcing nothing (an own credential's limit cleared by its only agent). */
  delete(key: ProviderLimitCredentialKey): boolean {
    return this.records.delete(key);
  }

  /**
   * A host recorded a limit on `key`: stored, and announced to both hosts.
   * A shorter limit never cuts a longer one still running on the key (a
   * transient throttle hit while the account's quota waits for its reset):
   * the later end stays, with its kind, reset and reason; the attempts are
   * the larger of both, and `recordedAtMs` is the new hit's (only a turn
   * started after it proves the account serves again). Returns the limit
   * now stored, which is what is announced.
   */
  record(key: ProviderLimitCredentialKey, record: ProviderLimitBackoffRecord, source: ProviderLimitChangeSource): ProviderLimitBackoffRecord {
    const current = this.records.get(key);
    let stored = record;
    if (current) {
      const attempts = Math.max(current.attempts, record.attempts);
      const keepsCurrentEnd = current.untilMs > record.recordedAtMs && current.untilMs > record.untilMs;
      stored = keepsCurrentEnd
        ? {
          attempts,
          reason: current.reason,
          untilMs: current.untilMs,
          providerLimitKind: current.providerLimitKind,
          ...(current.resetsAt ? { resetsAt: current.resetsAt } : {}),
          recordedAtMs: record.recordedAtMs,
        }
        : { ...record, attempts };
    }
    this.records.set(key, stored);
    this.announce({ kind: "recorded", key, record: stored, source });
    return stored;
  }

  /**
   * End the limit on `key` early (`cause`): deleted, and announced to both
   * hosts with the record it ended. Returns that record, or undefined when
   * none was stored (nothing is announced then).
   */
  release(key: ProviderLimitCredentialKey, cause: ProviderLimitReleaseCause, source: ProviderLimitChangeSource): ProviderLimitBackoffRecord | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    this.records.delete(key);
    this.announce({ kind: "released", key, record, cause, source });
    return record;
  }

  /**
   * The invalid record that holds an agent of `model` on `key`: one for the
   * whole credential first, else the `user_model_access` one for that model.
   */
  invalidFor(key: ProviderLimitCredentialKey, model: string | null | undefined): CredentialInvalidRecord | undefined {
    const records = this.invalid.get(key);
    if (!records) return undefined;
    return records.find((record) => record.invalidReason !== "user_model_access")
      ?? records.find((record) => credentialInvalidAppliesToModel(record, model));
  }

  /** Whether any credential is invalid. */
  hasAnyInvalid(): boolean {
    return this.invalid.size > 0;
  }

  /** Whether the credential `key` has any invalid record. */
  hasInvalid(key: ProviderLimitCredentialKey): boolean {
    return this.invalid.has(key);
  }

  /**
   * A host saw the credential `key` rejected: stored (replacing the record it
   * supersedes: the credential's own, or the same model's) and announced to
   * both hosts. Returns the stored record. `recorderConfig`: the rejected
   * agent's config, announced with the change (where its credential lives).
   */
  recordInvalid(
    key: ProviderLimitCredentialKey,
    record: CredentialInvalidRecord,
    source: ProviderLimitChangeSource,
    recorderConfig?: AgentConfig,
  ): CredentialInvalidRecord {
    const stored: CredentialInvalidRecord = record.invalidReason === "user_model_access"
      ? { invalidReason: "user_model_access", model: invalidModelKey(record.model), recordedAtMs: record.recordedAtMs, ...(record.code ? { code: record.code } : {}) }
      : { invalidReason: record.invalidReason, recordedAtMs: record.recordedAtMs, ...(record.code ? { code: record.code } : {}) };
    const current = this.invalid.get(key) ?? [];
    const kept = current.filter((each) => stored.invalidReason === "user_model_access"
      ? !(each.invalidReason === "user_model_access" && invalidModelKey(each.model) === stored.model)
      : each.invalidReason === "user_model_access");
    this.invalid.set(key, [...kept, stored]);
    // Who showed a superseded record still shows it (and the server may still
    // block them for it): they are told when the record replacing it ends.
    const carried = current.filter((each) => !kept.includes(each)).flatMap((each) => {
      const entries = this.shown.get(each) ?? [];
      this.shown.delete(each);
      return entries;
    });
    this.shown.set(stored, mergeShown(carried, source.agentId
      ? [{ agentId: source.agentId, host: source.host, reason: stored.invalidReason, shownAs: "own_error" }]
      : []));
    this.announce({ kind: "invalid_recorded", key, record: stored, source, ...(recorderConfig ? { recorderConfig } : {}) });
    return stored;
  }

  /**
   * Reconciler step 4b: an agent now shows the held notice for `record` (the
   * record `invalidFor` returned): it is told when the record is released.
   */
  noteInvalidShown(key: ProviderLimitCredentialKey, record: CredentialInvalidRecord, shown: CredentialInvalidShown): void {
    const stored = this.invalid.get(key)?.find((each) => each === record)
      ?? this.invalid.get(key)?.find((each) => credentialInvalidNoticeKey(each) === credentialInvalidNoticeKey(record));
    if (!stored) return;
    this.shown.set(stored, mergeShown(this.shown.get(stored) ?? [], [shown]));
  }

  /**
   * The credential `key` counts as valid again (`cause`): its records are
   * deleted and each is announced to both hosts. `only` narrows the release
   * to the records it accepts (model output proves only the credential and
   * the model it came from; a model change ends only that model's record).
   * Returns the records released. `evidenceAtMs` (#proj-raft-computer:#69):
   * when the evidence behind the release was produced, if not now: for model
   * output, the start of the turn that produced it. RuntimeReadinessStore
   * keeps it as the end's time, so another runner's finding recorded after
   * that turn started is not taken as ended.
   */
  releaseInvalid(
    key: ProviderLimitCredentialKey,
    cause: CredentialInvalidReleaseCause,
    source: ProviderLimitChangeSource,
    only: (record: CredentialInvalidRecord) => boolean = () => true,
    evidenceAtMs?: number,
  ): CredentialInvalidRecord[] {
    const records = this.invalid.get(key);
    if (!records) return [];
    const released = records.filter(only);
    if (released.length === 0) return [];
    const kept = records.filter((record) => !released.includes(record));
    if (kept.length > 0) this.invalid.set(key, kept);
    else this.invalid.delete(key);
    for (const record of released) {
      const shown = this.shown.get(record) ?? [];
      this.shown.delete(record);
      this.announce({ kind: "invalid_released", key, record, cause, source, shown, ...(evidenceAtMs !== undefined ? { evidenceAtMs } : {}) });
    }
    return released;
  }

  subscribe(listener: ProviderLimitListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private announce(change: ProviderLimitChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        // One host failing to apply a change never keeps it from the other.
        logger.error(`[Daemon] provider limit ${change.kind} listener failed`, error);
      }
    }
  }
}
