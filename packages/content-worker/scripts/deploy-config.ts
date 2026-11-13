/**
 * The deploy's view of wrangler.jsonc, for a deployment that keeps its real
 * names out of this package (wrangler.jsonc carries placeholders only).
 *
 *   tsx scripts/deploy-config.ts render <env> <output>
 *     Writes wrangler.jsonc plus one `env.<env>` section built from
 *     CONTENT_WORKER_NAME, CONTENT_WORKER_R2_BUCKET, CONTENT_WORKER_R2_ENDPOINT,
 *     CONTENT_WORKER_D1_DATABASE_NAME, CONTENT_WORKER_D1_DATABASE_ID,
 *     CONTENT_WORKER_CONTENT_DOMAIN, CONTENT_WORKER_APP_ORIGIN,
 *     CONTENT_WORKER_EXTRA_APP_ORIGINS (optional),
 *     CONTENT_WORKER_FRAMED_BY_ORIGINS (optional),
 *     CONTENT_WORKER_EMBEDS and CONTENT_WORKER_EMBED_DOMAIN (optional, together) and
 *     CONTENT_WORKER_RAFT_API_URL. No R2 binding: the Worker reads its bucket
 *     with a read-only token (R2_ENDPOINT, R2_BUCKET, R2_READ_*). Deploy with
 *     `--config <output> --env <env>`. The output must sit beside wrangler.jsonc
 *     (`main` and `migrations_dir` are relative to it).
 *   tsx scripts/deploy-config.ts secrets <secret list JSON>
 *     `wrangler secret list --format json` names exactly the Worker's secrets.
 *   tsx scripts/deploy-config.ts select-version <deployments JSON> <message>
 *     The version `wrangler deploy --message <message>` deployed (selectVersionId).
 *   tsx scripts/deploy-config.ts verify-version <version JSON> <rendered config> <env> <version id> <message> [--no-secrets]
 *     `wrangler versions view --json` has exactly the rendered bindings and the
 *     Worker's secrets (none with --no-secrets: a first deploy, before they are synced).
 *
 * Never prints a secret's value: it reads names only.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { extraAppOriginsOf, framedByOriginsOf } from "../src/appOrigins";

/** The Worker's secrets (RaftContentEnv), set on it by the deployment, never by this script. */
export const REQUIRED_SECRETS = ["PORTHOLE_SECRET", "RAFT_API_TOKEN", "RAFT_TOKENS", "R2_READ_ACCESS_KEY_ID", "R2_READ_SECRET_ACCESS_KEY"] as const;
/** The Worker's vars, sorted. */
const VARS = ["APP_ORIGIN", "CONTENT_DOMAIN", "EMBEDS", "EMBED_DOMAIN", "EXTRA_APP_ORIGINS", "FRAMED_BY_ORIGINS", "R2_BUCKET", "R2_ENDPOINT", "RAFT_API_URL"] as const;
const D1_BINDING = "TICKETS";
/** An account's R2 S3 endpoint, an origin: `https://<account id>[.<jurisdiction>].r2.cloudflarestorage.com`. */
const R2_ENDPOINT = /^https:\/\/[0-9a-f]{32}(?:\.[a-z]+)?\.r2\.cloudflarestorage\.com$/;

