// Computer-scoped AI provider probes (Phase 2A foundation).
//
// Contract of record: #wg-subscription-login:225b161b (Cardy v2 +收口修正).
// A probe verifies one provider connection from one Computer using the real
// runtime adapter. The Server never calls the provider for a probe; it only
// stores encrypted credentials, authorizes, hands an exact one-time
// materialization to the claiming Computer, and records a closed receipt.
//
// Security invariants encoded here:
// - probe ids and client idempotency keys are branded; minting happens only in
//   this file (see scripts/ci/check-branded-mint-sites.ts).
// - every digest is a SHA-256 over canonical JSON, so intent / materialization
//   / result form a tamper-evident chain without storing secrets.
// - the closed category enum is complete: transport, carrier, authority and
//   validity failures are distinct members; `success` is an outcome, never a
//   category.
import type { Brand } from "./brandedIds";

/** Daemon capability advertising the probe carrier. Absence is decidable. */
export const PROVIDER_PROBE_CAPABILITY = "provider-probe:v1";

/** One machine command round trip budget. Distinct from runtime-models' 5s. */
export const PROVIDER_PROBE_BUDGET_MS = 30_000;
/**
 * Relay/wait budget for one probe round trip. Strictly larger than the
 * provider budget so a daemon-decided provider_timeout always lands before
 * the Server would record carrier_timeout for the same round trip.
 */
export const PROVIDER_PROBE_RELAY_BUDGET_MS = PROVIDER_PROBE_BUDGET_MS + 10_000;
/** One-time materialization HTTP round trip budget on the daemon. */
export const PROVIDER_PROBE_MATERIALIZE_BUDGET_MS = 5_000;
/**
 * Intent TTL. Strictly larger than relay budget + closure epsilon so a result
 * that survived the relay can never arrive after the intent expired, and an
 * expired intent can never be closed as success.
 */
export const PROVIDER_PROBE_INTENT_TTL_MS = PROVIDER_PROBE_RELAY_BUDGET_MS + 15_000;
/** Lease during which the same claimant may retry a lost materialize response. */
export const PROVIDER_PROBE_MATERIALIZE_LEASE_MS = 60_000;
/** Rate window: at most one new dispatch per (connection, computer) per window. */
export const PROVIDER_PROBE_RATE_WINDOW_MS = 60_000;
/** Hard ceiling for the assistant plain-text reply, in UTF-8 bytes. */
export const PROVIDER_PROBE_REPLY_MAX_BYTES = 4_096;

export const PROVIDER_PROBE_KINDS = ["canary"] as const;
export type ProviderProbeKind = (typeof PROVIDER_PROBE_KINDS)[number];
export const isProviderProbeKind = (value: unknown): value is ProviderProbeKind => (
  typeof value === "string" && (PROVIDER_PROBE_KINDS as readonly string[]).includes(value)
);

export const PROVIDER_PROBE_OUTCOMES = ["success", "failure"] as const;
export type ProviderProbeOutcome = (typeof PROVIDER_PROBE_OUTCOMES)[number];
export const isProviderProbeOutcome = (value: unknown): value is ProviderProbeOutcome => (
  typeof value === "string" && (PROVIDER_PROBE_OUTCOMES as readonly string[]).includes(value)
);

/**
 * Closed terminal category vocabulary. Provider-reported failures occupy the
 * first six members; the rest are Server-decided closure reasons. A probe that
 * closes for any of these is a failure; `success` carries no category.
 */
export const PROVIDER_PROBE_CATEGORIES = [
  "auth",
  "model",
  "network",
  "dns_tls",
  "rate_quota",
  "invalid_response",
  "carrier_offline",
  "carrier_timeout",
  "unsupported_carrier",
  "provider_timeout",
  "stale_authority",
  "intent_expired",
  "invalid_carrier_result",
] as const;
export type ProviderProbeCategory = (typeof PROVIDER_PROBE_CATEGORIES)[number];
export const isProviderProbeCategory = (value: unknown): value is ProviderProbeCategory => (
  typeof value === "string" && (PROVIDER_PROBE_CATEGORIES as readonly string[]).includes(value)
);

