// A pushed version's pages that hold themselves to one screen (task #71), or
// hold frames of their own, and the copies of common libraries it brings
// (bundledLibraries.ts): the push's `warnings`, after the commit, best effort.
//
// An app shell's global styles (`html, body { height: 100%; overflow: hidden }`,
// Tailwind's `h-screen overflow-hidden`, `#root { position: fixed }`) stop a
// page at its first screen in Raft's frame: the reader can't scroll to the
// rest. Porthole's `lintFiles` scroll-lock rule (P106/P110) reads that from the
// text alone, no browser: the entry and up to 7 more pages, and the
// stylesheets they link and import, from the files it is given. Its
// nested-frame rule is kept too: an `<iframe>` (srcdoc ones included),
// `<frame>`, `<object>` or `<embed>` in a page's markup is removed in Raft's
// frame (Porthole's frame guard; Raft doesn't take `nestedFrames: "own"`).
// Only those two rules are kept here; the version is published whatever they
// say.
//
// - Porthole's rules read markup only. A page's own `<script>` elements that
//   create a frame-like element (`createElement("iframe")`, `createElementNS`,
//   any quote; P130's list: iframe, frame, frameset, object, embed, portal,
//   fencedframe) are found here, as text too, and warned as `nested-frame`:
//   that call throws in Raft's frame (Porthole 0.14.8), so the rest of that
//   script doesn't run. Scripts in files of their own (a bundle, a library)
//   aren't read: they would share the byte budget with the pages, and a
//   library's frame may sit on a path the page never takes.
// - What an HTML comment holds isn't in the page: comments outside
//   `<script>`/`<style>` are blanked (lines kept) before either check, so a
//   commented-out `<iframe>` or rule doesn't warn; so are a script's own
//   comments for the createElement check. The word "iframe" in a page's text
//   never warns: the rules want a tag (`<iframe`) or the call.
//
// - Only when the entry is a page (HTML). The pages it reads are the ones
//   lintFiles would (the entry, then the others in path order, 8 in all); the
//   stylesheets are the version's own files those pages link (`<link href>`)
//   or that a read sheet `@import`s, found by path as lintFiles finds them.
// - Bytes from the request's inline files where it brought them (the same
//   sha256), else from the blob store, all reads together, at most
//   SCROLL_CHECK_BYTES in all: a version whose pages and sheets are more is
//   not checked (no warning), nor is one whose reads don't finish within
//   SCROLL_CHECK_TIMEOUT_MS. Any failure (storage, a missing blob, Porthole)
//   is no warning, never a failed push.
// - The config is Raft's framing (packages/content-worker/src/raftContentDisplays.ts:
//   the artifact preset served on a content origin, `layout: fill`), with the
//   page size limit raised to what this check reads: Raft serves pages larger
//   than Porthole's 200 KB default, and lintFiles skips a page over the limit.
// - Porthole is loaded on the first check, not at startup.
// - The bundled-library check (bundledLibraries.ts) runs beside these, within
//   the same time; its reads are its own (the first bytes of a few files),
//   not this budget's, and what it finds by name alone stands without them.
import { and, eq, inArray } from "drizzle-orm";
import type { PortholeConfig } from "@botiverse/porthole";
import type { AgentApiArtifactPublishWarning, ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { artifactR2Store, type ArtifactBlobReader } from "./blobStore";
import { bundledLibraryWarnings } from "./bundledLibraries";
import { artifactBlobs, type ArtifactBlobRow } from "./schema";

/** The lintFiles rules a push warns about: pages held to one screen, and pages with nested frames or plugins. */
const KEPT_RULES: ReadonlySet<string> = new Set(["scroll-lock", "nested-frame"]);
/** A comment, or a raw-text element whose `<!--` is no comment (a script's, a style's). */
const COMMENT_OR_RAW = /<!--|<(script|style|textarea|title)\b/giu;
/** A `<script>` element's start tag. */
const SCRIPT_TAG = /<script\b[^<>]{0,8192}>/giu;
/** A script creating a frame-like element (P130's list), any quote; an `NS` call's namespace is one short argument. */
const CREATES_FRAME = /\bcreateElement(NS)?\s{0,64}\(\s{0,64}(?:[^,()]{0,256},\s{0,64})?(["'`])(iframe|frameset|frame|object|embed|portal|fencedframe)\2\s{0,64}[,)]/giu;
/** The most bytes of pages and stylesheets one check reads; a version needing more isn't checked. */
export const SCROLL_CHECK_BYTES = 2 * 1024 * 1024;
/** How long the reads may take before the check gives up (no warning). */
export const SCROLL_CHECK_TIMEOUT_MS = 1_500;
/** The pages lintFiles' scroll-lock rule reads: the entry and 7 more (Porthole's SCROLL_PAGES). */
const SCROLL_PAGES = 8;
/** How deep `@import` is followed (Porthole follows 8). */
const DEEPEST_IMPORT = 8;

/** A file of the version: its bytes' sha256, size and blob row id. */
export interface ScrollCheckFile {
  sha256: string;
  size: number;
  blobId: string | null;
}

type Porthole = typeof import("@botiverse/porthole");
let loaded: Promise<{ porthole: Porthole; config: PortholeConfig }> | null = null;

function portholeOnce() {
  loaded ??= import("@botiverse/porthole").then((porthole) => {
    const displays = porthole.defineDisplays({
      artifact: { preset: "artifact", options: { layout: { kind: "fill" }, limits: { maxBytes: SCROLL_CHECK_BYTES } } },
    });
    return { porthole, config: displays.guideConfig("artifact", "served") };
  });
  // A failed load is tried again on the next push.
  loaded.catch(() => { loaded = null; });
  return loaded;
}

const LINK_TAG = /<link\b([^<>]{0,8192})>/giu;
const HREF = /\bhref\s{0,64}=\s{0,64}(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\s"'>]{1,2048}))/iu;
const IMPORT = /@import\s{1,64}(?:url\(\s{0,64}(["']?)([^"'()\s]{1,2048})\1\s{0,64}\)|(["'])([^"'\n]{1,2048})\3)/giu;

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/** `text` with `from`..`to` turned to spaces, its line breaks kept (so are the lines of what follows). */
const blank = (text: string, from: number, to: number): string => text.slice(from, to).replace(/[^\n]/gu, " ");
const linesIn = (text: string): number => text.split("\n").length - 1;

/** A page's text with its HTML comments blanked, lines kept; a script's or a style's text is left as it is. */
function withoutComments(page: string): string {
  let out = "";
  let kept = 0;
  const at = new RegExp(COMMENT_OR_RAW);
  for (let found = at.exec(page); found !== null; found = at.exec(page)) {
    const raw = found[1];
    if (raw !== undefined) {
      const close = new RegExp(`</${raw}`, "giu");
      close.lastIndex = found.index + found[0].length;
      const end = close.exec(page);
      if (end === null) break;
      at.lastIndex = end.index + end[0].length;
      continue;
    }
    const close = page.indexOf("-->", found.index + 4);
    const end = close < 0 ? page.length : close + 3;
    out += page.slice(kept, found.index) + blank(page, found.index, end);
    kept = end;
    at.lastIndex = end;
  }
  return kept === 0 ? page : out + page.slice(kept);
}

/** A script's text with its comments blanked, lines kept, strings left as they are. Best effort: a regex literal holding a quote can mislead it. */
function withoutScriptComments(code: string): string {
  let out = "";
  let kept = 0;
  let quote = "";
  for (let at = 0; at < code.length; at += 1) {
    const char = code[at];
    if (quote !== "") {
      if (char === "\\") at += 1;
      else if (char === quote || (char === "\n" && quote !== "`")) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "/" && (code[at + 1] === "/" || code[at + 1] === "*")) {
      const line = code[at + 1] === "/";
      const close = code.indexOf(line ? "\n" : "*/", at + 2);
      const end = close < 0 ? code.length : line ? close : close + 2;
      out += code.slice(kept, at) + blank(code, at, end);
      kept = end;
      at = end - 1;
    }
  }
  return out + code.slice(kept);
}

/**
 * The first of a page's own `<script>` elements to create a frame-like element, as a nested-frame
 * warning: the call throws in Raft's frame (Porthole 0.14.8, P130), and the rest of that script
 * doesn't run. `page` is already without its HTML comments.
 */
function scriptFrameWarning(path: string, page: string): AgentApiArtifactPublishWarning | null {
  const tag = new RegExp(SCRIPT_TAG);
  for (let start = tag.exec(page); start !== null; start = tag.exec(page)) {
    const from = start.index + start[0].length;
    const close = /<\/script/giu;
    close.lastIndex = from;
    const end = close.exec(page)?.index ?? page.length;
    const code = withoutScriptComments(page.slice(from, end));
    const call = new RegExp(CREATES_FRAME).exec(code);
    if (call !== null) {
      const element = (call[3] ?? "").toLowerCase();
      const named = `createElement${call[1] ?? ""}(${call[1] ? "…, " : ""}"${element}")`;
      return {
        rule: "nested-frame",
        path,
        line: linesIn(page.slice(0, from)) + linesIn(code.slice(0, call.index)) + 1,
        message: `Remove ${named} from this script: in Raft's frame that line throws and the rest of that script doesn't run (a page can't hold frames of its own). Draw the content in the page itself (a scaled <div> for a mock-up), or link to it.`,
      };
    }
    tag.lastIndex = end;
  }
  return null;
}

/** `reference` from a file in `directory`, as a path of the version (as Porthole resolves it); null for another origin, a rooted path, or above the version. */
function resolve(directory: string, reference: string): string | null {
  if (reference === "" || /^[a-z][a-z0-9+.-]*:/iu.test(reference) || reference.startsWith("/") || reference.startsWith("#")) return null;
  const bare = reference.split("#")[0]?.split("?")[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare;
  }
  const segments = `${directory}${decoded}`.split("/");
  const out: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else if (segment !== "." && (segment !== "" || index === segments.length - 1)) {
      out.push(segment);
    }
  }
  return out.join("/");
}

/** What a page links (`<link href>`) and what it or a sheet `@import`s, as paths of the version. */
function sheetsNamedIn(path: string, text: string, page: boolean): string[] {
  const directory = directoryOf(path);
  const references: string[] = [];
  if (page) {
    for (const tag of text.matchAll(LINK_TAG)) {
      const href = HREF.exec(tag[1] ?? "");
      if (href) references.push(href[1] ?? href[2] ?? href[3] ?? "");
    }
  }
  for (const imported of text.matchAll(IMPORT)) references.push(imported[2] ?? imported[4] ?? "");
  return references.map((reference) => resolve(directory, reference)).filter((target): target is string => target !== null);
}

/** All of a blob's bytes, at most `size`. */
async function readBlob(reader: ArtifactBlobReader, blob: ArtifactBlobRow, signal: AbortSignal): Promise<Buffer> {
  const bytes = await reader.read(blob, signal);
  if (!bytes) throw new Error("blob has no object");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > blob.sizeBytes) throw new Error("blob longer than its row");
      chunks.push(buffer);
    }
  } finally {
    bytes.stream.destroy();
  }
  return Buffer.concat(chunks, total);
}

let checking = true;

/** Tests: turn the check off (it reads storage too, which a test counting reads would see); undefined turns it back on. */
export function __setScrollLockCheckForTests(on: boolean | undefined): void {
  checking = on ?? true;
}

/**
 * The push's warnings for a version just committed: scroll-lock and nested-frame, then
 * bundled-library. `files` its manifest, `changed` the paths the push adds, replaces or removes,
 * `inline` the bytes the request brought by path (only those whose sha256 is the version's). The
 * page checks say nothing when the entry isn't a page, or they couldn't be made within their
 * budget and time.
 */
export async function scrollLockWarnings(input: {
  serverId: ServerId;
  entry: string;
  files: ReadonlyMap<string, ScrollCheckFile>;
  changed: readonly string[];
  inline: ReadonlyMap<string, Buffer>;
}): Promise<AgentApiArtifactPublishWarning[]> {
  if (!checking) return [];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => { controller.abort(); done(null); }, SCROLL_CHECK_TIMEOUT_MS);
  });
  const running = check(input, controller.signal);
  // Past the timeout nobody awaits it: its failure then is no unhandled rejection.
  running.catch(() => {});
  const failed = (what: string) => (error: unknown) => {
    console.warn(`artifacts ${what} check failed`, error instanceof Error ? error.message : error);
    return null;
  };
  const pages = Promise.race([running, timeout]).catch(failed("scroll-lock"));
  // The library check stops reading at the timeout's abort; what it found by name stands.
  const libraries = bundledLibraryWarnings(input, controller.signal).catch(failed("bundled-library"));
  try {
    const [checked, copies] = await Promise.all([pages, libraries]);
    return [...(checked ?? []), ...(copies ?? [])];
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function check(
  input: Parameters<typeof scrollLockWarnings>[0],
  signal: AbortSignal,
): Promise<AgentApiArtifactPublishWarning[] | null> {
  const { porthole, config } = await portholeOnce();
  const isPage = (path: string) => porthole.fileTypeOf(path).role === "page";
  if (!isPage(input.entry) || !input.files.has(input.entry)) return [];

  const read = new Map<string, Buffer>();
  let budget = SCROLL_CHECK_BYTES;
  let blobRows: Map<string, ArtifactBlobRow> | null = null;
  const reader = artifactR2Store();

  /** Reads `paths` (all of them, or null when over the budget or one can't be read). */
  const readAll = async (paths: readonly string[]): Promise<boolean> => {
    for (const path of paths) budget -= input.files.get(path)!.size;
    if (budget < 0) return false;
    const fromStore = paths.filter((path) => !input.inline.has(path));
    if (fromStore.length > 0) {
      if (!reader) return false;
      const ids = fromStore.map((path) => input.files.get(path)!.blobId).filter((id): id is string => id !== null);
      if (ids.length < fromStore.length) return false;
      const rows = await getDb().select().from(artifactBlobs).where(and(
        eq(artifactBlobs.serverId, input.serverId),
        eq(artifactBlobs.state, "ready"),
        inArray(artifactBlobs.id, ids),
      ));
      blobRows = new Map([...(blobRows ?? new Map<string, ArtifactBlobRow>()), ...rows.map((row) => [row.id, row] as const)]);
    }
    // One at a time: the reads are few and small (SCROLL_PAGES pages and their
    // sheets, within SCROLL_CHECK_BYTES), and none of them borrows a fan-out.
    for (const path of paths) {
      const inline = input.inline.get(path);
      if (inline) {
        read.set(path, inline);
        continue;
      }
      const blob = blobRows!.get(input.files.get(path)!.blobId!);
      if (!blob) throw new Error("blob row not found");
      read.set(path, await readBlob(reader!, blob, signal));
    }
    return true;
  };

  // The pages lintFiles' rule reads: the entry, then the others in path order.
  const pages = [input.entry, ...[...input.files.keys()].filter((path) => path !== input.entry && isPage(path)).sort()].slice(0, SCROLL_PAGES);
  if (!await readAll(pages)) return null;
  // The stylesheets they link, and what those import, round by round.
  let named = pages.flatMap((path) => sheetsNamedIn(path, read.get(path)!.toString("utf8"), true));
  for (let depth = 0; depth <= DEEPEST_IMPORT; depth += 1) {
    const sheets = [...new Set(named)].filter((path) => !read.has(path) && input.files.has(path) && path.toLowerCase().endsWith(".css"));
    if (sheets.length === 0) break;
    if (!await readAll(sheets)) return null;
    named = sheets.flatMap((path) => sheetsNamedIn(path, read.get(path)!.toString("utf8"), false));
  }
  if (signal.aborted) return null;

  // The pages without their HTML comments (lines kept): what a comment holds isn't in the page.
  const pageText = new Map(pages.map((path) => [path, withoutComments(read.get(path)!.toString("utf8"))] as const));
  const files = Object.fromEntries([...read].map(([path, bytes]) => {
    const text = pageText.get(path);
    const body = text === undefined ? bytes : Buffer.from(text, "utf8");
    return [path, new Uint8Array(body.buffer, body.byteOffset, body.byteLength)];
  }));
  const found: AgentApiArtifactPublishWarning[] = porthole.lintFiles(config, files, { entry: input.entry })
    // A page held to one screen, where it is held, and a page that embeds frames of its own (they never load in
    // Raft's frame: QA #proj-workspace:04df2a51, a prototype's stages left blank); not the notes on pages it couldn't check.
    .filter((finding) => KEPT_RULES.has(finding.rule) && finding.path !== undefined && finding.line !== undefined)
    .map((finding) => ({ rule: finding.rule, path: finding.path!, line: finding.line!, message: finding.message }));
  // A page's own scripts that create a frame (Porthole's rule reads only markup).
  for (const [path, text] of pageText) {
    const created = scriptFrameWarning(path, text);
    if (created) found.push(created);
  }
  return found;
}
