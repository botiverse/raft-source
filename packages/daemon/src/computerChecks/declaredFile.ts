// Reads a declared file's declared keys out of its text. Only keys the check
// declared are looked at; every other line (tokens next to a login name, in
// gh's hosts.yml or .npmrc) is skipped without being kept. A file the reader
// does not understand is `parse_failed` with no detail: the error must not
// carry the file's content.
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { DeclaredFile, ReadKeysResult, ReadSection } from "./types";

/** Larger than any config file a check reads; a bigger one is not read. */
export const DECLARED_FILE_MAX_BYTES = 256 * 1024;
/**
 * Longer YAML lines are not looked at: no declared value is near this long,
 * and it keeps every regex below on short input.
 */
export const DECLARED_LINE_MAX_CHARS = 1024;

/**
 * Reads at most `maxBytes` from a regular file. O_NONBLOCK so a FIFO or
 * device planted at the path cannot block the open; anything that is not a
 * regular file is unreadable. A symlink to a regular file is followed. The
 * type and size are checked on the handle that is then read, so the path
 * cannot be swapped in between. Over `maxBytes` is `parse_failed`.
 */
export async function readRegularFile(filePath: string, maxBytes: number): Promise<{ text: string } | { unavailable: "missing" | "unreadable" | "parse_failed" }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { unavailable: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { unavailable: "unreadable" };
    if (stat.size > maxBytes) return { unavailable: "parse_failed" };
    // The file may grow after fstat: read one byte past the cap to notice.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { unavailable: "parse_failed" };
    return { text: buffer.subarray(0, length).toString("utf8") };
  } catch {
    return { unavailable: "unreadable" };
  } finally {
    await handle.close().catch(() => {});
  }
}

class ParseFailed extends Error {
  constructor() {
    super("parse_failed");
  }
}

/** `key: null` marks where a section starts, so a section with no declared key still counts. */
type RawEntry = { section: string; key: string | null; value: string };

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  return v;
}

function* lineEntries(text: string): Generator<RawEntry> {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (line !== undefined) yield { section: "", key: "value", value: line };
}

// INI as npm, the AWS CLI and gcloud write it. Indented lines without `=` are
// continuation lines (aws `s3 =` blocks) and are skipped.
function* iniEntries(text: string): Generator<RawEntry> {
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith(";")) continue;
    if (t.startsWith("[")) {
      if (!t.endsWith("]")) throw new ParseFailed();
      section = t.slice(1, -1).trim();
      yield { section, key: null, value: "" };
      continue;
    }
    const eq = t.indexOf("=");
    if (eq > 0) {
      yield { section, key: t.slice(0, eq).trim(), value: unquote(t.slice(eq + 1)) };
      continue;
    }
    if (/^\s/.test(line)) continue;
    throw new ParseFailed();
  }
}

/** Drops a ` # comment` (whitespace then `#`) without a backtracking regex. */
function stripYamlComment(value: string): string {
  for (let i = value.indexOf("#"); i !== -1; i = value.indexOf("#", i + 1)) {
    if (i > 0 && /\s/.test(value[i - 1]!)) return value.slice(0, i);
  }
  return value;
}

// The two-level YAML gh writes (`host:` then indented `key: value`). Deeper
// levels (gh's `users:` map) are skipped. Anything else is not understood.
// An over-long indented line is skipped (no value from it); an over-long
// top-level line is not understood, since it may start a section.
function* yamlEntries(text: string): Generator<RawEntry> {
  let section: string | null = null;
  let childIndent = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.length > DECLARED_LINE_MAX_CHARS) {
      if (/^\S/.test(line)) throw new ParseFailed();
      continue;
    }
    if (/^ *\t/.test(line)) throw new ParseFailed();
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const top = /^([^\s:#'"][^:]*):\s*$/.exec(line);
      if (!top) throw new ParseFailed();
      section = top[1]!.trim();
      childIndent = 0;
      yield { section, key: null, value: "" };
      continue;
    }
    if (section === null) throw new ParseFailed();
    if (childIndent === 0) childIndent = indent;
    if (indent > childIndent) continue;
    if (indent < childIndent) throw new ParseFailed();
    const kv = /^\s+([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (!kv) throw new ParseFailed();
    yield { section, key: kv[1]!, value: unquote(stripYamlComment(kv[2] ?? "")) };
  }
}

const ENTRIES: Record<DeclaredFile["format"], (text: string) => Iterable<RawEntry>> = {
  line: lineEntries,
  ini: iniEntries,
  yaml: yamlEntries,
};

export function readDeclaredKeys(file: DeclaredFile, text: string): ReadKeysResult {
  const sections = new Map<string, ReadSection>();
  try {
    for (const entry of ENTRIES[file.format](text)) {
      const name = entry.section === "" ? "" : file.sectionShape?.(entry.section);
      if (name === undefined) continue;
      let section = sections.get(name);
      if (!section) {
        section = { name, values: {} };
        sections.set(name, section);
      }
      const key = entry.key;
      if (key === null) continue;
      const declared = file.keys.find((k) => ((k.match ?? "exact") === "exact" ? key === k.key : key.endsWith(k.key)));
      const value = declared?.shape(entry.value);
      if (declared && value !== undefined) section.values[declared.key] = value;
    }
  } catch {
    // Deliberately drops the error: it may quote the file.
    return { unavailable: "parse_failed" };
  }
  return { sections: [...sections.values()] };
}
