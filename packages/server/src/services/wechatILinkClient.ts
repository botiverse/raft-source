import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { createSafeFetch } from "./managedMcpGateway";

// Tencent iLink bot API (WeChat ClawBot), as documented for the openclaw-weixin
// plugin (github.com/Tencent/openclaw-weixin docs/protocol.md). Raft is the
// client: it asks for a QR code, polls its status until the owner's WeChat
// confirms, and (the poll worker, PR2) long-polls getupdates and replies with
// sendmessage.
//
// Every request goes to an allowlisted origin only: https, port 443, host
// exactly ilinkai.weixin.qq.com or under .ilinkai.weixin.qq.com; never an IP
// literal, userinfo or another port. The fixed start host, a status answer's `baseurl`
// and `redirect_host` are all checked (normalizeILinkOrigin), only the
// normalized origin is kept, and it is checked again on every call. Requests
// go through the SSRF-safe fetch (managed MCP's: private addresses refused,
// redirects refused, bounded response size).
//
// Tokens (the bot token, a message's context token) and iLink's opaque ids
// (the QR polling handle, the bot and user ids) are branded, minted only by
// this module's parsers (the database columns carry the brands as types), and
// never put in an error message.

/** The fixed host every QR binding starts at. */
export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** `iLink-App-Id`: the id the openclaw-weixin plugin sends. */
export const ILINK_APP_ID = "bot";
/** The plugin version Raft speaks the protocol of (`base_info.channel_version`). */
export const ILINK_CHANNEL_VERSION = "2.4.10";
/** `iLink-App-ClientVersion`: ILINK_CHANNEL_VERSION as 0x00MMNNPP, in decimal. */
export const ILINK_APP_CLIENT_VERSION = String(encodeILinkClientVersion(ILINK_CHANNEL_VERSION));
/** `base_info.bot_agent`: an observability label only (not authentication or routing). */
export const ILINK_BOT_AGENT = "Raft/1.0";
/** `bot_type` for get_bot_qrcode / get_qrcode_status. */
export const ILINK_BOT_TYPE = "3";
/** iLink's "session expired" answer (ret or errcode): the bot token is dead; scan again. */
export const ILINK_STALE_TOKEN_CODE = -14;

const QR_CREATE_TIMEOUT_MS = 15_000;
/** get_qrcode_status is a long poll; Raft waits less and answers `wait`, so the browser's poll stays short. */
export const ILINK_QR_STATUS_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 15_000;
/** getupdates' default long poll; the server may suggest another (longpolling_timeout_ms). */
export const ILINK_LONG_POLL_TIMEOUT_MS = 35_000;
const LONG_POLL_GRACE_MS = 10_000;
/** The transport's own deadline for any iLink request: a backstop (each request has its own, shorter one). */
const ILINK_TRANSPORT_BACKSTOP_MS = ILINK_LONG_POLL_TIMEOUT_MS + 2 * LONG_POLL_GRACE_MS;
/** The longest long poll Raft waits out: with its grace it stays under the transport's backstop. */
export const ILINK_MAX_LONG_POLL_MS = ILINK_TRANSPORT_BACKSTOP_MS - LONG_POLL_GRACE_MS - 1_000;
const MAX_ID_LENGTH = 512;
const MAX_TOKEN_LENGTH = 16 * 1024;

/** The bot credential iLink issues when a QR binding is confirmed. */
export type ILinkBotToken = string & { readonly __ilinkBotToken: unique symbol };
/** The per-conversation token a reply to an inbound WeChat message must carry. */
export type WeChatContextToken = string & { readonly __wechatContextToken: unique symbol };
/**
 * iLink's handle for one QR code: polling get_qrcode_status with it yields the
 * bot token once the code is confirmed. The QR content shown to the person
 * likely embeds it too.
 */
export type ILinkQrcodeHandle = string & { readonly __ilinkQrcodeHandle: unique symbol };
/** A WeChat user as iLink names them (the scanner; an inbound sender). */
export type ILinkUserId = string & { readonly __ilinkUserId: unique symbol };
/** The ClawBot account a binding speaks as. */
export type ILinkBotId = string & { readonly __ilinkBotId: unique symbol };

export type ILinkErrorKind = "host_not_allowed" | "timeout" | "network" | "http" | "protocol" | "business";

