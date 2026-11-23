/**
 * A project config (ProjectSpec v2): everything raft-perf needs to know about one
 * product's web — public or signed-in, single-milestone (`ready`) or multi-milestone
 * (`shell` + `ready`), with optional per-environment page paths (`paths`) and environment
 * scoping (`envs`) — so the commands themselves carry no product's name (#proj-frontend:#74).
 *
 * JSON in `packages/perf/projects/<project>.json`. Pure, pinned by `project.test.ts`.
 *
 * Security invariant: `auth` configs name environment variables (`STAMP_SESSION`,
 * `STAMP_STORAGE_STATE`), NEVER literal tokens, cookies, or file contents. Unknown keys
 * and hex/single-word token-like strings in `*Env` fields are rejected at parse time.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ReadySignal {
  /** A CSS selector; ready when an element matching it is visible. */
  selector: string;
  /** Also require that element to hold some text (default true): an empty shell is not content. */
  hasText?: boolean;
}

export interface ProjectCookieSpec {
  /** Cookie name (e.g. `__Host-raft_git_gateway_session`). */
  name: string;
  /** Environment variable holding the cookie value at runtime (e.g. `STAMP_SESSION`). */
  valueEnv: string;
}

export type ProjectAuthConfig =
  | {
      kind: "cookie";
      cookie: ProjectCookieSpec;
      optionalCookies?: ProjectCookieSpec[];
      /** Optional fallback environment variable holding a path to a Playwright `storageState` JSON file. */
      storageStateEnv?: string;
    }
  | {
      kind: "storage-state";
      /** Environment variable holding a path to a Playwright `storageState` JSON file. */
      pathEnv: string;
    };

export interface ProjectPage {
  name: string;
  /** Default path on the origin, starting with "/" (required unless `paths` covers every applicable env). */
  path: string;
  /** Optional per-environment path overrides (e.g. `{ "staging": "/github/stamp-build/stamp-setup-test", "production": "/github/botiverse/mobile" }`). */
  paths?: Record<string, string>;
  /** Optional list of environment names where this page exists (default: all environments). */
  envs?: string[];
  /** Set `false` on public pages (e.g. `/sign-in`) inside an otherwise signed-in project so they neither require nor attach session cookies. */
  auth?: boolean;
  /** Optional app-chrome milestone (e.g. top navigation bar visible before async data arrives). */
  shell?: ReadySignal;
  /** Primary content-ready milestone ("first post / row / heading visible"). */
  ready: ReadySignal;
}

export interface ProjectEnv {
  origin: string;
  auth?: ProjectAuthConfig;
}

export interface ProjectConfig {
  project: string;
  auth?: ProjectAuthConfig;
  envs: Record<string, ProjectEnv>;
  pages: ProjectPage[];
}

export interface ResolvedCookie {
  name: string;
  value: string;
  url: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Lax";
}

export interface ResolvedProjectAuth {
  authenticated: boolean;
  storageStatePath: string | null;
  cookies: ResolvedCookie[];
  /** Non-empty secret values read from `process.env` so callers scrub them from any diagnostic text. */
  secretsToScrub: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const ENV_VAR = /^[A-Z][A-Z0-9_]{2,63}$/;
const HEX_ONLY = /^[0-9A-F_]+$/;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOGIN_REDIRECT_PATH = /^\/(login|signin|sign-in|auth)(\/|$)/i;

/**
 * Validate an environment variable name: must be `UPPER_SNAKE_CASE` with at least one `_`
 * and at least one non-hex letter (`G-Z`), rejecting literal hex tokens or bare words.
 */
function isSafeEnvVarName(value: unknown): value is string {
  return typeof value === "string" && ENV_VAR.test(value) && value.includes("_") && !HEX_ONLY.test(value);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  bad: (what: string) => never,
): void {
  const allowSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowSet.has(key)) {
      bad(`${label} has unknown field "${key}" (allowed: ${allowed.join(", ")})`);
    }
  }
}

