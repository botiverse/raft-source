// The app's startup chunk grouping (Rolldown codeSplitting groups), shared by
// the web build (vite.config.ts) and Raft Desktop's renderer build
// (apps/desktop/frontend/vite.config.ts): both bundle this app from its own
// entry. Moved here unchanged from vite.config.ts.
import type { Rolldown } from "vite";

// Match a module id that belongs to one of the named npm packages (pnpm layout
// nests them as .../node_modules/<name>/...).
export const NODE_MODULES = /[\\/]node_modules[\\/]/;

export function vendorPackages(names: string[]): RegExp {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  return new RegExp(`[\\\\/]node_modules[\\\\/](?:${escaped.join("|")})[\\\\/]`);
}
// ricons is the design system's own icons, moved out of raft-ui in 0.95: it
// stays in raft-ui's chunk, so a ricons release renames only that one.
export const RAFT_UI = vendorPackages(["@botiverse/raft-ui", "@botiverse/ricons"]);
// Packages split out of vendor-startup so a small change in one of them does
// not rename the whole 750 KB chunk: the minifier renumbers every identifier
// in a chunk when any module in it changes. v1.21.61 -> v1.21.62 changed only
// lucide-react (+2.9 KB, new icons) and @base-ui/react (-1 KB, after a raft-ui
// upgrade), yet all of vendor-startup got a new name (task #164).
export const ICONS = vendorPackages(["lucide-react"]);
export const BASE_UI = /[\\/]node_modules[\\/]@base-ui[\\/]/;
// The two largest of the rest (zod 182 KB, axios 112 KB rendered). A chunk's
// module order follows execution order, so when the app's import order moves
// one library past another, every identifier after it is renumbered: with only
// icons and Base UI split out, vendor-startup kept identical bytes from
// v1.21.61 to v1.21.62 but zustand moved before axios, and the file still got
// a new name. Two groups, not four, so the first screen stays within Raft
// Desktop's bundle-size gate (baseline 9 files + 2; Tenny, task #164).
export const ZOD = vendorPackages(["zod"]);
export const AXIOS = vendorPackages(["axios"]);

// The app's own startup code that changes about once a week, not once a
// release: the small workspace packages (sync-core, runtime-form with its
// released forms) and generated data (the Pi model catalog, pinyin, reaction
// sprites, pixel avatars). Measured over 1,400 staging commits (2026-11-11),
// none of it changed in 99% of 20-commit windows, while every folder of the
// web app and packages/shared changed in nearly all of them. Each of these
// imports nothing from the app, so the group takes no app module with it (a
// group also takes the dependencies of what it captures).
export const APP_STABLE = /[\\/]packages[\\/](?:sync-core|runtime-form)[\\/]|\.generated\.ts$|[\\/]packages[\\/]web[\\/]src[\\/]generated[\\/]|[\\/]packages[\\/]shared[\\/](?:src[\\/]generated|assets)[\\/]/;

// Modules the entry loads at startup, computed once per build. Rolldown 1.2
// emits such a module as its own common chunk whenever a lazy route also
// imports it, even though the entry has already loaded it
// (rolldown/rolldown#10731), which turned the first paint into ~100 requests.
// Grouping this closure restores what Rollup produced: the entry plus a few files.
//
// The import graph is not tree-shaken, so a plain walk would pass through
// re-export barrels (e.g. @botiverse/raft-shared -> @botiverse/raft-sync-core)
// and pull lazy-only modules such as the Activity runtime into startup. A
// barrel's re-export edge is followed only when its target is itself a barrel
// or declares (not merely re-exports) a name that some startup module imports.
//
// A bundled library's barrel has the same meaning in another form: raft-ui's
// dist/index.mjs and dist/wip.mjs are `import { a, b as c } from "./x";` lines
// and one `export { a, c };`. Read as a plain module, every component behind
// them joined the startup closure, so vendor-raft-ui carried each raft-ui part
// any lazy page uses (FitToolbar, SelectionToolbar, Lightbox...).
const REEXPORT_STATEMENT = /^export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["'][^"']+["'];?$/;
const NAMED_IMPORT = /import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']/g;
const NAMESPACE_IMPORT = /import\s*(?:[\w$]+\s*,\s*)?\*\s*as\s/;

const IMPORT_LIST_STATEMENT = /^import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']$/;
const SIDE_EFFECT_IMPORT_STATEMENT = /^import\s*["'](\.[^"']*)["']$/;
const LOCAL_EXPORT_STATEMENT = /^export\s*\{([^}]*)\}$/;

