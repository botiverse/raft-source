import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";

import { currentTimeMs, type ServerToMachineMessage } from "@botiverse/raft-shared";

/**
 * Commands carrying customer credentials (`machine:runtime_auth:connect_provider`,
 * `agent:start`, and `agent:config`) must never cross Redis pub/sub in the clear
 * when the Computer's socket is held by another replica (#proj-runtime:#79,
 * docs/contracts/runtime-auth.md §2).
 *
 * The whole command is sealed with AES-256-GCM under a domain-separated key
 * every replica derives from the server's own secret (which Redis never holds),
 * bound via AAD to that Computer and request/seal id. Only routing metadata
 * stays readable. The owning replica opens it once, within
 * REPLICA_HOP_SEAL_TTL_MS of sealing; a replayed, expired, tampered, or
 * unsealed copy is refused.
 */

type ConnectProvider = Extract<ServerToMachineMessage, { type: "machine:runtime_auth:connect_provider" }>;
type AgentConfigBearingMessage = Extract<ServerToMachineMessage, { type: "agent:start" | "agent:config" }>;
/** The connect as it crosses replicas. */
interface SealedConnectProvider {
  type: ConnectProvider["type"];
  requestId: string;
  sealed: string;
}
/** An `agent:start` or `agent:config` frame as it crosses replicas. */
interface SealedAgentConfigHop {
  type: AgentConfigBearingMessage["type"];
  agentId: string;
  sealId: string;
  sealed: string;
}

const SEAL_VERSION = "v2";
/**
 * The full GCM tag, pinned on both sides. Without it Node accepts a shorter
 * tag (down to 4 bytes) and checks only that many, so a truncated tag would
 * still open (#proj-runtime:76de8fcb).
 */
const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;
/**
 * How long a sealed frame may take from one replica to the other: the
 * requester waits RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS (30 s) in all, so a
 * copy older than this has no one waiting for it. Also the bound on clock
 * skew between replicas.
 */
export const REPLICA_HOP_SEAL_TTL_MS = 60_000;

/** Request/seal ids already opened on this replica, until their seal expires: each opens once. */
const opened = new Map<string, number>();

export type ReplicaHopRefusal = "unsealed" | "malformed" | "unopenable" | "expired" | "replayed";

/**
 * Rolling-deploy cutover mode for sealing `agent:start` and `agent:config`
 * across Redis (#proj-runtime:#79), controlled by the global FFA flag
 * `replica_seal_agent_config_v1` (resolved in `agentSecretFlags.ts`):
 *   - "receive_only" (PR 1 default): `openAfterReplicaHop` opens sealed
 *     `agent:start`/`agent:config` (strictly refusing tampered, replayed, or
 *     expired copies) and still accepts legacy unsealed copies from older
 *     replicas; `sealForReplicaHop` does not emit sealed copies until all
 *     replicas know how to open them.
 *   - "seal": emit sealed `agent:start`/`agent:config` on send; accept both
 *     sealed and legacy unsealed on receive during cutover.
 *   - "strict": emit sealed on send AND refuse unsealed on receive (post-cutover).
 */
export type AgentConfigHopSealMode = "receive_only" | "seal" | "strict";

function hopKey(info: "provider-connect.v2" | "agent-config-hop.v1"): Buffer {
  // The replica replay secret when set, else the JWT secret: the same choice machineLocalReplay.ts makes.
  const secret = process.env.SLOCK_REPLICA_REPLAY_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("A replica secret is required to seal credentials between replicas");
  return Buffer.from(hkdfSync("sha256", secret, "raft.runtime-auth.replica-hop", info, 32));
}

function boundTo(...parts: string[]): Buffer {
  return Buffer.from(parts.join("\0"), "utf8");
}

export function isAgentConfigBearingMessage(msg: ServerToMachineMessage): msg is AgentConfigBearingMessage {
  return msg.type === "agent:start" || msg.type === "agent:config";
}

function sealPayload(info: "provider-connect.v2" | "agent-config-hop.v1", aad: Buffer, payload: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", hopKey(info), iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [SEAL_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), sealed.toString("base64url")].join(":");
}

function openPayload<T>(
  info: "provider-connect.v2" | "agent-config-hop.v1",
  aad: Buffer,
  sealedText: string,
): { ok: true; payload: T } | { ok: false; reason: "malformed" | "unopenable" } {
  const [version, iv, tag, sealed, extra] = sealedText.split(":");
  if (version !== SEAL_VERSION || !iv || !tag || !sealed || extra !== undefined) return { ok: false, reason: "malformed" };
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== AUTH_TAG_BYTES) return { ok: false, reason: "malformed" };
  try {
    const decipher = createDecipheriv("aes-256-gcm", hopKey(info), ivBytes, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tagBytes);
    // Any error here (a missing secret, wrong tag, unreadable JSON) is dropped unread: its text could quote the plaintext.
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed, "base64url")), decipher.final()]).toString("utf8")) as T;
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "unopenable" };
  }
}

function claimReplaySlot(replayKey: string, issuedAtMs: number, now: number): "ok" | "expired" | "replayed" {
  if (Math.abs(now - issuedAtMs) > REPLICA_HOP_SEAL_TTL_MS) return "expired";
  // `opened` preserves insertion order; evict expired entries from the head and stop at the first live slot.
  for (const [id, expiresAtMs] of opened) {
    if (expiresAtMs > now) break;
    opened.delete(id);
  }
  if (opened.has(replayKey)) return "replayed";
  opened.set(replayKey, issuedAtMs + REPLICA_HOP_SEAL_TTL_MS);
  return "ok";
}

