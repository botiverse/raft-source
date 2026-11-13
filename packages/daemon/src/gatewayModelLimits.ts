// #proj-runtime:#53: a Built-in gateway model's context window and max output
// tokens, as the gateway's own model list reports them. The contract gateways
// implement is the public page docs.raft.build/developers/gateway-model-limits
// (raft-docs content/developers/gateway-model-limits): field names, value
// rules, when Raft reads and how it fails. Keep the two in step.
// A typed OpenRouter model (task #10) reads OpenRouter's own list through the
// same reader, as an OpenAI-compatible list (readBuiltInPresetCustomModelLimits).
//
// The list is read with the connection's own Base URL and API key, through an
// HTTP client that routes like the session's model calls. Nothing here logs or
// records the URL, the key or the response body.
//
// Formats are pluggable readers (GatewayModelListReader): each turns a parsed
// response into the limits it understands, by exact model id. The plain list
// is read with the generic reader (which also covers OpenRouter). When that
// does not give the model a valid limit, a Built-in gateway reads one more URL
// variant, `<list>?client_version=pi`, with the CLIProxyAPI reader: stock
// CLIProxyAPI strips limits from its plain list but serves its Codex-client
// catalog (the one its own Pi plugin reads) on that query.
import { createHash } from "node:crypto";

export type GatewayApiKind = "openai-compatible" | "anthropic-compatible";

/** What the gateway reported for one model; a field it did not report validly is absent. */
export interface GatewayModelLimits {
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * How the read went, for traces: `ok` (the model was listed, with at least one
 * valid limit), `not_listed` (the list was read; the model is absent),
 * `no_limits` (the model is listed but reports no valid limit),
 * `failed:<class>`, `skipped` (nothing to read for).
 */
export type GatewayModelLimitsOutcome =
  | "ok"
  | "not_listed"
  | "no_limits"
  | "skipped"
  | `failed:${GatewayModelLimitsFailure}`;

export type GatewayModelLimitsFailure = "http_status" | "redirect" | "timeout" | "too_large" | "invalid_json" | "invalid_shape" | "network";

/**
 * Which reader gave the model its limits, for traces: `generic` (the field
 * names the docs page lists), `openrouter` (the generic reader, with a value
 * from OpenRouter's `top_provider`), `cliproxyapi_pi` (CLIProxyAPI's
 * `client_version=pi` catalog).
 */
export type GatewayModelListFormat = "generic" | "openrouter" | "cliproxyapi_pi";

export interface GatewayModelLimitsResult {
  limits: GatewayModelLimits | null;
  outcome: GatewayModelLimitsOutcome;
  /** True when the answer came from the cache, not a request made for this call. */
  cached: boolean;
  /** The reader that matched; set exactly when `outcome` is `ok`. */
  format?: GatewayModelListFormat;
  /** True when the `client_version=pi` catalog was consulted (requested or cached) for this answer. */
  fallbackRead?: boolean;
}

export const GATEWAY_MODEL_LIMITS_CACHE_MS = 60 * 60_000;
export const GATEWAY_MODEL_LIMITS_TIMEOUT_MS = 5_000;
export const GATEWAY_MODEL_LIMITS_MAX_BYTES = 2 * 1024 * 1024;
/** The caps the agent form also enforces; a larger value is ignored. */
const MAX_CONTEXT_WINDOW = 10_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const ANTHROPIC_VERSION = "2023-06-01";

/** The first valid value wins, in this order (the docs page lists the same). */
const CONTEXT_WINDOW_FIELDS: readonly (readonly string[])[] = [
  ["context_length"],
  ["context_window"],
  ["max_model_len"],
  ["top_provider", "context_length"],
  // An input-only limit, used as the context window when no total is given.
  ["max_input_tokens"],
  ["input_token_limit"],
];
const MAX_TOKENS_FIELDS: readonly (readonly string[])[] = [
  ["max_completion_tokens"],
  ["max_output_tokens"],
  ["top_provider", "max_completion_tokens"],
  ["output_token_limit"],
];
/** Anthropic's Models API names max output `max_tokens`; OpenAI-style catalogs use it for different things. */
const ANTHROPIC_ONLY_MAX_TOKENS_FIELD = ["max_tokens"] as const;

function validLimit(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : undefined;
}

function readPath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstValidField(
  record: Record<string, unknown>,
  fields: readonly (readonly string[])[],
  max: number,
): { value: number; field: readonly string[] } | undefined {
  for (const field of fields) {
    const value = validLimit(readPath(record, field), max);
    if (value !== undefined) return { value, field };
  }
  return undefined;
}

function limitsOf(contextWindow: number | undefined, maxTokens: number | undefined): GatewayModelLimits | null {
  if (contextWindow === undefined && maxTokens === undefined) return null;
  return { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) };
}

