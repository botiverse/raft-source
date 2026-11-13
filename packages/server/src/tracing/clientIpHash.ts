import { createHmac } from "node:crypto";
import { ipKeyGenerator } from "express-rate-limit";

import { clientIpForRateLimit, trustedViewerIp } from "../lib/clientIpForRateLimit";

// The IP-keyed rate limiters (app.ts) could not be checked against real
// traffic: request spans carried nothing about the caller's address
// (#proj-o11y:#26, Warden; Tenny reviewed it as new user data). Each request
// span now carries a salted HMAC of exactly the limiter's key:
// ipKeyGenerator(clientIpForRateLimit(req)), so an IPv6 address is its /56,
// as the limiters count it. Grouping by the hash within one salt counts
// requests per limiter key; the raw address is never stored or traced.
//
// The salt is CLIENT_IP_HASH_SALT, `<version>:<secret>`, from SSM through the
// task definition. It is rotated on purpose: a new salt (with a new version,
// in a new SSM parameter: infra/aws-server/README.md)
// makes hashes from before and after impossible to join. The version goes on
// the span as client_ip_hash_salt so a reading never mixes two salts. Without
// a well-formed salt no attribute is recorded (never an unsalted hash).
//
// Use only for rate limiting and abuse: never join it with product.events or
// product.public_visitors, and never use it to tie a signed-out visit to an
// account (docs/observability/reading-telemetry.md).
export const CLIENT_IP_HASH_SALT_ENV = "CLIENT_IP_HASH_SALT";
const SALT = /^([a-z0-9][a-z0-9_-]{0,15}):(.{32,})$/s;
const HASH_HEX_CHARS = 16;

type Salt = { version: string; key: Buffer };
let cached: { raw: string | undefined; salt: Salt | null } | null = null;

function saltOf(env: NodeJS.ProcessEnv): Salt | null {
  const raw = env[CLIENT_IP_HASH_SALT_ENV];
  if (cached && cached.raw === raw) return cached.salt;
  const match = raw ? SALT.exec(raw.trim()) : null;
  const salt = match ? { version: match[1]!, key: Buffer.from(match[2]!, "utf8") } : null;
  cached = { raw, salt };
  return salt;
}

type ClientIpRequest = Parameters<typeof clientIpForRateLimit>[0];

/**
 * `{ client_ip_hash, client_ip_hash_salt, client_ip_source }` for a request
 * span, or `{}` without a salt. `client_ip_source` says whose address the
 * limiters keyed this request on: `viewer` (TRUST_CLOUDFRONT_VIEWER_HEADERS on
 * and a usable viewer header) or `edge` (the CloudFront edge, shared by
 * everyone behind it; also the fallback when the flag is on but no header
 * gave the visitor's address).
 */
export function clientIpHashAttrs(req: ClientIpRequest, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const salt = saltOf(env);
  if (!salt) return {};
  const limiterKey = ipKeyGenerator(clientIpForRateLimit(req, env));
  return {
    client_ip_hash: createHmac("sha256", salt.key).update(limiterKey, "utf8").digest("hex").slice(0, HASH_HEX_CHARS),
    client_ip_hash_salt: salt.version,
    client_ip_source: trustedViewerIp(req, env) !== null ? "viewer" : "edge",
  };
}
