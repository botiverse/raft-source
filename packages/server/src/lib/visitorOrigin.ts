import type { Request } from "express";
import { trustedViewerIp } from "./clientIpForRateLimit";

// Where a request came from, for a person to check against where they are
// (the device-login approval page). Only from CloudFront's viewer headers, and
// only when they are trusted (TRUST_CLOUDFRONT_VIEWER_HEADERS, see
// clientIpForRateLimit.ts): otherwise every field is null and the page says it
// can't tell. `req.ip` is never used: in production it is CloudFront's edge.
//
// Location is CloudFront's geolocation headers (city, region, country), which
// the distribution forwards only when its origin request policy includes them.
// Storing these is a security-only decision (Tenny, device login): they live
// on the record they describe and are cleared after 30 days.

type VisitorRequest = Pick<Request, "ip"> & { headers?: Request["headers"] };

export type VisitorOrigin = {
  ip: string | null;
  /** "Seattle, Washington, United States", from whichever parts CloudFront sent. */
  location: string | null;
};

const MAX_PART_LENGTH = 80;

function headerText(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  let text = raw;
  // CloudFront percent-encodes non-ASCII city and region names.
  if (/%[0-9A-Fa-f]{2}/.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return null;
    }
  }
  text = Array.from(text).filter((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7f;
  }).join("").trim();
  if (!text) return null;
  return text.length > MAX_PART_LENGTH ? text.slice(0, MAX_PART_LENGTH) : text;
}

export function visitorOrigin(req: VisitorRequest, env: NodeJS.ProcessEnv = process.env): VisitorOrigin {
  const ip = trustedViewerIp(req, env);
  if (ip === null) return { ip: null, location: null };
  const headers = req.headers ?? {};
  const parts = [
    headerText(headers["cloudfront-viewer-city"]),
    headerText(headers["cloudfront-viewer-country-region-name"]),
    headerText(headers["cloudfront-viewer-country-name"]) ?? headerText(headers["cloudfront-viewer-country"]),
  ].filter((part): part is string => part !== null);
  return { ip, location: parts.length > 0 ? parts.join(", ") : null };
}
