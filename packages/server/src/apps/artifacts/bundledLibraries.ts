// A push's copies of common libraries (`bundled-library`): one of the push's
// `warnings` (scrollLock.ts runs it beside the page checks), never a refusal.
//
// Raft's frame lets a page load scripts, styles and fonts from the library
// CDNs (Porthole's `LIBRARY_CDNS`, packages/content-worker/src/raftContentDisplays.ts),
// so a library copied into the artifact only costs: its bytes count against
// the server's monthly upload quota each time they change (a build that
// rewrites its bundle changes them every version). The warning names the copy
// and the pinned jsDelivr address to load instead, or the package's page there
// when the version isn't known.
//
// - Only when the entry is a page (HTML), and only scripts and stylesheets
//   this push adds or replaces (a file carried over was warned about when it
//   came) of at least LIBRARY_MIN_BYTES: every listed build is larger, and a
//   page's own small file named like one (chart.js) isn't one.
// - Found by its name (LIBRARIES: a library's own build names, e.g.
//   jquery-3.7.1.min.js, react-dom.production.min.js, chart.umd.min.js; a name
//   a page's own code could have, such as chart.js or three.js, needs the
//   banner), or by the banner its build starts with (`/*! jQuery v3.7.1`,
//   `@license React v17.0.2`): the file's first comment, in its first
//   BANNER_BYTES. Only the first: a page's own bundle may carry a library's
//   license comment further in, and is no copy of it. The version is the
//   banner's, else the one in the name.
// - Banners are read from the request's inline bytes, and from storage for at
//   most BANNER_FILES more (in path order, those not already named with their
//   version; the first chunk only), one at a time, until the push's warnings
//   are out of time: a file not read is still found by its name. Any failure
//   reading is no banner.
// - The list is small on purpose: the libraries pages copy in most, each with
//   a jsDelivr build to point at. A renamed copy without a banner (vendor.js)
//   isn't found, and Tailwind's stylesheet isn't listed: a tailwind.css is
//   usually the page's own build of the classes it uses.
import { and, eq, inArray } from "drizzle-orm";
import { artifactFileType, type AgentApiArtifactPublishWarning, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { artifactR2Store } from "./blobStore";
import { artifactBlobs, type ArtifactBlobRow } from "./schema";

/** The smallest file that is checked: the smallest build listed (React 18's UMD) is about 10 KB. */
export const LIBRARY_MIN_BYTES = 4 * 1024;
/** How much of a file's start is read for a banner. */
export const BANNER_BYTES = 1024;
/** The most files whose banner one push reads. */
export const BANNER_FILES = 8;

type Kind = "script" | "style";

interface Library {
  /** As the warning names it. */
  title: string;
  /** Its build's file names (the last path segment). */
  names: RegExp;
  /** The banner its build starts with; the version, where it says one, in group 1. */
  banner?: RegExp;
  /** The address to load it from at `version`. */
  url: (version: string, kind: Kind) => string;
  /** Where its versions are listed, when the version isn't known. */
  page: string;
}

const jsdelivr = (npm: string, file?: (kind: Kind) => string): Pick<Library, "url" | "page"> => ({
  url: (version, kind) => `https://cdn.jsdelivr.net/npm/${npm}@${version}${file ? `/${file(kind)}` : ""}`,
  page: `https://www.jsdelivr.com/package/npm/${npm}`,
});

/** The copies warned about (names in any case). */
const LIBRARIES: readonly Library[] = [
  { title: "jQuery", names: /^jquery(?:-\d+\.\d+\.\d+)?(?:\.slim)?(?:\.min)?\.js$/iu, banner: /\bjQuery (?:JavaScript Library )?v(\d+\.\d+\.\d+)/u, ...jsdelivr("jquery", () => "dist/jquery.min.js") },
  { title: "ReactDOM", names: /^react-dom(?:\.(?:production|development))?(?:\.min)?\.js$/iu, banner: /@license React(?: v(\d+\.\d+\.\d+))?[\s*]*react-dom\.(?:production|development)/u, ...jsdelivr("react-dom", () => "umd/react-dom.production.min.js") },
  { title: "React", names: /^react(?:\.(?:production|development))?(?:\.min)?\.js$/iu, banner: /@license React(?: v(\d+\.\d+\.\d+))?[\s*]*react\.(?:production|development)/u, ...jsdelivr("react", () => "umd/react.production.min.js") },
  { title: "Chart.js", names: /^chart(?:\.umd(?:\.min)?|\.bundle(?:\.min)?|\.min)\.js$/iu, banner: /\bChart\.js v(\d+\.\d+\.\d+)/u, ...jsdelivr("chart.js") },
  { title: "three.js", names: /^three(?:\.module(?:\.min)?|\.min)\.js$/iu, banner: /\bCopyright 2010-\d{4} Three\.js Authors/u, ...jsdelivr("three", () => "build/three.module.js") },
  { title: "D3", names: /^d3(?:\.v\d+)?(?:\.min)?\.js$/iu, banner: /\bd3js\.org v(\d+\.\d+\.\d+)/u, ...jsdelivr("d3") },
  { title: "Plotly", names: /^plotly(?:-latest|-\d+\.\d+\.\d+)?(?:\.min)?\.js$/iu, banner: /\bplotly\.js v(\d+\.\d+\.\d+)/u, ...jsdelivr("plotly.js-dist-min") },
  { title: "Vue", names: /^vue(?:\.global|\.runtime\.global)?(?:\.prod)?(?:\.min)?\.js$/iu, banner: /\bvue(?:\.js)? v(\d+\.\d+\.\d+)/iu, ...jsdelivr("vue") },
  { title: "Lodash", names: /^lodash(?:\.core)?(?:\.min)?\.js$/iu, banner: /@license[\s*]*Lodash\b/u, ...jsdelivr("lodash") },
  { title: "Bootstrap", names: /^bootstrap(?:\.bundle)?(?:\.min)?\.(?:js|css)$/iu, banner: /\bBootstrap +v(\d+\.\d+\.\d+)/u, ...jsdelivr("bootstrap", (kind) => (kind === "style" ? "dist/css/bootstrap.min.css" : "dist/js/bootstrap.bundle.min.js")) },
  { title: "Mermaid", names: /^mermaid(?:\.min)?\.js$/iu, ...jsdelivr("mermaid", () => "dist/mermaid.min.js") },
  { title: "KaTeX", names: /^katex(?:\.min)?\.(?:js|css)$/iu, ...jsdelivr("katex", (kind) => (kind === "style" ? "dist/katex.min.css" : "dist/katex.min.js")) },
  { title: "highlight.js", names: /^highlight\.min\.js$/iu, banner: /\bHighlight\.js v(\d+\.\d+\.\d+)/u, ...jsdelivr("@highlightjs/cdn-assets", () => "highlight.min.js") },
  // A saved copy of Tailwind's Play CDN script (Porthole's guide teaches it at cdn.tailwindcss.com/<version>);
  // v4's Play CDN is @tailwindcss/browser on jsDelivr (cdn.tailwindcss.com has no 4.x).
  { title: "Tailwind's Play CDN", names: /^tailwind(?:css)?(?:-\d+\.\d+\.\d+)?(?:\.min)?\.js$/iu, url: (version) => (/^[4-9]\./u.test(version) ? `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${version}` : `https://cdn.tailwindcss.com/${version}`), page: "https://tailwindcss.com/docs/installation/play-cdn" },
];

const VERSION_IN_NAME = /\d+\.\d+\.\d+/u;
/** A file's first comment (its start, when it runs past what was read), after a stylesheet's `@charset` or a script's `"use strict"`. */
const LEADING_COMMENT = /^\uFEFF?\s*(?:@charset\s+"[^"]*";\s*|(["'])use strict\1;?\s*)?(\/\*(?:[\s\S]*?\*\/|[\s\S]*$)|\/\/[^\n]*)/u;

const kindOf = (path: string): Kind | null => {
  const lower = path.toLowerCase();
  return lower.endsWith(".css") ? "style" : lower.endsWith(".js") || lower.endsWith(".mjs") ? "script" : null;
};
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The library `path` is a copy of, by its name or the banner at `head`'s start, and its version where either says it. */
export function libraryCopyOf(path: string, head: string | null): { library: Library; version: string | null; byBanner: boolean } | null {
  const name = nameOf(path);
  const comment = head === null ? "" : (LEADING_COMMENT.exec(head)?.[2] ?? "");
  for (const library of LIBRARIES) {
    const banner = comment === "" ? null : library.banner?.exec(comment);
    if (banner) return { library, version: banner[1] ?? VERSION_IN_NAME.exec(name)?.[0] ?? null, byBanner: true };
  }
  const named = LIBRARIES.find((library) => library.names.test(name));
  return named ? { library: named, version: VERSION_IN_NAME.exec(name)?.[0] ?? null, byBanner: false } : null;
}

/** The warning for a copy found at `path`. */
export function bundledLibraryWarning(path: string, copy: NonNullable<ReturnType<typeof libraryCopyOf>>): AgentApiArtifactPublishWarning {
  const { library, version, byBanner } = copy;
  const what = `${byBanner ? "This is" : "By its name, this looks like"} a copy of ${library.title}${version === null ? "" : ` ${version}`}`;
  const load = version === null
    ? `point the page's src (or href) at a library CDN, pinned to the version you use (its versions: ${library.page}),`
    : `point the page's src (or href) at ${library.url(version, kindOf(path) ?? "script")}`;
  return {
    rule: "bundled-library",
    path,
    message: `${what}: ${load} and delete this file. A copied library counts against the server's monthly upload quota each time its bytes change; an address doesn't.`,
  };
}

/** The first BANNER_BYTES of a blob: the stream's first chunks, then it is closed. */
async function headOf(blob: ArtifactBlobRow, signal: AbortSignal): Promise<Buffer> {
  const reader = artifactR2Store();
  if (!reader) throw new Error("no storage");
  const bytes = await reader.read(blob, signal);
  if (!bytes) throw new Error("blob has no object");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= BANNER_BYTES) break;
    }
  } finally {
    bytes.stream.destroy();
  }
  return Buffer.concat(chunks, total);
}

