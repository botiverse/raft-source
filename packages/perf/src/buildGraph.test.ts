import { type BuildGraph, analyze, initialFiles, lazyCandidates, packageOf, why } from "./buildGraph";
import { graphFromBundle, graphId } from "./buildGraphPlugin";

const P = "node_modules/.pnpm";
const LODASH4 = `${P}/lodash@4.17.21/node_modules/lodash/lodash.js`;
const LODASH3 = `${P}/lodash@3.10.1/node_modules/lodash/index.js`;
const REACT = `${P}/react@19.1.0/node_modules/react/index.js`;
// index -> vendor -> runtime statically (two hops), index -> settings dynamically
const graph: BuildGraph = {
  schema: "raft-perf/build-graph@1",
  builtAt: "2026-11-13T00:00:00.000Z",
  bundler: "rolldown 1.2.13",
  chunks: [
    { file: "assets/index-a.js", name: "index", isEntry: true, isDynamicEntry: false, bytes: 1000, imports: ["assets/vendor-b.js"], dynamicImports: ["assets/settings-c.js"], css: ["assets/index-a.css"], modules: [{ id: "packages/web/src/main.tsx", rendered: 600 }, { id: "packages/web/src/lib/util.ts", rendered: 400 }] },
    { file: "assets/vendor-b.js", name: "vendor", isEntry: false, isDynamicEntry: false, bytes: 3000, imports: ["assets/runtime-d.js"], dynamicImports: [], css: [], modules: [{ id: REACT, rendered: 2000 }, { id: LODASH4, rendered: 4000 }] },
    { file: "assets/runtime-d.js", name: "runtime", isEntry: false, isDynamicEntry: false, bytes: 100, imports: [], dynamicImports: [], css: [], modules: [{ id: "(virtual)/rolldown/runtime.js", rendered: 10 }] },
    { file: "assets/settings-c.js", name: "settings", isEntry: false, isDynamicEntry: true, bytes: 2000, imports: ["assets/vendor-b.js"], dynamicImports: [], css: ["assets/settings-c.css"], modules: [{ id: "packages/web/src/settings.tsx", rendered: 500 }, { id: LODASH3, rendered: 1500 }] },
  ],
  assets: [{ file: "assets/index-a.css", bytes: 50 }, { file: "assets/settings-c.css", bytes: 70 }],
  importers: {
    [LODASH4]: { static: [REACT], dynamic: [] },
    [REACT]: { static: [LODASH4, "packages/web/src/main.tsx"], dynamic: [] },
    [LODASH3]: { static: [], dynamic: ["packages/web/src/settings.tsx"] },
    "packages/web/src/settings.tsx": { static: [], dynamic: ["packages/web/src/main.tsx"] },
  },
};

describe("packageOf", () => {
  it("reads name and version from a pnpm store path, scoped names included", () => {
    expect(packageOf(`${P}/react-dom@19.1.0_react@19.1.0/node_modules/react-dom/client.js`)).toMatchObject({ name: "react-dom", version: "19.1.0", external: true });
    expect(packageOf(`${P}/@babel+runtime@7.26.0/node_modules/@babel/runtime/helpers/esm/extends.js?v=1`)).toMatchObject({ name: "@babel/runtime", version: "7.26.0" });
  });
  it("treats a nested copy as its own package location, without a version when the path has none", () => {
    expect(packageOf("node_modules/a/node_modules/b/index.js")).toMatchObject({ name: "b", version: null, root: "node_modules/a/node_modules/b" });
  });
  it("groups source by its first two segments, and keeps the bundler's own modules out of both source and packages", () => {
    expect(packageOf("packages/web/src/App.tsx")).toMatchObject({ name: "packages/web", external: false });
    // as the plugin writes Vite's and Rolldown's helpers (their ids begin with \0)
    expect(packageOf("(virtual)/vite/preload-helper.js").name).toBe("(virtual)");
    expect(packageOf("(virtual)/rolldown/runtime.js").name).toBe("(virtual)");
  });
});