export class ILinkRequestError extends Error {
  override readonly name: string = "ILinkRequestError";
  constructor(readonly kind: ILinkErrorKind, message: string, readonly details: { status?: number; ret?: number } = {}) {
    super(message);
  }
}

/** iLink answered ret/errcode -14: the bot token no longer works; the binding needs a new QR scan. */
export class ILinkStaleTokenError extends ILinkRequestError {
  override readonly name = "ILinkStaleTokenError";
  constructor() {
    super("business", "iLink bot token is stale (-14)", { ret: ILINK_STALE_TOKEN_CODE });
  }
}

export function encodeILinkClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

// ── Host allowlist ──────────────────────────────────────────────────────────

const ILINK_HOST = "ilinkai.weixin.qq.com";
const ILINK_HOST_SUFFIX = ".ilinkai.weixin.qq.com";

/**
 * The URL's origin (`https://<host>`) when it is an allowed iLink endpoint,
 * else null: https only, default port, no userinfo, a DNS name (never an IP)
 * that is ilinkai.weixin.qq.com or ends in .ilinkai.weixin.qq.com. Any path, query or
 * fragment is dropped: only the origin is stored and used.
 */
export function normalizeILinkOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2_048 || /[\s\0]/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.startsWith("[") || isIP(host) !== 0) return null;
  if (host !== ILINK_HOST && !(host.endsWith(ILINK_HOST_SUFFIX) && host.length > ILINK_HOST_SUFFIX.length)) return null;
  if (!/^[a-z0-9.-]+$/u.test(host) || host.includes("..")) return null;
  return `https://${host}`;
}

/** A status answer's `redirect_host` (a bare host name) as an allowed origin, else null. */
export function ilinkOriginFromRedirectHost(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || !/^[A-Za-z0-9.-]+$/u.test(raw)) return null;
  return normalizeILinkOrigin(`https://${raw}`);
}

function requireOrigin(baseUrl: string): string {
  const origin = normalizeILinkOrigin(baseUrl);
  if (!origin || origin !== baseUrl) throw new ILinkRequestError("host_not_allowed", "iLink host is not allowed");
  return origin;
}

// ── Requests ────────────────────────────────────────────────────────────────

export interface ILinkHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** X-WECHAT-UIN: a random uint32, as decimal text, base64. */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function appHeaders(): Record<string, string> {
  return { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION };
}

function postHeaders(botToken: ILinkBotToken | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...appHeaders(),
    ...(botToken ? { Authorization: `Bearer ${botToken}` } : {}),
  };
}

function baseInfo() {
  return { channel_version: ILINK_CHANNEL_VERSION, bot_agent: ILINK_BOT_AGENT };
}

export function buildGetBotQrcodeRequest(baseUrl: string = ILINK_DEFAULT_BASE_URL): ILinkHttpRequest {
  return {
    url: `${requireOrigin(baseUrl)}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`,
    method: "POST",
    // No Authorization and no base_info on this one (protocol.md).
    headers: postHeaders(null),
    body: JSON.stringify({ local_token_list: [] }),
    timeoutMs: QR_CREATE_TIMEOUT_MS,
  };
}

export function buildGetQrcodeStatusRequest(input: { baseUrl: string; qrcode: ILinkQrcodeHandle; verifyCode?: string | null }): ILinkHttpRequest {
  let url = `${requireOrigin(input.baseUrl)}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(input.qrcode)}`;
  if (input.verifyCode) url += `&verify_code=${encodeURIComponent(input.verifyCode)}`;
  // Application headers only (protocol.md: no AuthorizationType/Authorization/UIN on the status poll).
  return { url, method: "GET", headers: appHeaders(), timeoutMs: ILINK_QR_STATUS_TIMEOUT_MS };
}

export function buildGetUpdatesRequest(input: {
  baseUrl: string;
  botToken: ILinkBotToken;
  getUpdatesBuf: string | null;
  longPollTimeoutMs?: number | null;
}): ILinkHttpRequest {
  // iLink's suggestion (longpolling_timeout_ms) when it made one, else 35 s; never past the transport's backstop.
  const longPoll = input.longPollTimeoutMs && input.longPollTimeoutMs > 0
    ? Math.min(input.longPollTimeoutMs, ILINK_MAX_LONG_POLL_MS)
    : ILINK_LONG_POLL_TIMEOUT_MS;
  return {
    url: `${requireOrigin(input.baseUrl)}/ilink/bot/getupdates`,
    method: "POST",
    headers: postHeaders(input.botToken),
    body: JSON.stringify({ get_updates_buf: input.getUpdatesBuf ?? "", base_info: baseInfo() }),
    timeoutMs: longPoll + LONG_POLL_GRACE_MS,
  };
}