function parseReadySignal(raw: unknown, label: string, bad: (what: string) => never): ReadySignal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return bad(`${label} must be an object with "selector"`);
  }
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, ["selector", "hasText"], label, bad);
  if (typeof r.selector !== "string" || !r.selector.trim()) {
    return bad(`${label}.selector is required`);
  }
  return {
    selector: r.selector,
    hasText: r.hasText !== false,
  };
}

function parseCookieSpec(raw: unknown, label: string, bad: (what: string) => never): ProjectCookieSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return bad(`${label} must be an object with "name" and "valueEnv"`);
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(obj, ["name", "valueEnv"], label, bad);
  if (typeof obj.name !== "string" || !COOKIE_NAME.test(obj.name)) {
    return bad(`${label}.name must be a valid HTTP cookie name`);
  }
  if (!isSafeEnvVarName(obj.valueEnv)) {
    return bad(
      `${label}.valueEnv must be an UPPER_SNAKE_CASE environment variable name like STAMP_SESSION (never a literal token or hex string)`,
    );
  }
  return { name: obj.name, valueEnv: obj.valueEnv };
}

function parseAuthConfig(raw: unknown, label: string, bad: (what: string) => never): ProjectAuthConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return bad(`${label} must be an object`);
  }
  const a = raw as Record<string, unknown>;
  if (a.kind === "cookie") {
    rejectUnknownKeys(a, ["kind", "cookie", "optionalCookies", "storageStateEnv"], label, bad);
    const cookie = parseCookieSpec(a.cookie, `${label}.cookie`, bad);
    let optionalCookies: ProjectCookieSpec[] | undefined;
    if (a.optionalCookies !== undefined) {
      if (!Array.isArray(a.optionalCookies)) bad(`${label}.optionalCookies must be an array`);
      optionalCookies = (a.optionalCookies as unknown[]).map((c, idx) =>
        parseCookieSpec(c, `${label}.optionalCookies[${idx}]`, bad),
      );
    }
    let storageStateEnv: string | undefined;
    if (a.storageStateEnv !== undefined) {
      if (!isSafeEnvVarName(a.storageStateEnv)) {
        bad(`${label}.storageStateEnv must be an UPPER_SNAKE_CASE environment variable name`);
      }
      storageStateEnv = a.storageStateEnv as string;
    }
    return {
      kind: "cookie",
      cookie,
      ...(optionalCookies ? { optionalCookies } : {}),
      ...(storageStateEnv ? { storageStateEnv } : {}),
    };
  }
  if (a.kind === "storage-state") {
    rejectUnknownKeys(a, ["kind", "pathEnv"], label, bad);
    if (!isSafeEnvVarName(a.pathEnv)) {
      return bad(`${label}.pathEnv must be an UPPER_SNAKE_CASE environment variable name`);
    }
    return { kind: "storage-state", pathEnv: a.pathEnv };
  }
  return bad(`${label}.kind must be "cookie" or "storage-state"`);
}

