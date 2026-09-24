// `raft integration invoke --service <service> --action <action>` — invoke a manifest-backed HTTP API action.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TransformCallback } from "node:stream";
import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError, CliError, type FileWriteEffectState } from "../../core/errors.js";
import { writeJson, writeText, NL, adoptCliReplyText } from "../../core/renderer.js";
import { CanonicalFetchTransportError, fetchWithCanonicalProxy } from "../../proxy.js";
import { apiFailureError } from "../_apiFailure.js";
import type { IntegrationListResponse, IntegrationLoginResponse, RegisteredIntegrationService } from "./_format.js";
import {
  cookieHeaderForUrl,
  ensureIntegrationServiceSession,
  loadStoredIntegrationSession,
  type SessionCookie,
} from "./_session.js";
import {
  type AgentManifest,
  type AgentManifestActionV0,
  type AgentManifestV0,
} from "./manifest.js";
import {
  resolveRegisteredActionBaseUrl,
} from "./actionV1.js";
import {
  actionUndeclaredV1Error,
  formatIntegrationReceiptV1,
  IntegrationV1Error,
  invokeManifestActionV1,
  localCliDesignBlockedError,
  preflightManifestActionV1,
} from "./invokeV1.js";
import type { AgentManifestActionV1, AgentManifestV1 } from "./manifestV1.js";
import {
  humanSurface,
  probeIntegrationManifest,
  type ManifestObservation,
  type ManifestProbeResult,
} from "./readiness.js";
import { buildIntegrationReadinessV1 } from "./readinessV1.js";

/** Default maximum bytes allowed for a file-response download (100 MiB). */
const DEFAULT_MAX_FILE_RESPONSE_BYTES = 100 * 1024 * 1024;
/** Absolute ceiling for file-response downloads; manifest cannot exceed this. */
const ABSOLUTE_MAX_FILE_RESPONSE_BYTES = 1024 * 1024 * 1024;

function isPosixPlatform(): boolean {
  return process.platform !== "win32";
}

function assertPosixPlatform(operation: string): void {
  if (!isPosixPlatform()) {
    throw new Error(
      `private file permissions are not supported on ${process.platform}; ${operation} requires a POSIX platform`,
    );
  }
}

function createPrivateDirectory(dirPath: string): void {
  assertPosixPlatform("private directory creation");
  fs.mkdirSync(dirPath, { mode: 0o700 });
}

function enforcePrivateDirectory(dirPath: string): void {
  assertPosixPlatform("private directory mode enforcement");
  fs.chmodSync(dirPath, 0o700);
  const stats = fs.statSync(dirPath);
  const actualMode = stats.mode & 0o777;
  if (actualMode !== 0o700) {
    throw new Error(
      `failed to enforce private directory mode 0700 for ${dirPath}: got 0${actualMode.toString(8)}`,
    );
  }
}

function createPrivateFile(filePath: string): number {
  assertPosixPlatform("private file creation");
  return fs.openSync(filePath, "w", 0o600);
}

function enforcePrivateFile(fd: number, filePath: string): void {
  assertPosixPlatform("private file mode enforcement");
  fs.fchmodSync(fd, 0o600);
  const stats = fs.fstatSync(fd);
  const actualMode = stats.mode & 0o777;
  if (actualMode !== 0o600) {
    throw new Error(
      `failed to enforce private file mode 0600 for ${filePath}: got 0${actualMode.toString(8)}`,
    );
  }
}

/**
 * Find the first ancestor of `dirPath` that does not currently exist. This is
 * the directory that `mkdirSync(..., { recursive: true })` would create first;
 * recording it before the mutation lets us emit a truthful partial-effect
 * receipt if the recursive creation fails after mutating some ancestors.
 */
function findFirstMissingAncestor(dirPath: string): string | null {
  const resolved = path.resolve(dirPath);
  if (fs.existsSync(resolved)) return null;
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  const missingParent = findFirstMissingAncestor(parent);
  return missingParent ?? resolved;
}

interface InvokeOptions {
  service?: string;
  action?: string;
  listActions?: boolean;
  preflight?: boolean;
  param?: string[];
  dataJson?: string;
  dataFile?: string;
  scope?: string[];
  target?: string;
  retryInvocation?: string;
  output?: string;
  json?: boolean;
}

interface ParsedInvokeArgs {
  serviceArg?: string;
  actionArg?: string;
  opts: InvokeOptions;
}

type ActionResult =
  | { kind: "json"; status: number; value: unknown }
  | { kind: "text"; status: number; value: string }
  | {
    kind: "file";
    status: number;
    filePath: string;
    contentType: string | null;
    size: number;
    created: boolean;
    overwritten: boolean;
    unknown: boolean;
    dirCreated: boolean;
    dirCreatedPath?: string;
    dirCleaned: boolean;
    tempDirCreated: boolean;
    tempDirCleaned: boolean;
    cleanupFailed: boolean;
    retainedTempArtifacts?: string[];
  };

type IntegrationActionListData = {
  service: string;
  manifestUrl: string | null;
  status: ManifestObservation["status"];
  surface: ManifestObservation["surface"];
  manifestObservation: ManifestObservation;
  actions: AgentManifestActionV0[];
};

const MAX_ACTION_ERROR_BODY_LENGTH = 8_192;

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function isCredentialField(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "apikey",
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "password",
    "secret",
    "session",
    "token",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function redactCredentialText(value: string): string {
  return value
    .replace(/\b(sk_(?:agent|machine|computer|daemon)_)[A-Za-z0-9._-]+/g, "$1<redacted>")
    .replace(/\b(sap_)[A-Za-z0-9._-]+/g, "$1<redacted>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>");
}

function redactActionErrorValue(value: unknown, fieldName?: string): unknown {
  if (fieldName && isCredentialField(fieldName) && value !== null && value !== undefined) {
    return "<redacted>";
  }
  if (typeof value === "string") return redactCredentialText(value);
  if (Array.isArray(value)) return value.map((item) => redactActionErrorValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactActionErrorValue(item, key)]),
    );
  }
  return value;
}

function truncateActionErrorBody(value: string): string {
  if (value.length <= MAX_ACTION_ERROR_BODY_LENGTH) return value;
  return `${value.slice(0, MAX_ACTION_ERROR_BODY_LENGTH)}...[truncated]`;
}

function formatJsonActionErrorBody(value: unknown): string {
  const serialized = JSON.stringify(redactActionErrorValue(value));
  return truncateActionErrorBody(serialized ?? "<empty>");
}

function formatTextActionErrorBody(value: string): string {
  const redacted = redactCredentialText(value.trim());
  return truncateActionErrorBody(redacted || "<empty>");
}

function formatActionErrorBody(rawBody: string): string {
  try {
    return formatJsonActionErrorBody(JSON.parse(rawBody));
  } catch {
    return formatTextActionErrorBody(rawBody);
  }
}

function actionFailureMessage(status: number, responseBody: string): string {
  return `service action failed (HTTP ${status}); response body: ${responseBody}`;
}

function rejectedSessionMessage(status: number, responseBody: string): string {
  return `service session was rejected or expired (HTTP ${status}); response body: ${responseBody}`;
}

function normalizeService(value: string): string {
  return value.trim().toLowerCase();
}

function findService(data: IntegrationListResponse, service: string): RegisteredIntegrationService | null {
  const normalized = normalizeService(service);
  if (!normalized) return null;
  return data.services.find((candidate) =>
    candidate.id === service
    || normalizeService(candidate.clientId) === normalized
    || normalizeService(candidate.name) === normalized
  ) ?? null;
}

function normalizeScopes(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const scopes = Array.from(new Set(
    raw.flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  )).sort();
  if (scopes.length === 0) {
    throw cliError("INVALID_ARG", "--scope must include at least one non-empty scope");
  }
  return scopes;
}

function parseHandlerArgs(
  serviceArgOrOpts: string | InvokeOptions | undefined,
  actionArgOrOpts: string | InvokeOptions | undefined,
  maybeOpts: InvokeOptions | undefined,
): ParsedInvokeArgs {
  if (typeof serviceArgOrOpts === "object" && serviceArgOrOpts !== null) {
    return { opts: serviceArgOrOpts };
  }
  if (typeof actionArgOrOpts === "object" && actionArgOrOpts !== null) {
    return { serviceArg: serviceArgOrOpts, opts: actionArgOrOpts };
  }
  return { serviceArg: serviceArgOrOpts, actionArg: actionArgOrOpts, opts: maybeOpts ?? {} };
}

