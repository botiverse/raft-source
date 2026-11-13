// Bundle the renderPerfProbe.ts → IIFE that Playwright can `addInitScript({ path })`.
// Output goes to .render-perf/probe.iife.js — gitignored, rebuilt per CI run.
//
// Why IIFE: addInitScript injects a single <script> at document_start; we want
// react-scan + bippy + our recorder all bundled together so there's no
// dynamic import path that could race react-dom mount.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "renderPerfProbe.ts");
const outdir = resolve(here, "../../.render-perf");
const outfile = resolve(outdir, "probe.iife.js");

await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile,
  sourcemap: "inline",
  minify: false,
  // tree-shake the react-scan/lite package down to the parts we use
  treeShaking: true,
});

console.log(`[render-perf] built ${outfile}`);