/** Validates a parsed config; throws naming the first thing that is wrong. */
export function parseProjectConfig(raw: unknown, source = "project config"): ProjectConfig {
  const bad = (what: string): never => {
    throw new Error(`${source}: ${what}`);
  };
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || Array.isArray(c)) return bad("not an object");
  rejectUnknownKeys(c, ["project", "auth", "envs", "pages"], "root", bad);
  if (typeof c.project !== "string" || !NAME.test(c.project)) bad(`"project" must be a lowercase name like raft-web`);
  const topAuth = c.auth !== undefined ? parseAuthConfig(c.auth, `"auth"`, bad) : undefined;
  if (!c.envs || typeof c.envs !== "object" || Array.isArray(c.envs) || !Object.keys(c.envs as object).length) {
    bad(`"envs" needs at least one named environment`);
  }
  const envs: Record<string, ProjectEnv> = {};
  for (const [name, rawEnv] of Object.entries(c.envs as Record<string, unknown>)) {
    if (!NAME.test(name)) bad(`env name "${name}" must be a lowercase name like production`);
    const envObj = rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv) ? (rawEnv as Record<string, unknown>) : null;
    if (envObj) rejectUnknownKeys(envObj, ["origin", "auth"], `env "${name}"`, bad);
    let origin: string;
    try {
      const u = new URL(typeof envObj?.origin === "string" ? envObj.origin : "");
      if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
      // an origin only: a path here would be silently dropped, so it is refused (put paths in "pages")
      if (u.pathname !== "/" || u.search || u.hash) throw new Error("path");
      origin = u.origin;
    } catch {
      return bad(`env "${name}" needs an http(s) "origin" with no path (paths go in "pages")`);
    }
    const envAuth = envObj?.auth !== undefined ? parseAuthConfig(envObj.auth, `env "${name}".auth`, bad) : undefined;
    envs[name] = {
      origin,
      ...(envAuth ? { auth: envAuth } : {}),
    };
  }
  const declaredEnvNames = Object.keys(envs);
  if (!Array.isArray(c.pages) || !c.pages.length) bad(`"pages" needs at least one page`);
  const seen = new Set<string>();
  const pages = (c.pages as unknown[]).map((rawPage, i): ProjectPage => {
    const p = rawPage && typeof rawPage === "object" && !Array.isArray(rawPage) ? (rawPage as Record<string, unknown>) : null;
    if (!p || typeof p.name !== "string" || !NAME.test(p.name)) bad(`page ${i}: "name" must be a lowercase name`);
    const pageName = p!.name as string;
    rejectUnknownKeys(p!, ["name", "path", "paths", "envs", "auth", "shell", "ready"], `page "${pageName}"`, bad);
    if (seen.has(pageName)) bad(`page "${pageName}" is listed twice`);
    seen.add(pageName);

    let pageEnvs: string[] | undefined;
    if (p!.envs !== undefined) {
      if (!Array.isArray(p!.envs) || p!.envs.length === 0) {
        bad(`page "${pageName}": "envs" must be a non-empty array of environment names`);
      }
      pageEnvs = (p!.envs as unknown[]).map((e) => {
        if (typeof e !== "string" || !Object.hasOwn(envs, e)) {
          bad(`page "${pageName}": unknown env ${JSON.stringify(e)} in "envs" (has: ${declaredEnvNames.join(", ")})`);
        }
        return e as string;
      });
    }

    let pathsMap: Record<string, string> | undefined;
    if (p!.paths !== undefined) {
      if (!p!.paths || typeof p!.paths !== "object" || Array.isArray(p!.paths)) {
        bad(`page "${pageName}": "paths" must be an object mapping env names to "/..." paths`);
      }
      pathsMap = {};
      for (const [envKey, val] of Object.entries(p!.paths as Record<string, unknown>)) {
        if (!Object.hasOwn(envs, envKey)) {
          bad(`page "${pageName}": unknown env "${envKey}" in "paths" (has: ${declaredEnvNames.join(", ")})`);
        }
        if (typeof val !== "string" || !val.startsWith("/")) {
          return bad(`page "${pageName}": paths.${envKey} must start with "/"`);
        }
        pathsMap[envKey] = val;
      }
    }

    const activeEnvs = pageEnvs ?? declaredEnvNames;
    let defaultPath: string;
    if (typeof p!.path === "string") {
      if (!p!.path.startsWith("/")) bad(`page "${pageName}": "path" must start with "/"`);
      defaultPath = p!.path;
    } else if (pathsMap && activeEnvs.every((e) => typeof pathsMap![e] === "string")) {
      defaultPath = pathsMap[activeEnvs[0]!]!;
    } else {
      return bad(`page "${pageName}": "path" must start with "/" (or provide "paths" for every active env)`);
    }

    if (!p!.ready || typeof (p!.ready as { selector?: unknown }).selector !== "string" || !(p!.ready as { selector: string }).selector.trim()) {
      bad(`page "${pageName}": "ready.selector" is required (what shows the page's own content is on screen)`);
    }
    const ready = parseReadySignal(p!.ready, `page "${pageName}": ready`, bad);
    const shell = p!.shell !== undefined ? parseReadySignal(p!.shell, `page "${pageName}": shell`, bad) : undefined;
    if (p!.auth !== undefined && typeof p!.auth !== "boolean") {
      bad(`page "${pageName}": "auth" must be a boolean when given`);
    }
    return {
      name: pageName,
      path: defaultPath,
      ...(pathsMap ? { paths: pathsMap } : {}),
      ...(pageEnvs ? { envs: pageEnvs } : {}),
      ...(typeof p!.auth === "boolean" ? { auth: p!.auth } : {}),
      ...(shell ? { shell } : {}),
      ready,
    };
  });
  return {
    project: c.project as string,
    ...(topAuth ? { auth: topAuth } : {}),
    envs,
    pages,
  };
}

