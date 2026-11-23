// #wg-rbac:#27 runner credential renewal (daemon capability
// `runner-credential-renew:v1`). A daemon declaring it gets runner credentials
// (`AgentConfig.agentCredentialKey`) that expire 7 days after they are issued;
// it renews each one a live launch holds at its half-life, and after a 401
// `agent_credential_expired` (then retries that request once).
//
// Who holds a key: only this daemon process. The agent's runtime never sees
// it (cliTransport.ts gives the runtime a local proxy token; managed MCP runs
// a local proxy, or in-process tools for Pi). The hosts keep the launch's
// FIRST key and id in its config (`agentCredentialKey/Id`), and that config is
// copied into restart snapshots, rebinds and queued starts. So a renewal does
// not rewrite configs: it records a lineage (first key -> next key -> ...),
// and every place that sends a key resolves the current one at use time
// (`currentRunnerCredentialKey`: the credential proxy, the daemon's own
// as-agent requests, managed MCP). The lineage also answers what is held
// (`heldRunnerCredentialIdsWithRenewals`, for `ready`) and what a launch end
// revokes (`runnerCredentialLineageIds`: every id the launch's key became).
//
// Module state, like the credential proxy's registrations: one daemon core per
// process installs the renewer (`installRunnerCredentialRenewer`).

import { createHash } from "node:crypto";

/** 401 code of an expired agent key (server: AGENT_CREDENTIAL_EXPIRED_CODE). */
export const AGENT_CREDENTIAL_EXPIRED_CODE = "agent_credential_expired";
/** At most how long a renewed key keeps working (server: RUNNER_CREDENTIAL_RENEW_OVERLAP_MS). */
export const RUNNER_CREDENTIAL_RENEW_OVERLAP_MS = 5 * 60_000;
/** Renewal fires at half-life +/- this fraction of it. */
export const RUNNER_CREDENTIAL_RENEW_JITTER = 0.1;
/** First wait before trying again after a 5xx, a not-yet-declared capability or a failed mint; doubles per failure. */
export const RUNNER_CREDENTIAL_RENEW_RETRY_MS = 60_000;
/** The longest wait between attempts (an offline machine tries about twice an hour, not every minute). */
export const RUNNER_CREDENTIAL_RENEW_RETRY_MAX_MS = 30 * 60_000;
/**
 * Waits after a 403 `runner_credential_renew_not_declared` (the server has not
 * yet seen this connection's `ready`, e.g. just after waking): short at first,
 * then the normal backoff. Never a mint: one now would get a key that never
 * expires.
 */
export const RUNNER_CREDENTIAL_NOT_DECLARED_RETRY_MS = [5_000, 10_000, 20_000] as const;
/** A Retry-After below this is raised to it (Retry-After: 0 must not spin). */
export const RUNNER_CREDENTIAL_RENEW_RETRY_AFTER_MIN_MS = 5_000;
/** Within this of expiry a renewal the server cannot take now (429, 5xx, capability not yet seen) mints afresh instead of waiting. */
export const RUNNER_CREDENTIAL_FRESH_MINT_WITHIN_MS = 10 * 60_000;
const RENEW_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How often renewals whose time has come are looked for by the wall clock.
 * Timers run on a monotonic clock that stops while the machine sleeps, so a
 * laptop asleep past a key's half-life (or expiry) would otherwise wait out
 * the timer's remaining awake time.
 */
export const RUNNER_CREDENTIAL_RENEW_SWEEP_MS = 60_000;

export type RunnerCredential = {
  apiKey: string;
  credentialId: string | null;
  /** ISO; null: never expires (the server did not see the capability). */
  expiresAt: string | null;
};

export type RunnerCredentialRenewTrigger = "half_life" | "expired_401" | "wake_hints_expired";
export type RunnerCredentialRenewOutcome =
  | "renewed"
  | "fallback_mint"
  | "expired_retry"
  | "expired_no_renew"
  | "rate_limited"
  | "failed";

/** A mint response body (`POST .../credentials`), or null when it carries no usable key. */
export function parseRunnerCredentialMintBody(body: unknown): RunnerCredential | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.apiKey !== "string" || !record.apiKey.startsWith("sk_agent_")) return null;
  return {
    apiKey: record.apiKey,
    credentialId: typeof record.credentialId === "string" ? record.credentialId : null,
    expiresAt: typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt)) ? record.expiresAt : null,
  };
}

