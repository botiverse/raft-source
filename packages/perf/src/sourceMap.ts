/**
 * Zero-dependency SourceMap v3 decoder and directory registry for `raft-perf diagnose`.
 *
 * Resolves minified V8 CPU profile frames (0-based line/column) and Chrome trace
 * stack frames (1-based line/column) back to original TypeScript/React source files,
 * 1-based lines, symbol names, and high-level subsystem buckets without adding
 * runtime dependencies or serving `.map` files into the measured browser.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface RawSourceMap {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources?: Array<string | null>;
  names?: string[];
  mappings?: string;
  sections?: Array<{
    offset: { line: number; column: number };
    map?: RawSourceMap;
    url?: string;
  }>;
}

export interface ResolvedLocation {
  /** Normalized source path (e.g. `packages/web/src/features/messages/MessageList.tsx` or `node_modules/react-dom/...`). */
  source: string;
  /** 1-based original line number. */
  line: number;
  /** 1-based original column number. */
  column: number;
  /** Original identifier from the `names` table when recorded by the bundler. */
  name: string | null;
  /** Subsystem bucket for aggregated attribution. */
  bucket: SourceBucket;
}

export type SourceBucket =
  | "app"
  | "react"
  | "markdown"
  | "rich-content"
  | "ui"
  | "state-network"
  | "vendor"
  | "bundle-unmapped"
  | "runtime";

interface Segment {
  genCol: number;
  srcIdx: number;
  origLine: number;
  origCol: number;
  nameIdx: number;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_TABLE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_TABLE[BASE64_CHARS.charCodeAt(i)] = i;
}

function decodeVlq(input: string, startIndex: number): [value: number, nextIndex: number] {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  while (index < input.length) {
    const code = input.charCodeAt(index++);
    const digit = code < 128 ? BASE64_TABLE[code]! : -1;
    if (digit < 0) throw new Error(`invalid Base64 VLQ character at index ${index - 1}`);
    const continuation = (digit & 32) !== 0;
    result += (digit & 31) << shift;
    shift += 5;
    if (!continuation) {
      const negative = (result & 1) === 1;
      const unsigned = result >>> 1;
      return [negative ? -unsigned : unsigned, index];
    }
  }
  throw new Error("truncated Base64 VLQ sequence");
}

