/**
 * The build's module graph: which modules each output file holds, how many
 * bytes each takes, which file imports which, and which module imports which.
 * Written at build time by buildGraphPlugin.ts; read here to answer what the
 * deployed files alone cannot: which package the first screen's bytes belong
 * to, which packages are bundled in several versions, and through which
 * import chain a package reached the first screen. Pure; pinned by
 * buildGraph.test.ts.
 */

export interface GraphModule {
  /** Module id relative to the build root, forward slashes, no query. A module the bundler made up (no file) starts with `(virtual)/`. */
  id: string;
  /** Bytes of the module as rendered into this chunk, before minification (what the bundler reports). */
  rendered: number;
}

export interface GraphChunk {
  /** Output file, e.g. assets/app-shell-BCVSriIS.js */
  file: string;
  name: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  /** Bytes of the emitted file (after minification). */
  bytes: number;
  /** Output files this one imports statically / dynamically. */
  imports: string[];
  dynamicImports: string[];
  /** Stylesheets this file brings with it (Vite records them per chunk). Absent when the bundler does not say. */
  css?: string[];
  modules: GraphModule[];
}

export interface BuildGraph {
  schema: "raft-perf/build-graph@1";
  builtAt: string;
  bundler: string | null;
  chunks: GraphChunk[];
  /** Emitted files that are not JS chunks (CSS, fonts, images), for the size of the stylesheets a chunk brings. */
  assets: { file: string; bytes: number }[];
  /** Per module: the modules that import it statically / dynamically. */
  importers: Record<string, { static: string[]; dynamic: string[] }>;
}

export interface PackageRef {
  /** npm name, or a source group like `packages/web` for code outside node_modules, or `(virtual)`. */
  name: string;
  /** Version when the path carries one (a pnpm store path does); otherwise null. */
  version: string | null;
  /** Where this copy lives: the path up to and including the package directory. Tells nested copies apart. */
  root: string;
  external: boolean;
}

/** Prefix of a module the bundler made up (its id began with `\0`): helpers and runtime, nobody's source. */
export const VIRTUAL = "(virtual)/";

/** Strip what bundlers add around a file path: the `\0` virtual prefix and a query or hash suffix. */
export function cleanModuleId(id: string): string {
  return id.replace(/^\0+/, "").replace(/[?#].*$/, "").replaceAll("\\", "/");
}

/**
 * The package a module belongs to, from its path. The last `node_modules/`
 * decides (a nested copy is its own package), scoped names take two
 * segments, and a pnpm store path (`.pnpm/<name>@<version>…/node_modules/<name>`)
 * also gives the version. Anything outside node_modules is grouped by its
 * first two path segments.
 */
export function packageOf(id: string): PackageRef {
  if (id.startsWith(VIRTUAL)) return { name: "(virtual)", version: null, root: "(virtual)", external: false };
  const path = cleanModuleId(id);
  const marker = "node_modules/";
  const at = path.lastIndexOf(marker);
  if (at === -1) {
    if (!path.includes("/") || /^[a-z-]{2,}:/.test(path)) return { name: "(virtual)", version: null, root: "(virtual)", external: false };
    const segments = path.split("/").filter((s) => s && s !== "." && s !== "..");
    const group = segments.length > 2 ? segments.slice(0, 2).join("/") : (segments[0] ?? "(source)");
    return { name: group, version: null, root: group, external: false };
  }
  const rest = path.slice(at + marker.length).split("/");
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : (rest[0] ?? "");
  const root = path.slice(0, at + marker.length) + name;
  return { name, version: pnpmVersion(path.slice(0, at), name), root, external: true };
}

/** `…/.pnpm/react-dom@19.1.0_react@19.1.0/` + `react-dom` -> `19.1.0`. Null when the path is not a pnpm store path for that package. */
function pnpmVersion(before: string, name: string): string | null {
  const store = /(?:^|\/)\.pnpm\/([^/]+)\/$/.exec(before);
  if (!store) return null;
  const encoded = name.replace("/", "+");
  const dir = store[1];
  if (!dir.startsWith(`${encoded}@`)) return null;
  const version = dir.slice(encoded.length + 1).split("_")[0];
  return version || null;
}

export interface PackageBytes {
  name: string;
  /** Distinct copies (version or location) of this package in the build. */
  copies: { version: string | null; root: string; bytes: number }[];
  /** Estimated bytes in the files a first visit must download. */
  initialBytes: number;
  /** Estimated bytes in files loaded later. */
  laterBytes: number;
  modules: number;
  external: boolean;
}

export interface GraphAnalysis {
  /** Output files a first visit must download: the entries and everything they import statically. */
  initialFiles: string[];
  /** JS only, uncompressed. `initialCssBytes` is the stylesheets the first-visit files bring, null when the graph does not record them. */
  totals: { initialBytes: number; laterBytes: number; initialCssBytes: number | null; files: number; modules: number };
  /** Every package, largest first-screen share first. */
  packages: PackageBytes[];
  /** Your own source by directory (at most four path segments deep), largest first-visit share first. */
  sourceDirs: { dir: string; initialBytes: number; laterBytes: number }[];
  /** Packages present in more than one version or location. */
  duplicates: PackageBytes[];
}

/** The entries plus the static-import closure: what a cold visit must download. */
export function initialFiles(graph: BuildGraph): Set<string> {
  const byFile = new Map(graph.chunks.map((c) => [c.file, c]));
  const seen = new Set<string>();
  const queue = graph.chunks.filter((c) => c.isEntry).map((c) => c.file);
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of byFile.get(file)?.imports ?? []) if (!seen.has(next) && byFile.has(next)) queue.push(next);
  }
  return seen;
}

