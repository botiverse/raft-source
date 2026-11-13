#!/usr/bin/env -S node --import=@oxc-node/core/register
/**
 * slockdev — TypeScript rewrite (task #15, +task #12 cf-tunnel default).
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
 *   - ensure_rustfs_bucket reuses bash's @aws-sdk/client-s3
 *     Head/Create approach (60× retry) to keep behavior byte-equivalent
 *     rather than risk SDK-version drift. The script lives as a real
 *     file at packages/server/ensure-rustfs-bucket.ts (invoked as
 *     `pnpm exec node --import @oxc-node/core/register ensure-rustfs-bucket.ts` with cwd=packages/server) so
 *     that Windows + shell:true does not corrupt a multi-line --eval
 *     payload (Node DEP0190 — args are concatenated, not escaped).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { homedir, hostname, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReaderStartedAtMs, runTraceCli, traceBannerLines } from "./raftdev-trace";
import {
  prepareDevEnvDir,
  recordDevEnvProcesses,
  removeDevEnvDir,
  resolveDevCachePaths,
  resolveDevEnvDir,
  runCacheCli,
  type DevEnvDir,
} from "./raftdev-cache";
import { POST_MIGRATION_INDEXES } from "../../packages/server/src/db/postMigrationIndexes";
import {
  PREVIEW_CLEANER_PATH,
  PREVIEW_DOCKER_MEMORY_CAPS,
  PREVIEW_IDLE_TTL_SECONDS,
  PREVIEW_INVALID_DBUS_ADDRESS,
  cancelPreviewReminder,
  descendantPids,
  dockerInspectState,
  formatCleanupLeftovers,
  formatDuration,
  isInUnitCgroup,
  isRecordedProcessAlive,
  isoSeconds,
  janitorDecision,
  liveStarttime,
  listPreviewRecords,
  parseCleanerStopOutput,
  parseContainerInspect,
  parsePreviewUnitSpec,
  previewAdoptionRefusal,
  previewSeedRefusal,
  previewDockerEndpointRefusal,
  shouldStartDaemonWindow,
  parsePreviewStartArgs,
  parsePreviewState,
  previewCleanerEnvFile,
  previewLoginLines,
  previewSeedPasswordEnv,
  previewOwner,
  previewRecordPath,
  previewDroppedResources,
  previewIdentityChanges,
  previewRecordProblems,
  previewRegistryDir,
  previewStopUnitArgs,
  previewSystemdRunArgs,
  previewTmuxSocket,
  previewUnitEnv,
  previewUnitName,
  processesOutsideUnit,
  provisionalPreviewRecord,
  runningPreviewRecord,
  readProcStat,
  schedulePreviewReminder,
  seedAccountsFromSeedFile,
  selectPreviewRecord,
  summarizePreviewRecord,
  tmuxSessionFromArgs,
  verifyPreviewCleanup,
  webAutoLoginEnv,
  withDockerMemoryCap,
  withPreviewContainer,
  withPreviewProcesses,
  withPreviewVolume,
  type CommandRunner,
  type ContainerInspection,
  type PreviewProcess,
  type PreviewRecord,
  type PreviewStartArgs,
  type PreviewUnitSpec,
  type PreviewState,
} from "./raftdev-preview";

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
  RISINGWAVE_DSN_FILE: string; RISINGWAVE_STATE_FILE: string; TUNNEL_STATE_FILE: string;
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

/**
 * Parse the RAFTDEV_RISINGWAVE / --risingwave[=...] / --no-risingwave switch.
 * `null` means unset (the default profile applies); `"off"` is the explicit
 * opt-out (`0` / `--no-risingwave`).
 */
export function parseRisingWaveLocalProfile(
  raw: string | undefined,
): RisingWaveLocalProfile | "off" | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  if (value === "0") return "off";
  if (value === "1" || value === "full") return "full";
  if (value === "process-only") return "process-only";
  throw new Error(
    `RAFTDEV_RISINGWAVE must be 0, 1, full, or process-only, got: ${JSON.stringify(raw)}`,
  );
}

export function risingWaveNeedsBootstrap(config: RisingWaveDependencyConfig): boolean {
  return config.mode === "local" && config.profile === "full";
}

/** Server surfaces that answer 503 when no RisingWave is configured. */
export const RISINGWAVE_DISABLED_WARNING = [
  "WARNING: RisingWave is disabled (--no-risingwave / RAFTDEV_RISINGWAVE=0).",
  "  The Activity endpoints (inbox, followed threads, unread summary, channel unread)",
  "  will return 503. Restart without --no-risingwave to use the product's main pages.",
] as const;

/**
 * Resolve the RisingWave dependency without touching Docker.
 *
 * A managed local full instance (standalone + CDC + serving MVs) is the
 * default, because the product's main pages read from it. `--no-risingwave`
 * (RAFTDEV_RISINGWAVE=0) is the backend-only opt-out; `--risingwave` /
 * `=full` restate the default and `=process-only` selects the pgwire smoke.
 * Supplying RISINGWAVE_DATABASE_URL without an explicit local profile selects
 * an already-managed external instance instead of the default container.
 * Refuse an explicit local profile plus an external URL so a developer never
 * thinks they are testing local RisingWave while the server points elsewhere.
 */
export function resolveRisingWaveDependency(
  localRaw: string | undefined,
  externalDatabaseUrl: string | undefined,
  localDatabaseUrl: string,
  imageRaw: string | undefined,
): RisingWaveDependencyConfig {
  const selection = parseRisingWaveLocalProfile(localRaw);
  const external = externalDatabaseUrl?.trim() ?? "";
  if (selection !== null && selection !== "off" && external !== "") {
    throw new Error(
      "a local --risingwave/RAFTDEV_RISINGWAVE profile cannot be combined with RISINGWAVE_DATABASE_URL; unset one source",
    );
  }
  if (external !== "") return { mode: "external", databaseUrl: external };
  const profile = selection ?? "full";
  if (profile === "off") return { mode: "disabled" };
  return {
    mode: "local",
    profile,
    databaseUrl: localDatabaseUrl,
    image: imageRaw?.trim() || DEFAULT_RISINGWAVE_IMAGE,
  };
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
// A dev RisingWave holds a few hundred rows but runs the whole inbox MV chain
// (51 objects) continuously. Without a cap it sizes its own memory from the
// whole host (it saw ~62 GiB on a shared 16 GiB-limited machine) and held 5.5
// GiB plus 2.3 GiB of swap (IT, 2026-10-23). It gets a budget (2 GiB unless
// RAFTDEV_RW_MEMORY_BYTES says otherwise) and a Docker limit 1 GiB above it,
// with no extra swap.
//
// single_node gives the compactor 1/8 of the budget, and below ~8 GiB that is
// under the compactor's own floor: it fails `compactor_memory_limit_bytes >
// min_compactor_memory_limit_bytes * 2` and RisingWave exits (139) before
// pgwire is up (#10967, reverted in #10974). A config file sets the
// compactor's limit outright (768 MB; it takes 80% of that), so a small
// budget starts.
export const DEFAULT_RISINGWAVE_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const RISINGWAVE_DOCKER_HEADROOM_BYTES = 1024 * 1024 * 1024;
export const RISINGWAVE_CONFIG_IN_CONTAINER = "/raftdev/risingwave.toml";
export const RISINGWAVE_CONFIG = "[storage]\ncompactor_memory_limit_mb = 768\n";

/**
 * RAFTDEV_RW_MEMORY_BYTES, or the 2 GiB default. The default is also the
 * floor: 2 GiB is the smallest budget seen to start and pass the realRw suite
 * (IT, CCX23, 2026-10-23); nothing smaller has been tried.
 */
export function parseRisingWaveMemoryBytes(raw: string | undefined): number {
  if (!raw || raw.trim() === "") return DEFAULT_RISINGWAVE_MEMORY_BYTES;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < DEFAULT_RISINGWAVE_MEMORY_BYTES) {
    out(`ERROR: RAFTDEV_RW_MEMORY_BYTES must be a whole number of bytes, at least ${DEFAULT_RISINGWAVE_MEMORY_BYTES}; got: ${raw}`);
    process.exit(1);
  }
  return value;
}

/**
 * Who started a raftdev container: the checkout's directory, hashed. The
 * orphan sweep only ever touches containers carrying its own owner, since
 * agents share machines and tmux only sees its own user's (and socket's)
 * sessions.
 */
export const RAFTDEV_OWNER_LABEL = "com.botiverse.raftdev.owner";
export function raftdevOwner(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
}

