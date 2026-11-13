import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

export const BILLING_DELETION_TEST_DATABASE = "billing_deletion_test";
const TEST_PASSWORD = "synthetic-billing-test-only";

export interface BillingDeletionTestTarget {
  readonly url: string;
  readonly pool: { host: "127.0.0.1"; port: number; database: string; user: "postgres"; password: string; ssl: false; max: number; connectionTimeoutMillis: number; application_name: string; options: string };
}

/** Refuse before loading business modules or constructing any connection. */
export function billingDeletionTestTarget(env: NodeJS.ProcessEnv): BillingDeletionTestTarget {
  const raw = env.BILLING_DELETION_REAL_PG_URL;
  if (env.BILLING_DELETION_DISPOSABLE_INSTANCE !== "1" || !raw) throw new Error("Billing deletion tests require an explicitly disposable local database");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("Billing deletion test target is invalid"); }
  const port = Number(parsed.port);
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)
    || !new Set(["127.0.0.1", "localhost"]).has(parsed.hostname)
    || !Number.isInteger(port) || port < 1024 || port > 65535
    || parsed.pathname !== `/${BILLING_DELETION_TEST_DATABASE}`
    || parsed.username !== "postgres" || (parsed.password !== "" && parsed.password !== TEST_PASSWORD)
    || parsed.search !== "" || parsed.hash !== "") throw new Error("Billing deletion tests accept only their designated local disposable database");
  return {
    url: `postgresql://postgres:${TEST_PASSWORD}@127.0.0.1:${port}/${BILLING_DELETION_TEST_DATABASE}`,
    pool: { host: "127.0.0.1", port, database: BILLING_DELETION_TEST_DATABASE, user: "postgres", password: TEST_PASSWORD, ssl: false, max: 4, connectionTimeoutMillis: 2_000, application_name: "raft-billing-deletion-test", options: "-c application_name=raft-billing-deletion-test" },
  };
}

/** No HTTP is needed: provider and mail transports are synthetic fixtures. */
function noHttp<T extends (...args: never[]) => unknown>(_original: T): T {
  return (() => { throw new Error("Billing deletion tests refuse HTTP delivery"); }) as unknown as T;
}

/** Own safety boundary: no inherited provider/PG credentials or HTTP delivery.
 * The callback is where pg, billing and email modules may first be loaded.
 */
export async function withBillingDeletionIsolation<T>(env: NodeJS.ProcessEnv, work: (target: BillingDeletionTestTarget) => Promise<T>): Promise<T> {
  const target = billingDeletionTestTarget(env);
  const keys = new Set([...Object.keys(env).filter(key => key.startsWith("PG") || key.startsWith("STRIPE_")),
    "RESEND_API_KEY", "FROM_EMAIL", "DATABASE_URL", "PAID_LIFECYCLE_EMAIL_MODE", "JWT_SECRET", "NODE_ENV",
    "STRIPE_SECRET_KEY", "STRIPE_BILLING_ENABLED", "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID", "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID", "STRIPE_WEBHOOK_SECRET"]);
  const old = [...keys].map(key => [key, env[key]] as const);
  const original = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, fetch: globalThis.fetch };
  try {
    for (const key of keys) delete env[key];
    Object.assign(env, { NODE_ENV: "test", DATABASE_URL: target.url, RESEND_API_KEY: "", FROM_EMAIL: "Raft test <noreply@example.test>", STRIPE_SECRET_KEY: "sk_test_synthetic_only", STRIPE_BILLING_ENABLED: "true", STRIPE_PRO_SEAT_MONTHLY_PRICE_ID: "price_pro_seat", STRIPE_PRO_SEAT_ANNUAL_PRICE_ID: "price_pro_seat_annual", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_only", PAID_LIFECYCLE_EMAIL_MODE: "disabled", JWT_SECRET: "synthetic-billing-deletion-test-signing-key" });
    http.request = noHttp(original.httpRequest); http.get = noHttp(original.httpGet);
    https.request = noHttp(original.httpsRequest); https.get = noHttp(original.httpsGet);
    globalThis.fetch = noHttp(original.fetch);
    syncBuiltinESMExports();
    return await work(target);
  } finally {
    http.request = original.httpRequest; http.get = original.httpGet;
    https.request = original.httpsRequest; https.get = original.httpsGet;
    globalThis.fetch = original.fetch; syncBuiltinESMExports();
    for (const [key, value] of old) value === undefined ? delete env[key] : env[key] = value;
  }
}
