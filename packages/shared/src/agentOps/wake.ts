// Wake-up signals for External Agents.
//
// A push notice (`raft-agent-inbox-notice.v1`) is a content-free wake-up:
// Raft POSTs it to the registered webhook, signed with HMAC-SHA256 over the
// raw body. It carries no message bodies and acknowledges nothing; the agent
// pulls its inbox itself. Notices are idempotent wake-ups by design: a replay
// costs at most one extra pull, so verification checks the signature and the
// schema, and deliberately applies no time window (clock skew would drop real
// wake-ups, which costs far more than a replay).
//
// Runtime-neutral on purpose: WebCrypto only (Cloudflare Workers, Node ≥ 20,
// Deno, Bun), raw bytes in, no `node:crypto`, no filesystem.

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiPushWebhookStatusResponse } from "../agentApiContract";
import { failureFromClientResult, type RaftOutcome } from "./outcome";

export const RAFT_INBOX_NOTICE_SCHEMA = "raft-agent-inbox-notice.v1" as const;
export const RAFT_NOTICE_SIGNATURE_HEADER = "x-raft-signature-256" as const;
export const RAFT_NOTICE_DELIVERY_ID_HEADER = "x-raft-delivery-id" as const;

export type RaftNoticeFlag = "mention" | "non_member_mention" | "thread" | "dm" | "task";

export interface RaftNoticeTarget {
  /** Canonical reply target for the conversation. */
  target: string;
  channelId: string | null;
  channelType: string | null;
  pendingCount: number;
  firstPendingMsgId: string | null;
  latestMsgId: string | null;
  /**
   * Seq of the latest pending message, a decimal string; null on older Servers
   * and for app events. Pass `channelId:latestSeq` as `/events` `wait_for`.
   */
  latestSeq: string | null;
  latestSenderName: string | null;
  latestSenderType: "human" | "agent" | "system" | "third_party_app" | null;
  flags: RaftNoticeFlag[];
  /** True when any flag is a personal mention. */
  mentionsYou: boolean;
}

export interface RaftInboxNotice {
  noticeId: string;
  /** Header delivery id; equals `noticeId` on current Servers. */
  deliveryId: string | null;
  recipientAgentId: string;
  occurredAt: string;
  /** The same "Inbox update" summary text a managed agent gets. */
  text: string;
  targets: RaftNoticeTarget[];
}

export type VerifyNoticeRejection =
  | "missing_signature"
  | "bad_signature"
  | "invalid_body"
  | "unsupported_schema";

export type VerifyNoticeResult =
  | { ok: true; notice: RaftInboxNotice }
  | { ok: false; reason: VerifyNoticeRejection; message: string };

export interface VerifyNoticeInput {
  /** Request headers; any object with `get(name)` (Fetch `Headers`) or a plain record. */
  headers: { get(name: string): string | null } | Record<string, string | string[] | undefined>;
  /** The raw request body bytes, exactly as received. */
  body: Uint8Array;
  /** The secret given to `PUT /push-webhook`. */
  secret: string;
}

function headerValue(headers: VerifyNoticeInput["headers"], name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmacSha256(secret: string, body: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Copy into a fresh ArrayBuffer: WebCrypto's BufferSource excludes views over SharedArrayBuffer.
  const bytes = new Uint8Array(body.byteLength);
  bytes.set(body);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes.buffer));
}

const SENDER_TYPES = new Set(["human", "agent", "system", "third_party_app"]);
const FLAGS = new Set<RaftNoticeFlag>(["mention", "non_member_mention", "thread", "dm", "task"]);

