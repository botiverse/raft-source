import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { currentTimeMs, type ServerToMachineMessage } from "@botiverse/raft-shared";

/**
 * A Qwen Code provider connect carries the provider's API key
 * (docs/contracts/runtime-auth.md §2). When the Computer's socket is held by
 * another replica, the command crosses Redis pub/sub on its way there. It
 * never crosses it readable or changeable: the whole command (key, provider,
 * endpoint, model, runtime) is sealed with AES-256-GCM under a key every
 * replica derives from the server's own secret, which Redis never holds, and
 * bound to that Computer and that request. Only the type and the request id
 * stay readable, to route the command and to answer a refusal. The replica
 * that writes it to the Computer's socket opens it once, within
 * REPLICA_HOP_SEAL_TTL_MS of sealing; a replayed or late copy is refused.
 */

type ConnectProvider = Extract<ServerToMachineMessage, { type: "machine:runtime_auth:connect_provider" }>;
/** The connect as it crosses replicas. */
interface SealedConnectProvider {
  type: ConnectProvider["type"];
  requestId: string;
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
 * How long a sealed connect may take from one replica to the other: the
 * requester waits RUNTIME_AUTH_PROVIDER_RELAY_BUDGET_MS (30 s) in all, so a
 * copy older than this has no one waiting for it. Also the bound on clock
 * skew between replicas.
 */
export const REPLICA_HOP_SEAL_TTL_MS = 60_000;

/** Request ids already opened on this replica, until their seal expires: each opens once. */
const opened = new Map<string, number>();

export type ReplicaHopRefusal = "unsealed" | "malformed" | "unopenable" | "expired" | "replayed";

function hopKey(): Buffer {
  // The replica replay secret when set, else the JWT secret: the same choice machineLocalReplay.ts makes.
  const secret = process.env.SLOCK_REPLICA_REPLAY_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("A replica secret is required to seal a provider key between replicas");
  return Buffer.from(hkdfSync("sha256", secret, "raft.runtime-auth.replica-hop", "provider-connect.v2", 32));
}

function boundTo(machineId: string, requestId: string): Buffer {
  return Buffer.from([machineId, requestId].join("\0"), "utf8");
}

/** The message as it may cross Redis: a provider connect sealed whole, any other message unchanged. */
export function sealForReplicaHop(machineId: string, msg: ServerToMachineMessage, now: number = currentTimeMs()): ServerToMachineMessage {
  if (msg.type !== "machine:runtime_auth:connect_provider") return msg;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", hopKey(), iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(boundTo(machineId, msg.requestId));
  const sealed = Buffer.concat([cipher.update(JSON.stringify({ issuedAtMs: now, message: msg }), "utf8"), cipher.final()]);
  const hop: SealedConnectProvider = {
    type: msg.type,
    requestId: msg.requestId,
    sealed: [SEAL_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), sealed.toString("base64url")].join(":"),
  };
  // The replica router carries a ServerToMachineMessage; this form never
  // reaches a socket, since openAfterReplicaHop turns it back first.
  return hop as unknown as ServerToMachineMessage;
}

/**
 * The message as it arrived from another replica, ready for the Computer's
 * socket: a provider connect opened. A connect that does not open (sent in
 * the clear, changed, sealed for another Computer or request or with another
 * secret, too old, or opened before) is refused with its reason and, when it
 * names one, the request id the refusal can answer. Never the key.
 */
export function openAfterReplicaHop(
  machineId: string,
  msg: ServerToMachineMessage,
  now: number = currentTimeMs(),
): { ok: true; message: ServerToMachineMessage } | { ok: false; reason: ReplicaHopRefusal; requestId: string | null } {
  if (msg.type !== "machine:runtime_auth:connect_provider") return { ok: true, message: msg };
  const hop = msg as unknown as Partial<SealedConnectProvider>;
  const requestId = typeof hop.requestId === "string" && hop.requestId.length > 0 && hop.requestId.length <= 128 ? hop.requestId : null;
  if (typeof hop.sealed !== "string") return { ok: false, reason: "unsealed", requestId };
  const [version, iv, tag, sealed, extra] = hop.sealed.split(":");
  if (!requestId || version !== SEAL_VERSION || !iv || !tag || !sealed || extra !== undefined) return { ok: false, reason: "malformed", requestId };
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== AUTH_TAG_BYTES) return { ok: false, reason: "malformed", requestId };
  let payload: { issuedAtMs?: unknown; message?: Partial<ConnectProvider> };
  try {
    const decipher = createDecipheriv("aes-256-gcm", hopKey(), ivBytes, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(boundTo(machineId, requestId));
    decipher.setAuthTag(tagBytes);
    // Any error here (a wrong tag, unreadable JSON) is dropped unread: its text could quote the plaintext.
    payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed, "base64url")), decipher.final()]).toString("utf8")) as typeof payload;
  } catch {
    return { ok: false, reason: "unopenable", requestId };
  }
  const message = payload.message;
  if (message?.type !== "machine:runtime_auth:connect_provider" || message.requestId !== requestId || typeof payload.issuedAtMs !== "number") {
    return { ok: false, reason: "malformed", requestId };
  }
  if (Math.abs(now - payload.issuedAtMs) > REPLICA_HOP_SEAL_TTL_MS) return { ok: false, reason: "expired", requestId };
  for (const [id, expiresAtMs] of opened) if (expiresAtMs <= now) opened.delete(id);
  if (opened.has(requestId)) return { ok: false, reason: "replayed", requestId };
  opened.set(requestId, payload.issuedAtMs + REPLICA_HOP_SEAL_TTL_MS);
  return { ok: true, message: message as ConnectProvider };
}

export function __clearReplicaHopSealsForTests(): void {
  opened.clear();
}