type LineageNode = {
  /** Emptied once a replaced (not first) key's overlap ends: the raw key is not kept longer than it works. */
  apiKey: string;
  credentialId: string;
  /** The launch's first credential id: what the hosts hold in their configs. */
  rootId: string;
  /** The launch's first node: its lineage is forgotten from here. */
  root: LineageNode | null;
  agentId: string;
  runtime: string;
  issuedAtMs: number;
  expiresAtMs: number | null;
  next: LineageNode | null;
  /** Set once replaced: until when the replaced key still authenticates. */
  replacedUntilMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Drops a replaced key from the lookup once its overlap ends. */
  dropTimer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<string | null> | null;
  /** Transient failures in a row: the retry wait doubles with each. */
  failures: number;
  /** 403 runner_credential_renew_not_declared answers in a row. */
  notDeclared: number;
  /** The launch ended (or the renewer was uninstalled): nothing may be swapped in or scheduled. */
  forgotten: boolean;
  /** Wall-clock time the scheduled attempt is due (the sweep runs it if the timer is late). */
  dueAtMs: number | null;
  /** sha256 of this key once it left the lookup (`droppedKeyNodes`). */
  droppedKeyHash: string | null;
};

const nodesByKey = new Map<string, LineageNode>();
const nodesById = new Map<string, LineageNode>();
/**
 * Replaced keys that left the lookup, by sha256 (never the raw key): a request
 * or a stream that still used one resolves to its lineage's current key, so its
 * expiry is not mistaken for an untracked key's.
 */
const droppedKeyNodes = new Map<string, LineageNode>();
/** Proxy registrations name the launch a key serves (trace attrs only). */
const launchIdByRootKey = new Map<string, string>();

export type RunnerCredentialRenewerDeps = {
  serverUrl: string;
  /** The Computer's own key: renewals authenticate as the mint does. */
  computerKey: () => string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** A new runner credential, as a start mints one (one attempt; the renewer retries). */
  freshMint: (agentId: string, runtime: string) => Promise<RunnerCredential>;
  /** Revoke one credential (runnerCredentialRevoke.ts): one issued for a launch that ended meanwhile. */
  revoke: (agentId: string, credentialId: string) => void;
  /** Whether a live launch or start still holds the launch credential `rootId`. */
  isHeld: (rootId: string) => boolean;
  recordEvent: (name: string, attrs: Record<string, unknown>, status: "ok" | "error") => void;
  now?: () => number;
  random?: () => number;
};

let renewer: RunnerCredentialRenewerDeps | null = null;

function now(): number {
  return renewer?.now?.() ?? Date.now();
}

/** Installs the daemon's renewer; returns its uninstall (clears every timer and the lineage). */
export function installRunnerCredentialRenewer(deps: RunnerCredentialRenewerDeps): () => void {
  resetLineage();
  renewer = deps;
  const sweep = setInterval(runOverdueAttempts, RUNNER_CREDENTIAL_RENEW_SWEEP_MS);
  sweep.unref?.();
  return () => {
    clearInterval(sweep);
    if (renewer !== deps) return;
    resetLineage();
    renewer = null;
  };
}

/** Runs every attempt whose wall-clock time has passed while its timer has not fired (the machine slept). */
function runOverdueAttempts(): void {
  const at = now();
  for (const node of [...nodesById.values()]) {
    if (node.forgotten || node.next || node.inflight || node.dueAtMs === null || node.dueAtMs > at) continue;
    if (node.timer) clearTimeout(node.timer);
    node.timer = null;
    node.dueAtMs = null;
    void attempt(node, "half_life");
  }
}

function resetLineage(): void {
  for (const node of nodesById.values()) retire(node);
  nodesByKey.clear();
  nodesById.clear();
  droppedKeyNodes.clear();
  launchIdByRootKey.clear();
}

function retire(node: LineageNode): void {
  if (node.timer) clearTimeout(node.timer);
  if (node.dropTimer) clearTimeout(node.dropTimer);
  node.timer = null;
  node.dropTimer = null;
  node.dueAtMs = null;
  node.forgotten = true;
}

export function __resetRunnerCredentialRenewalForTest(): void {
  resetLineage();
  renewer = null;
}

