#!/usr/bin/env -S node --import tsx
/**
 * slockdev — tsx rewrite (task #15, +task #12 cf-tunnel default).
 *
 * Faithful replacement for the bash slockdev. Behavior parity is the
 * contract: same stdout, same exit codes, same docker/tmux/psql side
 * effects, same env-vars in spawned tmux windows. Pure logic (offset,
 * sanitize, env model) is parity-proven 31/31 vs real bash; ports +
 * status produce byte-identical output vs bash for ASCII and multibyte
 * (negative-offset) names. start/stop/seed/logs/script/nuke replicate
 * the bash control flow exactly. #12 adds a cloudflared-detect default
 * tunnel at start time with graceful localhost-only fallback (opt out
 * with SLOCKDEV_TUNNEL=0).
 *
 * Implementation notes:
 *   - Uses Node stdlib (child_process / fs) — no execa dependency.
 *   - tmux command strings are assembled via shellQuote (POSIX
 *     single-quote). bash uses `printf %q`; the textual form differs
 *     for some bytes but execution semantics are equivalent for the
 *     values we pass (URLs, paths, secrets, alnum). The string is
 *     internal to tmux and never printed.
 *   - ensure_rustfs_bucket reuses bash's npx-tsx + @aws-sdk/client-s3
 *     Head/Create approach (60× retry) to keep behavior byte-equivalent
 *     rather than risk SDK-version drift. The script lives as a real
 *     file at packages/server/ensure-rustfs-bucket.mjs (invoked as
 *     `npx tsx ensure-rustfs-bucket.mjs` with cwd=packages/server) so
 *     that Windows + shell:true does not corrupt a multi-line --eval
 *     payload (Node DEP0190 — args are concatenated, not escaped).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReaderStartedAtMs, runTraceCli, traceBannerLines } from "./raftdev-trace.js";

export const PROJECT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Durable Docker ownership marker. Cleanup never owns an unlabeled resource. */
export const RAFTDEV_MANAGED_LABEL = "com.botiverse.raftdev.managed";
const RAFTDEV_MANAGED_LABEL_ARG = `${RAFTDEV_MANAGED_LABEL}=true`;

const out = (s = ""): void => { process.stdout.write(s + "\n"); };

// ───────────────── pure logic (parity-proven 31/31) ─────────────────

export function computeOffset(name: string): number {
  let hash = 0;
  for (const ch of name) {
    const b = Buffer.from(ch, "utf8")[0] ?? 0;
    const c = b > 127 ? b - 256 : b;
    hash = (hash * 31 + c) % 100;
  }
  return hash;
}

export function sanitizeBucketComponent(value: string): string {
  let v = value.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-+/g, "-");
  return v === "" ? "env" : v;
}

interface Env {
  name: string; OFFSET: number;
  PG_PORT: number; REDIS_PORT: number; RUSTFS_PORT: number;
  RISINGWAVE_PORT: number; RISINGWAVE_DASHBOARD_PORT: number;
  RUSTFS_CONSOLE_PORT: number; SERVER_PORT: number; WEB_PORT: number;
  TRACE_WORKER_PORT: number; LATENCY_PROXY_PORT: number;
  OTELCOL_HTTP_PORT: number; OTELCOL_GRPC_PORT: number;
  CONTAINER: string; REDIS_CONTAINER: string; RUSTFS_CONTAINER: string; OTELCOL_CONTAINER: string;
  RISINGWAVE_CONTAINER: string;
  RISINGWAVE_NETWORK: string;
  RUSTFS_VOLUME: string; TMUX_SESSION: string; SEED_FILE: string;
  SLOCKDEV_DIR: string; SLOCK_HOME: string; ACTIVITY_FILE: string; IDLE_TTL_FILE: string;
  RISINGWAVE_DSN_FILE: string; RISINGWAVE_STATE_FILE: string;
  POSTGRES_PASSWORD: string; JWT_SECRET: string;
  DATABASE_URL: string; REDIS_URL: string;
  RISINGWAVE_DATABASE_URL: string;
  RUSTFS_ACCESS_KEY: string; RUSTFS_SECRET_KEY: string; RUSTFS_BUCKET: string;
  S3_ENDPOINT: string;
}

export type TraceReaderMode = "local" | "remote" | "worker-disabled" | "observe-disabled";
export type TraceReaderStatus = "starting" | "ready" | "failed" | "stopped";

export interface TraceReaderState {
  schemaVersion: 1;
  mode: TraceReaderMode;
  status: TraceReaderStatus;
  startedAt: string;
}

const MAX_TRACE_READER_STATE_BYTES = 16 * 1024;

// task #19 phase 0: optional HTTP latency injection. Parsed once at start
// time; the proxy itself lives in scripts/dev/raftdev-latency-proxy.ts and is
// only spawned when the user opts in via `--latency <range>` or the
// SLOCKDEV_API_LATENCY_MS env. Default is undefined → slockdev's behavior is
// byte-for-byte unchanged for a normal `raftdev start`.
export interface LatencyProfile {
  minMs: number;
  maxMs: number;
  label: string;
}

export function parseLatencyProfile(raw: string): LatencyProfile {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) {
    throw new Error(
      `latency profile must be "<min>-<max>" or "<n>" in ms, got: ${JSON.stringify(raw)}`,
    );
  }
  const minMs = Number(m[1]);
  const maxMs = m[2] === undefined ? minMs : Number(m[2]);
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs)) {
    throw new Error(`latency profile numbers must be integers, got: ${JSON.stringify(raw)}`);
  }
  // Upper bound is a safety rail, not a math constraint: anything past ~10s
  // per request makes the dev server look hung rather than slow, which is
  // not what this tool is for. Raise deliberately if a future profile needs
  // to model timeout/retry behavior.
  if (maxMs > 10_000) {
    throw new Error(`latency upper bound is capped at 10000ms; got ${maxMs}`);
  }
  if (maxMs < minMs) {
    throw new Error(`latency max (${maxMs}) must be >= min (${minMs})`);
  }
  const label = minMs === maxMs ? `${minMs}ms (fixed)` : `${minMs}-${maxMs}ms (uniform)`;
  return { minMs, maxMs, label };
}

const DEFAULT_IDLE_TTL_SECONDS = 60 * 60;

// ───────────────── cluster mode (--replicas N) ─────────────────
//
// The server is ALREADY cluster-built: Socket.io uses the Redis adapter
// (packages/server/src/socket/index.ts) and cross-replica routing is fully
// Redis-side (packages/server/src/replicaRouter.ts — each process auto-mints
// REPLICA_ID = crypto.randomUUID(), machine→replica mapping lives in Redis).
// So a replica needs NOTHING special to identify itself: just its own PORT and
// its own METRICS_PORT, all sharing the SAME DATABASE_URL + REDIS_URL + seed +
// S3. No front load-balancer is needed — clients/daemon target a replica's
// port directly, and Redis pub/sub + the Socket.io Redis adapter coordinate
// broadcasts across replicas. `--replicas N` (default 1) launches N server
// windows; N=1 is byte-for-byte identical to the pre-cluster behavior.
//
// Replica 1 keeps the canonical SERVER_PORT (13001+o, band 13001-13100) and an
// UNSET METRICS_PORT (server default 9091) so the single-replica path is
// unchanged. Replica k (k≥2) gets a port in its OWN ≥100-wide band, disjoint
// from every other derived band (see the OTELCOL comment in setupEnv):
//   server  : 13001 + (k-1)*100 + o   → replica2 13101-13200, replica3 13201-…
//   metrics : 12001 + (k-2)*100 + o   → replica2 12001-12100, replica3 12101-…
// The metrics base sits below the server band (12xxx) and is also +100-banded
// per replica so two extra replicas never share a Prometheus port. (Replica 1
// keeps the historical 9091 default; two concurrent envs both using 9091 is a
// pre-existing single-replica limitation, unchanged here.)
const MAX_REPLICAS = 8;
const REPLICA_SERVER_PORT_BASE = 13001; // replica1 = SERVER_PORT; replicaK = base + (K-1)*100 + o
const REPLICA_METRICS_PORT_BASE = 12001; // replicaK (K≥2) = base + (K-2)*100 + o

// Optional RisingWave standalone dependency (task #87). These host-port bands
// are allocated even while the dependency is disabled so `raftdev ports`
// remains deterministic. Each is at least 100 wide and disjoint from the
// existing otelcol bands (ending at 17516) and trace-worker band (starting at
// 18787). Container ports follow RisingWave's standalone Docker contract:
// pgwire 4566 and the built-in dashboard 5691.
const RISINGWAVE_PORT_BASE = 17666;
const RISINGWAVE_DASHBOARD_PORT_BASE = 17866;
// Pin the exact RisingWave v2.8.0 image used by the full CDC/MV acceptance
// harness. The override remains available for deliberate compatibility work.
export const DEFAULT_RISINGWAVE_IMAGE =
  "risingwavelabs/risingwave@sha256:ba5915a5e85c938a3ec62d76c63c6e4cb37d4f4e3c5c30886f0d2eff61b70073";

export function risingWavePort(offset: number): number {
  return RISINGWAVE_PORT_BASE + offset;
}

export function risingWaveDashboardPort(offset: number): number {
  return RISINGWAVE_DASHBOARD_PORT_BASE + offset;
}

export type RisingWaveDependencyMode = "disabled" | "local" | "external";
export type RisingWaveLocalProfile = "full" | "process-only";

export interface RisingWaveDependencyConfig {
  mode: RisingWaveDependencyMode;
  profile?: RisingWaveLocalProfile;
  databaseUrl?: string;
  image?: string;
}

export type RisingWaveStateStatus = "starting" | "pgwire-ready" | "serving-ready" | "failed" | "unmanaged";

export interface RisingWaveState {
  schemaVersion: 1;
  mode: "local" | "external";
  profile?: RisingWaveLocalProfile;
  status: RisingWaveStateStatus;
  managed: boolean;
  databaseName: "dev";
  configuredImage?: string;
  actualImageId?: string;
  pgwireUrl?: string;
  dashboardUrl?: string;
}

const MAX_RISINGWAVE_STATE_BYTES = 16 * 1024;

const RISINGWAVE_SERVER_TUNING_ENV = [
  "RISINGWAVE_POOL_MAX",
  "RISINGWAVE_CONNECTION_TIMEOUT_MS",
  "RISINGWAVE_INBOX_RFC056_SERVING_MODE",
  "RISINGWAVE_FOLLOWED_THREAD_STATS_VERSION",
  "RISINGWAVE_FOLLOWED_THREAD_STATS_SLOW_REPLAY_TRACE_MS",
  "RISINGWAVE_FOLLOWED_THREAD_STATS_REPLAY_THREAD_CAP",
] as const;

/**
 * Server env injected for an enabled dependency. Returning an empty object for
 * disabled mode pins the historical default-off server command byte-for-byte.
 */
export function risingWaveServerEnvironment(
  config: RisingWaveDependencyConfig,
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (config.mode === "disabled" || !config.databaseUrl) return {};
  const result: Record<string, string> = {
    RISINGWAVE_DATABASE_URL: config.databaseUrl,
  };
  for (const name of RISINGWAVE_SERVER_TUNING_ENV) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  return result;
}

/**
 * Shell assignment for the connection URL. External URLs may contain real
 * credentials, so read those from a protected file instead of embedding them
 * in tmux/bash argv. The local URL has no password and remains inline.
 */
export function risingWaveDatabaseUrlCommandAssignment(
  config: RisingWaveDependencyConfig,
  externalDsnFile: string,
): string | undefined {
  if (config.mode === "disabled" || !config.databaseUrl) return undefined;
  if (config.mode === "external") {
    return `RISINGWAVE_DATABASE_URL="$(cat -- ${shellQuote(externalDsnFile)})"`;
  }
  return envAssign("RISINGWAVE_DATABASE_URL", config.databaseUrl);
}

/** Parse the explicit RAFTDEV_RISINGWAVE local-container profile. */
export function parseRisingWaveLocalProfile(
  raw: string | undefined,
): RisingWaveLocalProfile | null {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "0") return null;
  const value = raw.trim();
  if (value === "1" || value === "full") return "full";
  if (value === "process-only") return "process-only";
  throw new Error(
    `RAFTDEV_RISINGWAVE must be 0, 1, full, or process-only, got: ${JSON.stringify(raw)}`,
  );
}

export function risingWaveNeedsBootstrap(config: RisingWaveDependencyConfig): boolean {
  return config.mode === "local" && config.profile === "full";
}

/**
 * Resolve the optional dependency without touching Docker.
 *
 * A local standalone instance is an explicit opt-in (`--risingwave` or
 * RAFTDEV_RISINGWAVE=1). Supplying RISINGWAVE_DATABASE_URL instead selects an
 * already-managed external instance. Refuse both at once so a developer never
 * thinks they are testing local RisingWave while the server points elsewhere.
 */
export function resolveRisingWaveDependency(
  localRaw: string | undefined,
  externalDatabaseUrl: string | undefined,
  localDatabaseUrl: string,
  imageRaw: string | undefined,
): RisingWaveDependencyConfig {
  const profile = parseRisingWaveLocalProfile(localRaw);
  const external = externalDatabaseUrl?.trim() ?? "";
  if (profile && external !== "") {
    throw new Error(
      "a local --risingwave/RAFTDEV_RISINGWAVE profile cannot be combined with RISINGWAVE_DATABASE_URL; unset one source",
    );
  }
  if (profile) {
    return {
      mode: "local",
      profile,
      databaseUrl: localDatabaseUrl,
      image: imageRaw?.trim() || DEFAULT_RISINGWAVE_IMAGE,
    };
  }
  if (external !== "") return { mode: "external", databaseUrl: external };
  return { mode: "disabled" };
}

/**
 * External DSNs are retained in the resolved config, then removed from the
 * ambient process environment before any unrelated child process is spawned.
 * The server receives the value later through its mode-0600 per-environment
 * file; schema, seed, build, tmux, web, daemon, and worker children must not
 * inherit it.
 */
export function scrubExternalRisingWaveDatabaseUrl(
  config: RisingWaveDependencyConfig,
  environment: NodeJS.ProcessEnv,
): void {
  if (config.mode === "external") delete environment.RISINGWAVE_DATABASE_URL;
}

export interface RisingWaveDockerEnv {
  RISINGWAVE_CONTAINER: string;
  RISINGWAVE_PORT: number;
  RISINGWAVE_DASHBOARD_PORT: number;
}

export interface PostgresDockerEnv {
  CONTAINER: string;
  PG_PORT: number;
  POSTGRES_PASSWORD: string;
  RISINGWAVE_NETWORK: string;
}

export type RisingWaveReadinessResult = "ready" | "container-exited" | "timeout";

/**
 * Synchronous readiness loop with injectable probes so the lifecycle teeth do
 * not need a real Docker daemon. A TCP accept is insufficient here: Docker can
 * publish 4566 before RisingWave's pgwire session/query path is usable.
 */
export function waitForRisingWaveReadiness(options: {
  attempts: number;
  containerRunning: () => boolean;
  sqlReady: () => boolean;
  sleep: () => void;
}): RisingWaveReadinessResult {
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (!options.containerRunning()) return "container-exited";
    if (options.sqlReady()) return "ready";
    if (attempt < options.attempts) options.sleep();
  }
  return "timeout";
}

/** Exact documented standalone Docker shape, with host exposure kept local. */
export function risingWaveDockerRunArgs(
  e: RisingWaveDockerEnv,
  image: string = DEFAULT_RISINGWAVE_IMAGE,
  network?: string,
): string[] {
  return [
    "run", "-d", "--pull=always", "--name", e.RISINGWAVE_CONTAINER,
    "--label", RAFTDEV_MANAGED_LABEL_ARG,
    ...(network ? ["--network", network] : []),
    "-p", `127.0.0.1:${e.RISINGWAVE_PORT}:4566`,
    "-p", `127.0.0.1:${e.RISINGWAVE_DASHBOARD_PORT}:5691`,
    image,
    "single_node",
  ];
}

export function postgresDockerRunArgs(e: PostgresDockerEnv, cdcEnabled = false): string[] {
  return [
    "run", "-d", "--name", e.CONTAINER,
    "--label", RAFTDEV_MANAGED_LABEL_ARG,
    ...(cdcEnabled ? ["--network", e.RISINGWAVE_NETWORK] : []),
    "-e", "POSTGRES_DB=slock",
    "-e", "POSTGRES_USER=postgres",
    "-e", `POSTGRES_PASSWORD=${e.POSTGRES_PASSWORD}`,
    "-p", `${e.PG_PORT}:5432`,
    "postgres:16-alpine",
    ...(cdcEnabled ? [
      "-c", "wal_level=logical",
      "-c", "max_replication_slots=10",
      "-c", "max_wal_senders=10",
      "-c", "max_slot_wal_keep_size=256MB",
    ] : []),
  ];
}

// Server (HTTP/API) port for replica index k (1-based). k=1 is the canonical
// SERVER_PORT; extra replicas climb the 131xx/132xx/… bands.
export function replicaServerPort(offset: number, k: number): number {
  return REPLICA_SERVER_PORT_BASE + (k - 1) * 100 + offset;
}

// Prometheus metrics port for replica index k (1-based). k=1 → null (leave
// METRICS_PORT unset so the server uses its 9091 default, preserving the
// single-replica behavior byte-for-byte). k≥2 → a derived, per-replica port.
export function replicaMetricsPort(offset: number, k: number): number | null {
  if (k <= 1) return null;
  return REPLICA_METRICS_PORT_BASE + (k - 2) * 100 + offset;
}

// Parse + validate the replica count from --replicas / SLOCKDEV_REPLICAS.
export function parseReplicas(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--replicas must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  if (n > MAX_REPLICAS) {
    throw new Error(`--replicas is capped at ${MAX_REPLICAS}, got ${n}`);
  }
  return n;
}

// tmux window name for replica index k (1-based): "server", "server-2", …
export function replicaWindowName(k: number): string {
  return k === 1 ? "server" : `server-${k}`;
}

const ENVIRONMENT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Canonical raftdev environment names stay safe for paths, ports, tmux, and Docker. */
export function validateEnvironmentName(name: string): string {
  if (!ENVIRONMENT_NAME_RE.test(name) || name === "." || name === "..") {
    throw new Error(
      `environment name must be 1-128 ASCII letters, digits, dots, underscores, or hyphens (not . or ..); got ${JSON.stringify(name)}`,
    );
  }
  return name;
}