/**
 * A module's share of its file's emitted bytes. The bundler reports module
 * sizes before minification, so the file's real size is split in proportion:
 * an estimate (minification does not shrink every module alike) that adds up
 * to the file's size. A file with no modules of its own belongs to no package.
 */
function shares(chunk: GraphChunk): Map<string, number> {
  const total = chunk.modules.reduce((sum, m) => sum + m.rendered, 0);
  return new Map(chunk.modules.map((m) => [m.id, total > 0 ? (chunk.bytes * m.rendered) / total : 0]));
}

export function analyze(graph: BuildGraph): GraphAnalysis {
  const initial = initialFiles(graph);
  const packages = new Map<string, PackageBytes & { roots: Map<string, { version: string | null; root: string; bytes: number }>; ids: Set<string> }>();
  const moduleIds = new Set<string>();
  const dirs = new Map<string, { dir: string; initialBytes: number; laterBytes: number }>();
  let initialBytes = 0;
  let laterBytes = 0;
  for (const chunk of graph.chunks) {
    const isInitial = initial.has(chunk.file);
    if (isInitial) initialBytes += chunk.bytes;
    else laterBytes += chunk.bytes;
    for (const [id, bytes] of shares(chunk)) {
      const ref = packageOf(id);
      if (!ref.external && ref.name !== "(virtual)") {
        const segments = id.split("/");
        const dir = segments.slice(0, Math.min(4, segments.length - 1)).join("/") || segments[0];
        const sum = dirs.get(dir) ?? { dir, initialBytes: 0, laterBytes: 0 };
        if (isInitial) sum.initialBytes += bytes;
        else sum.laterBytes += bytes;
        dirs.set(dir, sum);
      }
      let entry = packages.get(ref.name);
      if (!entry) {
        entry = { name: ref.name, copies: [], initialBytes: 0, laterBytes: 0, modules: 0, external: ref.external, roots: new Map(), ids: new Set() };
        packages.set(ref.name, entry);
      }
      if (isInitial) entry.initialBytes += bytes;
      else entry.laterBytes += bytes;
      entry.ids.add(id);
      const copy = entry.roots.get(ref.root) ?? { version: ref.version, root: ref.root, bytes: 0 };
      copy.bytes += bytes;
      entry.roots.set(ref.root, copy);
      moduleIds.add(id);
    }
  }
  const all: PackageBytes[] = [...packages.values()]
    .map((p) => ({
      name: p.name,
      copies: distinctCopies([...p.roots.values()]),
      initialBytes: Math.round(p.initialBytes),
      laterBytes: Math.round(p.laterBytes),
      modules: p.ids.size,
      external: p.external,
    }))
    .sort((a, b) => b.initialBytes - a.initialBytes || b.laterBytes - a.laterBytes || a.name.localeCompare(b.name));
  const assetBytes = new Map(graph.assets.map((a) => [a.file, a.bytes]));
  const initialCss = new Set(graph.chunks.filter((c) => initial.has(c.file)).flatMap((c) => c.css ?? []));
  const cssKnown = graph.chunks.some((c) => c.css !== undefined);
  return {
    initialFiles: [...initial].sort(),
    totals: { initialBytes, laterBytes, initialCssBytes: cssKnown ? [...initialCss].reduce((sum, file) => sum + (assetBytes.get(file) ?? 0), 0) : null, files: graph.chunks.length, modules: moduleIds.size },
    packages: all,
    sourceDirs: [...dirs.values()].map((d) => ({ dir: d.dir, initialBytes: Math.round(d.initialBytes), laterBytes: Math.round(d.laterBytes) })).sort((a, b) => b.initialBytes - a.initialBytes || b.laterBytes - a.laterBytes || a.dir.localeCompare(b.dir)),
    duplicates: all.filter((p) => p.external && p.copies.length > 1),
  };
}

