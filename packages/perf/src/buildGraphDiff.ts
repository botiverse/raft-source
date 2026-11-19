/**
 * Two builds compared through their module graphs (buildGraph.ts): what a
 * change put onto the first visit or took off it, by file, package, source
 * directory and module. The first-screen `diff` compares deployed files and
 * can only say a file grew; this says which module made it grow.
 *
 * Two units, kept apart. Files and totals are bytes as written to disk.
 * Packages, directories and modules are the bundler's own module sizes
 * before minification: a module's number does not move because a neighbour
 * in its file changed (the share estimates of `analyze` do), though the
 * bundler can render the same source a few bytes differently between
 * builds, and it is larger than what ships.
 * Pure; pinned by buildGraphDiff.test.ts.
 */
import { type BuildGraph, initialFiles, packageOf } from "./buildGraph";
import { stableName } from "./firstScreen";

export interface Change {
  name: string;
  base: number;
  head: number;
  delta: number;
}

export interface ModuleMove {
  id: string;
  package: string;
  /** The module's size before minification in the build where it is on the first visit. */
  bytes: number;
  /** Where it is in the other build: a later file, or not in the build. */
  other: "later" | "absent";
}

export interface GraphDiff {
  schema: "raft-perf/build-graph-diff@1";
  base: { builtAt: string; bundler: string | null };
  head: { builtAt: string; bundler: string | null };
  /** Bytes on disk, uncompressed. */
  totals: { firstVisitJs: Change; laterJs: Change; firstVisitCss: { base: number | null; head: number | null; delta: number | null } };
  /** First-visit JS files of either build, matched by name without the content hash (files that share a name are added up); unchanged files left out. Bytes on disk. */
  files: (Change & { status: "changed" | "added" | "removed" })[];
  /** The rest in module bytes before minification, first visit only, largest change first, changes under `minBytes` left out. */
  packages: Change[];
  sourceDirs: Change[];
  modules: {
    /** On the first visit in head and not in base. Modules that render to nothing are left out. */
    entered: ModuleMove[];
    /** On the first visit in base and not in head. */
    left: ModuleMove[];
    /** On the first visit in both, with a different size. */
    resized: Change[];
  };
}

interface Placed {
  rendered: number;
  firstVisit: boolean;
}

function placements(graph: BuildGraph): { modules: Map<string, Placed>; files: Map<string, number>; firstVisitJs: number; laterJs: number; firstVisitCss: number | null } {
  const initial = initialFiles(graph);
  const modules = new Map<string, Placed>();
  const files = new Map<string, number>();
  let firstVisitJs = 0;
  let laterJs = 0;
  for (const chunk of graph.chunks) {
    const firstVisit = initial.has(chunk.file);
    if (firstVisit) {
      firstVisitJs += chunk.bytes;
      files.set(stableName(chunk.file), (files.get(stableName(chunk.file)) ?? 0) + chunk.bytes);
    } else laterJs += chunk.bytes;
    for (const m of chunk.modules) modules.set(m.id, { rendered: m.rendered, firstVisit });
  }
  const assetBytes = new Map(graph.assets.map((a) => [a.file, a.bytes]));
  const css = new Set(graph.chunks.filter((c) => initial.has(c.file)).flatMap((c) => c.css ?? []));
  const cssKnown = graph.chunks.some((c) => c.css !== undefined);
  return { modules, files, firstVisitJs, laterJs, firstVisitCss: cssKnown ? [...css].reduce((sum, file) => sum + (assetBytes.get(file) ?? 0), 0) : null };
}

const change = (name: string, base: number, head: number): Change => ({ name, base, head, delta: head - base });
const byDelta = (a: Change, b: Change): number => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name);

/** The directory a module of your own source is counted under: at most four path segments, as in `analyze`. */
function sourceDir(id: string): string {
  const segments = id.split("/");
  return segments.slice(0, Math.min(4, segments.length - 1)).join("/") || segments[0];
}

export function diffGraphs(base: BuildGraph, head: BuildGraph, minBytes = 1024): GraphDiff {
  const b = placements(base);
  const h = placements(head);

  const files: GraphDiff["files"] = [];
  for (const name of new Set([...b.files.keys(), ...h.files.keys()])) {
    const was = b.files.get(name);
    const now = h.files.get(name);
    if (was === now) continue;
    files.push({ ...change(name, was ?? 0, now ?? 0), status: was === undefined ? "added" : now === undefined ? "removed" : "changed" });
  }

  const packages = new Map<string, [number, number]>();
  const dirs = new Map<string, [number, number]>();
  const add = (map: Map<string, [number, number]>, key: string, side: 0 | 1, bytes: number): void => {
    const pair = map.get(key) ?? [0, 0];
    pair[side] += bytes;
    map.set(key, pair);
  };
  const entered: ModuleMove[] = [];
  const left: ModuleMove[] = [];
  const resized: Change[] = [];
  for (const [side, mine, theirs] of [
    [0, b, h],
    [1, h, b],
  ] as const) {
    for (const [id, placed] of mine.modules) {
      if (!placed.firstVisit) continue;
      const ref = packageOf(id);
      add(packages, ref.name, side, placed.rendered);
      if (!ref.external && ref.name !== "(virtual)") add(dirs, sourceDir(id), side, placed.rendered);
      const other = theirs.modules.get(id);
      if (other?.firstVisit) {
        if (side === 1 && placed.rendered !== other.rendered && Math.abs(placed.rendered - other.rendered) >= minBytes) resized.push(change(id, other.rendered, placed.rendered));
        continue;
      }
      // a module that renders to nothing (types, re-exports) carries nothing onto or off the first visit
      if (placed.rendered > 0) (side === 1 ? entered : left).push({ id, package: ref.name, bytes: placed.rendered, other: other ? "later" : "absent" });
    }
  }
  const changes = (map: Map<string, [number, number]>): Change[] =>
    [...map]
      .map(([name, [was, now]]) => change(name, was, now))
      .filter((c) => c.delta !== 0 && Math.abs(c.delta) >= minBytes)
      .sort(byDelta);
  const bySize = (a: ModuleMove, z: ModuleMove): number => z.bytes - a.bytes || a.id.localeCompare(z.id);
  return {
    schema: "raft-perf/build-graph-diff@1",
    base: { builtAt: base.builtAt, bundler: base.bundler },
    head: { builtAt: head.builtAt, bundler: head.bundler },
    totals: {
      firstVisitJs: change("first-visit JS", b.firstVisitJs, h.firstVisitJs),
      laterJs: change("later JS", b.laterJs, h.laterJs),
      firstVisitCss: { base: b.firstVisitCss, head: h.firstVisitCss, delta: b.firstVisitCss !== null && h.firstVisitCss !== null ? h.firstVisitCss - b.firstVisitCss : null },
    },
    files: files.sort(byDelta),
    packages: changes(packages),
    sourceDirs: changes(dirs),
    modules: { entered: entered.sort(bySize), left: left.sort(bySize), resized: resized.sort(byDelta) },
  };
}