function setupEnv(name: string): Env {
  validateEnvironmentName(name);
  const bucket = sanitizeBucketComponent(name);
  const o = computeOffset(name);
  const PG_PORT = 15432 + o;
  const REDIS_PORT = 16379 + o;
  const RUSTFS_PORT = 19000 + o;
  const POSTGRES_PASSWORD = `slock-dev-${name}`;
  const SLOCKDEV_DIR = join(PROJECT_DIR, ".slockdev", name);
  return {
    name, OFFSET: o,
    PG_PORT, REDIS_PORT, RUSTFS_PORT,
    RISINGWAVE_PORT: risingWavePort(o),
    RISINGWAVE_DASHBOARD_PORT: risingWaveDashboardPort(o),
    RUSTFS_CONSOLE_PORT: 19100 + o, SERVER_PORT: 13001 + o, WEB_PORT: 15173 + o,
    TRACE_WORKER_PORT: 18787 + o,
    // Reserved for the optional latency proxy (task #19 phase 0). The port
    // is allocated whether or not the proxy is active so `raftdev ports`
    // / status output stays deterministic; the proxy process is only spawned
    // when --latency / SLOCKDEV_API_LATENCY_MS is set.
    LATENCY_PROXY_PORT: 14001 + o,
    // Local OTLP collector (otelcol-contrib) host ports for the trace-observe
    // loop (PRIMARY of this task). The trace-upload Worker forwards received
    // OTLP traces to OTELCOL_HTTP_PORT; the collector also exposes gRPC. Both
    // are derived so `raftdev ports` / status stay deterministic and multiple
    // envs don't collide. CRITICAL: each derived port must sit in its OWN
    // ≥100-wide band so the +o ranges of two concurrent envs never overlap.
    // gRPC base 17317 → range [17317,17416]; HTTP base 17417 → [17417,17516].
    // 100 apart (disjoint), and both clear of every other band: latency-proxy
    // 14001-14100, web 15173-15272, pg 15432-15531, redis 16379-16478,
    // trace-worker 18787-18886, rustfs 19000-19099, console 19100-19199.
    // (17317 still echoes the well-known OTLP gRPC 4317 in slockdev's 1xxxx band.)
    OTELCOL_GRPC_PORT: 17317 + o,
    OTELCOL_HTTP_PORT: 17417 + o,
    CONTAINER: `slock-dev-${name}-pg`,
    REDIS_CONTAINER: `slock-dev-${name}-redis`,
    RUSTFS_CONTAINER: `slock-dev-${name}-rustfs`,
    OTELCOL_CONTAINER: `slock-dev-${name}-otelcol`,
    RISINGWAVE_CONTAINER: `slock-dev-${name}-risingwave`,
    RISINGWAVE_NETWORK: `slock-dev-${name}-risingwave-net`,
    RUSTFS_VOLUME: `slock-dev-${name}-rustfs-data`,
    TMUX_SESSION: `slock-${name}`,
    SEED_FILE: join(PROJECT_DIR, `.dev-env-${name}.json`),
    SLOCKDEV_DIR,
    SLOCK_HOME: process.env.SLOCKDEV_HOME || join(SLOCKDEV_DIR, "home"),
    ACTIVITY_FILE: join(SLOCKDEV_DIR, "last-activity"),
    IDLE_TTL_FILE: join(SLOCKDEV_DIR, "idle-ttl-seconds"),
    RISINGWAVE_DSN_FILE: join(SLOCKDEV_DIR, "risingwave-database-url"),
    RISINGWAVE_STATE_FILE: join(SLOCKDEV_DIR, "risingwave-state.json"),
    POSTGRES_PASSWORD,
    JWT_SECRET: `dev-secret-${name}`,
    DATABASE_URL: `postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${PG_PORT}/slock`,
    REDIS_URL: `redis://localhost:${REDIS_PORT}`,
    RISINGWAVE_DATABASE_URL: `postgresql://root@127.0.0.1:${risingWavePort(o)}/dev`,
    RUSTFS_ACCESS_KEY: "slockdev",
    RUSTFS_SECRET_KEY: `slockdev-secret-${bucket}`,
    RUSTFS_BUCKET: `slock-dev-${bucket}-attachments`,
    S3_ENDPOINT: `http://localhost:${RUSTFS_PORT}`,
  };
}

function writeRisingWaveState(e: Env, state: RisingWaveState): void {
  mkdirSync(e.SLOCKDEV_DIR, { recursive: true });
  const temporary = `${e.RISINGWAVE_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, e.RISINGWAVE_STATE_FILE);
}

function readRisingWaveState(e: Env): RisingWaveState | null {
  try {
    const stat = statSync(e.RISINGWAVE_STATE_FILE);
    if (!stat.isFile() || stat.size > MAX_RISINGWAVE_STATE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(e.RISINGWAVE_STATE_FILE, "utf8")) as Partial<RisingWaveState>;
    if (parsed.schemaVersion !== 1 || (parsed.mode !== "local" && parsed.mode !== "external")) return null;
    if (parsed.databaseName !== "dev" || typeof parsed.managed !== "boolean") return null;
    if (parsed.mode === "external") {
      if (parsed.managed || parsed.status !== "unmanaged") return null;
      // Reconstruct the external state rather than trusting optional persisted
      // fields. In particular, never render a DSN inserted into the state file.
      return {
        schemaVersion: 1,
        mode: "external",
        status: "unmanaged",
        managed: false,
        databaseName: "dev",
      };
    }
    if (!parsed.managed || (parsed.profile !== "full" && parsed.profile !== "process-only")) return null;
    if (!["starting", "pgwire-ready", "serving-ready", "failed"].includes(parsed.status ?? "")) return null;
    if (
      parsed.configuredImage !== undefined &&
      (typeof parsed.configuredImage !== "string" || parsed.configuredImage.length > 512 || /[\r\n\0]/.test(parsed.configuredImage))
    ) return null;
    if (
      parsed.actualImageId !== undefined &&
      (typeof parsed.actualImageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(parsed.actualImageId))
    ) return null;
    return {
      schemaVersion: 1,
      mode: "local",
      profile: parsed.profile,
      status: parsed.status as RisingWaveStateStatus,
      managed: true,
      databaseName: "dev",
      configuredImage: parsed.configuredImage,
      actualImageId: parsed.actualImageId,
      pgwireUrl: e.RISINGWAVE_DATABASE_URL,
      dashboardUrl: `http://127.0.0.1:${e.RISINGWAVE_DASHBOARD_PORT}`,
    };
  } catch {
    return null;
  }
}

function initialRisingWaveState(e: Env, config: RisingWaveDependencyConfig): RisingWaveState | null {
  if (config.mode === "disabled") return null;
  if (config.mode === "external") {
    return {
      schemaVersion: 1,
      mode: "external",
      status: "unmanaged",
      managed: false,
      databaseName: "dev",
    };
  }
  return {
    schemaVersion: 1,
    mode: "local",
    profile: config.profile ?? "full",
    status: "starting",
    managed: true,
    databaseName: "dev",
    configuredImage: config.image ?? DEFAULT_RISINGWAVE_IMAGE,
    pgwireUrl: e.RISINGWAVE_DATABASE_URL,
    dashboardUrl: `http://127.0.0.1:${e.RISINGWAVE_DASHBOARD_PORT}`,
  };
}

function traceReaderPaths(e: Env): { tracesDir: string; current: string; state: string } {
  const tracesDir = join(e.SLOCKDEV_DIR, "traces");
  return {
    tracesDir,
    current: join(tracesDir, "otlp.json"),
    state: join(tracesDir, "reader-state.json"),
  };
}

function writeTraceReaderStateFile(statePath: string, state: TraceReaderState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statePath);
}

function writeTraceReaderState(e: Env, state: TraceReaderState): void {
  writeTraceReaderStateFile(traceReaderPaths(e).state, state);
}

function readTraceReaderStateFile(statePath: string): TraceReaderState | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    if (statSync(statePath).size > MAX_TRACE_READER_STATE_BYTES) return undefined;
    const value = JSON.parse(readFileSync(statePath, "utf8")) as Partial<TraceReaderState>;
    const validMode = value.mode === "local" || value.mode === "remote" ||
      value.mode === "worker-disabled" || value.mode === "observe-disabled";
    const validStatus = value.status === "starting" || value.status === "ready" ||
      value.status === "failed" || value.status === "stopped";
    if (value.schemaVersion !== 1 || !validMode || !validStatus
      || typeof value.startedAt !== "string" || parseReaderStartedAtMs(value.startedAt) === undefined) {
      return undefined;
    }
    return value as TraceReaderState;
  } catch {
    return undefined;
  }
}

function readTraceReaderState(e: Env): TraceReaderState | undefined {
  return readTraceReaderStateFile(traceReaderPaths(e).state);
}

function initializeTraceReaderRun(e: Env, mode: TraceReaderMode): TraceReaderState {
  const paths = traceReaderPaths(e);
  mkdirSync(paths.tracesDir, { recursive: true });
  const startedAt = new Date().toISOString();
  if (existsSync(paths.current)) {
    const archived = join(paths.tracesDir, "otlp.previous.json");
    rmSync(archived, { force: true });
    renameSync(paths.current, archived);
  }
  const state: TraceReaderState = {
    schemaVersion: 1,
    mode,
    status: mode === "local" ? "starting" : "ready",
    startedAt,
  };
  writeTraceReaderState(e, state);
  return state;
}

export function markTraceReaderStateFileStoppedIfPresent(
  statePath: string,
  warn: (message: string) => void = out,
): boolean {
  if (!existsSync(statePath)) return false;
  const state = readTraceReaderStateFile(statePath);
  if (!state) {
    warn(`WARNING: Trace reader state is invalid; leaving it unchanged: ${statePath}`);
    return false;
  }
  writeTraceReaderStateFile(statePath, { ...state, status: "stopped" });
  return true;
}

function markTraceReaderStoppedIfPresent(e: Env): void {
  markTraceReaderStateFileStoppedIfPresent(traceReaderPaths(e).state);
}

// POSIX single-quote: empty → '', else 'value' with embedded ' → '\''
// Functionally equivalent to bash `printf %q` for the values we pass.
function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_,.\/:=@%+\-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function envAssign(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}

function parseIdleTtlSeconds(raw: string | undefined): number {
  if (!raw || raw.trim() === "") return DEFAULT_IDLE_TTL_SECONDS;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    out(`ERROR: SLOCKDEV_IDLE_TTL_SECONDS must be a non-negative number, got: ${raw}`);
    process.exit(1);
  }
  return Math.floor(parsed);
}

function readIntegerFile(path: string): number | null {
  try {
    const parsed = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  } catch {
    return null;
  }
}

function formatTimestamp(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "unknown";
  return new Date(seconds * 1000).toISOString();
}

// Wraps a command so tmux window prints its exit status then drops into a
// login shell — identical contract to bash slockdev's run_tmux_shell_command.
function runTmuxShellCommand(cmd: string): string {
  const wrapped =
    `${cmd}; status=$?; echo; echo "[raftdev] command exited with status $status"; ` +
    `exec "${process.env.SHELL || "/bin/zsh"}" -l`;
  return `bash -lc ${shellQuote(wrapped)}`;
}

interface ShResult { code: number; stdout: string; stderr: string }

export function packageManagerCommand(
  command: "npx" | "pnpm",
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `${command}.cmd` : command;
}

export function packageManagerSpawnShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export type SeedCommandOptions = {
  name: string;
  withOnboarding: boolean;
};

