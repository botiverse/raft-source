export const DEFAULT_APP_URL = "http://localhost:5173";

export const LEGACY_SLOCK_APP_HOSTNAMES = [
  "app.slock.ai",
  "staging.slock.ai",
] as const;

function parseHttpUrl(raw: string | undefined | null): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeAppUrl(raw: string | undefined | null): string | null {
  return parseHttpUrl(raw)?.origin ?? null;
}

export function getConfiguredAppUrl(): string | null {
  return normalizeAppUrl(process.env.APP_URL);
}

export function getAppUrl(): string {
  return getConfiguredAppUrl() ?? DEFAULT_APP_URL;
}

function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

export function getWebCorsOrigins(raw = process.env.CORS_ORIGIN): string[] {
  const origins = parseOriginList(raw);
  if (origins.includes("*")) return ["*"];
  const appUrl = getConfiguredAppUrl();
  if (appUrl) origins.push(appUrl);
  if (origins.length === 0) origins.push(DEFAULT_APP_URL);
  return unique(origins);
}

export function getWebCorsOriginOption(raw = process.env.CORS_ORIGIN): string | string[] {
  const origins = getWebCorsOrigins(raw);
  return origins.length === 1 ? origins[0] : origins;
}

export function getWebFrameAncestorOrigins(raw = process.env.CORS_ORIGIN): string[] {
  const origins = parseOriginList(raw);
  const appUrl = getConfiguredAppUrl();
  if (appUrl) origins.push(appUrl);
  if (origins.length === 0) origins.push(DEFAULT_APP_URL);
  return unique(
    origins
      .map((origin) => normalizeAppUrl(origin))
      .filter((origin): origin is string => origin !== null),
  );
}

function hostnameFromHostOrOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const asUrl = value.includes("://") ? value : `https://${value}`;
  return parseHttpUrl(asUrl)?.hostname ?? null;
}

function getExtraPermalinkHostnames(): string[] {
  return parseOriginList(process.env.APP_PERMALINK_HOSTS)
    .map(hostnameFromHostOrOrigin)
    .filter((hostname): hostname is string => hostname !== null);
}

export function getAppPermalinkHostnames(): string[] {
  const configuredAppHost = parseHttpUrl(process.env.APP_URL)?.hostname;
  return unique([
    ...LEGACY_SLOCK_APP_HOSTNAMES,
    ...(configuredAppHost ? [configuredAppHost] : []),
    ...getExtraPermalinkHostnames(),
  ]);
}