function readTextReference(value: string): string {
  if (!value.startsWith("@")) return value;
  const path = value.slice(1);
  if (!path) throw cliError("INVALID_ARG", "@ file references must include a path");
  if (path === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(path, "utf8");
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw cliError("INVALID_ARG", `${label} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliError("INVALID_ARG", `${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

type DeclaredParamTypeLookup = (name: string) => string | readonly string[] | undefined;
type DeclaredParamType = ReturnType<DeclaredParamTypeLookup>;

function structuredParamTypeLabel(
  declaredType: DeclaredParamType,
): string | null {
  const types = (Array.isArray(declaredType) ? declaredType : [declaredType])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  const structured = ["array", "object"].filter((value) => types.includes(value));
  return structured.length > 0 ? structured.join(" or ") : null;
}

function declaredV1ParamType(
  action: AgentManifestActionV1,
  name: string,
): DeclaredParamType {
  const properties = action.input_schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
  const property = (properties as Record<string, unknown>)[name];
  if (!property || typeof property !== "object" || Array.isArray(property)) return undefined;
  const type = (property as Record<string, unknown>).type;
  if (typeof type === "string") return type;
  if (Array.isArray(type) && type.every((value) => typeof value === "string")) {
    return type as string[];
  }
  return undefined;
}

function parseActionPayload(
  opts: InvokeOptions,
  declaredParamType?: DeclaredParamTypeLookup,
): Record<string, unknown> {
  if (opts.dataJson && opts.dataFile) {
    throw cliError("INVALID_ARG", "use only one of --data-json or --data-file");
  }

  const payload: Record<string, unknown> = {};
  if (opts.dataJson) {
    Object.assign(payload, parseJsonObject(opts.dataJson, "--data-json"));
  }
  if (opts.dataFile) {
    const raw = opts.dataFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.dataFile, "utf8");
    Object.assign(payload, parseJsonObject(raw, "--data-file"));
  }

  for (const rawParam of opts.param ?? []) {
    const separator = rawParam.indexOf("=");
    if (separator <= 0) {
      throw cliError("INVALID_ARG", "--param values must use key=value");
    }
    const key = rawParam.slice(0, separator).trim();
    if (!key) throw cliError("INVALID_ARG", "--param keys must not be empty");
    const structuredType = structuredParamTypeLabel(declaredParamType?.(key));
    if (structuredType) {
      throw cliError(
        "INVALID_ARG",
        `--param ${key} is text-only, but the manifest declares ${structuredType}; use --data-json or --data-file for typed JSON`,
      );
    }
    payload[key] = readTextReference(rawParam.slice(separator + 1));
  }

  return payload;
}

function validateRequiredParams(action: AgentManifestActionV0, payload: Record<string, unknown>): void {
  for (const [name, spec] of Object.entries(action.parameters ?? {})) {
    if (!spec.required) continue;
    if (payload[name] === undefined || payload[name] === null || payload[name] === "") {
      throw cliError("INVALID_ARG", `missing required parameter ${name}`);
    }
  }
}

function safeUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw cliError("INVALID_ARG", `${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw cliError("INVALID_ARG", `${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw cliError("INVALID_ARG", `${label} must not include credentials`);
  }
  return url;
}

function endpointPathParameterNames(endpointPath: string): Set<string> {
  return new Set(Array.from(endpointPath.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (match) => match[1]));
}

function substituteEndpointPathParams(endpointPath: string, payload: Record<string, unknown>): string {
  return endpointPath.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = payload[name];
    if (value === undefined || value === null || value === "") {
      throw cliError("INVALID_ARG", `missing path parameter ${name}`);
    }
    return encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value));
  });
}

function payloadWithoutEndpointPathParams(
  endpointPath: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const pathParams = endpointPathParameterNames(endpointPath);
  return Object.fromEntries(Object.entries(payload).filter(([name]) => !pathParams.has(name)));
}

function resolveActionUrl(input: {
  service: RegisteredIntegrationService;
  manifest: AgentManifestV0;
  action: AgentManifestActionV0;
  payload: Record<string, unknown>;
}): URL {
  const base =
    input.manifest.execution.base_url
    ?? input.manifest.app_origin
    ?? input.service.homepageUrl
    ?? (input.service.returnUrl ? safeUrl(input.service.returnUrl, "service return URL").origin : null);
  if (!base) {
    throw cliError(
      "INVALID_ARG",
      "manifest must provide execution.base_url or app_origin, or the service must provide a homepage/return URL",
    );
  }
  const baseUrl = safeUrl(base, "action base URL");
  return new URL(substituteEndpointPathParams(input.action.endpoint.path, input.payload), baseUrl);
}

function appendPayloadAsQuery(url: URL, payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
}

