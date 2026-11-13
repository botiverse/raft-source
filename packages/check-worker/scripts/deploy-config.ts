/**
 * The deploy's view of wrangler.jsonc (.github/workflows/deploy-check-worker.yml). Unlike the
 * content Worker's, this config names its two environments itself (their Worker names and
 * Raft's API origins are public); the deploy checks them, deploys `--env <env>`, and reads the
 * deployed version back.
 *
 *   tsx scripts/deploy-config.ts describe <env>
 *     Checks wrangler.jsonc and prints the environment as JSON: { name, apiOrigin, crons, browserPool }.
 *   tsx scripts/deploy-config.ts secrets <secret list JSON>
 *     `wrangler secret list --format json` names exactly the Worker's secrets.
 *   tsx scripts/deploy-config.ts select-version <deployments JSON> <message>
 *     The version the deploy with <message> deployed.
 *   tsx scripts/deploy-config.ts verify-version <version JSON> <env> <version id> <message> [--no-secrets]
 *     `wrangler versions view --json` has exactly the environment's bindings (BROWSER,
 *     RAFT_API_ORIGIN, CHECK_BROWSER_POOL) and the Worker's secret (none with --no-secrets: a
 *     first deploy).
 *
 * Never prints a secret's value: it reads names only.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** The Worker's secrets (src/config.ts CheckWorkerEnv), set by the deployment, never by this script. */