/** Copies that differ by version; the same version installed in two places (pnpm peer variants) counts once. */
function distinctCopies(copies: { version: string | null; root: string; bytes: number }[]): { version: string | null; root: string; bytes: number }[] {
  const byKey = new Map<string, { version: string | null; root: string; bytes: number }>();
  for (const copy of copies) {
    const key = copy.version ?? copy.root;
    const kept = byKey.get(key);
    if (kept) kept.bytes += copy.bytes;
    else byKey.set(key, { ...copy });
  }
  return [...byKey.values()].map((c) => ({ ...c, bytes: Math.round(c.bytes) })).sort((a, b) => b.bytes - a.bytes);
}

export interface WhyStep {
  id: string;
  package: string;
  /** How this step imports the one before it. The first step (the package's own module) has null. */
  via: "static" | "dynamic" | null;
}

export interface WhyAnswer {
  package: string;
  found: boolean;
  /** From a module of the package up to the first module of your own source that pulls it in. Shortest such chain. */
  chain: WhyStep[];
  /** The output files that hold the package, and whether a first visit downloads them. */
  files: { file: string; initial: boolean }[];
  /**
   * Everything that imports a module of the package directly: the modules of your own source, and the
   * other packages (ask `why` about those next). The chain above is only the shortest way in: the
   * package leaves the first visit only when every importer loaded on the first visit stops importing it.
   * An importer with `rendered: false` is in no output file (its code was tree-shaken away or was types
   * only): it holds nothing in the build. Only direct importers are listed: followed further up, a barrel file would make everything that
   * imports the barrel look like an importer of everything the barrel re-exports.
   */
  importedBy: { source: { id: string; firstVisit: boolean; via: "static" | "dynamic"; rendered: boolean }[]; packages: string[] };
}

/**
 * Why a package (`name`, or `name@version` for one copy of several) is in the build: the shortest import chain from one of its
 * modules up to a module outside node_modules. When the package is on the
 * first visit, a chain ending in source the first visit loads is preferred.
 * Static imports are followed first, since they are what puts a package
 * into the same file as its importer; a dynamic import is taken only when no
 * static chain exists. Breadth-first with a visited set, so import cycles end.
 */