function appendResourceLocatorQuery(input: {
  url: URL;
  action: AgentManifestActionV0;
  payload: Record<string, unknown>;
}): void {
  const { url, action, payload } = input;
  if (/\{id\}/.test(action.endpoint.path)) return;
  const id = payload.id;
  if (id === undefined || id === null || id === "" || url.searchParams.has("id")) return;
  url.searchParams.set("id", typeof id === "string" ? id : JSON.stringify(id));
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  // RFC 5987 extended filename: filename*=charset'lang'encoded-value
  const extendedMatch = /filename\*=\s*([^'"\s]+)\s*'[^']*'\s*([^;]+)/i.exec(header);
  if (extendedMatch) {
    const charset = extendedMatch[1].trim().toLowerCase();
    const encodedValue = extendedMatch[2].trim();
    if (charset !== "utf-8") return null;
    try {
      return decodeURIComponent(encodedValue);
    } catch {
      return null;
    }
  }
  // RFC 6266 simple filename, with or without quotes
  const match = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(header);
  if (!match) return null;
  const value = (match[1] ?? match[2]).trim();
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeFilename(value: string): string | null {
  const base = path.basename(value.replace(/\\/g, "/"));
  if (base === "." || base === "..") return null;
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_{2,}/g, "_").replace(/(^_|_$)/g, "");
  return sanitized || "download";
}

function defaultDownloadFilename(action: AgentManifestActionV0, contentType: string | null): string {
  const suffix = contentType?.includes("gzip") ? ".gz" : "";
  return `${action.name}${suffix}`;
}

interface DownloadPath {
  filePath: string;
  /** When set, the parent directory was created as a private temporary directory. */
  defaultTempDir?: string;
}

function resolveDownloadPath(input: {
  action: AgentManifestActionV0;
  output?: string;
  contentDisposition: string | null;
  contentType: string | null;
}): DownloadPath {
  if (input.output) {
    return { filePath: path.resolve(input.output) };
  }
  const filename = parseContentDispositionFilename(input.contentDisposition)
    ?? input.action.response?.filename
    ?? defaultDownloadFilename(input.action, input.contentType);
  const safe = sanitizeFilename(filename) ?? "download";
  // Plan a private temporary directory, but do not create it yet. Creation is
  // deferred until after all zero-effect guards (null body, declared size cap)
  // have passed, so preflight failures cannot leak world-readable directories.
  const defaultTempDir = path.join(os.tmpdir(), `raft-integration-invoke-${crypto.randomUUID()}`);
  return { filePath: path.join(defaultTempDir, safe), defaultTempDir };
}

interface FileWriteResult {
  size: number;
  created: boolean;
  overwritten: boolean;
  unknown: boolean;
  dirCreated: boolean;
  dirCreatedPath?: string;
  dirCleaned: boolean;
  tempDirCreated: boolean;
  tempDirCleaned: boolean;
  cleanupFailed: boolean;
  retainedTempArtifacts?: string[];
}

function fileWriteError(input: {
  code: "LOCAL_WRITE_SOURCE_FAILED" | "LOCAL_WRITE_DESTINATION_FAILED" | "LOCAL_WRITE_PARTIAL_FAILED" | "LOCAL_WRITE_POST_COMMIT_FAILED" | "LOCAL_WRITE_SIZE_EXCEEDED" | "LOCAL_WRITE_FAILED";
  phase: string;
  message: string;
  cause?: unknown;
  effectState: FileWriteEffectState;
  cleanupOutcome: CleanupOutcome;
}): CliError {
  // A retained artifact after cleanup failure is always a partial effect,
  // regardless of the original failure classification.
  const code = input.cleanupOutcome.kind === "retained" ? "LOCAL_WRITE_PARTIAL_FAILED" : input.code;
  const phase = input.cleanupOutcome.kind === "retained" ? "partial_cleanup" : input.phase;
  return cliError(code, input.message, {
    cause: input.cause,
    faultDomain: `file_write:${phase}`,
    effectState: input.effectState,
  });
}

/**
 * Construct a terminal file-write error before any filesystem effects exist.
 * Pre-effect failures have no artifact to clean up, so they do not need a
 * `CleanupOutcome`; using a separate helper guarantees that post-effect callers
 * cannot accidentally bypass the finalizer.
 */
function fileWriteErrorBeforeEffects(input: {
  code: "LOCAL_WRITE_FAILED" | "LOCAL_WRITE_SIZE_EXCEEDED";
  phase: string;
  message: string;
  cause?: unknown;
  effectState: FileWriteEffectState;
}): CliError {
  return cliError(input.code, input.message, {
    cause: input.cause,
    faultDomain: `file_write:${input.phase}`,
    effectState: input.effectState,
  });
}

/**
 * A deferred failure descriptor thrown inside `writeFileResponse` when a failure
 * occurs after filesystem effects exist. The terminal `CliError` must be built
 * only after `CleanupOutcome.finalize` has run and returned the final disk state.
 * This guarantees that the receipt reflects the actual outcome, not a snapshot
 * taken before cleanup.
 */
class FileWriteFailure extends Error {
  constructor(public readonly descriptor: {
    code: "LOCAL_WRITE_SIZE_EXCEEDED" | "LOCAL_WRITE_SOURCE_FAILED" | "LOCAL_WRITE_DESTINATION_FAILED" | "LOCAL_WRITE_FAILED";
    phase: string;
    message: string;
    cause?: unknown;
    bytesWritten?: number;
  }) {
    super(descriptor.message);
  }
}

class ByteLimitTransform extends Transform {
  private bytesReceived = 0;
  private limitExceeded = false;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytesReceived += chunk.length;
    if (this.bytesReceived > this.limit) {
      this.limitExceeded = true;
      callback(new Error(`file response exceeds maximum allowed size of ${this.limit} bytes`));
      return;
    }
    callback(null, chunk);
  }

  get exceeded(): boolean {
    return this.limitExceeded;
  }
}

/**
 * Opaque cleanup outcome. The private constructor and nominal brand prevent
 * callers from fabricating a structural `{ kind: "cleaned" }` literal, and the
 * private `cleaned` factory ensures that a `kind=cleaned` value is only ever
 * produced as the witness of an actual cleanup operation performed by
 * `CleanupOutcome.finalize`. Terminal receipts must be constructed from a value
 * produced by the finalizer so the receipt reflects the actual disk state.
 */
export class CleanupOutcome {
  private readonly __cleanupOutcomeBrand = "CleanupOutcome";
  private constructor(
    public readonly kind: "cleaned" | "retained",
    public readonly path?: string,
  ) {}
  private static cleaned(): CleanupOutcome {
    return new CleanupOutcome("cleaned");
  }
  /**
   * Public factory for intentionally retained artifacts. This is safe to expose
   * because it always promotes the terminal receipt to PARTIAL and carries the
   * exact retained path; it cannot hide an artifact.
   */
  static retained(path: string): CleanupOutcome {
    return new CleanupOutcome("retained", path);
  }
  private static removeArtifact(artifactPath: string): string | null {
    try {
      fs.rmSync(artifactPath, { recursive: true, force: true });
      return null;
    } catch {
      return artifactPath;
    }
  }
  /**
   * The only public way to obtain a `kind=cleaned` outcome: perform the cleanup,
   * update the receipt, and return cleaned only if the artifact was actually
   * removed. A retained path is returned if cleanup fails.
   */
  static finalize(
    artifactPath: string,
    effect: FileWriteEffectState,
    options: {
      cleanedField: "dirCleaned" | "tempDirCleaned";
      bytesWritten?: number;
    },
  ): CleanupOutcome {
    if (options.bytesWritten !== undefined && effect.bytesWritten === undefined) {
      effect.bytesWritten = options.bytesWritten;
    }
    const retained = CleanupOutcome.removeArtifact(artifactPath);
    if (retained) {
      effect.cleanupFailed = true;
      effect.retainedTempArtifacts = [...(effect.retainedTempArtifacts ?? []), retained];
      return CleanupOutcome.retained(retained);
    }
    effect[options.cleanedField] = true;
    // The artifact is gone: remove it from retained-state bookkeeping. Retained
    // paths are terminal state, not append-only creation facts.
    effect.retainedTempArtifacts = effect.retainedTempArtifacts?.filter((p) => p !== artifactPath);
    if (options.cleanedField === "dirCleaned") {
      effect.retainedParentDirs = undefined;
    }
    return CleanupOutcome.cleaned();
  }
}

/**
 * A writable stream backed by an already-open file descriptor that counts bytes
 * actually written through successful `fs.write` callbacks. This is the
 * authoritative source for `bytesWritten`: it records destination-accepted
 * bytes, not upstream attempted bytes.
 *
 * The stream waits for all in-flight `fs.write` callbacks to settle before
 * closing the file descriptor. Callers must `await destination.settled()` after
 * a pipeline failure before reading `bytesWritten` or finalizing cleanup, so the
 * receipt reflects every byte that was actually accepted by the destination.
 */
class CountingFileWritable extends Writable {
  bytesWritten = 0;
  private fd: number;
  private fdClosed = false;
  private pendingWrites = 0;
  private closeCallback: ((error: Error | null) => void) | null = null;
  private closeError: Error | null = null;
  private settledResolve!: () => void;
  private settledPromise: Promise<void>;

  constructor(fd: number) {
    super();
    this.fd = fd;
    this.settledPromise = new Promise((resolve) => {
      this.settledResolve = resolve;
    });
  }

  /**
   * Resolves once all in-flight writes have settled and the file descriptor has
   * been closed. Safe to call multiple times.
   */
  settled(): Promise<void> {
    return this.settledPromise;
  }

  private writeChunk(chunk: Buffer, callback: (error?: Error | null) => void, offset = 0): void {
    this.pendingWrites++;
    fs.write(this.fd, chunk, offset, chunk.length - offset, null, (err, written) => {
      this.pendingWrites--;
      if (err) {
        callback(err);
      } else if (written === undefined || written <= 0) {
        // A zero-progress write would otherwise recurse forever on the same
        // offset. Treat it as a destination no-progress error.
        callback(new Error(`destination write made no progress (written=${written ?? "undefined"})`));
      } else {
        this.bytesWritten += written;
        if (offset + written < chunk.length) {
          this.writeChunk(chunk, callback, offset + written);
          return;
        }
        callback();
      }
      this.tryClose();
    });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    // Defensive: do not accept new writes once destroy has been requested.
    if (this.closeCallback) {
      callback(new Error("CountingFileWritable is being destroyed"));
      return;
    }
    this.writeChunk(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void) {
    callback();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (this.fdClosed) {
      callback(error);
      return;
    }
    this.closeCallback = callback;
    this.closeError = error;
    this.tryClose();
  }

  private tryClose(): void {
    if (!this.closeCallback || this.pendingWrites > 0 || this.fdClosed) {
      return;
    }
    this.fdClosed = true;
    fs.close(this.fd, (closeErr) => {
      const cb = this.closeCallback!;
      this.closeCallback = null;
      cb(this.closeError ?? closeErr);
      this.settledResolve();
    });
  }
}

async function writeFileResponse(input: {
  response: Response;
  filePath: string;
  defaultTempDir?: string;
  maxBytes: number;
}): Promise<FileWriteResult> {
  const target = path.resolve(input.filePath);
  const parentDir = path.dirname(target);
  const effect: FileWriteEffectState = {
    targetPath: target,
    targetCommitted: false,
    unknown: true,
    created: false,
    overwritten: false,
  };
  let tempDir: string | null = null;
  let tempFile: string | null = null;

  try {
    const body = input.response.body;
    if (!body) {
      throw fileWriteErrorBeforeEffects({
        code: "LOCAL_WRITE_FAILED",
        phase: "prepare",
        message: "service action returned an empty file response body",
        effectState: effect,
      });
    }

    // Guard: reject file responses whose declared size exceeds the cap before
    // creating any filesystem effects. Content-Length is advisory; the streaming
    // cap below is the authoritative limit.
    const contentLengthHeader = input.response.headers.get("content-length");
    const declaredLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
    if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
      throw fileWriteErrorBeforeEffects({
        code: "LOCAL_WRITE_SIZE_EXCEEDED",
        phase: "size_limit",
        message: `file response declared size (${declaredLength} bytes) exceeds maximum allowed size (${input.maxBytes} bytes)`,
        effectState: effect,
      });
    }

    // Phase: prepare — create directories only after all zero-effect guards.
    let dirCreatedPath: string | undefined;
    if (input.defaultTempDir) {
      // Default temp dir must be private; it is part of the security contract.
      // The directory is created first, its effect is recorded immediately, and
      // only then do we attempt to enforce its mode. This ordering guarantees
      // that any cleanup after an enforcement failure sees the real path.
      try {
        createPrivateDirectory(input.defaultTempDir);
      } catch (error) {
        throw fileWriteErrorBeforeEffects({
          code: "LOCAL_WRITE_FAILED",
          phase: "prepare",
          message: `failed to create private temporary directory ${input.defaultTempDir}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
          effectState: effect,
        });
      }
      dirCreatedPath = input.defaultTempDir;
      effect.dirCreated = true;
      effect.dirCreatedPath = dirCreatedPath;
      effect.retainedParentDirs = [dirCreatedPath];
      try {
        enforcePrivateDirectory(input.defaultTempDir);
      } catch (error) {
        const cleanupOutcome = CleanupOutcome.finalize(dirCreatedPath, effect, { cleanedField: "dirCleaned" });
        throw fileWriteError({
          code: "LOCAL_WRITE_FAILED",
          phase: "prepare",
          message: cleanupOutcome.kind === "retained"
            ? `created private temporary directory ${dirCreatedPath} but could not enforce its mode or remove it: ${error instanceof Error ? error.message : String(error)}`
            : `failed to enforce private mode for temporary directory ${dirCreatedPath}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
          effectState: effect,
          cleanupOutcome,
        });
      }
    } else {
      // User-controlled parent directory: only create missing ancestors.
      let firstMissingAncestor: string | null = null;
      try {
        firstMissingAncestor = findFirstMissingAncestor(parentDir);
        dirCreatedPath = fs.mkdirSync(parentDir, { recursive: true }) ?? undefined;
      } catch (error) {
        if (firstMissingAncestor && fs.existsSync(firstMissingAncestor)) {
          // Recursive mkdir created at least one ancestor before failing. The
          // failure is therefore a partial effect, not a pre-effect error.
          effect.dirCreated = true;
          effect.dirCreatedPath = firstMissingAncestor;
          effect.retainedParentDirs = [firstMissingAncestor];
          throw fileWriteError({
            code: "LOCAL_WRITE_FAILED",
            phase: "prepare",
            message: `failed to create output directory ${parentDir}: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
            effectState: effect,
            cleanupOutcome: CleanupOutcome.retained(firstMissingAncestor),
          });
        }
        throw fileWriteErrorBeforeEffects({
          code: "LOCAL_WRITE_FAILED",
          phase: "prepare",
          message: `failed to create output directory ${parentDir}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
          effectState: effect,
        });
      }
    }
    effect.dirCreated = dirCreatedPath !== undefined;
    effect.dirCreatedPath = dirCreatedPath;
    effect.retainedParentDirs = dirCreatedPath ? [dirCreatedPath] : undefined;

    // Create a private staging temp directory inside the parent so the final
    // rename is atomic and stays on the same filesystem.
    tempDir = path.join(parentDir, `.raft-invoke-write-${crypto.randomUUID()}`);
    try {
      createPrivateDirectory(tempDir);
    } catch (error) {
      // Only the system-owned default temp dir may be auto-cleaned on staging
      // failure. Explicit output ancestors are intentionally retained: we cannot
      // safely distinguish newly-created ancestors from pre-existing user data.
      if (dirCreatedPath && dirCreatedPath === input.defaultTempDir) {
        const cleanupOutcome = CleanupOutcome.finalize(dirCreatedPath, effect, { cleanedField: "dirCleaned" });
        throw fileWriteError({
          code: "LOCAL_WRITE_FAILED",
          phase: "prepare",
          message: cleanupOutcome.kind === "retained"
            ? `failed to create private temporary write directory in ${parentDir} and could not clean up ${dirCreatedPath}: ${error instanceof Error ? error.message : String(error)}`
            : `failed to create private temporary write directory in ${parentDir}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
          effectState: effect,
          cleanupOutcome,
        });
      }
      if (dirCreatedPath) {
        // An explicit output ancestor was created before staging failed; it is
        // user-controlled and intentionally retained.
        effect.dirCreated = true;
        effect.dirCreatedPath = dirCreatedPath;
        effect.retainedParentDirs = [dirCreatedPath];
        throw fileWriteError({
          code: "LOCAL_WRITE_FAILED",
          phase: "prepare",
          message: `failed to create private temporary write directory in ${parentDir}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
          effectState: effect,
          cleanupOutcome: CleanupOutcome.retained(dirCreatedPath),
        });
      }
      // No filesystem artifact was created.
      throw fileWriteErrorBeforeEffects({
        code: "LOCAL_WRITE_FAILED",
        phase: "prepare",
        message: `failed to create private temporary write directory in ${parentDir}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
        effectState: effect,
      });
    }
    effect.tempDirCreated = true;
    try {
      enforcePrivateDirectory(tempDir);
    } catch (error) {
      const failedTempDir = tempDir;
      const cleanupOutcome = CleanupOutcome.finalize(failedTempDir, effect, { cleanedField: "tempDirCleaned" });
      tempDir = null;
      throw fileWriteError({
        code: "LOCAL_WRITE_FAILED",
        phase: "prepare",
        message: cleanupOutcome.kind === "retained"
          ? `created temporary write directory ${failedTempDir} but could not enforce its mode or remove it: ${error instanceof Error ? error.message : String(error)}`
          : `failed to enforce private mode for temporary write directory ${failedTempDir}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
        effectState: effect,
        cleanupOutcome,
      });
    }
    tempFile = path.join(tempDir, "payload");

    // Phase: stream — copy the response body into the private temp file.
    // We listen for errors on all sides so that source-read,
    // destination-write, and size-limit failures can be classified separately.
    let failedSide: "source" | "destination" | null = null;
    let sizeLimitExceeded = false;
    const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
    source.on("error", () => {
      if (!failedSide) failedSide = "source";
    });
    const byteLimit = new ByteLimitTransform(input.maxBytes);
    byteLimit.on("error", () => {
      if (byteLimit.exceeded) {
        sizeLimitExceeded = true;
      }
    });

    let fd: number;
    try {
      fd = createPrivateFile(tempFile);
    } catch (error) {
      // Defer terminal error construction until after the staging temp directory
      // has been finalized. The temp directory was created before this step, so
      // a failed open still requires cleanup.
      throw new FileWriteFailure({
        code: "LOCAL_WRITE_FAILED",
        phase: "prepare",
        message: `failed to create private temporary file ${tempFile}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
    effect.tempFileCreated = true;
    effect.tempFilePath = tempFile;
    try {
      enforcePrivateFile(fd, tempFile);
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failure; the cleanup path below owns the final state.
      }
      const failedTempDir = tempDir;
      const cleanupOutcome = CleanupOutcome.finalize(failedTempDir, effect, { cleanedField: "tempDirCleaned" });
      tempDir = null;
      throw fileWriteError({
        code: "LOCAL_WRITE_FAILED",
        phase: "prepare",
        message: cleanupOutcome.kind === "retained"
          ? `created private temporary file ${tempFile} but could not enforce its mode or remove it: ${error instanceof Error ? error.message : String(error)}`
          : `failed to enforce private mode for temporary file ${tempFile}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
        effectState: effect,
        cleanupOutcome,
      });
    }
    let destination: CountingFileWritable;
    try {
      destination = new CountingFileWritable(fd);
    } catch (error) {
      // Defer terminal error construction until the staging temp directory has
      // been finalized. The temp file was opened before this step, so a failed
      // stream setup still requires cleanup.
      throw new FileWriteFailure({
        code: "LOCAL_WRITE_FAILED",
        phase: "prepare",
        message: `failed to create destination stream for ${tempFile}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
    destination.on("error", () => {
      if (!failedSide) failedSide = "destination";
    });

    try {
      await pipeline(source, byteLimit, destination);
    } catch (error) {
      // Wait for any in-flight destination writes to settle before reading the
      // counter; otherwise a teardown race could omit bytes whose callbacks
      // complete after `pipeline` rejects.
      await destination.settled();
      // Record bytes actually written by the destination stream; CountingFileWritable
      // counts only bytes that made it through a successful fs.write callback.
      const bytesWritten = destination.bytesWritten;
      if (sizeLimitExceeded) {
        throw new FileWriteFailure({
          code: "LOCAL_WRITE_SIZE_EXCEEDED",
          phase: "size_limit",
          message: `file response exceeds maximum allowed size of ${input.maxBytes} bytes`,
          cause: error,
          bytesWritten,
        });
      }
      const side = failedSide ?? "source";
      if (side === "source") {
        throw new FileWriteFailure({
          code: "LOCAL_WRITE_SOURCE_FAILED",
          phase: "source_read",
          message: `failed to read response body from service: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
          bytesWritten,
        });
      }
      throw new FileWriteFailure({
        code: "LOCAL_WRITE_DESTINATION_FAILED",
        phase: "destination_write",
        message: `failed to write response body to temporary file: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
        bytesWritten,
      });
    }

    // Phase: commit — atomically publish the completed temp file.
    try {
      fs.renameSync(tempFile, target);
      effect.targetCommitted = true;
    } catch (error) {
      // Defer terminal error construction until the staging temp directory has
      // been finalized; the temp file still exists after a failed rename.
      await destination.settled();
      throw new FileWriteFailure({
        code: "LOCAL_WRITE_FAILED",
        phase: "commit",
        message: `failed to commit downloaded file to ${target}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
        bytesWritten: destination.bytesWritten,
      });
    }

    // The file is now committed. Best-effort cleanup of the empty staging
    // directory; failure is recorded as a partial effect but does not undo success.
    const committedTempDir = tempDir;
    const postCommitCleanupOutcome = CleanupOutcome.finalize(committedTempDir, effect, { cleanedField: "tempDirCleaned" });
    tempDir = null;
    tempFile = null;

    // Phase: receipt — derive the receipt from the committed file on disk.
    let stats: fs.Stats;
    try {
      stats = fs.statSync(target);
      effect.bytesWritten = stats.size;
    } catch (error) {
      throw fileWriteError({
        code: "LOCAL_WRITE_POST_COMMIT_FAILED",
        phase: "post_commit",
        message: `file was written to ${target} but could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
        effectState: effect,
        cleanupOutcome: postCommitCleanupOutcome,
      });
    }

    return {
      size: stats.size,
      created: false,
      overwritten: false,
      unknown: true,
      dirCreated: effect.dirCreated ?? false,
      dirCreatedPath,
      dirCleaned: effect.dirCleaned ?? false,
      tempDirCreated: effect.tempDirCreated ?? false,
      tempDirCleaned: effect.tempDirCleaned ?? false,
      cleanupFailed: effect.cleanupFailed ?? false,
      retainedTempArtifacts: effect.retainedTempArtifacts,
    };
  } catch (error) {
    if (error instanceof FileWriteFailure) {
      // Roll back the uncommitted temp directory and construct the terminal
      // receipt only after the final disk state is known. Parent directories
      // created by mkdirSync are intentionally retained: we cannot safely
      // distinguish newly-created ancestors from pre-existing ones.
      if (tempDir) {
        const cleanupOutcome = CleanupOutcome.finalize(tempDir, effect, {
          cleanedField: "tempDirCleaned",
          bytesWritten: error.descriptor.bytesWritten,
        });
        const message = cleanupOutcome.kind === "retained"
          ? `failed during file write and could not clean up partial artifact: ${error.descriptor.message}`
          : error.descriptor.message;
        throw fileWriteError({
          code: error.descriptor.code,
          phase: error.descriptor.phase,
          message,
          cause: error.descriptor.cause,
          effectState: effect,
          cleanupOutcome,
        });
      }
      // No temporary artifact remains (any explicit output ancestor is
      // intentionally retained and already recorded in effect_state).
      throw cliError(error.descriptor.code, error.descriptor.message, {
        cause: error.descriptor.cause,
        faultDomain: `file_write:${error.descriptor.phase}`,
        effectState: effect,
      });
    }
    if (error instanceof CliError) throw error;
    // Unexpected errors after filesystem effects also need cleanup. The terminal
    // receipt must be built from the cleanup outcome, not from a pre-cleanup
    // snapshot.
    let bytesWritten: number | undefined;
    if (tempFile) {
      try {
        bytesWritten = fs.statSync(tempFile).size;
      } catch {
        // Ignore stat failure; receipt will show undefined bytesWritten.
      }
    }
    if (tempDir) {
      const cleanupOutcome = CleanupOutcome.finalize(tempDir, effect, {
        cleanedField: "tempDirCleaned",
        bytesWritten,
      });
      const message = cleanupOutcome.kind === "retained"
        ? `failed during file write and could not clean up partial artifact: ${error instanceof Error ? error.message : String(error)}`
        : `failed to write response to ${target}: ${error instanceof Error ? error.message : String(error)}`;
      throw fileWriteError({
        code: "LOCAL_WRITE_FAILED",
        phase: "prepare",
        message,
        cause: error,
        effectState: effect,
        cleanupOutcome,
      });
    }
    // No temporary artifact remains.
    throw cliError("LOCAL_WRITE_FAILED", `failed to write response to ${target}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
      faultDomain: "file_write:prepare",
      effectState: effect,
    });
  }
}

async function invokeHttpAction(input: {
  url: URL;
  action: AgentManifestActionV0;
  payload: Record<string, unknown>;
  cookies: SessionCookie[];
  service: RegisteredIntegrationService;
  env: NodeJS.ProcessEnv;
  output?: string;
}): Promise<ActionResult> {
  const url = new URL(input.url);
  const cookie = cookieHeaderForUrl(input.cookies, url);
  if (!cookie) {
    throw cliError(
      "INTEGRATION_INVOKE_FAILED",
      "service callback handoff did not set a session cookie usable for the action URL; ensure the cookie host and Path cover the action endpoint",
    );
  }
  const isFileResponse = input.action.response?.type === "file";
  const declaredContentType = input.action.response?.contentType;
  const payload = payloadWithoutEndpointPathParams(input.action.endpoint.path, input.payload);
  const headers: Record<string, string> = {
    accept: isFileResponse
      ? (declaredContentType ? `${declaredContentType},*/*` : "*/*")
      : "application/json,text/plain,*/*",
    cookie,
  };
  const init: RequestInit = {
    method: input.action.endpoint.method,
    headers,
    redirect: "follow",
  };

  if (input.action.endpoint.method === "GET") {
    appendPayloadAsQuery(url, payload);
  } else {
    appendResourceLocatorQuery({ url, action: input.action, payload });
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }

  let response: Response;
  try {
    response = await fetchWithCanonicalProxy(url, init, input.env);
  } catch (cause) {
    if (!(cause instanceof CanonicalFetchTransportError)) throw cause;
    const diagnostics = cause.diagnostics;
    const causeSuffix = diagnostics.causeCode ? `/${diagnostics.causeCode}` : "";
    throw cliError(
      "INTEGRATION_INVOKE_FAILED",
      `service action transport failed before a response (${diagnostics.causeClass}${causeSuffix} at ${diagnostics.url})`,
      {
        cause,
        layer: "integration_action_transport",
        faultDomain: "integration_action_transport",
        retryable: true,
        suggestedNextAction: "Retry the action after the reported integration route is reachable.",
        details: {
          actual_url: diagnostics.url,
          cause_class: diagnostics.causeClass,
          cause_code: diagnostics.causeCode ?? null,
        },
      },
    );
  }
  const contentType = response.headers.get("content-type");

  if (isFileResponse) {
    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      const responseBody = formatActionErrorBody(rawBody);
      if (response.status === 401 || response.status === 403) {
        throw cliError(
          "INTEGRATION_INVOKE_FAILED",
          rejectedSessionMessage(response.status, responseBody),
          {
            suggestedNextAction: `Run \`raft integration login --service ${input.service.clientId}\` and retry the action.`,
          },
        );
      }
      throw cliError(
        "INTEGRATION_INVOKE_FAILED",
        actionFailureMessage(response.status, responseBody),
      );
    }
    const { filePath, defaultTempDir } = resolveDownloadPath({
      action: input.action,
      output: input.output,
      contentDisposition: response.headers.get("content-disposition"),
      contentType,
    });
    const manifestMaxBytes = input.action.response?.maxBytes;
    const maxBytes = Math.min(
      manifestMaxBytes ?? DEFAULT_MAX_FILE_RESPONSE_BYTES,
      ABSOLUTE_MAX_FILE_RESPONSE_BYTES,
    );
    const writeResult = await writeFileResponse({ response, filePath, defaultTempDir, maxBytes });
    return {
      kind: "file",
      status: response.status,
      filePath,
      contentType,
      size: writeResult.size,
      created: writeResult.created,
      overwritten: writeResult.overwritten,
      unknown: writeResult.unknown,
      dirCreated: writeResult.dirCreated,
      dirCreatedPath: writeResult.dirCreatedPath,
      dirCleaned: writeResult.dirCleaned,
      tempDirCreated: writeResult.tempDirCreated,
      tempDirCleaned: writeResult.tempDirCleaned,
      cleanupFailed: writeResult.cleanupFailed,
      retainedTempArtifacts: writeResult.retainedTempArtifacts,
    };
  }

  if (isJsonContentType(contentType ?? "")) {
    const rawBody = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(rawBody);
    } catch {
      if (!response.ok) {
        throw cliError(
          "INTEGRATION_INVOKE_FAILED",
          actionFailureMessage(response.status, formatActionErrorBody(rawBody)),
        );
      }
      throw cliError("INVALID_JSON_RESPONSE", `service action returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const responseBody = formatJsonActionErrorBody(value);
      if (response.status === 401 || response.status === 403) {
        throw cliError(
          "INTEGRATION_INVOKE_FAILED",
          rejectedSessionMessage(response.status, responseBody),
          {
            suggestedNextAction: `Run \`raft integration login --service ${input.service.clientId}\` and retry the action.`,
          },
        );
      }
      throw cliError(
        "INTEGRATION_INVOKE_FAILED",
        actionFailureMessage(response.status, responseBody),
      );
    }
    return { kind: "json", status: response.status, value };
  }

  const value = await response.text();
  if (!response.ok) {
    const responseBody = formatActionErrorBody(value);
    if (response.status === 401 || response.status === 403) {
      throw cliError(
        "INTEGRATION_INVOKE_FAILED",
        rejectedSessionMessage(response.status, responseBody),
        {
          suggestedNextAction: `Run \`raft integration login --service ${input.service.clientId}\` and retry the action.`,
        },
      );
    }
    throw cliError(
      "INTEGRATION_INVOKE_FAILED",
      actionFailureMessage(response.status, responseBody),
    );
  }
  return { kind: "text", status: response.status, value };
}