/**
 * Load a project config either by built-in name (`stamp` -> `projects/stamp.json`)
 * or by file path (`projects/raft-design.json`).
 */
export function loadProjectConfig(nameOrPath: string): ProjectConfig {
  const trimmed = nameOrPath.trim();
  if (!trimmed) throw new Error("--project needs a project name (e.g. stamp, raft-design) or a JSON file path");
  if (NAME.test(trimmed)) {
    const builtin = new URL(`../projects/${trimmed}.json`, import.meta.url);
    if (existsSync(builtin)) {
      return parseProjectConfig(JSON.parse(readFileSync(builtin, "utf8")), `project ${trimmed}`);
    }
  }
  const full = resolve(trimmed);
  if (!existsSync(full)) {
    throw new Error(`--project ${trimmed}: no built-in project "${trimmed}" and no file at ${full}`);
  }
  return parseProjectConfig(JSON.parse(readFileSync(full, "utf8")), trimmed);
}

/**
 * The env and pages a run was asked for (resolving per-env `paths[envName]` onto `page.path`
 * and filtering out pages scoped to other environments); throws when the config has no such env or page.
 */
export function selectRun(config: ProjectConfig, envName: string, pageName?: string): { env: ProjectEnv; pages: ProjectPage[] } {
  const env =
    (Object.hasOwn(config.envs, envName) ? config.envs[envName] : undefined) ??
    (() => {
      throw new Error(`${config.project} has no env "${envName}" (has: ${Object.keys(config.envs).join(", ")})`);
    })();

  const bindPath = (p: ProjectPage): ProjectPage => {
    const envPath = p.paths && Object.hasOwn(p.paths, envName) ? p.paths[envName] : undefined;
    return envPath ? { ...p, path: envPath } : p;
  };

  if (!pageName) {
    const applicable = config.pages.filter((p) => !p.envs || p.envs.includes(envName)).map(bindPath);
    if (applicable.length === 0) {
      throw new Error(`${config.project} has no pages configured for env "${envName}"`);
    }
    return { env, pages: applicable };
  }
  const page =
    config.pages.find((p) => p.name === pageName) ??
    (() => {
      throw new Error(`${config.project} has no page "${pageName}" (has: ${config.pages.map((p) => p.name).join(", ")})`);
    })();
  if (page.envs && !page.envs.includes(envName)) {
    throw new Error(
      `${config.project} page "${pageName}" is not configured for env "${envName}" (configured for: ${page.envs.join(", ")})`,
    );
  }
  return { env, pages: [bindPath(page)] };
}

/**
 * Detect whether a signed-in page load hit an authentication / sign-in wall:
 *   1. HTTP 302 or SPA router redirect to `/login`, `/signin`, `/sign-in`, `/auth`, or cross-host OAuth, OR
 *   2. An in-place SPA login wall where the URL stays on `expectedPath` (e.g. Stamp `/pulls` or `/`)
 *      while `/api/...` returned HTTP `401` or fetched `/api/<scope>/sign-in`.
 */
export function detectAuthRedirect(
  pageUsesAuth: boolean,
  targetOriginHost: string,
  expectedPath: string,
  currentUrlStr: string,
  apiSamples: ReadonlyArray<{ route: string; status: number | null }> = [],
): { redirectedToAuth: boolean; finalPath: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(currentUrlStr);
  } catch {
    return { redirectedToAuth: false, finalPath: null };
  }
  const finalPath = parsed.pathname;
  if (!pageUsesAuth) {
    return { redirectedToAuth: false, finalPath };
  }
  const crossHost = parsed.host !== targetOriginHost;
  const loginWallUrl = finalPath !== expectedPath && LOGIN_REDIRECT_PATH.test(finalPath);
  const inPlaceApiAuthWall = apiSamples.some(
    (s) => s.status === 401 || /^\/api\/([^/]+\/)?(sign-in|signin|login)(\?|$)/i.test(s.route),
  );
  return {
    redirectedToAuth: crossHost || loginWallUrl || inPlaceApiAuthWall,
    finalPath,
  };
}

