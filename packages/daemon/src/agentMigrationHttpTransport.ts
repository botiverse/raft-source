import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { currentDate } from "@botiverse/raft-shared";
import {
  assertAgentMigrationManifestSymlinkTargetsSafe,
  type AgentMigrationExportManifest,
} from "./agentMigrationExport.js";

export type AgentMigrationGrantState = "issued" | "streaming" | "interrupted" | "consumed" | "expired" | "revoked";

export interface AgentMigrationGrant {
  grantId: string;
  tokenHash: string;
  expiresAt: Date;
  oneTimeUse: boolean;
  state: AgentMigrationGrantState;
  manifest: AgentMigrationExportManifest;
  manifestSha256: string;
  bundleEtag: string;
  bundleSizeBytes: number | null;
}

export interface CreateAgentMigrationGrantInput {
  grantId?: string;
  token?: string;
  expiresAt: Date;
  manifest: AgentMigrationExportManifest;
  oneTimeUse?: boolean;
  bundleSizeBytes?: number | null;
}

export interface AgentMigrationBundleRange {
  start: number;
  end: number;
}

export interface AgentMigrationBundleRequest {
  range: AgentMigrationBundleRange | null;
  offsetBytes: number;
  lengthBytes: number | null;
}

export interface AgentMigrationHttpTransportOptions {
  bundleStreamFactory?: (grant: AgentMigrationGrant, request: AgentMigrationBundleRequest) => Readable;
  controlSeam?: boolean;
  listen?: AgentMigrationHttpTransportListenOptions;
  now?: () => Date;
}

export interface AgentMigrationHttpTransportListenOptions {
  host?: string;
  port?: number;
  publicUrl?: string;
}

export interface AgentMigrationHttpTransport {
  readonly grants: AgentMigrationGrantRegistry;
  server: http.Server;
  listen(port?: number, host?: string): Promise<{ url: string }>;
  close(): Promise<void>;
}

export const AGENT_MIGRATION_TRANSPORT_HOST_ENV = "SLOCK_AGENT_MIGRATION_TRANSPORT_HOST";
export const AGENT_MIGRATION_TRANSPORT_PORT_ENV = "SLOCK_AGENT_MIGRATION_TRANSPORT_PORT";
export const AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV = "SLOCK_AGENT_MIGRATION_TRANSPORT_PUBLIC_URL";
export const AGENT_MIGRATION_CONTROL_SEAM_ENV = "SLOCK_AGENT_MIGRATION_CONTROL_SEAM";

const CONTROL_REQUEST_MAX_BYTES = 8 * 1024 * 1024;

interface JsonError {
  code: string;
}

class MigrationBundleStreamError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class AgentMigrationGrantRegistry {
  private readonly grants = new Map<string, AgentMigrationGrant>();
  private readonly now: () => Date;

  constructor(now: () => Date = currentDate) {
    this.now = now;
  }

  createGrant(input: CreateAgentMigrationGrantInput): { grant: AgentMigrationGrant; token: string } {
    assertAgentMigrationManifestSymlinkTargetsSafe(input.manifest);
    const token = input.token ?? randomBytes(32).toString("base64url");
    const manifestSha256 = sha256Buffer(canonicalJsonBuffer(input.manifest));
    const grant: AgentMigrationGrant = {
      grantId: input.grantId ?? randomBytes(16).toString("hex"),
      tokenHash: hashToken(token),
      expiresAt: input.expiresAt,
      oneTimeUse: input.oneTimeUse ?? true,
      state: "issued",
      manifest: input.manifest,
      manifestSha256,
      bundleEtag: `"agent-migration-${manifestSha256}"`,
      bundleSizeBytes: normalizeBundleSizeBytes(input.bundleSizeBytes),
    };
    this.grants.set(grant.grantId, grant);
    return { grant, token };
  }

  get(grantId: string): AgentMigrationGrant | undefined {
    return this.grants.get(grantId);
  }