type Json = Record<string, unknown>;
type D1Database = { binding: string; database_name: string; database_id: string; migrations_dir?: string };
export type DeployEnv = {
  name: string;
  d1_databases: D1Database[];
  vars: Record<(typeof VARS)[number], string>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

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

function required(env: NodeJS.ProcessEnv, name: string, pattern: RegExp | null, what: string): string {
  const value = env[name]?.trim() ?? "";
  if (!value) throw new Error(`missing ${name}`);
  if (pattern && !pattern.test(value)) throw new Error(`${name} is not ${what}`);
  return value;
}

/** An https URL: an origin alone, or a URL with no query, fragment or trailing slash. */
function httpsUrl(env: NodeJS.ProcessEnv, name: string, originOnly: boolean): string {
  const value = required(env, name, null, "");
  const url = URL.canParse(value) ? new URL(value) : null;
  const ok =
    url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    (originOnly ? value === url.origin : !value.endsWith("/"));
  if (!ok) throw new Error(`${name} is not an https ${originOnly ? "origin" : "URL without a trailing slash"}`);
  return value;
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
const siteOf = (host: string) => host.split(".").slice(-2).join(".");

/**
 * The embed settings (Porthole P143; src/services/embed.ts): EMBEDS `1` or `true` turns embeds on
 * (`0`, `false` or unset: off, the kill switch), and then EMBED_DOMAIN is required. The embed host
 * is a lowercase host on the content domain's site (so the content frame can require a same-site
 * request) but never the content domain nor under it, and never on the app's or the API's site.
 */
function embedVarsOf(env: NodeJS.ProcessEnv, contentDomain: string, appOrigin: string, raftApiUrl: string): { EMBEDS: string; EMBED_DOMAIN: string } {
  const embeds = env.CONTENT_WORKER_EMBEDS?.trim().toLowerCase() ?? "";
  if (!["", "0", "1", "false", "true"].includes(embeds)) throw new Error("CONTENT_WORKER_EMBEDS is not 1, true, 0, false or empty");
  const domain = env.CONTENT_WORKER_EMBED_DOMAIN?.trim() ?? "";
  if (domain === "") {
    if (embeds === "1" || embeds === "true") throw new Error("CONTENT_WORKER_EMBEDS is on without CONTENT_WORKER_EMBED_DOMAIN");
    return { EMBEDS: embeds, EMBED_DOMAIN: "" };
  }
  if (!HOST.test(domain)) throw new Error("CONTENT_WORKER_EMBED_DOMAIN is not a lowercase host name (no scheme, port or path)");
  if (under(domain, contentDomain)) throw new Error("CONTENT_WORKER_EMBED_DOMAIN overlaps the content domain");
  if (siteOf(domain) !== siteOf(contentDomain)) throw new Error("CONTENT_WORKER_EMBED_DOMAIN is not on the content domain's site");
  for (const [label, url] of [["APP_ORIGIN", appOrigin], ["RAFT_API_URL", raftApiUrl]] as const) {
    if (siteOf(new URL(url).hostname) === siteOf(domain)) throw new Error(`CONTENT_WORKER_EMBED_DOMAIN is on ${label}'s site`);
  }
  return { EMBEDS: embeds, EMBED_DOMAIN: domain };
}

/** The committed config the deploy starts from: placeholders only, the shape this script fills in. */
function checkBase(base: Json): { d1: D1Database } {
  for (const key of ["routes", "route", "env"]) {
    if (key in base) throw new Error(`wrangler.jsonc must not declare "${key}" (routes are managed outside wrangler; the deploy adds env)`);
  }
  if (base.workers_dev !== true) throw new Error("wrangler.jsonc must keep workers_dev: true (the issue route's host)");
  if (base.preview_urls !== false) throw new Error("wrangler.jsonc must keep preview_urls: false");
  // An R2 binding can put, delete and list across its whole bucket: the Worker reads with a read-only token.
  if ("r2_buckets" in base) throw new Error("wrangler.jsonc must not bind an R2 bucket (the Worker reads R2 with a read-only token)");
  const d1 = base.d1_databases;
  if (!Array.isArray(d1) || d1.length !== 1 || (d1[0] as Json)?.binding !== D1_BINDING)
    throw new Error(`wrangler.jsonc must bind exactly one D1 database, ${D1_BINDING}`);
  const vars = base.vars;
  if (vars === null || typeof vars !== "object" || Object.keys(vars).sort().join(",") !== VARS.join(","))
    throw new Error(`wrangler.jsonc vars must be exactly ${VARS.join(", ")} (the deploy sets each; a new one needs the deploy too)`);
  for (const key of ["durable_objects", "kv_namespaces", "services", "queues", "hyperdrive", "analytics_engine_datasets"]) {
    if (key in base) throw new Error(`wrangler.jsonc declares ${key}, which the deploy does not render`);
  }
  return { d1: d1[0] as D1Database };
}

/** wrangler.jsonc with one environment, `env`, filled in from the deploy's values. */
export function renderDeployConfig(baseText: string, envName: string, env: NodeJS.ProcessEnv): Json {
  if (!/^[a-z][a-z0-9-]*$/.test(envName)) throw new Error("environment name must be lowercase letters, digits and dashes");
  const base = parseJsonc(baseText, "wrangler.jsonc");
  const { d1 } = checkBase(base);
  const name = required(env, "CONTENT_WORKER_NAME", /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "a Worker name");
  const bucket = required(env, "CONTENT_WORKER_R2_BUCKET", /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "an R2 bucket name");
  const endpoint = required(env, "CONTENT_WORKER_R2_ENDPOINT", R2_ENDPOINT, "an R2 S3 endpoint origin (https://<account id>.r2.cloudflarestorage.com)");
  const databaseName = required(env, "CONTENT_WORKER_D1_DATABASE_NAME", /^[a-z0-9][a-z0-9_-]{0,63}$/, "a D1 database name");
  const databaseId = required(env, "CONTENT_WORKER_D1_DATABASE_ID", UUID, "a D1 database id (lowercase UUID)");
  if (databaseId === "00000000-0000-0000-0000-000000000000") throw new Error("CONTENT_WORKER_D1_DATABASE_ID is the placeholder");
  if (databaseId === d1.database_id) throw new Error("CONTENT_WORKER_D1_DATABASE_ID is wrangler.jsonc's placeholder");
  const contentDomain = required(env, "CONTENT_WORKER_CONTENT_DOMAIN", HOST, "a lowercase host name (no scheme, port or path)");
  const appOrigin = httpsUrl(env, "CONTENT_WORKER_APP_ORIGIN", true);
  const raftApiUrl = httpsUrl(env, "CONTENT_WORKER_RAFT_API_URL", false);
  // Optional; checked as the Worker checks it (a bad entry would make the content domain a 503).
  const extraAppOrigins = extraAppOriginsOf(env.CONTENT_WORKER_EXTRA_APP_ORIGINS);
  for (const origin of extraAppOrigins) {
    if (origin.startsWith("https:") && under(new URL(origin).hostname, contentDomain))
      throw new Error("EXTRA_APP_ORIGINS has a host that overlaps the content domain");
  }
  // Optional; checked as the Worker checks it (none an app origin), and apart from the content domain.
  const framedByOrigins = framedByOriginsOf(env.CONTENT_WORKER_FRAMED_BY_ORIGINS, [appOrigin, ...extraAppOrigins]);
  for (const origin of framedByOrigins) {
    if (under(new URL(origin).hostname, contentDomain)) throw new Error("FRAMED_BY_ORIGINS has a host that overlaps the content domain");
  }
  // The content domain is Porthole's alone: the app and its API must live elsewhere.
  for (const [label, url] of [["APP_ORIGIN", appOrigin], ["RAFT_API_URL", raftApiUrl]] as const) {
    if (under(new URL(url).hostname, contentDomain)) throw new Error(`${label}'s host overlaps the content domain`);
  }
  const embedVars = embedVarsOf(env, contentDomain, appOrigin, raftApiUrl);
  const section: DeployEnv = {
    name,
    d1_databases: [
      {
        binding: D1_BINDING,
        database_name: databaseName,
        database_id: databaseId,
        ...(d1.migrations_dir === undefined ? {} : { migrations_dir: d1.migrations_dir }),
      },
    ],
    vars: {
      APP_ORIGIN: appOrigin,
      CONTENT_DOMAIN: contentDomain,
      ...embedVars,
      EXTRA_APP_ORIGINS: extraAppOrigins.join(","),
      FRAMED_BY_ORIGINS: framedByOrigins.join(","),
      R2_BUCKET: bucket,
      R2_ENDPOINT: endpoint,
      RAFT_API_URL: raftApiUrl,
    },
  };
  return { ...base, env: { [envName]: section } };
}

/** The one environment of a rendered config. */
export function deployEnvOf(rendered: Json, envName: string): DeployEnv {
  const envs = rendered.env as Record<string, DeployEnv> | undefined;
  if (!envs || Object.keys(envs).join(",") !== envName) throw new Error(`rendered config must have exactly the environment ${envName}`);
  return envs[envName]!;
}

export function verifySecretList(text: string): void {
  const list = parseJson(text, "secret list");
  if (!Array.isArray(list) || list.some((each) => typeof each?.name !== "string" || each?.type !== "secret_text"))
    throw new Error("secret list must be an array of secret_text entries");
  const names = new Set(list.map((each) => each.name as string));
  const missing = REQUIRED_SECRETS.filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !(REQUIRED_SECRETS as readonly string[]).includes(name)).sort();
  if (missing.length || extra.length)
    throw new Error(
      `the Worker's secrets must be exactly ${REQUIRED_SECRETS.join(", ")}` +
        (missing.length ? `; missing: ${missing.join(", ")}` : "") +
        (extra.length ? `; unexpected: ${extra.join(", ")}` : ""),
    );
}

/**
 * `wrangler deploy --message` puts the message on the version it uploads; the
 * deployment it makes carries none (its annotations are `workers/triggered_by`).
 * So: the one deployment that does name the message (a `versions deploy
 * --message`), else the newest deployment. Either way verify-version then
 * requires the version's own message, so another deploy's version is refused.
 */
export function selectVersionId(text: string, message: string): string {
  const deployments = parseJson(text, "deployment list");
  if (!Array.isArray(deployments)) throw new Error("deployment list must be an array");
  if (deployments.length === 0) throw new Error("no deployments");
  const named = deployments.filter((each) => each?.annotations?.["workers/message"] === message);
  if (named.length > 1) throw new Error(`expected at most one deployment with message ${message}, found ${named.length}`);
  const newest = () => [...deployments].sort((a, b) => String(b?.created_on ?? "").localeCompare(String(a?.created_on ?? "")))[0];
  const versions = (named[0] ?? newest()).versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100)
    throw new Error("the deployment must have exactly one version at 100 percent");
  const id = versions[0]?.version_id;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("deployment version id missing");
  return id;
}