/**
 * Resolve authentication inputs for `config` + `envName` from `envVars` (and optional CLI `--storage-state`).
 * Never includes secret values in thrown error messages.
 */
export function resolveProjectAuth(
  config: ProjectConfig,
  envName: string,
  envVars: Record<string, string | undefined>,
  options: { storageStateFile?: string; unauthenticated?: boolean } = {},
): ResolvedProjectAuth {
  if (options.unauthenticated) {
    return { authenticated: false, storageStatePath: null, cookies: [], secretsToScrub: [] };
  }
  const env = selectRun(config, envName).env;
  const auth = env.auth ?? config.auth;
  const secureOrigin = env.origin.startsWith("https://");
  const cookieUrl = `${env.origin}/`;

  if (options.storageStateFile) {
    const full = resolve(options.storageStateFile);
    if (!existsSync(full)) {
      throw new Error(`--storage-state file does not exist: ${full}`);
    }
    return { authenticated: true, storageStatePath: full, cookies: [], secretsToScrub: [] };
  }

  if (!auth) {
    return { authenticated: false, storageStatePath: null, cookies: [], secretsToScrub: [] };
  }

  if (auth.kind === "storage-state") {
    const rawPath = envVars[auth.pathEnv]?.trim();
    if (!rawPath) {
      throw new Error(`${config.project}/${envName} requires signed-in state: set ${auth.pathEnv} or pass --storage-state <file>`);
    }
    const full = resolve(rawPath);
    if (!existsSync(full)) {
      throw new Error(`${auth.pathEnv} points to a missing file: ${full}`);
    }
    return { authenticated: true, storageStatePath: full, cookies: [], secretsToScrub: [] };
  }

  // `auth.kind === "cookie"`
  const token = envVars[auth.cookie.valueEnv]?.trim();
  if (token) {
    const secretsToScrub = [token];
    const cookies: ResolvedCookie[] = [
      {
        name: auth.cookie.name,
        value: token,
        url: cookieUrl,
        secure: secureOrigin || auth.cookie.name.startsWith("__Host-") || auth.cookie.name.startsWith("__Secure-"),
        httpOnly: true,
        sameSite: "Lax",
      },
    ];
    for (const extra of auth.optionalCookies ?? []) {
      const val = envVars[extra.valueEnv]?.trim();
      if (val) {
        secretsToScrub.push(val);
        cookies.push({
          name: extra.name,
          value: val,
          url: cookieUrl,
          secure: secureOrigin || extra.name.startsWith("__Host-") || extra.name.startsWith("__Secure-"),
          httpOnly: false,
          sameSite: "Lax",
        });
      }
    }
    return { authenticated: true, storageStatePath: null, cookies, secretsToScrub };
  }

  if (auth.storageStateEnv) {
    const statePath = envVars[auth.storageStateEnv]?.trim();
    if (statePath) {
      const full = resolve(statePath);
      if (!existsSync(full)) {
        throw new Error(`${auth.storageStateEnv} points to a missing file: ${full}`);
      }
      return { authenticated: true, storageStatePath: full, cookies: [], secretsToScrub: [] };
    }
  }

  const hints = [auth.cookie.valueEnv, ...(auth.storageStateEnv ? [auth.storageStateEnv] : [])].join(" or ");
  throw new Error(
    `${config.project}/${envName} requires authentication: set ${hints} (or pass --storage-state <file>, or --unauthenticated to measure logged-out redirects)`,
  );
}

/** Scrub any known secret token values from diagnostic text before logging or serializing. */
export function scrubAuthSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.replaceAll(secret, "<redacted>");
    }
  }
  return out;
}