  authenticate(grantId: string, token: string | null): { ok: true; grant: AgentMigrationGrant } | { ok: false; status: number; code: string } {
    const grant = this.grants.get(grantId);
    if (!grant || !token || !verifyTokenHash(token, grant.tokenHash)) {
      return { ok: false, status: 401, code: "migration_grant_auth_failed" };
    }

    if (grant.state === "revoked" || grant.state === "consumed") {
      return { ok: false, status: 410, code: "migration_grant_unavailable" };
    }

    if (this.now().getTime() >= grant.expiresAt.getTime()) {
      grant.state = "expired";
      return { ok: false, status: 410, code: "migration_grant_unavailable" };
    }

    return { ok: true, grant };
  }

  revokeAll(): void {
    for (const grant of this.grants.values()) {
      if (grant.state !== "consumed" && grant.state !== "expired") {
        grant.state = "revoked";
      }
    }
  }

  beginBundleStream(grant: AgentMigrationGrant): boolean {
    const current = this.grants.get(grant.grantId);
    if (current !== grant) return false;
    if (current.state !== "issued" && current.state !== "interrupted") return false;
    current.state = "streaming";
    return true;
  }
}

export function createAgentMigrationHttpTransport(
  options: AgentMigrationHttpTransportOptions = {},
): AgentMigrationHttpTransport {
  const now = options.now ?? currentDate;
  const registry = new AgentMigrationGrantRegistry(now);
  const controlBundles = new Map<string, Buffer>();
  const fallbackBundleStreamFactory = options.bundleStreamFactory ?? defaultBundleStream;
  const bundleStreamFactory = (grant: AgentMigrationGrant, request: AgentMigrationBundleRequest): Readable => {
    const bundle = controlBundles.get(grant.grantId);
    if (bundle) {
      const endExclusive = request.lengthBytes === null ? undefined : request.offsetBytes + request.lengthBytes;
      return Readable.from([bundle.subarray(request.offsetBytes, endExclusive)]);
    }
    return fallbackBundleStreamFactory(grant, request);
  };
  const listenDefaults = options.listen ?? resolveAgentMigrationHttpTransportListenOptions();
  const controlSeamEnabled = options.controlSeam ?? resolveAgentMigrationControlSeamEnabled();

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (parsed.pathname.startsWith("/migration-control")) {
      void handleMigrationControlRequest(req, res, parsed, {
        enabled: controlSeamEnabled,
        now,
        registry,
        controlBundles,
      });
      return;
    }
    void handleMigrationRequest(req, res, registry, bundleStreamFactory);
  });

  return {
    grants: registry,
    server,
    listen: (port = listenDefaults.port ?? 0, host = listenDefaults.host ?? "127.0.0.1") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("migration transport listen did not produce a TCP address"));
            return;
          }
          resolve({ url: listenDefaults.publicUrl ?? `http://${formatListenAddress(address.address)}:${address.port}` });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        registry.revokeAll();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

export function resolveAgentMigrationHttpTransportListenOptions(
  env: NodeJS.ProcessEnv = process.env,
): AgentMigrationHttpTransportListenOptions {
  const host = env[AGENT_MIGRATION_TRANSPORT_HOST_ENV]?.trim();
  const port = parseOptionalPort(env[AGENT_MIGRATION_TRANSPORT_PORT_ENV]);
  const publicUrl = env[AGENT_MIGRATION_TRANSPORT_PUBLIC_URL_ENV]?.trim();
  return {
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  };
}

export function resolveAgentMigrationControlSeamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_MIGRATION_CONTROL_SEAM_ENV]?.trim() !== "0";
}

interface AgentMigrationControlContext {
  enabled: boolean;
  now: () => Date;
  registry: AgentMigrationGrantRegistry;
  controlBundles: Map<string, Buffer>;
}