/** Normalize a bundler source path into a clean repository- or package-relative path. */
export function cleanSourcePath(rawSource: string, mapDir?: string, sourceRoot?: string): string {
  let cleaned = rawSource
    .replace(/^(?:webpack|vite|rollup|rolldown|file):\/\/\//i, "/")
    .replace(/^(?:webpack|vite|rollup|rolldown):\/\//i, "")
    .replace(/^\.\//, "")
    .replace(/\?.*$/, "");

  if (mapDir && !cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
    const base = sourceRoot && !/^https?:\/\//i.test(sourceRoot) ? path.resolve(mapDir, sourceRoot) : mapDir;
    const abs = path.resolve(base, cleaned).replaceAll("\\", "/");
    const nmIdx = abs.lastIndexOf("/node_modules/");
    if (nmIdx >= 0) return abs.slice(nmIdx + 1);
    for (const marker of ["/packages/", "/apps/", "/scripts/"]) {
      const idx = abs.indexOf(marker);
      if (idx >= 0) return abs.slice(idx + 1);
    }
  }

  cleaned = cleaned.replaceAll("\\", "/");
  const nmIdx = cleaned.lastIndexOf("node_modules/");
  if (nmIdx >= 0) return cleaned.slice(nmIdx);
  for (const marker of ["packages/", "apps/", "scripts/"]) {
    const idx = cleaned.indexOf(marker);
    if (idx >= 0) return cleaned.slice(idx);
  }
  return cleaned.replace(/^(?:\.\.\/)+/, "");
}

/** Classify a resolved source path (or fallback script URL) into a high-level subsystem bucket. */
export function classifySourceBucket(source: string, functionName = ""): SourceBucket {
  if (!source || source.startsWith("node:") || source.startsWith("extensions::")) return "runtime";
  if (
    functionName === "(idle)" ||
    functionName === "(program)" ||
    functionName === "(garbage collector)" ||
    source === "(native)"
  ) {
    return "runtime";
  }

  const lower = source.toLowerCase();
  if (lower.includes("node_modules/")) {
    const afterNm = lower.slice(lower.lastIndexOf("node_modules/") + "node_modules/".length);
    // Handle pnpm virtual store paths (`node_modules/.pnpm/pkg@ver/node_modules/pkg/...`)
    if (
      /^(?:react|react-dom|scheduler|use-sync-external-store)(?:\/|$)/.test(afterNm)
    ) {
      return "react";
    }
    if (
      /^(?:react-markdown|remark-|rehype-|unified|micromark|mdast-|hast-|unist-|vfile|katex)(?:[\w-]*)(?:\/|$)/.test(afterNm)
    ) {
      return "markdown";
    }
    if (/^(?:shiki|@shikijs\/|mermaid|d3-|dagre|cytoscape|khroma)(?:[\w-]*)(?:\/|$)/.test(afterNm)) {
      return "rich-content";
    }
    if (
      /^(?:@botiverse\/(?:raft-ui|oar|ricons|hands-feedback-react)|raft-ui|lucide-react|@dnd-kit\/|@tanstack\/react-virtual|emoji-picker-react)(?:\/|$)/.test(
        afterNm,
      )
    ) {
      return "ui";
    }
    if (
      /^(?:zustand|socket\.io-client|engine\.io-client|axios|zod|react-router|@botiverse\/(?:raft-sync-core|raft-shared|porthole))(?:[\w-]*)(?:\/|$)/.test(
        afterNm,
      )
    ) {
      return "state-network";
    }
    return "vendor";
  }

  if (/^https?:\/\//i.test(source) || /\.[cm]?js$/i.test(source)) {
    if (
      !lower.startsWith("packages/") &&
      !lower.startsWith("apps/") &&
      !lower.startsWith("src/")
    ) {
      return "bundle-unmapped";
    }
  }
  if (/^(?:packages|apps)\/[^/]+\/dist\//i.test(lower)) {
    return "bundle-unmapped";
  }
  return "app";
}

export class ParsedSourceMap {
  private readonly lines: Segment[][];
  private readonly sources: Array<string | null>;
  private readonly names: string[];

  constructor(raw: RawSourceMap, mapFilePath?: string) {
    if (raw.version !== 3) {
      throw new Error(`unsupported SourceMap version: ${String(raw.version)}`);
    }
    const mapDir = mapFilePath ? path.dirname(mapFilePath) : undefined;
    if (Array.isArray(raw.sections)) {
      const mergedSources: Array<string | null> = [];
      const mergedNames: string[] = [];
      const mergedLines: Segment[][] = [];
      for (const section of raw.sections) {
        let subMap: RawSourceMap | undefined = section.map;
        let subMapPath = mapFilePath;
        if (!subMap && typeof section.url === "string" && mapDir && !/^https?:\/\//i.test(section.url)) {
          const candidate = path.resolve(mapDir, section.url);
          if (existsSync(candidate)) {
            subMap = JSON.parse(readFileSync(candidate, "utf8")) as RawSourceMap;
            subMapPath = candidate;
          }
        }
        if (!subMap) {
          throw new Error(`indexed SourceMap section has no inline "map"${section.url ? ` (external url "${section.url}" could not be loaded)` : ""}`);
        }
        const sub = new ParsedSourceMap(subMap, subMapPath);
        const srcBase = mergedSources.length;
        const nameBase = mergedNames.length;
        mergedSources.push(...sub.sources);
        mergedNames.push(...sub.names);
        for (let lineIdx = 0; lineIdx < sub.lines.length; lineIdx++) {
          const targetLine = section.offset.line + lineIdx;
          const colOffset = lineIdx === 0 ? section.offset.column : 0;
          const row = (mergedLines[targetLine] ??= []);
          for (const seg of sub.lines[lineIdx]!) {
            row.push({
              genCol: seg.genCol + colOffset,
              srcIdx: seg.srcIdx >= 0 ? seg.srcIdx + srcBase : -1,
              origLine: seg.origLine,
              origCol: seg.origCol,
              nameIdx: seg.nameIdx >= 0 ? seg.nameIdx + nameBase : -1,
            });
          }
          row.sort((a, b) => a.genCol - b.genCol);
        }
      }
      this.sources = mergedSources;
      this.names = mergedNames;
      this.lines = mergedLines;
      return;
    }

    this.sources = (raw.sources ?? []).map((s) => (s == null ? null : cleanSourcePath(s, mapDir, raw.sourceRoot)));
    this.names = raw.names ?? [];
    this.lines = decodeMappings(raw.mappings ?? "");
  }

  /** Resolve a 0-based `(line, column)` pair (as emitted by CDP `Profiler.ProfileNode.callFrame`). */
  resolveZeroBased(line0: number, column0: number): ResolvedLocation | null {
    if (line0 < 0 || line0 >= this.lines.length) return null;
    const segments = this.lines[line0];
    if (!segments || segments.length === 0) return null;
    if (column0 < segments[0]!.genCol) return null;

    // Greatest segment with `genCol <= column0`
    let lo = 0;
    let hi = segments.length - 1;
    let match = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid]!.genCol <= column0) {
        match = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (match < 0) return null;
    const seg = segments[match]!;
    if (seg.srcIdx < 0) return null;
    const source = this.sources[seg.srcIdx];
    if (!source) return null;
    // V8 records a function's callFrame at its parameter `(` column rather than the identifier token immediately before it on the same declaration line.
    let nameIdx = seg.nameIdx;
    if (nameIdx < 0 && match > 0) {
      const prev = segments[match - 1]!;
      if (prev.srcIdx === seg.srcIdx && prev.origLine === seg.origLine && prev.nameIdx >= 0) {
        nameIdx = prev.nameIdx;
      }
    }
    const name = nameIdx >= 0 ? (this.names[nameIdx] ?? null) : null;
    return {
      source,
      line: seg.origLine + 1,
      column: seg.origCol + 1,
      name,
      bucket: classifySourceBucket(source, name ?? ""),
    };
  }

  /** Resolve a 1-based `(line, column)` pair (as emitted by Chrome trace `stackTrace` frames). */
  resolveOneBased(line1: number, column1: number): ResolvedLocation | null {
    return this.resolveZeroBased(Math.max(0, line1 - 1), Math.max(0, column1 - 1));
  }
}

function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let currentLine: Segment[] = [];
  lines.push(currentLine);

  let genCol = 0;
  let srcIdx = 0;
  let origLine = 0;
  let origCol = 0;
  let nameIdx = 0;

  let index = 0;
  while (index < mappings.length) {
    const ch = mappings.charCodeAt(index);
    if (ch === 59 /* ';' */) {
      currentLine.sort((a, b) => a.genCol - b.genCol);
      currentLine = [];
      lines.push(currentLine);
      genCol = 0;
      index++;
      continue;
    }
    if (ch === 44 /* ',' */) {
      index++;
      continue;
    }

    let delta: number;
    [delta, index] = decodeVlq(mappings, index);
    genCol += delta;

    if (index >= mappings.length || mappings.charCodeAt(index) === 44 || mappings.charCodeAt(index) === 59) {
      currentLine.push({ genCol, srcIdx: -1, origLine: 0, origCol: 0, nameIdx: -1 });
      continue;
    }

    [delta, index] = decodeVlq(mappings, index);
    srcIdx += delta;
    [delta, index] = decodeVlq(mappings, index);
    origLine += delta;
    [delta, index] = decodeVlq(mappings, index);
    origCol += delta;

    let segName = -1;
    if (index < mappings.length && mappings.charCodeAt(index) !== 44 && mappings.charCodeAt(index) !== 59) {
      [delta, index] = decodeVlq(mappings, index);
      nameIdx += delta;
      segName = nameIdx;
    }

    currentLine.push({ genCol, srcIdx, origLine, origCol, nameIdx: segName });
  }
  currentLine.sort((a, b) => a.genCol - b.genCol);
  return lines;
}

/** Extract the bare script basename (`index-AbCd1234.js`) from a URL or path. */
export function scriptBasename(urlOrPath: string): string {
  if (!urlOrPath) return "";
  const withoutQuery = urlOrPath.split("?")[0]!.split("#")[0]!;
  const slash = withoutQuery.lastIndexOf("/");
  return slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery;
}

/** Lazy directory-backed registry mapping deployed bundle URLs to local `.map` files. */
export class SourceMapRegistry {
  private readonly mapFilesByScript = new Map<string, string>();
  private readonly parsedCache = new Map<string, ParsedSourceMap | null>();

  constructor(mapFilesByScript?: ReadonlyMap<string, string>) {
    if (mapFilesByScript) {
      for (const [k, v] of mapFilesByScript) this.mapFilesByScript.set(k, v);
    }
  }

  static fromDirectory(dir: string): SourceMapRegistry {
    const root = path.resolve(dir);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`sourcemap directory not found: ${root}`);
    }
    const found = new Map<string, string>();
    const visit = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.isFile() && /\.[cm]?js\.map$/i.test(entry.name)) {
          const jsName = entry.name.slice(0, -4);
          if (!found.has(jsName)) found.set(jsName, full);
        }
      }
    };
    visit(root);
    return new SourceMapRegistry(found);
  }

  get mapCount(): number {
    return this.mapFilesByScript.size;
  }

  private loadForUrl(url: string): ParsedSourceMap | null {
    const base = scriptBasename(url);
    if (!base) return null;
    if (this.parsedCache.has(base)) return this.parsedCache.get(base)!;
    const mapPath = this.mapFilesByScript.get(base);
    if (!mapPath) {
      this.parsedCache.set(base, null);
      return null;
    }
    try {
      const raw = JSON.parse(readFileSync(mapPath, "utf8")) as RawSourceMap;
      const parsed = new ParsedSourceMap(raw, mapPath);
      this.parsedCache.set(base, parsed);
      return parsed;
    } catch {
      this.parsedCache.set(base, null);
      return null;
    }
  }

  resolveZeroBased(url: string, line0: number, column0: number): ResolvedLocation | null {
    const map = this.loadForUrl(url);
    return map ? map.resolveZeroBased(line0, column0) : null;
  }

  resolveOneBased(url: string, line1: number, column1: number): ResolvedLocation | null {
    const map = this.loadForUrl(url);
    return map ? map.resolveOneBased(line1, column1) : null;
  }
}