describe("analyze", () => {
  const a = analyze(graph);
  it("takes the entry and everything it imports statically, however deep, as the first visit; not the dynamic import", () => {
    expect([...initialFiles(graph)].sort()).toEqual(["assets/index-a.js", "assets/runtime-d.js", "assets/vendor-b.js"]);
    expect(a.totals).toMatchObject({ initialBytes: 4100, laterBytes: 2000 });
  });
  it("adds up the stylesheets the first-visit files bring, and says null when the graph does not record them", () => {
    expect(a.totals.initialCssBytes).toBe(50);
    // a stylesheet two first-visit files share is downloaded once
    expect(analyze({ ...graph, chunks: graph.chunks.map((c) => (c.name === "vendor" ? { ...c, css: ["assets/index-a.css"] } : c)) }).totals.initialCssBytes).toBe(50);
    expect(analyze({ ...graph, chunks: graph.chunks.map(({ css: _css, ...c }) => c) }).totals.initialCssBytes).toBeNull();
  });
  it("splits a file's real bytes by each module's share", () => {
    // vendor-b: 3000 bytes, lodash 4000 of 6000 rendered -> 2000; settings-c: 2000 bytes, lodash 1500 of 2000 -> 1500
    expect(a.packages.find((p) => p.name === "lodash")).toMatchObject({ initialBytes: 2000, laterBytes: 1500 });
    expect(a.packages.reduce((sum, p) => sum + p.initialBytes + p.laterBytes, 0)).toBe(6100);
  });
  it("breaks your own source down by directory and leaves the bundler's helpers out", () => {
    expect(a.sourceDirs).toEqual([
      { dir: "packages/web/src", initialBytes: 600, laterBytes: 500 },
      { dir: "packages/web/src/lib", initialBytes: 400, laterBytes: 0 },
    ]);
  });
  it("lists a package bundled in two versions, and not one bundled once", () => {
    expect(a.duplicates.map((p) => p.name)).toEqual(["lodash"]);
    expect(a.duplicates[0].copies.map((c) => c.version)).toEqual(["4.17.21", "3.10.1"]);
  });
  it("counts one version installed for two sets of peers once", () => {
    const g: BuildGraph = { ...graph, chunks: [{ ...graph.chunks[0], modules: [{ id: `${P}/x@1.0.0_react@18.0.0/node_modules/x/i.js`, rendered: 1 }, { id: `${P}/x@1.0.0_react@19.1.0/node_modules/x/i.js`, rendered: 1 }] }] };
    const x = analyze(g);
    expect(x.duplicates).toEqual([]);
    expect(x.packages.find((p) => p.name === "x")!.copies).toHaveLength(1);
  });
});