export function parseSeedCommandArgs(args: string[], defaultName: string): SeedCommandOptions {
  let name = defaultName;
  let nameSet = false;
  let withOnboarding = false;

  for (const arg of args) {
    if (arg === "--with-onboarding") {
      withOnboarding = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown seed option: ${arg}`);
    } else if (nameSet) {
      throw new Error(`Unexpected extra argument for seed: ${arg}`);
    } else {
      name = arg;
      nameSet = true;
    }
  }

  validateEnvironmentName(name);
  return { name, withOnboarding };
}

export function buildDevSeedArgs(outputPath: string, withOnboarding: boolean): string[] {
  return [
    "tsx",
    "scripts/seed.ts",
    "--output",
    outputPath,
    ...(withOnboarding ? ["--with-onboarding"] : []),
  ];
}

function sh(
  cmd: string,
  args: string[],
  opts: { quiet?: boolean; input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): ShResult {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    cwd: opts.cwd,
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runRequiredTmux(args: string[], windowName: string): void {
  const result = sh("tmux", args, { quiet: true });
  if (result.code === 0) return;
  out(`ERROR: Failed to create required tmux window '${windowName}' (exit ${result.code}).`);
  out("  The environment was not started; managed partial resources will be cleaned.");
  process.exit(result.code);
}

export function commandExists(command: string): boolean {
  const probe = process.platform === "win32"
    ? spawnSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    : spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return probe.status === 0;
}

function commandRuns(command: string, args: string[]): boolean {
  const probe = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return probe.status === 0;
}

function risingWaveSqlReady(databaseUrl: string): boolean {
  // `pg` is already a server runtime dependency. Run the probe from the server
  // package so pnpm's strict node_modules layout resolves it without adding a
  // second driver or a host psql prerequisite. Keep the DSN in argv (not the
  // generated JavaScript) and suppress child output so external credentials
  // can never leak through a connection error.
  const probe = [
    "const { Client } = require('pg');",
    "const client = new Client({ connectionString: process.argv[1], connectionTimeoutMillis: 1500, query_timeout: 1500 });",
    "(async () => {",
    "  try {",
    "    await client.connect();",
    "    const result = await client.query('SELECT 1 AS raftdev_ready');",
    "    process.exitCode = result.rowCount === 1 ? 0 : 1;",
    "  } catch {",
    "    process.exitCode = 1;",
    "  } finally {",
    "    await client.end().catch(() => undefined);",
    "  }",
    "})();",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "--eval", probe, databaseUrl], {
    cwd: join(PROJECT_DIR, "packages/server"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 4_000,
  });
  return result.status === 0;
}

export function validateStartTooling(): void {
  const missing: string[] = [];
  for (const command of ["docker", "tmux", "lsof", "bash"]) {
    if (!commandExists(command)) missing.push(command);
  }
  if (!missing.includes("bash") && !commandRuns("bash", ["-lc", "true"])) {
    missing.push("usable bash");
  }
  if (missing.length === 0) return;

  out("ERROR: raftdev start requires POSIX dev tools that are not available:");
  for (const command of missing) out(`  - ${command}`);
  if (process.platform === "win32") {
    out("");
    out("Native Windows is not fully supported by this tmux-based raftdev launcher yet.");
    out("Use WSL with bash, tmux, lsof, Docker access, and this repo mounted inside WSL; or install equivalent POSIX tools on PATH.");
  }
  out("");
  out("No containers or local processes were started.");
  process.exit(1);
}

function dockerNameExists(name: string): boolean {
  const lines = sh("docker", ["ps", "-a", "--format", "{{.Names}}"], { quiet: true }).stdout.split("\n");
  return lines.includes(name);
}
function dockerNameRunning(name: string): boolean {
  const lines = sh("docker", ["ps", "--format", "{{.Names}}"], { quiet: true }).stdout.split("\n");
  return lines.includes(name);
}
function dockerNetworkExists(name: string): boolean {
  return sh("docker", ["network", "inspect", name], { quiet: true }).code === 0;
}
function dockerContainerIsRaftdevManaged(name: string): boolean {
  const result = sh("docker", [
    "inspect", "--format", `{{ index .Config.Labels ${JSON.stringify(RAFTDEV_MANAGED_LABEL)} }}`, name,
  ], { quiet: true });
  return result.code === 0 && result.stdout.trim() === "true";
}
function dockerNetworkIsRaftdevManaged(name: string): boolean {
  const result = sh("docker", [
    "network", "inspect", "--format", `{{ index .Labels ${JSON.stringify(RAFTDEV_MANAGED_LABEL)} }}`, name,
  ], { quiet: true });
  return result.code === 0 && result.stdout.trim() === "true";
}
function dockerVolumeIsRaftdevManaged(name: string): boolean {
  const result = sh("docker", [
    "volume", "inspect", "--format", `{{ index .Labels ${JSON.stringify(RAFTDEV_MANAGED_LABEL)} }}`, name,
  ], { quiet: true });
  return result.code === 0 && result.stdout.trim() === "true";
}
function dockerVolumeExists(name: string): boolean {
  return sh("docker", ["volume", "inspect", name], { quiet: true }).code === 0;
}
function dockerContainerImageId(name: string): string | undefined {
  const result = sh("docker", ["inspect", "--format", "{{.Image}}", name], { quiet: true });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}
function dockerImageExists(image: string): boolean {
  return sh("docker", ["image", "inspect", image], { quiet: true }).code === 0;
}

function postgresLogicalWalReady(e: Env): boolean {
  const result = sh("docker", [
    "exec", e.CONTAINER,
    "psql", "-U", "postgres", "-d", "slock", "-Atc", "SHOW wal_level",
  ], { quiet: true });
  return result.code === 0 && result.stdout.trim() === "logical";
}
function tmuxHasSession(session: string): boolean {
  return sh("tmux", ["has-session", "-t", session], { quiet: true }).code === 0;
}

// Actual window names in a session. Used by stop/nuke so cluster-mode replica
// windows (server-2 … server-N) — whose count isn't known at stop time — all
// get a C-c before the session is killed, just like the fixed windows.
function tmuxWindowNames(session: string): string[] {
  return sh("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { quiet: true })
    .stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function portInUse(port: number): boolean {
  const r = process.platform === "win32"
    ? sh("cmd.exe", ["/c", "lsof.cmd", "-iTCP:" + String(port), "-sTCP:LISTEN", "-P", "-n"], { quiet: true })
    : sh("lsof", ["-iTCP:" + String(port), "-sTCP:LISTEN", "-P", "-n"], { quiet: true });
  return r.code === 0 && r.stdout.trim() !== "";
}
function checkPort(port: number, service: string): void {
  if (portInUse(port)) {
    out(`ERROR: Port ${port} (${service}) is already in use.`);
    out(`  Run: lsof -iTCP:${port} -sTCP:LISTEN`);
    process.exit(1);
  }
}

function ensureRustfsBucket(e: Env): boolean {
  out(`Waiting for RustFS and ensuring bucket '${e.RUSTFS_BUCKET}'...`);
  const dir = mkdtempSync(join(tmpdir(), `slockdev-rustfs-init-${e.RUSTFS_BUCKET}-`));
  const initLog = join(dir, "init.log");
  // Script lives at packages/server/ensure-rustfs-bucket.mjs so that Node's
  // ESM resolution walks up into the monorepo's node_modules for
  // @aws-sdk/client-s3. The earlier shape (`tsx --eval <multi-line string>`
  // with `shell: true` on Windows) silently succeeded without running:
  // Node's shell:true + array-args path concats without quoting (DEP0190),
  // and cmd.exe then chops the multi-line body into separate batch
  // statements, leaving --eval with empty input. Passing the script as a
  // single-token file path avoids that quoting hazard.
  for (let i = 1; i <= 60; i++) {
    writeFileSync(initLog, "");
    const fdOut = openSync(initLog, "a");
    const fdErr = openSync(initLog, "a");
    const npxCommand = packageManagerCommand("npx");
    const r = spawnSync(npxCommand, ["tsx", "ensure-rustfs-bucket.mjs"], {
      cwd: join(PROJECT_DIR, "packages/server"),
      env: {
        ...process.env,
        S3_ENDPOINT: e.S3_ENDPOINT,
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY_ID: e.RUSTFS_ACCESS_KEY,
        S3_SECRET_ACCESS_KEY: e.RUSTFS_SECRET_KEY,
        S3_ATTACHMENTS_BUCKET: e.RUSTFS_BUCKET,
      },
      stdio: ["ignore", fdOut, fdErr],
      shell: packageManagerSpawnShell(),
    });
    try { closeSync(fdOut); } catch {}
    try { closeSync(fdErr); } catch {}
    if (r.status === 0) {
      out("RustFS bucket is ready.");
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      return true;
    }
    if (i === 60) {
      out("ERROR: RustFS did not become ready in time.");
      out(`  Bucket init log: ${initLog}`);
      try {
        const tail = readFileSync(initLog, "utf8").split("\n").slice(-40).join("\n");
        if (tail) process.stdout.write(tail + (tail.endsWith("\n") ? "" : "\n"));
      } catch {}
      out(`  Logs: docker logs ${e.RUSTFS_CONTAINER}`);
      return false;
    }
    spawnSync("sleep", ["1"]);
  }
  return false;
}

// ───────────────── commands ─────────────────

function usageAndExit(): never {
  out(`raftdev — Raft development environment CLI

Usage: ./raftdev <command> [name]

Commands:
  start [name] [--description <text>] [--replicas N] [--risingwave[=full|process-only]] [--with-onboarding]
                  Start an isolated dev environment
  stop [name]     Stop and clean up an environment
  status          Show all running environments
  seed [name] [--with-onboarding]
                  Re-run seed script; default fixture skips onboarding
  script <name>   Run a repo-owned dev script against an environment
  logs [name]     Attach to the tmux session
  ports [name]    Show port allocation for a name
  trace last [--env <name>] [--since <duration>] [--wait <duration>] [--raw]
                  Show the latest local dev HTTP trace tree
  trace find --name <family> [--env <name>] [--since <duration>] [--wait <duration>] [--raw]
                  Find matching local spans and span events
  trace show <trace-id> [--env <name>] [--wait <duration>] [--raw]
                  Show one local web/server/daemon trace tree
  nuke            Stop ALL environments and remove ALL containers

Name defaults to the directory basename (e.g., "slock").
Different names get different ports, so multiple environments can coexist.

Optional:
  --description <text> on start labels what this preview environment is for.
  It is shown in the web Dev tools panel. SLOCKDEV_PREVIEW_DESCRIPTION can
  also provide the same value.
  --with-onboarding on start or seed preserves the real fresh-owner account
  and server onboarding gates. The default seed writes canonical completed /
  grandfathered state so routine product validation opens on the app surface.
  --replicas N (default 1; or SLOCKDEV_REPLICAS=N) on start launches N server
  replicas (tmux windows server, server-2, …, server-N) that SHARE the same
  Postgres + Redis + seed, each on its own derived port, so you can test
  multi-replica / cluster behavior locally. The server is already cluster-built
  (Socket.io Redis adapter + Redis-side cross-replica routing), so no front
  load-balancer is added: connect a client/daemon to ANY replica's port
  directly and Redis coordinates broadcasts across all replicas. N=1 is
  byte-for-byte identical to a normal single-replica start. Replica 1 keeps the
  canonical server port (13001+offset) and metrics :9091; replica k≥2 gets a
  derived server port (13001+(k-1)*100+offset) and metrics port
  (12001+(k-2)*100+offset). The daemon connects to replica 1. Capped at 8.
  Example: ./raftdev start clustertest --replicas 2
  --risingwave (or --risingwave=full) starts an optional managed RisingWave
  standalone plus Postgres CDC and the serving materialized-view graph, gates
  seeded PG/RW parity, then injects RISINGWAVE_DATABASE_URL into the server.
  --risingwave=process-only preserves the lightweight pgwire/pool/fallback
  wiring smoke and intentionally creates no CDC/MVs. It is disabled by default.
  RAFTDEV_RISINGWAVE=1|full|process-only provides the same profiles, and
  RAFTDEV_RISINGWAVE_IMAGE can override the pinned v2.8.0 image. To use an already-managed instance,
  set RISINGWAVE_DATABASE_URL without --risingwave; credentials are never
  printed. Local standalone data is ephemeral and removed by raftdev stop.
  See docs/operations/raftdev-risingwave.md.
  --latency <min>-<max> (or a single <n>) on start spawns an HTTP latency
  proxy in front of the dev server and points the Web's API requests at it.
  Each request is delayed by a uniform random number of ms in [min, max].
  WebSocket upgrades pass through without delay. Default is off (zero
  behaviour change). SLOCKDEV_API_LATENCY_MS provides the same value via env
  for scripted use (e.g. boot-profile latency tiers). Examples:
    --latency 100-300        # rough p50→p95 frontend API feel
    --latency 300-800        # p95→p99 long-tail feel
    SLOCKDEV_API_LATENCY_MS=250 ./raftdev start
  The trace upload Worker starts by default on the derived trace-worker port.
  The daemon uploads rotated bundles to it via SLOCK_DAEMON_TRACE_UPLOAD_URL;
  the web app sends browser traces via VITE_WEB_TRACE_URL and Report Issue via
  VITE_FEEDBACK_EXPORT_URL.
  Set SLOCKDEV_TRACE_WORKER=0 to disable it for a local environment.
  By default a local trace-observe loop also runs: an otelcol-contrib collector
  (the 'otelcol' tmux window) that receives server spans directly plus the web
  and daemon traces the Worker forwards. Use trace last/find/show for the safe reader;
  the 'otelcol' tmux window and .slockdev/<name>/traces/otlp.json remain the
  low-level debug surfaces. The collector runs as a docker container (no PATH
  binary to install — Docker is already required), so it is zero-config: one
  default-on flag, no manual setup. Opt out with SLOCKDEV_TRACE_OBSERVE=0. See
  rfcs/023-local-trace-observe-loop.md.
  Point-anywhere: set SLOCKDEV_TRACE_WORKER_URL=<url> (or --trace-worker-url
  <url>) to skip the local worker and point the daemon + web at a remote
  trace-upload Worker instead. Supply SLOCKDEV_SCOPE_ATTESTATION_SECRET so
  uploads pass attestation against it (the only cross-process secret).
  Set SLOCKDEV_HOME=/path/to/home to intentionally override the isolated
  SLOCK_HOME used by the spawned dev processes.
  Preview environments auto-stop after 1 hour with no real user API activity.
  User API requests refresh the timer; health checks, CORS preflight, and
  /internal daemon/background traffic do not. Set SLOCKDEV_IDLE_TTL_SECONDS=0
  to disable auto-stop for an intentionally long debugging session.

  If 'cloudflared' is installed (e.g. \`brew install cloudflare/cloudflare/cloudflared\`),
  \`./raftdev start\` automatically opens a public preview tunnel to the
  web port and prints the trycloudflare URL. If 'cloudflared' is not on
  PATH, only localhost is started and an install hint is shown. Set
  SLOCKDEV_TUNNEL=0 to skip opening a tunnel even when cloudflared is
  available.`);
  process.exit(1);
}

function cmdPorts(name: string): void {
  const e = setupEnv(name);
  const risingWaveState = readRisingWaveState(e);
  out(`Ports for '${name}' (offset: ${e.OFFSET}):`);
  out(`  PostgreSQL : localhost:${e.PG_PORT}`);
  out(`  Postgres   : ${e.DATABASE_URL}`);
  out(`  Redis      : localhost:${e.REDIS_PORT}`);
  if (risingWaveState?.mode === "external") {
    out("  RisingWave : external/unmanaged (connection value hidden; stop/nuke will not modify it)");
  } else {
    const label = risingWaveState?.mode === "local"
      ? `managed/${risingWaveState.profile ?? "full"}; ${risingWaveState.status}`
      : "reserved; opt in with --risingwave";
    out(`  RisingWave : localhost:${e.RISINGWAVE_PORT} (dashboard: http://localhost:${e.RISINGWAVE_DASHBOARD_PORT}; ${label})`);
    out(`  RW pgwire  : ${e.RISINGWAVE_DATABASE_URL}${risingWaveState ? "" : " (reserved)"}`);
  }
  out(`  RustFS     : ${e.S3_ENDPOINT}`);
  out(`  RustFS UI  : http://localhost:${e.RUSTFS_CONSOLE_PORT}`);
  out(`  Server     : localhost:${e.SERVER_PORT}`);
  out(`  Web        : http://localhost:${e.WEB_PORT}`);
  out(`  SLOCK_HOME : ${e.SLOCK_HOME}`);
  out(`  Trace worker: http://localhost:${e.TRACE_WORKER_PORT} (web + daemon traces, feedback reports; set SLOCKDEV_TRACE_WORKER=0 to disable)`);
  out(`  Trace observe: otelcol OTLP http://127.0.0.1:${e.OTELCOL_HTTP_PORT} (grpc ${e.OTELCOL_GRPC_PORT}); server direct + Worker-forwarded web/daemon; set SLOCKDEV_TRACE_OBSERVE=0 to disable`);
  out(`  Latency proxy: localhost:${e.LATENCY_PROXY_PORT} (only used when --latency / SLOCKDEV_API_LATENCY_MS is set)`);
}

function cmdStatus(): void {
  out("=== Slock Dev Environments ===");
  out("");
  out("Docker containers:");
  const containerRows = sh(
    "docker",
    ["ps", "-a", "--filter", "name=slock-dev-", "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"],
    { quiet: true },
  ).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const containerNames = containerRows.map((line) => line.split("\t", 1)[0]);
  const runningContainerNames = sh(
    "docker",
    ["ps", "--filter", "name=slock-dev-", "--format", "{{.Names}}"],
    { quiet: true },
  ).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  out(containerRows.length > 0 ? containerRows.map((line) => `  ${line}`).join("\n") : "  (none)");
  out("");
  const volumeNames = sh(
    "docker",
    ["volume", "ls", "--filter", "name=slock-dev-", "--format", "{{.Name}}"],
    { quiet: true },
  ).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  out("Docker volumes:");
  out(volumeNames.length > 0 ? volumeNames.map((volume) => `  ${volume}`).join("\n") : "  (none)");
  out("");
  const networkNames = sh(
    "docker",
    ["network", "ls", "--filter", "name=slock-dev-", "--format", "{{.Name}}"],
    { quiet: true },
  ).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  out("Docker networks:");
  out(networkNames.length > 0 ? networkNames.map((network) => `  ${network}`).join("\n") : "  (none)");
  out("");
  out("tmux sessions:");
  const sessionNames = sh("tmux", ["list-sessions", "-F", "#{session_name}"], { quiet: true })
    .stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("slock-"));
  out(sessionNames.length > 0 ? sessionNames.map((session) => `  ${session}`).join("\n") : "  (none)");
  out("");
  const environmentNames = new Set<string>();
  for (const f of (existsSync(PROJECT_DIR) ? readdirSync(PROJECT_DIR) : []).sort()) {
    const m = f.match(/^\.dev-env-(.*)\.json$/);
    if (m) environmentNames.add(m[1]);
  }
  const environmentsRoot = join(PROJECT_DIR, ".slockdev");
  for (const entry of (existsSync(environmentsRoot)
    ? readdirSync(environmentsRoot, { withFileTypes: true })
    : [])) {
    if (entry.isDirectory() && existsSync(join(environmentsRoot, entry.name, "risingwave-state.json"))) {
      environmentNames.add(entry.name);
    }
  }
  for (const containerName of containerNames) {
    const match = containerName.match(/^slock-dev-(.+)-(?:pg|redis|rustfs|otelcol|risingwave)$/);
    if (!match) continue;
    try {
      validateEnvironmentName(match[1]);
      environmentNames.add(match[1]);
    } catch {
      // Status is display-only; ignore malformed external names.
    }
  }
  for (const volumeName of volumeNames) {
    const match = volumeName.match(/^slock-dev-(.+)-rustfs-data$/);
    if (!match || !dockerVolumeIsRaftdevManaged(volumeName)) continue;
    try {
      validateEnvironmentName(match[1]);
      environmentNames.add(match[1]);
    } catch {
      // Status is display-only; ignore malformed external names.
    }
  }
  for (const networkName of networkNames) {
    const match = networkName.match(/^slock-dev-(.+)-risingwave-net$/);
    if (!match || !dockerNetworkIsRaftdevManaged(networkName)) continue;
    try {
      validateEnvironmentName(match[1]);
      environmentNames.add(match[1]);
    } catch {
      // Status is display-only; ignore malformed external names.
    }
  }
  for (const sessionName of sessionNames) {
    const environmentName = sessionName.slice("slock-".length);
    try {
      validateEnvironmentName(environmentName);
      environmentNames.add(environmentName);
    } catch {
      // Status is display-only; ignore malformed external names.
    }
  }
  for (const en of [...environmentNames].sort()) {
    const o = computeOffset(en);
    const e = setupEnv(en);
    const risingWaveState = readRisingWaveState(e);
    const baseOwnershipProof = risingWaveState?.mode === "local" ||
      hasSeededEnvironmentOwnershipProof(e);
    const hasSession = sessionNames.includes(e.TMUX_SESSION);
    const environmentContainers = [
      e.CONTAINER,
      e.REDIS_CONTAINER,
      e.RUSTFS_CONTAINER,
      e.OTELCOL_CONTAINER,
      e.RISINGWAVE_CONTAINER,
    ].filter((container) => containerNames.includes(container));
    const environmentVolumes = volumeNames.filter((volume) =>
      volume === e.RUSTFS_VOLUME &&
      (dockerVolumeIsRaftdevManaged(volume) || baseOwnershipProof)
    );
    const environmentNetworks = networkNames.filter((network) =>
      network === e.RISINGWAVE_NETWORK &&
      (
        dockerNetworkIsRaftdevManaged(network) ||
        (risingWaveState?.mode === "local" && risingWaveState.profile === "full")
      )
    );
    const dockerResidueCount = environmentContainers.length +
      environmentVolumes.length + environmentNetworks.length;
    const postgresRunning = runningContainerNames.includes(e.CONTAINER);
    const rustfsRunning = runningContainerNames.includes(e.RUSTFS_CONTAINER);
    const managedRedisRunning = runningContainerNames.includes(e.REDIS_CONTAINER);
    const externalRedisListening = hasSession && postgresRunning && rustfsRunning &&
      !managedRedisRunning && portInUse(e.REDIS_PORT);
    const readyServiceCount = Number(postgresRunning) + Number(rustfsRunning) +
      Number(managedRedisRunning || externalRedisListening);
    out(`Environment '${en}':`);
    if (hasSession && readyServiceCount === 3) {
      const redisState = externalRedisListening ? "; Redis external" : "";
      out(`  Runtime    : running (tmux session + required services ready${redisState})`);
    } else if (hasSession || dockerResidueCount > 0) {
      const sessionState = hasSession ? "tmux session present" : "no tmux session";
      out(`  Runtime    : partial/orphan (${sessionState}; ${readyServiceCount}/3 required services ready; ${dockerResidueCount} Docker residue(s))`);
      out(`  Recovery   : ./raftdev stop ${en}`);
    } else {
      out("  Runtime    : stopped (state only; no tmux session or Docker resources)");
    }
    out(`  PostgreSQL : localhost:${15432 + o}`);
    out(`  Postgres   : postgresql://postgres:slock-dev-${en}@localhost:${15432 + o}/slock`);
    out(`  Redis      : localhost:${16379 + o}`);
    if (risingWaveState?.mode === "external") {
      out("  RisingWave : external/unmanaged ownership marker (connection value hidden; stop/nuke will not modify it)");
    } else if (risingWaveState?.mode === "local") {
      const processState = dockerNameRunning(e.RISINGWAVE_CONTAINER) ? "running" : "stopped";
      out(`  RisingWave : managed/${risingWaveState.profile ?? "full"}; ${risingWaveState.status}; process ${processState}`);
      out(`               pgwire ${risingWaveState.pgwireUrl ?? e.RISINGWAVE_DATABASE_URL}`);
      out(`               dashboard ${risingWaveState.dashboardUrl ?? `http://localhost:${e.RISINGWAVE_DASHBOARD_PORT}`}`);
      out(`               database ${risingWaveState.databaseName}`);
      if (risingWaveState.configuredImage) out(`               image ${risingWaveState.configuredImage}`);
      if (risingWaveState.actualImageId) out(`               image ID ${risingWaveState.actualImageId}`);
      if (risingWaveState.profile === "full") {
        out(`               source ${"slockdev_pg_cdc"}; publication ${"slockdev_rw_publication"}`);
      } else {
        out("               WARNING: process-only wiring smoke; no CDC or materialized views");
      }
    } else if (dockerNameExists(e.RISINGWAVE_CONTAINER)) {
      const state = dockerNameRunning(e.RISINGWAVE_CONTAINER) ? "running" : "stopped";
      const ownership = dockerContainerIsRaftdevManaged(e.RISINGWAVE_CONTAINER)
        ? "managed/untracked"
        : "external/unmanaged; cleanup denied";
      out(`  RisingWave : localhost:${e.RISINGWAVE_PORT} (dashboard: http://localhost:${e.RISINGWAVE_DASHBOARD_PORT}; ${state}; ${ownership})`);
    }
    out(`  RustFS     : http://localhost:${19000 + o} (console: http://localhost:${19100 + o})`);
    out(`  Server     : localhost:${13001 + o}`);
    out(`  Web        : http://localhost:${15173 + o}`);
    out(`  SLOCK_HOME : ${join(PROJECT_DIR, ".slockdev", en, "home")}`);
    out(`  Trace worker: localhost:${18787 + o} (web + daemon traces, feedback reports; set SLOCKDEV_TRACE_WORKER=0 to disable)`);
    out(`  Trace observe: otelcol OTLP http://127.0.0.1:${17417 + o} (grpc ${17317 + o}); server direct + Worker-forwarded web/daemon`);
    const lastActivity = readIntegerFile(e.ACTIVITY_FILE);
    const ttl = readIntegerFile(e.IDLE_TTL_FILE) ?? DEFAULT_IDLE_TTL_SECONDS;
    out(`  Last activity: ${formatTimestamp(lastActivity)}`);
    out(ttl > 0
      ? `  Auto-stop at : ${formatTimestamp(lastActivity ? lastActivity + ttl : null)} (idle TTL ${ttl}s)`
      : "  Auto-stop at : disabled");
    out("");
  }
  if (environmentNames.size === 0) out("No raftdev environments found.");
}

function cmdLogs(name: string): void {
  const e = setupEnv(name);
  if (!tmuxHasSession(e.TMUX_SESSION)) {
    out(`No tmux session '${e.TMUX_SESSION}' found.`);
    out(`  Start the environment first: ./raftdev start ${name}`);
    process.exit(1);
  }
  // Node has no exec(); inherit stdio + exit on child exit is the closest equivalent.
  const r = spawnSync("tmux", ["attach", "-t", e.TMUX_SESSION], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

function cmdScript(args: string[]): void {
  const scriptName = args[0] ?? "";
  let rest = args.slice(1);
  if (!scriptName) {
    out("ERROR: script name is required.");
    out("  Example: ./raftdev script smoke-runtime --env cli-e2e --matrix runtime=claude,codex");
    out("  Example: ./raftdev script feedback-report --env cli-e2e");
    out("  Example: ./raftdev script onboarding-scenarios --env onboarding-preview --scenario matrix");
    process.exit(1);
  }
  let envName = basename(PROJECT_DIR);
  const passthrough: string[] = [];
  while (rest.length > 0) {
    if (rest[0] === "--env") {
      if (rest.length < 2) { out("ERROR: --env requires a value."); process.exit(1); }
      envName = rest[1];
      rest = rest.slice(2);
    } else {
      passthrough.push(rest[0]);
      rest = rest.slice(1);
    }
  }
  const e = setupEnv(envName);
  if (!existsSync(e.SEED_FILE)) {
    out(`ERROR: Seed file not found for environment '${envName}'.`);
    out(`  Expected: ${e.SEED_FILE}`);
    out(`  Start the environment first: ./raftdev start ${envName}`);
    process.exit(1);
  }
  let scriptPath = "";
  if (scriptName === "smoke-runtime") {
    scriptPath = join(PROJECT_DIR, "scripts/smoke/smoke-runtime.ts");
  } else if (scriptName === "feedback-report") {
    scriptPath = join(PROJECT_DIR, "scripts/smoke/smoke-feedback-report.ts");
  } else if (scriptName === "onboarding-scenarios") {
    scriptPath = join(PROJECT_DIR, "packages/server/scripts/onboarding-scenarios.ts");
  } else {
    out(`ERROR: Unknown script '${scriptName}'.`);
    process.exit(1);
  }
  if (!existsSync(scriptPath)) {
    out(`ERROR: Script file not found: ${scriptPath}`);
    process.exit(1);
  }
  const r = spawnSync(
    "node",
    [
      "--import", "tsx", scriptPath,
      "--server-url", `http://localhost:${e.SERVER_PORT}`,
      "--seed-file", e.SEED_FILE,
      ...(scriptName === "feedback-report" ? ["--worker-url", `http://localhost:${e.TRACE_WORKER_PORT}`] : []),
      ...(scriptName === "onboarding-scenarios" ? ["--web-url", `http://localhost:${e.WEB_PORT}`] : []),
      ...passthrough,
    ],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: e.DATABASE_URL } },
  );
  process.exit(r.status ?? 0);
}

type SeededRisingWaveIdentity = {
  serverId: string;
  userId: string;
};

function readSeededRisingWaveIdentity(e: Env): SeededRisingWaveIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(e.SEED_FILE, "utf8"));
  } catch {
    throw new Error(`could not read seeded identity file ${e.SEED_FILE}`);
  }
  const seed = parsed as {
    server?: { id?: unknown };
    user?: { id?: unknown };
  };
  if (typeof seed.server?.id !== "string" || typeof seed.user?.id !== "string") {
    throw new Error(`seeded identity file ${e.SEED_FILE} is missing server.id or user.id`);
  }
  return { serverId: seed.server.id, userId: seed.user.id };
}