function buildIntegrationActionListData(input: {
  service: RegisteredIntegrationService;
  manifest: AgentManifestV0;
  observation: ManifestObservation;
}): IntegrationActionListData {
  return {
    service: input.service.clientId,
    manifestUrl: input.service.agentManifestUrl,
    status: input.observation.status,
    surface: input.observation.surface,
    manifestObservation: input.observation,
    actions: input.manifest.actions ?? [],
  };
}

function formatStructuredValue(value: unknown, indent = 0): string[] {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((item) => {
      const rendered = formatStructuredValue(item, indent + 2);
      return [
        `${prefix}-${rendered[0]?.slice(indent + 2) ? ` ${rendered[0].slice(indent + 2)}` : ""}`,
        ...rendered.slice(1),
      ];
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return [`${prefix}{}`];
    return entries.flatMap(([key, item]) => {
      if (item === null || typeof item !== "object") {
        return [`${prefix}${key}: ${JSON.stringify(item)}`];
      }
      return [`${prefix}${key}:`, ...formatStructuredValue(item, indent + 2)];
    });
  }
  return [`${prefix}${JSON.stringify(value)}`];
}

function formatActions(data: IntegrationActionListData): string {
  const lines = formatStructuredValue(data);
  for (const action of data.actions) {
    if (
      action.endpoint.method !== "GET"
      && Object.hasOwn(action.parameters ?? {}, "id")
      && !/\{id\}/.test(action.endpoint.path)
    ) {
      lines.push(`note (${action.name}): id is treated as the resource locator and is also sent as query ?id=; JSON body is preserved`);
    }
  }
  if (data.actions.length > 0) {
    lines.push(`next: raft integration invoke --service ${JSON.stringify(data.service)} --action ${JSON.stringify(data.actions[0]?.name ?? "<name>")}`);
  }
  return lines.join("\n");
}

function formatV1Actions(input: {
  service: RegisteredIntegrationService;
  manifestUrl: string;
  manifest: AgentManifestV1;
  observation: ManifestObservation;
  actorId: string;
  sessionPresent: boolean;
}): string {
  const lines = [
    `Actions for ${input.service.name}`,
    `service: ${input.service.clientId}`,
    `manifest: ${input.manifestUrl}`,
    "schema: raft-agent-manifest.v1",
    `manifest status: ${input.observation.status}`,
    `action surface: ${humanSurface(input.observation.surface)}`,
    `observed at: ${input.observation.observed_at}`,
    `source: ${input.observation.source}`,
  ];
  if (input.manifest.execution.mode === "local_cli") {
    lines.push("- none");
    lines.push("readiness: local_cli_design_blocked");
    lines.push("next: use the documented Web surface; local command execution and credential materialization are unavailable");
    return lines.join("\n");
  }
  if (input.manifest.actions.length === 0) {
    lines.push("- none");
    lines.push("readiness: zero_action_manifest");
    lines.push("next: use the app on the Web; this valid manifest declares no agent-callable actions");
    return lines.join("\n");
  }
  for (const action of input.manifest.actions) {
    const readiness = buildIntegrationReadinessV1({
      actorId: input.actorId,
      observation: input.observation,
      manifest: input.manifest,
      actionName: action.name,
      sessionPresent: input.sessionPresent,
    });
    lines.push(`- ${action.name}`);
    lines.push(`  endpoint: ${action.endpoint.method} ${action.endpoint.path}`);
    if (action.description) lines.push(`  description: ${action.description}`);
    lines.push(`  effect: ${action.effect}`);
    lines.push(`  idempotency: ${action.idempotency.mode}`);
    lines.push(`  readback: ${action.readback.mode}`);
    lines.push(`  rollback: ${action.rollback.mode}`);
    lines.push(`  readiness: ${readiness.overall}`);
    lines.push(`  authority: ${readiness.authority.status}`);
  }
  lines.push(`next: raft integration invoke --service ${JSON.stringify(input.service.clientId)} --action ${JSON.stringify(input.manifest.actions[0]?.name ?? "<name>")}`);
  return lines.join("\n");
}

function formatMissingManifestActions(input: {
  service: RegisteredIntegrationService;
  observation: ManifestObservation;
}): string {
  return [
    `Actions for ${input.service.name}`,
    `service: ${input.service.clientId}`,
    `manifest: ${input.observation.manifest_url ?? "-"}`,
    `manifest status: ${input.observation.status}`,
    `action surface: ${humanSurface(input.observation.surface)}`,
    `observed at: ${input.observation.observed_at}`,
    `source: ${input.observation.source}`,
    `evidence ceiling: ${input.observation.evidence_ceiling}`,
    "- none",
    `next: ${input.observation.next_action}`,
  ].join("\n");
}

function pickViewerUrl(value: unknown): string | null {
  return value && typeof value === "object" && typeof (value as { viewerUrl?: unknown }).viewerUrl === "string"
    ? (value as { viewerUrl: string }).viewerUrl
    : null;
}

function formatActionResult(input: {
  service: RegisteredIntegrationService;
  action: AgentManifestActionV0;
  result: ActionResult;
}): string {
  const lines = [
    `Action invoked: ${input.action.name}`,
    `service: ${input.service.clientId}`,
    `status: HTTP ${input.result.status}`,
  ];
  if (input.result.kind === "file") {
    lines.push(`file: ${input.result.filePath}`);
    lines.push(`content type: ${input.result.contentType ?? "-"}`);
    lines.push(`size: ${input.result.size} bytes`);
    const effect = input.result.unknown
      ? "unknown"
      : input.result.overwritten
      ? "overwrote"
      : "created";
    lines.push(`effect: ${effect}`);
    if (input.result.dirCreated) {
      const dirStatus = input.result.dirCleaned ? "created and cleaned" : "created";
      lines.push(`directory: ${dirStatus}${input.result.dirCreatedPath ? ` (${input.result.dirCreatedPath})` : ""}`);
    }
    const tempStatus = input.result.cleanupFailed
      ? "cleanup failed"
      : input.result.tempDirCleaned
      ? "cleaned"
      : input.result.tempDirCreated
      ? "retained"
      : null;
    if (tempStatus) {
      const retained = input.result.retainedTempArtifacts?.[0];
      lines.push(`temp directory: ${tempStatus}${retained ? ` (${retained})` : ""}`);
    }
    return lines.join("\n");
  }
  if (input.result.kind === "json") {
    const viewerUrl = pickViewerUrl(input.result.value);
    if (viewerUrl) lines.push(`viewer URL: ${viewerUrl}`);
    lines.push("result:");
    lines.push(JSON.stringify(input.result.value, null, 2));
  } else if (input.result.value) {
    lines.push("result:");
    lines.push(input.result.value);
  }
  return lines.join("\n");
}

function approvalRequiredNextAction(input: {
  service: RegisteredIntegrationService;
  login: IntegrationLoginResponse;
  requestedTarget?: string;
}): string {
  const requestId = input.login.approval?.requestId ?? input.login.requestId ?? "-";
  const target = input.login.approval?.target ?? input.requestedTarget?.trim() ?? null;
  const actionCardMessageId = input.login.approval?.actionCardMessageId ?? null;
  const loginTarget = target ?? "<current-channel-or-thread>";
  const loginCommand = `raft integration login --service ${JSON.stringify(input.service.clientId)} --target ${JSON.stringify(loginTarget)}`;

  if (actionCardMessageId) {
    return [
      `Approval request ${requestId} was posted to ${target ?? "-"} as card ${actionCardMessageId}.`,
      "Ask a server owner/admin to approve the card, then rerun the same integration invoke command.",
      `If the approval card must be posted again, run \`${loginCommand}\`.`,
    ].join(" ");
  }

  return [
    `Approval request ${requestId} exists, but no approval card was posted.`,
    `Run \`${loginCommand}\` to post the owner/admin approval card in the current conversation,`,
    "then ask a server owner/admin to approve it and rerun the same integration invoke command.",
  ].join(" ");
}

function manifestObservationErrorMessage(observation: ManifestObservation): string {
  const details = [observation.detail];
  if (observation.http_status !== undefined && !observation.detail?.includes(`HTTP ${observation.http_status}`)) {
    details.push(`HTTP ${observation.http_status}`);
  }
  if (observation.content_type) details.push(`content-type ${observation.content_type}`);
  if (observation.schema_path) details.push(`schema path ${observation.schema_path}`);
  if (observation.retry_after !== undefined) details.push(`retry-after ${observation.retry_after ?? "unknown"}`);
  return details.filter(Boolean).join("; ") || `manifest observation failed with status ${observation.status}`;
}

function manifestObservationErrorCode(observation: ManifestObservation): string {
  switch (observation.status) {
    case "missing":
    case "not_configured":
      return "INTEGRATION_MANIFEST_MISSING";
    case "invalid":
      return "INTEGRATION_MANIFEST_INVALID";
    case "unavailable":
      return "INTEGRATION_MANIFEST_UNAVAILABLE";
    case "unreachable":
      return "INTEGRATION_MANIFEST_UNREACHABLE";
    case "unchecked":
      return "INTEGRATION_MANIFEST_UNCHECKED";
    case "valid":
      return "INTERNAL_BUG";
  }
}

function raiseIntegrationV1Error(error: IntegrationV1Error, json: boolean | undefined): never {
  error.outputMode = json ? "json" : "text";
  throw error;
}

function setCliErrorOutputMode(error: unknown, json: boolean | undefined): void {
  if (error instanceof CliError && error.outputMode === undefined) {
    error.outputMode = json ? "json" : "text";
  }
}

async function fetchManifestForInvoke(input: {
  probe: ManifestProbeResult;
}): Promise<AgentManifest> {
  const result = input.probe;
  if (result.observation.status === "valid" && result.manifest) {
    return result.manifest;
  }
  throw cliError(
    manifestObservationErrorCode(result.observation),
    manifestObservationErrorMessage(result.observation),
    {
      cause: result.error,
      layer: result.observation.fault_domain ?? "manifest_observation",
      retryable: result.observation.retryable,
      suggestedNextAction: result.observation.next_action,
      details: {
        manifest_url: result.observation.manifest_url,
        actual_url: result.observation.actual_url ?? null,
        cause_class: result.observation.cause_class ?? null,
        cause_code: result.observation.cause_code ?? null,
        http_status: result.observation.http_status ?? null,
      },
    },
  );
}

function assertPreflightOptions(opts: InvokeOptions): void {
  if (!opts.preflight) return;
  if (opts.listActions) {
    throw cliError("INVALID_ARG", "--preflight cannot be combined with --list-actions");
  }
  const disallowed = [
    opts.param?.length ? "--param" : null,
    opts.dataJson !== undefined ? "--data-json" : null,
    opts.dataFile !== undefined ? "--data-file" : null,
    opts.scope?.length ? "--scope" : null,
    opts.target !== undefined ? "--target" : null,
    opts.retryInvocation !== undefined ? "--retry-invocation" : null,
    opts.output !== undefined ? "--output" : null,
  ].filter((value): value is string => Boolean(value));
  if (disallowed.length > 0) {
    throw cliError(
      "INVALID_ARG",
      `--preflight accepts only --service, --action, and --json; remove ${disallowed.join(", ")}`,
    );
  }
}

function actionSessionProbeUrlV1(input: {
  service: RegisteredIntegrationService;
  manifest: AgentManifestV1;
  action: AgentManifestActionV1;
}): URL {
  const base = resolveRegisteredActionBaseUrl(input);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const endpointPath = input.action.endpoint.path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "preflight");
  const url = new URL(base);
  url.pathname = `${basePath}${endpointPath}`;
  url.search = "";
  url.hash = "";
  return url;
}