/** Categories a daemon may report from the runtime adapter itself. */
export const PROVIDER_PROBE_DAEMON_CATEGORIES = [
  "auth",
  "model",
  "network",
  "dns_tls",
  "rate_quota",
  "invalid_response",
  "provider_timeout",
] as const;
export type ProviderProbeDaemonCategory = (typeof PROVIDER_PROBE_DAEMON_CATEGORIES)[number];
export const isProviderProbeDaemonCategory = (value: unknown): value is ProviderProbeDaemonCategory => (
  typeof value === "string" && (PROVIDER_PROBE_DAEMON_CATEGORIES as readonly string[]).includes(value)
);

/**
 * Wave 1 closes verification to the Built-in Pi runtime: the daemon canary
 * adapter only exists there, so any other runtime label must be rejected
 * before dispatch instead of being relabelled into a Built-in receipt.
 */
export const PROVIDER_PROBE_WAVE1_RUNTIMES = ["builtin"] as const;
export type ProviderProbeRuntime = (typeof PROVIDER_PROBE_WAVE1_RUNTIMES)[number];
export const isProviderProbeRuntime = (value: unknown): value is ProviderProbeRuntime => (
  typeof value === "string" && (PROVIDER_PROBE_WAVE1_RUNTIMES as readonly string[]).includes(value)
);

/** Server-minted probe identity. Mint with {@link mintProviderProbeId} only. */
export type ProviderProbeId = Brand<string, "ProviderProbeId">;
export const mintProviderProbeId = (): ProviderProbeId => (
  globalThis.crypto.randomUUID() as ProviderProbeId
);
export const asProviderProbeId = (value: string): ProviderProbeId => value as ProviderProbeId;
export const isProviderProbeId = (value: unknown): value is ProviderProbeId => (
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
);

/**
 * Client-supplied idempotency key for probe creation. Mint with
 * {@link asProviderProbeRequestId} at the validated-body boundary only.
 */
export type ProviderProbeRequestId = Brand<string, "ProviderProbeRequestId">;
export const asProviderProbeRequestId = (value: string): ProviderProbeRequestId => (
  value as ProviderProbeRequestId
);
export const isProviderProbeRequestId = (value: unknown): value is ProviderProbeRequestId => (
  typeof value === "string" && value.length >= 16 && value.length <= 128 && /^[\x21-\x7e]+$/u.test(value)
);

/** Stable, key-order-insensitive JSON serialization used by every digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Isomorphic SHA-256 (WebCrypto) so this module stays loadable from the Web
 * bundle; digest helpers are async everywhere for the same reason.
 */