function hasSeededEnvironmentOwnershipProof(e: Env): boolean {
  try {
    readSeededRisingWaveIdentity(e);
    return true;
  } catch {
    return false;
  }
}

export type RisingWaveCdcResidue = "present" | "absent" | "unknown";

export function shouldRefuseRisingWaveSeedWithoutState(
  hasValidState: boolean,
  stateFileExists: boolean,
  risingWaveContainerExists: boolean,
  cdcResidue: RisingWaveCdcResidue,
): boolean {
  return !hasValidState &&
    (stateFileExists || risingWaveContainerExists || cdcResidue !== "absent");
}

export function hasRisingWaveSeedPostgresOwnershipProof(
  hasManagedLabel: boolean,
  stateMode: "local" | "external" | null,
  hasValidSeed: boolean,
): boolean {
  return hasManagedLabel || stateMode === "local" || hasValidSeed;
}

export function shouldRefuseExternalRisingWaveTransition(
  previousMode: "local" | "external" | null,
  hasRisingWaveContainer: boolean,
  risingWaveContainerIsManaged: boolean,
  hasRisingWaveNetwork: boolean,
  risingWaveNetworkIsManaged: boolean,
): boolean {
  if (previousMode === "external") return false;
  const hasResidue = hasRisingWaveContainer || hasRisingWaveNetwork;
  return (previousMode === "local" && hasResidue) ||
    (hasRisingWaveContainer && risingWaveContainerIsManaged) ||
    (hasRisingWaveNetwork && risingWaveNetworkIsManaged);
}

/**
 * Detect a managed/full catalog whose state file was lost.  This inspection is
 * deliberately read-only and runs inside the owned Postgres container so no
 * database credential is exposed in argv or diagnostics.  An inconclusive
 * result must fail closed: reseeding could otherwise invalidate a live CDC
 * publication/slot before raftdev knows that parity is required.
 */
function inspectRisingWaveCdcResidue(e: Env): RisingWaveCdcResidue {
  const result = sh("docker", [
    "exec", e.CONTAINER,
    "psql", "-X", "-U", "postgres", "-d", "slock", "-At",
    "-v", "ON_ERROR_STOP=1",
    "-c",
    "SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'slockdev_rw_publication') " +
      "OR EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'slockdev_rw_slot')",
  ], { quiet: true });
  if (result.code !== 0) return "unknown";
  const value = result.stdout.trim();
  if (value === "t") return "present";
  if (value === "f") return "absent";
  return "unknown";
}

function redactRisingWaveDiagnostic(e: Env, value: string): string {
  let redacted = value;
  for (const secret of [e.DATABASE_URL, e.RISINGWAVE_DATABASE_URL, e.POSTGRES_PASSWORD]) {
    if (secret) redacted = redacted.replaceAll(secret, "<redacted>");
  }
  return redacted;
}

function runManagedRisingWaveBootstrap(e: Env): number {
  const result = spawnSync(packageManagerCommand("npx"), [
    "tsx", "scripts/bootstrap-risingwave-local.ts",
  ], {
    cwd: join(PROJECT_DIR, "packages/server"),
    env: {
      ...process.env,
      DATABASE_URL: e.DATABASE_URL,
      RISINGWAVE_DATABASE_URL: e.RISINGWAVE_DATABASE_URL,
      RISINGWAVE_CDC_HOST: e.CONTAINER,
      RISINGWAVE_CDC_PORT: "5432",
      RISINGWAVE_CDC_USERNAME: "postgres",
      RISINGWAVE_CDC_PASSWORD: e.POSTGRES_PASSWORD,
      RAFTDEV_RISINGWAVE_BOOTSTRAP: "1",
    },
    stdio: "inherit",
    shell: packageManagerSpawnShell(),
  });
  return result.status ?? 1;
}

function writeFailedRisingWaveState(e: Env, state: RisingWaveState | null): void {
  if (state?.mode === "local") writeRisingWaveState(e, { ...state, status: "failed" });
}

/**
 * Wait for the CDC graph to converge on the deterministic seed, then exercise
 * the same Postgres-vs-RisingWave comparison used for production rollout.
 * Intermediate mismatches are expected while CDC catches up and stay quiet;
 * only the final safe diagnostic is printed.
 */
function runSeededRisingWaveParity(
  e: Env,
  options: { attempts?: number; bootstrapSeedBaseline?: boolean } = {},
): boolean {
  const attempts = options.attempts ?? 60;
  let identity: SeededRisingWaveIdentity;
  try {
    identity = readSeededRisingWaveIdentity(e);
  } catch (error) {
    out(`ERROR: ${(error as Error).message}`);
    return false;
  }

  const npxCommand = packageManagerCommand("npx");
  let finalStdout = "";
  let finalStderr = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync(npxCommand, [
      "tsx", "scripts/verify-risingwave-inbox-parity.ts",
      "--server-id", identity.serverId,
      "--user-id", identity.userId,
      "--filter", "all,unread,mentions",
      "--limit", "100",
      "--offset", "0",
      "--summary-server-id", identity.serverId,
      ...(options.bootstrapSeedBaseline ? ["--bootstrap-seed-baseline"] : []),
    ], {
      cwd: join(PROJECT_DIR, "packages/server"),
      env: {
        ...process.env,
        DATABASE_URL: e.DATABASE_URL,
        RISINGWAVE_DATABASE_URL: e.RISINGWAVE_DATABASE_URL,
        // This one-shot verifier must issue a direct candidate read even when
        // spawned server processes retain RFC056's default-off rollout guard.
        // It does not enable RW serving for the environment.
        RISINGWAVE_INBOX_RFC056_SERVING_MODE: "on",
      },
      encoding: "utf8",
      shell: packageManagerSpawnShell(),
      timeout: 15_000,
      killSignal: "SIGTERM",
    });
    finalStdout = typeof result.stdout === "string" ? result.stdout : "";
    finalStderr = typeof result.stderr === "string" ? result.stderr : "";
    if (result.error) {
      finalStderr = `${finalStderr}\n${result.error.message}`.trim();
    }
    if ((result.status ?? 1) === 0) {
      const summary = redactRisingWaveDiagnostic(e, finalStdout.trim());
      if (summary) out(summary);
      return true;
    }
    if (attempt < attempts) spawnSync("sleep", ["1"]);
  }

  const diagnostic = redactRisingWaveDiagnostic(
    e,
    (finalStderr || finalStdout || "parity command exited without diagnostics").trim(),
  );
  out(`ERROR: Seeded Postgres/RisingWave parity did not converge after ${attempts} attempts.`);
  if (diagnostic) out(diagnostic);
  return false;
}

function cmdSeed(args: string[]): void {
  if (args.includes("-h") || args.includes("--help")) usageAndExit();
  const { name, withOnboarding } = parseSeedCommandArgs(args, basename(PROJECT_DIR));
  const e = setupEnv(name);
  // Reseed never needs the server's optional external dependency. Scrub an
  // exported credential before RustFS/Drizzle/seed children inherit it.
  delete process.env.RISINGWAVE_DATABASE_URL;
  if (!dockerNameRunning(e.CONTAINER)) {
    out(`ERROR: Container '${e.CONTAINER}' is not running.`);
    out(`  Start the environment first: ./raftdev start ${name}`);
    process.exit(1);
  }
  const risingWaveState = readRisingWaveState(e);
  if (!hasRisingWaveSeedPostgresOwnershipProof(
    dockerContainerIsRaftdevManaged(e.CONTAINER),
    risingWaveState?.mode ?? null,
    hasSeededEnvironmentOwnershipProof(e),
  )) {
    out(`ERROR: Postgres container '${e.CONTAINER}' is not proven to be owned by raftdev.`);
    out("  Refusing to run schema push or seed against a same-named external container.");
    out(`  Recovery: choose a different environment name, or restore the validated raftdev ownership state.`);
    process.exit(1);
  }
  const risingWaveStateFileExists = existsSync(e.RISINGWAVE_STATE_FILE);
  const risingWaveContainerExists = dockerNameExists(e.RISINGWAVE_CONTAINER);
  const cdcResidue = !risingWaveState && !risingWaveStateFileExists && !risingWaveContainerExists
    ? inspectRisingWaveCdcResidue(e)
    : "absent";
  if (shouldRefuseRisingWaveSeedWithoutState(
    Boolean(risingWaveState),
    risingWaveStateFileExists,
    risingWaveContainerExists,
    cdcResidue,
  )) {
    out(`ERROR: RisingWave ownership/profile state is missing or invalid for '${name}'.`);
    out(`  Refusing to mutate Postgres without knowing whether CDC parity is required.`);
    if (cdcResidue === "present") {
      out("  An owned RisingWave publication or replication slot still exists in Postgres.");
    } else if (cdcResidue === "unknown") {
      out("  Could not prove that Postgres is free of owned RisingWave CDC state.");
    }
    out(`  Recovery: ./raftdev stop ${name} && ./raftdev start ${name} --risingwave`);
    process.exit(1);
  }
  if (
    risingWaveState?.mode === "local" &&
    risingWaveState.profile === "full" &&
    !dockerNameRunning(e.RISINGWAVE_CONTAINER)
  ) {
    writeRisingWaveState(e, { ...risingWaveState, status: "failed" });
    out(`ERROR: Managed/full RisingWave is not running for '${name}'.`);
    out("  Postgres was not reseeded because strict CDC parity could not be proved.");
    out(`  Recovery: ./raftdev stop ${name} && ./raftdev start ${name} --risingwave`);
    process.exit(1);
  }
  if (risingWaveState?.mode === "local" && risingWaveState.profile === "full") {
    out(`ERROR: '${name}' is a managed/full CDC environment; live reseed is intentionally refused.`);
    out("  Rebuilding explicit CDC schemas requires quiescing server traffic and replacing the RisingWave catalog.");
    out(`  Use: ./raftdev stop ${name} && ./raftdev start ${name} --risingwave`);
    process.exit(1);
  }
  out("Pushing database schema...");
  const npxCommand = packageManagerCommand("npx");
  let r = spawnSync(npxCommand, ["drizzle-kit", "push", "--force"], {
    cwd: join(PROJECT_DIR, "packages/server"),
    env: { ...process.env, DATABASE_URL: e.DATABASE_URL },
    stdio: "inherit",
    shell: packageManagerSpawnShell(),
  });
  if ((r.status ?? 1) !== 0) {
    writeFailedRisingWaveState(e, risingWaveState);
    process.exit(r.status ?? 1);
  }
  out("Schema is up to date.");
  if (!ensureRustfsBucket(e)) {
    writeFailedRisingWaveState(e, risingWaveState);
    process.exit(1);
  }
  out(`Seeding test data for '${name}'...`);
  r = spawnSync(npxCommand, buildDevSeedArgs(e.SEED_FILE, withOnboarding), {
    cwd: join(PROJECT_DIR, "packages/server"),
    env: {
      ...process.env,
      DATABASE_URL: e.DATABASE_URL,
      S3_ENDPOINT: e.S3_ENDPOINT,
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: e.RUSTFS_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: e.RUSTFS_SECRET_KEY,
      S3_ATTACHMENTS_BUCKET: e.RUSTFS_BUCKET,
      S3_CDN_BUCKET: e.RUSTFS_BUCKET,
    },
    stdio: "inherit",
    shell: packageManagerSpawnShell(),
  });
  if ((r.status ?? 1) !== 0) {
    writeFailedRisingWaveState(e, risingWaveState);
    process.exit(r.status ?? 1);
  }
  out(`Done. Credentials: ${e.SEED_FILE}`);
}

