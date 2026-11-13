import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { captureCpuProfile, tryAcquireCpuProfiler, type CpuProfile } from "../lib/cpuProfileCapture";
import {
  getOpsProfileStorage,
  resolveOpsProfileStorageConfig,
  type OpsProfileStorageConfig,
  type StorageBackend,
} from "../services/storageService";
import { recordTraceEvent } from "../tracing/semanticTrace";

/**
 * Ops-only CPU profile capture: `POST /api/ops/cpu-profile` samples this
 * process for N seconds with V8's profiler and uploads the `.cpuprofile` to
 * the private ops bucket. Runbook: docs/operations/server-cpu-profile.md.
 *
 * Hidden unless fully configured: CPU_PROFILE_ENABLED=true, OPS_PROFILE_TOKEN
 * (at least 32 characters) and S3_OPS_PROFILE_BUCKET with the main S3
 * credentials. Disabled, a missing or a wrong token all fall through to the
 * app's JSON 404, so the route is indistinguishable from an unmounted path.
 * The token never reaches logs, traces or bodies; the profile never reaches
 * the response.
 */

export const CPU_PROFILE_DEFAULT_SECONDS = 30;
export const CPU_PROFILE_MAX_SECONDS = 60;
const MIN_TOKEN_LENGTH = 32;
const TRACE_EVENT = "server.ops.cpu_profile";

export interface OpsCpuProfileConfig {
  token: string;
  bucket: string;
  deploymentEnv: string;
}

export function readOpsCpuProfileConfig(env: NodeJS.ProcessEnv = process.env): OpsCpuProfileConfig | null {
  if (env.CPU_PROFILE_ENABLED?.trim().toLowerCase() !== "true") return null;
  const token = env.OPS_PROFILE_TOKEN?.trim() ?? "";
  const bucket = env.S3_OPS_PROFILE_BUCKET?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH || !bucket) return null;
  return { token, bucket, deploymentEnv: keySegment(env.DEPLOYMENT_ENV?.trim() || "unknown") };
}

/**
 * Startup check, called once from server bootstrap. When CPU profiling is
 * switched on, resolve its storage now so a misconfiguration is logged at
 * boot (by getOpsProfileStorage, names only) instead of at the first capture,
 * and log which storage mode is in use. Never logs values. Returns the line it
 * logged, or null when profiling is off.
 */
export function reportOpsCpuProfileStartup(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    getStorage: () => StorageBackend | null;
    resolve: (env: NodeJS.ProcessEnv) => OpsProfileStorageConfig;
    log: (line: string) => void;
  } = { getStorage: getOpsProfileStorage, resolve: resolveOpsProfileStorageConfig, log: line => console.info(line) },
): string | null {
  if (env.CPU_PROFILE_ENABLED?.trim().toLowerCase() !== "true") return null;
  const storage = deps.getStorage();
  const mode = deps.resolve(env).kind;
  const ready = readOpsCpuProfileConfig(env) !== null && storage !== null;
  const line = `[ops.cpu_profile] CPU_PROFILE_ENABLED=true; storage mode=${mode}; endpoint ${ready ? "open" : "closed"}`;
  deps.log(line);
  return line;
}

export interface OpsCpuProfileDeps {
  env: NodeJS.ProcessEnv;
  getStorage: () => StorageBackend | null;
  capture: (durationMs: number) => Promise<CpuProfile>;
  /** The process's `service.instance.id` (traces, metrics). */
  serviceInstanceId: string;
  now: () => Date;
}

type DurationParse = { ok: true; seconds: number } | { ok: false; error: string };