export async function sha256Hex(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Digest of the client-visible create payload; binds idempotency keys. */
export async function providerProbeRequestDigest(input: {
  connectionId: string;
  computerId: string;
  runtime: string;
  model: string;
  probeKind: ProviderProbeKind;
}): Promise<string> {
  return sha256Hex(canonicalJson({ ...input, schema: "provider-probe-request.v1" }));
}

/** Digest of the stored intent; the first link of the receipt chain. */
export async function providerProbeIntentDigest(input: {
  serverId: string;
  connectionId: string;
  configVersion: number;
  credentialVersion: number;
  computerId: string;
  runtime: string;
  model: string;
  probeKind: ProviderProbeKind;
  probeRequestId: string;
  requestDigest: string;
}): Promise<string> {
  return sha256Hex(canonicalJson({ ...input, schema: "provider-probe-intent.v1" }));
}

/** Digest of a one-time materialization claim; second link of the chain. */
export async function providerProbeMaterializationDigest(input: {
  probeId: string;
  machineId: string;
  claimRequestId: string;
  connectionEpochId: string;
  replicaGeneration: string;
  projection: unknown;
  keyEnvNames: readonly string[];
}): Promise<string> {
  return sha256Hex(canonicalJson({ ...input, schema: "provider-probe-materialization.v1" }));
}

/**
 * Digest of a closed result. Covers the closed outcome, the response hash and
 * byte count and the derived authority identity — never the reply body.
 */
export async function providerProbeResultDigest(input: {
  outcome: ProviderProbeOutcome;
  category: ProviderProbeCategory | null;
  responseSha256: string | null;
  responseBytes: number | null;
  authorityIdentity: string;
}): Promise<string> {
  return sha256Hex(canonicalJson({ ...input, schema: "provider-probe-result.v1" }));
}

/** Identity of the dispatch authority, derived from stored state only. */
export async function providerProbeAuthorityIdentity(input: {
  connectionEpochId: string;
  replicaGeneration: string;
}): Promise<string> {
  return sha256Hex(canonicalJson({ ...input, schema: "provider-probe-authority.v1" }));
}

/** Server → Computer probe command. Carries no credential and no endpoint. */
export interface MachineProviderProbeRequest {
  type: "machine:provider_probe:request";
  requestId: string;
  probeId: ProviderProbeId;
  runtime: string;
  model: string;
}

/** Computer → Server probe result. `reply` is transient and bounded. */
export interface MachineProviderProbeResult {
  type: "machine:provider_probe:result";
  requestId: string;
  probeId: ProviderProbeId;
  outcome: ProviderProbeOutcome;
  /** Daemon-decided categories only; Server-owned reasons never travel on the wire. */
  category: ProviderProbeDaemonCategory | null;
  latencyMs: number | null;
  /** Failure results must carry null hash/bytes/reply. */
  responseSha256: string | null;
  responseBytes: number | null;
  resultDigest: string;
  authorityEcho: { connectionEpochId: string; replicaGeneration: string };
  daemonVersion: string | null;
  computerVersion: string | null;
  runtimeVersion: string | null;
  /** ≤4096 UTF-8 bytes of non-blank assistant plain text; success requires it. */
  reply: string | null;
}

/** Credential-free probe state returned by the read endpoint. */
export interface ProviderProbeReceiptView {
  probeId: ProviderProbeId;
  probeRequestId: string;
  connectionId: string;
  computerId: string;
  runtime: string;
  model: string;
  probeKind: ProviderProbeKind;
  configVersion: number;
  credentialVersion: number;
  outcome: ProviderProbeOutcome | null;
  category: ProviderProbeCategory | null;
  latencyMs: number | null;
  responseSha256: string | null;
  responseBytes: number | null;
  verifiedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Create-endpoint response: receipt plus, only here, the transient reply. */
export interface ProviderProbeCreatedView {
  probe: ProviderProbeReceiptView;
  /** Present only for a just-observed success on this authenticated request. */
  reply: string | null;
  replayed: boolean;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Daemon- and Server-side bound check for the assistant reply. */
export function boundProviderProbeReply(reply: unknown): string | null {
  if (reply === null || reply === undefined) return null;
  if (typeof reply !== "string") return null;
  if (reply.trim().length === 0) return null;
  if (utf8ByteLength(reply) > PROVIDER_PROBE_REPLY_MAX_BYTES) return null;
  return reply;
}

/** Durable receipt summary for the shadow-UI read model (no reply body). */
export interface ProviderProbeReceiptSummary {
  probeId: string;
  computerId: string;
  runtime: string;
  model: string;
  outcome: ProviderProbeOutcome;
  category: ProviderProbeCategory | null;
  latencyMs: number | null;
  verifiedAt: string;
  configVersion: number;
  credentialVersion: number;
  runtimeVersion: string | null;
  daemonVersion: string | null;
  computerVersion: string | null;
}

export interface ProviderProbeReceiptList {
  receipts: ProviderProbeReceiptSummary[];
}