/**
 * The bundled-library warnings for a version just committed: `changed` the paths this push adds,
 * replaces or removes, `files` the version's manifest, `inline` the bytes the request brought by
 * path (the version's own). Reads stop when `signal` aborts (the push's warnings are out of time),
 * and a failed read is no banner.
 */
export async function bundledLibraryWarnings(input: {
  serverId: ServerId;
  entry: string;
  changed: readonly string[];
  files: ReadonlyMap<string, { size: number; blobId: string | null }>;
  inline: ReadonlyMap<string, Buffer>;
}, signal: AbortSignal): Promise<AgentApiArtifactPublishWarning[]> {
  if (artifactFileType(input.entry).kind !== "html" || !input.files.has(input.entry)) return [];
  const candidates = input.changed
    .filter((path) => kindOf(path) !== null && (input.files.get(path)?.size ?? 0) >= LIBRARY_MIN_BYTES)
    .sort();
  if (candidates.length === 0) return [];

  // The request's bytes are in hand; from storage, the first BANNER_FILES not already named with their version.
  const heads = new Map<string, string>();
  const textOf = (bytes: Buffer) => bytes.subarray(0, BANNER_BYTES).toString("utf8");
  for (const path of candidates) {
    const inline = input.inline.get(path);
    if (inline) heads.set(path, textOf(inline));
  }
  const fromStore = candidates
    .filter((path) => !heads.has(path) && input.files.get(path)!.blobId !== null && (libraryCopyOf(path, null)?.version ?? null) === null)
    .slice(0, BANNER_FILES);
  const stopped = new Promise<null>((done) => {
    if (signal.aborted) done(null);
    signal.addEventListener("abort", () => done(null), { once: true });
  });
  if (fromStore.length > 0 && !signal.aborted) {
    try {
      const ids = fromStore.map((path) => input.files.get(path)!.blobId!);
      const query = Promise.resolve(getDb().select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, input.serverId), eq(artifactBlobs.state, "ready"), inArray(artifactBlobs.id, ids))));
      // Past the stop nobody awaits it: its failure then is no unhandled rejection.
      query.catch(() => {});
      const rows = await Promise.race([query, stopped]);
      const byId = new Map((rows ?? []).map((row) => [row.id, row] as const));
      for (const path of fromStore) {
        const blob = byId.get(input.files.get(path)!.blobId!);
        if (signal.aborted) break;
        if (!blob) continue;
        const head = await Promise.race([headOf(blob, signal).catch(() => null), stopped]);
        if (head) heads.set(path, textOf(head));
      }
    } catch (error) {
      console.warn("artifacts bundled-library check failed", error instanceof Error ? error.message : error);
    }
  }

  return candidates.flatMap((path) => {
    const copy = libraryCopyOf(path, heads.get(path) ?? null);
    return copy ? [bundledLibraryWarning(path, copy)] : [];
  });
}
