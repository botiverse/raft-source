/**
 * Artifact bytes from R2 through its S3-compatible API: one GetObject, signed
 * with AWS Signature Version 4 (WebCrypto), with an R2 API token that can
 * only read objects of the one bucket (Cloudflare's "Object Read only"
 * permission, scoped to that bucket). The Worker has no R2 binding: a binding
 * can put, delete and list across its whole bucket, and Cloudflare has no
 * read-only one; a token's scope is enforced by Cloudflare.
 *
 * Only what this Worker sends is signed here: GET, no body, no query string
 * (test/sigv4.test.ts checks it against AWS's published Signature Version 4
 * examples).
 */

/** Where the bucket is and the token that may read it (R2_ENDPOINT, R2_BUCKET, R2_READ_*). */
export type R2ReadSettings = {
  /** The account's S3 endpoint, an origin: `https://<account id>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

/** R2's region for Signature Version 4: always `auto`. */
export const R2_REGION = "auto";
/** The SHA-256 of an empty body: a GET's payload hash. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** How much of an error answer is read for its `<Code>` (never answered to anyone, never logged whole). */
const ERROR_BODY_BYTES = 4_096;

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (text: string) => hex(await crypto.subtle.digest("SHA-256", utf8(text)));
async function hmac(key: BufferSource, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, utf8(text));
}

/** Signature Version 4's time stamp: `20130524T000000Z`. */
export const amzDate = (now: Date): string => now.toISOString().replace(/[-:]|\.\d{3}/g, "");

/** One path segment as S3 wants it in a URL and its canonical request: RFC 3986, every byte but the unreserved ones encoded. */
export const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The headers that sign a bodiless request without a query (Signature Version 4,
 * S3's single-encoded path): the given headers, `x-amz-date` and `authorization`.
 * `host` is signed but not returned: fetch sends the URL's own. The payload
 * hash is the request's `x-amz-content-sha256`, or an empty body's.
 */
export async function signV4(
  request: { readonly method: string; readonly url: URL; readonly headers?: Readonly<Record<string, string>> },
  credentials: { readonly accessKeyId: string; readonly secretAccessKey: string },
  scope: { readonly region: string; readonly service: string },
  now: Date,
): Promise<Record<string, string>> {
  if (request.url.search !== "" || request.url.hash !== "") throw new Error("signV4 signs requests without a query");
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  headers.host = request.url.host;
  headers["x-amz-date"] = date;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    request.url.pathname,
    "",
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    signedHeaders,
    headers["x-amz-content-sha256"] ?? EMPTY_SHA256,
  ].join("\n");
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, credentialScope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(utf8(`AWS4${credentials.secretAccessKey}`), day);
  for (const part of [scope.region, scope.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** R2 answered a read with something other than the object or NoSuchKey: its status and S3 error code, nothing else. */
export class R2ReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`R2 answered ${status}${code === null ? "" : ` ${code}`}`);
    this.name = "R2ReadError";
  }
}

/** An S3 error answer's `<Code>` (a word, nothing more), from its first few KiB; the rest is dropped. */
async function errorCodeOf(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(new TextDecoder().decode(bytes))?.[1] ?? null;
}

/**
 * An object's bytes (GetObject): the 200 answer, its body a stream; null for
 * NoSuchKey. Anything else (a 403 for a token that can't read, any other 404,
 * a 5xx, a redirect) throws an R2ReadError with no part of R2's body but its
 * error code; a network failure throws as fetch does.
 */
export async function r2Get(settings: R2ReadSettings, key: string, now = new Date()): Promise<Response | null> {
  const url = new URL(`${settings.endpoint}/${encodeSegment(settings.bucket)}/${key.split("/").map(encodeSegment).join("/")}`);
  const headers = await signV4({ method: "GET", url, headers: { "x-amz-content-sha256": EMPTY_SHA256 } }, settings, { region: R2_REGION, service: "s3" }, now);
  const response = await fetch(url, { method: "GET", headers, redirect: "manual" });
  if (response.status === 200) return response;
  const code = await errorCodeOf(response);
  if (response.status === 404 && code === "NoSuchKey") return null;
  throw new R2ReadError(response.status, code);
}