export function why(graph: BuildGraph, packageSpec: string): WhyAnswer {
  // `name` or `name@version` (a scoped name starts with @, so the version is after a later @)
  const versionAt = packageSpec.indexOf("@", 1);
  const packageName = versionAt === -1 ? packageSpec : packageSpec.slice(0, versionAt);
  const version = versionAt === -1 ? null : packageSpec.slice(versionAt + 1);
  const initial = initialFiles(graph);
  const files = new Map<string, boolean>();
  const starts: string[] = [];
  for (const chunk of graph.chunks) {
    for (const m of chunk.modules) {
      const ref = packageOf(m.id);
      if (ref.name !== packageName || (version !== null && ref.version !== version)) continue;
      files.set(chunk.file, initial.has(chunk.file));
      starts.push(m.id);
    }
  }
  const answer: WhyAnswer = { package: packageSpec, found: starts.length > 0, chain: [], importedBy: { source: [], packages: [] }, files: [...files].map(([file, isInitial]) => ({ file, initial: isInitial })).sort((a, b) => Number(b.initial) - Number(a.initial) || a.file.localeCompare(b.file)) };
  if (!starts.length) return answer;
  answer.importedBy = directImporters(graph, starts, packageName, version, initial);
  // First a chain that ends in source the first visit itself loads (when the package is on the first visit):
  // that is the import to cut. Then any static chain, then one through a dynamic import.
  const initialSource = new Set(graph.chunks.filter((c) => initial.has(c.file)).flatMap((c) => c.modules.map((m) => m.id)));
  const onFirstVisit = answer.files.some((f) => f.initial);
  for (const pass of [...(onFirstVisit ? [{ allowDynamic: false, initialOnly: true }] : []), { allowDynamic: false, initialOnly: false }, { allowDynamic: true, initialOnly: false }]) {
    const { allowDynamic, initialOnly } = pass;
    const previous = new Map<string, { from: string | null; via: "static" | "dynamic" | null }>();
    const queue: string[] = [];
    for (const id of new Set(starts)) {
      previous.set(id, { from: null, via: null });
      queue.push(id);
    }
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      const ref = packageOf(id);
      if (!ref.external && ref.name !== "(virtual)" && (!initialOnly || initialSource.has(id))) {
        const chain: WhyStep[] = [];
        for (let at: string | null = id; at; at = previous.get(at)!.from) chain.push({ id: at, package: packageOf(at).name, via: previous.get(at)!.via });
        // walked from the source module back to the package: report package first
        answer.chain = chain.reverse();
        return answer;
      }
      const edges = graph.importers[id];
      const next: [string, "static" | "dynamic"][] = [...(edges?.static ?? []).map((n): [string, "static"] => [n, "static"]), ...(allowDynamic ? (edges?.dynamic ?? []).map((n): [string, "dynamic"] => [n, "dynamic"]) : [])];
      for (const [importer, via] of next) {
        if (previous.has(importer)) continue;
        previous.set(importer, { from: id, via });
        queue.push(importer);
      }
    }
  }
  return answer;
}

/** Who imports the package's modules directly (see WhyAnswer.importedBy). */
function directImporters(graph: BuildGraph, starts: string[], packageName: string, version: string | null, initial: Set<string>): WhyAnswer["importedBy"] {
  const firstVisitModules = new Set(graph.chunks.filter((c) => initial.has(c.file)).flatMap((c) => c.modules.map((m) => m.id)));
  const renderedModules = new Set(graph.chunks.flatMap((c) => c.modules.map((m) => m.id)));
  const source = new Map<string, "static" | "dynamic">();
  const packages = new Set<string>();
  // the package's own modules, rendered or not (a tree-shaken barrel is how most importers reach it)
  const own = new Set(starts);
  const queue = [...own];
  for (let head = 0; head < queue.length; head++) {
    const edges = graph.importers[queue[head]];
    for (const [list, via] of [[edges?.static ?? [], "static"], [edges?.dynamic ?? [], "dynamic"]] as const) {
      for (const importer of list) {
        const ref = packageOf(importer);
        // asked about one version: the other version's modules are importers like any other package's
        if (ref.name === packageName && (version === null || ref.version === version)) {
          if (!own.has(importer)) {
            own.add(importer);
            queue.push(importer);
          }
        } else if (ref.external) packages.add(ref.name);
        else if (ref.name !== "(virtual)" && source.get(importer) !== "static") source.set(importer, via);
      }
    }
  }
  return {
    source: [...source].map(([id, via]) => ({ id, firstVisit: firstVisitModules.has(id), via, rendered: renderedModules.has(id) })).sort((a, b) => Number(b.firstVisit) - Number(a.firstVisit) || Number(b.rendered) - Number(a.rendered) || b.via.localeCompare(a.via) || a.id.localeCompare(b.id)),
    packages: [...packages].sort(),
  };
}

