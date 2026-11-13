/**
 * What a cold load of a deployed web must download before the app boots, read
 * from the deployed `index.html` itself (no build): the module entry, its
 * modulepreload links, stylesheets, and any static import the preloads miss.
 * Pure helpers here; the network side lives in snapshot.ts. Pinned by
 * firstScreen.test.ts.
 */

export type FileKind = "js" | "css";
export type FileVia = "entry" | "modulepreload" | "stylesheet" | "static-import";

export interface FirstScreenFile {
  /** Path on the origin, with the content hash, e.g. /assets/app-shell-BCVSriIS.js */
  url: string;
  /** The file's name without its content hash, e.g. app-shell.js: the key two builds are compared on. */
  name: string;
  kind: FileKind;
  via: FileVia;
  bytes: number;
  /** Brotli (quality 11) size: close to what the CDN sends. */
  brBytes: number;
  /** SHA-256 of the content (hex). Tells a changed file apart when the web does not hash its file names. Absent in older snapshots. */
  sha256?: string;
  /** The response's Cache-Control (null when none). `no-store` files are downloaded again on every visit. Absent in older snapshots. */
  cacheControl?: string | null;
}

export interface ReleaseIdentity {
  commitSha: string | null;
  builtAt: string | null;
  deploymentEnvironment: string | null;
}

export interface FirstScreenSnapshot {
  schema: "raft-perf/first-screen@1";
  origin: string;
  takenAt: string;
  release: ReleaseIdentity;
  html: { bytes: number; brBytes: number; cacheControl?: string | null };
  files: FirstScreenFile[];
  /** static-import URLs the origin answered 404 for (regex false positives), not counted. Absent in files from before it existed. */
  skipped?: string[];
  totals: { files: number; jsBytes: number; jsBrBytes: number; cssBytes: number; cssBrBytes: number; brBytes: number };
}

export interface HtmlAssets {
  release: ReleaseIdentity;
  /** In document order, de-duplicated. */
  assets: { url: string; kind: FileKind; via: FileVia }[];
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
};

/** Resolve an asset reference to a same-origin path (with its query); null for other origins and data: URLs. */
export function sameOriginPath(ref: string, origin: string, base = "/"): string | null {
  let u: URL;
  try {
    u = new URL(ref, new URL(base, origin));
  } catch {
    return null;
  }
  if (u.origin !== new URL(origin).origin) return null;
  return u.pathname + u.search;
}

export function parseIndexHtml(html: string, origin: string): HtmlAssets {
  const assets: HtmlAssets["assets"] = [];
  const seen = new Set<string>();
  const push = (ref: string | null, kind: FileKind, via: FileVia) => {
    const path = ref == null ? null : sameOriginPath(ref, origin);
    if (path == null) return;
    if (seen.has(path)) {
      // the module script itself is the entry, even when its preload came first
      if (via === "entry") for (const a of assets) if (a.url === path) a.via = "entry";
      return;
    }
    seen.add(path);
    assets.push({ url: path, kind, via });
  };
  // Inline script bodies first (SSR state can contain "<!--"), then comments.
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, "$1</script>").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of markup.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    if (m[1].toLowerCase() === "script") {
      if ((attr(tag, "type") ?? "").toLowerCase() === "module") push(attr(tag, "src"), "js", "entry");
      continue;
    }
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload")) push(attr(tag, "href"), "js", "modulepreload");
    else if (rel.includes("stylesheet") && !rel.includes("alternate") && !/^print$/i.test(attr(tag, "media") ?? "")) push(attr(tag, "href"), "css", "stylesheet");
  }
  let release: ReleaseIdentity = { commitSha: null, builtAt: null, deploymentEnvironment: null };
  const id = html.match(/<script\b[^>]*\bid="raft-frontend-release-identity"[^>]*>([\s\S]*?)<\/script>/i);
  if (id) {
    try {
      const j = JSON.parse(id[1]);
      release = { commitSha: j.commitSha ?? j.releaseId ?? null, builtAt: j.builtAt ?? null, deploymentEnvironment: j.deploymentEnvironment ?? null };
    } catch {
      /* keep nulls: the snapshot still records sizes */
    }
  }
  return { release, assets };
}

