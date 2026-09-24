import type { Request } from "express";

declare global {
  namespace Express {
    interface Request {
      observedRoutePattern?: string;
    }
  }
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEXISH_ID_SEGMENT = /^(?:[0-9a-f]{8}|[0-9a-f]{16,64})$/i;
const NUMERIC_ID_SEGMENT = /^\d+$/;

function normalizePathSegment(segment: string): string {
  if (UUID_SEGMENT.test(segment)) return ":id";
  if (HEXISH_ID_SEGMENT.test(segment)) return ":id";
  if (NUMERIC_ID_SEGMENT.test(segment)) return ":id";
  return segment;
}

function normalizePathname(pathname: string): string {
  const normalized = pathname
    .split("/")
    .map((segment) => (segment ? normalizePathSegment(segment) : segment))
    .join("/");
  return normalized || "/";
}

function normalizeQueryPattern(url: URL): string {
  const queryKeys = [...new Set(url.searchParams.keys())].sort();
  if (queryKeys.length === 0) return "";
  return `?${queryKeys.map((key) => `${key}=*`).join("&")}`;
}

function normalizeRequestPathFromUrl(rawUrl: string, includeQuery: boolean): string {
  const url = new URL(rawUrl, "http://localhost");
  const query = includeQuery ? normalizeQueryPattern(url) : "";
  return `${normalizePathname(url.pathname)}${query}`;
}

export interface RequestRoutePatternOptions {
  includeQuery?: boolean;
  unmatchedLabel?: string;
}

export function normalizeRequestRoutePattern(
  req: Request,
  {
    includeQuery = false,
    unmatchedLabel = "unmatched",
  }: RequestRoutePatternOptions = {},
): string {
  const routePath = typeof req.route?.path === "string" ? req.route.path : null;
  if (routePath) {
    const query = includeQuery
      ? normalizeQueryPattern(new URL(req.originalUrl || req.url, "http://localhost"))
      : "";
    return `${req.baseUrl || ""}${routePath}${query}`;
  }
  if (req.observedRoutePattern) {
    const query = includeQuery
      ? normalizeQueryPattern(new URL(req.originalUrl || req.url, "http://localhost"))
      : "";
    return `${req.observedRoutePattern}${query}`;
  }
  if (!includeQuery) return unmatchedLabel;
  return normalizeRequestPathFromUrl(req.originalUrl || req.url, true);
}
