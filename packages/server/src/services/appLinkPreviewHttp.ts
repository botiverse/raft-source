import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { publicPreviewUrl } from "@botiverse/raft-shared/src/appLinkPreview";
import { isPublicWebhookAddress } from "./appWebhookConfigService";
import { createAppWebhookPinnedLookup } from "./appNotificationDeliveryService";
import { hasControlCharacterKey } from "../lib/strictJson";

export type PreviewHttpOptions = {
  /** Sent as Accept-Language (version 2 callbacks; the body's `locale` wins, addendum 1 §4). */
  acceptLanguage?: string;
  /**
   * What a 200 answer resolves to:
   * - "json" (default; the domain proof): JSON.parse of the body;
   * - "preview" (a version 1 preview answer, protocol JSON): the same, after
   *   refusing a key with a C0 control character in the raw text (addendum 4 §4);
   * - "text" (a version 2 preview answer): the body as text, strict UTF-8, for
   *   the strict parser. Never JSON.parse.
   */
  response?: "json" | "preview" | "text";
  /** The whole exchange's budget, DNS included: 3 s (previews, the default); card actions pass 2.5 s. */
  timeoutMs?: number;
};
export type PreviewHttp = (url: string, body?: string, assertion?: string, options?: PreviewHttpOptions) => Promise<unknown>;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Turns a bounded 200 body into what `response` asks for; throws on anything unusable. */
export function readPreviewBody(bytes: Buffer, response: PreviewHttpOptions["response"] = "json"): unknown {
  if (response === "text") return strictUtf8.decode(bytes);
  const text = bytes.toString("utf8");
  if (response === "preview" && hasControlCharacterKey(text)) throw new Error("Invalid preview JSON");
  return JSON.parse(text);
}

/**
 * The exchange failed before a request was created: the endpoint, its DNS
 * answer or the address policy refused it, so no byte of the body left Raft.
 * A card action may treat this as proof the request was never sent (protocol
 * v3.2.3 §8.1, sent -> failed_not_sent); every other failure may have been sent.
 */
export class PreviewNotSentError extends Error {
  constructor(message: string) { super(message); this.name = "PreviewNotSentError"; }
}

/** Bounded JSON exchange; no cookies, redirects, ambient credentials or private DNS targets. */
export const previewHttp: PreviewHttp = async (raw, body, assertion, options = {}) => {
  const url = publicPreviewUrl(raw);
  if (!url) throw new PreviewNotSentError("Invalid preview endpoint");
  const budgetMs = options.timeoutMs ?? 3000;
  const deadline = Date.now() + budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: LookupAddress[];
  try {
    addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Preview DNS timeout")), budgetMs); }),
    ]).finally(() => clearTimeout(timer));
  } catch { throw new PreviewNotSentError("Preview host unavailable"); }
  if (!addresses.length || addresses.some((entry) => !isPublicWebhookAddress(entry.address)) || Date.now() >= deadline) throw new PreviewNotSentError("Preview host unavailable");
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: "https:", hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method: body === undefined ? "GET" : "POST", servername: url.hostname, rejectUnauthorized: true,
      lookup: createAppWebhookPinnedLookup(addresses[0]) as never,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        ...(assertion ? { authorization: `Bearer ${assertion}` } : {}),
        ...(options.acceptLanguage ? { "accept-language": options.acceptLanguage } : {}) },
    }, (res) => {
      if (res.statusCode !== 200 || !res.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        res.resume(); req.destroy(new Error("Preview response unavailable")); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32768) { res.destroy(new Error("Preview response too large")); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Preview response interrupted")));
      res.on("end", () => {
        clearTimeout(timeout);
        try { resolve(readPreviewBody(Buffer.concat(chunks), options.response)); } catch { reject(new Error("Invalid preview JSON")); }
      });
    });
    const timeout = setTimeout(() => req.destroy(new Error("Preview timeout")), Math.max(1, deadline - Date.now()));
    req.on("error", reject);
    req.once("close", () => clearTimeout(timeout));
    req.on("socket", (socket) => socket.once("connect", () => {
      if (!socket.remoteAddress || !isPublicWebhookAddress(socket.remoteAddress)) req.destroy(new Error("Preview connection unavailable"));
    }));
    req.end(body);
  });
};
