import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationSources } from "../../db/pgliteMigrations";

// One migrated PGlite datadir per run instead of one per test file. The
// globalSetup (pgliteTemplate.global.ts) ensures the file exists, building it
// in a child process so the migration memory peak never sits in Vitest, and
// hands its path to workers through `provide`; database.ts restores each test
// database from it. See src/test/integration/README.md.

/** Bump when the template's build or restore contract changes. */
export const TEMPLATE_FORMAT_VERSION = 1;
export const TEMPLATE_PROVIDE_KEY = "pgliteTemplatePath";
export const TEMPLATE_ENV = "RAFT_TEST_PGLITE_TEMPLATE";
export const TEMPLATE_KEEP = 3;
export const STALE_TMP_MS = 60 * 60 * 1000;

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const TEMPLATE_CACHE_DIR = path.join(SERVER_ROOT, "node_modules", ".cache", "raft-pglite-template");
const BUILD_SCRIPT = fileURLToPath(new URL("./pgliteTemplate.build.ts", import.meta.url));

declare module "vitest" {
  export interface ProvidedContext {
    pgliteTemplatePath?: string;
  }
}

export type TemplateMode = "reuse" | "rebuild" | "off";

/** RAFT_TEST_PGLITE_TEMPLATE: unset = reuse, `rebuild` = force a fresh build, `off` = no template. */
export function templateMode(env: NodeJS.ProcessEnv = process.env): TemplateMode {
  const raw = env[TEMPLATE_ENV];
  if (raw === undefined || raw === "") return "reuse";
  if (raw === "rebuild" || raw === "off") return raw;
  throw new Error(`${TEMPLATE_ENV} must be unset, "rebuild" or "off", got ${JSON.stringify(raw)}`);
}

export function computeTemplateKey(input: {
  journal: string;
  migrations: Array<{ tag: string; sql: string }>;
  compatibilityStatements: string[];
  pgliteVersion: string;
  formatVersion?: number;
}): string {
  const hash = createHash("sha256");
  const part = (label: string, value: string) => hash.update(`${label}\0${value.length}\0${value}\0`);
  part("format", String(input.formatVersion ?? TEMPLATE_FORMAT_VERSION));
  part("pglite", input.pgliteVersion);
  part("journal", input.journal);
  for (const migration of input.migrations) part(`sql:${migration.tag}`, migration.sql);
  for (const statement of input.compatibilityStatements) part("compat", statement);
  return hash.digest("hex").slice(0, 32);
}

export function templateFileName(key: string): string {
  return `pglite-template-${key}.tar`;
}

export async function installedPgliteVersion(): Promise<string> {
  // The package's exports map hides package.json; walk up from its entry.
  let dir = path.dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@electric-sql/pglite" && pkg.version) return pkg.version;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Cannot find the installed @electric-sql/pglite version");
    dir = parent;
  }
}

export async function currentTemplateKey(): Promise<string> {
  const [sources, pgliteVersion] = await Promise.all([readMigrationSources(), installedPgliteVersion()]);
  return computeTemplateKey({ ...sources, pgliteVersion });
}

/**
 * Keep the newest `keep` templates (by mtime; `current` always survives) and
 * remove temporary files older than `staleTmpMs` left by interrupted builds.
 */
export async function pruneTemplateDir(dir: string, options: {
  current?: string;
  keep?: number;
  staleTmpMs?: number;
  now?: number;
} = {}): Promise<string[]> {
  const keep = options.keep ?? TEMPLATE_KEEP;
  const staleTmpMs = options.staleTmpMs ?? STALE_TMP_MS;
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const templates: Array<{ name: string; mtimeMs: number }> = [];
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith("pglite-template-")) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    if (name.endsWith(".tmp")) {
      if (now - info.mtimeMs > staleTmpMs) {
        await rm(file, { force: true });
        removed.push(name);
      }
    } else if (name.endsWith(".tar")) {
      templates.push({ name, mtimeMs: info.mtimeMs });
    }
  }
  templates.sort((a, b) => (b.name === options.current ? 1 : 0) - (a.name === options.current ? 1 : 0) || b.mtimeMs - a.mtimeMs);
  for (const { name } of templates.slice(keep)) {
    await rm(path.join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

export type TemplateSource =
  | { kind: "file"; path: string }
  | { kind: "processLocal"; warn: boolean };

/**
 * How openTestDatabase gets its in-memory baseline. A Vitest worker without a
 * template path is a misconfiguration: warn locally, fail in CI. Non-Vitest
 * callers (Playwright server, scripts) keep the process-local snapshot.
 */
export function decideTemplateSource(input: { underVitest: boolean; templatePath?: string; ci: boolean }): TemplateSource {
  if (input.templatePath) return { kind: "file", path: input.templatePath };
  if (!input.underVitest) return { kind: "processLocal", warn: false };
  if (input.ci) {
    throw new Error(
      "PGlite test template missing: the server Vitest globalSetup (src/test/setup/pgliteTemplate.global.ts) " +
        "did not provide pgliteTemplatePath. CI refuses to migrate every test file from scratch.",
    );
  }
  return { kind: "processLocal", warn: true };
}

export const MISSING_TEMPLATE_WARNING =
  "[pglite-template] PGlite test template missing (no pgliteTemplatePath from globalSetup); " +
  "this test file migrates from scratch. See src/test/integration/README.md.";

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

function buildInChild(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "@oxc-node/core/register", BUILD_SCRIPT, file], {
      cwd: SERVER_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`PGlite template build failed (exit ${code ?? signal}): ${BUILD_SCRIPT}`));
    });
  });
}

/** Ensure the current template file exists; returns its path, or undefined when disabled. */
export async function ensureTemplate(env: NodeJS.ProcessEnv = process.env, dir = TEMPLATE_CACHE_DIR): Promise<string | undefined> {
  const mode = templateMode(env);
  if (mode === "off") return undefined;
  const name = templateFileName(await currentTemplateKey());
  const file = path.join(dir, name);
  if (mode === "rebuild" || !(await exists(file))) {
    const started = Date.now();
    await buildInChild(file);
    const { size } = await stat(file);
    console.log(`[pglite-template] built ${name} (${(size / 1024 / 1024).toFixed(1)} MiB) in ${Date.now() - started} ms`);
  } else {
    const now = new Date();
    await utimes(file, now, now);
  }
  await pruneTemplateDir(dir, { current: name });
  return file;
}
