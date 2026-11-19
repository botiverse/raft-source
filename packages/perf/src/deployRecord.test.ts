import type { BuildGraph, GraphChunk } from "./buildGraph";
import { recordMarkdown } from "./deployRecord";
import { type FirstScreenFile, type FirstScreenSnapshot, totals } from "./firstScreen";

const chunk = (file: string, bytes: number, modules: [string, number][], more: Partial<GraphChunk> = {}): GraphChunk => ({ file, name: file, isEntry: false, isDynamicEntry: false, bytes, imports: [], dynamicImports: [], css: [], modules: modules.map(([id, rendered]) => ({ id, rendered })), ...more });
const graph = (app: [string, number][], appHash = "Qw34erTy"): BuildGraph => ({ schema: "raft-perf/build-graph@1", builtAt: "2026-11-13T00:00:00.000Z", bundler: "rolldown 1.2.13", assets: [{ file: "assets/app-Xx11yyZ2.css", bytes: 9000 }], importers: {}, chunks: [chunk("assets/index-AbCd1234.js", 100, [["packages/web/src/main.tsx", 200]], { isEntry: true, imports: [`assets/app-${appHash}.js`], css: ["assets/app-Xx11yyZ2.css"] }), chunk(`assets/app-${appHash}.js`, 3000, app), chunk("assets/settings-Mn56opQr.js", 800, [["packages/web/src/pages/Settings.tsx", 900]], { isDynamicEntry: true })] });
const file = (url: string, name: string, brBytes: number, bytes: number, kind: "js" | "css" = "js"): FirstScreenFile => ({ url, name, kind, via: kind === "js" ? "modulepreload" : "stylesheet", bytes, brBytes, sha256: url });
const snapshot = (commitSha: string, files: FirstScreenFile[]): FirstScreenSnapshot => ({ schema: "raft-perf/first-screen@1", origin: "https://example.test", takenAt: "2026-11-13T00:00:00.000Z", release: { commitSha, builtAt: null, deploymentEnvironment: "staging" }, html: { bytes: 1000, brBytes: 400 }, files, totals: totals(files) });

const baseGraph = graph([["packages/web/src/components/List.tsx", 3000]]);
const headGraph = graph([["packages/web/src/components/List.tsx", 3000], ["packages/web/src/components/Heavy.tsx", 9000]], "Zz99aaBB");
// uncompressed sizes are the graph's: index 100 bytes, app 3000
const baseSnap = snapshot("aaaaaaaa1111", [file("/assets/index-AbCd1234.js", "index.js", 100, 100), file("/assets/app-Qw34erTy.js", "app.js", 10_000, 3000), file("/assets/app-Xx11yyZ2.css", "app.css", 2_000, 9000, "css")]);
const headSnap = snapshot("bbbbbbbb2222", [file("/assets/index-AbCd1234.js", "index.js", 100, 100), file("/assets/app-Zz99aaBB.js", "app.js", 16_500, 3000), file("/assets/app-Xx11yyZ2.css", "app.css", 2_000, 9000, "css")]);

