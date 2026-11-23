/**
 * Deterministic HTTP GET `/api/*` snapshot capture and replay for `raft-perf ab --replay`.
 *
 * Eliminates staging API latency variance when comparing two local web builds on
 * channel startup (`paintedMs`, `responseToPaintMs`): a warm capture pass records
 * the decoded API responses for both builds before pair 1, freezes the snapshot,
 * and fulfills matching `GET /api/*` requests locally during alternating pairs
 * while counting any uncached misses per arm.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export interface ReplayEntry {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

export interface ReplayMetadata {
  apiOrigin: string;
  serverSlug?: string;
  channelName?: string;
  fixtureTag?: string | null;
  /** Non-reversible 12-hex-char SHA-256 prefix of lowercased account email so snapshots never store credentials/PII while catching account mismatches. */
  accountHint?: string;
}

export interface ApiReplaySnapshot extends ReplayMetadata {
  version: 1;
  capturedAt: string;
  entries: Record<string, ReplayEntry>;
}

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "timing-allow-origin",
  "server-timing",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-expose-headers",
]);

/** Max snapshot age (24 hours) before `validateReplaySnapshot` emits a staleness warning. */
export const REPLAY_STALE_MS = 24 * 60 * 60 * 1000;

export function hashAccountHint(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex").slice(0, 12);
}

const EPHEMERAL_QUERY_KEYS = new Set(["_", "_t", "_ts", "ts", "timestamp"]);

/** Redacted route shape (`pathname` + sorted query parameter names, no values) for reporting replay misses safely. */
export function redactedApiRouteShape(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const keys = [...new Set([...parsed.searchParams.keys()].sort())];
    return `${parsed.pathname}${keys.length ? `?${keys.join("&")}` : ""}`;
  } catch {
    return rawUrl.split("?")[0] ?? rawUrl;
  }
}

/**
 * Decide whether replay misses invalidate a paired comparison (exit 2) or are minor/symmetric (note only, exit 0).
 * Invalidates when the critical first-page messages request missed on either arm, or when arm miss counts diverge
 * by more than `max(3, ceil(pairs * 0.5))`.
 */
export function evaluateReplayMisses(input: {
  baseMisses: number;
  prMisses: number;
  criticalMisses: number;
  pairs: number;
}): { fatal: boolean; reason: string | null } {
  const total = input.baseMisses + input.prMisses;
  if (total === 0 && input.criticalMisses === 0) return { fatal: false, reason: null };
  if (input.criticalMisses > 0) {
    return {
      fatal: true,
      reason: `--replay missed ${input.criticalMisses} critical first-page messages request(s) (base: ${input.baseMisses}, pr: ${input.prMisses})`,
    };
  }
  const maxSkew = Math.max(3, Math.ceil(Math.max(1, input.pairs) * 0.5));
  const skew = Math.abs(input.baseMisses - input.prMisses);
  if (skew > maxSkew) {
    return {
      fatal: true,
      reason: `--replay had asymmetric uncached GET /api/* misses (base: ${input.baseMisses}, pr: ${input.prMisses}, skew ${skew} > ${maxSkew})`,
    };
  }
  return {
    fatal: false,
    reason: `--replay had symmetric non-critical GET /api/* misses that fell back to network (base: ${input.baseMisses}, pr: ${input.prMisses})`,
  };
}

/** Build a stable lookup key for a `GET /api/*` request, sorting query parameters, normalizing wall-clock timestamps, and including `x-server-id`. */
export function canonicalApiRequestKey(method: string, rawUrl: string, headers?: Record<string, string | undefined>): string | null {
  if (method.toUpperCase() !== "GET") return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith("/api/")) return null;
  const params = [...parsed.searchParams.entries()]
    .map(([k, v]): [string, string] => [k, EPHEMERAL_QUERY_KEYS.has(k.toLowerCase()) ? "<ts>" : v])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  let serverId = "";
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "x-server-id" && v) {
        serverId = v.trim();
        break;
      }
    }
  }
  return `GET ${parsed.pathname}${query ? `?${query}` : ""}${serverId ? ` [server:${serverId}]` : ""}`;
}

/** Filter response headers down to deterministic headers safe for Playwright `route.fulfill` with decoded body bytes. */
export function sanitizeReplayHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const lower = k.toLowerCase();
    if (SAFE_RESPONSE_HEADERS.has(lower) && typeof v === "string") {
      out[lower] = v;
    }
  }
  if (!out["timing-allow-origin"]) out["timing-allow-origin"] = "*";
  if (!out["access-control-allow-origin"]) out["access-control-allow-origin"] = "*";
  return out;
}

