import assert from "node:assert/strict";
import { clientIpForRateLimit, TRUST_CLOUDFRONT_VIEWER_HEADERS_ENV, trustedViewerIp } from "./clientIpForRateLimit";
import { visitorOrigin } from "./visitorOrigin";

const EDGE = "130.176.0.10";
const on = { [TRUST_CLOUDFRONT_VIEWER_HEADERS_ENV]: "true" } as NodeJS.ProcessEnv;
const off = {} as NodeJS.ProcessEnv;

function req(headers: Record<string, string | string[]>) {
  return { ip: EDGE, headers };
}

test("off by default: the proxy address is used and viewer headers are ignored", () => {
  const forged = req({ "cloudfront-viewer-address": "203.0.113.7:4000", "x-forwarded-for": "1.2.3.4, 203.0.113.7, 130.176.0.10" });
  assert.equal(clientIpForRateLimit(forged, off), EDGE);
  assert.equal(clientIpForRateLimit(forged, { [TRUST_CLOUDFRONT_VIEWER_HEADERS_ENV]: "1" } as NodeJS.ProcessEnv), EDGE, "only the literal \"true\" enables it");
});

test("on: CloudFront-Viewer-Address wins, for IPv4 and unbracketed IPv6", () => {
  assert.equal(clientIpForRateLimit(req({ "cloudfront-viewer-address": "203.0.113.7:46532" }), on), "203.0.113.7");
  assert.equal(clientIpForRateLimit(req({ "cloudfront-viewer-address": "2001:db8::1:46532" }), on), "2001:db8::1");
});

test("on: without the viewer header, the second X-Forwarded-For hop from the right is used, never a client-supplied one", () => {
  assert.equal(clientIpForRateLimit(req({ "x-forwarded-for": "203.0.113.7, 130.176.0.10" }), on), "203.0.113.7");
  assert.equal(
    clientIpForRateLimit(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.7, 130.176.0.10" }), on),
    "203.0.113.7",
    "hops the client prepended are ignored",
  );
});

test("on: malformed or missing headers fall back to the proxy address", () => {
  assert.equal(clientIpForRateLimit(req({ "cloudfront-viewer-address": "not-an-ip:1" }), on), EDGE);
  assert.equal(clientIpForRateLimit(req({ "x-forwarded-for": "130.176.0.10" }), on), EDGE);
  assert.equal(clientIpForRateLimit(req({ "x-forwarded-for": "garbage, 130.176.0.10" }), on), EDGE);
  assert.equal(clientIpForRateLimit(req({}), on), EDGE);
  assert.equal(clientIpForRateLimit({ ip: undefined, headers: {} }, on), "unknown");
});

test("trustedViewerIp: the visitor's address or null, never the edge's", () => {
  const forged = req({ "cloudfront-viewer-address": "203.0.113.7:4000", "x-forwarded-for": "1.2.3.4, 203.0.113.7, 130.176.0.10" });
  assert.equal(trustedViewerIp(forged, off), null);
  assert.equal(trustedViewerIp(forged, on), "203.0.113.7");
  // On, but nothing names the visitor: null where the rate limiter falls back to the edge.
  assert.equal(trustedViewerIp(req({}), on), null);
  assert.equal(trustedViewerIp(req({ "x-forwarded-for": "130.176.0.10" }), on), null);
  assert.equal(trustedViewerIp(req({ "cloudfront-viewer-address": "not-an-ip:1" }), on), null);
});

test("visitorOrigin: location from CloudFront's headers, only with a trusted visitor address", () => {
  const headers = {
    "cloudfront-viewer-address": "203.0.113.7:4000",
    "cloudfront-viewer-city": "S%C3%A3o%20Paulo%0D%0AX-Injected: 1",
    "cloudfront-viewer-country": "BR",
  };
  assert.deepEqual(visitorOrigin(req(headers), off), { ip: null, location: null });
  assert.deepEqual(visitorOrigin(req(headers), on), { ip: "203.0.113.7", location: "São PauloX-Injected: 1, BR" });
  assert.deepEqual(visitorOrigin(req({ "cloudfront-viewer-country": "BR" }), on), { ip: null, location: null });
  assert.deepEqual(visitorOrigin(req({ "cloudfront-viewer-address": "203.0.113.7:4000" }), on), { ip: "203.0.113.7", location: null });
});