describe("why", () => {
  it("finds the shortest static chain to your own source and ends on an import cycle", () => {
    const answer = why(graph, "lodash");
    expect(answer.chain.map((s) => s.id)).toEqual([LODASH4, REACT, "packages/web/src/main.tsx"]);
    expect(answer.chain.map((s) => s.via)).toEqual([null, "static", "static"]);
    expect(answer.files).toEqual([{ file: "assets/vendor-b.js", initial: true }, { file: "assets/settings-c.js", initial: false }]);
  });
  it("answers for one copy when asked by name@version, through a dynamic import when that is the only way in", () => {
    const answer = why(graph, "lodash@3.10.1");
    expect(answer.chain.map((s) => [s.id, s.via])).toEqual([[LODASH3, null], ["packages/web/src/settings.tsx", "dynamic"]]);
    expect(answer.files).toEqual([{ file: "assets/settings-c.js", initial: false }]);
  });
  it("takes a longer static chain over a shorter dynamic one", () => {
    const g: BuildGraph = { ...graph, importers: { ...graph.importers, [LODASH4]: { static: [REACT], dynamic: ["packages/web/src/settings.tsx"] } } };
    expect(why(g, "lodash@4.17.21").chain.map((s) => s.via)).toEqual([null, "static", "static"]);
  });
  it("prefers the importer the first visit loads over a nearer one loaded later", () => {
    const g: BuildGraph = { ...graph, importers: { ...graph.importers, [LODASH4]: { static: ["packages/web/src/settings.tsx", REACT], dynamic: [] } } };
    expect(why(g, "lodash@4.17.21").chain.at(-1)!.id).toBe("packages/web/src/main.tsx");
  });
  it("lists everything that imports the package directly, not only the nearest: one chain is not the reason", () => {
    const BARREL = `${P}/lodash@4.17.21/node_modules/lodash/index.js`;
    // lodash.js is reached through lodash's own barrel (in no chunk), which util.ts, react and (dynamically) settings.tsx import
    const g: BuildGraph = { ...graph, importers: { ...graph.importers, [LODASH4]: { static: [BARREL], dynamic: [] }, [BARREL]: { static: [REACT, "packages/web/src/lib/util.ts"], dynamic: ["packages/web/src/settings.tsx"] } } };
    expect(why(g, "lodash@4.17.21").importedBy).toEqual({
      source: [
        { id: "packages/web/src/lib/util.ts", firstVisit: true, via: "static", rendered: true },
        { id: "packages/web/src/settings.tsx", firstVisit: false, via: "dynamic", rendered: true },
      ],
      // main.tsx imports react, not lodash: it is not listed, react is
      packages: ["react"],
    });
    expect(why(graph, "lodash@3.10.1").importedBy).toEqual({ source: [{ id: "packages/web/src/settings.tsx", firstVisit: false, via: "dynamic", rendered: true }], packages: [] });
  });
  it("keeps a static import when the same module also imports it dynamically, and marks an importer that is in no file", () => {
    const g: BuildGraph = { ...graph, importers: { ...graph.importers, [LODASH4]: { static: ["packages/web/src/main.tsx", "packages/web/src/types.ts"], dynamic: ["packages/web/src/main.tsx"] } } };
    expect(why(g, "lodash@4.17.21").importedBy.source).toEqual([
      { id: "packages/web/src/main.tsx", firstVisit: true, via: "static", rendered: true },
      { id: "packages/web/src/types.ts", firstVisit: false, via: "static", rendered: false },
    ]);
  });
  it("treats the other version as another importer when asked about one version", () => {
    const g: BuildGraph = { ...graph, importers: { ...graph.importers, [LODASH3]: { static: [LODASH4], dynamic: [] } } };
    expect(why(g, "lodash@3.10.1").importedBy).toEqual({ source: [], packages: ["lodash"] });
  });
  it("does not take the bundler's helper for your source", () => {
    const g: BuildGraph = { ...graph, importers: { ...graph.importers, [REACT]: { static: ["(virtual)/vite/preload-helper.js"], dynamic: [] }, "(virtual)/vite/preload-helper.js": { static: ["packages/web/src/main.tsx"], dynamic: [] } } };
    expect(why(g, "react").chain.at(-1)!.id).toBe("packages/web/src/main.tsx");
  });
  it("says so when the package is not in the build", () => {
    expect(why(graph, "moment")).toMatchObject({ found: false, chain: [] });
    expect(why(graph, "lodash@9.9.9").found).toBe(false);
  });
});

