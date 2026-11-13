// The check Worker's settings (wrangler.jsonc; README "Configuration"). A run with a setting
// missing or unusable leases nothing: it logs what is wrong (in words, never a value) and ends.
/** The server refuses a shorter ARTIFACTS_CHECK_WORKER_TOKEN (its CONTENT_TOKEN_MIN_BYTES, checkRoutes.ts). */
export const CHECK_WORKER_TOKEN_MIN_BYTES = 32;

export interface CheckWorkerEnv {
  /** Cloudflare Browser Rendering. */
  BROWSER: Fetcher;
  /** Raft's API, an https origin (`https://api.raft.build`): the lease and result routes are under it. */
  RAFT_API_ORIGIN: string;
  /** Secret: the bearer for Raft's /internal/artifacts-check/* (the server's ARTIFACTS_CHECK_WORKER_TOKEN). */
  ARTIFACTS_CHECK_WORKER_TOKEN?: string;
  /**
   * Warm browsers (pool.ts): "on" reuses the account's free sessions; "off", or absent, or
   * anything else, launches a session per check and closes it after, never connecting to another.
   * At most one pooling environment per Cloudflare account (README "Warm browsers").
   */
  CHECK_BROWSER_POOL?: string;
}

export type CheckWorkerConfig = { ok: true; origin: string; token: string; browserPool: boolean } | { ok: false; problem: string };

/** Whether the pool is on: only an exact "on" (a typo or no value is off: no session shared). */
export const browserPoolOn = (value: string | undefined): boolean => value?.trim() === "on";

export function configOf(env: Partial<CheckWorkerEnv>): CheckWorkerConfig {
  const origin = env.RAFT_API_ORIGIN?.trim() ?? "";
  if (!origin) return { ok: false, problem: "RAFT_API_ORIGIN is not set" };
  if (!URL.canParse(origin) || new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
    return { ok: false, problem: "RAFT_API_ORIGIN is not an https origin" };
  const token = env.ARTIFACTS_CHECK_WORKER_TOKEN?.trim() ?? "";
  if (!token) return { ok: false, problem: "ARTIFACTS_CHECK_WORKER_TOKEN is not set" };
  if (new TextEncoder().encode(token).length < CHECK_WORKER_TOKEN_MIN_BYTES)
    return { ok: false, problem: `ARTIFACTS_CHECK_WORKER_TOKEN is shorter than ${CHECK_WORKER_TOKEN_MIN_BYTES} bytes` };
  if (env.BROWSER === undefined || typeof env.BROWSER.fetch !== "function") return { ok: false, problem: "the BROWSER binding is missing" };
  return { ok: true, origin, token, browserPool: browserPoolOn(env.CHECK_BROWSER_POOL) };
}