/** A text reply (text only in v0). `clientId` is Raft's idempotency handle for it (the Raft message id). */
export function buildSendTextMessageRequest(input: {
  baseUrl: string;
  botToken: ILinkBotToken;
  toUserId: ILinkUserId;
  clientId: string;
  contextToken: WeChatContextToken | null;
  text: string;
}): ILinkHttpRequest {
  return {
    url: `${requireOrigin(input.baseUrl)}/ilink/bot/sendmessage`,
    method: "POST",
    headers: postHeaders(input.botToken),
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: input.toUserId,
        client_id: input.clientId,
        message_type: 2,
        message_state: 2,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
        item_list: [{ type: 1, text_item: { text: input.text } }],
      },
      base_info: baseInfo(),
    }),
    timeoutMs: SEND_TIMEOUT_MS,
  };
}

// ── Responses ───────────────────────────────────────────────────────────────

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ILinkRequestError("protocol", "iLink answered with something other than JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ILinkRequestError("protocol", "iLink answered with something other than a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function boundedString(value: unknown, max = MAX_ID_LENGTH): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0") ? value : null;
}

/** -14 in ret or errcode is a stale token; any other non-zero code is a business failure. */
function checkReturnCodes(body: Record<string, unknown>): void {
  const ret = typeof body.ret === "number" ? body.ret : null;
  const errcode = typeof body.errcode === "number" ? body.errcode : null;
  if (ret === ILINK_STALE_TOKEN_CODE || errcode === ILINK_STALE_TOKEN_CODE) throw new ILinkStaleTokenError();
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    throw new ILinkRequestError("business", "iLink refused the request", { ret: ret ?? errcode ?? undefined });
  }
}

export interface ILinkQrcode {
  /** iLink's handle for the QR code (polled with get_qrcode_status). */
  qrcode: ILinkQrcodeHandle;
  /** What the QR code encodes (a URL or text to render); likely embeds the handle. */
  qrContent: string;
}

export function parseGetBotQrcodeResponse(text: string): ILinkQrcode {
  const body = parseJsonObject(text);
  checkReturnCodes(body);
  const qrcode = boundedString(body.qrcode, 4_096);
  const qrContent = boundedString(body.qrcode_img_content, 8_192);
  if (!qrcode || !qrContent) throw new ILinkRequestError("protocol", "iLink QR code answer is incomplete");
  return { qrcode: qrcode as ILinkQrcodeHandle, qrContent };
}

export const ILINK_QR_STATUSES = [
  "wait",
  "scaned",
  "confirmed",
  "expired",
  "need_verifycode",
  "verify_code_blocked",
  "scaned_but_redirect",
  "binded_redirect",
] as const;
export type ILinkQrStatusName = (typeof ILINK_QR_STATUSES)[number];

export type ILinkQrStatus =
  | { status: "wait" | "scaned" | "expired" | "need_verifycode" | "verify_code_blocked" | "binded_redirect" }
  /** `redirectBaseUrl`: where to poll next (allowlisted), or null to keep polling the same host. */
  | { status: "scaned_but_redirect"; redirectBaseUrl: string | null }
  | {
    status: "confirmed";
    botToken: ILinkBotToken;
    ilinkBotId: ILinkBotId;
    /** Who scanned: the only WeChat sender the binding will accept. */
    ilinkUserId: ILinkUserId;
    /** The bot API origin (allowlisted); the default host when iLink names none. */
    baseUrl: string;
  };