type Binding = { name?: unknown; type?: unknown; [key: string]: unknown };

function one(bindings: Binding[], name: string, type: string): Binding {
  const found = bindings.filter((each) => each.name === name && each.type === type);
  if (found.length !== 1) throw new Error(`expected one ${type} binding named ${name}`);
  return found[0]!;
}

/** The deployed version: the message it was deployed with, and exactly the rendered bindings (no R2 binding) plus the secrets. */
export function verifyVersion(text: string, expected: { env: DeployEnv; versionId: string; message: string; secrets: boolean }): void {
  const version = parseJson(text, "version readback") as Json | null;
  if (version?.id !== expected.versionId) throw new Error("version id readback mismatch");
  if ((version.annotations as Json | undefined)?.["workers/message"] !== expected.message) throw new Error("deploy message readback mismatch");
  const bindings = (version.resources as Json | undefined)?.bindings;
  if (!Array.isArray(bindings)) throw new Error("version bindings missing");
  const plain = (bindings as Binding[]).filter((each) => each.type !== "secret_text");
  const want = [D1_BINDING, ...VARS].sort();
  const have = plain.map((each) => String(each.name)).sort();
  if (have.join(",") !== want.join(",")) throw new Error(`binding set mismatch: expected ${want.join(", ")}; found ${have.join(", ")}`);
  if (one(bindings, D1_BINDING, "d1").id !== expected.env.d1_databases[0]!.database_id) throw new Error("D1 database readback mismatch");
  for (const name of VARS) {
    if (one(bindings, name, "plain_text").text !== expected.env.vars[name]) throw new Error(`${name} readback mismatch`);
  }
  const secrets = (bindings as Binding[])
    .filter((each) => each.type === "secret_text")
    .map((each) => String(each.name))
    .sort();
  const wantSecrets = expected.secrets ? [...REQUIRED_SECRETS].sort() : [];
  if (secrets.join(",") !== wantSecrets.join(","))
    throw new Error(`secret names mismatch: expected ${wantSecrets.join(", ") || "none"}; found ${secrets.join(", ") || "none"}`);
}

