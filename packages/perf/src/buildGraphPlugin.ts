/**
 * A build plugin (Rollup, Rolldown, Vite) that writes the build's module
 * graph for `raft-perf graph` (src/buildGraph.ts). It only reads what the
 * bundler hands to `writeBundle`, and imports nothing from the bundler or
 * the app, so any project can add it:
 *
 *   plugins: [buildGraphPlugin({ out: "build-graph.json" })]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { type BuildGraph, type GraphChunk, VIRTUAL, cleanModuleId } from "./buildGraph";

/** The parts of the bundler's output this plugin reads (Rollup's OutputChunk / OutputAsset, structurally). */
interface OutputFile {
  type: "chunk" | "asset";
  fileName: string;
  name?: string;
  code?: string;
  source?: string | Uint8Array;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  modules?: Record<string, { renderedLength: number }>;
  /** Vite's per-chunk record of the stylesheets it brings. */
  viteMetadata?: { importedCss?: Iterable<string> };
}

interface PluginContext {
  getModuleInfo?: (id: string) => { importers?: readonly string[]; dynamicImporters?: readonly string[] } | null;
  meta?: { rolldownVersion?: string; rollupVersion?: string };
}

export interface BuildGraphPluginOptions {
  /** Where to write the graph (JSON). */
  out: string;
  /** Module ids are written relative to this directory (default: the current directory). */
  root?: string;
}

/** A module id as the graph stores it: relative to the root when it is a file under it. */
export function graphId(id: string, root: string): string {
  const clean = cleanModuleId(id);
  const isFile = /^(\/|[A-Za-z]:\/)/.test(clean);
  // a \0 id that still names a file (a commonjs proxy of a real module) stays with that file's package
  if (id.startsWith("\0") && !isFile) return VIRTUAL + clean;
  if (!isFile) return clean;
  const rel = relative(root, clean).replaceAll("\\", "/");
  return rel.startsWith("..") && !rel.includes("node_modules/") ? clean : rel.replace(/^(\.\.\/)+/, "");
}

/** The graph for one bundle, from what `writeBundle` receives. Exported for the test. */
export function graphFromBundle(bundle: Record<string, OutputFile>, context: PluginContext, root: string, builtAt: string): BuildGraph {
  const chunks: GraphChunk[] = [];
  const assets: BuildGraph["assets"] = [];
  const importers: BuildGraph["importers"] = {};
  const pending: string[] = [];
  for (const file of Object.values(bundle)) {
    if (file.type !== "chunk") {
      // source maps describe the build, they are not something a visitor downloads
      if (file.fileName.endsWith(".map")) continue;
      assets.push({ file: file.fileName, bytes: typeof file.source === "string" ? Buffer.byteLength(file.source) : (file.source?.byteLength ?? 0) });
      continue;
    }
    const modules = Object.entries(file.modules ?? {}).map(([id, m]) => ({ id: graphId(id, root), rendered: m.renderedLength }));
    pending.push(...Object.keys(file.modules ?? {}));
    chunks.push({
      file: file.fileName,
      name: file.name ?? file.fileName,
      isEntry: file.isEntry === true,
      isDynamicEntry: file.isDynamicEntry === true,
      bytes: Buffer.byteLength(file.code ?? ""),
      imports: [...(file.imports ?? [])],
      dynamicImports: [...(file.dynamicImports ?? [])],
      ...(file.viteMetadata?.importedCss ? { css: [...file.viteMetadata.importedCss] } : {}),
      modules,
    });
  }
  // Importers are followed past the modules that were rendered: a barrel file whose own code was
  // tree-shaken away is in no chunk, yet it is the link between a package and whoever imports it.
  const asked = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (asked.has(id)) continue;
    asked.add(id);
    const info = context.getModuleInfo?.(id);
    if (!info) continue;
    importers[graphId(id, root)] = { static: (info.importers ?? []).map((i) => graphId(i, root)), dynamic: (info.dynamicImporters ?? []).map((i) => graphId(i, root)) };
    pending.push(...(info.importers ?? []), ...(info.dynamicImporters ?? []));
  }
  const bundler = context.meta?.rolldownVersion ? `rolldown ${context.meta.rolldownVersion}` : context.meta?.rollupVersion ? `rollup ${context.meta.rollupVersion}` : null;
  return { schema: "raft-perf/build-graph@1", builtAt, bundler, chunks, assets, importers };
}

/**
 * Reads the bundle in `writeBundle`, after every other plugin: Vite rewrites
 * chunks in its own `generateBundle` (the preload lists) and drops the empty
 * ones it made for CSS, so only then are the files what was written to disk.
 * One output per build: with several, the last one written wins.
 */
export function buildGraphPlugin(options: BuildGraphPluginOptions): { name: string; enforce: "post"; writeBundle: (this: PluginContext, outputOptions: unknown, bundle: Record<string, OutputFile>) => void } {
  const root = resolve(options.root ?? process.cwd());
  return {
    name: "raft-perf-build-graph",
    enforce: "post",
    writeBundle(_outputOptions, bundle) {
      const graph = graphFromBundle(bundle, this, root, new Date().toISOString());
      const out = resolve(options.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(graph)}\n`);
    },
  };
}