function parseGenericEntry(entry: Record<string, unknown>, kind: GatewayApiKind): { limits: GatewayModelLimits; format: GatewayModelListFormat } | null {
  const contextWindow = firstValidField(entry, CONTEXT_WINDOW_FIELDS, MAX_CONTEXT_WINDOW);
  const maxTokens = firstValidField(entry, kind === "anthropic-compatible" ? [...MAX_TOKENS_FIELDS, ANTHROPIC_ONLY_MAX_TOKENS_FIELD] : MAX_TOKENS_FIELDS, MAX_OUTPUT_TOKENS);
  const limits = limitsOf(contextWindow?.value, maxTokens?.value);
  if (!limits) return null;
  const openrouter = contextWindow?.field[0] === "top_provider" || maxTokens?.field[0] === "top_provider";
  return { limits, format: openrouter ? "openrouter" : "generic" };
}

/** The limits of one model object from the gateway's list; null when it reports neither validly. */
export function parseGatewayModelEntryLimits(entry: Record<string, unknown>, kind: GatewayApiKind): GatewayModelLimits | null {
  return parseGenericEntry(entry, kind)?.limits ?? null;
}

/**
 * Every listed model's limits by exact, case-sensitive `id`, or null when the
 * body is not a `{ data: [...] }` list. A model without valid limits is left
 * out; a repeated id keeps its first entry that has valid limits.
 */
export function parseGatewayModelList(body: unknown, kind: GatewayApiKind): Map<string, GatewayModelLimits> | null {
  const list = GENERIC_MODEL_LIST_READER.read(body, kind);
  return list ? new Map([...list.models].map(([id, model]) => [id, model.limits])) : null;
}

/**
 * What a reader understood of one response: every model id it carried (with
 * or without a valid limit), and the valid limits by exact id.
 */
export interface GatewayModelListRead {
  ids: ReadonlySet<string>;
  models: ReadonlyMap<string, { limits: GatewayModelLimits; format: GatewayModelListFormat }>;
}

/**
 * One response format. `read` gets the parsed JSON body and returns null when
 * the body is not in its format; it never throws. A repeated id keeps its
 * first entry with valid limits.
 */
export interface GatewayModelListReader {
  read(body: unknown, kind: GatewayApiKind): GatewayModelListRead | null;
}

function readEntries(
  entries: unknown[],
  idOf: (entry: Record<string, unknown>) => unknown,
  parse: (entry: Record<string, unknown>) => { limits: GatewayModelLimits; format: GatewayModelListFormat } | null,
): GatewayModelListRead {
  const models = new Map<string, { limits: GatewayModelLimits; format: GatewayModelListFormat }>();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = idOf(record);
    if (typeof id !== "string" || id.length === 0) continue;
    ids.add(id);
    if (models.has(id)) continue;
    const parsed = parse(record);
    if (parsed) models.set(id, parsed);
  }
  return { ids, models };
}

function objectField(body: unknown, key: string): unknown {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[key] : undefined;
}

/** `{ data: [{ id, ...limit fields the docs page lists }] }`: OpenAI, Anthropic, OpenRouter, vLLM, LiteLLM, ... */
export const GENERIC_MODEL_LIST_READER: GatewayModelListReader = {
  read(body, kind) {
    const data = objectField(body, "data");
    if (!Array.isArray(data)) return null;
    return readEntries(data, (entry) => entry.id, (entry) => parseGenericEntry(entry, kind));
  },
};

/**
 * CLIProxyAPI's Codex-client catalog, `GET /v1/models?client_version=<v>`
 * (CLIProxyAPI sdk/api/handlers/openai/openai_handlers.go OpenAIModels ->
 * internal/client/codex/models BuildResponseForClient...):
 * `{ models: [{ slug, context_window, max_context_window, max_tokens?, ... }] }`.
 * `context_window` is the window the client works in; `max_context_window`
 * can be larger (e.g. 500000 vs 872000). Fields and order follow CLIProxyAPI's
 * own Pi plugin (@router-for-me/pi-cliproxyapi-provider, extensions/lib.ts
 * toPiModel): id `slug` then `id`; context `context_window` then
 * `max_context_window`; output `max_tokens`, `max_output_tokens`,
 * `max_completion_tokens`; `models` then `data`.
 */
