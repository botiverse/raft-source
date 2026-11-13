import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface S3TraceStorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  fetch?: typeof fetch;
  /** Wait before each retry of a failed PUT; its length is the number of retries. */
  putRetryDelaysMs?: readonly number[];
}

// R2 answers a small share of PUTs with 429 or 5xx (about 1 in 100,000). One
// cause is its limit of one write per second to the same key, so the first
// retry waits a full second.
const DEFAULT_PUT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

export interface S3PutOptions {
  httpMetadata?: {
    contentType?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
}

export interface S3Object {
  body: ReadableStream | null;
  httpMetadata?: {
    contentType?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
}

export class S3TraceStorage {
  private readonly endpoint: string;
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;
  private readonly putRetryDelaysMs: readonly number[];

  constructor(private readonly config: S3TraceStorageConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.region = config.region || "auto";
    this.fetchImpl = config.fetch ?? fetch;
    this.putRetryDelaysMs = config.putRetryDelaysMs ?? DEFAULT_PUT_RETRY_DELAYS_MS;
  }

  // A PUT of the same key and bytes is idempotent, so 429, 5xx and network
  // errors are retried. Every failed attempt is logged on one countable line
  // (`[TraceStorage] put_failed`): a write that fails inside a request
  // otherwise surfaces only as that request's 500. An error raised before the
  // request is sent (an invalid key or header) is not a storage failure: it
  // is thrown at once, neither retried nor counted.
  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: S3PutOptions): Promise<{ etag?: string }> {
    const body = toBody(value);
    for (let attempt = 1; ; attempt += 1) {
      const retryDelayMs = this.putRetryDelaysMs[attempt - 1];
      try {
        return await this.putOnce(key, body, options);
      } catch (error) {
        if (!(error instanceof S3PutError)) throw error;
        const { status } = error;
        const willRetry = retryDelayMs !== undefined && (status === undefined || status === 429 || status >= 500);
        console.warn("[TraceStorage] put_failed", {
          key,
          attempt,
          will_retry: willRetry,
          ...(status !== undefined ? { status } : {}),
          error_message: error.message,
        });
        if (!willRetry) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  // Headers are built and signed per attempt: the signature covers the date.
  private async putOnce(key: string, body: Buffer, options?: S3PutOptions): Promise<{ etag?: string }> {
    const headers = new Headers({
      "content-length": String(body.length),
      "content-type": options?.httpMetadata?.contentType ?? "application/octet-stream",
      "x-amz-content-sha256": UNSIGNED_PAYLOAD,
    });
    if (options?.httpMetadata?.contentEncoding) headers.set("content-encoding", options.httpMetadata.contentEncoding);
    for (const [metadataKey, metadataValue] of Object.entries(options?.customMetadata ?? {})) {
      headers.set(`x-amz-meta-${metadataKey.toLowerCase()}`, metadataValue);
    }

    const url = this.objectUrl(key);
    await this.sign(headers, "PUT", url.pathname + url.search);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT",
        headers,
        body: body as BodyInit,
      });
    } catch (cause) {
      throw new S3PutError(undefined, cause);
    }
    if (!response.ok) {
      // Release the connection: the error body is not read.
      await response.body?.cancel().catch(() => undefined);
      throw new S3PutError(response.status);
    }
    return { etag: response.headers.get("etag") ?? undefined };
  }

  async get(key: string): Promise<S3Object | null> {
    const headers = new Headers({ "x-amz-content-sha256": UNSIGNED_PAYLOAD });
    const url = this.objectUrl(key);
    await this.sign(headers, "GET", url.pathname + url.search);
    return await getRawObject(url, headers);
  }

  private objectUrl(key: string): URL {
    return new URL(`${this.endpoint}/${encodeURIComponent(this.config.bucket)}/${encodeS3Key(key)}`);
  }

  private async sign(headers: Headers, method: string, canonicalPathAndQuery: string): Promise<void> {
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    headers.set("host", new URL(this.endpoint).host);
    headers.set("x-amz-date", amzDate);

    const canonicalHeaders = canonicalizeHeaders(headers);
    const signedHeaders = canonicalHeaders.map(([key]) => key).join(";");
    const canonicalRequest = [
      method,
      canonicalPathAndQuery,
      "",
      canonicalHeaders.map(([key, value]) => `${key}:${value}\n`).join(""),
      signedHeaders,
      UNSIGNED_PAYLOAD,
    ].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await sha256Hex(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.region), "s3"),
      "aws4_request",
    );
    const signature = hmacHex(signingKey, stringToSign);

    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );
  }
}

// R2 refused the PUT (`status`), or the request failed before R2 answered.
class S3PutError extends Error {
  constructor(readonly status: number | undefined, cause?: unknown) {
    super(
      status !== undefined
        ? `R2 PUT failed with status ${status}`
        : `R2 PUT failed before a response: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function getRawObject(url: URL, headers: Headers): Promise<S3Object | null> {
  return await new Promise((resolve, reject) => {
    const client = url.protocol === "http:" ? httpRequest : httpsRequest;
    const request = client(url, {
      method: "GET",
      headers: Object.fromEntries(headers.entries()),
    }, (response) => {
      if (response.statusCode === 404) {
        response.resume();
        resolve(null);
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`R2 GET failed with status ${response.statusCode ?? "unknown"}`));
        return;
      }

      const responseHeaders = headersFromIncoming(response.headers);
      resolve({
        body: Readable.toWeb(response) as ReadableStream,
        httpMetadata: {
          contentType: responseHeaders.get("content-type") ?? undefined,
          contentEncoding: responseHeaders.get("content-encoding") ?? undefined,
        },
        customMetadata: readCustomMetadata(responseHeaders),
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function headersFromIncoming(headers: import("node:http").IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

function toBody(value: ArrayBuffer | ArrayBufferView | string): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function encodeS3Key(key: string): string {
  // URL parsing collapses "." and ".." segments (encoded or not), which would
  // move the request outside the bucket path; such keys are never valid.
  const parts = key.split("/");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("object key has a dot path segment");
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

function readCustomMetadata(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const prefix = "x-amz-meta-";
    if (!key.startsWith(prefix)) continue;
    metadata[key.slice(prefix.length)] = value;
  }
  return metadata;
}

function canonicalizeHeaders(headers: Headers): Array<[string, string]> {
  return [...headers.entries()]
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