describe("lazyCandidates", () => {
  // main -> App -> { Chat, Settings }; Chat -> { Button, date }; Settings -> { Button, Form -> zodlib }; a tree-shaken barrel sits between Settings and Form
  const src = (name: string): string => `packages/web/src/${name}.tsx`;
  const DATE = `${P}/date@1.0.0/node_modules/date/index.js`;
  const ZODLIB = `${P}/zodlib@1.0.0/node_modules/zodlib/index.js`;
  const one: BuildGraph = {
    schema: "raft-perf/build-graph@1",
    builtAt: "2026-11-13T00:00:00.000Z",
    bundler: null,
    chunks: [
      { file: "index.js", name: "index", isEntry: true, isDynamicEntry: false, bytes: 100, imports: ["app.js"], dynamicImports: ["later.js"], modules: [{ id: src("main"), rendered: 100 }] },
      { file: "app.js", name: "app", isEntry: false, isDynamicEntry: false, bytes: 8000, imports: [], dynamicImports: [], modules: [{ id: src("App"), rendered: 1000 }, { id: src("Chat"), rendered: 1000 }, { id: src("Settings"), rendered: 1000 }, { id: src("Button"), rendered: 1000 }, { id: src("Form"), rendered: 1000 }, { id: DATE, rendered: 1000 }, { id: ZODLIB, rendered: 2000 }] },
      { file: "later.js", name: "later", isEntry: false, isDynamicEntry: true, bytes: 5000, imports: [], dynamicImports: [], modules: [{ id: src("Admin"), rendered: 1 }] },
    ],
    assets: [],
    importers: {
      [src("main")]: { static: [], dynamic: [] },
      [src("App")]: { static: [src("main")], dynamic: [] },
      [src("Chat")]: { static: [src("App")], dynamic: [] },
      [src("Settings")]: { static: [src("App")], dynamic: [] },
      [src("Button")]: { static: [src("Chat"), src("Settings")], dynamic: [] },
      [DATE]: { static: [src("Chat")], dynamic: [] },
      "packages/web/src/forms/index.ts": { static: [src("Settings")], dynamic: [] },
      [src("Form")]: { static: ["packages/web/src/forms/index.ts"], dynamic: [] },
      [ZODLIB]: { static: [src("Form")], dynamic: [] },
      [src("Admin")]: { static: [], dynamic: [src("main")] },
    },
  };
  const list = lazyCandidates(one, 1500);
  it("gives a module what is on the first visit only through it, through a tree-shaken barrel too, and not what another module also imports", () => {
    // Settings: itself 1000 + Form 1000 + zodlib 2000; Button is also imported by Chat, so it stays
    expect(list.find((c) => c.id === src("Settings"))).toMatchObject({ bytes: 4000, modules: 3, importers: [src("App")], within: src("App") });
    expect(list.find((c) => c.id === src("Chat"))).toMatchObject({ bytes: 2000, modules: 2 });
  });
  it("counts a module two others import under the nearest module above both", () => {
    // App holds everything but main: 8000
    expect(list[0]).toMatchObject({ id: src("App"), bytes: 8000, modules: 7, within: null });
    expect(list[0].holds[0]).toEqual({ name: "packages/web/src", bytes: 5000 });
  });
  it("lists your own modules only, largest first, nested ones naming the one they are part of, and never an entry or a later file", () => {
    expect(list.map((c) => c.id)).toEqual([src("App"), src("Settings"), src("Form"), src("Chat")]);
    expect(list.find((c) => c.id === src("Form"))).toMatchObject({ bytes: 3000, within: src("Settings"), importers: [src("Settings")] });
  });
  it("lists the app below the entry module when one file holds everything (no chunk groups), the page that imports the entry aside", () => {
    const single: BuildGraph = { ...one, chunks: [{ ...one.chunks[1], file: "index.js", isEntry: true, modules: [{ id: "packages/web/index.html", rendered: 1 }, { id: src("main"), rendered: 100 }, ...one.chunks[1].modules] }, one.chunks[2]], importers: { ...one.importers, [src("main")]: { static: ["packages/web/index.html"], dynamic: [] } } };
    expect(lazyCandidates(single, 1500 * 0.9).map((c) => c.id)).toEqual([src("App"), src("Settings"), src("Form"), src("Chat")]);
  });
  it("does not name a module of a later file as a first-visit importer", () => {
    const g: BuildGraph = { ...one, importers: { ...one.importers, [src("Form")]: { static: ["packages/web/src/forms/index.ts", src("Admin")], dynamic: [] }, [src("Admin")]: { static: [src("Chat")], dynamic: [src("main")] } } };
    // Admin (in later.js) imports Form and is imported by Chat: Chat is not Form's importer on the first visit
    expect(lazyCandidates(g, 1500).find((c) => c.id === src("Form"))!.importers).toEqual([src("Settings")]);
  });
  it("settles import cycles that need more than one pass: nothing below the root holds another module", () => {
    // Cooper, Harvey, Kennedy's example: r -> {n5, n4}; n5 -> n1; n4 -> {n2, n3}; n1 -> n2; n2 -> {n1, n3}; n3 -> n2
    const n = (i: number | string): string => `packages/web/src/n${i}.ts`;
    const cyc: BuildGraph = {
      ...one,
      chunks: [{ file: "index.js", name: "index", isEntry: true, isDynamicEntry: false, bytes: 6000, imports: [], dynamicImports: [], modules: ["r", 1, 2, 3, 4, 5].map((i) => ({ id: n(i), rendered: 1000 })) }],
      importers: { [n("r")]: { static: [], dynamic: [] }, [n(5)]: { static: [n("r")], dynamic: [] }, [n(4)]: { static: [n("r")], dynamic: [] }, [n(1)]: { static: [n(5), n(2)], dynamic: [] }, [n(2)]: { static: [n(4), n(1), n(3)], dynamic: [] }, [n(3)]: { static: [n(4), n(2)], dynamic: [] } },
    };
    expect(lazyCandidates(cyc, 1).map((c) => [c.id, c.bytes, c.within])).toEqual([1, 2, 3, 4, 5].map((i) => [n(i), 1000, null]));
  });
  it("leaves out what is below the smallest size asked for", () => {
    expect(lazyCandidates(one, 3500).map((c) => c.id)).toEqual([src("App"), src("Settings")]);
  });
});

