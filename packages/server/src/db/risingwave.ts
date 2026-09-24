import pg from "pg";
import { performance } from "node:perf_hooks";

export const RISINGWAVE_UNREAD_INBOX_CONTRACT_VERSION = 2;
export type RisingWaveInboxItemsServingVersion = 1 | 2 | 3;
export type RisingWaveInboxRfc056ServingMode = "off" | "shadow" | "on";
export const RISINGWAVE_UNREAD_INBOX_SERVING_VERSION: RisingWaveInboxItemsServingVersion = 2;
const DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS = 1_000;
const MIN_RISINGWAVE_CONNECTION_TIMEOUT_MS = 250;
const MAX_RISINGWAVE_CONNECTION_TIMEOUT_MS = 10_000;

export type RisingWavePoolState = {
  rw_pool_total: number;
  rw_pool_idle: number;
  rw_pool_waiting: number;
};

export type RisingWaveQueryRead<T extends pg.QueryResultRow = any> = {
  result: pg.QueryResult<T>;
  acquireWaitMs: number;
  poolState: RisingWavePoolState;
};

export function getRisingWaveInboxItemsServingVersion(): RisingWaveInboxItemsServingVersion {
  return RISINGWAVE_UNREAD_INBOX_SERVING_VERSION;
}

export function getRisingWaveInboxRfc056ServingMode(
  env: NodeJS.ProcessEnv = process.env,
): RisingWaveInboxRfc056ServingMode {
  const value = env.RISINGWAVE_INBOX_RFC056_SERVING_MODE?.trim().toLowerCase();
  if (value === "shadow" || value === "on") return value;
  // Fail closed for missing and invalid values. Operators must explicitly
  // authorize every RFC056 candidate read or serving transition.
  return "off";
}

let _risingWavePool: pg.Pool | null = null;
let _risingWaveUrl: string | null = null;

export function getRisingWaveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.RISINGWAVE_DATABASE_URL?.trim();
  return value ? value : null;
}

export function isRisingWaveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getRisingWaveDatabaseUrl(env));
}

export function isRisingWaveFollowedThreadStatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default-on once RisingWave is configured; set the version to "0" only for emergency rollback.
  return env.RISINGWAVE_FOLLOWED_THREAD_STATS_VERSION !== "0" && isRisingWaveConfigured(env);
}

export function getRisingWaveConnectionTimeoutMillis(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RISINGWAVE_CONNECTION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RISINGWAVE_CONNECTION_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.trunc(parsed), MIN_RISINGWAVE_CONNECTION_TIMEOUT_MS),
    MAX_RISINGWAVE_CONNECTION_TIMEOUT_MS,
  );
}

export async function queryRisingWave<T extends pg.QueryResultRow = any>(
  pool: pg.Pool,
  queryText: string,
  values?: unknown[],
): Promise<RisingWaveQueryRead<T>> {
  const acquireStartedAt = performance.now();
  const client = await pool.connect();
  const acquireWaitMs = performance.now() - acquireStartedAt;
  const poolState = getRisingWavePoolState(pool);
  try {
    const result = await client.query<T>(queryText, values);
    return { result, acquireWaitMs, poolState };
  } finally {
    client.release();
  }
}

export function getRisingWavePool(): pg.Pool | null {
  const databaseUrl = getRisingWaveDatabaseUrl();
  if (!databaseUrl) return null;

  if (_risingWavePool && _risingWaveUrl === databaseUrl) {
    return _risingWavePool;
  }

  if (_risingWavePool) {
    void _risingWavePool.end().catch((err) => {
      console.error("[risingwave] failed to close replaced pool:", err.message);
    });
  }

  _risingWaveUrl = databaseUrl;
  _risingWavePool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.RISINGWAVE_POOL_MAX || "10"),
    connectionTimeoutMillis: getRisingWaveConnectionTimeoutMillis(),
    idleTimeoutMillis: 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ssl: databaseUrl.includes("risingwave.cloud") ? { rejectUnauthorized: false } : undefined,
  });
  _risingWavePool.on("error", (err) => {
    console.error("[risingwave] unexpected pool error:", err.message);
  });
  return _risingWavePool;
}

export function getRisingWavePoolState(pool: pg.Pool | null = _risingWavePool): RisingWavePoolState {
  return {
    rw_pool_total: pool?.totalCount ?? 0,
    rw_pool_idle: pool?.idleCount ?? 0,
    rw_pool_waiting: pool?.waitingCount ?? 0,
  };
}

export async function closeRisingWavePool() {
  if (_risingWavePool) {
    await _risingWavePool.end();
  }
  _risingWavePool = null;
  _risingWaveUrl = null;
}