async function handleMigrationControlRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsed: URL,
  context: AgentMigrationControlContext,
): Promise<void> {
  if (!context.enabled) {
    sendJson(res, 404, { code: "migration_route_not_found" });
    return;
  }

  if (parsed.pathname !== "/migration-control/grants") {
    sendJson(res, 404, { code: "migration_route_not_found" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { code: "migration_method_not_allowed" });
    return;
  }

  let rawInput: unknown;
  try {
    rawInput = await readJsonRequestBody(req, CONTROL_REQUEST_MAX_BYTES);
  } catch (err) {
    if (err instanceof MigrationBundleStreamError) {
      sendJson(res, err.code === "migration_control_payload_too_large" ? 413 : 400, { code: err.code });
      return;
    }
    sendJson(res, 400, { code: "migration_control_invalid_json" });
    return;
  }

  const input = parseControlGrantInput(rawInput, context.now);
  if (!input.ok) {
    sendJson(res, 400, { code: input.code });
    return;
  }

  const { bundle, createGrantInput } = input;
  const { grant, token } = context.registry.createGrant({
    ...createGrantInput,
    bundleSizeBytes: bundle.byteLength,
  });
  context.controlBundles.set(grant.grantId, bundle);

  sendJson(res, 201, {
    grantId: grant.grantId,
    token,
    manifestSha256: grant.manifestSha256,
    bundleSizeBytes: grant.bundleSizeBytes,
    expiresAt: grant.expiresAt.toISOString(),
    manifestUrl: `/migration/${encodeURIComponent(grant.grantId)}/manifest`,
    bundleUrl: `/migration/${encodeURIComponent(grant.grantId)}/bundle.tar`,
  });
}

async function handleMigrationRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: AgentMigrationGrantRegistry,
  bundleStreamFactory: (grant: AgentMigrationGrant, request: AgentMigrationBundleRequest) => Readable,
): Promise<void> {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = /^\/migration\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(parsed.pathname);
  if (!match) {
    sendJson(res, 404, { code: "migration_route_not_found" });
    return;
  }

  const [, grantId, resource, resourceId] = match;
  const auth = registry.authenticate(decodeURIComponent(grantId), extractBearerToken(req));
  if (!auth.ok) {
    sendJson(res, auth.status, { code: auth.code });
    return;
  }

  if (resource === "manifest" && req.method === "GET" && !resourceId) {
    sendJson(res, 200, {
      manifestSha256: auth.grant.manifestSha256,
      manifest: auth.grant.manifest,
    }, {
      "X-Raft-Manifest-Sha": auth.grant.manifestSha256,
      ETag: `"manifest-${auth.grant.manifestSha256}"`,
    });
    return;
  }

  if (resource === "bundle.tar" && !resourceId) {
    if (req.method === "HEAD") {
      sendHead(res, auth.grant);
      return;
    }
    if (req.method === "GET") {
      await streamBundle(req, res, auth.grant, registry, bundleStreamFactory);
      return;
    }
  }

  if (resource === "chunk" && req.method === "GET" && resourceId) {
    sendJson(res, 501, { code: "migration_chunk_not_implemented" });
    return;
  }

  sendJson(res, 405, { code: "migration_method_not_allowed" });
}

function sendHead(res: http.ServerResponse, grant: AgentMigrationGrant): void {
  res.statusCode = 200;
  res.setHeader("X-Raft-Manifest-Sha", grant.manifestSha256);
  res.setHeader("ETag", grant.bundleEtag);
  res.setHeader("Accept-Ranges", grant.bundleSizeBytes === null ? "none" : "bytes");
  res.setHeader("X-Raft-Bundle-Size", grant.bundleSizeBytes === null ? "unknown" : grant.bundleSizeBytes.toString());
  if (grant.bundleSizeBytes !== null) {
    res.setHeader("Content-Length", grant.bundleSizeBytes.toString());
  }
  res.end();
}