function parseNotice(value: unknown, deliveryId: string | null): RaftInboxNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.noticeId !== "string" || typeof v.recipientAgentId !== "string" || typeof v.occurredAt !== "string" || !Array.isArray(v.targets)) return null;
  const targets: RaftNoticeTarget[] = [];
  for (const raw of v.targets) {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.target !== "string") return null;
    const flags = Array.isArray(t.flags) ? t.flags.filter((f): f is RaftNoticeFlag => typeof f === "string" && FLAGS.has(f as RaftNoticeFlag)) : [];
    targets.push({
      target: t.target,
      channelId: typeof t.channelId === "string" ? t.channelId : null,
      channelType: typeof t.channelType === "string" ? t.channelType : null,
      pendingCount: typeof t.pendingCount === "number" ? t.pendingCount : 0,
      firstPendingMsgId: typeof t.firstPendingMsgId === "string" ? t.firstPendingMsgId : null,
      latestMsgId: typeof t.latestMsgId === "string" ? t.latestMsgId : null,
      latestSeq: typeof t.latestSeq === "string" && /^[0-9]+$/.test(t.latestSeq) ? t.latestSeq : null,
      latestSenderName: typeof t.latestSenderName === "string" ? t.latestSenderName : null,
      latestSenderType: typeof t.latestSenderType === "string" && SENDER_TYPES.has(t.latestSenderType)
        ? t.latestSenderType as RaftNoticeTarget["latestSenderType"]
        : null,
      flags,
      mentionsYou: flags.includes("mention") || flags.includes("non_member_mention"),
    });
  }
  return {
    noticeId: v.noticeId,
    deliveryId,
    recipientAgentId: v.recipientAgentId,
    occurredAt: v.occurredAt,
    text: typeof v.text === "string" ? v.text : "",
    targets,
  };
}

/**
 * Verify and parse a push notice. Async, WebCrypto, raw bytes. Never rejects
 * on time: treat every accepted notice as "pull your inbox now".
 */
export async function verifyInboxNotice(input: VerifyNoticeInput): Promise<VerifyNoticeResult> {
  const header = headerValue(input.headers, RAFT_NOTICE_SIGNATURE_HEADER)?.trim() ?? "";
  if (!header) return { ok: false, reason: "missing_signature", message: `Missing ${RAFT_NOTICE_SIGNATURE_HEADER} header.` };
  const presented = header.toLowerCase().startsWith("sha256=") ? hexToBytes(header.slice("sha256=".length)) : null;
  if (!presented) return { ok: false, reason: "bad_signature", message: "Signature header is not `sha256=<hex>`." };
  const expected = await hmacSha256(input.secret, input.body);
  if (!constantTimeEqual(presented, expected)) return { ok: false, reason: "bad_signature", message: "Signature does not match the body." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(input.body));
  } catch {
    return { ok: false, reason: "invalid_body", message: "Body is not JSON." };
  }
  const schema = parsed && typeof parsed === "object" ? (parsed as { schema?: unknown }).schema : undefined;
  if (schema !== RAFT_INBOX_NOTICE_SCHEMA) {
    return { ok: false, reason: "unsupported_schema", message: `Expected schema ${RAFT_INBOX_NOTICE_SCHEMA}.` };
  }
  const notice = parseNotice(parsed, headerValue(input.headers, RAFT_NOTICE_DELIVERY_ID_HEADER));
  if (!notice) return { ok: false, reason: "invalid_body", message: "Notice body does not match the contract." };
  return { ok: true, notice };
}

// ── webhook registration ─────────────────────────────────────────────────

export type RaftWebhookStatus = AgentApiPushWebhookStatusResponse;

function statusText(status: RaftWebhookStatus): string {
  if (!status.registered) return "Push webhook: not registered.";
  return `Push webhook: ${status.url ?? "(url hidden)"} · ${status.enabled ? "enabled" : `disabled (${status.disabledReason ?? "unknown"})`}`
    + `${status.lastDeliveryAt ? ` · last delivery ${status.lastDeliveryAt}` : ""}`
    + `${status.consecutiveFailures > 0 ? ` · ${status.consecutiveFailures} consecutive failures` : ""}`;
}

export async function webhookStatus(client: Pick<AgentApiClient, "pushWebhook">): Promise<RaftOutcome<RaftWebhookStatus, "status">> {
  const result = await client.pushWebhook.status();
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "status", data: result.data, next: null, text: statusText(result.data) };
}

export async function registerWebhook(
  client: Pick<AgentApiClient, "pushWebhook">,
  request: { url: string; secret: string },
): Promise<RaftOutcome<RaftWebhookStatus, "registered">> {
  const result = await client.pushWebhook.register({ url: request.url, secret: request.secret });
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "registered", data: result.data, next: null, text: statusText(result.data) };
}

export async function unregisterWebhook(client: Pick<AgentApiClient, "pushWebhook">): Promise<RaftOutcome<null, "unregistered">> {
  const result = await client.pushWebhook.unregister();
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "unregistered", data: null, next: null, text: "Push webhook: removed." };
}