function parseDurationSeconds(body: unknown): DurationParse {
  if (body === undefined || body === null) return { ok: true, seconds: CPU_PROFILE_DEFAULT_SECONDS };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const unknownKeys = Object.keys(body).filter(key => key !== "durationSeconds");
  if (unknownKeys.length > 0) return { ok: false, error: "Only durationSeconds is accepted" };
  const raw = (body as { durationSeconds?: unknown }).durationSeconds;
  if (raw === undefined) return { ok: true, seconds: CPU_PROFILE_DEFAULT_SECONDS };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > CPU_PROFILE_MAX_SECONDS) {
    return { ok: false, error: `durationSeconds must be an integer from 1 to ${CPU_PROFILE_MAX_SECONDS}` };
  }
  return { ok: true, seconds: raw };
}

function tokenMatches(req: Request, expected: string): boolean {
  const match = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "");
  if (!match) return false;
  // Equal-length digests: the compare leaks neither content nor length.
  const presented = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(presented, createHash("sha256").update(expected).digest());
}

function keySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function createOpsCpuProfileRouter(overrides: Partial<OpsCpuProfileDeps> = {}): Router {
  const deps: OpsCpuProfileDeps = {
    env: overrides.env ?? process.env,
    getStorage: overrides.getStorage ?? getOpsProfileStorage,
    capture: overrides.capture ?? captureCpuProfile,
    serviceInstanceId: overrides.serviceInstanceId ?? "unknown",
    now: overrides.now ?? (() => new Date()),
  };
  const router = Router();

  router.post("/cpu-profile", async (req, res, next) => {
    const config = readOpsCpuProfileConfig(deps.env);
    const storage = config ? deps.getStorage() : null;
    if (!config || !storage) return next();
    if (!tokenMatches(req, config.token)) {
      recordTraceEvent(TRACE_EVENT, { outcome: "refused", reason: "bad_token" });
      return next();
    }

    const duration = parseDurationSeconds(req.body);
    if (!duration.ok) {
      res.status(400).json({ error: duration.error, code: "invalid_cpu_profile_request" });
      return;
    }
    const releaseProfiler = tryAcquireCpuProfiler();
    if (!releaseProfiler) {
      recordTraceEvent(TRACE_EVENT, { outcome: "refused", reason: "busy" });
      res.status(409).json({ error: "A CPU profile capture is already running on this instance", code: "cpu_profile_busy" });
      return;
    }

    const durationSeconds = duration.seconds;
    const startedAt = deps.now();
    try {
      let profile: CpuProfile;
      try {
        profile = await deps.capture(durationSeconds * 1000);
      } catch (error) {
        console.error("[ops.cpu_profile] capture failed:", (error as Error).message);
        recordTraceEvent(TRACE_EVENT, { outcome: "error", reason: "capture_failed", duration_s: durationSeconds });
        res.status(500).json({ error: "CPU profile capture failed", code: "cpu_profile_capture_failed" });
        return;
      }

      const body = Buffer.from(JSON.stringify(profile));
      const sampleCount = profile.samples?.length ?? 0;
      const key = [
        "ops/cpu-profiles",
        config.deploymentEnv,
        keySegment(deps.serviceInstanceId),
        `${startedAt.toISOString().replace(/:/g, "-")}.cpuprofile`,
      ].join("/");
      const attrs = { duration_s: durationSeconds, bytes: body.byteLength, sample_count: sampleCount };
      try {
        await storage.put(key, body, "application/json");
      } catch (error) {
        console.error("[ops.cpu_profile] upload failed:", (error as Error).message);
        recordTraceEvent(TRACE_EVENT, { outcome: "error", reason: "upload_failed", ...attrs });
        res.status(502).json({ error: "CPU profile upload failed", code: "cpu_profile_upload_failed" });
        return;
      }

      console.info("[ops.cpu_profile] uploaded", { bucket: config.bucket, key, ...attrs });
      recordTraceEvent(TRACE_EVENT, { outcome: "ok", ...attrs });
      res.json({
        bucket: config.bucket,
        key,
        instanceId: deps.serviceInstanceId,
        durationSeconds,
        sampleCount,
        bytes: body.byteLength,
      });
    } finally {
      releaseProfiler();
    }
  });

  return router;
}