function actionContractInvalidV1Error(input: {
  service: RegisteredIntegrationService;
  action: AgentManifestActionV1;
  error: unknown;
}): IntegrationV1Error {
  return new IntegrationV1Error({
    schema: "raft-integration-error.v1",
    code: "INTEGRATION_ACTION_CONTRACT_INVALID",
    message: input.error instanceof Error
      ? input.error.message.slice(0, 512)
      : "The action contract cannot be bound to the registered service.",
    service_id: input.service.clientId,
    action: input.action.name,
    effect: input.action.effect,
    fault_domain: "manifest_policy",
    retryable: false,
    evidence: {
      manifest: "valid",
      auth: "unknown",
      authority: "unknown",
      transport: "not_attempted",
      response_schema: "not_run",
      readback: "not_run",
    },
    schema_path: null,
    http_status: null,
    request_id: null,
    next_action: "Ask the service owner to correct the registered manifest action contract.",
  });
}

function authNotReadyV1Error(input: {
  service: RegisteredIntegrationService;
  action: AgentManifestActionV1;
}): IntegrationV1Error {
  return new IntegrationV1Error({
    schema: "raft-integration-error.v1",
    code: "INTEGRATION_AUTH_NOT_READY",
    message: "No existing agent session is bound to this service action.",
    service_id: input.service.clientId,
    action: input.action.name,
    effect: input.action.effect,
    fault_domain: "auth",
    retryable: false,
    evidence: {
      manifest: "valid",
      auth: "not_ready",
      authority: "unknown",
      transport: "not_attempted",
      response_schema: "not_run",
      readback: "not_run",
    },
    schema_path: null,
    http_status: null,
    request_id: null,
    next_action: `Run \`raft integration login --service ${JSON.stringify(input.service.clientId)}\` before invoking this action.`,
  });
}