/** Entries the lineage still keeps (tests: a forgotten launch leaves none). */
export function __runnerCredentialLineageSizeForTest(): { keys: number; ids: number; dropped: number } {
  return { keys: nodesByKey.size, ids: nodesById.size, dropped: droppedKeyNodes.size };
}

/**
 * A runner credential was minted for `agentId`: renew it at its half-life
 * while a launch holds it. Untracked (nothing to do) without a renewer, an id
 * or an expiry.
 */
export function trackRunnerCredential(input: { agentId: string; runtime: string; credential: RunnerCredential }): void {
  const { credential } = input;
  if (!renewer || !credential.credentialId || !credential.expiresAt) return;
  if (nodesByKey.has(credential.apiKey)) return;
  const node = newNode(credential, input.agentId, input.runtime, null);
  index(node);
  scheduleHalfLife(node);
}

function newNode(credential: RunnerCredential, agentId: string, runtime: string, root: LineageNode | null): LineageNode {
  return {
    apiKey: credential.apiKey,
    credentialId: credential.credentialId!,
    rootId: root?.credentialId ?? credential.credentialId!,
    root,
    agentId,
    runtime,
    issuedAtMs: now(),
    expiresAtMs: credential.expiresAt ? Date.parse(credential.expiresAt) : null,
    next: null,
    replacedUntilMs: null,
    timer: null,
    dropTimer: null,
    inflight: null,
    failures: 0,
    notDeclared: 0,
    forgotten: false,
    dueAtMs: null,
    droppedKeyHash: null,
  };
}

function rootOf(node: LineageNode): LineageNode {
  return node.root ?? node;
}

/** The credential proxy registered `apiKey` for `launchId` (named on renewal events). */
export function noteRunnerCredentialLaunch(apiKey: string, launchId: string | null | undefined): void {
  if (launchId && nodesByKey.has(apiKey)) launchIdByRootKey.set(apiKey, launchId);
}

function index(node: LineageNode): void {
  nodesByKey.set(node.apiKey, node);
  nodesById.set(node.credentialId, node);
}

function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** The node of a key a launch was given or renewed into, including a replaced key past its overlap. */
function lookupNode(apiKey: string): LineageNode | undefined {
  return nodesByKey.get(apiKey) ?? (droppedKeyNodes.size > 0 ? droppedKeyNodes.get(keyHash(apiKey)) : undefined);
}

function tail(node: LineageNode): LineageNode {
  let current = node;
  while (current.next) current = current.next;
  return current;
}

/** The key to send now for a key a launch was given (itself when never renewed). */
export function currentRunnerCredentialKey(apiKey: string): string {
  const node = lookupNode(apiKey);
  return node ? tail(node).apiKey : apiKey;
}

/** `credentialId` and every id it was renewed or re-minted into, oldest first. */
export function runnerCredentialLineageIds(credentialId: string): string[] {
  const ids: string[] = [credentialId];
  let node = nodesById.get(credentialId)?.next ?? null;
  while (node) {
    ids.push(node.credentialId);
    node = node.next;
  }
  return ids;
}

/**
 * The ids the hosts hold (their launches' first ids), as `ready` reports them:
 * each launch's current id, and a replaced one only while it still
 * authenticates (the renewal overlap, at most 5 minutes). After that the
 * server may revoke it as unheld, which only ends what already expired.
 */
export function heldRunnerCredentialIdsWithRenewals(hostIds: readonly string[]): string[] {
  const at = now();
  const ids = new Set<string>();
  for (const id of hostIds) {
    let node = nodesById.get(id);
    if (!node) {
      ids.add(id);
      continue;
    }
    while (node) {
      if (!node.next || (node.replacedUntilMs !== null && node.replacedUntilMs > at)) ids.add(node.credentialId);
      node = node.next ?? undefined;
    }
  }
  return [...ids];
}

/** The launch holding `credentialId` ended (its credentials are being revoked): stop renewing them. */
export function forgetRunnerCredentialLineage(credentialId: string): void {
  const node = nodesById.get(credentialId);
  if (node) forgetFrom(node);
}

/** Forgets every node from `node` on: no timer, no lookup entry, never swapped into again. */
function forgetFrom(node: LineageNode | null): void {
  while (node) {
    retire(node);
    if (nodesByKey.get(node.apiKey) === node) nodesByKey.delete(node.apiKey);
    if (nodesById.get(node.credentialId) === node) nodesById.delete(node.credentialId);
    if (node.droppedKeyHash && droppedKeyNodes.get(node.droppedKeyHash) === node) droppedKeyNodes.delete(node.droppedKeyHash);
    launchIdByRootKey.delete(node.apiKey);
    node = node.next;
  }
}