const CLIPROXYAPI_CONTEXT_WINDOW_FIELDS: readonly (readonly string[])[] = [["context_window"], ["max_context_window"]];
const CLIPROXYAPI_MAX_TOKENS_FIELDS: readonly (readonly string[])[] = [["max_tokens"], ["max_output_tokens"], ["max_completion_tokens"]];

export const CLIPROXYAPI_PI_MODEL_LIST_READER: GatewayModelListReader = {
  read(body) {
    const models = objectField(body, "models");
    const data = objectField(body, "data");
    const entries = Array.isArray(models) ? models : Array.isArray(data) ? data : null;
    if (!entries) return null;
    return readEntries(
      entries,
      (entry) => (typeof entry.slug === "string" && entry.slug.length > 0 ? entry.slug : entry.id),
      (entry) => {
        const limits = limitsOf(
          firstValidField(entry, CLIPROXYAPI_CONTEXT_WINDOW_FIELDS, MAX_CONTEXT_WINDOW)?.value,
          firstValidField(entry, CLIPROXYAPI_MAX_TOKENS_FIELDS, MAX_OUTPUT_TOKENS)?.value,
        );
        return limits ? { limits, format: "cliproxyapi_pi" } : null;
      },
    );
  },
};

/** The list Raft read from one URL: what its readers understood, the first reader's entry winning per id. */
type ModelList = GatewayModelListRead;

function parseModelList(body: unknown, kind: GatewayApiKind, readers: readonly GatewayModelListReader[]): ModelList | null {
  let recognized = false;
  const ids = new Set<string>();
  const models = new Map<string, { limits: GatewayModelLimits; format: GatewayModelListFormat }>();
  for (const reader of readers) {
    const read = reader.read(body, kind);
    if (!read) continue;
    recognized = true;
    for (const id of read.ids) ids.add(id);
    for (const [id, model] of read.models) if (!models.has(id)) models.set(id, model);
  }
  return recognized ? { ids, models } : null;
}

/**
 * `<Base URL>/models`, or `<Base URL>/v1/models?limit=1000` for an
 * Anthropic-compatible gateway (the Models API pages; one response is read,
 * no further pages).
 */
export function gatewayModelListUrl(baseUrl: string, kind: GatewayApiKind): string {
  const base = baseUrl.replace(/\/+$/, "");
  return kind === "anthropic-compatible" ? `${base}/v1/models?limit=1000` : `${base}/models`;
}

/**
 * The CLIProxyAPI catalog variant: `<Base URL>/models?client_version=pi`, or
 * `<Base URL>/v1/models?client_version=pi` for an Anthropic-compatible
 * gateway (CLIProxyAPI answers `client_version` before it looks at Anthropic
 * headers).
 */