function actionPreflightDataV1(input: {
  service: RegisteredIntegrationService;
  action: AgentManifestActionV1;
  observation: ManifestObservation;
}) {
  return {
    schema: "raft-integration-invoke-preflight.v1" as const,
    service_id: input.service.clientId,
    manifest: {
      status: "valid" as const,
      observed_at: input.observation.observed_at,
      source: input.observation.source,
    },
    action: {
      name: input.action.name,
      effect: input.action.effect,
      contract_status: "valid" as const,
    },
    auth: { status: "session_bound" as const },
    invoke: { status: "attemptable_unverified" as const },
    transport: { status: "not_attempted" as const },
  };
}

function formatActionPreflightV1(data: ReturnType<typeof actionPreflightDataV1>): string {
  return [
    `Preflight: ${data.invoke.status}`,
    `service: ${data.service_id}`,
    `manifest: ${data.manifest.status}`,
    `action: ${data.action.name}`,
    `effect: ${data.action.effect}`,
    `contract: ${data.action.contract_status}`,
    `auth: ${data.auth.status}`,
    `transport: ${data.transport.status}`,
    `observed at: ${data.manifest.observed_at}`,
    `source: ${data.manifest.source}`,
  ].join("\n");
}

export const integrationInvokeCommand = defineCommand(
  {
    name: "invoke",
    description: "Invoke a manifest-backed HTTP API action for a registered integration",
    arguments: ["[service]", "[action]"],
    options: [
      { flags: "--service <id>", description: "Registered service id, client id, or exact service name" },
      { flags: "--action <name>", description: "Manifest action name to invoke" },
      { flags: "--list-actions", description: "List manifest actions instead of invoking one" },
      {
        flags: "--preflight",
        description: "Check the exact manifest action and existing session without login or invocation",
      },
      {
        flags: "--param <key=value>",
        description: "Text action parameter; repeatable. Use key=@file or key=@- to read text. Use --data-json/--data-file for array or object fields. For non-GET actions, id is also sent as query ?id= when the manifest path has no {id}",
        parse: (value, previous: string[] = []) => {
          previous.push(value);
          return previous;
        },
      },
      { flags: "--data-json <json>", description: "JSON object request body for the action" },
      { flags: "--data-file <path>", description: "JSON object request body file, or - for stdin" },
      {
        flags: "--scope <scope>",
        description: "Login scope to request before invoking; can be repeated or comma-separated",
        parse: (value, previous: string[] = []) => {
          previous.push(value);
          return previous;
        },
      },
      { flags: "--target <target>", description: "Conversation target to post a human approval card when approval is required" },
      {
        flags: "--retry-invocation <uuid>",
        description: "Retry one prior manifest v1 logical invocation with the same actor, target, contract, and request binding",
      },
      { flags: "--output <path>", description: "Write a file-response action to this path instead of a temporary file" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (
    cmdCtx,
    serviceArgOrOpts?: string | InvokeOptions,
    actionArgOrOpts?: string | InvokeOptions,
    maybeOpts?: InvokeOptions,
  ) => {
    const { serviceArg, actionArg, opts } = parseHandlerArgs(serviceArgOrOpts, actionArgOrOpts, maybeOpts);
    const serviceQuery = (opts.service ?? serviceArg ?? "").trim();
    const actionName = (opts.action ?? actionArg ?? "").trim();
    if (!serviceQuery) throw cliError("INVALID_ARG", "--service or service argument is required");
    if (!opts.listActions && !actionName) throw cliError("INVALID_ARG", "--action or action argument is required");
    assertPreflightOptions(opts);

    const agentContext = cmdCtx.loadAgentContext();
    const client = cmdCtx.createApiClient(agentContext);
    const api = createAgentApiSurfaceClient(client);
    const listRes = await api.integrations.list();
    if (!listRes.ok || !listRes.data) {
      throw apiFailureError(listRes, "INTEGRATION_LIST_FAILED");
    }

    const service = findService(listRes.data, serviceQuery);
    if (!service) {
      throw cliError("INTEGRATION_NOT_FOUND", `No registered integration matched ${serviceQuery}`);
    }

    const manifestProbe = await probeIntegrationManifest(service, { env: cmdCtx.env });
    if (
      opts.listActions
      && (manifestProbe.observation.status === "not_configured" || manifestProbe.observation.status === "missing")
    ) {
      if (opts.json) {
        writeJson(cmdCtx.io, {
          ok: true,
          data: {
            service: service.clientId,
            manifestUrl: service.agentManifestUrl,
            status: manifestProbe.observation.status,
            surface: manifestProbe.observation.surface,
            manifestObservation: manifestProbe.observation,
            actions: [],
          },
        });
        return;
      }
      writeText(cmdCtx.io, adoptCliReplyText(formatMissingManifestActions({ service, observation: manifestProbe.observation })), NL);
      return;
    }

    const manifest = await fetchManifestForInvoke({
      probe: manifestProbe,
    });

    if (manifest.schema === "slock-agent-manifest.v1") {
      if (opts.listActions) {
        const storedSession = manifest.execution.mode === "local_cli"
          ? null
          : loadStoredIntegrationSession({ service, agentContext, env: cmdCtx.env });
        const actionReadiness = manifest.actions.map((action) =>
          buildIntegrationReadinessV1({
            actorId: agentContext.agentId,
            observation: manifestProbe.observation,
            manifest,
            actionName: action.name,
            sessionPresent: Boolean(storedSession),
          })
        );
        if (opts.json) {
          writeJson(cmdCtx.io, {
            ok: true,
            data: {
              service: service.clientId,
              manifestUrl: service.agentManifestUrl,
              status: manifestProbe.observation.status,
              surface: manifestProbe.observation.surface,
              manifestObservation: manifestProbe.observation,
              actions: manifest.actions,
              actionReadiness,
            },
          });
          return;
        }
        writeText(cmdCtx.io, adoptCliReplyText(formatV1Actions({
          service,
          manifestUrl: service.agentManifestUrl ?? "-",
          manifest,
          observation: manifestProbe.observation,
          actorId: agentContext.agentId,
          sessionPresent: Boolean(storedSession),
        })), NL);
        return;
      }

      if (manifest.execution.mode === "local_cli") {
        raiseIntegrationV1Error(
          localCliDesignBlockedError({ serviceId: service.clientId, action: actionName }),
          opts.json,
        );
      }
      const action = manifest.actions.find((candidate) => candidate.name === actionName);
      if (!action) {
        raiseIntegrationV1Error(
          actionUndeclaredV1Error({ serviceId: service.clientId, action: actionName }),
          opts.json,
        );
      }
      if (opts.output) {
        throw cliError("INVALID_ARG", "--output is only available for manifest v0 file-response actions");
      }
      if (opts.preflight) {
        const storedSession = loadStoredIntegrationSession({ service, agentContext, env: cmdCtx.env });
        let sessionUrl: URL;
        try {
          sessionUrl = actionSessionProbeUrlV1({ service, manifest, action });
        } catch (error) {
          raiseIntegrationV1Error(actionContractInvalidV1Error({ service, action, error }), opts.json);
        }
        const sessionBound = Boolean(
          storedSession && cookieHeaderForUrl(storedSession.cookies, sessionUrl),
        );
        if (!sessionBound) {
          raiseIntegrationV1Error(authNotReadyV1Error({ service, action }), opts.json);
        }
        const data = actionPreflightDataV1({
          service,
          action,
          observation: manifestProbe.observation,
        });
        if (opts.json) {
          writeJson(cmdCtx.io, { ok: true, data });
          return;
        }
        writeText(cmdCtx.io, adoptCliReplyText(formatActionPreflightV1(data)), NL);
        return;
      }
      const payload = parseActionPayload(opts, (name) => declaredV1ParamType(action, name));
      try {
        preflightManifestActionV1({
          actorContext: agentContext,
          service,
          manifest,
          action,
          payload,
        });
      } catch (error) {
        if (error instanceof IntegrationV1Error) raiseIntegrationV1Error(error, opts.json);
        throw error;
      }
      const storedSession = loadStoredIntegrationSession({ service, agentContext, env: cmdCtx.env });
      const requestedScopes = normalizeScopes(opts.scope);
      let cookies = requestedScopes || opts.target ? null : storedSession?.cookies ?? null;
      if (!cookies) {
        const loginScopes = normalizeScopes([
          ...(opts.scope ?? []),
          ...action.authority.required_scopes,
        ]);
        const loginRes = await api.integrations.login({
          service: service.clientId,
          scopes: loginScopes,
          target: opts.target?.trim() || undefined,
        });
        if (!loginRes.ok || !loginRes.data) {
          const error = new IntegrationV1Error({
            schema: "raft-integration-error.v1",
            code: loginRes.errorCode ?? (loginRes.status >= 500 ? "SERVER_5XX" : "INTEGRATION_AUTH_NOT_READY"),
            message: loginRes.error ?? `Agent Login failed with HTTP ${loginRes.status}.`,
            service_id: service.clientId,
            action: action.name,
            effect: action.effect,
            fault_domain: "auth",
            retryable: loginRes.status >= 500,
            evidence: {
              manifest: "valid",
              auth: "not_ready",
              authority: "unknown",
              transport: "not_attempted",
              response_schema: "not_run",
              readback: "not_run",
            },
            schema_path: null,
            http_status: loginRes.status,
            request_id: null,
            next_action: `Run \`raft integration login --service ${JSON.stringify(service.clientId)}\` and retry.`,
          });
          raiseIntegrationV1Error(error, opts.json);
        }
        if (loginRes.data.status === "approval_required") {
          const error = new IntegrationV1Error({
            schema: "raft-integration-error.v1",
            code: "INTEGRATION_AUTH_NOT_READY",
            message: "Human approval is required before invoking this integration action.",
            service_id: service.clientId,
            action: action.name,
            effect: action.effect,
            fault_domain: "auth",
            retryable: false,
            evidence: {
              manifest: "valid",
              auth: "not_ready",
              authority: "unknown",
              transport: "not_attempted",
              response_schema: "not_run",
              readback: "not_run",
            },
            schema_path: null,
            http_status: null,
            request_id: loginRes.data.approval?.requestId ?? loginRes.data.requestId ?? null,
            next_action: approvalRequiredNextAction({
              service,
              login: loginRes.data,
              requestedTarget: opts.target,
            }),
          });
          raiseIntegrationV1Error(error, opts.json);
        }
        const session = await ensureIntegrationServiceSession({
          login: loginRes.data,
          service,
          agentContext,
          env: cmdCtx.env,
          refresh: true,
        });
        cookies = session.cookies;
      }

      let result;
      try {
        result = await invokeManifestActionV1({
          actorContext: agentContext,
          env: cmdCtx.env,
          service,
          manifest,
          action,
          payload,
          cookies,
          retryInvocationId: opts.retryInvocation?.trim() || undefined,
        });
      } catch (error) {
        if (error instanceof IntegrationV1Error) raiseIntegrationV1Error(error, opts.json);
        throw error;
      }
      if (opts.json) {
        writeJson(cmdCtx.io, {
          ok: true,
          data: {
            service: service.clientId,
            action: action.name,
            status: result.status,
            result: result.value,
            receipt: result.receipt,
            readbackReceipt: result.readbackReceipt ?? null,
          },
        });
        return;
      }
      writeText(cmdCtx.io, formatIntegrationReceiptV1({
        receipt: result.receipt,
        value: result.value,
      }), NL);
      return;
    }

    if (opts.retryInvocation) {
      throw cliError("INVALID_ARG", "--retry-invocation is available only for manifest v1 actions");
    }
    if (opts.preflight) {
      throw cliError(
        "INTEGRATION_PREFLIGHT_REQUIRES_MANIFEST_V1",
        "--preflight requires a manifest v1 action contract",
      );
    }
    if (manifest.execution.mode !== "http_api") {
      throw cliError("INTEGRATION_MANIFEST_UNSUPPORTED", "manifest execution mode is not http_api");
    }

    if (opts.listActions) {
      const data = buildIntegrationActionListData({
        service,
        manifest,
        observation: manifestProbe.observation,
      });
      if (opts.json) {
        writeJson(cmdCtx.io, { ok: true, data });
        return;
      }
      writeText(cmdCtx.io, adoptCliReplyText(formatActions(data)), NL);
      return;
    }

    const action = (manifest.actions ?? []).find((candidate) => candidate.name === actionName);
    if (!action) throw cliError("INVALID_ARG", `manifest does not define action ${actionName}`);
    if (opts.output && action.response?.type !== "file") {
      throw cliError("INVALID_ARG", "--output is only available for file-response actions");
    }

    const payload = parseActionPayload(opts, (name) => action.parameters?.[name]?.type);
    validateRequiredParams(action, payload);
    const scopes = normalizeScopes(opts.scope);
    const storedSession = scopes || opts.target
      ? null
      : loadStoredIntegrationSession({ service, agentContext, env: cmdCtx.env });
    let cookies = storedSession?.cookies ?? null;
    if (!cookies) {
      const loginRes = await api.integrations.login({
        service: service.clientId,
        scopes,
        target: opts.target?.trim() || undefined,
      });
      if (!loginRes.ok || !loginRes.data) {
        const code = loginRes.errorCode
          ?? (loginRes.status >= 500 ? "SERVER_5XX" : "INTEGRATION_LOGIN_FAILED");
        throw cliError(code, loginRes.error ?? `HTTP ${loginRes.status}`);
      }
      if (loginRes.data.status === "approval_required") {
        throw cliError(
          "INTEGRATION_APPROVAL_REQUIRED",
          "human approval is required before invoking this integration action",
          {
            suggestedNextAction: approvalRequiredNextAction({
              service,
              login: loginRes.data,
              requestedTarget: opts.target,
            }),
          },
        );
      }

      const session = await ensureIntegrationServiceSession({
        login: loginRes.data,
        service,
        agentContext,
        env: cmdCtx.env,
        refresh: true,
      });
      cookies = session.cookies;
    }

    const url = resolveActionUrl({ service, manifest, action, payload });
    let result: ActionResult;
    try {
      result = await invokeHttpAction({
        url,
        action,
        payload,
        cookies,
        service,
        env: cmdCtx.env,
        output: opts.output,
      });
    } catch (error) {
      setCliErrorOutputMode(error, opts.json);
      throw error;
    }
    if (opts.json) {
      const data: Record<string, unknown> = {
        service: service.clientId,
        action: action.name,
        status: result.status,
      };
      if (result.kind === "file") {
        data.filePath = result.filePath;
        data.contentType = result.contentType;
        data.size = result.size;
        data.created = result.created;
        data.overwritten = result.overwritten;
        data.unknown = result.unknown;
        data.dirCreated = result.dirCreated;
        data.dirCreatedPath = result.dirCreatedPath ?? null;
        data.dirCleaned = result.dirCleaned;
        data.tempDirCreated = result.tempDirCreated;
        data.tempDirCleaned = result.tempDirCleaned;
        data.cleanupFailed = result.cleanupFailed;
        data.retainedTempArtifacts = result.retainedTempArtifacts ?? null;
      } else {
        data.result = result.value;
      }
      writeJson(cmdCtx.io, { ok: true, data });
      return;
    }
    writeText(cmdCtx.io, adoptCliReplyText(formatActionResult({ service, action, result })), NL);
  },
);

export function registerIntegrationInvokeCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, integrationInvokeCommand, runtimeOptions);
}
