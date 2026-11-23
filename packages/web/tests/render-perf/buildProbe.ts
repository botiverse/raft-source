// Bundle the renderPerfProbe.ts → IIFE that Playwright can `addInitScript({ path })`.
// Output goes to .render-perf/probe.iife.js — gitignored, rebuilt per CI run.
//
// Why IIFE: addInitScript injects a single <script> at document_start; we want
// react-scan + bippy + our recorder all bundled together so there's no
// dynamic import path that could race react-dom mount.
//
// `buildProbe.ts why [outdir]` builds the diagnostic render-why probe instead
// (renderWhyProbe.ts → why-probe.iife.js) and its report functions for Node
// (renderWhy.ts → why-lib.mjs), into `outdir` (default .render-perf/).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const why = process.argv[2] === "why";
const entry = resolve(here, why ? "renderWhyProbe.ts" : "renderPerfProbe.ts");
const outdir = why && process.argv[3] ? resolve(process.argv[3]) : resolve(here, "../../.render-perf");
const outfile = resolve(outdir, why ? "why-probe.iife.js" : "probe.iife.js");

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

if (why) {
  const libfile = resolve(outdir, "why-lib.mjs");
  await build({ entryPoints: [resolve(here, "renderWhy.ts")], bundle: true, format: "esm", platform: "node", target: "es2022", outfile: libfile });
  console.log(`[render-perf] built ${libfile}`);
}