/** Current (unreplaced) tracked credentials that expire: the `ready` event's count. */
export function expiringRunnerCredentialCount(): number {
  let count = 0;
  for (const node of nodesById.values()) if (!node.next && node.expiresAtMs !== null) count += 1;
  return count;
}

/**
 * Sends a request with a runner key: the current one for `apiKey`. A 401
 * `agent_credential_expired` renews it (or mints afresh when renewal is
 * refused) and sends the request once more with the new key; any other 401
 * is returned as is. `send` must be callable twice (a replayable body).
 */
export async function fetchWithRunnerCredential(
  apiKey: string,
  send: (key: string) => Promise<Response>,
): Promise<Response> {
  const used = currentRunnerCredentialKey(apiKey);
  const response = await send(used);
  if (response.status !== 401 || !(await isExpiredRefusal(response))) return response;
  const next = await renewExpiredRunnerCredential(used);
  if (!next || next === used) return response;
  await response.body?.cancel().catch(() => undefined);
  return send(next);
}

async function isExpiredRefusal(response: Response): Promise<boolean> {
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  return body?.code === AGENT_CREDENTIAL_EXPIRED_CODE;
}

/**
 * `usedKey` was refused as expired: the key to retry with, or null when none
 * can be had (the request is answered with the 401). A key already replaced
 * is answered with its successor, without a renewal.
 */
export function renewExpiredRunnerCredential(usedKey: string): Promise<string | null> {
  return renewKey(usedKey, "expired_401");
}

/** The agent's wake-hint stream ended `credential-expired` for `usedKey`: renew before it reconnects. */
export function noteRunnerCredentialStreamExpired(usedKey: string): void {
  void renewKey(usedKey, "wake_hints_expired");
}

async function renewKey(usedKey: string, trigger: RunnerCredentialRenewTrigger): Promise<string | null> {
  if (!renewer) return null;
  const node = lookupNode(usedKey);
  if (!node) {
    renewer.recordEvent("daemon.runner_credential.renew", {
      outcome: "expired_no_renew" satisfies RunnerCredentialRenewOutcome,
      trigger,
      reason: "untracked_credential",
    }, "error");
    return null;
  }
  // Already replaced: a request is retried with the current key, and a stream
  // that ended for the old key needs nothing (its reconnect uses the current one).
  if (node.next) return tail(node).apiKey;
  return attempt(node, trigger);
}

function attempt(node: LineageNode, trigger: RunnerCredentialRenewTrigger): Promise<string | null> {
  if (node.inflight) return node.inflight;
  const run = runAttempt(node, trigger).finally(() => {
    node.inflight = null;
  });
  node.inflight = run;
  return run;
}

function scheduleHalfLife(node: LineageNode): void {
  if (!renewer || node.expiresAtMs === null || node.forgotten) return;
  const halfLife = (node.expiresAtMs - node.issuedAtMs) / 2;
  const random = renewer.random?.() ?? Math.random();
  const jittered = halfLife * (1 + (random * 2 - 1) * RUNNER_CREDENTIAL_RENEW_JITTER);
  scheduleAttempt(node, Math.max(0, node.issuedAtMs + jittered - now()));
}

function scheduleAttempt(node: LineageNode, delayMs: number): void {
  if (node.forgotten) return;
  if (node.timer) clearTimeout(node.timer);
  node.dueAtMs = now() + delayMs;
  node.timer = setTimeout(() => {
    node.timer = null;
    node.dueAtMs = null;
    if (node.forgotten || node.next) return;
    void attempt(node, "half_life");
  }, delayMs);
  node.timer.unref?.();
}

/** The wait after `node`'s latest transient failure: 60 s, doubling, at most 30 minutes. */
function backoffMs(node: LineageNode): number {
  return Math.min(RUNNER_CREDENTIAL_RENEW_RETRY_MS * 2 ** Math.max(0, node.failures - 1), RUNNER_CREDENTIAL_RENEW_RETRY_MAX_MS);
}