export function parseGetQrcodeStatusResponse(text: string): ILinkQrStatus {
  const body = parseJsonObject(text);
  const status = body.status;
  if (typeof status !== "string" || !(ILINK_QR_STATUSES as readonly string[]).includes(status)) {
    throw new ILinkRequestError("protocol", "iLink QR status is unknown");
  }
  const named = status as ILinkQrStatusName;
  if (named === "scaned_but_redirect") {
    if (body.redirect_host === undefined || body.redirect_host === null || body.redirect_host === "") {
      return { status: named, redirectBaseUrl: null };
    }
    const redirectBaseUrl = ilinkOriginFromRedirectHost(body.redirect_host);
    if (!redirectBaseUrl) throw new ILinkRequestError("host_not_allowed", "iLink redirect host is not allowed");
    return { status: named, redirectBaseUrl };
  }
  if (named === "confirmed") {
    const botToken = boundedString(body.bot_token, MAX_TOKEN_LENGTH);
    const ilinkBotId = boundedString(body.ilink_bot_id);
    const ilinkUserId = boundedString(body.ilink_user_id);
    if (!botToken || !ilinkBotId || !ilinkUserId) {
      throw new ILinkRequestError("protocol", "iLink confirmation is incomplete");
    }
    let baseUrl = ILINK_DEFAULT_BASE_URL;
    if (body.baseurl !== undefined && body.baseurl !== null && body.baseurl !== "") {
      const origin = normalizeILinkOrigin(body.baseurl);
      if (!origin) throw new ILinkRequestError("host_not_allowed", "iLink bot API host is not allowed");
      baseUrl = origin;
    }
    return { status: named, botToken: botToken as ILinkBotToken, ilinkBotId: ilinkBotId as ILinkBotId, ilinkUserId: ilinkUserId as ILinkUserId, baseUrl };
  }
  return { status: named };
}

export interface ILinkInboundMessage {
  /** iLink's message_id as decimal text; null when absent or not a safe integer (use the context token to dedupe). */
  messageId: string | null;
  fromUserId: ILinkUserId | null;
  toUserId: ILinkUserId | null;
  /** 1 user, 2 bot. */
  messageType: number | null;
  createTimeMs: number | null;
  contextToken: WeChatContextToken | null;
  /** The text items' text joined by newlines; null when the message has none. */
  text: string | null;
  /** Item types other than text (images, voice, files, ...): v0 mirrors text only. */
  nonTextItemTypes: number[];
}

export interface ILinkUpdates {
  messages: ILinkInboundMessage[];
  /** The cursor for the next getupdates; null when iLink sent none (keep the previous one). */
  getUpdatesBuf: string | null;
  longPollingTimeoutMs: number | null;
}

function parseInboundMessage(raw: unknown): ILinkInboundMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  const texts: string[] = [];
  const nonTextItemTypes: number[] = [];
  for (const item of Array.isArray(msg.item_list) ? msg.item_list : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const textItem = entry.text_item as Record<string, unknown> | undefined;
    if (entry.type === 1 && textItem && typeof textItem.text === "string") {
      texts.push(textItem.text);
    } else if (typeof entry.type === "number") {
      nonTextItemTypes.push(entry.type);
    }
  }
  const contextToken = boundedString(msg.context_token, MAX_TOKEN_LENGTH);
  const fromUserId = boundedString(msg.from_user_id);
  const toUserId = boundedString(msg.to_user_id);
  return {
    messageId: typeof msg.message_id === "number" && Number.isSafeInteger(msg.message_id)
      ? String(msg.message_id)
      : typeof msg.message_id === "string" && /^\d{1,32}$/u.test(msg.message_id) ? msg.message_id : null,
    fromUserId: fromUserId ? fromUserId as ILinkUserId : null,
    toUserId: toUserId ? toUserId as ILinkUserId : null,
    messageType: typeof msg.message_type === "number" ? msg.message_type : null,
    createTimeMs: typeof msg.create_time_ms === "number" && Number.isFinite(msg.create_time_ms) ? msg.create_time_ms : null,
    contextToken: contextToken ? contextToken as WeChatContextToken : null,
    text: texts.length > 0 ? texts.join("\n") : null,
    nonTextItemTypes,
  };
}

export function parseGetUpdatesResponse(text: string): ILinkUpdates {
  const body = parseJsonObject(text);
  checkReturnCodes(body);
  const messages: ILinkInboundMessage[] = [];
  for (const raw of Array.isArray(body.msgs) ? body.msgs : []) {
    const parsed = parseInboundMessage(raw);
    if (parsed) messages.push(parsed);
  }
  const cursor = typeof body.get_updates_buf === "string" && body.get_updates_buf.length > 0 ? body.get_updates_buf : null;
  const timeout = typeof body.longpolling_timeout_ms === "number" && Number.isFinite(body.longpolling_timeout_ms) && body.longpolling_timeout_ms > 0
    ? body.longpolling_timeout_ms
    : null;
  return { messages, getUpdatesBuf: cursor, longPollingTimeoutMs: timeout };
}