describe("recordMarkdown", () => {
  it("gives the growth over the wire from the deployed files and names the module that entered, from the graph", () => {
    const r = recordMarkdown({ graph: headGraph, snapshot: headSnap, baseGraph, baseSnapshot: baseSnap, noteBytes: 5 * 1024 });
    expect(r).toMatchObject({ consistent: true, growthBrBytes: 6500, noteworthy: true });
    expect(r.markdown).toContain("(bbbbbbbb)");
    expect(r.markdown).toContain("**+6.3 KB**");
    expect(r.markdown).toContain("against the deploy before it (aaaaaaaa)");
    expect(r.markdown).toContain("worth a look");
    expect(r.markdown).toContain("- `packages/web/src/components/Heavy.tsx` 8.8 KB (new)");
    expect(r.markdown).toContain("second build of the same commit");
  });
  it("does not ask for a look below the line, and says so when nothing changed", () => {
    // the next deploy, another commit, with the very same files
    const r = recordMarkdown({ graph: baseGraph, snapshot: { ...baseSnap, release: { ...baseSnap.release, commitSha: "eeeeeeee5555" } }, baseGraph, baseSnapshot: baseSnap, noteBytes: 5 * 1024 });
    expect(r).toMatchObject({ growthBrBytes: 0, noteworthy: false });
    expect(r.markdown).not.toContain("worth a look");
    expect(r.markdown).toContain("Nothing of 1 KB or more.");
  });
  it("refuses a module breakdown when the graph's files are not the deployed ones, and names the difference", () => {
    const other = { ...headGraph, chunks: [...headGraph.chunks.map((c) => (c.isEntry ? { ...c, imports: [...c.imports, "assets/extra-Kk77_llM.js"] } : c)), chunk("assets/extra-Kk77_llM.js", 500, [["packages/web/src/extra.ts", 500]])] };
    const r = recordMarkdown({ graph: other, snapshot: headSnap, baseGraph, baseSnapshot: baseSnap, noteBytes: 5 * 1024 });
    expect(r.consistent).toBe(false);
    expect(r.markdown).toContain("is not the deployed build");
    expect(r.markdown).toContain("In the graph, not deployed: `extra.js`");
    expect(r.markdown).not.toContain("Entered the first screen");
    // the bytes over the wire are still given: they do not depend on the graph
    expect(r.growthBrBytes).toBe(6500);
  });
  it("says what it cannot compare on a first record", () => {
    const r = recordMarkdown({ graph: headGraph, snapshot: headSnap, noteBytes: 5 * 1024 });
    expect(r).toMatchObject({ consistent: true, growthBrBytes: null, noteworthy: false });
    expect(r.markdown).toContain("No earlier record to compare with");
    expect(r.markdown).toContain("No earlier build graph to compare with");
  });
  it("refuses a graph of another commit, or one whose files have other sizes, though the file names without hash are the same", () => {
    const otherCommit = recordMarkdown({ graph: headGraph, snapshot: headSnap, baseGraph, baseSnapshot: baseSnap, noteBytes: 5 * 1024, graphCommit: "cccccccc3333" });
    expect(otherCommit.consistent).toBe(false);
    expect(otherCommit.markdown).toContain("the graph was built from cccccccc, the deploy is bbbbbbbb");
    const otherSize = { ...headGraph, chunks: headGraph.chunks.map((c) => (c.file.includes("app-") ? { ...c, bytes: 3900 } : c)) };
    const r = recordMarkdown({ graph: otherSize, snapshot: headSnap, baseGraph, baseSnapshot: baseSnap, noteBytes: 5 * 1024, graphCommit: "bbbbbbbb2222" });
    expect(r.consistent).toBe(false);
    expect(r.markdown).toContain("differs by 900 bytes");
    expect(r.markdown).not.toContain("Entered the first screen");
  });
  it("says how well the graph matches when it does, and tolerates a build timestamp's worth of bytes", () => {
    const stamp = { ...headGraph, chunks: headGraph.chunks.map((c) => (c.file.includes("app-") ? { ...c, bytes: 3020, file: "assets/app-Nn00mmPP.js" } : c.isEntry ? { ...c, imports: ["assets/app-Nn00mmPP.js"] } : c)) };
    const r = recordMarkdown({ graph: stamp, snapshot: headSnap, baseGraph, baseSnapshot: baseSnap, noteBytes: 5 * 1024, graphCommit: "bbbbbbbb2222" });
    expect(r.consistent).toBe(true);
    expect(r.markdown).toContain("of 3 first-screen files, 2 have the very same hashed name and 2 the same size (largest difference 20 bytes)");
  });
  it("does not compare with a previous record of the same commit (a re-run), nor across a previous record whose graph and files are of different commits", () => {
    const rerun = recordMarkdown({ graph: headGraph, snapshot: headSnap, baseGraph: headGraph, baseSnapshot: headSnap, noteBytes: 5 * 1024 });
    expect(rerun).toMatchObject({ growthBrBytes: null, noteworthy: false });
    expect(rerun.markdown).toContain("a re-run");
    expect(rerun.markdown).not.toContain("against the deploy before it");
    const mixed = recordMarkdown({ graph: headGraph, snapshot: headSnap, baseGraph, baseSnapshot: baseSnap, noteBytes: 5 * 1024, baseGraphCommit: "dddddddd4444" });
    expect(mixed.growthBrBytes).toBe(6500);
    expect(mixed.markdown).toContain("are of different commits: no module comparison this time");
    expect(mixed.markdown).not.toContain("Entered the first screen");
  });
  it("asks for a look exactly from the line", () => {
    const at = (br: number) => recordMarkdown({ graph: headGraph, snapshot: snapshot("bbbbbbbb2222", [file("/assets/index-AbCd1234.js", "index.js", 100, 100), file("/assets/app-Zz99aaBB.js", "app.js", br, 3000)]), baseSnapshot: snapshot("aaaaaaaa1111", [file("/assets/index-AbCd1234.js", "index.js", 100, 100), file("/assets/app-Qw34erTy.js", "app.js", 10_000, 3000)]), noteBytes: 5120 });
    expect(at(15_119).noteworthy).toBe(false);
    expect(at(15_120).noteworthy).toBe(true);
    expect(at(1_000).noteworthy).toBe(false);
  });
});