export class ApiReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();
  readonly apiOrigin: string;
  readonly serverSlug?: string;
  readonly channelName?: string;
  readonly fixtureTag?: string | null;
  readonly accountHint?: string;
  readonly capturedAt: string;

  constructor(meta: ReplayMetadata | string, initial?: ApiReplaySnapshot) {
    const resolved: ReplayMetadata = typeof meta === "string" ? { apiOrigin: meta } : meta;
    this.apiOrigin = initial?.apiOrigin ?? resolved.apiOrigin;
    this.serverSlug = initial?.serverSlug ?? resolved.serverSlug;
    this.channelName = initial?.channelName ?? resolved.channelName;
    this.fixtureTag = initial?.fixtureTag !== undefined ? initial.fixtureTag : resolved.fixtureTag;
    this.accountHint = initial?.accountHint ?? resolved.accountHint;
    this.capturedAt = initial?.capturedAt ?? new Date().toISOString();
    if (initial) {
      for (const [k, v] of Object.entries(initial.entries)) {
        this.entries.set(k, v);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  record(key: string, status: number, rawHeaders: Record<string, string>, body: Buffer): void {
    const is2xx = status >= 200 && status < 300;
    // Cache deterministic empty-state 404s on optional routes (e.g. channel announcement / active upload session)
    // so --replay makes 0 redundant live network trips, while NEVER caching 404 on core boot routes or 401/403/429/5xx.
    const pathname = key.startsWith("GET ") ? (key.slice(4).split(/[? ]/)[0] ?? "") : "";
    const isCoreBootRoute =
      pathname === "/api/auth/me" ||
      pathname === "/api/servers" ||
      pathname === "/api/channels" ||
      pathname.startsWith("/api/messages/channel/");
    const isDeterministic404 = status === 404 && pathname.startsWith("/api/") && !isCoreBootRoute;
    if (!is2xx && !isDeterministic404) return;
    const headers = sanitizeReplayHeaders(rawHeaders);
    const contentType = headers["content-type"] ?? "application/json; charset=utf-8";
    this.entries.set(key, {
      status,
      contentType,
      headers,
      bodyBase64: body.toString("base64"),
    });
  }

  lookup(key: string): { status: number; contentType: string; headers: Record<string, string>; body: Buffer } | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    return {
      status: hit.status,
      contentType: hit.contentType,
      headers: hit.headers,
      body: Buffer.from(hit.bodyBase64, "base64"),
    };
  }

  /**
   * Check a loaded `--replay-file` against the current run's target API, account,
   * server/channel, fixture digest, and staleness threshold.
   */
  validateAgainst(
    expected: {
      apiOrigin: string;
      serverSlug: string;
      channelName: string;
      fixtureTag: string | null;
      accountEmail: string;
    },
    nowMs = Date.now(),
  ): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (this.apiOrigin.replace(/\/$/, "") !== expected.apiOrigin.replace(/\/$/, "")) {
      errors.push(`replay snapshot apiOrigin is "${this.apiOrigin}", expected "${expected.apiOrigin}"`);
    }
    if (this.serverSlug && this.serverSlug !== expected.serverSlug) {
      errors.push(`replay snapshot server is "${this.serverSlug}", expected "${expected.serverSlug}"`);
    }
    if (this.channelName && this.channelName !== expected.channelName) {
      errors.push(`replay snapshot channel is "${this.channelName}", expected "${expected.channelName}"`);
    }
    if (expected.fixtureTag && this.fixtureTag && this.fixtureTag !== expected.fixtureTag) {
      errors.push(`replay snapshot fixtureTag is "${this.fixtureTag}", expected "${expected.fixtureTag}"`);
    }
    const wantAccount = hashAccountHint(expected.accountEmail);
    if (this.accountHint && this.accountHint !== wantAccount) {
      errors.push("replay snapshot was recorded with a different test account");
    }
    const parsedTime = Date.parse(this.capturedAt);
    if (!Number.isFinite(parsedTime)) {
      warnings.push(`replay snapshot has an invalid capturedAt timestamp (${JSON.stringify(this.capturedAt)})`);
    } else if (nowMs - parsedTime > REPLAY_STALE_MS) {
      const hours = Math.round(((nowMs - parsedTime) / 3_600_000) * 10) / 10;
      warnings.push(`replay snapshot is ${hours} h old (captured ${this.capturedAt}); live server state or auth claims may have drifted`);
    }
    if (expected.fixtureTag && !this.fixtureTag) {
      warnings.push(`--fixture verified live API (${expected.fixtureTag}), while --replay-file lacks fixtureTag metadata`);
    }
    return { errors, warnings };
  }

  toSnapshot(): ApiReplaySnapshot {
    return {
      version: 1,
      capturedAt: this.capturedAt,
      apiOrigin: this.apiOrigin,
      ...(this.serverSlug ? { serverSlug: this.serverSlug } : {}),
      ...(this.channelName ? { channelName: this.channelName } : {}),
      ...(this.fixtureTag !== undefined ? { fixtureTag: this.fixtureTag } : {}),
      ...(this.accountHint ? { accountHint: this.accountHint } : {}),
      entries: Object.fromEntries([...this.entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    };
  }

  saveToFile(filePath: string): void {
    writeFileSync(filePath, `${JSON.stringify(this.toSnapshot(), null, 2)}\n`);
  }

  static loadFromFile(filePath: string): ApiReplayStore {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ApiReplaySnapshot>;
    if (raw.version !== 1 || !raw.entries || typeof raw.entries !== "object" || typeof raw.apiOrigin !== "string") {
      throw new Error(`${filePath}: invalid ApiReplaySnapshot v1 file`);
    }
    return new ApiReplayStore(raw as ReplayMetadata, raw as ApiReplaySnapshot);
  }
}