function cmdStop(name: string): void {
  const e = setupEnv(name);
  const risingWaveState = readRisingWaveState(e);
  const baseOwnershipProof = risingWaveState?.mode === "local" ||
    hasSeededEnvironmentOwnershipProof(e);
  let cleanupFailed = false;
  out(`=== Stopping dev environment: ${name} ===`);
  if (tmuxHasSession(e.TMUX_SESSION)) {
    // C-c every actual window (covers cluster-mode server-2 … server-N too).
    for (const w of tmuxWindowNames(e.TMUX_SESSION)) {
      sh("tmux", ["send-keys", "-t", `${e.TMUX_SESSION}:${w}`, "C-c"], { quiet: true });
    }
    spawnSync("sleep", ["1"]);
    if (sh("tmux", ["kill-session", "-t", e.TMUX_SESSION], { quiet: true }).code === 0) {
      out(`tmux session '${e.TMUX_SESSION}' stopped.`);
    } else {
      cleanupFailed = true;
      out(`ERROR: Failed to stop tmux session '${e.TMUX_SESSION}'.`);
    }
  } else {
    out(`No tmux session '${e.TMUX_SESSION}' found.`);
  }
  // The local source owns a replication slot in Postgres. Stop/remove
  // RisingWave before Postgres so the slot shuts down cleanly. Mention the
  // optional process only when it actually existed, keeping default-off output
  // unchanged.
  if (dockerNameExists(e.RISINGWAVE_CONTAINER)) {
    const owned = risingWaveState?.mode === "local" ||
      dockerContainerIsRaftdevManaged(e.RISINGWAVE_CONTAINER);
    if (!owned || risingWaveState?.mode === "external") {
      out(`External/unmanaged container '${e.RISINGWAVE_CONTAINER}' preserved.`);
    } else if (sh("docker", ["rm", "-f", e.RISINGWAVE_CONTAINER], { quiet: true }).code === 0) {
      out(`Container '${e.RISINGWAVE_CONTAINER}' removed.`);
    } else {
      cleanupFailed = true;
      out(`ERROR: Failed to remove container '${e.RISINGWAVE_CONTAINER}'.`);
    }
  }
  for (const c of [e.CONTAINER, e.REDIS_CONTAINER, e.RUSTFS_CONTAINER, e.OTELCOL_CONTAINER]) {
    if (dockerNameExists(c)) {
      if (!dockerContainerIsRaftdevManaged(c) && !baseOwnershipProof) {
        out(`Unowned container '${c}' preserved.`);
      } else if (sh("docker", ["rm", "-f", c], { quiet: true }).code === 0) {
        out(`Container '${c}' removed.`);
      } else {
        cleanupFailed = true;
        out(`ERROR: Failed to remove container '${c}'.`);
      }
    } else {
      out(`No container '${c}' found.`);
    }
  }
  if (dockerNetworkExists(e.RISINGWAVE_NETWORK)) {
    const owned = (risingWaveState?.mode === "local" && risingWaveState.profile === "full") ||
      dockerNetworkIsRaftdevManaged(e.RISINGWAVE_NETWORK);
    if (!owned || risingWaveState?.mode === "external") {
      out(`External/unmanaged network '${e.RISINGWAVE_NETWORK}' preserved.`);
    } else if (sh("docker", ["network", "rm", e.RISINGWAVE_NETWORK], { quiet: true }).code === 0) {
      out(`Network '${e.RISINGWAVE_NETWORK}' removed.`);
    } else {
      cleanupFailed = true;
      out(`ERROR: Failed to remove network '${e.RISINGWAVE_NETWORK}'.`);
    }
  }
  const volumeList = sh("docker", ["volume", "ls", "--format", "{{.Name}}"], { quiet: true });
  if (volumeList.code !== 0) {
    cleanupFailed = true;
    out("ERROR: Failed to enumerate Docker volumes.");
  }
  const vols = volumeList.stdout.split("\n");
  if (vols.includes(e.RUSTFS_VOLUME)) {
    if (!dockerVolumeIsRaftdevManaged(e.RUSTFS_VOLUME) && !baseOwnershipProof) {
      out(`Unowned volume '${e.RUSTFS_VOLUME}' preserved.`);
    } else if (sh("docker", ["volume", "rm", e.RUSTFS_VOLUME], { quiet: true }).code === 0) {
      out(`Volume '${e.RUSTFS_VOLUME}' removed.`);
    } else {
      cleanupFailed = true;
      out(`ERROR: Failed to remove volume '${e.RUSTFS_VOLUME}'.`);
    }
  }
  if (cleanupFailed) {
    out("ERROR: Cleanup was incomplete; seed, credential, and ownership state files were preserved for retry.");
    process.exitCode = 1;
    return;
  }
  if (existsSync(e.SEED_FILE)) {
    rmSync(e.SEED_FILE, { force: true });
    out(`Removed ${e.SEED_FILE}`);
  }
  for (const f of [e.ACTIVITY_FILE, e.IDLE_TTL_FILE]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  rmSync(e.RISINGWAVE_DSN_FILE, { force: true });
  // Keep the non-secret external ownership denial as a durable tombstone. It
  // makes repeated stop/nuke calls preserve even a same-named resource that
  // happens to carry a raftdev label from another environment.
  if (risingWaveState?.mode !== "external") {
    rmSync(e.RISINGWAVE_STATE_FILE, { force: true });
  }
  markTraceReaderStoppedIfPresent(e);
  out("Done.");
}

function cmdNuke(): void {
  out("=== Nuking ALL slock dev environments ===");
  out("");
  const environmentsRoot = join(PROJECT_DIR, ".slockdev");
  const externalRisingWaveContainers = new Set<string>();
  const externalRisingWaveNetworks = new Set<string>();
  const legacyManagedContainers = new Set<string>();
  const legacyManagedNetworks = new Set<string>();
  const legacyManagedVolumes = new Set<string>();
  let cleanupFailed = false;

  const registerBaseEnvironment = (e: Env): void => {
    for (const container of [e.CONTAINER, e.REDIS_CONTAINER, e.RUSTFS_CONTAINER, e.OTELCOL_CONTAINER]) {
      legacyManagedContainers.add(container);
    }
    legacyManagedVolumes.add(e.RUSTFS_VOLUME);
  };

  // Seed files and validated state files are the migration proof for resources
  // created by pre-label raftdev versions. Names alone are never ownership.
  for (const file of (existsSync(PROJECT_DIR) ? readdirSync(PROJECT_DIR) : [])) {
    const match = file.match(/^\.dev-env-(.*)\.json$/);
    if (!match) continue;
    try {
      validateEnvironmentName(match[1]);
      const e = setupEnv(match[1]);
      if (hasSeededEnvironmentOwnershipProof(e)) registerBaseEnvironment(e);
    } catch {
      // A malformed filename is not authority to delete Docker resources.
    }
  }
  for (const entry of (existsSync(environmentsRoot)
    ? readdirSync(environmentsRoot, { withFileTypes: true })
    : [])) {
    if (!entry.isDirectory()) continue;
    let e: Env;
    try {
      validateEnvironmentName(entry.name);
      e = setupEnv(entry.name);
    } catch {
      continue;
    }
    const state = readRisingWaveState(e);
    if (state?.mode === "local") registerBaseEnvironment(e);
    if (state?.mode === "external") {
      externalRisingWaveContainers.add(e.RISINGWAVE_CONTAINER);
      externalRisingWaveNetworks.add(e.RISINGWAVE_NETWORK);
    } else if (state?.mode === "local") {
      legacyManagedContainers.add(e.RISINGWAVE_CONTAINER);
      if (state.profile === "full") legacyManagedNetworks.add(e.RISINGWAVE_NETWORK);
    }
  }
  const sessions = sh("tmux", ["list-sessions", "-F", "#{session_name}"], { quiet: true })
    .stdout.split("\n").filter((s) => s.startsWith("slock-")).filter(Boolean);
  if (sessions.length > 0) {
    for (const s of sessions) {
      // C-c every actual window (covers cluster-mode server-2 … server-N too).
      for (const w of tmuxWindowNames(s)) {
        sh("tmux", ["send-keys", "-t", `${s}:${w}`, "C-c"], { quiet: true });
      }
    }
    spawnSync("sleep", ["1"]);
    for (const s of sessions) {
      if (sh("tmux", ["kill-session", "-t", s], { quiet: true }).code === 0) {
        out(`Killed tmux session: ${s}`);
      } else {
        cleanupFailed = true;
        out(`ERROR: Failed to kill tmux session: ${s}`);
      }
    }
  } else {
    out("No slock tmux sessions found.");
  }
  const containerList = sh("docker", ["ps", "-a", "--filter", "name=slock-dev-", "--format", "{{.Names}}"], { quiet: true });
  if (containerList.code !== 0) {
    cleanupFailed = true;
    out("ERROR: Failed to enumerate Docker containers.");
  }
  const containers = containerList.stdout.split("\n").filter(Boolean);
  if (containers.length > 0) {
    for (const c of containers) {
      if (externalRisingWaveContainers.has(c)) {
        out(`Preserved external/unmanaged container: ${c}`);
        continue;
      }
      if (!dockerContainerIsRaftdevManaged(c) && !legacyManagedContainers.has(c)) {
        out(`Preserved unowned container: ${c}`);
        continue;
      }
      if (sh("docker", ["rm", "-f", c], { quiet: true }).code === 0) {
        out(`Removed container: ${c}`);
      } else {
        cleanupFailed = true;
        out(`ERROR: Failed to remove container: ${c}`);
      }
    }
  } else {
    out("No slock Docker containers found.");
  }
  const volumeList = sh("docker", ["volume", "ls", "--format", "{{.Name}}"], { quiet: true });
  if (volumeList.code !== 0) {
    cleanupFailed = true;
    out("ERROR: Failed to enumerate Docker volumes.");
  }
  const volumes = volumeList.stdout.split("\n").filter((v) => /^slock-dev-.*-rustfs-data$/.test(v));
  for (const v of volumes) {
    if (!dockerVolumeIsRaftdevManaged(v) && !legacyManagedVolumes.has(v)) {
      out(`Preserved unowned volume: ${v}`);
      continue;
    }
    if (sh("docker", ["volume", "rm", v], { quiet: true }).code === 0) {
      out(`Removed volume: ${v}`);
    } else {
      cleanupFailed = true;
      out(`ERROR: Failed to remove volume: ${v}`);
    }
  }
  const networkList = sh("docker", ["network", "ls", "--format", "{{.Name}}"], { quiet: true });
  if (networkList.code !== 0) {
    cleanupFailed = true;
    out("ERROR: Failed to enumerate Docker networks.");
  }
  const networks = networkList.stdout.split("\n").filter((network) => /^slock-dev-.*-risingwave-net$/.test(network));
  for (const network of networks) {
    if (externalRisingWaveNetworks.has(network)) {
      out(`Preserved external/unmanaged network: ${network}`);
      continue;
    }
    if (!dockerNetworkIsRaftdevManaged(network) && !legacyManagedNetworks.has(network)) {
      out(`Preserved unowned network: ${network}`);
      continue;
    }
    if (sh("docker", ["network", "rm", network], { quiet: true }).code === 0) {
      out(`Removed network: ${network}`);
    } else {
      cleanupFailed = true;
      out(`ERROR: Failed to remove network: ${network}`);
    }
  }
  if (cleanupFailed) {
    out("");
    out("ERROR: Nuke was incomplete; seed, credential, and ownership state files were preserved for retry.");
    process.exitCode = 1;
    return;
  }
  let stoppedTraceReaders = 0;
  let removedRisingWaveDsnFiles = 0;
  let removedRisingWaveStateFiles = 0;
  for (const entry of (existsSync(environmentsRoot)
    ? readdirSync(environmentsRoot, { withFileTypes: true })
    : [])) {
    if (!entry.isDirectory()) continue;
    const statePath = join(environmentsRoot, entry.name, "traces", "reader-state.json");
    if (markTraceReaderStateFileStoppedIfPresent(statePath)) stoppedTraceReaders += 1;
    const risingWaveDsnFile = join(environmentsRoot, entry.name, "risingwave-database-url");
    if (existsSync(risingWaveDsnFile)) {
      rmSync(risingWaveDsnFile, { force: true });
      removedRisingWaveDsnFiles += 1;
    }
    const risingWaveStateFile = join(environmentsRoot, entry.name, "risingwave-state.json");
    const e = setupEnv(entry.name);
    if (existsSync(risingWaveStateFile) && readRisingWaveState(e)?.mode !== "external") {
      rmSync(risingWaveStateFile, { force: true });
      removedRisingWaveStateFiles += 1;
    }
  }
  if (stoppedTraceReaders > 0) {
    out(`Marked ${stoppedTraceReaders} trace reader state file(s) stopped.`);
  }
  if (removedRisingWaveDsnFiles > 0) {
    out(`Removed ${removedRisingWaveDsnFiles} RisingWave credential file(s).`);
  }
  if (removedRisingWaveStateFiles > 0) {
    out(`Removed ${removedRisingWaveStateFiles} RisingWave state file(s).`);
  }
  let cleaned = 0;
  for (const f of (existsSync(PROJECT_DIR) ? readdirSync(PROJECT_DIR) : [])) {
    if (/^\.dev-env-.*\.json$/.test(f)) {
      rmSync(join(PROJECT_DIR, f), { force: true });
      cleaned++;
    }
  }
  if (cleaned > 0) out(`Removed ${cleaned} seed file(s).`);
  out("");
  out("All managed resources clean; unowned and external resources preserved.");
}

// ──── #12: cloudflared default tunnel ────

export function detectCloudflared(): boolean {
  return commandExists("cloudflared");
}

interface TunnelInfo {
  enabled: boolean;
  url?: string;
  pid?: number;
  logFile?: string;
  reason?: string;
}

function startCloudflaredTunnel(e: Env, onSpawn?: (pid: number | undefined) => void): TunnelInfo {
  if (process.env.SLOCKDEV_TUNNEL === "0") {
    return { enabled: false, reason: "SLOCKDEV_TUNNEL=0 (opt-out)" };
  }
  if (!detectCloudflared()) {
    return { enabled: false, reason: "cloudflared not installed" };
  }
  const logFile = join(tmpdir(), `slockdev-cf-${e.name}.log`);
  try { writeFileSync(logFile, ""); } catch {}
  const logFd = openSync(logFile, "a");
  const child = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${e.WEB_PORT}`, "--no-autoupdate", "--protocol", "http2"],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  onSpawn?.(child.pid);
  try { closeSync(logFd); } catch {}
  // Poll log briefly for the trycloudflare URL (~20s cap so start doesn't hang).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const buf = readFileSync(logFile, "utf8");
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) return { enabled: true, url: m[0], pid: child.pid, logFile };
    } catch {}
    spawnSync("sleep", ["1"]);
  }
  return { enabled: true, pid: child.pid, logFile, reason: "tunnel started but URL not parsed within 20s; see log" };
}

// ──── trace-observe loop: local otelcol-contrib (docker) ────

// The collector runs as a docker container (matching the pg/redis/rustfs
// pattern) so the observe loop is zero-config: no PATH binary to install, no
// platform matrix, no checksum dance. otelcol-contrib (the "contrib"
// distribution) ships the `file` and `debug` exporters this loop relies on.
// Pinned to a known-good tag for reproducibility.
const OTELCOL_IMAGE = "otel/opentelemetry-collector-contrib:0.153.0";
// Where we mount the config inside the container — this is the image's default
// config path, so no extra --config arg is needed.
const OTELCOL_CONTAINER_CONFIG = "/etc/otelcol-contrib/config.yaml";
// Container-internal mount point for the file-exporter output directory; the
// host side is <slockdevDir>/traces.
const OTELCOL_CONTAINER_TRACES = "/traces";

// Builds the otelcol-contrib config for the local trace-observe loop. The
// config runs INSIDE the container, so the receiver binds the in-container
// standard OTLP ports (4317/4318) on 0.0.0.0; docker maps those to the derived
// host ports (OTELCOL_GRPC_PORT / OTELCOL_HTTP_PORT) so concurrent envs don't
// collide. Every received trace fans out to two exporters: `debug`
// (pretty-prints spans into the otelcol tmux window so the dev can watch traces
// arrive live) and `file` (appends OTLP JSON under the mounted /traces dir →
// host <slockdevDir>/traces/otlp.json for after-the-fact inspection).
export function buildOtelcolConfig(_e: Env): string {
  const filePath = `${OTELCOL_CONTAINER_TRACES}/otlp.json`;
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    "        endpoint: 0.0.0.0:4317",
    "      http:",
    "        endpoint: 0.0.0.0:4318",
    "exporters:",
    "  debug:",
    "    verbosity: detailed",
    "  file:",
    `    path: ${filePath}`,
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      exporters: [debug, file]",
    "",
  ].join("\n");
}

interface StartFailureCleanupGuard {
  disarm(): void;
  trackTunnel(pid: number | undefined): void;
}

interface StartFailureOwnershipProof {
  baseResources: boolean;
  risingWaveContainer: boolean;
  risingWaveNetwork: boolean;
}

function cleanupFailedStart(
  e: Env,
  tunnelPid: number | undefined,
  seedFileExistedBeforeStart: boolean,
  ownershipProof: StartFailureOwnershipProof,
): boolean {
  let complete = true;
  out("");
  out(`Start failed; cleaning partial environment '${e.name}'...`);

  if (tunnelPid !== undefined) {
    try {
      process.kill(tunnelPid, "SIGTERM");
      out(`Cloudflared process ${tunnelPid} stopped.`);
    } catch {
      // The child may already have exited; no resource remains to clean.
    }
  }

  if (tmuxHasSession(e.TMUX_SESSION)) {
    for (const window of sh("tmux", ["list-windows", "-t", e.TMUX_SESSION, "-F", "#{window_index}"], { quiet: true })
      .stdout.split("\n").filter(Boolean)) {
      sh("tmux", ["send-keys", "-t", `${e.TMUX_SESSION}:${window}`, "C-c"], { quiet: true });
    }
    if (sh("tmux", ["kill-session", "-t", e.TMUX_SESSION], { quiet: true }).code === 0) {
      out(`tmux session '${e.TMUX_SESSION}' removed.`);
    } else {
      complete = false;
      out(`ERROR: Failed to remove tmux session '${e.TMUX_SESSION}'.`);
    }
  }

  for (const container of [
    e.RISINGWAVE_CONTAINER,
    e.OTELCOL_CONTAINER,
    e.RUSTFS_CONTAINER,
    e.REDIS_CONTAINER,
    e.CONTAINER,
  ]) {
    if (!dockerNameExists(container)) continue;
    const legacyOwned = container === e.RISINGWAVE_CONTAINER
      ? ownershipProof.risingWaveContainer
      : ownershipProof.baseResources;
    if (!dockerContainerIsRaftdevManaged(container) && !legacyOwned) {
      complete = false;
      out(`Unowned container '${container}' preserved.`);
      continue;
    }
    if (sh("docker", ["rm", "-f", container], { quiet: true }).code === 0) {
      out(`Container '${container}' removed.`);
    } else {
      complete = false;
      out(`ERROR: Failed to remove container '${container}'.`);
    }
  }

  if (dockerNetworkExists(e.RISINGWAVE_NETWORK)) {
    if (
      !dockerNetworkIsRaftdevManaged(e.RISINGWAVE_NETWORK) &&
      !ownershipProof.risingWaveNetwork
    ) {
      complete = false;
      out(`External/unmanaged network '${e.RISINGWAVE_NETWORK}' preserved.`);
    } else if (sh("docker", ["network", "rm", e.RISINGWAVE_NETWORK], { quiet: true }).code === 0) {
      out(`Network '${e.RISINGWAVE_NETWORK}' removed.`);
    } else {
      complete = false;
      out(`ERROR: Failed to remove network '${e.RISINGWAVE_NETWORK}'.`);
    }
  }

  if (dockerVolumeExists(e.RUSTFS_VOLUME)) {
    if (!dockerVolumeIsRaftdevManaged(e.RUSTFS_VOLUME) && !ownershipProof.baseResources) {
      complete = false;
      out(`Unowned volume '${e.RUSTFS_VOLUME}' preserved.`);
    } else if (sh("docker", ["volume", "rm", e.RUSTFS_VOLUME], { quiet: true }).code === 0) {
      out(`Volume '${e.RUSTFS_VOLUME}' removed.`);
    } else {
      complete = false;
      out(`ERROR: Failed to remove volume '${e.RUSTFS_VOLUME}'.`);
    }
  }

  if (complete) {
    const risingWaveState = readRisingWaveState(e);
    for (const file of [e.ACTIVITY_FILE, e.IDLE_TTL_FILE, e.RISINGWAVE_DSN_FILE]) {
      rmSync(file, { force: true });
    }
    if (!seedFileExistedBeforeStart) rmSync(e.SEED_FILE, { force: true });
    if (risingWaveState?.mode !== "external") rmSync(e.RISINGWAVE_STATE_FILE, { force: true });
    markTraceReaderStoppedIfPresent(e);
    out("Partial environment cleanup complete.");
  } else {
    out(`Recovery: ./raftdev stop ${e.name}`);
  }
  return complete;
}

function armStartFailureCleanup(
  e: Env,
  seedFileExistedBeforeStart: boolean,
  ownershipProof: StartFailureOwnershipProof,
): StartFailureCleanupGuard {
  const intentFile = process.env.RAFTDEV_START_INTENT_FILE?.trim();
  let tunnelPid: number | undefined;
  const writeIntent = (): void => {
    if (!intentFile) return;
    const temporary = `${intentFile}.${process.pid}.tmp`;
    writeFileSync(temporary, [
      e.name,
      seedFileExistedBeforeStart ? "1" : "0",
      ownershipProof.baseResources ? "1" : "0",
      ownershipProof.risingWaveContainer ? "1" : "0",
      ownershipProof.risingWaveNetwork ? "1" : "0",
      tunnelPid === undefined ? "0" : String(tunnelPid),
    ].join("\t") + "\n", { mode: 0o600 });
    renameSync(temporary, intentFile);
  };
  writeIntent();
  let armed = true;
  let cleaning = false;
  const cleanup = (): void => {
    if (!armed || cleaning) return;
    cleaning = true;
    if (
      cleanupFailedStart(e, tunnelPid, seedFileExistedBeforeStart, ownershipProof) &&
      intentFile
    ) {
      writeFileSync(`${intentFile}.cleaned`, "\n");
      rmSync(intentFile, { force: true });
    }
  };
  const onSigint = (): never => process.exit(130);
  const onSigterm = (): never => process.exit(143);
  process.once("exit", cleanup);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    disarm(): void {
      armed = false;
      if (intentFile) {
        rmSync(intentFile, { force: true });
        rmSync(`${intentFile}.cleaned`, { force: true });
      }
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
    trackTunnel(pid: number | undefined): void {
      tunnelPid = pid;
      writeIntent();
    },
  };
}

// ──── start ────

function cmdStart(args: string[]): void {
  let name = basename(PROJECT_DIR);
  let nameSet = false;
  let previewDescription =
    process.env.SLOCKDEV_PREVIEW_DESCRIPTION ?? process.env.SLOCKDEV_DESCRIPTION ?? "";
  // --latency overrides SLOCKDEV_API_LATENCY_MS when both are present;
  // SLOCKDEV_API_LATENCY_MS is the env fallback so CI / scripts can drive it.
  let latencyRaw: string | undefined = process.env.SLOCKDEV_API_LATENCY_MS;
  // --trace-worker-url overrides SLOCKDEV_TRACE_WORKER_URL when both are set.
  let traceWorkerUrlArg: string | undefined;
  // --replicas overrides SLOCKDEV_REPLICAS when both are set. Cluster mode:
  // launch N server replicas over one shared Postgres + Redis. Default 1 (the
  // env fallback so CI/scripts can drive it) → byte-for-byte single-replica.
  let replicasRaw: string | undefined = process.env.SLOCKDEV_REPLICAS;
  // Local RisingWave is default-off. The CLI flag wins only by explicitly
  // setting the same switch as RAFTDEV_RISINGWAVE=1; an external URL is a
  // separate mode resolved below and intentionally cannot be combined.
  let risingWaveLocalRaw: string | undefined = process.env.RAFTDEV_RISINGWAVE;
  let withOnboarding = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--description" || a === "--desc") {
      if (i + 1 >= args.length) { out(`ERROR: ${a} requires a value.`); process.exit(1); }
      previewDescription = args[i + 1]; i += 2;
    } else if (a.startsWith("--description=") || a.startsWith("--desc=")) {
      previewDescription = a.slice(a.indexOf("=") + 1); i += 1;
    } else if (a === "--latency") {
      if (i + 1 >= args.length) { out(`ERROR: ${a} requires a value (e.g. 100-300).`); process.exit(1); }
      latencyRaw = args[i + 1]; i += 2;
    } else if (a.startsWith("--latency=")) {
      latencyRaw = a.slice(a.indexOf("=") + 1); i += 1;
    } else if (a === "--trace-worker-url") {
      if (i + 1 >= args.length) { out(`ERROR: ${a} requires a value (a trace-upload worker URL).`); process.exit(1); }
      traceWorkerUrlArg = args[i + 1]; i += 2;
    } else if (a.startsWith("--trace-worker-url=")) {
      traceWorkerUrlArg = a.slice(a.indexOf("=") + 1); i += 1;
    } else if (a === "--replicas") {
      if (i + 1 >= args.length) { out(`ERROR: ${a} requires a value (e.g. 2).`); process.exit(1); }
      replicasRaw = args[i + 1]; i += 2;
    } else if (a.startsWith("--replicas=")) {
      replicasRaw = a.slice(a.indexOf("=") + 1); i += 1;
    } else if (a === "--risingwave") {
      risingWaveLocalRaw = "1"; i += 1;
    } else if (a.startsWith("--risingwave=")) {
      risingWaveLocalRaw = a.slice(a.indexOf("=") + 1); i += 1;
    } else if (a === "--with-onboarding") {
      withOnboarding = true; i += 1;
    } else if (a === "-h" || a === "--help") {
      usageAndExit();
    } else if (a.startsWith("--")) {
      out(`ERROR: Unknown start option: ${a}`); process.exit(1);
    } else {
      if (nameSet) { out(`ERROR: Unexpected extra argument for start: ${a}`); process.exit(1); }
      name = a; nameSet = true; i += 1;
    }
  }
  try {
    validateEnvironmentName(name);
  } catch (error) {
    out(`ERROR: ${(error as Error).message}`);
    process.exit(1);
  }
  const e = setupEnv(name);
  let risingWave: RisingWaveDependencyConfig;
  try {
    risingWave = resolveRisingWaveDependency(
      risingWaveLocalRaw,
      process.env.RISINGWAVE_DATABASE_URL,
      e.RISINGWAVE_DATABASE_URL,
      process.env.RAFTDEV_RISINGWAVE_IMAGE,
    );
  } catch (err) {
    out(`ERROR: ${(err as Error).message}`);
    out("  Use --risingwave[=full|process-only] for managed local, or only RISINGWAVE_DATABASE_URL for external.");
    process.exit(1);
  }
  scrubExternalRisingWaveDatabaseUrl(risingWave, process.env);
  // ── point-anywhere (SECONDARY): SLOCKDEV_TRACE_WORKER_URL / --trace-worker-url ──
  // When set, slockdev does NOT start a local trace worker; instead it points
  // the daemon + web at the given (typically remote) trace-upload Worker URL.
  // This is the task #60 repro path. The scope-attestation secret can be
  // supplied via SLOCKDEV_SCOPE_ATTESTATION_SECRET so the remote worker accepts
  // the upload instead of failing on auth (it is the only cross-process secret).
  const traceWorkerUrl = (traceWorkerUrlArg ?? process.env.SLOCKDEV_TRACE_WORKER_URL ?? "").trim();
  const usingRemoteWorker = traceWorkerUrl !== "";
  // Local trace worker is on by default; skipped entirely when pointing at a
  // remote worker, or when explicitly opted out with SLOCKDEV_TRACE_WORKER=0.
  const traceWorker = !usingRemoteWorker && process.env.SLOCKDEV_TRACE_WORKER !== "0";
  // Local trace-observe loop (PRIMARY): a local otelcol-contrib that RECEIVES
  // the traces the worker forwards and lets the dev OBSERVE them locally.
  // Only meaningful when a local worker is running; opt out with
  // SLOCKDEV_TRACE_OBSERVE=0 (mirrors the SLOCKDEV_TRACE_WORKER=0 pattern).
  const traceObserve = traceWorker && process.env.SLOCKDEV_TRACE_OBSERVE !== "0";
  const traceReaderMode: TraceReaderMode = usingRemoteWorker
    ? "remote"
    : !traceWorker
      ? "worker-disabled"
      : traceObserve
        ? "local"
        : "observe-disabled";
  // Effective worker URL the daemon + web should point at: the remote one when
  // pointing-anywhere, else the local worker, else nothing.
  const effectiveWorkerUrl = usingRemoteWorker
    ? traceWorkerUrl
    : traceWorker
      ? `http://localhost:${e.TRACE_WORKER_PORT}`
      : "";
  // Scope-attestation secret for the daemon/server/web → worker handshake. The
  // server SIGNS scope attestations with it and the worker VERIFIES them, so it
  // is the ONLY secret that matters cross-process. For a local worker it is
  // derived from the env name (matching the worker window below). For a remote
  // worker the dev supplies it (SLOCKDEV_SCOPE_ATTESTATION_SECRET) so
  // attestation passes against that worker (the task #60 point-anywhere repro).
  const scopeAttestationSecret = usingRemoteWorker
    ? (process.env.SLOCKDEV_SCOPE_ATTESTATION_SECRET ?? "")
    : `dev-secret-${name}`;
  // Worker-INTERNAL secret (getUploadSessionSecret) — only consumed by a worker
  // process slockdev itself launches, i.e. the local-worker path. In remote
  // mode no local worker is started, so there is nothing to hand it to; leave
  // it empty rather than reading a dead SLOCKDEV_TRACE_WORKER_SECRET env (it
  // would never reach a process — cross-process auth is scope-attestation only).
  const traceWorkerSecret = traceWorker ? `trace-worker-dev-secret-${name}` : "";
  const idleTtlSeconds = parseIdleTtlSeconds(process.env.SLOCKDEV_IDLE_TTL_SECONDS);
  // Cluster mode: number of server replicas to launch. Validated before we
  // touch docker/tmux. 1 → single-replica (unchanged behavior).
  let replicas: number;
  try {
    replicas = parseReplicas(replicasRaw);
  } catch (err) {
    out(`ERROR: ${(err as Error).message}`);
    out("  Examples: --replicas 2   --replicas 3   SLOCKDEV_REPLICAS=2 ./raftdev start");
    process.exit(1);
  }
  validateStartTooling();
  // Validate latency early — malformed values should fail before we touch
  // docker / tmux. Unset → undefined → proxy never spawns, slockdev start
  // is byte-for-byte unchanged.
  let latencyProfile: LatencyProfile | undefined;
  if (latencyRaw !== undefined && latencyRaw.trim() !== "") {
    try {
      latencyProfile = parseLatencyProfile(latencyRaw);
    } catch (err) {
      out(`ERROR: ${(err as Error).message}`);
      out("  Examples: --latency 100-300   --latency 250   SLOCKDEV_API_LATENCY_MS=300-800");
      process.exit(1);
    }
  }

  out(`=== Starting dev environment: ${name} ===`);
  out(`  PostgreSQL : localhost:${e.PG_PORT}`);
  out(`  Redis      : localhost:${e.REDIS_PORT}`);
  if (risingWave.mode === "local") {
    out(`  RisingWave : localhost:${e.RISINGWAVE_PORT} (managed/${risingWave.profile}; dashboard: http://localhost:${e.RISINGWAVE_DASHBOARD_PORT})`);
  } else if (risingWave.mode === "external") {
    out("  RisingWave : external RISINGWAVE_DATABASE_URL (value hidden)");
  }
  out(`  RustFS     : http://localhost:${e.RUSTFS_PORT} (console: http://localhost:${e.RUSTFS_CONSOLE_PORT})`);
  if (replicas > 1) {
    const ports = Array.from({ length: replicas }, (_, idx) => replicaServerPort(e.OFFSET, idx + 1));
    out(`  Server     : ${replicas} replicas (cluster mode) on localhost:${ports.join(", ")}`);
    out(`               shared Postgres + Redis; clients/daemon target a port directly`);
  } else {
    out(`  Server     : localhost:${e.SERVER_PORT}`);
  }
  out(`  Web        : localhost:${e.WEB_PORT}`);
  out(`  SLOCK_HOME : ${e.SLOCK_HOME}`);
  if (previewDescription) out(`  Description: ${previewDescription}`);
  if (usingRemoteWorker) {
    out(`  Trace worker: ${traceWorkerUrl} (remote — point-anywhere; no local worker started)`);
  } else if (traceWorker) {
    out(`  Trace worker: localhost:${e.TRACE_WORKER_PORT}`);
    if (traceObserve) {
      out(`  Trace observe: otelcol on http://127.0.0.1:${e.OTELCOL_HTTP_PORT} (grpc ${e.OTELCOL_GRPC_PORT}) → ${join(e.SLOCKDEV_DIR, "traces", "otlp.json")}`);
    }
  }
  if (latencyProfile) {
    out(`  Latency    : ${latencyProfile.label} via proxy on localhost:${e.LATENCY_PROXY_PORT}`);
    out("               (HTTP only; WebSocket upgrades pass through without delay)");
  } else {
    out("  Latency    : disabled (default)");
  }
  out(idleTtlSeconds > 0 ? `  Auto-stop : after ${idleTtlSeconds}s idle` : "  Auto-stop : disabled");
  out("");

  if (tmuxHasSession(e.TMUX_SESSION)) {
    out(`Environment '${name}' is already running.`);
    out(`  Attach:  ./raftdev logs ${name}`);
    out(`  Stop:    ./raftdev stop ${name}`);
    process.exit(1);
  }

  checkPort(e.PG_PORT, "PostgreSQL");
  checkPort(e.RUSTFS_PORT, "RustFS");
  checkPort(e.RUSTFS_CONSOLE_PORT, "RustFS console");
  checkPort(e.SERVER_PORT, "Server");
  // Cluster mode: each extra replica needs its own free server + metrics port.
  for (let k = 2; k <= replicas; k++) {
    checkPort(replicaServerPort(e.OFFSET, k), `Server replica ${k}`);
    const mp = replicaMetricsPort(e.OFFSET, k);
    if (mp !== null) checkPort(mp, `Server replica ${k} metrics`);
  }
  checkPort(e.WEB_PORT, "Web");
  if (risingWave.mode === "local") {
    checkPort(e.RISINGWAVE_PORT, "RisingWave pgwire");
    checkPort(e.RISINGWAVE_DASHBOARD_PORT, "RisingWave dashboard");
  }
  if (traceWorker) checkPort(e.TRACE_WORKER_PORT, "Trace upload worker");
  if (traceObserve) {
    checkPort(e.OTELCOL_HTTP_PORT, "otelcol OTLP HTTP");
    checkPort(e.OTELCOL_GRPC_PORT, "otelcol OTLP gRPC");
  }
  if (latencyProfile) checkPort(e.LATENCY_PROXY_PORT, "Latency proxy");

  // Establish a hard current-run boundary before any service starts. The file
  // exporter appends, so carrying otlp.json across restarts would let a remote
  // or disabled run accidentally present an earlier local run as current.
  let traceReaderState = initializeTraceReaderRun(e, traceReaderMode);
  const updateTraceReaderStatus = (status: TraceReaderStatus): void => {
    traceReaderState = { ...traceReaderState, status };
    writeTraceReaderState(e, traceReaderState);
  };
  const seedFileExistedBeforeStart = existsSync(e.SEED_FILE);
  const previousRisingWaveState = readRisingWaveState(e);
  const previousBaseOwnershipProof = previousRisingWaveState?.mode === "local" ||
    hasSeededEnvironmentOwnershipProof(e);
  for (const container of [e.CONTAINER, e.REDIS_CONTAINER, e.RUSTFS_CONTAINER, e.OTELCOL_CONTAINER]) {
    if (
      dockerNameExists(container) &&
      !dockerContainerIsRaftdevManaged(container) &&
      !previousBaseOwnershipProof
    ) {
      updateTraceReaderStatus("failed");
      out(`ERROR: Refusing to adopt unowned container '${container}'.`);
      out("  Remove or rename that external resource, or choose another raftdev environment name.");
      process.exit(1);
    }
  }
  if (
    dockerVolumeExists(e.RUSTFS_VOLUME) &&
    !dockerVolumeIsRaftdevManaged(e.RUSTFS_VOLUME) &&
    !previousBaseOwnershipProof
  ) {
    updateTraceReaderStatus("failed");
    out(`ERROR: Refusing to adopt unowned volume '${e.RUSTFS_VOLUME}'.`);
    out("  Remove or rename that external resource, or choose another raftdev environment name.");
    process.exit(1);
  }
  const hasRisingWaveContainer = dockerNameExists(e.RISINGWAVE_CONTAINER);
  const hasRisingWaveNetwork = dockerNetworkExists(e.RISINGWAVE_NETWORK);
  if (
    risingWave.mode === "external" &&
    shouldRefuseExternalRisingWaveTransition(
      previousRisingWaveState?.mode ?? null,
      hasRisingWaveContainer,
      hasRisingWaveContainer && dockerContainerIsRaftdevManaged(e.RISINGWAVE_CONTAINER),
      hasRisingWaveNetwork,
      hasRisingWaveNetwork && dockerNetworkIsRaftdevManaged(e.RISINGWAVE_NETWORK),
    )
  ) {
    updateTraceReaderStatus("failed");
    out(`ERROR: Managed local RisingWave residue exists for '${name}'.`);
    out("  Refusing to overwrite its ownership state with an external profile.");
    out(`  Recovery: ./raftdev stop ${name}, then retry with RISINGWAVE_DATABASE_URL.`);
    process.exit(1);
  }
  let risingWaveState = initialRisingWaveState(e, risingWave);
  const updateRisingWaveStatus = (
    status: RisingWaveStateStatus,
    patch: Partial<RisingWaveState> = {},
  ): void => {
    if (!risingWaveState) return;
    if (risingWaveState.mode === "external" && status !== "unmanaged") return;
    risingWaveState = { ...risingWaveState, ...patch, status };
    writeRisingWaveState(e, risingWaveState);
  };
  if (risingWaveState) writeRisingWaveState(e, risingWaveState);
  else if (previousRisingWaveState?.mode === "external") {
    // A stopped external profile may leave a durable non-secret ownership
    // denial for same-named Docker resources. Default-off mode must not erase
    // that tombstone merely because this server will not use RisingWave.
    writeRisingWaveState(e, previousRisingWaveState);
  } else {
    rmSync(e.RISINGWAVE_STATE_FILE, { force: true });
  }

  // Pull a missing collector image synchronously before starting the rest of
  // the environment. Once producers are live, the collector probe below must
  // be an authoritative docker-running verdict rather than an image-pull race.
  if (traceObserve && !dockerImageExists(OTELCOL_IMAGE)) {
    out(`Pulling local trace collector image ${OTELCOL_IMAGE}...`);
    const pull = spawnSync("docker", ["pull", OTELCOL_IMAGE], { stdio: "inherit" });
    if ((pull.status ?? 1) !== 0 || !dockerImageExists(OTELCOL_IMAGE)) {
      updateTraceReaderStatus("failed");
      updateRisingWaveStatus("failed");
      out(`ERROR: Failed to pull local trace collector image ${OTELCOL_IMAGE}.`);
      out("No development services were started.");
      process.exit(1);
    }
  }

  // From this point onward start may create managed resources. Any nonzero
  // exit or termination must clean those partial resources before returning.
  const failureCleanup = armStartFailureCleanup(e, seedFileExistedBeforeStart, {
    baseResources: previousBaseOwnershipProof,
    risingWaveContainer: previousRisingWaveState?.mode === "local",
    risingWaveNetwork: previousRisingWaveState?.mode === "local" &&
      previousRisingWaveState.profile === "full",
  });
  const risingWaveFull = risingWaveNeedsBootstrap(risingWave);
  if (risingWaveFull) {
    // Full mode is intentionally ephemeral/destructive. Recreate both database
    // containers and their bridge so a process-only residue cannot silently
    // retain non-logical WAL settings or a stale CDC catalog.
    for (const container of [e.RISINGWAVE_CONTAINER, e.CONTAINER]) {
      if (dockerNameExists(container)) {
        const hasLegacyOwnership = container === e.RISINGWAVE_CONTAINER
          ? previousRisingWaveState?.mode === "local"
          : previousBaseOwnershipProof;
        if (
          (container === e.RISINGWAVE_CONTAINER && previousRisingWaveState?.mode === "external") ||
          (!dockerContainerIsRaftdevManaged(container) && !hasLegacyOwnership)
        ) {
          if (previousRisingWaveState) writeRisingWaveState(e, previousRisingWaveState);
          else rmSync(e.RISINGWAVE_STATE_FILE, { force: true });
          out(`ERROR: Refusing to replace unowned container '${container}'.`);
          out(`  Remove or rename that external resource, or choose another raftdev environment name.`);
          process.exit(1);
        }
        out(`Replacing existing full-profile container ${container}...`);
        if (sh("docker", ["rm", "-f", container], { quiet: true }).code !== 0) {
          updateRisingWaveStatus("failed");
          out(`ERROR: Failed to replace container '${container}'.`);
          process.exit(1);
        }
      }
    }
    if (dockerNetworkExists(e.RISINGWAVE_NETWORK)) {
      if (
        previousRisingWaveState?.mode === "external" ||
        (!dockerNetworkIsRaftdevManaged(e.RISINGWAVE_NETWORK) &&
          !(previousRisingWaveState?.mode === "local" && previousRisingWaveState.profile === "full"))
      ) {
        if (previousRisingWaveState) writeRisingWaveState(e, previousRisingWaveState);
        else rmSync(e.RISINGWAVE_STATE_FILE, { force: true });
        out(`ERROR: Refusing to replace unowned Docker network '${e.RISINGWAVE_NETWORK}'.`);
        out(`  Remove or rename that external resource, or choose another raftdev environment name.`);
        process.exit(1);
      }
      if (sh("docker", ["network", "rm", e.RISINGWAVE_NETWORK], { quiet: true }).code !== 0) {
        updateRisingWaveStatus("failed");
        out(`ERROR: Failed to replace Docker network '${e.RISINGWAVE_NETWORK}'.`);
        process.exit(1);
      }
    }
    out(`Creating RisingWave CDC network ${e.RISINGWAVE_NETWORK}...`);
    if (sh("docker", [
      "network", "create", "--label", RAFTDEV_MANAGED_LABEL_ARG, e.RISINGWAVE_NETWORK,
    ], { quiet: true }).code !== 0) {
      updateRisingWaveStatus("failed");
      out(`ERROR: Failed to create Docker network '${e.RISINGWAVE_NETWORK}'.`);
      process.exit(1);
    }
  }

  // PostgreSQL container
  if (dockerNameExists(e.CONTAINER)) {
    out(`Starting existing container ${e.CONTAINER}...`);
    sh("docker", ["start", e.CONTAINER], { quiet: true });
  } else {
    out(`Creating PostgreSQL container ${e.CONTAINER}...`);
    const launch = sh("docker", postgresDockerRunArgs(e, risingWaveFull), { quiet: true });
    if (launch.code !== 0) {
      updateRisingWaveStatus("failed");
      out(`ERROR: Failed to create PostgreSQL container '${e.CONTAINER}'.`);
      process.exit(1);
    }
  }

  // Redis container
  if (portInUse(e.REDIS_PORT)) {
    out(`Redis already listening on port ${e.REDIS_PORT} (external).`);
  } else if (dockerNameExists(e.REDIS_CONTAINER)) {
    out(`Starting existing container ${e.REDIS_CONTAINER}...`);
    sh("docker", ["start", e.REDIS_CONTAINER], { quiet: true });
  } else {
    out(`Creating Redis container ${e.REDIS_CONTAINER}...`);
    sh("docker", [
      "run", "-d", "--name", e.REDIS_CONTAINER,
      "--label", RAFTDEV_MANAGED_LABEL_ARG,
      "-p", `${e.REDIS_PORT}:6379`,
      "redis:7-alpine",
    ], { quiet: true });
  }

  // Optional RisingWave standalone data plane. The documented Docker shape is
  // a single process (`single_node`) exposing pgwire :4566 and dashboard :5691.
  // It is deliberately independent from the local Postgres/Redis lifecycle;
  // RISINGWAVE_DATABASE_URL selects it only when the developer opted in.
  if (risingWave.mode === "local") {
    let launchCode = 0;
    if (dockerNameExists(e.RISINGWAVE_CONTAINER)) {
      if (
        previousRisingWaveState?.mode === "external" ||
        (!dockerContainerIsRaftdevManaged(e.RISINGWAVE_CONTAINER) &&
          previousRisingWaveState?.mode !== "local")
      ) {
        if (previousRisingWaveState) writeRisingWaveState(e, previousRisingWaveState);
        else rmSync(e.RISINGWAVE_STATE_FILE, { force: true });
        out(`ERROR: Refusing to replace unowned container '${e.RISINGWAVE_CONTAINER}'.`);
        out(`  Remove or rename that external resource, or choose another raftdev environment name.`);
        process.exit(1);
      }
      // Local standalone is explicitly ephemeral. Recreate a stopped residue
      // instead of silently retaining stale catalog state or ignoring a new
      // image/port override after an interrupted prior start.
      out(`Replacing existing container ${e.RISINGWAVE_CONTAINER}...`);
      const removeCode = sh("docker", ["rm", "-f", e.RISINGWAVE_CONTAINER], { quiet: true }).code;
      if (removeCode !== 0) {
        updateRisingWaveStatus("failed");
        out(`ERROR: Failed to replace RisingWave container '${e.RISINGWAVE_CONTAINER}'.`);
        out("  Retry after inspecting Docker, or run ./raftdev stop to clean partial services.");
        process.exit(1);
      }
    }
    out(`Creating RisingWave standalone container ${e.RISINGWAVE_CONTAINER}...`);
    launchCode = sh(
      "docker",
      risingWaveDockerRunArgs(
        e,
        risingWave.image ?? DEFAULT_RISINGWAVE_IMAGE,
        risingWaveFull ? e.RISINGWAVE_NETWORK : undefined,
      ),
      { quiet: true },
    ).code;
    if (launchCode !== 0) {
      updateRisingWaveStatus("failed");
      out(`ERROR: Failed to start RisingWave container '${e.RISINGWAVE_CONTAINER}'.`);
      out(`  Image: ${risingWave.image ?? DEFAULT_RISINGWAVE_IMAGE}`);
      out("  Retry after inspecting Docker, or run ./raftdev stop to clean partial services.");
      process.exit(1);
    }
    updateRisingWaveStatus("starting", {
      actualImageId: dockerContainerImageId(e.RISINGWAVE_CONTAINER),
    });
  }

  // RustFS
  sh("docker", [
    "volume", "create", "--label", RAFTDEV_MANAGED_LABEL_ARG, e.RUSTFS_VOLUME,
  ], { quiet: true });
  sh("docker", [
    "run", "--rm", "-v", `${e.RUSTFS_VOLUME}:/data`,
    "postgres:16-alpine", "sh", "-c", "chown -R 10001:10001 /data",
  ], { quiet: true });
  if (dockerNameExists(e.RUSTFS_CONTAINER)) {
    out(`Starting existing container ${e.RUSTFS_CONTAINER}...`);
    sh("docker", ["start", e.RUSTFS_CONTAINER], { quiet: true });
  } else {
    out(`Creating RustFS container ${e.RUSTFS_CONTAINER}...`);
    sh("docker", [
      "run", "-d", "--name", e.RUSTFS_CONTAINER,
      "--label", RAFTDEV_MANAGED_LABEL_ARG,
      "-e", "RUSTFS_ADDRESS=:9000",
      "-e", `RUSTFS_ACCESS_KEY=${e.RUSTFS_ACCESS_KEY}`,
      "-e", `RUSTFS_SECRET_KEY=${e.RUSTFS_SECRET_KEY}`,
      "-e", "RUSTFS_CONSOLE_ENABLE=true",
      "-p", `${e.RUSTFS_PORT}:9000`,
      "-p", `${e.RUSTFS_CONSOLE_PORT}:9001`,
      "-v", `${e.RUSTFS_VOLUME}:/data`,
      "mirror.gcr.io/rustfs/rustfs:latest",
      "/data",
    ], { quiet: true });
  }

  out("Waiting for PostgreSQL...");
  let pgReady = false;
  for (let n = 1; n <= 30; n++) {
    const r = sh("docker", ["exec", e.CONTAINER, "pg_isready", "-U", "postgres"], { quiet: true });
    if (r.code === 0) { pgReady = true; break; }
    spawnSync("sleep", ["1"]);
  }
  if (!pgReady) {
    updateRisingWaveStatus("failed");
    out("ERROR: PostgreSQL did not become ready in time.");
    process.exit(1);
  }
  out("PostgreSQL is ready.");
  if (risingWaveFull && !postgresLogicalWalReady(e)) {
    updateRisingWaveStatus("failed");
    out("ERROR: Managed full profile requires PostgreSQL wal_level=logical.");
    out(`  Inspect: docker exec ${e.CONTAINER} psql -U postgres -d slock -Atc 'SHOW wal_level'`);
    out(`  Recovery: ./raftdev stop ${name}`);
    process.exit(1);
  }
  if (risingWaveFull) out("PostgreSQL logical WAL is ready.");

  if (risingWave.mode === "local") {
    out("Waiting for RisingWave pgwire SELECT 1...");
    const readiness = waitForRisingWaveReadiness({
      attempts: 90,
      containerRunning: () => dockerNameRunning(e.RISINGWAVE_CONTAINER),
      sqlReady: () => risingWaveSqlReady(e.RISINGWAVE_DATABASE_URL),
      sleep: () => { spawnSync("sleep", ["1"]); },
    });
    if (readiness !== "ready") {
      updateRisingWaveStatus("failed");
      out(readiness === "container-exited"
        ? "ERROR: RisingWave standalone exited before pgwire became query-ready."
        : "ERROR: RisingWave standalone did not become query-ready in time.");
      out(`  Logs: docker logs --tail 100 ${e.RISINGWAVE_CONTAINER}`);
      out("  The image requires AVX2 on x86_64 or NEON on ARM64.");
      process.exit(1);
    }
    out("RisingWave pgwire SELECT 1 is ready.");
    if (risingWave.profile === "process-only") {
      updateRisingWaveStatus("pgwire-ready");
      out("  WARNING: process-only wiring smoke has no CDC sources or materialized views.");
    }
  }

  if (!ensureRustfsBucket(e)) {
    updateRisingWaveStatus("failed");
    process.exit(1);
  }

  out("Pushing database schema...");
  const npxCommand = packageManagerCommand("npx");
  let r = spawnSync(npxCommand, ["drizzle-kit", "push", "--force"], {
    cwd: join(PROJECT_DIR, "packages/server"),
    env: { ...process.env, DATABASE_URL: e.DATABASE_URL },
    stdio: "inherit",
    shell: packageManagerSpawnShell(),
  });
  if ((r.status ?? 1) !== 0) {
    updateRisingWaveStatus("failed");
    process.exit(r.status ?? 1);
  }
  out("Schema is up to date.");

  out("Seeding test data...");
  r = spawnSync(npxCommand, buildDevSeedArgs(e.SEED_FILE, withOnboarding), {
    cwd: join(PROJECT_DIR, "packages/server"),
    env: {
      ...process.env,
      DATABASE_URL: e.DATABASE_URL,
      S3_ENDPOINT: e.S3_ENDPOINT,
      S3_REGION: "us-east-1",
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: e.RUSTFS_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: e.RUSTFS_SECRET_KEY,
      S3_ATTACHMENTS_BUCKET: e.RUSTFS_BUCKET,
      S3_CDN_BUCKET: e.RUSTFS_BUCKET,
    },
    stdio: "inherit",
    shell: packageManagerSpawnShell(),
  });
  if ((r.status ?? 1) !== 0) {
    updateRisingWaveStatus("failed");
    process.exit(r.status ?? 1);
  }
  out("Seed data ready.");

  if (risingWaveFull) {
    out("Bootstrapping managed RisingWave CDC and materialized-view graph...");
    const bootstrapStatus = runManagedRisingWaveBootstrap(e);
    if (bootstrapStatus !== 0) {
      updateRisingWaveStatus("failed");
      out("ERROR: Managed RisingWave CDC/MV bootstrap failed; server processes were not started.");
      out(`  RisingWave logs: docker logs --tail 100 ${e.RISINGWAVE_CONTAINER}`);
      out(`  Recovery: ./raftdev stop ${name}`);
      process.exit(bootstrapStatus);
    }
    out("RisingWave CDC/MV graph is ready; waiting for strict seeded parity...");
    if (!runSeededRisingWaveParity(e, { bootstrapSeedBaseline: true })) {
      updateRisingWaveStatus("failed");
      out("ERROR: Managed RisingWave serving parity failed; server processes were not started.");
      out(`  Recovery: ./raftdev stop ${name}`);
      process.exit(1);
    }
    updateRisingWaveStatus("serving-ready");
    out("Managed RisingWave is serving-ready.");
  }

  out("Building @botiverse/raft (used by spawned agents for messaging)...");
  const pnpmCommand = packageManagerCommand("pnpm");
  r = spawnSync(pnpmCommand, ["--filter", "@botiverse/raft", "build"], {
    cwd: PROJECT_DIR, env: process.env, stdio: ["inherit", "ignore", "inherit"],
    shell: packageManagerSpawnShell(),
  });
  if ((r.status ?? 1) !== 0) {
    updateRisingWaveStatus("failed");
    process.exit(r.status ?? 1);
  }
  out("CLI built.");

  // Extract machine API key from seed file (first "apiKey": "..." occurrence).
  let machineApiKey = "";
  try {
    const m = readFileSync(e.SEED_FILE, "utf8").match(/"apiKey":\s*"([^"]+)"/);
    if (m) machineApiKey = m[1];
  } catch {}

  mkdirSync(e.SLOCKDEV_DIR, { recursive: true });
  mkdirSync(e.SLOCK_HOME, { recursive: true });
  const machineApiKeyFile = join(e.SLOCK_HOME, "slockdev-machine-api-key");
  writeFileSync(machineApiKeyFile, machineApiKey, { mode: 0o600 });
  chmodSync(machineApiKeyFile, 0o600);
  writeFileSync(e.ACTIVITY_FILE, `${Math.floor(Date.now() / 1000)}\n`);
  writeFileSync(e.IDLE_TTL_FILE, `${idleTtlSeconds}\n`);
  if (risingWave.mode === "external") {
    writeFileSync(e.RISINGWAVE_DSN_FILE, `${risingWave.databaseUrl}\n`, { mode: 0o600 });
    chmodSync(e.RISINGWAVE_DSN_FILE, 0o600);
  } else {
    // Clear residue from an interrupted earlier external-mode run before a
    // local/default-off server can start under a different ownership model.
    rmSync(e.RISINGWAVE_DSN_FILE, { force: true });
  }

  // Start the preview tunnel before constructing server/web commands so OAuth
  // callbacks can default to the public localdev URL instead of localhost.
  const tunnel = startCloudflaredTunnel(e, (pid) => failureCleanup.trackTunnel(pid));
  const publicPreviewUrl = tunnel.url;

  const passthrough = (n: string): string => envAssign(n, process.env[n] ?? "");
  const risingWaveServerEnv = risingWaveServerEnvironment(risingWave, process.env);
  const risingWaveDatabaseUrlAssignment = risingWaveDatabaseUrlCommandAssignment(
    risingWave,
    e.RISINGWAVE_DSN_FILE,
  );

  // Build the env-prefixed `pnpm --filter @botiverse/raft-server dev` command line for
  // replica index k (1-based). Replica 1 is byte-for-byte identical to the
  // historical single-replica command: PORT=SERVER_PORT and NO METRICS_PORT
  // (server default 9091). Replicas k≥2 get their own derived PORT + METRICS_PORT
  // (see replicaServerPort/replicaMetricsPort) but share everything else —
  // DATABASE_URL, REDIS_URL, JWT_SECRET, S3 — so they form ONE logical cluster
  // over the same Postgres + Redis. Each server process auto-mints its own
  // REPLICA_ID, so no replica-identity env is needed.
  const buildServerCmd = (k: number): string => {
    const serverPort = replicaServerPort(e.OFFSET, k);
    const metricsPort = replicaMetricsPort(e.OFFSET, k);
    let serverCmd = "";
    // The server SIGNS daemon/web scope attestations with SCOPE_ATTESTATION_SECRET;
    // the trace worker (local or remote) VERIFIES with the same secret. Set it
    // whenever a worker is in play — local (derived secret) or remote (the secret
    // the dev supplied for the remote worker, if any).
    if (scopeAttestationSecret) serverCmd += `${envAssign("SCOPE_ATTESTATION_SECRET", scopeAttestationSecret)} `;
    serverCmd += `${envAssign("SLOCK_HOME", e.SLOCK_HOME)} `;
    serverCmd += `${envAssign("SLOCKDEV_LAST_ACTIVITY_FILE", e.ACTIVITY_FILE)} `;
    serverCmd += `${envAssign("DEPLOYMENT_ENV", "slockdev")} `;
    serverCmd += `${envAssign("DATABASE_URL", e.DATABASE_URL)} `;
    serverCmd += `${envAssign("JWT_SECRET", e.JWT_SECRET)} `;
    // task #30 — opt-in Raft Computer path. Default OFF (zero behaviour
    // change for non-Computer envs). `RAFTDEV_COMPUTER=1 ./raftdev start`
    // enables the device-code login surface + the >=32-char bootstrap
    // pepper device-auth requires, so `raft-computer login/attach/start`
    // works against this env with no manual slockdev edits.
    if (process.env.RAFTDEV_COMPUTER && process.env.RAFTDEV_COMPUTER !== "0") {
      serverCmd += `${envAssign("SLOCK_DEVICE_LOGIN_ENABLED", "true")} `;
      serverCmd += `${envAssign("AGENT_BOOTSTRAP_TOKEN_PEPPER", `raftdev-computer-pepper-${name}-0123456789abcdef`)} `;
    }
    serverCmd += `${envAssign("PORT", String(serverPort))} `;
    // Distinct Prometheus metrics port per extra replica so two server
    // processes on this host don't both try to bind 9091 (which would crash
    // the second — metrics.ts has no listen-error handler). Replica 1 omits
    // METRICS_PORT entirely → server default 9091, unchanged.
    if (metricsPort !== null) serverCmd += `${envAssign("METRICS_PORT", String(metricsPort))} `;
    serverCmd += `${envAssign("SERVER_URL", process.env.SERVER_URL || publicPreviewUrl || `http://localhost:${serverPort}`)} `;
    serverCmd += `${envAssign("APP_URL", process.env.APP_URL || publicPreviewUrl || `http://localhost:${e.WEB_PORT}`)} `;
    serverCmd += `${envAssign("CORS_ORIGIN", `http://localhost:${e.WEB_PORT}`)} `;
    serverCmd += `${envAssign("REDIS_URL", e.REDIS_URL)} `;
    if (risingWaveDatabaseUrlAssignment) {
      serverCmd += `${risingWaveDatabaseUrlAssignment} `;
    }
    for (const [key, value] of Object.entries(risingWaveServerEnv)) {
      if (key === "RISINGWAVE_DATABASE_URL") continue;
      serverCmd += `${envAssign(key, value)} `;
    }
    // Local trace-observe should include server request/db/route spans, not
    // only daemon/web traces that flow through the upload worker. Point each
    // server replica directly at the local collector; OtlpHttpTraceSink appends
    // /v1/traces when needed.
    if (traceObserve) {
      const serviceName = replicas === 1
        ? `slock-server-${name}`
        : `slock-server-${name}-${replicaWindowName(k)}`;
      serverCmd += `${envAssign("SLOCK_TRACE_OTLP_ENDPOINT", `http://127.0.0.1:${e.OTELCOL_HTTP_PORT}`)} `;
      serverCmd += `${envAssign("SLOCK_TRACE_SERVICE_NAME", serviceName)} `;
    }
    serverCmd += `${envAssign("S3_ENDPOINT", e.S3_ENDPOINT)} `;
    serverCmd += `${envAssign("S3_REGION", "us-east-1")} `;
    serverCmd += `${envAssign("S3_FORCE_PATH_STYLE", "true")} `;
    serverCmd += `${envAssign("S3_ACCESS_KEY_ID", e.RUSTFS_ACCESS_KEY)} `;
    serverCmd += `${envAssign("S3_SECRET_ACCESS_KEY", e.RUSTFS_SECRET_KEY)} `;
    serverCmd += `${envAssign("S3_ATTACHMENTS_BUCKET", e.RUSTFS_BUCKET)} `;
    serverCmd += `${envAssign("S3_CDN_BUCKET", e.RUSTFS_BUCKET)} `;
    for (const v of [
      "TRANSLATION_PROVIDER",
      "TRANSLATION_AZURE_ENDPOINT", "TRANSLATION_AZURE_API_KEY", "TRANSLATION_AZURE_REGION",
      "TRANSLATION_VOLCENGINE_ACCESS_KEY_ID", "TRANSLATION_VOLCENGINE_SECRET_ACCESS_KEY",
      "TRANSLATION_VOLCENGINE_ENDPOINT", "TRANSLATION_VOLCENGINE_REGION",
      "TRANSLATION_GOOGLE_PROJECT_ID", "TRANSLATION_GOOGLE_LOCATION",
      "TRANSLATION_GOOGLE_ACCESS_TOKEN", "TRANSLATION_GOOGLE_SERVICE_ACCOUNT_JSON",
      "TRANSLATION_GOOGLE_CLIENT_EMAIL", "TRANSLATION_GOOGLE_PRIVATE_KEY",
      "TRANSLATION_GOOGLE_QUOTA_PROJECT_ID", "TRANSLATION_GOOGLE_ENDPOINT",
      "ATTACHMENT_COMMENTS_SERVER_SLUG",
      "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
      "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_REDIRECT_URI",
      "MOBILE_OAUTH_RETURN_URI",
      "MOBILE_OAUTH_ALLOWED_RETURN_URIS",
      "SLOCK_MCP_CREDENTIAL_KEY",
      "SLOCK_E2E_AUTO_VERIFY_EMAIL",
    ]) serverCmd += `${passthrough(v)} `;
    serverCmd += "pnpm --filter @botiverse/raft-server dev";
    return serverCmd;
  };

  // Window 0: server (replica 1) — creates the tmux session. This is byte-for-
  // byte the historical single-replica server window when replicas === 1.
  runRequiredTmux(
    ["new-session", "-d", "-s", e.TMUX_SESSION, "-n", replicaWindowName(1), "-c", PROJECT_DIR, runTmuxShellCommand(buildServerCmd(1))],
    replicaWindowName(1),
  );
  // Extra replica windows (server-2 … server-N), each on its own derived
  // server + metrics port, all over the same Postgres + Redis.
  for (let k = 2; k <= replicas; k++) {
    runRequiredTmux(
      ["new-window", "-t", e.TMUX_SESSION, "-n", replicaWindowName(k), "-c", PROJECT_DIR, runTmuxShellCommand(buildServerCmd(k))],
      replicaWindowName(k),
    );
  }

  // Window 1: web
  // When latency is active we point the Vite proxy at the latency proxy port
  // instead of the server port. The proxy then forwards to the real server.
  // Everything else in this command line stays identical — this is the only
  // bit that changes between latency-off and latency-on.
  const webServerPort = latencyProfile ? e.LATENCY_PROXY_PORT : e.SERVER_PORT;
  let webCmd = "";
  webCmd += `${envAssign("SLOCK_HOME", e.SLOCK_HOME)} `;
  webCmd += `${envAssign("SLOCK_SERVER_PORT", String(webServerPort))} `;
  webCmd += `${envAssign("VITE_DEV_PORT", String(e.WEB_PORT))} `;
  webCmd += `${envAssign("VITE_DEPLOYMENT_ENV", "slockdev")} `;
  webCmd += `${envAssign("VITE_SLOCKDEV_ENV_NAME", name)} `;
  webCmd += `${envAssign("VITE_SLOCKDEV_PREVIEW_DESCRIPTION", previewDescription)} `;
  // Opt-in: skip the slockdev auto-login into dev@slock.ai so a preview can
  // exercise the genuinely-fresh unauthenticated entry (signup / onboarding
  // rework). Baked inline (not tmux-env-inherited) for the same reason the
  // server flags are — new tmux windows do not inherit the launching shell's
  // env. Unset → not added → auto-login behaves exactly as before.
  if (process.env.VITE_SLOCKDEV_SKIP_AUTO_LOGIN) {
    webCmd += `${envAssign("VITE_SLOCKDEV_SKIP_AUTO_LOGIN", process.env.VITE_SLOCKDEV_SKIP_AUTO_LOGIN)} `;
  }
  // Preview acceptance can bind one environment to a seeded owner/admin/member
  // account. This stays slockdev-only and keeps each public role URL
  // passwordless without introducing a product-side account impersonation UI.
  if (process.env.VITE_SLOCKDEV_EMAIL) {
    webCmd += `${envAssign("VITE_SLOCKDEV_EMAIL", process.env.VITE_SLOCKDEV_EMAIL)} `;
  }
  // Point the web Report Issue export at whichever worker is in play (local or
  // remote), mirroring the daemon. Empty when no worker (SLOCKDEV_TRACE_WORKER=0).
  if (effectiveWorkerUrl) webCmd += `${envAssign("VITE_FEEDBACK_EXPORT_URL", effectiveWorkerUrl)} `;
  // Same worker also receives the L4 web auth-trace pipe (`webAuthTrace.ts`
  // reads `VITE_WEB_TRACE_URL`). Without this wiring, trace emit is a silent
  // no-op under slockdev — every `slock.auth.*` event is dropped, which makes
  // local auth-investigation indistinguishable from "trace pipe broken".
  // Surfaced 2026-06-17 by @tygg in #proj-frontend during a slockdev
  // tracing-link verification; mirrors xxchan's prod-side wiring done earlier
  // in the same investigation (#proj-frontend:0485c3a7 daily report).
  if (effectiveWorkerUrl) webCmd += `${envAssign("VITE_WEB_TRACE_URL", effectiveWorkerUrl)} `;
  webCmd += "pnpm --filter @botiverse/raft-web dev";
  runRequiredTmux(
    ["new-window", "-t", e.TMUX_SESSION, "-n", "web", "-c", PROJECT_DIR, runTmuxShellCommand(webCmd)],
    "web",
  );

  // Window 2: daemon
  let daemonCmd = "";
  // Point the daemon at whichever worker is in play. For a local worker this is
  // the derived localhost URL; for point-anywhere it is the remote URL the dev
  // gave (we deliberately do NOT clobber an external override with localhost).
  if (effectiveWorkerUrl) daemonCmd += `${envAssign("SLOCK_DAEMON_TRACE_UPLOAD_URL", effectiveWorkerUrl)} `;
  if (traceObserve) {
    // Trace-observe is a local diagnostic loop; keep daemon bundle rotation and
    // upload tight enough that .slockdev/<env>/traces/otlp.json reflects a
    // short smoke run instead of waiting for production's fleet-friendly jitter
    // and five-minute cadence.
    daemonCmd += `${envAssign("SLOCK_DAEMON_TRACE_JITTER_DISABLED", "1")} `;
    daemonCmd += `${envAssign("SLOCK_DAEMON_TRACE_MAX_FILE_AGE_MS", "5000")} `;
    daemonCmd += `${envAssign("SLOCK_DAEMON_TRACE_MAX_FILE_BYTES", "16384")} `;
    daemonCmd += `${envAssign("SLOCK_DAEMON_TRACE_UPLOAD_MIN_FILE_AGE_MS", "1000")} `;
    daemonCmd += `${envAssign("SLOCK_DAEMON_TRACE_UPLOAD_INTERVAL_MS", "5000")} `;
  }
  daemonCmd += `${envAssign("SLOCK_HOME", e.SLOCK_HOME)} `;
  daemonCmd += `pnpm --filter @botiverse/raft-daemon dev -- --server-url ${shellQuote(`http://localhost:${e.SERVER_PORT}`)} --api-key-file ${shellQuote(machineApiKeyFile)}`;
  runRequiredTmux(
    ["new-window", "-t", e.TMUX_SESSION, "-n", "daemon", "-c", PROJECT_DIR, runTmuxShellCommand(daemonCmd)],
    "daemon",
  );

  if (traceWorker) {
    let twCmd = "";
    twCmd += `${envAssign("SLOCK_HOME", e.SLOCK_HOME)} `;
    twCmd += `${envAssign("SCOPE_ATTESTATION_SECRET", scopeAttestationSecret)} `;
    twCmd += `${envAssign("TRACE_UPLOAD_WORKER_SECRET", traceWorkerSecret)} `;
    twCmd += `${envAssign("TRACE_UPLOAD_MAX_BYTES", "52428800")} `;
    twCmd += `${envAssign("TRACE_WEB_CORS_ORIGIN", `http://localhost:${e.WEB_PORT}`)} `;
    twCmd += `${envAssign("DEPLOYMENT_ENV", "slockdev")} `;
    twCmd += `${envAssign("PORT", String(e.TRACE_WORKER_PORT))} `;
    // Trace-observe loop: forward received OTLP traces to the local collector.
    // The worker appends `/v1/traces` to TRACE_INGEST_OTLP_ENDPOINT
    // (normalizeOtlpTracesEndpoint), so we pass the collector's OTLP HTTP base.
    if (traceObserve) {
      twCmd += `${envAssign("TRACE_INGEST_OTLP_ENDPOINT", `http://127.0.0.1:${e.OTELCOL_HTTP_PORT}`)} `;
      twCmd += `${envAssign("TRACE_INGEST_SERVICE_NAME", `slock-daemon-${name}`)} `;
    }
    twCmd += "pnpm --filter @botiverse/raft-trace-upload-worker dev";
    runRequiredTmux(
      ["new-window", "-t", e.TMUX_SESSION, "-n", "trace-worker", "-c", PROJECT_DIR, runTmuxShellCommand(twCmd)],
      "trace-worker",
    );
  }

  // otelcol window: the local trace-observe collector, run as a docker
  // container (zero-config — Docker is already a slockdev prerequisite, so
  // there is no binary to install and no graceful-degrade path). The container
  // runs FOREGROUND inside the tmux window so its debug exporter streams live
  // ("watch traces arrive"); `--rm` + an explicit pre-`docker rm -f` keep it
  // self-cleaning across restarts. Host ports map to the in-container standard
  // OTLP ports (4317/4318); the config + traces dir are bind-mounted.
  let otelcolStarted = false;
  if (traceObserve) {
    const { tracesDir } = traceReaderPaths(e);
    // The contrib image runs as uid 10001; make the bind-mounted traces dir
    // world-writable so the file exporter can append otlp.json (debug exporter
    // works regardless, but the persisted JSON is part of the observe loop).
    chmodSync(tracesDir, 0o777);
    const otelcolConfigPath = join(e.SLOCKDEV_DIR, "otelcol.yaml");
    writeFileSync(otelcolConfigPath, buildOtelcolConfig(e));
    const otelcolCmd =
      `docker rm -f ${shellQuote(e.OTELCOL_CONTAINER)} >/dev/null 2>&1; ` +
      `exec docker run --rm --name ${shellQuote(e.OTELCOL_CONTAINER)} ` +
      `--label ${shellQuote(RAFTDEV_MANAGED_LABEL_ARG)} ` +
      `-p 127.0.0.1:${e.OTELCOL_GRPC_PORT}:4317 ` +
      `-p 127.0.0.1:${e.OTELCOL_HTTP_PORT}:4318 ` +
      `-v ${shellQuote(`${otelcolConfigPath}:${OTELCOL_CONTAINER_CONFIG}`)} ` +
      `-v ${shellQuote(`${tracesDir}:${OTELCOL_CONTAINER_TRACES}`)} ` +
      `${OTELCOL_IMAGE}`;
    const launch = sh("tmux", ["new-window", "-t", e.TMUX_SESSION, "-n", "otelcol", "-c", PROJECT_DIR, runTmuxShellCommand(otelcolCmd)], { quiet: true });
    if (launch.code === 0) {
      // The image is already present, but tmux still launches docker
      // asynchronously. Give docker a bounded startup window and only call the
      // reader ready after the named container is actually running.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (dockerNameRunning(e.OTELCOL_CONTAINER)) {
          otelcolStarted = true;
          break;
        }
        spawnSync("sleep", ["0.25"]);
      }
    }
    updateTraceReaderStatus(otelcolStarted ? "ready" : "failed");
  }

  if (latencyProfile) {
    const proxyCmd =
      `node --import tsx scripts/dev/raftdev-latency-proxy.ts ` +
      `--port ${String(e.LATENCY_PROXY_PORT)} ` +
      `--target-port ${String(e.SERVER_PORT)} ` +
      `--min-ms ${String(latencyProfile.minMs)} ` +
      `--max-ms ${String(latencyProfile.maxMs)} ` +
      `--label ${shellQuote(latencyProfile.label)}`;
    runRequiredTmux(
      ["new-window", "-t", e.TMUX_SESSION, "-n", "latency-proxy", "-c", PROJECT_DIR, runTmuxShellCommand(proxyCmd)],
      "latency-proxy",
    );
  }

  if (idleTtlSeconds > 0) {
    const janitorCmd = `node --import tsx scripts/dev/raftdev.ts janitor ${shellQuote(name)} ${String(idleTtlSeconds)}`;
    runRequiredTmux(
      ["new-window", "-t", e.TMUX_SESSION, "-n", "janitor", "-c", PROJECT_DIR, runTmuxShellCommand(janitorCmd)],
      "janitor",
    );
  }

  sh("tmux", ["select-window", "-t", `${e.TMUX_SESSION}:server`], { quiet: true });

  out("");
  out(`=== Environment '${name}' is running ===`);
  out(`  Web UI:    http://localhost:${e.WEB_PORT}`);
  out(`  API:       http://localhost:${e.SERVER_PORT}`);
  if (replicas > 1) {
    out(`  Cluster:   ${replicas} server replicas over one Postgres + Redis (Socket.io Redis adapter coordinates broadcasts)`);
    for (let k = 1; k <= replicas; k++) {
      const sp = replicaServerPort(e.OFFSET, k);
      const mp = replicaMetricsPort(e.OFFSET, k);
      out(`    ${replicaWindowName(k).padEnd(9)} http://localhost:${sp}${mp !== null ? `  (metrics :${mp})` : "  (metrics :9091)"}`);
    }
    out(`             Daemon connects to replica 1 (:${e.SERVER_PORT}); target another replica by pointing a client at its port.`);
  }
  if (usingRemoteWorker) {
    out(`  Trace worker: ${traceWorkerUrl} (remote — point-anywhere; daemon + web report there)`);
    if (!scopeAttestationSecret) {
      out("               (no SLOCKDEV_SCOPE_ATTESTATION_SECRET set — uploads may fail attestation against the remote worker)");
    }
    out("  Trace observe: remote mode — no local collector or local trace-reader source");
  } else if (traceWorker) {
    out(`  Trace worker: http://localhost:${e.TRACE_WORKER_PORT}`);
    out(`  Report Issue: enabled via VITE_FEEDBACK_EXPORT_URL=http://localhost:${e.TRACE_WORKER_PORT}`);
    out(`  Feedback smoke: ./raftdev script feedback-report --env ${name}`);
    if (otelcolStarted) {
      out(`  Trace observe: otelcol container — OTLP http://127.0.0.1:${e.OTELCOL_HTTP_PORT} (grpc ${e.OTELCOL_GRPC_PORT})`);
      out(`                 received spans: 'otelcol' tmux window (debug) + ${join(e.SLOCKDEV_DIR, "traces", "otlp.json")}`);
      for (const line of traceBannerLines(name)) out(line);
    } else if (traceObserve) {
      out("  Trace observe: collector failed to start; inspect the 'otelcol' tmux window");
    } else {
      out("  Trace observe: disabled (SLOCKDEV_TRACE_OBSERVE=0)");
    }
  } else {
    out("  Trace worker: disabled (SLOCKDEV_TRACE_WORKER=0)");
    out("  Trace observe: disabled because the local trace worker is disabled");
  }
  if (latencyProfile) {
    out(`  Latency proxy: http://localhost:${e.LATENCY_PROXY_PORT} -> :${e.SERVER_PORT}  profile=${latencyProfile.label}`);
    out(`                 (Web's API requests go through this; WS upgrades pass through.)`);
  }
  out(`  SLOCK_HOME: ${e.SLOCK_HOME}`);
  out(`  Postgres:  ${e.DATABASE_URL}`);
  if (risingWave.mode === "local") {
    out(`  RisingWave: managed/${risingWave.profile} ${risingWaveState?.status ?? "unknown"}`);
    out(`              pgwire ${e.RISINGWAVE_DATABASE_URL}`);
    out(`              dashboard http://127.0.0.1:${e.RISINGWAVE_DASHBOARD_PORT}; database dev`);
    out(`              image ${risingWave.image ?? DEFAULT_RISINGWAVE_IMAGE}`);
    if (risingWaveState?.actualImageId) out(`              image ID ${risingWaveState.actualImageId}`);
    if (risingWave.profile === "full") {
      out("              source slockdev_pg_cdc; publication slockdev_rw_publication");
      out(`              psql '${e.RISINGWAVE_DATABASE_URL}'`);
    } else {
      out("              WARNING: no CDC/MVs; process-only wiring smoke is not a serving environment");
    }
  } else if (risingWave.mode === "external") {
    out("  RisingWave: external/unmanaged RISINGWAVE_DATABASE_URL (value hidden)");
    out("              raftdev stop/nuke will not modify the external instance");
  }
  out(`  RustFS:    ${e.S3_ENDPOINT} (bucket: ${e.RUSTFS_BUCKET})`);
  out(`  Login:     dev@slock.ai / password123`);
  out(idleTtlSeconds > 0
    ? `  Auto-stop: after ${idleTtlSeconds}s idle (last activity ${e.ACTIVITY_FILE})`
    : "  Auto-stop: disabled");
  if (tunnel.enabled && tunnel.url) {
    out(`  CF Tunnel: ${tunnel.url} (cloudflared pid ${tunnel.pid}, log ${tunnel.logFile})`);
  } else if (tunnel.enabled) {
    out(`  CF Tunnel: started (pid ${tunnel.pid}) — URL not yet visible; see ${tunnel.logFile}`);
  } else if (tunnel.reason === "cloudflared not installed") {
    out(`  CF Tunnel: NOT opened — \`cloudflared\` not installed. Install (e.g. \`brew install cloudflare/cloudflare/cloudflared\`) and re-run to get a public preview URL, or stay on localhost.`);
  } else if (tunnel.reason === "SLOCKDEV_TUNNEL=0 (opt-out)") {
    out(`  CF Tunnel: disabled (SLOCKDEV_TUNNEL=0).`);
  } else {
    out(`  CF Tunnel: ${tunnel.reason ?? "unknown state"}`);
  }
  out("");
  out(`  Attach:    ./raftdev logs ${name}`);
  out(`  Stop:      ./raftdev stop ${name}`);
  out(`  Creds:     ${e.SEED_FILE}`);
  failureCleanup.disarm();
}

