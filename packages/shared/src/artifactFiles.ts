// The type of an Artifact file: decided by its path's extension, never by the
// uploader's word or by sniffing the bytes (Raft Artifacts' rule, from
// Porthole's table). Server (Content-Type, kind) and clients share it.
import type { ArtifactKind } from "./workspaceArtifacts";

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  zip: "application/zip",
};

export interface ArtifactFileType {
  /** The Content-Type the file is served with. */
  contentType: string;
  /** How Raft shows it. */
  kind: ArtifactKind;
  /** Text (UTF-8) rather than binary bytes. */
  text: boolean;
}

/**
 * A title made from a file's name (Save as Artifact): without its last
 * extension when that names a type Raft knows (TYPES), so `notes.md` reads
 * `notes`; any other name as it is (`v1.2`, `2026.10.30`), and never empty
 * (`.env`). Kirby, #proj-workspace:f23b19b6.
 */
export function artifactTitleFromFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || TYPES[name.slice(dot + 1).toLowerCase()] === undefined) return name;
  return name.slice(0, dot).trim() || name;
}

/** The page's `<title>` is looked for in its first 256 KiB: it belongs in `<head>`. */
const HTML_TITLE_SCAN_CHARS = 256 * 1024;
const HTML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/**
 * A page's `<title>` as text (the first one; the common character
 * references decoded, whitespace collapsed), or null when it has none or an
 * empty one: what a new Artifact is titled when its push gives no title and
 * its entry is a page (agentOps artifactsPublish).
 */
export function artifactTitleFromHtml(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html.slice(0, HTML_TITLE_SCAN_CHARS));
  if (!match) return null;
  const text = match[1]!
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, ref: string) => {
      if (ref[0] !== "#") return HTML_ENTITIES[ref.toLowerCase()] ?? whole;
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}

export function artifactFileType(path: string): ArtifactFileType {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const contentType = (dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined) ?? "application/octet-stream";
  const bare = contentType.split(";")[0]!;
  const text = bare.startsWith("text/") || bare === "application/json" || bare === "application/xml" || bare === "image/svg+xml";
  let kind: ArtifactKind;
  if (bare === "text/html") kind = "html";
  else if (bare === "text/markdown") kind = "markdown";
  else if (bare === "text/csv") kind = "csv";
  else if (bare.startsWith("image/")) kind = "image";
  else if (bare === "application/pdf") kind = "pdf";
  else if (bare.startsWith("video/")) kind = "video";
  else if (text) kind = "text";
  else kind = "other";
  return { contentType, kind, text };
}

/**
 * The page a file opens as in its version's frame on the content origin, as a
 * path among the files the content Worker serves for that version: an HTML
 * page is its own; a Markdown file or a PDF is the page the Worker makes
 * beside it (`notes.md` as `notes.md.html`, the rendered page; `report.pdf`
 * as `report.pdf.html`, the viewer). Null for a kind no frame shows. The
 * server signs a frame's `page` from it and the Worker makes its pages at it:
 * one rule for both.
 */
export function artifactFramedPagePath(path: string): string | null {
  const { kind } = artifactFileType(path);
  if (kind === "html") return path;
  return kind === "markdown" || kind === "pdf" ? `${path}.html` : null;
}