async function streamBundle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  grant: AgentMigrationGrant,
  registry: AgentMigrationGrantRegistry,
  bundleStreamFactory: (grant: AgentMigrationGrant, request: AgentMigrationBundleRequest) => Readable,
): Promise<void> {
  if (grant.state === "streaming") {
    sendJson(res, 409, { code: "migration_bundle_stream_in_progress" });
    return;
  }

  if (grant.oneTimeUse && grant.state !== "issued" && grant.state !== "interrupted") {
    sendJson(res, 410, { code: "migration_grant_unavailable" });
    return;
  }

  const range = planRange(req, grant);
  if (!range.ok) {
    sendJson(res, 416, { code: range.code }, range.headers);
    return;
  }

  const previousState = grant.state;
  if (!registry.beginBundleStream(grant)) {
    sendJson(res, 409, { code: "migration_bundle_stream_in_progress" });
    return;
  }

  let stream: Readable;
  try {
    stream = bundleStreamFactory(grant, range.request);
  } catch (err) {
    grant.state = previousState;
    const code = err instanceof MigrationBundleStreamError ? err.code : "migration_bundle_stream_failed";
    sendJson(res, 500, { code });
    return;
  }
  let completed = false;
  res.on("close", () => {
    if (!completed && grant.state === "streaming") {
      grant.state = "interrupted";
    }
  });

  try {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-tar");
    res.setHeader("X-Raft-Manifest-Sha", grant.manifestSha256);
    res.setHeader("ETag", grant.bundleEtag);
    res.setHeader("Accept-Ranges", grant.bundleSizeBytes === null ? "none" : "bytes");
    if (range.request.range) {
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${range.request.range.start}-${range.request.range.end}/${grant.bundleSizeBytes}`);
    }
    if (range.request.lengthBytes !== null) {
      res.setHeader("Content-Length", range.request.lengthBytes.toString());
    }
    for await (const chunk of stream) {
      if (!res.write(chunk)) {
        await onceDrain(res);
      }
    }
    completed = true;
    grant.state = range.consumesGrant ? "consumed" : "interrupted";
    res.end();
  } catch {
    if (!completed) {
      grant.state = "interrupted";
    }
    if (!res.headersSent) {
      sendJson(res, 500, { code: "migration_bundle_stream_failed" });
    } else {
      res.destroy();
    }
  }
}

type RangePlan =
  | {
      ok: true;
      request: AgentMigrationBundleRequest;
      consumesGrant: boolean;
    }
  | {
      ok: false;
      code: string;
      headers?: Record<string, string>;
    };

function planRange(req: http.IncomingMessage, grant: AgentMigrationGrant): RangePlan {
  const header = singleHeader(req.headers.range);
  if (!header) {
    return {
      ok: true,
      request: { range: null, offsetBytes: 0, lengthBytes: grant.bundleSizeBytes },
      consumesGrant: true,
    };
  }

  if (grant.bundleSizeBytes === null) {
    return {
      ok: false,
      code: "migration_range_not_available",
      headers: { "Accept-Ranges": "none" },
    };
  }

  const parsed = parseSingleByteRange(header, grant.bundleSizeBytes);
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${grant.bundleSizeBytes}`,
      },
    };
  }

  return {
    ok: true,
    request: {
      range: parsed.range,
      offsetBytes: parsed.range.start,
      lengthBytes: parsed.range.end - parsed.range.start + 1,
    },
    consumesGrant: parsed.range.end === grant.bundleSizeBytes - 1,
  };
}

function parseSingleByteRange(header: string, sizeBytes: number): { ok: true; range: AgentMigrationBundleRange } | { ok: false; code: string } {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) {
    return { ok: false, code: "migration_range_not_satisfiable" };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : sizeBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= sizeBytes) {
    return { ok: false, code: "migration_range_not_satisfiable" };
  }
  return {
    ok: true,
    range: {
      start,
      end: Math.min(requestedEnd, sizeBytes - 1),
    },
  };
}

function defaultBundleStream(grant: AgentMigrationGrant): Readable {
  void grant;
  throw new MigrationBundleStreamError("migration_bundle_stream_not_wired");
}

