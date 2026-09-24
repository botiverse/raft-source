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
}

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

  constructor(private readonly config: S3TraceStorageConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.region = config.region || "auto";
    this.fetchImpl = config.fetch ?? fetch;
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: S3PutOptions): Promise<{ etag?: string }> {
    const body = toBody(value);
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
    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers,
      body: body as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`R2 PUT failed with status ${response.status}`);
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
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
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
