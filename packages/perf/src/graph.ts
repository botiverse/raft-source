#!/usr/bin/env node
/**
 * raft-perf graph: what the build put into the files, by package.
 *
 *   pnpm --filter @botiverse/raft-perf graph -- --build ../web --out build-graph.json
 *   pnpm --filter @botiverse/raft-perf graph -- --file build-graph.json [--top 15] [--why <package>] [--lazy]
 *
 * --build runs the project's own Vite build with the graph plugin added
 * (src/buildGraphPlugin.ts): the same build as the project's `vite build`,
 * into its usual output directory (projects have plugins that write there by
 * name), with no change to its config or its source tree. --file reads a graph written earlier.
 * JSON on stdout, the short list and the next command on stderr. Exit 0, or 2
 * on error. It reports; it never fails a build.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cliArgs } from "./args";
import { type BuildGraph, analyze, lazyCandidates, why } from "./buildGraph";
import { diffGraphs } from "./buildGraphDiff";
import { buildGraphPlugin } from "./buildGraphPlugin";

const HELP = `raft-perf graph (--file <build-graph.json> | --build <project dir> [--out <file>]) [--top <n>] [--why <package>] [--lazy [--min-kb <n>]] [--base <older graph> [--min-change-kb <n>]]

  --file   a graph written by the build plugin (src/buildGraphPlugin.ts) or by --build
  --build  a Vite project: build it now with the graph plugin added (a normal build into the project's output directory)
  --out    with --build: where to keep the graph (default: build-graph.json)
  --out-dir  with --build: write the build's files to this directory (emptied first) instead of the project's own output
             directory. A project's plugins that name their output directory themselves still act on that one
  --top    how many packages and source directories to list (default 15)
  --lazy   your own first-visit modules ranked by what would leave the first visit with them if they were loaded lazily
           (the module and everything that is there only through it); --min-kb sets the smallest listed (default 20)
  --base   an older graph to compare with: what entered and left the first visit, by file (bytes on disk) and by package,
           source directory and module (module bytes before minification); --min-change-kb sets the smallest change listed (default 1)
  --why    a package name, or name@version for one copy of several: what imports it directly (your modules and other packages),
           the shortest import chain among them, and the files that hold it
`;

/**
 * Runs the project's own `vite build` in a child process, with the graph
 * plugin merged into its config through a temporary wrapper config under
 * its node_modules/.cache (removed afterwards). A child process, because a project's config and
 * plugins expect Vite's own loader, not this command's.
 */