type AttemptEvent = {
  outcome: RunnerCredentialRenewOutcome;
  http_status?: number;
  refusal_code?: string;
  new_credential_id?: string | null;
  /** Whether the new key expires: false when a fallback mint got a key that never does. */
  new_expires?: boolean;
  swap_path?: "renewed" | "fallback_mint";
  retry_in_ms?: number;
  reason?: string;
  revoked_credential_id?: string;
};

async function runAttempt(node: LineageNode, trigger: RunnerCredentialRenewTrigger): Promise<string | null> {
  const deps = renewer;
  if (!deps) return null;
  const startedAt = now();
  const msToExpiry = node.expiresAtMs === null ? null : node.expiresAtMs - startedAt;
  const emit = (event: AttemptEvent): void => {
    const failed = event.outcome === "failed" || event.outcome === "expired_no_renew";
    const swapped = event.outcome === "renewed" || event.outcome === "fallback_mint";
    deps.recordEvent("daemon.runner_credential.renew", {
      agentId: node.agentId,
      launchId: launchIdByRootKey.get(rootOf(node).apiKey),
      trigger,
      old_credential_id: node.credentialId,
      ...(msToExpiry === null ? {} : { ms_to_expiry: msToExpiry }),
      ...event,
      outcome: trigger !== "half_life" && swapped ? "expired_retry" : event.outcome,
      ...(trigger !== "half_life" && swapped ? { swap_path: event.outcome } : {}),
    }, failed ? "error" : "ok");
  };
  // The launch still holds this lineage and the renewer is still the one that
  // started: checked before the request and again after every await, so a
  // launch that ended meanwhile (its credentials revoked and forgotten, or the
  // daemon stopping) never gets a key swapped in or minted for it.
  const live = (): boolean => renewer === deps && !node.forgotten && deps.isHeld(node.rootId);
  const launchEnded = (issued: RunnerCredential | null): null => {
    if (issued?.credentialId) deps.revoke(node.agentId, issued.credentialId);
    forgetFrom(rootOf(node));
    emit({
      outcome: "failed",
      reason: "launch_ended",
      ...(issued?.credentialId ? { revoked_credential_id: issued.credentialId } : {}),
    });
    return null;
  };

  // A credential no launch holds any more renews nothing.
  if (!live()) {
    forgetFrom(rootOf(node));
    return null;
  }

  // The server cannot take it now: wait if there is time, else mint.
  const waitOrMint = async (base: AttemptEvent, retryAfterMs: number | null): Promise<string | null> => {
    const remaining = msToExpiry ?? Infinity; // no expiry: never "about to expire", so always wait
    if (remaining > RUNNER_CREDENTIAL_FRESH_MINT_WITHIN_MS) {
      node.failures += 1;
      const wait = retryAfterMs === null ? backoffMs(node) : Math.max(retryAfterMs, RUNNER_CREDENTIAL_RENEW_RETRY_AFTER_MIN_MS);
      const retryIn = Math.min(wait, remaining - RUNNER_CREDENTIAL_FRESH_MINT_WITHIN_MS);
      scheduleAttempt(node, retryIn);
      emit({ ...base, retry_in_ms: retryIn });
      return null;
    }
    return mintInstead(base.http_status, base.refusal_code);
  };

  const mintInstead = async (httpStatus: number | undefined, refusalCode: string | undefined): Promise<string | null> => {
    // Every caller checked live() since its last await.
    let minted: RunnerCredential;
    try {
      minted = await deps.freshMint(node.agentId, node.runtime);
      if (!minted.credentialId) throw new Error("mint returned no credential id");
    } catch (err) {
      if (!live()) return launchEnded(null);
      node.failures += 1;
      // Tried again by itself, also once the key has expired: an idle agent
      // (nothing that would 401) must not wait for its next call.
      const remaining = (node.expiresAtMs ?? 0) - now();
      const retryIn = remaining > 0 ? Math.min(backoffMs(node), remaining) : backoffMs(node);
      scheduleAttempt(node, retryIn);
      emit({
        outcome: "failed",
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
        ...(refusalCode ? { refusal_code: refusalCode } : {}),
        reason: `fresh_mint_failed: ${errorClass(err)}`,
        retry_in_ms: retryIn,
      });
      return null;
    }
    if (!live()) return launchEnded(minted);
    const next = swap(node, minted, now() + RUNNER_CREDENTIAL_RENEW_OVERLAP_MS);
    // A key that never expires: the server did not see this daemon's
    // capability when it minted. Renew it soon (a renewal issues an expiring
    // key), backing off while that keeps happening, so the launch does not
    // stay on a key that is never renewed again.
    if (minted.expiresAt === null) {
      next.failures = node.failures + 1;
      scheduleAttempt(next, backoffMs(next));
    }
    emit({
      outcome: "fallback_mint",
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      ...(refusalCode ? { refusal_code: refusalCode } : {}),
      new_credential_id: minted.credentialId,
      new_expires: minted.expiresAt !== null,
    });
    return minted.apiKey;
  };

  let response: Response;
  try {
    response = await deps.fetch(
      new URL(`/internal/computer/runners/${encodeURIComponent(node.agentId)}/credentials/renew`, deps.serverUrl).toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.computerKey()}`,
          "Content-Type": "application/json",
          "X-Raft-Client": "daemon-server-session-worker",
        },
        body: JSON.stringify({ credentialId: node.credentialId }),
        signal: AbortSignal.timeout(RENEW_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (err) {
    if (!live()) return launchEnded(null);
    // The answer was lost: a key the server may have issued is held by no
    // one and expires (or the ready reconcile revokes it). Mint afresh.
    return mintInstead(undefined, `network_error:${errorClass(err)}`);
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const code = typeof body?.code === "string" ? body.code : undefined;
  const renewed = response.status === 201 ? parseRunnerCredentialMintBody(body) : null;
  // Ended while the request was out: a key it issued is revoked at once.
  if (!live()) return launchEnded(renewed);
  if (response.status === 201) {
    if (!renewed?.credentialId || renewed.apiKey === node.apiKey) return mintInstead(201, "invalid_renew_payload");
    const replacedUntil = typeof body?.replacedExpiresAt === "string" ? Date.parse(body.replacedExpiresAt) : NaN;
    swap(node, renewed, Number.isFinite(replacedUntil) ? replacedUntil : now() + RUNNER_CREDENTIAL_RENEW_OVERLAP_MS);
    emit({ outcome: "renewed", http_status: 201, new_credential_id: renewed.credentialId, new_expires: renewed.expiresAt !== null });
    return renewed.apiKey;
  }
  if (response.status === 429) {
    return waitOrMint({ outcome: "rate_limited", http_status: 429, ...(code ? { refusal_code: code } : {}) }, retryAfterMs(response));
  }
  // The server has not seen this connection's `ready` capability yet (a
  // reconnect, a wake from sleep): wait, also past expiry. A mint now would
  // get a key that never expires.
  if (code === "runner_credential_renew_not_declared") {
    node.notDeclared += 1;
    const short = RUNNER_CREDENTIAL_NOT_DECLARED_RETRY_MS[node.notDeclared - 1];
    if (short === undefined) node.failures += 1;
    const retryIn = short ?? backoffMs(node);
    scheduleAttempt(node, retryIn);
    emit({ outcome: "failed", http_status: response.status, refusal_code: code, retry_in_ms: retryIn });
    return null;
  }
  // 5xx: transient. Wait while there is time.
  if (response.status >= 500) {
    return waitOrMint({ outcome: "failed", http_status: response.status, ...(code ? { refusal_code: code } : {}) }, null);
  }
  // Every other refusal (404 agent/credential missing, 403 not a runner /
  // another Computer's, 409 revoked / window passed / already renewed, and
  // anything else): mint a new runner credential instead.
  return mintInstead(response.status, code);
}

function swap(node: LineageNode, credential: RunnerCredential, replacedUntilMs: number): LineageNode {
  if (node.timer) clearTimeout(node.timer);
  node.timer = null;
  const next = newNode(credential, node.agentId, node.runtime, rootOf(node));
  node.next = next;
  node.replacedUntilMs = replacedUntilMs;
  index(next);
  scheduleHalfLife(next);
  // A replaced key other than the launch's first (which its config still
  // names) leaves the lookup once it stops authenticating.
  if (node.root) {
    node.dropTimer = setTimeout(() => {
      node.dropTimer = null;
      if (nodesByKey.get(node.apiKey) === node) nodesByKey.delete(node.apiKey);
      if (!node.forgotten) {
        node.droppedKeyHash = keyHash(node.apiKey);
        droppedKeyNodes.set(node.droppedKeyHash, node);
      }
      node.apiKey = "";
    }, Math.max(0, replacedUntilMs - now()));
    node.dropTimer.unref?.();
  }
  return next;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}
