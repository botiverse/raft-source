// The request span's client_ip_hash (tracing/clientIpHash.ts): a salted HMAC
// of the IP rate limiters' own key, never the address, and nothing without a
// well-formed salt.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { TRUST_CLOUDFRONT_VIEWER_HEADERS_ENV } from "../lib/clientIpForRateLimit";
import { CLIENT_IP_HASH_SALT_ENV, clientIpHashAttrs } from "./clientIpHash";

const EDGE = "130.176.0.10";
const SECRET = "s".repeat(40);
const salted = (extra: Record<string, string> = {}) => ({ [CLIENT_IP_HASH_SALT_ENV]: `v1:${SECRET}`, ...extra }) as NodeJS.ProcessEnv;
const viewer = (address: string) => ({ ip: EDGE, headers: { "cloudfront-viewer-address": address } });

test("without a salt, or with a malformed one, nothing is recorded", () => {
  const req = viewer("203.0.113.7:4000");
  assert.deepEqual(clientIpHashAttrs(req, {} as NodeJS.ProcessEnv), {});
  for (const bad of ["", SECRET, "v1:short", "V1:" + SECRET, ":" + SECRET]) {
    assert.deepEqual(clientIpHashAttrs(req, { [CLIENT_IP_HASH_SALT_ENV]: bad } as NodeJS.ProcessEnv), {}, bad);
  }
});

test("the hash is a salted HMAC of the limiter key, with the salt's version, and never the address", () => {
  const attrs = clientIpHashAttrs(viewer("203.0.113.7:4000"), salted({ [TRUST_CLOUDFRONT_VIEWER_HEADERS_ENV]: "true" }));
  assert.deepEqual(attrs, {
    client_ip_hash: createHmac("sha256", SECRET).update("203.0.113.7").digest("hex").slice(0, 16),
    client_ip_hash_salt: "v1",
    client_ip_source: "viewer",
  });
  assert.ok(!JSON.stringify(attrs).includes("203.0.113"));
});

test("it follows the limiter's key: the edge address while viewer headers are not trusted, an IPv6 address as its /56", () => {
  const forged = viewer("203.0.113.7:4000");
  const edge = clientIpHashAttrs(forged, salted());
  assert.equal(edge.client_ip_source, "edge");
  assert.equal(edge.client_ip_hash, clientIpHashAttrs({ ip: EDGE, headers: {} }, salted()).client_ip_hash);
  const on = salted({ [TRUST_CLOUDFRONT_VIEWER_HEADERS_ENV]: "true" });
  const a = clientIpHashAttrs(viewer("2001:db8:abcd:1200::1:443"), on).client_ip_hash;
  const sameSubnet = clientIpHashAttrs(viewer("2001:db8:abcd:12ff::9:443"), on).client_ip_hash;
  const otherSubnet = clientIpHashAttrs(viewer("2001:db8:abcd:1300::1:443"), on).client_ip_hash;
  assert.equal(a, sameSubnet);
  assert.notEqual(a, otherSubnet);
});

test("with the flag on but no usable viewer header, the key falls back to the edge and says so", () => {
  const on = salted({ [TRUST_CLOUDFRONT_VIEWER_HEADERS_ENV]: "true" });
  const fallback = clientIpHashAttrs({ ip: EDGE, headers: {} }, on);
  assert.equal(fallback.client_ip_source, "edge");
  assert.equal(fallback.client_ip_hash, clientIpHashAttrs({ ip: EDGE, headers: {} }, salted()).client_ip_hash);
});

test("a request with no address hashes the limiters' \"unknown\" key, without throwing", () => {
  const attrs = clientIpHashAttrs({ ip: undefined, headers: undefined }, salted());
  assert.equal(attrs.client_ip_hash, createHmac("sha256", SECRET).update("unknown").digest("hex").slice(0, 16));
});

test("a new salt gives a different hash for the same address", () => {
  const req = { ip: "198.51.100.4", headers: {} };
  const before = clientIpHashAttrs(req, salted());
  const after = clientIpHashAttrs(req, { [CLIENT_IP_HASH_SALT_ENV]: `v2:${"t".repeat(40)}` } as NodeJS.ProcessEnv);
  assert.equal(after.client_ip_hash_salt, "v2");
  assert.notEqual(before.client_ip_hash, after.client_ip_hash);
});