export function gatewayClientVersionCatalogUrl(baseUrl: string, kind: GatewayApiKind): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${kind === "anthropic-compatible" ? "/v1/models" : "/models"}?client_version=pi`;
}

const PLAIN_LIST_READERS: readonly GatewayModelListReader[] = [GENERIC_MODEL_LIST_READER];
const CLIENT_VERSION_CATALOG_READERS: readonly GatewayModelListReader[] = [CLIPROXYAPI_PI_MODEL_LIST_READER];

type CacheEntry =
  | { expiresAtMs: number; list: ModelList }
  | { expiresAtMs: number; failure: GatewayModelLimitsFailure };

type ReadResult = { list: ModelList } | { failure: GatewayModelLimitsFailure };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ReadResult>>();

export function resetGatewayModelLimitsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

function cacheKey(kind: GatewayApiKind, url: string, apiKey: string): string {
  return `${kind}\n${url}\n${createHash("sha256").update(apiKey).digest("hex")}`;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string | "too_large"> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return "too_large";
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readModelList(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  kind: GatewayApiKind,
  apiKey: string,
  timeoutMs: number,
  maxBytes: number,
  readers: readonly GatewayModelListReader[],
): Promise<ReadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers: Record<string, string> = kind === "anthropic-compatible"
      ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" }
      : { authorization: `Bearer ${apiKey}`, accept: "application/json" };
    // Never follow a redirect: the key goes to the Base URL and nowhere else.
    const response = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { failure: "redirect" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { failure: "http_status" };
    }
    const text = await readBodyCapped(response, maxBytes);
    if (text === "too_large") return { failure: "too_large" };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { failure: "invalid_json" };
    }
    const list = parseModelList(body, kind, readers);
    return list ? { list } : { failure: "invalid_shape" };
  } catch {
    return { failure: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** One URL variant's read, through the cache: at most one request per (kind, URL, key) per hour, shared by concurrent callers. */
async function readCached(
  input: { kind: GatewayApiKind; apiKey: string; fetch: typeof globalThis.fetch; nowMs?: () => number; timeoutMs?: number; maxBytes?: number },
  url: string,
  readers: readonly GatewayModelListReader[],
): Promise<{ result: ReadResult; cached: boolean }> {
  const now = input.nowMs ?? Date.now;
  const key = cacheKey(input.kind, url, input.apiKey);
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > now()) {
    return { result: "list" in hit ? { list: hit.list } : { failure: hit.failure }, cached: true };
  }
  let pending = inFlight.get(key);
  let cached = true;
  if (!pending) {
    cached = false;
    pending = readModelList(
      input.fetch,
      url,
      input.kind,
      input.apiKey,
      input.timeoutMs ?? GATEWAY_MODEL_LIMITS_TIMEOUT_MS,
      input.maxBytes ?? GATEWAY_MODEL_LIMITS_MAX_BYTES,
      readers,
    ).then((read) => {
      cache.set(key, { expiresAtMs: now() + GATEWAY_MODEL_LIMITS_CACHE_MS, ...read });
      return read;
    }).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }
  return { result: await pending, cached };
}

/**
 * The gateway's limits for `modelId`. Each URL variant is read at most once
 * per (kind, URL, key) per hour, shared by concurrent callers; a failed read
 * is cached for the same hour. Never throws: every failure is an outcome.
 *
 * With `clientVersionCatalog`, a plain list that was read but gives the model
 * no valid limit (`not_listed` / `no_limits`) is followed by one read of the
 * `client_version=pi` catalog (same key, timeout, size cap, no redirects). It
 * is used only when it gives the exact id a valid limit; otherwise, or when it
 * fails, the plain list's outcome stands. A failed plain read is not retried
 * there: a query string does not fix auth, network or a timeout.
 */
export async function readGatewayModelLimits(input: {
  kind: GatewayApiKind;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fetch: typeof globalThis.fetch;
  nowMs?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Read CLIProxyAPI's `client_version=pi` catalog when the plain list has no limit for the model. */
  clientVersionCatalog?: boolean;
}): Promise<GatewayModelLimitsResult> {
  let url: string;
  let catalogUrl: string;
  try {
    url = gatewayModelListUrl(input.baseUrl, input.kind);
    catalogUrl = gatewayClientVersionCatalogUrl(input.baseUrl, input.kind);
    new URL(url);
    new URL(catalogUrl);
  } catch {
    return { limits: null, outcome: "failed:network", cached: false, fallbackRead: false };
  }
  const plain = await readCached(input, url, PLAIN_LIST_READERS);
  if ("failure" in plain.result) {
    return { limits: null, outcome: `failed:${plain.result.failure}`, cached: plain.cached, fallbackRead: false };
  }
  const found = plain.result.list.models.get(input.modelId);
  if (found) return { limits: found.limits, outcome: "ok", cached: plain.cached, format: found.format, fallbackRead: false };
  const outcome = plain.result.list.ids.has(input.modelId) ? "no_limits" : "not_listed";
  if (!input.clientVersionCatalog) return { limits: null, outcome, cached: plain.cached, fallbackRead: false };
  const catalog = await readCached(input, catalogUrl, CLIENT_VERSION_CATALOG_READERS);
  const cached = plain.cached && catalog.cached;
  const fromCatalog = "list" in catalog.result ? catalog.result.list.models.get(input.modelId) : undefined;
  if (fromCatalog) return { limits: fromCatalog.limits, outcome: "ok", cached, format: fromCatalog.format, fallbackRead: true };
  return { limits: null, outcome, cached, fallbackRead: true };
}