export function parseSendMessageResponse(text: string): void {
  // An empty body is what some deployments answer on success; protocol.md: only a non-zero ret is a failure.
  if (!text.trim()) return;
  checkReturnCodes(parseJsonObject(text));
}

// ── Transport and client ────────────────────────────────────────────────────

/** What sends one request: the SSRF-safe fetch in production, a fake in tests. */
export type ILinkTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<Response>;

let safeFetch: ReturnType<typeof createSafeFetch> | null = null;
let transportOverride: ILinkTransport | null = null;

function defaultTransport(): ILinkTransport {
  // One dispatcher for the process; its own timeout is only a backstop (each request has its deadline).
  safeFetch ??= createSafeFetch({ timeoutMs: ILINK_TRANSPORT_BACKSTOP_MS });
  const fetch = safeFetch.fetch;
  return (url, init) => fetch(url, init);
}

/** Tests: answer every iLink request with `transport` (null restores the real one). */
export function __setWeChatILinkTransportForTests(transport: ILinkTransport | null): void {
  transportOverride = transport;
}

async function send(transport: ILinkTransport, request: ILinkHttpRequest, signal?: AbortSignal): Promise<string> {
  requireOrigin(new URL(request.url).origin);
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: combined,
    });
  } catch {
    if (timeout.aborted) throw new ILinkRequestError("timeout", "iLink request timed out");
    throw new ILinkRequestError("network", "iLink could not be reached");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    if (timeout.aborted) throw new ILinkRequestError("timeout", "iLink request timed out");
    throw new ILinkRequestError("network", "iLink response could not be read");
  }
  if (!response.ok) throw new ILinkRequestError("http", `iLink answered HTTP ${response.status}`, { status: response.status });
  return text;
}

export interface WeChatILinkClient {
  getBotQrcode(options?: { signal?: AbortSignal }): Promise<ILinkQrcode>;
  /** A status poll; a timeout reads as `wait` (the poll is a long poll). */
  getQrcodeStatus(input: { baseUrl: string; qrcode: ILinkQrcodeHandle; verifyCode?: string | null; signal?: AbortSignal }): Promise<ILinkQrStatus>;
  getUpdates(input: { baseUrl: string; botToken: ILinkBotToken; getUpdatesBuf: string | null; longPollTimeoutMs?: number | null; signal?: AbortSignal }): Promise<ILinkUpdates>;
  sendTextMessage(input: { baseUrl: string; botToken: ILinkBotToken; toUserId: ILinkUserId; clientId: string; contextToken: WeChatContextToken | null; text: string; signal?: AbortSignal }): Promise<void>;
}

export function createWeChatILinkClient(options: { transport?: ILinkTransport } = {}): WeChatILinkClient {
  const transport = (): ILinkTransport => options.transport ?? transportOverride ?? defaultTransport();
  return {
    async getBotQrcode(opts = {}) {
      return parseGetBotQrcodeResponse(await send(transport(), buildGetBotQrcodeRequest(), opts.signal));
    },
    async getQrcodeStatus(input) {
      try {
        return parseGetQrcodeStatusResponse(await send(transport(), buildGetQrcodeStatusRequest(input), input.signal));
      } catch (err) {
        if (err instanceof ILinkRequestError && err.kind === "timeout") return { status: "wait" };
        throw err;
      }
    },
    async getUpdates(input) {
      try {
        return parseGetUpdatesResponse(await send(transport(), buildGetUpdatesRequest(input), input.signal));
      } catch (err) {
        // A long poll that ran out without news is an empty answer, not a failure.
        if (err instanceof ILinkRequestError && err.kind === "timeout") return { messages: [], getUpdatesBuf: null, longPollingTimeoutMs: null };
        throw err;
      }
    },
    async sendTextMessage(input) {
      parseSendMessageResponse(await send(transport(), buildSendTextMessageRequest(input), input.signal));
    },
  };
}

/** The client every caller uses (the test transport when one is set). */
export function wechatILinkClient(): WeChatILinkClient {
  return createWeChatILinkClient();
}