function cmdJanitor(name: string, ttlSecondsArg: string | undefined): void {
  const e = setupEnv(name);
  const ttlSeconds = parseIdleTtlSeconds(ttlSecondsArg);
  if (ttlSeconds <= 0) return;
  out(`[raftdev] janitor watching '${name}' (idle TTL ${ttlSeconds}s)`);
  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const lastActivity = readIntegerFile(e.ACTIVITY_FILE) ?? now;
    const idleSeconds = now - lastActivity;
    if (idleSeconds >= ttlSeconds) {
      out(`[raftdev] '${name}' idle for ${idleSeconds}s; auto-stopping environment.`);
      cmdStop(name);
      return;
    }
    const remaining = Math.max(1, ttlSeconds - idleSeconds);
    spawnSync("sleep", [String(Math.min(60, remaining))]);
  }
}

// ───────────────── dispatch ─────────────────

async function main(argv: string[]): Promise<number | void> {
  const command = argv[0] ?? "";
  const envName = argv[1] ?? basename(PROJECT_DIR);
  switch (command) {
    case "__cleanup-failed-start": {
      try {
        validateEnvironmentName(envName);
      } catch (error) {
        out(`ERROR: ${(error as Error).message}`);
        return 1;
      }
      const tunnelPid = /^\d+$/.test(argv[6] ?? "") && Number(argv[6]) > 0
        ? Number(argv[6])
        : undefined;
      return cleanupFailedStart(setupEnv(envName), tunnelPid, argv[2] === "1", {
        baseResources: argv[3] === "1",
        risingWaveContainer: argv[4] === "1",
        risingWaveNetwork: argv[5] === "1",
      }) ? 0 : 1;
    }
    case "start":  cmdStart(argv.slice(1)); break;
    case "stop":   cmdStop(envName); break;
    case "status": cmdStatus(); break;
    case "seed":   cmdSeed(argv.slice(1)); break;
    case "script": cmdScript(argv.slice(1)); break;
    case "logs":   cmdLogs(envName); break;
    case "ports":  cmdPorts(envName); break;
    case "trace":  return runTraceCli(argv.slice(1), {
      projectDir: PROJECT_DIR,
      defaultEnvName: basename(PROJECT_DIR),
    });
    case "nuke":   cmdNuke(); break;
    case "janitor": cmdJanitor(envName, argv[2]); break;
    default:       usageAndExit();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== undefined) process.exitCode = code;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 1;
  });
}