function parseControlGrantInput(
  rawInput: unknown,
  now: () => Date,
): { ok: true; bundle: Buffer; createGrantInput: CreateAgentMigrationGrantInput } | { ok: false; code: string } {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { ok: false, code: "migration_control_invalid_payload" };
  }

  const input = rawInput as Record<string, unknown>;
  const manifest = input.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, code: "migration_control_manifest_required" };
  }
  try {
    assertAgentMigrationManifestSymlinkTargetsSafe(manifest as AgentMigrationExportManifest);
  } catch {
    return { ok: false, code: "migration_control_invalid_payload" };
  }

  const bundle = decodeControlBundle(input);
  if (!bundle.ok) return bundle;

  const expiresAt = parseControlGrantExpiry(input, now);
  if (!expiresAt.ok) return expiresAt;

  const grantId = optionalNonEmptyString(input.grantId);
  const token = optionalNonEmptyString(input.token);
  const oneTimeUse = typeof input.oneTimeUse === "boolean" ? input.oneTimeUse : undefined;

  return {
    ok: true,
    bundle: bundle.bundle,
    createGrantInput: {
      ...(grantId ? { grantId } : {}),
      ...(token ? { token } : {}),
      expiresAt: expiresAt.expiresAt,
      manifest: manifest as AgentMigrationExportManifest,
      ...(oneTimeUse === undefined ? {} : { oneTimeUse }),
    },
  };
}

function decodeControlBundle(input: Record<string, unknown>): { ok: true; bundle: Buffer } | { ok: false; code: string } {
  if (typeof input.bundleBase64 === "string") {
    const normalized = input.bundleBase64.trim();
    if (!normalized) return { ok: false, code: "migration_control_bundle_required" };
    const bundle = Buffer.from(normalized, "base64");
    if (bundle.byteLength === 0) return { ok: false, code: "migration_control_bundle_required" };
    return { ok: true, bundle };
  }

  if (typeof input.bundleText === "string") {
    const bundle = Buffer.from(input.bundleText, "utf8");
    if (bundle.byteLength === 0) return { ok: false, code: "migration_control_bundle_required" };
    return { ok: true, bundle };
  }

  return { ok: false, code: "migration_control_bundle_required" };
}

function parseControlGrantExpiry(
  input: Record<string, unknown>,
  now: () => Date,
): { ok: true; expiresAt: Date } | { ok: false; code: string } {
  if (typeof input.expiresAt === "string" && input.expiresAt.trim()) {
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      return { ok: false, code: "migration_control_invalid_expiry" };
    }
    return { ok: true, expiresAt };
  }

  if (input.expiresInSeconds !== undefined) {
    const expiresInSeconds = input.expiresInSeconds;
    if (typeof expiresInSeconds !== "number" || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
      return { ok: false, code: "migration_control_invalid_expiry" };
    }
    return { ok: true, expiresAt: new Date(now().getTime() + expiresInSeconds * 1000) };
  }

  return { ok: true, expiresAt: new Date(now().getTime() + 15 * 60 * 1000) };
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBundleSizeBytes(size: number | null | undefined): number | null {
  if (size === null || size === undefined) return null;
  if (!Number.isSafeInteger(size) || size < 0) return null;
  return size;
}

function parseOptionalPort(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${AGENT_MIGRATION_TRANSPORT_PORT_ENV} must be an integer from 0 to 65535`);
  }
  return port;
}

function formatListenAddress(address: string): string {
  if (address.includes(":") && !address.startsWith("[")) return `[${address}]`;
  return address;
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const directHeader = singleHeader(req.headers["x-raft-migration-token"]);
  if (directHeader) return directHeader;
  const authorization = singleHeader(req.headers.authorization);
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function sendJson(res: http.ServerResponse, status: number, body: JsonError | Record<string, unknown>, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload).toString(),
    ...headers,
  });
  res.end(payload);
}

function readJsonRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        rejected = true;
        reject(new MigrationBundleStreamError("migration_control_payload_too_large"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch {
        reject(new MigrationBundleStreamError("migration_control_invalid_json"));
      }
    });
  });
}

function hashToken(token: string): string {
  return sha256Buffer(Buffer.from(token, "utf8"));
}

function verifyTokenHash(token: string, expectedHashHex: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHashHex, "hex");
  if (actual.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalJsonBuffer(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

function onceDrain(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => res.once("drain", resolve));
}
