import type { BuildGraph, GraphChunk } from "./buildGraph";
import { diffGraphs } from "./buildGraphDiff";

const P = "node_modules/.pnpm";
const chunk = (file: string, bytes: number, modules: [string, number][], more: Partial<GraphChunk> = {}): GraphChunk => ({ file, name: file, isEntry: false, isDynamicEntry: false, bytes, imports: [], dynamicImports: [], css: [], modules: modules.map(([id, rendered]) => ({ id, rendered })), ...more });
const graph = (chunks: GraphChunk[], assets: BuildGraph["assets"] = []): BuildGraph => ({ schema: "raft-perf/build-graph@1", builtAt: "2026-11-13T00:00:00.000Z", bundler: "rolldown 1.2.13", chunks, assets, importers: {} });

const RENDER = `${P}/render@1.0.0/node_modules/render/index.js`;
// base: the chip and the renderer library are in the first-visit vendor file
const base = graph(
  [
    chunk("assets/index-AbCd1234.js", 100, [["packages/web/src/main.tsx", 200]], { isEntry: true, imports: ["assets/vendor-Xy12_abC.js", "assets/app-Qw34erTy.js"], css: ["assets/app-Zz99aaBB.css"] }),
    chunk("assets/vendor-Xy12_abC.js", 5000, [[RENDER, 6000], [`${P}/react@19.1.0/node_modules/react/index.js`, 4000]]),
    chunk("assets/app-Qw34erTy.js", 3000, [["packages/web/src/components/Chip.tsx", 3000], ["packages/web/src/components/List.tsx", 1000]]),
    chunk("assets/settings-Mn56opQr.js", 800, [["packages/web/src/pages/Settings.tsx", 900]], { isDynamicEntry: true }),
  ],
  [{ file: "assets/app-Zz99aaBB.css", bytes: 700 }],
);
// head: the renderer moved to a later file with a new module, the chip shrank, a new module joined the first visit, react untouched
const head = graph(
  [
    chunk("assets/index-AbCd1234.js", 100, [["packages/web/src/main.tsx", 200]], { isEntry: true, imports: ["assets/vendor-Kk77_llM.js", "assets/app-Rt56yuIo.js"], css: ["assets/app-Yy88ccDD.css"] }),
    chunk("assets/vendor-Kk77_llM.js", 2000, [[`${P}/react@19.1.0/node_modules/react/index.js`, 4000]]),
    chunk("assets/app-Rt56yuIo.js", 2900, [["packages/web/src/components/Chip.tsx", 1500], ["packages/web/src/components/List.tsx", 1000], ["packages/web/src/components/New.tsx", 1300]]),
    chunk("assets/settings-Mn56opQr.js", 800, [["packages/web/src/pages/Settings.tsx", 900]], { isDynamicEntry: true }),
    chunk("assets/ChipBody-Pp11qqRr.js", 3500, [[RENDER, 6000], ["packages/web/src/components/ChipBody.tsx", 1600]], { isDynamicEntry: true }),
  ],
  [{ file: "assets/app-Yy88ccDD.css", bytes: 650 }],
);

describe("diffGraphs", () => {
  const d = diffGraphs(base, head, 100);
  it("totals the bytes on disk for the first visit and later, and the first visit's stylesheets", () => {
    expect(d.totals.firstVisitJs).toMatchObject({ base: 8100, head: 5000, delta: -3100 });
    expect(d.totals.laterJs).toMatchObject({ base: 800, head: 4300, delta: 3500 });
    expect(d.totals.firstVisitCss).toEqual({ base: 700, head: 650, delta: -50 });
  });
  it("matches first-visit files by name without the hash and leaves unchanged ones out", () => {
    expect(d.files).toEqual([
      { name: "vendor.js", base: 5000, head: 2000, delta: -3000, status: "changed" },
      { name: "app.js", base: 3000, head: 2900, delta: -100, status: "changed" },
    ]);
  });
  it("names the package that left the first visit and not the one that stayed in the same file", () => {
    // react shares the vendor file with the renderer: its own bytes did not change, so it is not listed
    expect(d.packages).toEqual([
      { name: "render", base: 6000, head: 0, delta: -6000 },
      { name: "packages/web", base: 4200, head: 4000, delta: -200 },
    ]);
    expect(d.sourceDirs).toEqual([{ name: "packages/web/src/components", base: 4000, head: 3800, delta: -200 }]);
  });
  it("lists modules that entered and left the first visit, with where they are in the other build, and modules that changed size in place", () => {
    expect(d.modules.left).toEqual([{ id: RENDER, package: "render", bytes: 6000, other: "later" }]);
    expect(d.modules.entered).toEqual([{ id: "packages/web/src/components/New.tsx", package: "packages/web", bytes: 1300, other: "absent" }]);
    expect(d.modules.resized).toEqual([{ name: "packages/web/src/components/Chip.tsx", base: 3000, head: 1500, delta: -1500 }]);
  });
  it("adds up first-visit files that share a name, and leaves out modules that render to nothing", () => {
    const twoParts = graph([...head.chunks.slice(0, 3), chunk("assets/vendor-Zz00_yyX.js", 300, [["packages/web/src/types.ts", 0]]), ...head.chunks.slice(3)].map((c) => (c.isEntry ? { ...c, imports: [...c.imports, "assets/vendor-Zz00_yyX.js"] } : c)), head.assets);
    const d2 = diffGraphs(head, twoParts, 100);
    expect(d2.files).toEqual([{ name: "vendor.js", base: 2000, head: 2300, delta: 300, status: "changed" }]);
    expect(d2.modules.entered).toEqual([]);
  });
  it("reports nothing for a build compared with itself, at any threshold, and files that appear or disappear", () => {
    const zero = diffGraphs(base, base, 0);
    expect([zero.packages, zero.sourceDirs, zero.modules.resized]).toEqual([[], [], []]);
    const same = diffGraphs(base, base);
    expect([same.files, same.packages, same.sourceDirs, same.modules.entered, same.modules.left, same.modules.resized]).toEqual([[], [], [], [], [], []]);
    const noVendor = graph(base.chunks.filter((c) => !c.file.includes("vendor")).map((c) => ({ ...c, imports: c.imports.filter((i) => !i.includes("vendor")) })));
    expect(diffGraphs(base, noVendor).files).toEqual([{ name: "vendor.js", base: 5000, head: 0, delta: -5000, status: "removed" }]);
    expect(diffGraphs(noVendor, base).files).toEqual([{ name: "vendor.js", base: 0, head: 5000, delta: 5000, status: "added" }]);
    // a graph from a bundler that does not record stylesheets: no CSS number rather than a zero
    const noCss = graph(base.chunks.map(({ css: _css, ...c }) => c));
    expect(diffGraphs(base, noCss).totals.firstVisitCss).toEqual({ base: 700, head: null, delta: null });
  });
});