async function main(argv: string[]): Promise<void> {
  const [mode, ...args] = argv;
  if (mode === "render" && args.length === 2) {
    const [envName, output] = args as [string, string];
    const rendered = renderDeployConfig(await readFile("wrangler.jsonc", "utf8"), envName, process.env);
    await writeFile(output, `${JSON.stringify(rendered, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`rendered ${output} (env ${envName})\n`);
  } else if (mode === "secrets" && args.length === 1) {
    verifySecretList(await readFile(args[0]!, "utf8"));
    process.stdout.write(`secrets present: ${REQUIRED_SECRETS.join(", ")}\n`);
  } else if (mode === "select-version" && args.length === 2) {
    process.stdout.write(`${selectVersionId(await readFile(args[0]!, "utf8"), args[1]!)}\n`);
  } else if (mode === "verify-version" && (args.length === 5 || (args.length === 6 && args[5] === "--no-secrets"))) {
    const [file, config, envName, versionId, message] = args as [string, string, string, string, string];
    const env = deployEnvOf(parseJson(await readFile(config, "utf8"), config) as Json, envName);
    verifyVersion(await readFile(file, "utf8"), { env, versionId, message, secrets: args[5] !== "--no-secrets" });
    process.stdout.write(`version ${versionId}: bindings and secret names verified\n`);
  } else {
    throw new Error("usage: deploy-config.ts render <env> <output> | secrets <json> | select-version <json> <message> | verify-version <json> <config> <env> <version id> <message> [--no-secrets]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