/** The message as it may cross Redis: credential-carrying frames sealed whole, any other message unchanged. */
export function sealForReplicaHop(
  machineId: string,
  msg: ServerToMachineMessage,
  now: number = currentTimeMs(),
  agentConfigMode: AgentConfigHopSealMode = "receive_only",
): ServerToMachineMessage {
  if (msg.type === "machine:runtime_auth:connect_provider") {
    if (typeof (msg as unknown as Partial<SealedConnectProvider>).sealed === "string") return msg;
    const hop: SealedConnectProvider = {
      type: msg.type,
      requestId: msg.requestId,
      sealed: sealPayload("provider-connect.v2", boundTo(machineId, msg.requestId), { issuedAtMs: now, message: msg }),
    };
    // The replica router carries a ServerToMachineMessage; this form never
    // reaches a socket, since openAfterReplicaHop turns it back first.
    return hop as unknown as ServerToMachineMessage;
  }
  if (isAgentConfigBearingMessage(msg)) {
    if (typeof (msg as unknown as Partial<SealedAgentConfigHop>).sealed === "string") return msg;
    if (agentConfigMode === "receive_only") return msg;
    const sealId = randomUUID();
    const hop: SealedAgentConfigHop = {
      type: msg.type,
      agentId: msg.agentId,
      sealId,
      sealed: sealPayload("agent-config-hop.v1", boundTo(machineId, msg.type, msg.agentId, sealId), { issuedAtMs: now, message: msg }),
    };
    return hop as unknown as ServerToMachineMessage;
  }
  return msg;
}

/**
 * The message as it arrived from another replica, ready for the Computer's
 * socket: credential-carrying frames opened. Anything that does not open
 * (sent in the clear when required, changed, sealed for another Computer/agent/
 * request or with another secret, too old, or opened before) is refused with
 * its reason and, for provider connect, the request id the refusal can answer.
 * Never the key.
 */
export function openAfterReplicaHop(
  machineId: string,
  msg: ServerToMachineMessage,
  now: number = currentTimeMs(),
  agentConfigMode: AgentConfigHopSealMode = "receive_only",
): { ok: true; message: ServerToMachineMessage } | { ok: false; reason: ReplicaHopRefusal; requestId: string | null } {
  if (msg.type === "machine:runtime_auth:connect_provider") {
    const hop = msg as unknown as Partial<SealedConnectProvider>;
    const requestId = typeof hop.requestId === "string" && hop.requestId.length > 0 && hop.requestId.length <= 128 ? hop.requestId : null;
    if (typeof hop.sealed !== "string") return { ok: false, reason: "unsealed", requestId };
    if (!requestId) return { ok: false, reason: "malformed", requestId };
    const openedPayload = openPayload<{ issuedAtMs?: unknown; message?: Partial<ConnectProvider> }>(
      "provider-connect.v2",
      boundTo(machineId, requestId),
      hop.sealed,
    );
    if (!openedPayload.ok) return { ok: false, reason: openedPayload.reason, requestId };
    const { issuedAtMs, message } = openedPayload.payload;
    if (message?.type !== "machine:runtime_auth:connect_provider" || message.requestId !== requestId || typeof issuedAtMs !== "number") {
      return { ok: false, reason: "malformed", requestId };
    }
    const replay = claimReplaySlot(`connect:${requestId}`, issuedAtMs, now);
    if (replay !== "ok") return { ok: false, reason: replay, requestId };
    return { ok: true, message: message as ConnectProvider };
  }

  if (isAgentConfigBearingMessage(msg)) {
    const hop = msg as unknown as Partial<SealedAgentConfigHop>;
    if (hop.sealed === undefined) {
      if (agentConfigMode === "strict") return { ok: false, reason: "unsealed", requestId: null };
      return { ok: true, message: msg };
    }
    if (typeof hop.sealed !== "string") return { ok: false, reason: "malformed", requestId: null };
    const agentId = typeof hop.agentId === "string" && hop.agentId.length > 0 && hop.agentId.length <= 128 ? hop.agentId : null;
    const sealId = typeof hop.sealId === "string" && hop.sealId.length > 0 && hop.sealId.length <= 128 ? hop.sealId : null;
    if (!agentId || !sealId) return { ok: false, reason: "malformed", requestId: null };
    const openedPayload = openPayload<{ issuedAtMs?: unknown; message?: Partial<AgentConfigBearingMessage> }>(
      "agent-config-hop.v1",
      boundTo(machineId, msg.type, agentId, sealId),
      hop.sealed,
    );
    if (!openedPayload.ok) return { ok: false, reason: openedPayload.reason, requestId: null };
    const { issuedAtMs, message } = openedPayload.payload;
    if (message?.type !== msg.type || message.agentId !== agentId || typeof issuedAtMs !== "number") {
      return { ok: false, reason: "malformed", requestId: null };
    }
    const replay = claimReplaySlot(`agent:${sealId}`, issuedAtMs, now);
    if (replay !== "ok") return { ok: false, reason: replay, requestId: null };
    return { ok: true, message: message as AgentConfigBearingMessage };
  }

  return { ok: true, message: msg };
}

export function __clearReplicaHopSealsForTests(): void {
  opened.clear();
}