export interface LazyCandidate {
  /** A module of your own source on the first visit. */
  id: string;
  /**
   * Estimated first-visit bytes that only this module's static imports keep there: the most that can leave when it is
   * loaded lazily. An upper bound: a chunk group that names a package keeps it in its first-visit file whoever imports it.
   */
  bytes: number;
  /** How many first-visit modules those bytes are (the module itself included). */
  modules: number;
  /** The first-visit modules that import it statically (seen through barrels that are in no file): each of these imports has to become lazy. */
  importers: string[];
  /** The nearest module above it in this list, when its bytes are part of that one's. */
  within: string | null;
  /** The largest packages and source directories among those bytes. */
  holds: { name: string; bytes: number }[];
}

/**
 * What would leave the first visit if one module were loaded lazily: the
 * module and everything that is on the first visit only through it. That is
 * the module's subtree in the dominator tree of the static import graph,
 * rooted at the entries: a module is in M's subtree when every static import
 * path from an entry to it passes through M.
 *
 * It says how much a lazy import could move at most, not whether the first screen
 * needs the module: that is for whoever knows the screen. Sizes are the
 * estimated shares of buildGraph's `analyze`.
 */
export function lazyCandidates(graph: BuildGraph, minBytes = 20 * 1024): LazyCandidate[] {
  const initial = initialFiles(graph);
  const bytes = new Map<string, number>();
  const roots = new Set<string>();
  for (const chunk of graph.chunks) {
    if (!initial.has(chunk.file)) continue;
    for (const [id, share] of shares(chunk)) bytes.set(id, share);
  }
  // static imports between modules; a tree-shaken module (in no file) still links its importer to what it re-exports
  const imports = new Map<string, string[]>();
  for (const [id, edges] of Object.entries(graph.importers)) {
    for (const importer of edges.static) {
      const list = imports.get(importer) ?? [];
      list.push(id);
      imports.set(importer, list);
    }
  }
  // A root is a first-visit module nothing imports statically: the entry module itself, or one placed there by
  // chunk grouping or a dynamic import. Not every module of the entry file: without chunk groups that file holds the whole app.
  // A module only the HTML page imports is the entry module too (Vite makes the page a module that imports it).
  for (const id of bytes.keys()) if ((graph.importers[id]?.static ?? []).every((importer) => importer.endsWith(".html"))) roots.add(id);
  // an entry that its own imports import back (a cycle) has importers: fall back to the entry files' modules.
  // Only when nothing else is a root: an entry in a cycle beside another root (a polyfill) is not handled, and its app gets no candidates.
  if (roots.size === 0) for (const chunk of graph.chunks) if (chunk.isEntry) for (const m of chunk.modules) roots.add(m.id);

  // reverse postorder from a virtual root above all roots (iterative depth-first walk)
  const ROOT = "\0root";
  const next = (id: string): string[] => (id === ROOT ? [...roots] : (imports.get(id) ?? []));
  const order: string[] = [];
  const seen = new Set<string>([ROOT]);
  const stack: [string, number][] = [[ROOT, 0]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const children = next(top[0]);
    if (top[1] < children.length) {
      const child = children[top[1]++];
      if (!seen.has(child)) {
        seen.add(child);
        stack.push([child, 0]);
      }
    } else {
      order.push(top[0]);
      stack.pop();
    }
  }
  order.reverse();
  const index = new Map(order.map((id, i) => [id, i]));
  const preds = new Map<string, string[]>();
  for (const id of order) for (const child of next(id)) preds.set(child, [...(preds.get(child) ?? []), id]);

  // immediate dominators (Cooper, Harvey, Kennedy: iterate to a fixed point in reverse postorder)
  const idom = new Map<string, string>([[ROOT, ROOT]]);
  const meet = (a: string, b: string): string => {
    while (a !== b) {
      while (index.get(a)! > index.get(b)!) a = idom.get(a)!;
      while (index.get(b)! > index.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of order) {
      if (id === ROOT) continue;
      let dom: string | null = null;
      for (const p of preds.get(id) ?? []) if (idom.has(p)) dom = dom === null ? p : meet(p, dom);
      if (dom !== null && idom.get(id) !== dom) {
        idom.set(id, dom);
        changed = true;
      }
    }
  }

  // subtree sums: children come after their dominator in reverse postorder, so add upwards from the end
  const total = new Map<string, number>();
  const count = new Map<string, number>();
  const holds = new Map<string, Map<string, number>>();
  for (let i = order.length - 1; i > 0; i--) {
    const id = order[i];
    const own = bytes.get(id) ?? 0;
    total.set(id, (total.get(id) ?? 0) + own);
    count.set(id, (count.get(id) ?? 0) + (bytes.has(id) ? 1 : 0));
    const mine = holds.get(id) ?? new Map<string, number>();
    if (own > 0) {
      const ref = packageOf(id);
      const key = ref.external || ref.name === "(virtual)" ? ref.name : id.split("/").slice(0, Math.min(4, id.split("/").length - 1)).join("/");
      mine.set(key, (mine.get(key) ?? 0) + own);
    }
    holds.set(id, mine);
    const up = idom.get(id)!;
    if (up === ROOT) continue;
    total.set(up, (total.get(up) ?? 0) + total.get(id)!);
    count.set(up, (count.get(up) ?? 0) + count.get(id)!);
    const above = holds.get(up) ?? new Map<string, number>();
    for (const [key, value] of mine) above.set(key, (above.get(key) ?? 0) + value);
    holds.set(up, above);
  }

  // who imports a module, looking through modules that are in no first-visit file (a tree-shaken barrel): the import to change is in the file that is
  const inSomeFile = new Set(graph.chunks.flatMap((c) => c.modules.map((m) => m.id)));
  const renderedImporters = (id: string): string[] => {
    const found = new Set<string>();
    const walked = new Set<string>([id]);
    const queue = [id];
    for (let head = 0; head < queue.length; head++) {
      for (const importer of graph.importers[queue[head]]?.static ?? []) {
        if (walked.has(importer)) continue;
        walked.add(importer);
        if (bytes.has(importer)) found.add(importer);
        // only a module in no file at all is a link to look through; one in a later file is a later importer, not a first-visit one
        else if (!inSomeFile.has(importer)) queue.push(importer);
      }
    }
    return [...found].sort();
  };
  const listed = new Set<string>();
  const picked = order.filter((id) => {
    if (id === ROOT || roots.has(id) || !bytes.has(id)) return false;
    const ref = packageOf(id);
    return !ref.external && ref.name !== "(virtual)" && (total.get(id) ?? 0) >= minBytes;
  });
  for (const id of picked) listed.add(id);
  return picked
    .map((id) => {
      let within: string | null = null;
      for (let up = idom.get(id)!; up !== ROOT; up = idom.get(up)!) {
        if (listed.has(up)) {
          within = up;
          break;
        }
      }
      return {
        id,
        bytes: Math.round(total.get(id)!),
        modules: count.get(id)!,
        importers: renderedImporters(id),
        within,
        holds: [...holds.get(id)!].map(([name, value]) => ({ name, bytes: Math.round(value) })).sort((a, b) => b.bytes - a.bytes).slice(0, 4),
      };
    })
    .sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
}