describe("graphFromBundle", () => {
  it("turns bundler output into the graph: ids relative to the root, made-up modules marked, css per chunk, maps left out", () => {
    const g = graphFromBundle(
      {
        a: { type: "chunk", fileName: "assets/a.js", name: "a", code: "héllo", isEntry: true, imports: [], dynamicImports: [], modules: { "/repo/packages/web/src/a.ts?x=1": { renderedLength: 5 }, "\0vite/preload-helper.js": { renderedLength: 1 } }, viteMetadata: { importedCss: new Set(["assets/a.css"]) } },
        css: { type: "asset", fileName: "assets/a.css", source: new Uint8Array(6) },
        map: { type: "asset", fileName: "assets/a.js.map", source: "{}" },
      },
      // x/index.js is a barrel that was tree-shaken out of every chunk: its importers must still be recorded
      { getModuleInfo: (id) => (id === "/repo/packages/web/src/a.ts?x=1" ? { importers: ["/repo/node_modules/x/index.js"], dynamicImporters: [] } : id === "/repo/node_modules/x/index.js" ? { importers: [], dynamicImporters: ["/repo/packages/web/src/b.ts"] } : null), meta: { rolldownVersion: "1.2.13" } },
      "/repo",
      "2026-11-13T00:00:00.000Z",
    );
    expect(g.chunks[0]).toMatchObject({ file: "assets/a.js", bytes: 6, css: ["assets/a.css"], modules: [{ id: "packages/web/src/a.ts", rendered: 5 }, { id: "(virtual)/vite/preload-helper.js", rendered: 1 }] });
    expect(g.assets).toEqual([{ file: "assets/a.css", bytes: 6 }]);
    expect(g.importers).toEqual({ "packages/web/src/a.ts": { static: ["node_modules/x/index.js"], dynamic: [] }, "node_modules/x/index.js": { static: [], dynamic: ["packages/web/src/b.ts"] } });
    expect(g.bundler).toBe("rolldown 1.2.13");
  });
  it("leaves a commonjs proxy of a real file with that file's package", () => {
    expect(graphId("\0/repo/node_modules/a/i.js?commonjs-proxy", "/repo")).toBe("node_modules/a/i.js");
    expect(graphId("\0vite/preload-helper.js", "/repo")).toBe("(virtual)/vite/preload-helper.js");
  });
  it("keeps node_modules paths readable when the store sits above the root", () => {
    expect(graphId("/repo/node_modules/.pnpm/a@1.0.0/node_modules/a/i.js", "/repo/packages/web")).toBe("node_modules/.pnpm/a@1.0.0/node_modules/a/i.js");
  });
});
