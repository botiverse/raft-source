import { createHmac, hkdfSync } from "node:crypto";

// Request traces leave our infrastructure (ScopeDB), so raw agent and server
// ids stay out of them (see the no-raw-id assertions in the route tests).
// Traces carry a keyed hash instead: enough to group spans by agent or server
// across days, and not joinable back to `agents.id` / `servers.id` without the
// key.
//
// Each kind has its own key, derived from JWT_SECRET (stable across replicas
// and deploys) with HKDF: salt = the versioned label, info = the attr name. So
// an agent hash can never be compared with a server hash, and neither can be
// reused as or correlated with any other derived key. Rotating = bumping the
// label version, which breaks grouping across the rotation on purpose.
// Rotating JWT_SECRET itself also changes every hash, with the same effect on
// grouping.
const TRACE_IDENTITY_LABEL = "raft-trace-identity-v1";
const ID_HASH_HEX_CHARS = 16;

// stale_cache_key_hash: the rw-stale cache key (routes/rwStaleRead.ts), which
// embeds a user id; counted per key, never resolved back.
// conversation_id_hash: a channel/DM/thread id in the agent-context return
// event (agentContextReturnTrace.ts), the agent send's message.sent event
// (routes/internal.ts), message forward's terminal event (messageForwardTrace.ts)
// and the external agent inbox pull event (messageService.ts);
// counted per conversation, never resolved.
// message_id_hash: the message a link-preview read refused or failed on
// (routes/messages.ts), and the message an agent send created (message.sent,
// routes/internal.ts), and a forward's single source message (messageForwardTrace.ts);
// found from a known id with trace:agent-id-hash --kind message.
// job_id_hash: a channel conversion job, on the conversion worker's per-job
// event (server.channel_conversion_worker.job, channelConversionWorker.ts);
// found from a known id with trace:agent-id-hash --kind job.
// feedback_reporter_hash: the user who submitted product feedback, as the
// inbox object ref of the triage notice (productFeedbackTriageNotice.ts) so
// one person's submissions share one inbox row; never the raw user id.
export type TraceIdentityKind = "agent_id_hash" | "server_id_hash" | "stale_cache_key_hash" | "conversation_id_hash" | "machine_id_hash" | "message_id_hash" | "feedback_reporter_hash" | "job_id_hash";

let cachedRoot: string | null = null;
const cachedKeys = new Map<TraceIdentityKind, Buffer>();

function traceIdentityKey(kind: TraceIdentityKind): Buffer | null {
  const root = process.env.JWT_SECRET?.trim();
  if (!root) return null;
  if (cachedRoot !== root) {
    cachedKeys.clear();
    cachedRoot = root;
  }
  let key = cachedKeys.get(kind);
  if (!key) {
    key = Buffer.from(hkdfSync(
      "sha256",
      Buffer.from(root, "utf8"),
      Buffer.from(TRACE_IDENTITY_LABEL, "utf8"),
      Buffer.from(kind, "utf8"),
      32,
    ));
    cachedKeys.set(kind, key);
  }
  return key;
}

/**
 * Keyed trace hash of an id: first 16 hex chars of HMAC-SHA256(key(kind), id).
 * Returns null when there's no id or no key, so tracing never throws.
 * id -> hash: `pnpm --filter @botiverse/raft-server trace:agent-id-hash [--kind server] <id>`.
 * hash -> id: only operators, via the Feature Flag Admin Worker
 * (GET /api/operator/trace-identity/:hash, audited), which holds the derived
 * keys from `exportTraceIdentityKeyHex`, never JWT_SECRET.
 */
export function traceIdentityHash(kind: TraceIdentityKind, id: string | null | undefined): string | null {
  const value = id?.trim();
  if (!value) return null;
  const key = traceIdentityKey(kind);
  if (!key) return null;
  return createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, ID_HASH_HEX_CHARS);
}

/**
 * The derived per-kind key as 64 hex chars, or null without JWT_SECRET. Only
 * for provisioning the Feature Flag Admin Worker (scripts/trace-identity-keys.ts),
 * which resolves trace hashes for operators: HMAC-SHA256(key, id) there must
 * equal traceIdentityHash here. The key only yields trace hashes, not JWTs.
 */
export function exportTraceIdentityKeyHex(kind: TraceIdentityKind): string | null {
  return traceIdentityKey(kind)?.toString("hex") ?? null;
}

export function traceAgentIdHash(agentId: string | null | undefined): string | null {
  return traceIdentityHash("agent_id_hash", agentId);
}

export function traceServerIdHash(serverId: string | null | undefined): string | null {
  return traceIdentityHash("server_id_hash", serverId);
}

export function traceMachineIdHash(machineId: string | null | undefined): string | null {
  return traceIdentityHash("machine_id_hash", machineId);
}

/** `{ agent_id_hash }` when hashable, else `{}` — for spreading into attrs. */
export function agentIdHashAttrs(agentId: string | null | undefined): { agent_id_hash?: string } {
  const hash = traceAgentIdHash(agentId);
  return hash ? { agent_id_hash: hash } : {};
}

/**
 * `{ key_prefix_hash }` for a key that matched nothing. Under the agent hash key
 * so the raw prefix stays out of traces; it resolves to nothing, it only groups
 * requests by the key they presented.
 */
export function apiKeyPrefixHashAttrs(prefix: string): { key_prefix_hash?: string } {
  const hash = traceAgentIdHash(prefix);
  return hash ? { key_prefix_hash: hash } : {};
}

/** `{ server_id_hash }` when hashable, else `{}` — for spreading into attrs. */
export function serverIdHashAttrs(serverId: string | null | undefined): { server_id_hash?: string } {
  const hash = traceServerIdHash(serverId);
  return hash ? { server_id_hash: hash } : {};
}