export function risingWaveDockerRunArgs(
  e: RisingWaveDockerEnv,
  image: string = DEFAULT_RISINGWAVE_IMAGE,
  network?: string,
  opts: { owner?: string; memoryBytes?: number; configFile?: string } = {},
): string[] {
  const memoryBytes = opts.memoryBytes ?? DEFAULT_RISINGWAVE_MEMORY_BYTES;
  const dockerLimit = String(memoryBytes + RISINGWAVE_DOCKER_HEADROOM_BYTES);
  return [
    "run", "-d", "--pull=always", "--name", e.RISINGWAVE_CONTAINER,
    "--label", RAFTDEV_MANAGED_LABEL_ARG,
    ...(opts.owner ? ["--label", `${RAFTDEV_OWNER_LABEL}=${opts.owner}`] : []),
    ...(network ? ["--network", network] : []),
    "-p", `127.0.0.1:${e.RISINGWAVE_PORT}:4566`,
    "-p", `127.0.0.1:${e.RISINGWAVE_DASHBOARD_PORT}:5691`,
    "--memory", dockerLimit,
    "--memory-swap", dockerLimit,
    ...(opts.configFile ? ["-v", `${opts.configFile}:${RISINGWAVE_CONFIG_IN_CONTAINER}:ro`] : []),
    image,
    "single_node",
    // single_node has no environment variable for this (`single_node --help`).
    "--total-memory-bytes", String(memoryBytes),
    ...(opts.configFile ? ["--config-path", RISINGWAVE_CONFIG_IN_CONTAINER] : []),
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
    TUNNEL_STATE_FILE: join(SLOCKDEV_DIR, "tunnel.json"),
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

/**
 * The environment's services' TMPDIR on disk (`<cache root>/env/<env-key>/tmp`,
 * scripts/dev/raftdev-cache.ts), set by `start` once the dir exists; null when
 * the caller's TMPDIR is kept (explicit, CI, non-Linux, no on-disk root).
 */
let serviceEnvDir: DevEnvDir | null = null;

// Wraps a command so tmux window prints its exit status then drops into a
// login shell — identical contract to bash slockdev's run_tmux_shell_command.
// New tmux windows don't inherit this process's env (the tmux server may be
// older); carry the on-disk compile cache (applyDevCacheEnv) and the
// environment's TMPDIR into them explicitly.
export function tmuxShellCommand(
  cmd: string,
  carry: { NODE_COMPILE_CACHE?: string; TMPDIR?: string },
  shell: string,
): string {
  let exports = "";
  for (const name of ["NODE_COMPILE_CACHE", "TMPDIR"] as const) {
    const value = carry[name];
    if (value) exports += `export ${envAssign(name, value)}; `;
  }
  const wrapped =
    `${exports}${cmd}; status=$?; echo; echo "[raftdev] command exited with status $status"; ` +
    `exec "${shell}" -l`;
  return `bash -lc ${shellQuote(wrapped)}`;
}

export function runTmuxShellCommand(cmd: string): string {
  return tmuxShellCommand(cmd, {
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
    TMPDIR: serviceEnvDir?.tmpdir ?? undefined,
  }, process.env.SHELL || "/bin/zsh");
}

/** The environment's unique id: its state dir (`<project>/.slockdev/<name>`). */
function devEnvId(e: Pick<Env, "SLOCKDEV_DIR">): string {
  return e.SLOCKDEV_DIR;
}

/**
 * `start`: creates the environment's on-disk temp dir; the tmux windows
 * (runTmuxShellCommand) and cloudflared (serviceSpawnEnv) get it as TMPDIR.
 * process.env is left alone: `tmux new-session` may start the user's tmux
 * server with it, and every later window on that server (the user's own
 * shells included) would inherit this environment's dir. Keeps the caller's
 * TMPDIR when it is explicit or nothing applies.
 */
export function prepareServiceTmpdir(
  e: Pick<Env, "SLOCKDEV_DIR">,
  input: { env?: NodeJS.ProcessEnv; maxTmpdirBytes?: number; warn?: (msg: string) => void } = {},
): DevEnvDir | null {
  const warn = input.warn ?? out;
  const resolved = resolveDevEnvDir(devEnvId(e), { env: input.env, maxTmpdirBytes: input.maxTmpdirBytes });
  // The cache-root warnings were printed by applyDevCacheEnv.
  for (const w of resolved.warnings) if (w.includes("environment TMPDIR")) warn(w);
  serviceEnvDir = prepareDevEnvDir(resolved, { warn, starttimeOf: procStarttime }) ? resolved : null;
  return serviceEnvDir;
}

/** The env for a service raftdev spawns itself (cloudflared): `base` plus the environment's TMPDIR. */
export function serviceSpawnEnv(base: NodeJS.ProcessEnv, envDir: DevEnvDir | null): NodeJS.ProcessEnv {
  return envDir?.tmpdir ? { ...base, TMPDIR: envDir.tmpdir } : base;
}

/**
 * `stop` / `nuke`: removes the environment's temp dir once its processes are
 * confirmed gone (raftdev-cache.ts removeDevEnvDir); otherwise leaves it.
 */
function removeServiceTmpdir(e: Env): void {
  // Wherever start put it, whatever TMPDIR this stop runs with.
  const env = { ...process.env };
  delete env.TMPDIR;
  const resolved = resolveDevEnvDir(devEnvId(e), { env });
  if (!resolved.dir) return;
  const attempt = () => removeDevEnvDir(resolved.dir as string, {
    envId: devEnvId(e),
    hostname: hostname(),
    bootId: currentBootId() || null,
    starttimeOf: procStarttime,
    selfPid: process.pid,
    sessionAlive: () => tmuxHasSession(e.TMUX_SESSION),
  });
  let result = attempt();
  // Services may take a few seconds to exit after the session is killed.
  for (let i = 0; i < 5 && result.liveProcesses; i++) {
    spawnSync("sleep", ["1"]);
    result = attempt();
  }
  if (result.removed) out(`Removed temp dir ${resolved.dir}`);
  else if (result.reason !== "absent") out(`Temp dir ${resolved.dir} preserved: ${result.reason}.`);
}

/** cloudflared's log: in the environment's dir when it has one, else the caller's temp dir. */
export function cloudflaredLogPath(name: string, envDir: string | null, tmp: string = tmpdir()): string {
  return envDir ? join(envDir, "cloudflared.log") : join(tmp, `slockdev-cf-${name}.log`);
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

/**
 * The web window: pre-bundle Vite's dependencies in a short-lived `vite
 * optimize` process, then start the dev server, both with the same env.
 * On a cold cache (a fresh worktree, or a lockfile/config change) the dev
 * server would otherwise run the dependency bundle itself, and Rolldown's
 * native allocator keeps that memory (~0.9 GB) for the life of the server.
 * The dev server reuses the cache this process writes (same config hash), so
 * it never bundles at startup; with a warm cache `vite optimize` only checks
 * the metadata and exits. A failure is not fatal: the dev server then
 * pre-bundles in-process as before. `vite optimize` is deprecated in Vite 8
 * but still supported.
 */
export function webWindowCommand(envPrefix: string): string {
  // pnpm exits 1 on Ctrl-C, so a trap tells an interrupt from a failure: an
  // interrupted optimize stops the window (status 130) instead of starting the
  // dev server, as a Ctrl-C of the dev server itself would.
  return `optimize_interrupted=; trap 'optimize_interrupted=1' INT; ` +
    `${envPrefix}pnpm --filter @botiverse/raft-web exec vite optimize; optimize_status=$?; trap - INT; ` +
    `if [ -n "$optimize_interrupted" ]; then (exit 130); else ` +
    `[ "$optimize_status" -eq 0 ] || echo "[raftdev] vite optimize failed; the dev server will pre-bundle dependencies itself"; ` +
    `${envPrefix}pnpm --filter @botiverse/raft-web dev; fi`;
}

export type SeedCommandOptions = {
  name: string;
  withOnboarding: boolean;
  withAgentRuns: boolean;
};

export function parseSeedCommandArgs(args: string[], defaultName: string): SeedCommandOptions {
  let name = defaultName;
  let nameSet = false;
  let withOnboarding = false;
  let withAgentRuns = false;

  for (const arg of args) {
    if (arg === "--with-onboarding") {
      withOnboarding = true;
    } else if (arg === "--with-agent-runs") {
      withAgentRuns = true;
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
  return { name, withOnboarding, withAgentRuns };
}

// TypeScript scripts run on Node with the oxc-node loader. `pnpm exec` keeps
// the package-manager spawn seam (Windows .cmd shim, fake-bin tests).
export function tsScriptArgs(script: string, args: string[] = []): string[] {
  return ["exec", "node", "--import", "@oxc-node/core/register", script, ...args];
}

export function buildDevSeedArgs(outputPath: string, withOnboarding: boolean, withAgentRuns = false): string[] {
  return tsScriptArgs("scripts/seed.ts", [
    "--output",
    outputPath,
    ...(withOnboarding ? ["--with-onboarding"] : []),
    ...(withAgentRuns ? ["--with-agent-runs"] : []),
  ]);
}

/**
 * Steps of packages/server `db:migrate:deploy` that raftdev does not run, and
 * why. Everything else in that script (the migrator, the CONCURRENTLY index
 * builds and the post-migration index check) runs locally in the same order.
 */
export const DEV_SKIPPED_DEPLOY_STEPS: Readonly<Record<string, string>> = {
  // Admission check for the operator migration DSN: refuses unless its
  // statement_timeout equals SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS.
  "scripts/migration-preflight.ts": "checks the production migrator DSN's statement_timeout",
  // Both reconcile grants for operator roles that exist only in staging and
  // production; without FEATURE_FLAG_ADMIN_PRIVILEGE_GUARD_REQUIRED=1 (set only
  // by those deploys) they skip on a local database anyway.
  "scripts/verify-feature-flag-admin-privileges.ts": "grants for a production-only operator role",
  "scripts/verify-app-admin-privileges.ts": "grants for a production-only operator role",
};

const SCRIPT_STEP_PATTERN = /^node --import @oxc-node\/core\/register (scripts\/[\w.-]+\.ts)$/;
const VERIFY_POST_MIGRATION_INDEXES = "scripts/verify-post-migration-indexes.ts";

function scriptStepPath(command: string, what: string): string {
  const match = SCRIPT_STEP_PATTERN.exec(command.trim());
  if (!match) throw new Error(`unexpected ${what}: ${command.trim()}`);
  return match[1];
}

/**
 * The scripts raftdev runs to build its database, in order: the steps of the
 * `db:migrate:deploy` package script minus DEV_SKIPPED_DEPLOY_STEPS, plus the
 * create script of every post-migration index (`indexCreateScripts`, package
 * script names from POST_MIGRATION_INDEXES) that the deploy does not run, just
 * before the index check. Production and staging ran those once by hand
 * (postMigrationIndexes.ts); a local database gets them every time, so it has
 * production's whole index set and the check can fail instead of warning.
 * Throws when a step is not a plain `node --import ... scripts/<x>.ts` call,
 * or when a skipped step is no longer in the deploy, so a change is noticed.
 */
export function devMigrationSteps(packageScripts: Readonly<Record<string, string>>, indexCreateScripts: readonly string[]): string[] {
  const deploy = (packageScripts["db:migrate:deploy"] ?? "").split("&&")
    .map((step) => scriptStepPath(step, "db:migrate:deploy step"));
  for (const skipped of Object.keys(DEV_SKIPPED_DEPLOY_STEPS)) {
    if (!deploy.includes(skipped)) throw new Error(`db:migrate:deploy no longer runs ${skipped}`);
  }
  const steps = deploy.filter((script) => !(script in DEV_SKIPPED_DEPLOY_STEPS));
  const verifyAt = steps.indexOf(VERIFY_POST_MIGRATION_INDEXES);
  if (verifyAt === -1) throw new Error(`db:migrate:deploy no longer runs ${VERIFY_POST_MIGRATION_INDEXES}`);
  const extra: string[] = [];
  for (const name of indexCreateScripts) {
    const command = packageScripts[name];
    if (command === undefined) throw new Error(`post-migration index create script ${name} is not a package script`);
    const script = scriptStepPath(command, `${name} command`);
    if (!steps.includes(script) && !extra.includes(script)) extra.push(script);
  }
  return [...steps.slice(0, verifyAt), ...extra, ...steps.slice(verifyAt)];
}

export type DevDatabaseSchemaState = "empty" | "migrated" | "push-built";

/** The deploy phase-contract fields packages/server/scripts/migrate-deploy.ts
 *  reads (its `phaseContractFields`); it refuses any of them non-blank while
 *  the contract is off. */
export const DEV_MIGRATION_PHASE_FIELDS = [
  "SERVER_MIGRATION_PHASE_BOUNDARY_TAGS",
  "SERVER_MIGRATION_REQUIRED_PHASE_BOUNDARY_TAGS",
  "SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS",
  "SERVER_MIGRATION_LOCK_SCHEMA",
  "SERVER_MIGRATION_LOCK_RELATIONS",
  "SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE",
  "SERVER_MIGRATION_ADVISORY_LOCK_KEY",
] as const;

/** Retry-budget overrides packages/server/src/db/migrateDeploy.ts reads; a
 *  blank value selects its built-in default. */
export const DEV_MIGRATION_RETRY_FIELDS = [
  "SERVER_MIGRATION_RETRY_MAX_ATTEMPTS",
  "SERVER_MIGRATION_RETRY_BASE_DELAY_MS",
] as const;

/** The environment of a dev migration step: the developer's shell and `.env`
 *  must not change how the local database is migrated. The child scripts load
 *  packages/server/.env with `import "dotenv/config"`, which fills only
 *  variables that are unset, so deleting a variable is not enough: every value
 *  is set explicitly. MIGRATIONS_FOLDER is the repo's drizzle folder (the
 *  migrator uses `??`, so a blank value would count as set), the phase
 *  contract is pinned off and its fields blank (the migrator checks
 *  `?.trim()`), and the retry overrides blank (built-in defaults). */
export function devMigrationEnv(base: NodeJS.ProcessEnv, databaseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    DATABASE_URL: databaseUrl,
    MIGRATIONS_FOLDER: join(PROJECT_DIR, "packages/server/drizzle"),
    SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED: "false",
    // The post-migration index check fails instead of warning: every index
    // it lists is built by the steps before it (devMigrationSteps).
    POST_MIGRATION_INDEX_GUARD_REQUIRED: "1",
  };
  for (const name of [...DEV_MIGRATION_PHASE_FIELDS, ...DEV_MIGRATION_RETRY_FIELDS]) env[name] = "";
  return env;
}

/**
 * What a local Postgres holds before raftdev migrates it. `appliedMigrations`
 * is the row count of drizzle.__drizzle_migrations, or null when that table
 * does not exist. Tables without migration history mean the database was
 * built by `drizzle-kit push` (raftdev before it ran migrations): the migrator
 * would replay every migration against existing tables and fail.
 */
export function classifyDevDatabaseSchema(publicTables: number, appliedMigrations: number | null): DevDatabaseSchemaState {
  if ((appliedMigrations ?? 0) > 0) return "migrated";
  return publicTables > 0 ? "push-built" : "empty";
}

function sh(
  cmd: string,
  args: string[],
  opts: { quiet?: boolean; input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): ShResult {
  if (cmd === "tmux") args = [...previewTmuxSocketArgs(args), ...args];
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    cwd: opts.cwd,
    // `input` needs a piped stdin; "ignore" would drop it silently (the
    // preview record reaches raft-preview-cleaner register this way).
    stdio: [opts.input !== undefined ? "pipe" : opts.quiet ? "ignore" : "inherit", "pipe", "pipe"],
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

// External programs each raftdev command shells out to. They are checked
// once, before the command touches Docker or tmux, so a missing tool fails up
// front with every gap and its install hint listed together. lsof matters most:
// without it portInUse cannot tell a free port from an unknown one.
export type ToolingCommand = "start" | "stop" | "status" | "nuke" | "janitor";
const COMMAND_TOOLING: Record<ToolingCommand, readonly string[]> = {
  start: ["docker", "tmux", "lsof", "bash"],
  stop: ["docker", "tmux"],
  status: ["docker", "tmux", "lsof"],
  nuke: ["docker", "tmux"],
  janitor: ["docker", "tmux"],
};
const TOOL_INSTALL_HINTS: Record<string, string> = {
  docker: "Docker Engine or Docker Desktop (https://docs.docker.com/get-docker/); your user must be able to run `docker ps`",
  tmux: "macOS: brew install tmux; Debian/Ubuntu: sudo apt-get install tmux; Fedora: sudo dnf install tmux",
  lsof: "macOS: preinstalled; Debian/Ubuntu: sudo apt-get install lsof; Fedora: sudo dnf install lsof",
  bash: "install bash and make sure `bash -lc true` succeeds",
};

export function missingTooling(command: ToolingCommand): { tool: string; hint: string }[] {
  const missing: { tool: string; hint: string }[] = [];
  for (const tool of COMMAND_TOOLING[command]) {
    if (!commandExists(tool)) missing.push({ tool, hint: TOOL_INSTALL_HINTS[tool] });
  }
  const has = (tool: string) => COMMAND_TOOLING[command].includes(tool) && !missing.some((m) => m.tool === tool);
  if (has("bash") && !commandRuns("bash", ["-lc", "true"])) {
    missing.push({ tool: "usable bash", hint: TOOL_INSTALL_HINTS.bash });
  }
  return missing;
}

export function validateTooling(command: ToolingCommand): void {
  const missing = missingTooling(command);
  if (missing.length === 0) return;

  out(`ERROR: raftdev ${command} requires POSIX dev tools that are not available:`);
  for (const { tool, hint } of missing) out(`  - ${tool}: ${hint}`);
  if (process.platform === "win32") {
    out("");
    out("Native Windows is not fully supported by this tmux-based raftdev launcher yet.");
    out("Use WSL with bash, tmux, lsof, Docker access, and this repo mounted inside WSL; or install equivalent POSIX tools on PATH.");
  }
  out("");
  out(command === "start"
    ? "No containers or local processes were started."
    : "Nothing was changed.");
  process.exit(1);
}

// Only start creates containers, so only start needs a daemon that answers;
// it runs this after the read-only stale-session report and before the first
// port check or container. The other commands report what Docker tells them.
function validateDockerDaemon(): void {
  const info = sh("docker", ["info", "--format", "{{.ServerVersion}}"], { quiet: true });
  if (info.code === 0) return;
  const reason = info.stderr.trim().split("\n").find(Boolean) ?? `exit ${info.code}`;
  out("ERROR: raftdev start needs a reachable Docker daemon; `docker info` failed:");
  out(`  ${reason}`);
  out(`  ${TOOL_INSTALL_HINTS.docker}`);
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
/**
 * Kill a tmux session; one that is already gone counts as killed. The C-c sent
 * before the kill can end its last window, and with it the session, so
 * kill-session finds nothing and fails (IT, 2026-10-23: the first `raftdev
 * stop` returned 1 that way). Any other failure still fails.
 */
function killTmuxSession(session: string): boolean {
  return sh("tmux", ["kill-session", "-t", session], { quiet: true }).code === 0 ||
    !tmuxHasSession(session);
}

/**
 * The raftdev RisingWave containers whose environment is no longer running
 * (no `slock-<name>` tmux session): an environment that died or was stopped
 * part-way leaves its RisingWave running the whole MV chain with nothing
 * reading it. Only containers this checkout started (`owner`) are
 * considered, never another agent's or user's: their tmux sessions are not
 * visible from here, and a container without an owner is skipped. They
 * must also be named `slock-dev-<name>-risingwave` and have run for
 * `graceMs`, since an environment that is starting creates its RisingWave
 * before its tmux session.
 */
export const ORPHAN_RISINGWAVE_GRACE_MS = 30 * 60 * 1000;
export function orphanRisingWaveContainers(
  containers: readonly { name: string; startedAt: number; owner?: string }[],
  owner: string,
  hasSession: (session: string) => boolean,
  now: number,
  graceMs: number = ORPHAN_RISINGWAVE_GRACE_MS,
): string[] {
  return containers
    .filter((container) => {
      const env = /^slock-dev-(.+)-risingwave$/.exec(container.name)?.[1];
      return env !== undefined && container.owner === owner &&
        now - container.startedAt >= graceMs && !hasSession(`slock-${env}`);
    })
    .map(({ name }) => name);
}

/** Stop the raftdev RisingWave containers left by environments that are gone (orphanRisingWaveContainers). */
export function sweepOrphanRisingWave(graceMs: number = ORPHAN_RISINGWAVE_GRACE_MS): void {
  const owner = raftdevOwner(PROJECT_DIR);
  // Only this checkout's containers: docker filters on both labels.
  const listed = sh("docker", [
    "ps", "--filter", `label=${RAFTDEV_MANAGED_LABEL}=true`, "--filter", `label=${RAFTDEV_OWNER_LABEL}=${owner}`,
    "--format", "{{.Names}}",
  ], { quiet: true });
  if (listed.code !== 0) return;
  const containers = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((name) => {
    const started = sh("docker", ["inspect", "--format", "{{.State.StartedAt}}", name], { quiet: true }).stdout.trim();
    const startedAt = Date.parse(started);
    // Unknown start time: treat as just started, never as old.
    const labelled = sh("docker", [
      "inspect", "--format", `{{ index .Config.Labels ${JSON.stringify(RAFTDEV_OWNER_LABEL)} }}`, name,
    ], { quiet: true }).stdout.trim();
    return { name, startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(), owner: labelled || undefined };
  });
  for (const container of orphanRisingWaveContainers(containers, owner, tmuxHasSession, Date.now(), graceMs)) {
    const removed = sh("docker", ["rm", "-fv", container], { quiet: true }).code === 0;
    out(removed
      ? `[raftdev] removed '${container}': its environment is no longer running.`
      : `[raftdev] WARN: could not remove orphaned '${container}'.`);
  }
}

// Actual window names in a session. Used by stop/nuke so cluster-mode replica
// windows (server-2 … server-N) — whose count isn't known at stop time — all
// get a C-c before the session is killed, just like the fixed windows.
function tmuxWindowNames(session: string): string[] {
  return sh("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"], { quiet: true })
    .stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function portInUse(port: number): boolean {
  const [cmd, args] = process.platform === "win32"
    ? ["cmd.exe", ["/c", "lsof.cmd", "-iTCP:" + String(port), "-sTCP:LISTEN", "-P", "-n"]] as const
    : ["lsof", ["-iTCP:" + String(port), "-sTCP:LISTEN", "-P", "-n"]] as const;
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // lsof exits 1 both for "no listener" and, through spawnSync, for "could not
  // run". Never read the second as a free port. On Windows cmd.exe itself
  // starts and reports a missing lsof.cmd as "not recognized".
  if (r.error || (process.platform === "win32" && /not recognized/i.test(r.stderr ?? ""))) {
    out(`ERROR: Could not run lsof to check port ${port}: ${r.error?.message ?? (r.stderr ?? "").trim()}`);
    out(`  Install it: ${TOOL_INSTALL_HINTS.lsof}`);
    process.exit(1);
  }
  return r.status === 0 && (r.stdout ?? "").trim() !== "";
}
// tmux keeps a login shell after a command exits, and Node --watch may keep
// its parent alive after the server child exits. Check sockets, not those PIDs.
// This is listener evidence only, not an HTTP/application health assertion.
function applicationListeners(e: Env): { name: string; port: number; listening: boolean }[] {
  const replicas = new Set([1]);
  for (const window of tmuxWindowNames(e.TMUX_SESSION)) {
    const match = window.match(/^server-([2-9]|[1-9][0-9]+)$/);
    if (match && Number(match[1]) <= MAX_REPLICAS) replicas.add(Number(match[1]));
  }
  return [
    ...[...replicas].sort((a, b) => a - b).map((k) => ({
      name: replicaWindowName(k), port: replicaServerPort(e.OFFSET, k),
    })),
    { name: "web", port: e.WEB_PORT },
  ].map((entry) => ({ ...entry, listening: portInUse(entry.port) }));
}

function printApplicationListeners(listeners: ReturnType<typeof applicationListeners>): void {
  for (const { name, port, listening } of listeners) {
    out(`  Listener   : ${name} :${port} (${listening ? "listening" : "no listener detected"})`);
  }
  out("  Listener checks do not verify HTTP health; a missing listener may still be starting.");
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
  // Script lives at packages/server/ensure-rustfs-bucket.ts so that Node's
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
    const r = spawnSync(packageManagerCommand("pnpm"), ["exec", "node", "--import", "@oxc-node/core/register", "ensure-rustfs-bucket.ts"], {
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
  start [name] [--description <text>] [--replicas N] [--no-risingwave | --risingwave=process-only] [--with-onboarding] [--with-agent-runs]
                  Start an isolated dev environment
  stop [name]     Stop and clean up an environment
  status          Show environment resources and application listeners
  seed [name] [--with-onboarding] [--with-agent-runs]
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
  preview <name> [--for <duration>] [--with-agent-runs] [--profile frontend|local-stack]
          [--memory-max <size>] [--notify <conversation[:message-id]>] [start options]
                  Start a reviewer preview: systemd user unit, public tunnel,
                  hard deadline (default 2h, max 8h), registry record
  preview stop <name|id>
                  Verified stop of a preview (IT's raft-preview-cleaner)
  preview list [--json]
                  List recorded previews: owner, branch, URL, deadline, liveness
  cache status    Where dev caches and test temp files go, and which are on tmpfs
  cache prune     Remove leftover test temp dirs (>24h, owner gone), then pnpm store prune

Name defaults to the directory basename (e.g., "slock").
Different names get different ports, so multiple environments can coexist.

Runtime status:
  status checks application TCP listeners, not HTTP health. A retained tmux
  session does not prove the server is alive. start with an existing session
  exits 1 without restarting it; inspect logs, stop, then repeat start/options.

Optional:
  --description <text> on start labels what this preview environment is for.
  It is shown in the web Dev tools panel. SLOCKDEV_PREVIEW_DESCRIPTION can
  also provide the same value.
  --with-onboarding on start or seed preserves the real fresh-owner account
  and server onboarding gates. The default seed writes canonical completed /
  grandfathered state so routine product validation opens on the app surface.
  --with-agent-runs on start or seed lets the seeded agents on the dev machine
  run (assistant inactive, codex-reviewer active). By default the seed only
  builds data: those agents are stopped, so no seeded message, mention or
  reminder starts a model until you start one yourself.
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
  RisingWave: start runs a managed RisingWave standalone plus Postgres CDC and
  the serving materialized-view graph by default (the product's main pages
  read from it), gates seeded PG/RW parity, then injects
  RISINGWAVE_DATABASE_URL into the server. Local standalone data is ephemeral
  and removed by raftdev stop.
  --no-risingwave (or RAFTDEV_RISINGWAVE=0) skips it for a faster
  backend-only start; the Activity endpoints (inbox, followed threads, unread
  summary, channel unread) then return 503.
  --risingwave=process-only starts only the RisingWave process (pgwire/pool/
  fallback wiring smoke, no CDC/MVs). --risingwave and --risingwave=full are
  accepted and mean the default. RAFTDEV_RISINGWAVE=0|1|full|process-only
  provides the same choices, and RAFTDEV_RISINGWAVE_IMAGE can override the
  pinned v2.8.0 image. To use an already-managed instance, set
  RISINGWAVE_DATABASE_URL (with no local profile flag); credentials are never
  printed. A managed/full environment refuses a live \`raftdev seed\`; start
  with --no-risingwave if you need repeated reseeds.
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
  available. \`./raftdev stop\` ends that tunnel by its recorded pid and
  start time (.slockdev/<name>/tunnel.json).

Previews (Linux, systemd user session, cloudflared, IT's
/usr/local/libexec/raft-preview-cleaner; see docs/development/README.md):
  preview runs \`start\` inside the user unit raft-preview-<id>.service
  (MemoryMax from --profile: frontend=2G, local-stack=4G (default), or
  --memory-max; MemorySwapMax=0; RuntimeMaxSec = the deadline;
  KillMode=control-group), with its own tmux socket and no session bus, so
  every process stays in the unit. The tunnel is forced on; the URL is
  printed only after each recorded process is checked to be in the unit.
  --for takes 90m, 2h, 1h30m (default 2h, max 8h). The 1h idle stop also
  applies; whichever comes first stops it, and the janitor enforces both.
  Docker services get their own --memory caps (postgres 1g, redis 256m,
  rustfs 512m, otelcol 256m; RisingWave keeps its cap).
  The record (no credentials; a new UUID per launch, never reused) is
  written only by raft-preview-cleaner register, to
  \${XDG_STATE_HOME:-~/.local/state}/raft/previews/<id>.json. To move the
  registry, put one line RAFT_PREVIEW_REGISTRY=/absolute/path in
  ~/.config/raft/preview-cleaner.env: the cleanup timer reads only that file;
  RAFT_PREVIEW_REGISTRY in your shell alone does not reach it.
  --notify "#channel:<message-id>" or "dm:@name:<message-id>" schedules your
  own Raft reminder at deadline + 10 minutes (\`raft reminder schedule\`),
  recorded as notify + reminderId and cancelled by a verified \`preview stop\`.
  A failed schedule only warns.
  A preview never reuses resources: it refuses to start while any container
  of the name (pg, redis, rustfs, otelcol, risingwave) or its RustFS volume
  exists, or when Docker cannot answer; stop them or pick a new name.
  The unit gets an allowlist of the environment (PATH, HOME, locale, Docker,
  Node/pnpm, RAFTDEV_*/SLOCKDEV_*/VITE_*), never tokens, secrets, RAFT_* or
  CLAUDE_*; only --with-agent-runs adds the daemon's model variables
  (ANTHROPIC_*, OPENAI_*, KIMI_API_KEY, CODEX_HOME, ...).
  Without --with-agent-runs it prints the passwordless link (the auto-login
  account's role) and the seed accounts, and starts NO daemon window: no
  agent runs behind a passwordless URL. With --with-agent-runs it prints no
  passwordless link, forces VITE_SLOCKDEV_SKIP_AUTO_LOGIN=1 and seeds a
  random password (not password123): only that password signs in. It appears
  in the owner-only unit log the launcher prints and in the owner-only seed
  file. \`raftdev seed\` refuses a preview: previews are seeded only at
  launch. Post links only in the requester's thread.
  preview stop <name|id> runs \`raft-preview-cleaner stop <id>\`: unit,
  processes (pid + starttime + boot), containers and volumes are verified gone
  before the record is removed; otherwise it reports the residue and exits 1.`);
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
      : "reserved; not running (started with --no-risingwave, or not started)";
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
    const listeners = hasSession ? applicationListeners(e) : [];
    if (hasSession && readyServiceCount === 3 && listeners.every((entry) => entry.listening)) {
      const redisState = externalRedisListening ? "; Redis external" : "";
      out(`  Runtime    : running (tmux session + required services ready; application ports listening${redisState})`);
    } else if (hasSession || dockerResidueCount > 0) {
      const sessionState = hasSession ? "tmux session present" : "no tmux session";
      out(`  Runtime    : partial/orphan (${sessionState}; ${readyServiceCount}/3 required services ready; ${dockerResidueCount} Docker residue(s))`);
      out(`  Recovery   : ./raftdev stop ${en}`);
    } else {
      out("  Runtime    : stopped (state only; no tmux session or Docker resources)");
    }
    if (hasSession) printApplicationListeners(listeners);
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
  const attachArgs = ["attach", "-t", e.TMUX_SESSION];
  const r = spawnSync("tmux", [...previewTmuxSocketArgs(attachArgs), ...attachArgs], { stdio: "inherit" });
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
    out("  Example: ./raftdev script docs-fixture --env docs-shots");
    out("  Example: ./raftdev script migration-log-fixture --env migration-log");
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
  } else if (scriptName === "docs-fixture") {
    scriptPath = join(PROJECT_DIR, "packages/server/scripts/docs-fixture.ts");
  } else if (scriptName === "migration-log-fixture") {
    scriptPath = join(PROJECT_DIR, "packages/server/scripts/migration-log-fixture.ts");
  } else {
    out(`ERROR: Unknown script '${scriptName}'.`);
    process.exit(1);
  }
  if (!existsSync(scriptPath)) {
    out(`ERROR: Script file not found: ${scriptPath}`);
    process.exit(1);
  }
  const scriptEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: e.DATABASE_URL,
    // docs-fixture uploads attachments and marks its computers online.
    ...(scriptName === "docs-fixture"
      ? {
        REDIS_URL: e.REDIS_URL,
        S3_ENDPOINT: e.S3_ENDPOINT,
        S3_REGION: "us-east-1",
        S3_FORCE_PATH_STYLE: "true",
        S3_ACCESS_KEY_ID: e.RUSTFS_ACCESS_KEY,
        S3_SECRET_ACCESS_KEY: e.RUSTFS_SECRET_KEY,
        S3_ATTACHMENTS_BUCKET: e.RUSTFS_BUCKET,
        S3_CDN_BUCKET: e.RUSTFS_BUCKET,
      }
      : {}),
  };
  // docs-fixture checks Activity parity against RisingWave at the end, so pass
  // the RW URL only for a local, full-profile RW that is serving. Otherwise drop
  // it, including one exported in the shell (as cmdSeed does).
  const rwState = scriptName === "docs-fixture" ? readRisingWaveState(e) : null;
  if (scriptName === "docs-fixture") {
    if (rwState?.mode === "local" && rwState.profile === "full" && rwState.status === "serving-ready") {
      scriptEnv.RISINGWAVE_DATABASE_URL = e.RISINGWAVE_DATABASE_URL;
    } else {
      delete scriptEnv.RISINGWAVE_DATABASE_URL;
    }
  }
  const r = spawnSync(
    "node",
    [
      "--import", "@oxc-node/core/register", scriptPath,
      "--server-url", `http://localhost:${e.SERVER_PORT}`,
      "--seed-file", e.SEED_FILE,
      ...(scriptName === "feedback-report" ? ["--worker-url", `http://localhost:${e.TRACE_WORKER_PORT}`] : []),
      ...(scriptName === "onboarding-scenarios" || scriptName === "docs-fixture" || scriptName === "migration-log-fixture"
        ? ["--web-url", `http://localhost:${e.WEB_PORT}`]
        : []),
      ...passthrough,
    ],
    {
      stdio: "inherit",
      env: scriptEnv,
    },
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

function psqlScalar(e: Env, sql: string): string | null {
  const result = sh("docker", [
    "exec", e.CONTAINER,
    "psql", "-X", "-U", "postgres", "-d", "slock", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { quiet: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

// pg_isready only shows that some server answers on the container's Unix
// socket. On first boot postgres:16-alpine runs a temporary socket-only server
// (listen_addresses='') for its init scripts, then restarts, so "ready" could
// land on the temporary one. Ready therefore means one real read-only query
// over TCP inside the container, which only the final server accepts, within
// one overall deadline.
const POSTGRES_READY_TIMEOUT_MS = 60_000;
const POSTGRES_READY_QUERY =
  'PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=2 exec psql -X -h 127.0.0.1 -U postgres -d slock -At -v ON_ERROR_STOP=1 -c "SELECT 1"';

function postgresQueryOnce(e: Env): { ok: boolean; error: string } {
  const r = sh("docker", ["exec", e.CONTAINER, "sh", "-c", POSTGRES_READY_QUERY], { quiet: true });
  const error = r.code === 0 ? "" : ((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ") || `exit ${r.code}`);
  return { ok: r.code === 0, error };
}

// Injectable probe, clock and sleep so the deadline is testable without Docker.
export function waitForQueryReady(options: {
  timeoutMs: number;
  probe: () => { ok: boolean; error: string };
  now: () => number;
  sleep: () => void;
}): { ready: boolean; lastError: string } {
  const deadline = options.now() + options.timeoutMs;
  while (true) {
    const probe = options.probe();
    if (probe.ok) return { ready: true, lastError: "" };
    if (options.now() >= deadline) return { ready: false, lastError: probe.error };
    options.sleep();
  }
}

// Printed whenever raftdev gives up on Postgres, so the next occurrence shows
// which server state it hit instead of only "could not read".
function printPostgresDiagnostics(e: Env, lastError: string): void {
  out(`  Last query error: ${lastError || "(none)"}`);
  out(`  Connection: docker exec ${e.CONTAINER} psql -h 127.0.0.1 -U postgres -d slock (host port ${e.PG_PORT})`);
  const state = sh("docker", [
    "inspect", "--format",
    "status={{.State.Status}} running={{.State.Running}} restarting={{.State.Restarting}} restarts={{.RestartCount}} " +
      "exit={{.State.ExitCode}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}",
    e.CONTAINER,
  ], { quiet: true });
  out(`  Container : ${state.code === 0 ? state.stdout.trim() : `inspect failed (exit ${state.code})`}`);
  for (const [label, args] of [
    ["pg_isready (socket)", ["exec", e.CONTAINER, "pg_isready", "-U", "postgres"]],
    ["pg_isready (tcp)   ", ["exec", e.CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]],
  ] as const) {
    const r = sh("docker", [...args], { quiet: true });
    out(`  ${label}: ${(r.stdout || r.stderr).trim() || `exit ${r.code}`}`);
  }
  const logs = sh("docker", ["logs", "--tail", "30", e.CONTAINER], { quiet: true });
  const tail = `${logs.stdout}${logs.stderr}`.trim();
  if (tail) {
    out("  Server log (last 30 lines):");
    for (const line of tail.split("\n")) out(`    ${line}`);
  }
}

function inspectDevDatabaseSchema(e: Env): DevDatabaseSchemaState | null {
  const tables = psqlScalar(e,
    "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') || ',' || " +
      "(to_regclass('drizzle.__drizzle_migrations') IS NOT NULL)::text");
  const match = tables === null ? null : /^(\d+),(true|false)$/.exec(tables);
  if (!match) return null;
  let applied: number | null = null;
  if (match[2] === "true") {
    const count = psqlScalar(e, "SELECT count(*) FROM drizzle.__drizzle_migrations");
    if (count === null || !/^\d+$/.test(count)) return null;
    applied = Number(count);
  }
  return classifyDevDatabaseSchema(Number(match[1]), applied);
}

/**
 * Build or update the environment's Postgres the way production does: the
 * migrations in packages/server/drizzle, in journal order, then the
 * post-migration index steps of `db:migrate:deploy` (devMigrationSteps).
 * Prints the reason and returns false on any failure.
 */
function migrateDevDatabase(e: Env): boolean {
  const state = inspectDevDatabaseSchema(e);
  if (state === null) {
    out(`ERROR: Could not read the migration state of Postgres in '${e.CONTAINER}'.`);
    out(`  Inspect: docker exec ${e.CONTAINER} psql -U postgres -d slock -c '\\dt drizzle.*'`);
    printPostgresDiagnostics(e, postgresQueryOnce(e).error);
    return false;
  }
  if (state === "push-built") {
    out(`ERROR: Postgres in '${e.CONTAINER}' was built by \`drizzle-kit push\` (tables, but no drizzle.__drizzle_migrations history).`);
    out("  raftdev now builds the database by running packages/server/drizzle migrations, as production does,");
    out("  and cannot convert a pushed database. Recreate it (this deletes the environment's local data):");
    out(`  Recovery: ./raftdev stop ${e.name} && ./raftdev start ${e.name}  (add the flags you use, e.g. --replicas)`);
    return false;
  }
  const serverDir = join(PROJECT_DIR, "packages/server");
  const pkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
  let steps: string[];
  try {
    steps = devMigrationSteps(pkg.scripts, POST_MIGRATION_INDEXES.map((index) => index.createScript));
  } catch (error) {
    out(`ERROR: ${error instanceof Error ? error.message : String(error)} (update DEV_SKIPPED_DEPLOY_STEPS in scripts/dev/raftdev.ts).`);
    return false;
  }
  out(state === "empty" ? "Migrating database from empty..." : "Applying pending database migrations...");
  const startedAt = Date.now();
  for (const step of steps) {
    const r = spawnSync(packageManagerCommand("pnpm"), tsScriptArgs(step), {
      cwd: serverDir,
      env: devMigrationEnv(process.env, e.DATABASE_URL),
      stdio: "inherit",
      shell: packageManagerSpawnShell(),
    });
    if (r.status !== 0) {
      out(`ERROR: Database migration step ${step} failed (exit ${r.status ?? r.signal ?? "unknown"}); the database was not migrated.`);
      out(`  Recovery: fix the failure above, then ./raftdev stop ${e.name} && ./raftdev start ${e.name}`);
      return false;
    }
  }
  out(`Database migrated (${((Date.now() - startedAt) / 1000).toFixed(1)}s).`);
  return true;
}

function redactRisingWaveDiagnostic(e: Env, value: string): string {
  let redacted = value;
  for (const secret of [e.DATABASE_URL, e.RISINGWAVE_DATABASE_URL, e.POSTGRES_PASSWORD]) {
    if (secret) redacted = redacted.replaceAll(secret, "<redacted>");
  }
  return redacted;
}

function runManagedRisingWaveBootstrap(e: Env): number {
  const result = spawnSync(packageManagerCommand("pnpm"), tsScriptArgs("scripts/bootstrap-risingwave-local.ts"), {
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

  const pnpmCommand = packageManagerCommand("pnpm");
  let finalStdout = "";
  let finalStderr = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync(pnpmCommand, [
      ...tsScriptArgs("scripts/verify-risingwave-inbox-parity.ts"),
      "--server-id", identity.serverId,
      "--user-id", identity.userId,
      "--filter", "all,unread,mentions",
      "--limit", "100",
      "--offset", "0",
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
  const { name, withOnboarding, withAgentRuns } = parseSeedCommandArgs(args, basename(PROJECT_DIR));
  const e = setupEnv(name);
  const previewRefusal = previewSeedRefusal(name, readPreviewState(e));
  if (previewRefusal) {
    for (const line of previewRefusal) out(line);
    process.exit(1);
  }
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
    out("  Refusing to migrate or seed a same-named external container.");
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
    out(`  Recovery: ./raftdev stop ${name} && ./raftdev start ${name}`);
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
    out(`  Recovery: ./raftdev stop ${name} && ./raftdev start ${name}`);
    process.exit(1);
  }
  if (risingWaveState?.mode === "local" && risingWaveState.profile === "full") {
    out(`ERROR: '${name}' is a managed/full CDC environment; live reseed is intentionally refused.`);
    out("  Rebuilding explicit CDC schemas requires quiescing server traffic and replacing the RisingWave catalog.");
    out(`  Use: ./raftdev stop ${name} && ./raftdev start ${name}  (fresh seed with the CDC graph),`);
    out(`  or start it with --no-risingwave when you need repeated live reseeds.`);
    process.exit(1);
  }
  if (!migrateDevDatabase(e)) {
    writeFailedRisingWaveState(e, risingWaveState);
    process.exit(1);
  }
  if (!ensureRustfsBucket(e)) {
    writeFailedRisingWaveState(e, risingWaveState);
    process.exit(1);
  }
  out(`Seeding test data for '${name}'...`);
  const r = spawnSync(packageManagerCommand("pnpm"), buildDevSeedArgs(e.SEED_FILE, withOnboarding, withAgentRuns), {
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
  // The tunnel `start` opened is detached from tmux, so it outlives the
  // session: end it by its recorded identity (pid + starttime + boot), as the
  // preview teardown does, never by searching process names. First, so the
  // public way in closes first and is gone even if the teardown below fails.
  const tunnelStop = stopRecordedTunnel(e.TUNNEL_STATE_FILE);
  if (tunnelStop.outcome === "stopped") {
    out(`Cloudflared tunnel (pid ${tunnelStop.pid}) stopped.`);
  } else if (tunnelStop.outcome === "still-running") {
    cleanupFailed = true;
    out(`ERROR: Cloudflared tunnel (pid ${tunnelStop.pid}) is still running after SIGTERM.`);
  }
  if (tmuxHasSession(e.TMUX_SESSION)) {
    // C-c every actual window (covers cluster-mode server-2 … server-N too).
    for (const w of tmuxWindowNames(e.TMUX_SESSION)) {
      sh("tmux", ["send-keys", "-t", `${e.TMUX_SESSION}:${w}`, "C-c"], { quiet: true });
    }
    spawnSync("sleep", ["1"]);
    if (killTmuxSession(e.TMUX_SESSION)) {
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
    } else if (sh("docker", ["rm", "-fv", e.RISINGWAVE_CONTAINER], { quiet: true }).code === 0) {
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
      } else if (sh("docker", ["rm", "-fv", c], { quiet: true }).code === 0) {
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
  removeServiceTmpdir(e);
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
    const tunnelStop = stopRecordedTunnel(e.TUNNEL_STATE_FILE);
    if (tunnelStop.outcome === "stopped") {
      out(`Cloudflared tunnel of '${entry.name}' (pid ${tunnelStop.pid}) stopped.`);
    } else if (tunnelStop.outcome === "still-running") {
      cleanupFailed = true;
      out(`ERROR: Cloudflared tunnel of '${entry.name}' (pid ${tunnelStop.pid}) is still running after SIGTERM.`);
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
      if (killTmuxSession(s)) {
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
      if (sh("docker", ["rm", "-fv", c], { quiet: true }).code === 0) {
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
    removeServiceTmpdir(e);
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

// `force` (raftdev preview) ignores the SLOCKDEV_TUNNEL=0 opt-out: a preview
// exists to be reached through the tunnel.
function startCloudflaredTunnel(
  e: Env,
  onSpawn?: (pid: number | undefined) => void,
  force = false,
): TunnelInfo {
  if (!force && process.env.SLOCKDEV_TUNNEL === "0") {
    return { enabled: false, reason: "SLOCKDEV_TUNNEL=0 (opt-out)" };
  }
  if (!detectCloudflared()) {
    return { enabled: false, reason: "cloudflared not installed" };
  }
  const logFile = cloudflaredLogPath(e.name, serviceEnvDir?.dir ?? null);
  try { writeFileSync(logFile, ""); } catch {}
  const logFd = openSync(logFile, "a");
  const child = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${e.WEB_PORT}`, "--no-autoupdate", "--protocol", "http2"],
    { detached: true, stdio: ["ignore", logFd, logFd], env: serviceSpawnEnv(process.env, serviceEnvDir) },
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

/** The tunnel a plain `start` opened, by identity: pid + starttime + boot (preview records the same triple). */
export interface TunnelRecord {
  pid: number;
  starttime: string;
  bootId: string;
}

export interface TunnelProbes {
  starttimeOf(pid: number): string | null;
  bootId(): string;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleepMs(ms: number): void;
}

const defaultTunnelProbes: TunnelProbes = {
  starttimeOf: processStarttime,
  bootId: currentBootId,
  signal: (pid, signal) => process.kill(pid, signal),
  sleepMs: (ms) => { spawnSync("sleep", [String(ms / 1000)]); },
};

/**
 * A process's start time: /proc's starttime on Linux, else `ps`'s start time
 * (macOS has no /proc). The prefix keeps the two sources from ever comparing
 * equal.
 */
function processStarttime(pid: number): string | null {
  const fromProc = procStarttime(pid);
  if (fromProc !== null) return fromProc;
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    // The same text at record and at stop, whatever the caller's locale or zone.
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  const started = ps.status === 0 ? ps.stdout.trim() : "";
  return started ? `ps:${started}` : null;
}

/** Writes the tunnel's identity right after spawn, so `stop` can end that process and only that one. */
export function recordTunnelProcess(file: string, pid: number | undefined, probes: TunnelProbes = defaultTunnelProbes): void {
  rmSync(file, { force: true });
  if (pid === undefined) return;
  const starttime = probes.starttimeOf(pid);
  if (starttime === null) return;
  const record: TunnelRecord = { pid, starttime, bootId: probes.bootId() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function readTunnelRecord(file: string): TunnelRecord | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<TunnelRecord>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 1) return null;
    if (typeof value.starttime !== "string" || typeof value.bootId !== "string") return null;
    return { pid: value.pid!, starttime: value.starttime, bootId: value.bootId };
  } catch {
    return null;
  }
}

/**
 * Ends the recorded tunnel: SIGTERM only when the pid still has the recorded
 * starttime on the recorded boot (a reused pid or a reboot means it is already
 * gone), then waits for it to exit. The record goes only with the tunnel: it
 * is removed once the tunnel is stopped or gone, and kept while it still runs
 * so the next stop can still find it.
 */
export function stopRecordedTunnel(
  file: string,
  probes: TunnelProbes = defaultTunnelProbes,
  waitMs = 5_000,
): { outcome: "none" | "gone" | "stopped" | "still-running"; pid?: number } {
  const record = readTunnelRecord(file);
  if (!record) {
    rmSync(file, { force: true });
    return { outcome: "none" };
  }
  const alive = (): boolean => record.bootId === probes.bootId() && probes.starttimeOf(record.pid) === record.starttime;
  if (!alive()) {
    rmSync(file, { force: true });
    return { outcome: "gone", pid: record.pid };
  }
  const term = (): void => {
    try {
      probes.signal(record.pid, "SIGTERM");
    } catch {
      // Exited between the check and the signal.
    }
  };
  term();
  for (let waited = 0; waited < waitMs && alive(); waited += 100) {
    // cloudflared drains open requests for its grace period (30s) after the
    // first SIGTERM; a second one makes it exit at once.
    if (waited === 1_000) term();
    probes.sleepMs(100);
  }
  if (alive()) return { outcome: "still-running", pid: record.pid };
  rmSync(file, { force: true });
  return { outcome: "stopped", pid: record.pid };
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
    if (killTmuxSession(e.TMUX_SESSION)) {
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
    if (sh("docker", ["rm", "-fv", container], { quiet: true }).code === 0) {
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

/**
 * What `raftdev preview` adds to `start` (it runs inside the preview's
 * systemd unit, see cmdPreviewUnit): a forced tunnel that must yield a URL,
 * the pinned one-hour idle TTL, Docker memory caps, the auto-login rule
 * (webAutoLoginEnv), a janitor that also enforces the hard deadline, no URL
 * in the start banner, and a hook that checks the unit and registers the
 * record while the start failure cleanup is still armed (a failure there
 * tears the start down). Absent → `start` behaves exactly as before.
 */
interface PreviewStartHooks {
  /** Right after `docker run`/`docker start` of an environment container (staged registration). */
  containerCreated(name: string): void;
  /** Right after `docker volume create`. */
  volumeCreated(name: string): void;
  /** Right after a recorded process is spawned (cloudflared). */
  processStarted(role: string, pid: number | undefined): void;
  /** Right after the tmux session (and so its dedicated server) exists. */
  tmuxStarted(): void;
  onRunning(context: PreviewRunningContext): void;
}

interface PreviewRunningContext {
  e: Env;
  url: string;
  tunnelPid: number | undefined;
  withAgentRuns: boolean;
  dockerMemoryCaps: Record<string, string>;
}

function cmdStart(args: string[], preview?: PreviewStartHooks): void {
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
  // Managed local RisingWave (full) is the default. The CLI flags set the same
  // switch as RAFTDEV_RISINGWAVE (--no-risingwave = 0, --risingwave = 1); an
  // external URL is a separate mode resolved below and cannot be combined
  // with an explicit local profile.
  let risingWaveLocalRaw: string | undefined = process.env.RAFTDEV_RISINGWAVE;
  let withOnboarding = false;
  let withAgentRuns = false;
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
      // Compatibility alias: the managed full profile is now the default.
      risingWaveLocalRaw = "1"; i += 1;
    } else if (a === "--no-risingwave") {
      risingWaveLocalRaw = "0"; i += 1;
    } else if (a.startsWith("--risingwave=")) {
      risingWaveLocalRaw = a.slice(a.indexOf("=") + 1); i += 1;
    } else if (a === "--with-onboarding") {
      withOnboarding = true; i += 1;
    } else if (a === "--with-agent-runs") {
      withAgentRuns = true; i += 1;
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
    out("  Managed local full is the default; use --risingwave=process-only for the pgwire smoke,");
    out("  --no-risingwave to skip it, or only RISINGWAVE_DATABASE_URL (no local profile) for external.");
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
  // A preview pins the one-hour idle TTL: the cleanup contract accepts no other.
  const idleTtlSeconds = preview ? PREVIEW_IDLE_TTL_SECONDS : parseIdleTtlSeconds(process.env.SLOCKDEV_IDLE_TTL_SECONDS);
  if (preview && process.env.SLOCKDEV_IDLE_TTL_SECONDS && Number(process.env.SLOCKDEV_IDLE_TTL_SECONDS) !== PREVIEW_IDLE_TTL_SECONDS) {
    out(`  NOTE: a preview keeps the ${PREVIEW_IDLE_TTL_SECONDS}s idle TTL; SLOCKDEV_IDLE_TTL_SECONDS is ignored.`);
  }
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
  validateTooling("start");
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
  } else {
    out("  RisingWave : disabled (--no-risingwave)");
    for (const line of RISINGWAVE_DISABLED_WARNING) out(`  ${line}`);
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
    out(`Environment '${name}': tmux session already exists; no processes were started.`);
    printApplicationListeners(applicationListeners(e));
    out(`  Attach:  ./raftdev logs ${name}`);
    out(`  Stop:    ./raftdev stop ${name}`);
    out("  To recover: inspect logs, stop explicitly, then repeat the original start command and options.");
    process.exit(1);
  }

  validateDockerDaemon();
  // A plain start never inherits an earlier preview's state (its janitor would
  // otherwise enforce that deadline, and tmux would use that socket).
  if (!preview) rmSync(previewStateFile(e), { force: true });
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
  prepareServiceTmpdir(e);
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
        if (sh("docker", ["rm", "-fv", container], { quiet: true }).code !== 0) {
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
    preview?.containerCreated(e.CONTAINER);
  } else {
    out(`Creating PostgreSQL container ${e.CONTAINER}...`);
    const launch = sh("docker", withDockerMemoryCap(
      postgresDockerRunArgs(e, risingWaveFull),
      preview ? PREVIEW_DOCKER_MEMORY_CAPS.postgres : undefined,
    ), { quiet: true });
    preview?.containerCreated(e.CONTAINER);
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
    preview?.containerCreated(e.REDIS_CONTAINER);
  } else {
    out(`Creating Redis container ${e.REDIS_CONTAINER}...`);
    sh("docker", withDockerMemoryCap([
      "run", "-d", "--name", e.REDIS_CONTAINER,
      "--label", RAFTDEV_MANAGED_LABEL_ARG,
      "-p", `${e.REDIS_PORT}:6379`,
      "redis:7-alpine",
    ], preview ? PREVIEW_DOCKER_MEMORY_CAPS.redis : undefined), { quiet: true });
    preview?.containerCreated(e.REDIS_CONTAINER);
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
      const removeCode = sh("docker", ["rm", "-fv", e.RISINGWAVE_CONTAINER], { quiet: true }).code;
      if (removeCode !== 0) {
        updateRisingWaveStatus("failed");
        out(`ERROR: Failed to replace RisingWave container '${e.RISINGWAVE_CONTAINER}'.`);
        out("  Retry after inspecting Docker, or run ./raftdev stop to clean partial services.");
        process.exit(1);
      }
    }
    // Before adding a RisingWave, drop this checkout's ones whose environment
    // is gone (only here, once the start is really going ahead: a refused
    // start touches nothing).
    sweepOrphanRisingWave();
    const risingWaveConfigFile = join(e.SLOCKDEV_DIR, "risingwave.toml");
    writeFileSync(risingWaveConfigFile, RISINGWAVE_CONFIG);
    out(`Creating RisingWave standalone container ${e.RISINGWAVE_CONTAINER}...`);
    launchCode = sh(
      "docker",
      risingWaveDockerRunArgs(
        e,
        risingWave.image ?? DEFAULT_RISINGWAVE_IMAGE,
        risingWaveFull ? e.RISINGWAVE_NETWORK : undefined,
        {
          owner: raftdevOwner(PROJECT_DIR),
          memoryBytes: parseRisingWaveMemoryBytes(process.env.RAFTDEV_RW_MEMORY_BYTES),
          configFile: risingWaveConfigFile,
        },
      ),
      { quiet: true },
    ).code;
    preview?.containerCreated(e.RISINGWAVE_CONTAINER);
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
  preview?.volumeCreated(e.RUSTFS_VOLUME);
  sh("docker", [
    "run", "--rm", "-v", `${e.RUSTFS_VOLUME}:/data`,
    "postgres:16-alpine", "sh", "-c", "chown -R 10001:10001 /data",
  ], { quiet: true });
  if (dockerNameExists(e.RUSTFS_CONTAINER)) {
    out(`Starting existing container ${e.RUSTFS_CONTAINER}...`);
    sh("docker", ["start", e.RUSTFS_CONTAINER], { quiet: true });
    preview?.containerCreated(e.RUSTFS_CONTAINER);
  } else {
    out(`Creating RustFS container ${e.RUSTFS_CONTAINER}...`);
    sh("docker", withDockerMemoryCap([
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
    ], preview ? PREVIEW_DOCKER_MEMORY_CAPS.rustfs : undefined), { quiet: true });
    preview?.containerCreated(e.RUSTFS_CONTAINER);
  }

  out("Waiting for PostgreSQL...");
  const pgReadiness = waitForQueryReady({
    timeoutMs: POSTGRES_READY_TIMEOUT_MS,
    probe: () => postgresQueryOnce(e),
    now: () => Date.now(),
    sleep: () => { spawnSync("sleep", ["1"]); },
  });
  if (!pgReadiness.ready) {
    updateRisingWaveStatus("failed");
    out(`ERROR: PostgreSQL did not answer a read-only query within ${POSTGRES_READY_TIMEOUT_MS / 1000}s.`);
    printPostgresDiagnostics(e, pgReadiness.lastError);
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

  if (!migrateDevDatabase(e)) {
    updateRisingWaveStatus("failed");
    process.exit(1);
  }

  out("Seeding test data...");
  if (preview) {
    // The seed file holds the machine key and (with agent runs) the random
    // password; create it owner-only so the seed's write keeps that mode.
    writeFileSync(e.SEED_FILE, "", { mode: 0o600 });
    chmodSync(e.SEED_FILE, 0o600);
  }
  const seedPasswordEnv = Object.fromEntries(previewSeedPasswordEnv({
    preview: preview !== undefined,
    withAgentRuns,
    randomPassword: () => randomBytes(18).toString("base64url"),
  }));
  let r = spawnSync(packageManagerCommand("pnpm"), buildDevSeedArgs(e.SEED_FILE, withOnboarding, withAgentRuns), {
    cwd: join(PROJECT_DIR, "packages/server"),
    env: {
      ...process.env,
      ...seedPasswordEnv,
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
  // A tunnel recorded by an earlier start whose tmux session is gone would
  // lose its record to the new one below: end it first.
  if (stopRecordedTunnel(e.TUNNEL_STATE_FILE).outcome === "still-running") {
    out(`ERROR: the tunnel an earlier start opened is still running after SIGTERM; see ${e.TUNNEL_STATE_FILE}.`);
    process.exit(1);
  }
  const tunnel = startCloudflaredTunnel(e, (pid) => {
    failureCleanup.trackTunnel(pid);
    recordTunnelProcess(e.TUNNEL_STATE_FILE, pid);
    preview?.processStarted("cloudflared", pid);
    if (serviceEnvDir?.dir && pid !== undefined) recordDevEnvProcesses(serviceEnvDir.dir, [{ pid, role: "cloudflared" }], procStarttime);
  }, preview !== undefined);
  const publicPreviewUrl = tunnel.url;
  if (preview && !tunnel.url) {
    updateRisingWaveStatus("failed");
    out(`ERROR: raftdev preview needs a public tunnel URL; ${tunnel.reason ?? "cloudflared did not report one"}.`);
    if (tunnel.logFile) out(`  cloudflared log: ${tunnel.logFile}`);
    process.exit(1);
  }

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
    // Tell every machine attached to this server (including a `raft-computer`
    // started outside raftdev) to upload traces to this env's worker, not the
    // production default. Daemons accept it only for loopback or the
    // production host (packages/daemon/src/traceUploadUrl.ts), so a remote
    // point-anywhere URL still needs the daemon's own env (set below).
    if (effectiveWorkerUrl) serverCmd += `${envAssign("SLOCK_MACHINE_TRACE_UPLOAD_URL", effectiveWorkerUrl)} `;
    serverCmd += `${envAssign("SLOCKDEV_LAST_ACTIVITY_FILE", e.ACTIVITY_FILE)} `;
    serverCmd += `${envAssign("DEPLOYMENT_ENV", "slockdev")} `;
    serverCmd += `${envAssign("DATABASE_URL", e.DATABASE_URL)} `;
    serverCmd += `${envAssign("JWT_SECRET", e.JWT_SECRET)} `;
    // Stable per env so keys minted earlier keep verifying on the HMAC path.
    serverCmd += `${envAssign("AGENT_API_KEY_HMAC_SECRET", `raftdev-agent-key-hmac-${name}-0123456789abcdef`)} `;
    // task #30 — opt-in Raft Computer path. Default OFF (zero behaviour
    // change for non-Computer envs). `RAFTDEV_COMPUTER=1 ./raftdev start`
    // enables the device-code login surface + the >=32-char bootstrap
    // pepper device-auth requires, so `raft-computer login/attach/start`
    // works against this env with no manual slockdev edits.
    // #proj-assistant:#24 — opt-in: `RAFTDEV_ASSISTANT_WITHOUT_RUNTIME=1` shows the
    // seeded personal assistant (its otter, its DM) with no hosted runtime
    // behind it (assistantService.assistantWithoutRuntimeForPreview).
    if (process.env.RAFTDEV_ASSISTANT_WITHOUT_RUNTIME === "1") {
      serverCmd += `${envAssign("RAFTDEV_ASSISTANT_WITHOUT_RUNTIME", "1")} `;
    }
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
  preview?.tmuxStarted();
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
  // Opt-in VITE_SLOCKDEV_SKIP_AUTO_LOGIN skips the slockdev auto-login into
  // dev@slock.ai so a preview can exercise the genuinely-fresh unauthenticated
  // entry (signup / onboarding rework). VITE_SLOCKDEV_EMAIL binds one
  // environment to a seeded owner/admin/member account, keeping each public
  // role URL passwordless without a product-side impersonation UI. Both are
  // baked inline (not tmux-env-inherited) for the same reason the server flags
  // are — new tmux windows do not inherit the launching shell's env. Unset →
  // not added → auto-login behaves exactly as before. A preview with agent
  // runs always skips auto-login (hard rule: see webAutoLoginEnv).
  for (const [key, value] of webAutoLoginEnv({
    preview: preview !== undefined,
    withAgentRuns,
    env: process.env,
  })) {
    webCmd += `${envAssign(key, value)} `;
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
  runRequiredTmux(
    ["new-window", "-t", e.TMUX_SESSION, "-n", "web", "-c", PROJECT_DIR, runTmuxShellCommand(webWindowCommand(webCmd))],
    "web",
  );

  // Window 2: daemon. A preview without --with-agent-runs has none: its URL
  // is passwordless, so nothing behind it may run agents on this machine's
  // model credentials.
  const startDaemon = shouldStartDaemonWindow({ preview: preview !== undefined, withAgentRuns });
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
  if (startDaemon) {
    runRequiredTmux(
      ["new-window", "-t", e.TMUX_SESSION, "-n", "daemon", "-c", PROJECT_DIR, runTmuxShellCommand(daemonCmd)],
      "daemon",
    );
  } else {
    out("  Daemon: not started (preview without --with-agent-runs; no agent runs on this machine).");
  }

  if (traceWorker) {
    let twCmd = "";
    twCmd += `${envAssign("SLOCK_HOME", e.SLOCK_HOME)} `;
    twCmd += `${envAssign("SCOPE_ATTESTATION_SECRET", scopeAttestationSecret)} `;
    twCmd += `${envAssign("TRACE_UPLOAD_WORKER_SECRET", traceWorkerSecret)} `;
    twCmd += `${envAssign("TRACE_UPLOAD_MAX_BYTES", "52428800")} `;
    twCmd += `${envAssign("TRACE_WEB_CORS_ORIGIN", `http://localhost:${e.WEB_PORT}`)} `;
    twCmd += `${envAssign("DEPLOYMENT_ENV", "slockdev")} `;
    twCmd += `${envAssign("PORT", String(e.TRACE_WORKER_PORT))} `;
    // Same Node entry as production (src/node.ts), storing into the local RustFS.
    twCmd += `${envAssign("R2_ENDPOINT", e.S3_ENDPOINT)} `;
    twCmd += `${envAssign("R2_REGION", "us-east-1")} `;
    twCmd += `${envAssign("R2_BUCKET", e.RUSTFS_BUCKET)} `;
    twCmd += `${envAssign("R2_ACCESS_KEY_ID", e.RUSTFS_ACCESS_KEY)} `;
    twCmd += `${envAssign("R2_SECRET_ACCESS_KEY", e.RUSTFS_SECRET_KEY)} `;
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
      (preview
        ? `--memory ${PREVIEW_DOCKER_MEMORY_CAPS.otelcol} --memory-swap ${PREVIEW_DOCKER_MEMORY_CAPS.otelcol} `
        : "") +
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
    // tmux starts this container asynchronously; record it once it exists.
    preview?.containerCreated(e.OTELCOL_CONTAINER);
    updateTraceReaderStatus(otelcolStarted ? "ready" : "failed");
  }

  if (latencyProfile) {
    const proxyCmd =
      `node --import @oxc-node/core/register scripts/dev/raftdev-latency-proxy.ts ` +
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

  if (idleTtlSeconds > 0 || preview) {
    const janitorCmd = `node --import @oxc-node/core/register scripts/dev/raftdev.ts janitor ${shellQuote(name)} ${String(idleTtlSeconds)}`;
    runRequiredTmux(
      ["new-window", "-t", e.TMUX_SESSION, "-n", "janitor", "-c", PROJECT_DIR, runTmuxShellCommand(janitorCmd)],
      "janitor",
    );
  }

  sh("tmux", ["select-window", "-t", `${e.TMUX_SESSION}:server`], { quiet: true });
  if (serviceEnvDir?.dir) {
    const panes = sh("tmux", ["list-panes", "-s", "-t", e.TMUX_SESSION, "-F", "#{pane_pid}"], { quiet: true });
    const panePids = panes.stdout.split("\n").filter((l) => /^\d+$/.test(l)).map((l) => ({ pid: Number(l), role: "tmux-pane" }));
    recordDevEnvProcesses(serviceEnvDir.dir, panePids, procStarttime);
  }

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
  } else {
    out("  RisingWave: disabled (--no-risingwave)");
    for (const line of RISINGWAVE_DISABLED_WARNING) out(`  ${line}`);
  }
  out(`  RustFS:    ${e.S3_ENDPOINT} (bucket: ${e.RUSTFS_BUCKET})`);
  if (!(preview && withAgentRuns)) out(`  Login:     dev@slock.ai / password123`);
  out(idleTtlSeconds > 0
    ? `  Auto-stop: after ${idleTtlSeconds}s idle (last activity ${e.ACTIVITY_FILE})`
    : "  Auto-stop: disabled");
  if (preview && tunnel.url) {
    // The URL is published only after the unit check (cmdPreviewUnit).
    out(`  CF Tunnel: opened (cloudflared pid ${tunnel.pid}); URL follows once the unit check passes`);
  } else if (tunnel.enabled && tunnel.url) {
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
  out(preview ? `  Stop:      ./raftdev preview stop ${name}` : `  Stop:      ./raftdev stop ${name}`);
  out(`  Creds:     ${e.SEED_FILE}`);
  if (preview) {
    const dockerMemoryCaps: Record<string, string> = { ...PREVIEW_DOCKER_MEMORY_CAPS };
    if (risingWave.mode === "local") {
      dockerMemoryCaps.risingwave = String(
        parseRisingWaveMemoryBytes(process.env.RAFTDEV_RW_MEMORY_BYTES) + RISINGWAVE_DOCKER_HEADROOM_BYTES,
      );
    }
    preview.onRunning({ e, url: tunnel.url!, tunnelPid: tunnel.pid, withAgentRuns, dockerMemoryCaps });
  }
  failureCleanup.disarm();
}

/**
 * The plain janitor's stop. The janitor runs in a window of the tmux session
 * that `stop` sends C-c to and then kills, so running `stop` in-process ended
 * the janitor partway through: tmux, containers and volumes kept running.
 * Like the preview's stop unit, it runs as its own process instead, in a new
 * session (detached) with its output in .slockdev/<name>/janitor-stop.log
 * (latest stop only; it ends in "Done." on success), so neither the C-c nor
 * the session's hangup reaches it.
 */
export function janitorStopCommand(options: {
  nodePath: string;
  raftdevScript: string;
  name: string;
}): { command: string; args: string[] } {
  return {
    command: options.nodePath,
    args: ["--import", "@oxc-node/core/register", options.raftdevScript, "stop", options.name],
  };
}

function launchJanitorStop(e: Env): void {
  const logFile = join(e.SLOCKDEV_DIR, "janitor-stop.log");
  let logFd: number | null = null;
  try {
    mkdirSync(e.SLOCKDEV_DIR, { recursive: true });
    logFd = openSync(logFile, "w");
  } catch (err) {
    // No log is better than no stop.
    out(`[raftdev] cannot write ${logFile} (${(err as Error).message}); the stop runs without a log.`);
  }
  const { command, args } = janitorStopCommand({
    nodePath: process.execPath,
    raftdevScript: join(PROJECT_DIR, "scripts/dev/raftdev.ts"),
    name: e.name,
  });
  const output = logFd ?? "ignore";
  const child = spawn(command, args, {
    cwd: PROJECT_DIR, env: process.env, detached: true, stdio: ["ignore", output, output],
  });
  child.on("error", (err) => out(`[raftdev] could not start the stop: ${err.message}; run ./raftdev stop ${e.name}`));
  child.unref();
  if (logFd !== null) {
    try { closeSync(logFd); } catch {}
  }
  if (child.pid === undefined) return;
  out(`[raftdev] stop started outside tmux (pid ${child.pid})${logFd !== null ? `; log: ${logFile}` : ""}`);
}

function cmdJanitor(name: string, ttlSecondsArg: string | undefined): void {
  const e = setupEnv(name);
  const ttlSeconds = parseIdleTtlSeconds(ttlSecondsArg);
  const previewState = readPreviewState(e);
  if (ttlSeconds <= 0 && !previewState) return;
  out(ttlSeconds > 0
    ? `[raftdev] janitor watching '${name}' (idle TTL ${ttlSeconds}s)`
    : `[raftdev] janitor watching '${name}' (idle TTL disabled)`);
  const deadlineAtSeconds = previewState ? Math.floor(Date.parse(previewState.deadlineAt) / 1000) : null;
  if (previewState) out(`[raftdev] preview ${previewState.id} hard deadline ${previewState.deadlineAt}`);
  while (true) {
    // Also stop any other environment's RisingWave left running after it died.
    sweepOrphanRisingWave();
    const now = Math.floor(Date.now() / 1000);
    const lastActivity = readIntegerFile(e.ACTIVITY_FILE) ?? now;
    const decision = janitorDecision({
      nowSeconds: now,
      lastActivitySeconds: lastActivity,
      idleTtlSeconds: ttlSeconds,
      deadlineAtSeconds,
    });
    if (decision.action === "stop") {
      out(decision.reason === "deadline"
        ? `[raftdev] '${name}' reached its preview deadline; auto-stopping environment.`
        : `[raftdev] '${name}' idle for ${decision.idleSeconds}s; auto-stopping environment.`);
      if (previewState) {
        launchPreviewStopUnit(previewState, decision.reason);
      } else {
        launchJanitorStop(e);
      }
      return;
    }
    spawnSync("sleep", [String(decision.sleepSeconds)]);
  }
}

// ──── raftdev preview: reviewer environments (scripts/dev/raftdev-preview.ts) ────
//
// `./raftdev preview <name>` (the launcher, in the caller's shell) checks the
// host, schedules the owner's reminder, then starts `__preview-unit` as the
// systemd user unit raft-preview-<id>.service (MemoryMax, RuntimeMaxSec =
// deadline, KillMode=control-group). Inside the unit, cmdPreviewUnit runs
// `start` with preview hooks on a dedicated tmux socket and an invalid session
// bus, so tmux, server, vite and cloudflared all stay in the unit's cgroup;
// it checks that, registers the record through IT's raft-preview-cleaner, and
// on stop (RuntimeMaxSec, systemctl stop, or the cleaner) tears down with
// cmdStop. `preview stop` asks the cleaner for its verified stop.

function previewStateFile(e: Env): string {
  return join(e.SLOCKDEV_DIR, "preview.json");
}
function previewSpecFile(e: Env): string {
  return join(e.SLOCKDEV_DIR, "preview-unit-spec.json");
}
function previewLogFile(e: Env): string {
  return join(e.SLOCKDEV_DIR, "preview-unit.log");
}
function previewLaunchFile(e: Env): string {
  return join(e.SLOCKDEV_DIR, "preview-launch.json");
}

function readPreviewStateFile(path: string): PreviewState | null {
  try {
    return parsePreviewState(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readPreviewState(e: Env): PreviewState | null {
  return readPreviewStateFile(previewStateFile(e));
}

/**
 * `-L raft-preview-<id>` for a tmux call that addresses a preview's session
 * (`slock-<name>` with a preview state in this checkout), else nothing: the
 * default socket and plain environments are unchanged. A dedicated socket
 * makes the preview's tmux server a child of its unit instead of joining the
 * user's existing server outside it.
 */
function previewTmuxSocketArgs(args: readonly string[]): string[] {
  const session = tmuxSessionFromArgs(args);
  if (!session?.startsWith("slock-")) return [];
  const name = session.slice("slock-".length);
  if (!ENVIRONMENT_NAME_RE.test(name) || name === "." || name === "..") return [];
  const state = readPreviewStateFile(join(PROJECT_DIR, ".slockdev", name, "preview.json"));
  return state ? ["-L", state.tmuxSocket] : [];
}

const runCommand: CommandRunner = (command, args) => sh(command, args, { quiet: true });

/**
 * The environment for systemctl/systemd-run: inside a preview unit the
 * job-local invalid bus address is dropped so they reach the user manager
 * through $XDG_RUNTIME_DIR (set to the uid default when missing).
 */
function hostBusEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.DBUS_SESSION_BUS_ADDRESS === PREVIEW_INVALID_DBUS_ADDRESS) delete env.DBUS_SESSION_BUS_ADDRESS;
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return env;
}

function procStarttime(pid: number): string | null {
  return liveStarttime(readProcStat(pid));
}

function currentBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

function procCgroup(pid: number | "self"): string | null {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return null;
  }
}

function procParentTable(): Map<number, number> {
  const table = new Map<number, number>();
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return table; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcStat(Number(entry));
    if (stat) table.set(Number(entry), stat.ppid);
  }
  return table;
}

function listenerPids(port: number): number[] {
  return sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { quiet: true }).stdout
    .split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 1);
}

/** systemd's view of a unit: gone (not loaded, inactive or failed), present, or unknown. */
function unitState(unitName: string, env: NodeJS.ProcessEnv): { state: "present" | "gone" | "unknown"; invocationId: string } {
  const result = sh("systemctl", ["--user", "show", unitName, "-p", "LoadState", "-p", "ActiveState", "-p", "InvocationID"], {
    quiet: true,
    env,
  });
  const values = new Map(result.stdout.split("\n").filter((line) => line.includes("=")).map((line) => {
    const eq = line.indexOf("=");
    return [line.slice(0, eq), line.slice(eq + 1).trim()] as const;
  }));
  if (values.get("LoadState") === "not-found") return { state: "gone", invocationId: "" };
  if (result.code !== 0) return { state: "unknown", invocationId: "" };
  const active = values.get("ActiveState") ?? "";
  return {
    state: active === "inactive" || active === "failed" ? "gone" : "present",
    invocationId: values.get("InvocationID") ?? "",
  };
}

/**
 * The processes a preview owns, by pid + starttime: its tmux server
 * (dedicated socket), each pane and the pane's descendants at record time,
 * the server and web listeners, and cloudflared.
 */
function collectPreviewProcesses(e: Env, tunnelPid: number | undefined): PreviewProcess[] {
  const byPid = new Map<number, PreviewProcess>();
  const add = (pid: number, role: string, override = false): void => {
    if (!Number.isInteger(pid) || pid <= 1) return;
    const starttime = procStarttime(pid);
    if (starttime === null) return;
    if (override || !byPid.has(pid)) byPid.set(pid, { pid, starttime, role });
  };
  const serverPid = Number(sh("tmux", ["display-message", "-p", "-t", e.TMUX_SESSION, "#{pid}"], { quiet: true }).stdout.trim());
  add(serverPid, "tmux-server", true);
  const parents = procParentTable();
  const panes = sh("tmux", ["list-panes", "-s", "-t", e.TMUX_SESSION, "-F", "#{window_name}\t#{pane_pid}"], { quiet: true })
    .stdout.split("\n").map((line) => line.split("\t")).filter((parts) => parts.length === 2);
  for (const [window, pidText] of panes) {
    const panePid = Number(pidText);
    add(panePid, `tmux:${window}`);
    for (const child of descendantPids([panePid], parents)) add(child, `tmux:${window}:child`);
  }
  for (const pid of listenerPids(e.SERVER_PORT)) add(pid, "server", true);
  for (const pid of listenerPids(e.WEB_PORT)) add(pid, "vite", true);
  if (tunnelPid !== undefined) add(tunnelPid, "cloudflared", true);
  // The contract takes at most 256 identities: named roles first, then pane
  // descendants.
  return [...byPid.values()]
    .sort((a, b) => Number(a.role.endsWith(":child")) - Number(b.role.endsWith(":child")))
    .slice(0, 256);
}

function inspectPreviewContainer(name: string): ContainerInspection {
  return parseContainerInspect(
    sh("docker", ["container", "inspect", "--format", "{{.Id}}\t{{json .Mounts}}", name], { quiet: true }),
  );
}

/**
 * Full container ids and their `volume` mounts (anonymous included) of this
 * environment's containers. A failed Docker query is an error, never "no
 * such container": the caller must not publish an incomplete list.
 */
function collectPreviewDocker(e: Env): { containerIds: string[]; volumeNames: string[]; errors: string[] } {
  const containerIds: string[] = [];
  const volumeNames: string[] = [];
  const errors: string[] = [];
  for (const name of [e.CONTAINER, e.REDIS_CONTAINER, e.RUSTFS_CONTAINER, e.OTELCOL_CONTAINER, e.RISINGWAVE_CONTAINER]) {
    const inspection = inspectPreviewContainer(name);
    if (inspection.state === "unknown") errors.push(`${name}: ${inspection.error}`);
    if (inspection.state !== "present") continue;
    containerIds.push(inspection.id);
    volumeNames.push(...inspection.volumeNames);
  }
  return { containerIds, volumeNames, errors };
}

function gitValue(args: string[]): string {
  const result = sh("git", args, { quiet: true, cwd: PROJECT_DIR });
  return result.code === 0 ? result.stdout.trim() : "unknown";
}

function previewCleanerInstalled(): boolean {
  return existsSync(PREVIEW_CLEANER_PATH);
}

const PREVIEW_CLEANER_MISSING = [
  `ERROR: IT's preview helper is not installed (${PREVIEW_CLEANER_PATH}). It is the only record writer`,
  "  (locked register) and the verified stop. Ask IT to install raft-preview-cleaner and its user timer",
  "  (~/.config/systemd/user/raft-preview-cleaner.{service,timer}) on this host for this Unix user.",
];

function readCleanerEnvText(): string | null {
  try {
    return readFileSync(previewCleanerEnvFile(homedir()), "utf8");
  } catch {
    return null;
  }
}

/** The registry, resolved the way raft-preview-cleaner resolves it (env, then its env file, then XDG). */
function resolvePreviewRegistry(): string {
  return previewRegistryDir(process.env, homedir(), readCleanerEnvText());
}


function cmdPreview(args: string[]): number | void {
  const sub = args[0];
  if (sub === "stop") return cmdPreviewStop(args.slice(1));
  if (sub === "list") return cmdPreviewList(args.slice(1));
  if (sub === undefined || sub === "-h" || sub === "--help") usageAndExit();

  let parsed: PreviewStartArgs;
  try {
    parsed = parsePreviewStartArgs(args);
    validateEnvironmentName(parsed.name);
  } catch (error) {
    out(`ERROR: ${(error as Error).message}`);
    return 1;
  }
  const fail = (lines: string[]): number => {
    for (const line of lines) out(line);
    out("No containers or local processes were started.");
    return 1;
  };
  if (!existsSync("/proc/self/stat") || !existsSync("/proc/sys/kernel/random/boot_id")) {
    return fail(["ERROR: raftdev preview records processes by /proc identity and needs Linux."]);
  }
  if (!commandExists("systemd-run") || !commandExists("systemctl")) {
    return fail(["ERROR: raftdev preview runs as a systemd user unit; systemd-run/systemctl are not on PATH."]);
  }
  if (!detectCloudflared()) {
    return fail([
      "ERROR: raftdev preview needs cloudflared on PATH for its public tunnel.",
      "  Install it (e.g. `brew install cloudflare/cloudflare/cloudflared` or the Cloudflare .deb), then retry.",
    ]);
  }
  if (!previewCleanerInstalled()) return fail(PREVIEW_CLEANER_MISSING);
  const owner = previewOwner(process.env);
  if (!owner.agentId) {
    return fail(["ERROR: raftdev preview needs the owning agent's id (SLOCK_AGENT_ID) for its record."]);
  }
  const registryDir = resolvePreviewRegistry();
  const timerRegistry = previewRegistryDir({ XDG_STATE_HOME: process.env.XDG_STATE_HOME }, homedir(), readCleanerEnvText());
  if (registryDir !== timerRegistry) {
    out(`WARNING: RAFT_PREVIEW_REGISTRY=${registryDir} is not what the cleanup timer reads (${timerRegistry}).`);
    out(`  The timer follows an override only through ${previewCleanerEnvFile(homedir())}: one line RAFT_PREVIEW_REGISTRY=${registryDir}`);
  }
  const sameName = listPreviewRecords(registryDir)
    .flatMap((entry) => (entry.record && entry.record.name === parsed.name && entry.record.repo === PROJECT_DIR ? [entry.record] : []));
  if (sameName.length > 0) {
    return fail([
      `ERROR: preview '${parsed.name}' is already recorded (${sameName.map((r) => r.id).join(", ")}).`,
      `  Stop it first: ./raftdev preview stop ${parsed.name}`,
    ]);
  }
  const dockerRefusal = previewDockerEndpointRefusal(process.env);
  if (dockerRefusal) return fail(dockerRefusal);
  const e = setupEnv(parsed.name);
  const previous = readPreviewState(e);
  if (
    previous &&
    !existsSync(previewRecordPath(previous.registryDir, previous.id)) &&
    unitState(previewUnitName(previous.id), process.env).state === "gone"
  ) {
    // A launch that died before registering: nothing runs and nothing is recorded.
    rmSync(previewStateFile(e), { force: true });
  }
  if (spawnSync("tmux", ["has-session", "-t", e.TMUX_SESSION], { stdio: "ignore" }).status === 0 || readPreviewState(e)) {
    return fail([
      `ERROR: environment '${parsed.name}' already has a tmux session or preview state.`,
      `  Stop it first (./raftdev stop ${parsed.name} or ./raftdev preview stop ${parsed.name}), or pick another name.`,
    ]);
  }
  // A preview never adopts resources it did not create (contract): `start`
  // would otherwise reuse a leftover database with its old accounts,
  // sessions and refresh tokens (the seed's password reset is only defence
  // in depth). A Docker query failure refuses too.
  const adoption = previewAdoptionRefusal(parsed.name, [
    ...[e.CONTAINER, e.REDIS_CONTAINER, e.RUSTFS_CONTAINER, e.OTELCOL_CONTAINER, e.RISINGWAVE_CONTAINER].map((container) => ({
      kind: "container" as const,
      name: container,
      state: dockerInspectState(sh("docker", ["container", "inspect", container], { quiet: true })),
    })),
    {
      kind: "volume" as const,
      name: e.RUSTFS_VOLUME,
      state: dockerInspectState(sh("docker", ["volume", "inspect", e.RUSTFS_VOLUME], { quiet: true })),
    },
  ]);
  if (adoption) return fail(adoption);


  const id = randomUUID();
  const unitName = previewUnitName(id);
  const createdAt = new Date();
  const deadlineAt = new Date(createdAt.getTime() + parsed.forSeconds * 1000);
  out(`=== raftdev preview '${parsed.name}' (${id}) ===`);
  out(`  Deadline:  ${isoSeconds(deadlineAt)} UTC (${formatDuration(parsed.forSeconds)})`);
  out(`  Unit:      ${unitName} (profile ${parsed.resources.profile}, MemoryMax ${parsed.resources.memoryMax})`);

  let reminderId: string | null = null;
  if (parsed.notify) {
    if (commandExists("raft")) {
      const scheduled = schedulePreviewReminder({ id, name: parsed.name, deadlineAt, notify: parsed.notify }, runCommand);
      reminderId = scheduled.reminderId;
      if (scheduled.warning) out(`  WARNING: ${scheduled.warning}`);
    } else {
      out("  WARNING: `raft` CLI not on PATH; no owner reminder scheduled.");
    }
    if (reminderId) out(`  Reminder:  #${reminderId} at deadline + 10m in ${parsed.notify.target}`);
  }

  mkdirSync(e.SLOCKDEV_DIR, { recursive: true });
  const state: PreviewState = {
    schemaVersion: 1,
    id,
    deadlineAt: isoSeconds(deadlineAt),
    registryDir,
    tmuxSocket: previewTmuxSocket(id),
  };
  writeFileSync(previewStateFile(e), JSON.stringify(state) + "\n");
  const spec: PreviewUnitSpec = {
    schemaVersion: 1,
    id,
    name: parsed.name,
    startArgs: parsed.startArgs,
    withAgentRuns: parsed.withAgentRuns,
    createdAt: isoSeconds(createdAt),
    deadlineAt: isoSeconds(deadlineAt),
    registryDir,
    resources: parsed.resources,
    owner,
    notify: parsed.notify,
    reminderId,
    env: previewUnitEnv(process.env, { withAgentRuns: parsed.withAgentRuns }),
  };
  writeFileSync(previewSpecFile(e), JSON.stringify(spec), { mode: 0o600 });
  chmodSync(previewSpecFile(e), 0o600);
  // The unit's log carries the preview's login block (with --with-agent-runs,
  // the random seed password): owner-only. systemd appends to it in place.
  writeFileSync(previewLogFile(e), "", { mode: 0o600 });
  chmodSync(previewLogFile(e), 0o600);
  rmSync(previewLaunchFile(e), { force: true });

  let offset = 0;
  const flushLog = (): void => {
    try {
      const text = readFileSync(previewLogFile(e), "utf8");
      if (text.length > offset) {
        process.stdout.write(text.slice(offset));
        offset = text.length;
      }
    } catch {}
  };
  const abandon = (lines: string[]): number => {
    flushLog();
    for (const line of lines) out(line);
    rmSync(previewSpecFile(e), { force: true });
    if (existsSync(previewRecordPath(registryDir, id))) {
      // The unit registered (at least the provisional record): let the
      // cleaner stop it and verify every recorded resource, as for any stop.
      const stop = sh(PREVIEW_CLEANER_PATH, ["--registry", registryDir, "stop", id], { quiet: true, env: hostBusEnv() });
      const result = parseCleanerStopOutput(stop.stdout);
      if (stop.code !== 0 || (result.outcome !== "cleaned" && result.outcome !== "absent")) {
        out(`  Cleanup of ${id} is not verified (${result.outcome}); the record and the reminder are kept:`);
        for (const line of result.detail) out(line);
        out(`  Retry: ./raftdev preview stop ${id}`);
        return 1;
      }
      out(`  Cleanup of ${id} verified by raft-preview-cleaner.`);
    } else {
      sh("systemctl", ["--user", "stop", unitName], { quiet: true });
    }
    const cancelled = cancelPreviewReminder(reminderId, runCommand);
    if (cancelled.attempted && !cancelled.ok) out(`  WARNING: ${cancelled.message}`);
    rmSync(previewStateFile(e), { force: true });
    return 1;
  };

  const runtimeMaxSeconds = Math.max(1, Math.ceil((deadlineAt.getTime() - Date.now()) / 1000));
  const launch = sh("systemd-run", previewSystemdRunArgs({
    id,
    memoryMax: parsed.resources.memoryMax,
    runtimeMaxSeconds,
    workingDirectory: PROJECT_DIR,
    logFile: previewLogFile(e),
    command: [
      process.execPath, "--import", "@oxc-node/core/register", join(PROJECT_DIR, "scripts/dev/raftdev.ts"),
      "__preview-unit", previewSpecFile(e),
    ],
  }), { quiet: true });
  if (launch.code !== 0) {
    return abandon([`ERROR: systemd-run failed (exit ${launch.code}): ${launch.stderr.trim().split("\n")[0] ?? ""}`]);
  }
  out(`  Log:       ${previewLogFile(e)} (Ctrl-C stops following; the preview keeps running)`);
  out("");

  // Follow the unit's log until it reports running or failed, or stops.
  const followUntil = Date.now() + 30 * 60_000;
  let lastUnitCheck = 0;
  while (true) {
    flushLog();
    let launchState: { status?: string; message?: string } | null = null;
    try { launchState = JSON.parse(readFileSync(previewLaunchFile(e), "utf8")) as { status?: string; message?: string }; } catch {}
    if (launchState?.status === "running") break;
    if (launchState?.status === "failed") {
      return abandon([`ERROR: preview '${parsed.name}' failed to start: ${launchState.message ?? "see the log above"}`]);
    }
    if (Date.now() - lastUnitCheck > 5_000) {
      lastUnitCheck = Date.now();
      if (unitState(unitName, process.env).state === "gone") {
        return abandon([`ERROR: ${unitName} stopped before the preview came up; see ${previewLogFile(e)}`]);
      }
    }
    if (Date.now() > followUntil) {
      return abandon(["ERROR: the preview did not come up within 30 minutes; it was stopped."]);
    }
    spawnSync("sleep", ["1"]);
  }
  flushLog();
  out("");
  out(`Preview '${parsed.name}' is running in ${unitName}.`);
  out(`  Stop:      ./raftdev preview stop ${parsed.name}   (or by id: ./raftdev preview stop ${id})`);
  return 0;
}

/**
 * The preview unit's main process. Runs `start` with the preview hooks,
 * publishes the record only after every recorded process is proven to be in
 * this unit's cgroup, then waits; SIGTERM (RuntimeMaxSec at the deadline,
 * `systemctl --user stop`, the cleaner) runs the teardown: cmdStop for the
 * containers, tmux and files, and the tunnel. KillMode=control-group signals
 * every process in the unit at the same time.
 */
function cmdPreviewUnit(specPath: string | undefined): number | void {
  if (!specPath) return 1;
  let spec: PreviewUnitSpec;
  try {
    spec = parsePreviewUnitSpec(readFileSync(specPath, "utf8"));
  } catch (error) {
    out(`ERROR: ${(error as Error).message}`);
    return 1;
  } finally {
    rmSync(specPath, { force: true });
  }
  for (const [key, value] of Object.entries(spec.env)) process.env[key] = value;
  const e = setupEnv(spec.name);
  const unitName = previewUnitName(spec.id);
  let published = false;
  const writeLaunch = (status: "running" | "failed", message?: string): void => {
    writeFileSync(previewLaunchFile(e), JSON.stringify({ status, message: message ?? null }) + "\n");
  };
  process.once("exit", () => { if (!published) writeLaunch("failed", "start did not complete; see the log"); });
  const invocationId = process.env.INVOCATION_ID?.trim() ?? "";
  if (!/^[0-9a-f]{32}$/.test(invocationId) || !isInUnitCgroup(procCgroup("self"), unitName)) {
    out(`ERROR: __preview-unit must run as ${unitName} (no INVOCATION_ID or a different cgroup).`);
    writeLaunch("failed", `not running inside ${unitName}`);
    published = true;
    return 1;
  }

  // Staged registration of one UUID. A SIGKILL/OOM kill of this process runs
  // no exit or SIGTERM cleanup, and Docker containers live outside the unit,
  // so every resource is recorded as soon as it exists and the cleaner's
  // timer can always remove it: the provisional record now (nothing created
  // yet), each container/volume right after creation, processes as they
  // start, and the final record (url, stage "running") after the cgroup check.
  const supervisorStarttime = procStarttime(process.pid);
  let current: PreviewRecord = provisionalPreviewRecord({
    id: spec.id,
    name: spec.name,
    owner: spec.owner,
    repo: PROJECT_DIR,
    branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: gitValue(["rev-parse", "HEAD"]),
    createdAt: new Date(spec.createdAt),
    deadlineAt: new Date(spec.deadlineAt),
    withAgentRuns: spec.withAgentRuns,
    resources: spec.resources,
    dockerMemoryCaps: { ...PREVIEW_DOCKER_MEMORY_CAPS },
    bootId: currentBootId(),
    unitInvocationId: invocationId,
    notify: spec.notify,
    reminderId: spec.reminderId,
  }, supervisorStarttime ? { pid: process.pid, starttime: supervisorStarttime, role: "supervisor" } : undefined);
  let registeredOnce = false;
  /** Registers `next`, or returns the reason it was refused (nothing is written then). */
  const register = (next: PreviewRecord): string | null => {
    const problems = [
      ...previewRecordProblems(next),
      ...(registeredOnce ? previewIdentityChanges(current, next).map((field) => `immutable ${field} changed`) : []),
      ...(registeredOnce ? previewDroppedResources(current, next).map((item) => `${item} would be dropped`) : []),
    ];
    if (problems.length > 0) return problems.join("; ");
    // The helper is the only writer (shared per-id lock, atomic write).
    const registered = sh(PREVIEW_CLEANER_PATH, ["--registry", spec.registryDir, "register"], {
      quiet: true,
      input: JSON.stringify(next),
    });
    if (registered.code !== 0) {
      return `raft-preview-cleaner register failed (exit ${registered.code}): ${registered.stderr.trim().slice(0, 240)}`;
    }
    current = next;
    registeredOnce = true;
    return null;
  };
  /** Inside start (failure cleanup armed): a refused register tears the start down. */
  const registerOrFail = (next: PreviewRecord, what: string): void => {
    const refused = register(next);
    if (refused === null) return;
    out(`ERROR: could not record ${what} for preview ${spec.id}: ${refused}`);
    out("  Tearing the start down; the URL is not published.");
    process.exit(1);
  };
  const provisionalRefused = register(current);
  if (provisionalRefused !== null) {
    out(`ERROR: could not register the provisional preview record: ${provisionalRefused}`);
    writeLaunch("failed", "provisional register failed");
    published = true;
    return 1;
  }
  out(`[raftdev] provisional record ${previewRecordPath(spec.registryDir, spec.id)} registered (stage starting).`);
  let containersRecorded = 0;

  let tunnelPid: number | undefined;
  cmdStart([spec.name, ...spec.startArgs, ...(spec.withAgentRuns ? ["--with-agent-runs"] : [])], {
    containerCreated(name) {
      const inspection = inspectPreviewContainer(name);
      if (inspection.state === "gone") return; // the create itself failed; start reports it
      if (inspection.state === "unknown") {
        out(`ERROR: cannot inspect just-created container ${name}: ${inspection.error}`);
        out("  Tearing the start down; the URL is not published.");
        process.exit(1);
      }
      registerOrFail(withPreviewContainer(current, inspection.id, inspection.volumeNames), `container ${name}`);
      containersRecorded += 1;
      if (containersRecorded === 1 && process.env.RAFTDEV_PREVIEW_HOLD_AFTER_FIRST_CONTAINER === "1") {
        // Test hook for the kill-during-start check: the first container is
        // recorded; hold here so the supervisor can be SIGKILLed.
        out(`[raftdev] HOLD: ${name} (${inspection.id}) is recorded; holding 600s (RAFTDEV_PREVIEW_HOLD_AFTER_FIRST_CONTAINER=1).`);
        spawnSync("sleep", ["600"]);
      }
    },
    volumeCreated(name) {
      const state = dockerInspectState(sh("docker", ["volume", "inspect", name], { quiet: true }));
      if (state === "gone") return;
      if (state === "unknown") {
        out(`ERROR: cannot inspect just-created volume ${name}; tearing the start down.`);
        process.exit(1);
      }
      registerOrFail(withPreviewVolume(current, name), `volume ${name}`);
    },
    processStarted(role, pid) {
      if (pid === undefined || pid <= 1) return;
      const starttime = procStarttime(pid);
      if (starttime === null) return;
      registerOrFail(withPreviewProcesses(current, [{ pid, starttime, role }]), `${role} process ${pid}`);
    },
    tmuxStarted() {
      const serverPid = Number(sh("tmux", ["display-message", "-p", "-t", e.TMUX_SESSION, "#{pid}"], { quiet: true }).stdout.trim());
      const starttime = Number.isInteger(serverPid) && serverPid > 1 ? procStarttime(serverPid) : null;
      if (starttime === null) {
        out(`ERROR: cannot identify the tmux server of ${e.TMUX_SESSION}; tearing the start down.`);
        process.exit(1);
      }
      registerOrFail(withPreviewProcesses(current, [{ pid: serverPid, starttime, role: "tmux-server" }]), "the tmux server");
    },
    onRunning(context) {
      tunnelPid = context.tunnelPid;
      // Wait (bounded) for the server and vite listeners so the record holds
      // those processes, not only their pane shells.
      const waitUntil = Date.now() + 120_000;
      while (Date.now() < waitUntil && !(portInUse(e.SERVER_PORT) && portInUse(e.WEB_PORT))) {
        spawnSync("sleep", ["2"]);
      }
      if (!(portInUse(e.SERVER_PORT) && portInUse(e.WEB_PORT))) {
        out("ERROR: server/web did not start listening within 120s; the preview is not published.");
        process.exit(1);
      }
      const collected = collectPreviewProcesses(e, context.tunnelPid);
      const stillAlive = (p: PreviewProcess): boolean => procStarttime(p.pid) === p.starttime;
      const processes = collected.filter(stillAlive);
      const docker = collectPreviewDocker(e);
      if (docker.errors.length > 0) {
        out("ERROR: Docker could not be queried for this preview's containers; the URL is not published:");
        for (const error of docker.errors) out(`  ${error}`);
        process.exit(1);
      }
      // Record everything before the cgroup check, so a kill during or after
      // it still leaves server, vite, cloudflared and the panes recorded.
      let staged = withPreviewProcesses(current, processes);
      for (const id of docker.containerIds) staged = withPreviewContainer(staged, id, []);
      for (const volume of docker.volumeNames) staged = withPreviewVolume(staged, volume);
      registerOrFail(staged, "the started processes");

      // A short-lived pane child that exited meanwhile is not checked.
      const outside = processesOutsideUnit(collected, unitName, (pid) => procCgroup(pid)).filter(stillAlive);
      const roles = new Set(current.processes.map((p) => p.role));
      if (outside.length > 0 || !roles.has("tmux-server") || !roles.has("cloudflared")) {
        out(`ERROR: not every preview process is inside ${unitName}; tearing down without publishing the URL:`);
        for (const p of outside) out(`  pid ${p.pid} (${p.role}) cgroup ${procCgroup(p.pid)?.trim() ?? "unreadable"}`);
        if (!roles.has("tmux-server")) out("  the tmux server was not found");
        if (!roles.has("cloudflared")) out("  cloudflared was not found");
        process.exit(1);
      }
      registerOrFail(runningPreviewRecord(current, {
        url: context.url,
        processes,
        containerIds: docker.containerIds,
        volumeNames: docker.volumeNames,
        dockerMemoryCaps: context.dockerMemoryCaps,
      }), "the final record");
      const record = current;

      // Only now is the URL printed (and so published).
      let accounts: ReturnType<typeof seedAccountsFromSeedFile> = [];
      try { accounts = seedAccountsFromSeedFile(readFileSync(e.SEED_FILE, "utf8")); } catch {}
      const remaining = Math.max(0, Math.floor((Date.parse(record.deadlineAt) - Date.now()) / 1000));
      out("");
      out(`=== Preview '${spec.name}' is up (${record.processes.length} processes checked inside ${unitName}) ===`);
      out(`  URL:       ${context.url}`);
      out(`  Deadline:  ${record.deadlineAt} UTC (in ${formatDuration(remaining)}; idle stop after ${formatDuration(record.idleTtlSeconds)}, whichever comes first)`);
      out(`  Resources: profile ${record.profile}, MemoryMax ${record.memoryMax}${record.memoryMaxOverride ? " (--memory-max)" : ""}; Docker caps ${Object.entries(record.dockerMemoryCaps).map(([k, v]) => `${k}=${v}`).join(" ")}`);
      for (const line of previewLoginLines({ url: context.url, withAgentRuns: context.withAgentRuns, accounts, env: process.env })) out(line);
      out(`  Record:    ${previewRecordPath(spec.registryDir, spec.id)}`);
      out(`  Stop:      ./raftdev preview stop ${spec.name}`);
      published = true;
      writeLaunch("running");
    },
  });

  let tearingDown = false;
  const teardown = (signal: NodeJS.Signals): void => {
    if (tearingDown) return;
    tearingDown = true;
    out(`[raftdev] ${unitName} received ${signal}; tearing the preview down.`);
    cmdStop(spec.name);
    // Signal the tunnel only while it is still the recorded process (same
    // boot, pid and starttime), never a reused pid.
    const tunnel = current.processes.find((p) => p.pid === tunnelPid && p.role === "cloudflared");
    if (tunnel && isRecordedProcessAlive(tunnel, current.bootId, currentBootId(), procStarttime)) {
      try { process.kill(tunnel.pid, "SIGTERM"); } catch {}
    }
    process.exit(process.exitCode ?? 0);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => teardown(signal));
  // The unit lives as long as this process: keep the event loop alive.
  setInterval(() => {}, 1 << 30);
}

/**
 * The janitor lives inside the preview unit that the stop kills, so it starts
 * the verified stop (`preview stop <id>`) as a separate transient unit. If
 * that cannot start, it stops its own unit (whose teardown removes the
 * containers and tunnel) and leaves the record to the cleaner's timer.
 */
function launchPreviewStopUnit(state: PreviewState, reason: "deadline" | "idle"): void {
  const env = hostBusEnv();
  const launched = sh("systemd-run", previewStopUnitArgs({
    id: state.id,
    reason,
    nodePath: process.execPath,
    raftdevScript: join(PROJECT_DIR, "scripts/dev/raftdev.ts"),
    workingDirectory: PROJECT_DIR,
    registryDir: state.registryDir,
    path: process.env.PATH ?? "/usr/bin:/bin",
    // Previews refuse Docker endpoint overrides at launch, so the stop uses the default daemon too.
    dockerEnv: {},
  }), { quiet: true, env });
  if (launched.code === 0) {
    out(`[raftdev] verified stop started as raft-preview-${state.id}-stop.service`);
    return;
  }
  out(`[raftdev] could not start the stop unit (exit ${launched.code}); stopping ${previewUnitName(state.id)} directly.`);
  sh("systemctl", ["--user", "stop", "--no-block", previewUnitName(state.id)], { quiet: true, env });
}

function cmdPreviewStop(args: string[]): number {
  const target = args[0];
  if (!target || target.startsWith("-")) {
    out("ERROR: usage: ./raftdev preview stop <name|id>");
    return 1;
  }
  const reasonIndex = args.indexOf("--reason");
  const reason = reasonIndex > 0 ? args[reasonIndex + 1] ?? "manual" : "manual";
  const registryDir = resolvePreviewRegistry();
  const records = listPreviewRecords(registryDir).flatMap((entry) => (entry.record ? [entry.record] : []));
  const selected = selectPreviewRecord(records, target, PROJECT_DIR);
  if ("error" in selected) {
    out(`ERROR: ${selected.error} in ${registryDir}.`);
    out("  For a plain raftdev environment use ./raftdev stop <name>.");
    return 1;
  }
  const { record } = selected;
  const recordPath = previewRecordPath(registryDir, record.id);
  out(`=== Stopping preview '${record.name}' (${record.id}, ${reason}) ===`);
  if (!previewCleanerInstalled()) {
    for (const line of PREVIEW_CLEANER_MISSING) out(line);
    out("Nothing was stopped.");
    return 1;
  }
  // The cleaner stops the matching unit invocation (whose teardown runs
  // cmdStop), signals only pid+starttime+boot matches, removes the recorded
  // containers and volumes, verifies, and deletes the record only on success.
  const env = hostBusEnv();
  const result = sh(PREVIEW_CLEANER_PATH, ["--registry", registryDir, "stop", record.id], { quiet: true, env });
  const parsed = parseCleanerStopOutput(result.stdout);
  if (result.code !== 0 || (parsed.outcome !== "cleaned" && parsed.outcome !== "absent")) {
    out(`ERROR: raft-preview-cleaner stop ${record.id}: ${parsed.outcome} (exit ${result.code}); the record is kept for retry.`);
    for (const line of parsed.detail) out(line);
    if (result.stderr.trim()) out(`  ${result.stderr.trim().slice(0, 240)}`);
    out(`  Details: ${join(registryDir, "results", `${record.id}.json`)}`);
    return 1;
  }
  // raftdev's own check of the same identities, from the record read before
  // the stop: a cleaner "cleaned" is not taken on trust.
  const verification = verifyPreviewCleanup(record, {
    bootId: currentBootId(),
    starttimeOf: procStarttime,
    unitActive: (name) => unitState(name, env).state,
    containerState: (id) => dockerInspectState(sh("docker", ["container", "inspect", id], { quiet: true })),
    volumeState: (volume) => dockerInspectState(sh("docker", ["volume", "inspect", volume], { quiet: true })),
  });
  if (!verification.ok || existsSync(recordPath)) {
    const recordGone = !existsSync(recordPath);
    out(recordGone
      ? `ERROR: raft-preview-cleaner reported "${parsed.outcome}" and removed the record, but raftdev's own check still finds:`
      : `ERROR: raft-preview-cleaner reported "${parsed.outcome}", but raftdev still finds:`);
    for (const line of formatCleanupLeftovers(verification, record.unitName)) out(line);
    if (!recordGone) out(`  the record ${recordPath}`);
    if (recordGone) out("  The record is gone, so the cleaner's timer will not retry these; nothing here is removed by raftdev.");
    out(`  Cleaner result: ${join(registryDir, "results", `${record.id}.json`)}`);
    out("  The reminder is kept. Report this to IT with the lines above and that result file.");
    return 1;
  }
  out(`Verified: unit, ${record.processes.length} processes, ${record.containerIds.length} containers and ${record.volumeNames.length} volumes are gone; record removed.`);
  const cancelled = cancelPreviewReminder(record.reminderId, runCommand);
  if (cancelled.attempted) out(cancelled.ok ? `Owner ${cancelled.message}.` : `WARNING: ${cancelled.message}`);
  if (record.repo === PROJECT_DIR) {
    const e = setupEnv(record.name);
    if (readPreviewState(e)?.id === record.id) {
      for (const file of [previewStateFile(e), previewLaunchFile(e), previewSpecFile(e)]) rmSync(file, { force: true });
    }
  }
  return 0;
}

function cmdPreviewList(args: string[]): number {
  const json = args.includes("--json");
  const registryDir = resolvePreviewRegistry();
  const now = Date.now();
  const boot = currentBootId();
  const entries = listPreviewRecords(registryDir);
  const summaries = entries.flatMap(({ path, record }) =>
    record
      ? [{ ...summarizePreviewRecord(record, now, boot, procStarttime), unitState: unitState(record.unitName, hostBusEnv()).state, recordPath: path }]
      : []);
  const invalid = entries.filter((entry) => !entry.record).map((entry) => entry.path);
  if (json) {
    process.stdout.write(JSON.stringify({ registry: registryDir, previews: summaries, invalidRecords: invalid }, null, 2) + "\n");
    return 0;
  }
  out(`Preview registry: ${registryDir}`);
  if (summaries.length === 0) out("No previews recorded.");
  for (const s of summaries) {
    out("");
    out(`${s.name}  ${s.id}  (owner ${s.owner}, branch ${s.branch})`);
    out(`  URL:       ${s.url ?? "(not published; stage starting)"}`);
    out(`  Deadline:  ${s.deadlineAt} (${s.remainingSeconds > 0 ? `${formatDuration(s.remainingSeconds)} left` : "passed"})`);
    out(`  Processes: ${s.processesAlive}/${s.processesRecorded} recorded processes alive; unit ${s.unitName} ${s.unitState === "present" ? "active" : s.unitState}`);
    out(`  Profile:   ${s.profile} (MemoryMax ${s.memoryMax})`);
    out(`  Repo:      ${s.repo}`);
  }
  for (const path of invalid) out(`WARNING: unreadable or non-contract record: ${path}`);
  return 0;
}

// ───────────────── dispatch ─────────────────

/**
 * NODE_COMPILE_CACHE on disk (~/.cache/raft-dev/node-compile-cache) for every
 * process raftdev starts, instead of Node's default under a possibly tmpfs
 * /tmp (scripts/dev/raftdev-cache.ts). An explicit value, CI and non-Linux are
 * left alone. Warnings (caches stay in RAM) are printed for `start` only.
 */
function applyDevCacheEnv(command: string): void {
  const paths = resolveDevCachePaths();
  if (paths.nodeCompileCache.source === "raft-dev" && paths.nodeCompileCache.path) {
    process.env.NODE_COMPILE_CACHE = paths.nodeCompileCache.path;
  }
  if (command === "start" || command === "preview") for (const w of paths.warnings) out(w);
}

async function main(argv: string[]): Promise<number | void> {
  const command = argv[0] ?? "";
  const envName = argv[1] ?? basename(PROJECT_DIR);
  if (command === "cache") return runCacheCli(argv.slice(1), { out });
  applyDevCacheEnv(command);
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
    case "stop":   validateTooling("stop"); cmdStop(envName); break;
    case "status": validateTooling("status"); cmdStatus(); break;
    case "seed":   cmdSeed(argv.slice(1)); break;
    case "script": cmdScript(argv.slice(1)); break;
    case "logs":   cmdLogs(envName); break;
    case "ports":  cmdPorts(envName); break;
    case "trace":  return runTraceCli(argv.slice(1), {
      projectDir: PROJECT_DIR,
      defaultEnvName: basename(PROJECT_DIR),
    });
    case "nuke":   validateTooling("nuke"); cmdNuke(); break;
    case "janitor": validateTooling("janitor"); cmdJanitor(envName, argv[2]); break;
    case "preview": return cmdPreview(argv.slice(1));
    case "__preview-unit": return cmdPreviewUnit(argv[1]);
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
