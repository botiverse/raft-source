/**
 * A project config: everything raft-perf needs to know about one product's
 * web, so the commands themselves carry no product's name. JSON in
 * packages/perf/projects/<project>.json. Pure, pinned by project.test.ts.
 *
 *   {
 *     "project": "raft-design",
 *     "envs": { "production": { "origin": "https://raft-design.botiverse.build" } },
 *     "pages": [ { "name": "home", "path": "/", "ready": { "selector": "main h1" } } ]
 *   }
 *
 * `ready` says when the page's own content is on screen: the moment a person
 * would call it loaded. It is the product's equivalent of "first post visible".
 */

export interface ReadySignal {
  /** A CSS selector; ready when an element matching it is visible. */
  selector: string;
  /** Also require that element to hold some text (default true): an empty shell is not content. */
  hasText?: boolean;
}

export interface ProjectPage {
  name: string;
  /** Path on the origin, starting with "/". */
  path: string;
  ready: ReadySignal;
}

export interface ProjectEnv {
  origin: string;
}

export interface ProjectConfig {
  project: string;
  envs: Record<string, ProjectEnv>;
  pages: ProjectPage[];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Validates a parsed config; throws naming the first thing that is wrong. */
export function parseProjectConfig(raw: unknown, source = "project config"): ProjectConfig {
  const bad = (what: string): never => {
    throw new Error(`${source}: ${what}`);
  };
  const c = raw as Partial<ProjectConfig> | null;
  if (!c || typeof c !== "object") return bad("not an object");
  if (typeof c.project !== "string" || !NAME.test(c.project)) bad(`"project" must be a lowercase name like raft-web`);
  if (!c.envs || typeof c.envs !== "object" || Array.isArray(c.envs) || !Object.keys(c.envs).length) bad(`"envs" needs at least one named environment`);
  const envs: Record<string, ProjectEnv> = {};
  for (const [name, env] of Object.entries(c.envs!)) {
    if (!NAME.test(name)) bad(`env name "${name}" must be a lowercase name like production`);
    let origin: string;
    try {
      const u = new URL((env as ProjectEnv)?.origin);
      if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
      // an origin only: a path here would be silently dropped, so it is refused (put paths in "pages")
      if (u.pathname !== "/" || u.search || u.hash) throw new Error("path");
      origin = u.origin;
    } catch {
      return bad(`env "${name}" needs an http(s) "origin" with no path (paths go in "pages")`);
    }
    envs[name] = { origin };
  }
  if (!Array.isArray(c.pages) || !c.pages.length) bad(`"pages" needs at least one page`);
  const seen = new Set<string>();
  const pages = c.pages!.map((p, i) => {
    if (!p || typeof p.name !== "string" || !NAME.test(p.name)) bad(`page ${i}: "name" must be a lowercase name`);
    if (seen.has(p.name)) bad(`page "${p.name}" is listed twice`);
    seen.add(p.name);
    if (typeof p.path !== "string" || !p.path.startsWith("/")) bad(`page "${p.name}": "path" must start with "/"`);
    if (!p.ready || typeof p.ready.selector !== "string" || !p.ready.selector.trim()) bad(`page "${p.name}": "ready.selector" is required (what shows the page's own content is on screen)`);
    return { name: p.name, path: p.path, ready: { selector: p.ready.selector, hasText: p.ready.hasText !== false } };
  });
  return { project: c.project!, envs, pages };
}

/** The env and pages a run was asked for; throws when the config has no such env or page. */
export function selectRun(config: ProjectConfig, envName: string, pageName?: string): { env: ProjectEnv; pages: ProjectPage[] } {
  const env = (Object.hasOwn(config.envs, envName) ? config.envs[envName] : undefined) ?? (() => { throw new Error(`${config.project} has no env "${envName}" (has: ${Object.keys(config.envs).join(", ")})`); })();
  if (!pageName) return { env, pages: config.pages };
  const page = config.pages.find((p) => p.name === pageName) ?? (() => { throw new Error(`${config.project} has no page "${pageName}" (has: ${config.pages.map((p) => p.name).join(", ")})`); })();
  return { env, pages: [page] };
}