function barrelStatements(code: string): string[] {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .split(/;\s*|\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

interface ImportExportBarrel {
  /** Exported name -> the name its source module exports (`import { Dialog as X }; export { X }`). */
  sources: Map<string, string>;
  /** Relative specifiers of its side-effect imports (`import "./lib/drag-escape.mjs"`), always followed. */
  sideEffectImports: string[];
}

/** An `import { ... } from; export { ... }` barrel (a bundler's output), or null for any other module. */
function importExportBarrel(code: string | null): ImportExportBarrel | null {
  if (!code) return null;
  const imported = new Map<string, string>();
  const exported = new Map<string, string>();
  const sideEffectImports: string[] = [];
  for (const statement of barrelStatements(code)) {
    const importList = IMPORT_LIST_STATEMENT.exec(statement);
    const sideEffect = SIDE_EFFECT_IMPORT_STATEMENT.exec(statement);
    const exportList = LOCAL_EXPORT_STATEMENT.exec(statement);
    const list = importList ?? exportList;
    if (sideEffect) {
      sideEffectImports.push(sideEffect[1]);
      continue;
    }
    if (!list) return null;
    for (const part of list[1].split(",")) {
      const [name, alias = name] = part.trim().split(/\s+as\s+/);
      if (!name) continue;
      (importList ? imported : exported).set(alias, name);
    }
  }
  if (exported.size === 0) return null;
  const sources = new Map<string, string>();
  for (const [name, local] of exported) {
    const source = imported.get(local);
    if (source !== undefined) sources.set(name, source);
  }
  return { sources, sideEffectImports };
}

function isReexportBarrel(code: string | null): boolean {
  if (!code) return false;
  const statements = barrelStatements(code);
  if (statements.length > 0 && statements.every((statement) => REEXPORT_STATEMENT.test(statement))) return true;
  return importExportBarrel(code) !== null;
}

/** Whether `target` is the module the relative specifier `spec` in module `from` names (ids use forward slashes). */
function resolvesTo(from: string, spec: string, target: string): boolean {
  const parts = from.split("/").slice(0, -1);
  for (const segment of spec.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/") === target;
}

const LOCAL_EXPORT_LIST = /export\s*\{([^}]*)\}\s*(?!\s*from)(?:;|$)/gm;

// Names a module declares itself. `import { x } from "./y"; export { x };` is a
// re-export in disguise, so exported bindings that were imported are skipped.
function declaredExports(code: string): Set<string> {
  const importedBindings = new Set<string>();
  for (const [, list] of code.matchAll(NAMED_IMPORT)) {
    for (const part of list.split(",")) {
      const local = part.trim().split(/\s+as\s+/).pop();
      if (local) importedBindings.add(local);
    }
  }
  const names = new Set<string>();
  for (const [, name] of code.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) {
    names.add(name);
  }
  if (/export\s+default\b/.test(code)) names.add("default");
  for (const [, list] of code.matchAll(LOCAL_EXPORT_LIST)) {
    for (const part of list.split(",")) {
      const [local, exported = local] = part.trim().split(/\s+as\s+/);
      if (local && !importedBindings.has(local)) names.add(exported);
    }
  }
  return names;
}

function computeStartupClosure(entry: string, ctx: Rolldown.ChunkingContext): Set<string> {
  const importedNames = new Set<string>(["default"]);
  // Barrels imported by a module that uses `import * as`: every re-export counts.
  const wholeBarrels = new Set<string>();
  for (;;) {
    const closure = new Set<string>();
    const sizeBefore = importedNames.size + wholeBarrels.size;
    const pending = [entry];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (closure.has(id)) continue;
      closure.add(id);
      const info = ctx.getModuleInfo(id);
      if (!info) continue;
      if (!isReexportBarrel(info.code)) {
        const code = info.code ?? "";
        const namespaceImport = NAMESPACE_IMPORT.test(code);
        for (const [, list] of code.matchAll(NAMED_IMPORT)) {
          for (const part of list.split(",")) {
            const name = part.trim().split(/\s+as\s+/)[0];
            if (name) importedNames.add(name);
          }
        }
        for (const target of info.importedIds) {
          if (namespaceImport && isReexportBarrel(ctx.getModuleInfo(target)?.code ?? null)) wholeBarrels.add(target);
          pending.push(target);
        }
        continue;
      }
      const built = importExportBarrel(info.code);
      if (built) {
        // A startup import of `X` from it needs the name X's source module exports.
        for (const [name, source] of built.sources) {
          if (importedNames.has(name) || wholeBarrels.has(id)) importedNames.add(source);
        }
      }
      for (const target of info.importedIds) {
        const code = ctx.getModuleInfo(target)?.code ?? null;
        if (built?.sideEffectImports.some((spec) => resolvesTo(id, spec, target))) {
          pending.push(target);
          continue;
        }
        if (wholeBarrels.has(id) || code === null || isReexportBarrel(code)) {
          if (wholeBarrels.has(id) && isReexportBarrel(code)) wholeBarrels.add(target);
          pending.push(target);
          continue;
        }
        for (const name of declaredExports(code)) {
          if (importedNames.has(name)) {
            pending.push(target);
            break;
          }
        }
      }
    }
    if (importedNames.size + wholeBarrels.size === sizeBefore) return closure;
  }
}

/**
 * The entry's module id as the bundler names it. The config passes a native
 * absolute path (path.resolve), which on Windows has backslashes, while Vite
 * resolves module ids with forward slashes. Looking up the native path there
 * found no module, so the closure was the entry alone and nothing was grouped:
 * Raft Desktop's Windows renderer loaded ~330 files at startup instead of ~9.
 * Not vite's normalizePath: it converts only when the build runs on Windows,
 * so the Windows case could not be tested anywhere else.
 */
export function entryModuleId(entry: string, ctx: Pick<Rolldown.ChunkingContext, "getModuleInfo">): string {
  if (ctx.getModuleInfo(entry)) return entry;
  const slashed = entry.replace(/\\/g, "/");
  return ctx.getModuleInfo(slashed) ? slashed : entry;
}

/** `inEntryStartupClosure(moduleId, ctx)` for one entry, its closure computed once per build. */
function startupClosureOf(entry: string): (moduleId: string, ctx: Rolldown.ChunkingContext) => boolean {
  let closure: Set<string> | null = null;
  let entryId = entry;
  return (moduleId, ctx) => {
    if (!closure) {
      entryId = entryModuleId(entry, ctx);
      closure = computeStartupClosure(entryId, ctx);
    }
    return moduleId !== entryId && closure.has(moduleId);
  };
}


type CodeSplittingGroup = NonNullable<Exclude<NonNullable<Rolldown.OutputOptions["codeSplitting"]>, boolean>["groups"]>[number];

/**
 * The startup chunk groups for the app whose entry module is `entry` (an
 * absolute path): the stable vendor groups, then the entry's startup closure
 * split into vendor-icons-base-ui, vendor-zod-axios, vendor-startup,
 * vendor-raft-ui, app-stable (`appStable`, the web only) and app-shell. Used by the web
 * (packages/web/vite.config.ts) and Raft Desktop's renderer
 * (apps/desktop/frontend/vite.config.ts), which share the app's source.
 */
export interface StartupChunkOptions {
  /**
   * Split app-stable out of app-shell. The web does: a returning visitor keeps
   * it cached across deploys. Raft Desktop doesn't: its renderer loads from
   * the app bundle (app://), never downloads it, and its first-screen gate
   * counts files.
   */
  appStable?: boolean;
}

export function startupCodeSplittingGroups(entry: string, { appStable = false }: StartupChunkOptions = {}): CodeSplittingGroup[] {
  const inEntryStartupClosure = startupClosureOf(entry);
  return [
    // react-router-dom only re-exports react-router, so name the package that
    // holds the code.
    { name: "vendor-react", test: vendorPackages(["react", "react-dom", "react-router", "react-router-dom"]) },
    {
      name: "vendor-markdown",
      test: vendorPackages(["react-markdown", "remark-breaks", "remark-gfm", "rehype-raw", "rehype-sanitize"]),
    },
    { name: "vendor-socketio", test: vendorPackages(["socket.io-client"]) },
    // What changes often: icons (added in many releases) and Base UI (which
    // parts the first paint uses shift with raft-ui upgrades). Alone, they
    // rename only this chunk.
    {
      name: (moduleId, ctx) =>
        (ICONS.test(moduleId) || BASE_UI.test(moduleId)) && inEntryStartupClosure(moduleId, ctx) ? "vendor-icons-base-ui" : null,
      debugName: "vendor-icons-base-ui",
    },
    // The two largest libraries that rarely change, apart from vendor-startup
    // so the app's import order cannot shuffle them against the rest.
    {
      name: (moduleId, ctx) =>
        (ZOD.test(moduleId) || AXIOS.test(moduleId)) && inEntryStartupClosure(moduleId, ctx) ? "vendor-zod-axios" : null,
      debugName: "vendor-zod-axios",
    },
    // Third-party code the first paint needs, apart from the app's own: it
    // changes only when a dependency does, so a deploy leaves it cached.
    // raft-ui moves with the app (several releases a day), so it has its
    // own chunk, after this one: a group also takes the dependencies of
    // what it captures, and raft-ui's (Base UI...) belong here.
    {
      name: (moduleId, ctx) =>
        NODE_MODULES.test(moduleId) && !RAFT_UI.test(moduleId) && inEntryStartupClosure(moduleId, ctx) ? "vendor-startup" : null,
      debugName: "vendor-startup",
    },
    {
      name: (moduleId, ctx) => (RAFT_UI.test(moduleId) && inEntryStartupClosure(moduleId, ctx) ? "vendor-raft-ui" : null),
      debugName: "vendor-raft-ui",
    },
    // The app's slow-moving part, apart from app-shell so a deploy leaves it cached.
    ...(appStable
      ? [{
          name: (moduleId: string, ctx: Rolldown.ChunkingContext) =>
            !NODE_MODULES.test(moduleId) && APP_STABLE.test(moduleId) && inEntryStartupClosure(moduleId, ctx) ? "app-stable" : null,
          debugName: "app-stable",
        }]
      : []),
    { name: (moduleId, ctx) => (inEntryStartupClosure(moduleId, ctx) ? "app-shell" : null), debugName: "app-shell" },
  ];
}