/**
 * Relative static imports at statement starts (`import x from "./a.js"`,
 * `import "./b.js"`, `export * from "./c.js"`), the shape Rolldown emits.
 * Dynamic `import()` is not first-screen and is deliberately not matched.
 * A regex, not a parser: text that only looks like an import (inside a
 * template literal) can match; the snapshot skips such a URL when the
 * origin answers 404 and records it in `skipped`.
 */
export function staticImports(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[;\n})]|\*\/)\s*(?:import|export)\s*(?:[^"';()]*?\bfrom\s*)?["'](\.{1,2}\/[^"'\n]+?\.m?js(?:\?[^"'\n]*)?)["']/g;
  for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

/**
 * app-shell-BCVSriIS.js -> app-shell.js: drops Rolldown's 8-character content
 * hash. A suffix of only lowercase letters (`-settings`) is a word, not a hash.
 */
export function stableName(url: string): string {
  const file = (url.split("/").pop() ?? url).split("?")[0];
  return file.replace(/-([A-Za-z0-9_-]{8})(\.[a-z]+)$/, (whole, hash: string, ext: string) => (/[A-Z0-9_-]/.test(hash) ? ext : whole));
}

export function totals(files: readonly FirstScreenFile[]): FirstScreenSnapshot["totals"] {
  const sum = (k: "bytes" | "brBytes", kind?: FileKind) => files.filter((f) => !kind || f.kind === kind).reduce((a, f) => a + f[k], 0);
  return { files: files.length, jsBytes: sum("bytes", "js"), jsBrBytes: sum("brBytes", "js"), cssBytes: sum("bytes", "css"), cssBrBytes: sum("brBytes", "css"), brBytes: sum("brBytes") };
}

export interface FileChange {
  /** Stable name. Among changed / added / removed files, repeats of one name are `name#2`, `#3`… in document order; unchanged rows keep the plain name (tell them apart by URL). */
  name: string;
  change: "unchanged" | "changed" | "added" | "removed";
  baseUrl: string | null;
  headUrl: string | null;
  baseBrBytes: number | null;
  headBrBytes: number | null;
  /** The head file is served `no-store`: downloaded again on every visit, changed or not. */
  uncached?: boolean;
}

export interface FirstScreenDiff {
  schema: "raft-perf/first-screen-diff@1";
  base: { origin: string; commitSha: string | null; brBytes: number };
  head: { origin: string; commitSha: string | null; brBytes: number };
  /** head - base, brotli bytes of all first-screen files. */
  growthBrBytes: number;
  /**
   * Brotli bytes of head's first-screen files a returning visitor who has
   * base cached must download again: every head file that is new or changed
   * (its URL is not among base's, or, where both snapshots have content
   * hashes, the same URL now has different content), plus every `no-store` file.
   */
  invalidatedBrBytes: number;
  invalidatedShare: number;
  /** Part of invalidatedBrBytes that is `no-store`: downloaded on every visit, not only after a deploy. */
  uncachedBrBytes: number;
  files: FileChange[];
  verdict: "ok" | "grew";
  reason: string;
}

/** Name files for labelling: the stable name, then `#2`, `#3`… for repeats. */
function labelled(files: readonly FirstScreenFile[]): Map<string, FirstScreenFile> {
  const out = new Map<string, FirstScreenFile>();
  const count = new Map<string, number>();
  for (const f of files) {
    const n = (count.get(f.name) ?? 0) + 1;
    count.set(f.name, n);
    out.set(n === 1 ? f.name : `${f.name}#${n}`, f);
  }
  return out;
}

export const isNoStore = (f: FirstScreenFile): boolean => /(^|[\s,])no-store\b/i.test(f.cacheControl ?? "");

/**
 * Compare two snapshots. A head file is kept from the cache when base had the
 * same URL with the same content (content compared only where both snapshots
 * have hashes; with hashed file names the URL already decides) and it is not
 * `no-store`. Names only label the files: kept = unchanged; otherwise matched
 * by label (changed), else added / removed. Verdict "grew" when first-screen
 * brotli bytes grew by more than `maxGrowthBrBytes`.
 */
export function diffSnapshots(base: FirstScreenSnapshot, head: FirstScreenSnapshot, maxGrowthBrBytes = 10 * 1024): FirstScreenDiff {
  const baseByUrl = new Map(base.files.map((f) => [f.url, f]));
  const sameContent = (h: FirstScreenFile) => {
    const b = baseByUrl.get(h.url);
    return !!b && (!b.sha256 || !h.sha256 || b.sha256 === h.sha256);
  };
  const kept = (h: FirstScreenFile) => sameContent(h) && !isNoStore(h);
  const keptHead = head.files.filter(kept);
  const keptUrls = new Set(keptHead.map((f) => f.url));
  const fresh = head.files.filter((f) => !kept(f));
  const invalidated = fresh.reduce((a, f) => a + f.brBytes, 0);
  const uncached = head.files.filter(isNoStore).reduce((a, f) => a + f.brBytes, 0);
  const files: FileChange[] = [];
  for (const f of keptHead) files.push({ name: f.name, change: "unchanged", baseUrl: f.url, headUrl: f.url, baseBrBytes: baseByUrl.get(f.url)!.brBytes, headBrBytes: f.brBytes });
  // fresh head files with a same-URL base file pair with it first (content changed, or unchanged but no-store)
  const pairedBase = new Set<string>();
  const unpaired: FirstScreenFile[] = [];
  for (const hf of fresh) {
    const bf = baseByUrl.get(hf.url);
    if (bf && !keptUrls.has(hf.url) && !pairedBase.has(hf.url)) {
      pairedBase.add(hf.url);
      files.push({ name: hf.name, change: sameContent(hf) ? "unchanged" : "changed", baseUrl: bf.url, headUrl: hf.url, baseBrBytes: bf.brBytes, headBrBytes: hf.brBytes, ...(isNoStore(hf) ? { uncached: true } : {}) });
    } else unpaired.push(hf);
  }
  // the rest pair by name label
  const b = labelled(base.files.filter((f) => !keptUrls.has(f.url) && !pairedBase.has(f.url)));
  const h = labelled(unpaired);
  for (const [name, hf] of h) {
    const bf = b.get(name);
    files.push({ name, change: bf ? "changed" : "added", baseUrl: bf?.url ?? null, headUrl: hf.url, baseBrBytes: bf?.brBytes ?? null, headBrBytes: hf.brBytes, ...(isNoStore(hf) ? { uncached: true } : {}) });
  }
  for (const [name, bf] of b) if (!h.has(name)) files.push({ name, change: "removed", baseUrl: bf.url, headUrl: null, baseBrBytes: bf.brBytes, headBrBytes: null });
  const growth = head.totals.brBytes - base.totals.brBytes;
  const grew = growth > maxGrowthBrBytes;
  return {
    schema: "raft-perf/first-screen-diff@1",
    base: { origin: base.origin, commitSha: base.release.commitSha, brBytes: base.totals.brBytes },
    head: { origin: head.origin, commitSha: head.release.commitSha, brBytes: head.totals.brBytes },
    growthBrBytes: growth,
    invalidatedBrBytes: invalidated,
    invalidatedShare: head.totals.brBytes ? invalidated / head.totals.brBytes : 0,
    uncachedBrBytes: uncached,
    files,
    verdict: grew ? "grew" : "ok",
    reason: grew ? `first-screen brotli bytes grew by ${growth} (> ${maxGrowthBrBytes})` : `growth ${growth} <= ${maxGrowthBrBytes}`,
  };
}