export const REQUIRED_SECRETS = ["ARTIFACTS_CHECK_WORKER_TOKEN"] as const;
export const DEPLOY_ENVS = ["staging", "production"] as const;
export type DeployEnvName = (typeof DEPLOY_ENVS)[number];
const BROWSER_BINDING = "BROWSER";
const VARS = ["CHECK_BROWSER_POOL", "RAFT_API_ORIGIN"] as const;
/** CHECK_BROWSER_POOL's values (src/config.ts browserPoolOn). */
const POOL_VALUES = ["on", "off"] as const;
type PoolValue = (typeof POOL_VALUES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;
export interface DeployEnv {
  name: string;
  apiOrigin: string;
  crons: string[];
  /** Warm browsers (src/pool.ts): at most one environment "on" per Cloudflare account. */
  browserPool: PoolValue;
}

export function parseJsonc(text: string, label: string): Json {
  const { config, error } = ts.parseConfigFileTextToJson(label, text);
  if (error || config === null || typeof config !== "object" || Array.isArray(config)) throw new Error(`${label} is not a JSON object`);
  return config as Json;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The bindings a section declares must be exactly the browser and the vars (a new one needs the deploy's readback too). */
function checkSection(section: Json, label: string): { apiOrigin: string; crons: string[]; browserPool: PoolValue } {
  for (const key of ["routes", "route", "r2_buckets", "d1_databases", "kv_namespaces", "durable_objects", "services", "queues", "hyperdrive", "analytics_engine_datasets"]) {
    if (key in section) throw new Error(`${label} declares ${key}, which the check Worker has no use for`);
  }
  const browser = section.browser;
  if (!isRecord(browser) || browser.binding !== BROWSER_BINDING || Object.keys(browser).length !== 1) throw new Error(`${label} must bind the browser as ${BROWSER_BINDING}`);
  const vars = section.vars;
  if (!isRecord(vars) || Object.keys(vars).sort().join(",") !== VARS.join(",")) throw new Error(`${label} vars must be exactly ${VARS.join(", ")}`);
  const browserPool = vars.CHECK_BROWSER_POOL;
  if (typeof browserPool !== "string" || !(POOL_VALUES as readonly string[]).includes(browserPool)) throw new Error(`${label} CHECK_BROWSER_POOL must be "on" or "off"`);
  const triggers = section.triggers;
  const crons = isRecord(triggers) && Array.isArray(triggers.crons) ? triggers.crons : null;
  if (crons === null || crons.length !== 1 || typeof crons[0] !== "string") throw new Error(`${label} must have exactly one cron trigger`);
  return { apiOrigin: String(vars.RAFT_API_ORIGIN), crons: crons as string[], browserPool: browserPool as PoolValue };
}

/** wrangler.jsonc checked, and the environment `envName` of it. */
export function describeEnv(baseText: string, envName: string): DeployEnv {
  if (!(DEPLOY_ENVS as readonly string[]).includes(envName)) throw new Error(`environment must be one of ${DEPLOY_ENVS.join(", ")}`);
  const base = parseJsonc(baseText, "wrangler.jsonc");
  if (base.workers_dev !== false) throw new Error("wrangler.jsonc must keep workers_dev: false (no host: the deploy token reaches this one Worker only)");
  if (base.preview_urls !== false) throw new Error("wrangler.jsonc must keep preview_urls: false");
  if (!Array.isArray(base.compatibility_flags) || !base.compatibility_flags.includes("nodejs_compat")) throw new Error("wrangler.jsonc must keep the nodejs_compat flag (@cloudflare/puppeteer needs it)");
  const top = checkSection(base, "wrangler.jsonc");
  if (top.apiOrigin !== "") throw new Error("wrangler.jsonc's top-level RAFT_API_ORIGIN must stay empty (the top level is no deployment)");
  if (top.browserPool !== "off") throw new Error("wrangler.jsonc's top-level CHECK_BROWSER_POOL must stay off");
  const envs = base.env;
  if (!isRecord(envs) || Object.keys(envs).sort().join(",") !== [...DEPLOY_ENVS].sort().join(",")) throw new Error(`wrangler.jsonc must have exactly the environments ${DEPLOY_ENVS.join(", ")}`);
  const section = envs[envName];
  if (!isRecord(section)) throw new Error(`wrangler.jsonc env.${envName} is not an object`);
  const name = section.name;
  if (typeof name !== "string" || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error(`env.${envName}.name is not a Worker name`);
  const { apiOrigin, crons, browserPool } = checkSection(section, `env.${envName}`);
  // Browser Rendering's sessions are one list per Cloudflare account, and a pooling Worker takes any
  // free one. So of the environments of one account at most one pools, and never staging.
  if (envName === "staging" && browserPool !== "off") throw new Error("env.staging CHECK_BROWSER_POOL must be off (it shares an account with production)");
  const pooling = DEPLOY_ENVS.filter((each) => isRecord(envs[each]) && isRecord((envs[each] as Json).vars) && ((envs[each] as Json).vars as Json).CHECK_BROWSER_POOL === "on");
  if (pooling.length > 1) throw new Error("at most one environment may have CHECK_BROWSER_POOL on while they share an account");
  if (!URL.canParse(apiOrigin) || new URL(apiOrigin).protocol !== "https:" || new URL(apiOrigin).origin !== apiOrigin) throw new Error(`env.${envName} RAFT_API_ORIGIN is not an https origin`);
  return { name, apiOrigin, crons, browserPool };
}

export function verifySecretList(text: string): void {
  const list = parseJson(text, "secret list");
  if (!Array.isArray(list) || list.some((each) => typeof each?.name !== "string" || each?.type !== "secret_text")) throw new Error("secret list must be an array of secret_text entries");
  const names = list.map((each) => each.name as string).sort();
  if (names.join(",") !== [...REQUIRED_SECRETS].sort().join(",")) throw new Error(`the Worker's secrets must be exactly ${REQUIRED_SECRETS.join(", ")}; found ${names.join(", ") || "none"}`);
}

/** As the content Worker's: the one deployment naming the message, else the newest; one version at 100 percent. */
export function selectVersionId(text: string, message: string): string {
  const deployments = parseJson(text, "deployment list");
  if (!Array.isArray(deployments)) throw new Error("deployment list must be an array");
  if (deployments.length === 0) throw new Error("no deployments");
  const named = deployments.filter((each) => each?.annotations?.["workers/message"] === message);
  if (named.length > 1) throw new Error(`expected at most one deployment with message ${message}, found ${named.length}`);
  const newest = () => [...deployments].sort((a, b) => String(b?.created_on ?? "").localeCompare(String(a?.created_on ?? "")))[0];
  const versions = (named[0] ?? newest()).versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100) throw new Error("the deployment must have exactly one version at 100 percent");
  const id = versions[0]?.version_id;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("deployment version id missing");
  return id;
}

type Binding = { name?: unknown; type?: unknown; [key: string]: unknown };

/** The deployed version: its message, exactly the browser binding and the vars (with the environment's values), and the secret. */
export function verifyVersion(text: string, expected: { env: DeployEnv; versionId: string; message: string; secrets: boolean }): void {
  const version = parseJson(text, "version readback") as Json | null;
  if (version?.id !== expected.versionId) throw new Error("version id readback mismatch");
  if ((version.annotations as Json | undefined)?.["workers/message"] !== expected.message) throw new Error("deploy message readback mismatch");
  const bindings = (version.resources as Json | undefined)?.bindings;
  if (!Array.isArray(bindings)) throw new Error("version bindings missing");
  const plain = (bindings as Binding[]).filter((each) => each.type !== "secret_text");
  const want = [BROWSER_BINDING, ...VARS].sort();
  const have = plain.map((each) => String(each.name)).sort();
  if (have.join(",") !== want.join(",")) throw new Error(`binding set mismatch: expected ${want.join(", ")}; found ${have.join(", ")}`);
  if (plain.filter((each) => each.name === BROWSER_BINDING && each.type === "browser").length !== 1) throw new Error(`expected one browser binding named ${BROWSER_BINDING}`);
  const origin = plain.filter((each) => each.name === "RAFT_API_ORIGIN" && each.type === "plain_text");
  if (origin.length !== 1 || origin[0]!.text !== expected.env.apiOrigin) throw new Error("RAFT_API_ORIGIN readback mismatch");
  const pool = plain.filter((each) => each.name === "CHECK_BROWSER_POOL" && each.type === "plain_text");
  if (pool.length !== 1 || pool[0]!.text !== expected.env.browserPool) throw new Error("CHECK_BROWSER_POOL readback mismatch");
  const secrets = (bindings as Binding[]).filter((each) => each.type === "secret_text").map((each) => String(each.name)).sort();
  const wantSecrets = expected.secrets ? [...REQUIRED_SECRETS].sort() : [];
  if (secrets.join(",") !== wantSecrets.join(",")) throw new Error(`secret names mismatch: expected ${wantSecrets.join(", ") || "none"}; found ${secrets.join(", ") || "none"}`);
}

async function main(argv: string[]): Promise<void> {
  const [mode, ...args] = argv;
  if (mode === "describe" && args.length === 1) {
    process.stdout.write(`${JSON.stringify(describeEnv(await readFile("wrangler.jsonc", "utf8"), args[0]!))}\n`);
  } else if (mode === "secrets" && args.length === 1) {
    verifySecretList(await readFile(args[0]!, "utf8"));
    process.stdout.write(`secrets present: ${REQUIRED_SECRETS.join(", ")}\n`);
  } else if (mode === "select-version" && args.length === 2) {
    process.stdout.write(`${selectVersionId(await readFile(args[0]!, "utf8"), args[1]!)}\n`);
  } else if (mode === "verify-version" && (args.length === 4 || (args.length === 5 && args[4] === "--no-secrets"))) {
    const [file, envName, versionId, message] = args as [string, string, string, string];
    const env = describeEnv(await readFile("wrangler.jsonc", "utf8"), envName);
    verifyVersion(await readFile(file, "utf8"), { env, versionId, message, secrets: args[4] !== "--no-secrets" });
    process.stdout.write(`version ${versionId}: bindings and secret names verified\n`);
  } else {
    throw new Error("usage: deploy-config.ts describe <env> | secrets <json> | select-version <json> <message> | verify-version <json> <env> <version id> <message> [--no-secrets]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