async function buildGraph(dir: string, out: string, outDir?: string): Promise<void> {
  const project = resolve(dir);
  const base = ["ts", "mts", "js", "mjs"].map((ext) => `vite.config.${ext}`).find((name) => existsSync(join(project, name)));
  if (!base) throw new Error(`--build ${dir}: no vite.config.* there`);
  // out of the project's source tree, and one per process: an interrupted or concurrent run leaves nothing to commit or to clash with
  const cache = join(project, "node_modules/.cache/raft-perf");
  mkdirSync(cache, { recursive: true });
  const wrapper = join(cache, `vite.graph.${process.pid}.config.ts`);
  const plugin = fileURLToPath(new URL("./buildGraphPlugin.ts", import.meta.url));
  // ids relative to the repository (the nearest directory above with .git), else to the project
  let root = project;
  for (let at = project; dirname(at) !== at; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) {
      root = at;
      break;
    }
  }
  writeFileSync(
    wrapper,
    `import { mergeConfig } from "vite";
import base from ${JSON.stringify(join(project, base))};
import { buildGraphPlugin } from ${JSON.stringify(plugin)};
export default async (env: unknown) => mergeConfig(typeof base === "function" ? await (base as (e: unknown) => unknown)(env) : await base, { plugins: [buildGraphPlugin({ out: ${JSON.stringify(resolve(out))}, root: ${JSON.stringify(root)} })]${outDir ? `, build: { outDir: ${JSON.stringify(resolve(outDir))}, emptyOutDir: true }` : ""} });
`,
  );
  let vite: string;
  try {
    vite = join(dirname(createRequire(join(project, "package.json")).resolve("vite/package.json")), "bin/vite.js");
  } catch {
    rmSync(wrapper, { force: true });
    throw new Error(`--build ${dir}: vite is not installed there`);
  }
  // the build's own output goes to stderr: stdout is this command's JSON
  const child = spawn(process.execPath, [vite, "build", "--config", wrapper], { cwd: project, stdio: ["ignore", 2, 2] });
  // a signal to this process stops the build too, and the wrapper is removed before this command ends
  let stopped: NodeJS.Signals | null = null;
  const stop = (signal: NodeJS.Signals): void => {
    stopped = signal;
    child.kill(signal);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const end = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child.on("error", fail);
      child.on("exit", (code, signal) => done({ code, signal }));
    }).catch((error: unknown) => {
      throw new Error(`--build ${dir}: could not start vite build: ${(error as Error).message}`);
    });
    const signal = (stopped as NodeJS.Signals | null) ?? end.signal;
    if (signal) throw new Error(`--build ${dir}: vite build was stopped (${signal})`);
    if (end.code !== 0) throw new Error(`--build ${dir}: vite build failed (exit ${end.code}); its output is above. A project whose build needs environment variables or steps before it needs them here too`);
  } finally {
    rmSync(wrapper, { force: true });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function minKbOf(value: string | undefined, flag: string, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} takes a number above 0`);
  return n;
}

// small changes in bytes: "-0.0 KB" says nothing
const signed = (bytes: number): string => `${bytes > 0 ? "+" : ""}${Math.abs(bytes) < 100 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`}`;
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

async function main(): Promise<number> {
  const { values: args } = parseArgs({ args: cliArgs(), options: { file: { type: "string" }, build: { type: "string" }, out: { type: "string" }, "out-dir": { type: "string" }, top: { type: "string" }, why: { type: "string" }, lazy: { type: "boolean" }, "min-kb": { type: "string" }, base: { type: "string" }, "min-change-kb": { type: "string" }, help: { type: "boolean" } } });
  if (args.help || (!args.file && !args.build)) {
    process.stdout.write(HELP);
    return args.help ? 0 : 2;
  }
  if (args.file && args.build) throw new Error("give --file or --build, not both (--build writes the graph to --out and reads that)");
  if (args["out-dir"] && !args.build) throw new Error("--out-dir goes with --build");
  const top = Number(args.top ?? 15);
  if (!Number.isInteger(top) || top < 1) throw new Error("--top takes a whole number, 1 or more");
  let file = args.file;
  if (args.build) {
    file = args.out ?? "build-graph.json";
    await buildGraph(args.build, file, args["out-dir"]);
  }
  const readGraph = (path: string): BuildGraph => {
    const read = JSON.parse(readFileSync(path, "utf8")) as BuildGraph;
    if (read.schema !== "raft-perf/build-graph@1" || !Array.isArray(read.chunks) || !Array.isArray(read.assets) || typeof read.importers !== "object") throw new Error(`${path}: not a raft-perf build graph (schema ${String(read.schema)})`);
    return read;
  };
  const graph = readGraph(file!);
  const diff = args.base ? diffGraphs(readGraph(args.base), graph, minKbOf(args["min-change-kb"], "--min-change-kb", 1) * 1024) : undefined;
  if (args["min-change-kb"] !== undefined && !args.base) throw new Error("--min-change-kb goes with --base");
  const analysis = analyze(graph);
  const minKb = minKbOf(args["min-kb"], "--min-kb", 20);
  if (args["min-kb"] !== undefined && !args.lazy) throw new Error("--min-kb goes with --lazy");
  const lazy = args.lazy ? lazyCandidates(graph, minKb * 1024) : undefined;
  const answer = args.why ? why(graph, args.why) : undefined;
  if (answer && !answer.found) throw new Error(`--why ${args.why}: no module of that package is in the build (names are as listed under "packages")`);
  const report = {
    tool: "raft-perf graph",
    schema: "raft-perf/graph-report@1",
    file,
    builtAt: graph.builtAt,
    bundler: graph.bundler,
    // module sizes are the file's real bytes split by each module's share before minification
    trust: "JS files only, uncompressed bytes as written to disk; per-package and per-directory sizes are each file's bytes split by its modules' pre-minification shares (an estimate)",
    totals: analysis.totals,
    initialFiles: analysis.initialFiles,
    packages: analysis.packages.slice(0, top),
    sourceDirs: analysis.sourceDirs.slice(0, top),
    duplicates: analysis.duplicates,
    ...(answer ? { why: answer } : {}),
    // the full list: a candidate's `within` names another entry, which a cut list could drop
    ...(lazy ? { lazy } : {}),
    ...(diff ? { diff } : {}),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const t = analysis.totals;
  process.stderr.write(`raft-perf graph ${file}: first visit ${kb(t.initialBytes)} of JS in ${analysis.initialFiles.length} file(s)${t.initialCssBytes != null ? ` and ${kb(t.initialCssBytes)} of CSS` : ""}, later ${kb(t.laterBytes)} of JS; ${analysis.duplicates.length} package(s) in several versions\n`);
  analysis.packages.slice(0, Math.min(top, 8)).forEach((p, i) => process.stderr.write(`  ${i + 1}. ${p.name}: ${kb(p.initialBytes)} on the first visit, ${kb(p.laterBytes)} later\n`));
  if (answer) {
    const { packages } = answer.importedBy;
    // importers that are in no output file hold nothing in the build
    const source = answer.importedBy.source.filter((m) => m.rendered);
    const onFirstVisit = source.filter((m) => m.firstVisit && m.via === "static").length;
    process.stderr.write(`why ${answer.package}: imported directly by ${source.length} module(s) of your source (${onFirstVisit} on the first visit) and ${packages.length} other package(s)${packages.length ? `: ${packages.slice(0, 6).join(", ")}${packages.length > 6 ? ", ..." : ""}` : ""}\n`);
    if (source.length + packages.length > 1) process.stderr.write("  one chain is not the reason: it leaves the first visit only when every first-visit importer stops importing it (`why.importedBy` lists them)\n");
    process.stderr.write(`  shortest chain: ${answer.chain.map((s) => s.id).join(" <- ") || "no importer found"}\n`);
  }
  if (lazy) {
    process.stderr.write(`lazy: ${lazy.length} module(s) of your source hold ${minKb} KB or more that is on the first visit only through them: up to that much leaves if one is loaded lazily (whether the first screen needs it is yours to judge)\n`);
    lazy.slice(0, top).forEach((c) => process.stderr.write(`  up to ${kb(c.bytes)} in ${c.modules} module(s): ${c.id}, imported from ${c.importers.length} place(s)${c.within ? ` (part of ${c.within})` : ""}\n`));
  }
  if (diff) {
    const dt = diff.totals;
    process.stderr.write(`against ${args.base}: first visit ${signed(dt.firstVisitJs.delta)} of JS on disk (${kb(dt.firstVisitJs.base)} -> ${kb(dt.firstVisitJs.head)})${dt.firstVisitCss.delta != null ? `, ${signed(dt.firstVisitCss.delta)} of CSS` : ""}; later ${signed(dt.laterJs.delta)}\n`);
    diff.files.slice(0, top).forEach((f) => process.stderr.write(`  file ${f.name}: ${f.status === "changed" ? signed(f.delta) : `${f.status}, ${kb(f.status === "added" ? f.head : f.base)}`}\n`));
    const m = diff.modules;
    process.stderr.write(`  in module bytes before minification: ${m.entered.length} module(s) entered the first visit, ${m.left.length} left it, ${m.resized.length} changed size there\n`);
    m.entered.slice(0, top).forEach((x) => process.stderr.write(`    entered: ${x.id} ${kb(x.bytes)} (${x.other === "later" ? "was in a later file" : "new"})\n`));
    m.left.slice(0, top).forEach((x) => process.stderr.write(`    left: ${x.id} ${kb(x.bytes)} (${x.other === "later" ? "now in a later file" : "gone"})\n`));
    m.resized.slice(0, top).forEach((x) => process.stderr.write(`    resized: ${x.name} ${signed(x.delta)}\n`));
  }
  const first = analysis.packages.find((p) => p.external);
  if (!answer && !lazy && !diff && first) process.stderr.write(`next: raft-perf graph --file ${file} --why ${first.name}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf graph: ${(error as Error).message}\n`);
    process.exitCode = 2;
  },
);
