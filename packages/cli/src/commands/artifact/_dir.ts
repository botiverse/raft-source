// The local side of `raft artifact pull` / `push`: a directory holding one
// Artifact's files and `.raft-artifact.json`, which records the version the
// files came from (the base of the next push) and each file's sha256 at that
// version, so push sends only what changed. Nothing else is kept locally:
// what the agent has seen is the Server's to remember.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { artifactLinkId, asArtifactId, isWellFormedArtifactFilePath } from "@botiverse/raft-shared/src/agentCliSurface";

import { CliError } from "../../core/errors";

export const ARTIFACT_STATE_FILE = ".raft-artifact.json";

/**
 * Whether an Artifact file at `path` would land on this directory's
 * `.raft-artifact.json`: the same name at the top whatever its case (macOS
 * and Windows file systems ignore it), with trailing dots or spaces (Windows
 * drops them) or an NTFS stream suffix, as isGitPathSegment reads `.git`.
 * Such a file is never written, so an author can't plant a base.
 */
export function isArtifactStateFilePath(path: string): boolean {
  if (path.includes("/")) return false;
  const name = path.toLowerCase().split(":")[0]!;
  return name.replace(/[. ]+$/u, "") === ARTIFACT_STATE_FILE;
}

export interface ArtifactDirState {
  artifact: string;
  title: string;
  /** The version the files came from: the next push's base. */
  version: number;
  /** path → sha256 of that file in `version`. */
  files: Record<string, string>;
}

/** Tool folders and droppings: never pushed unless the artifact already has them. */
const TOOL_NAMES = new Set([".git", ".DS_Store", "node_modules"]);

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readDirState(dir: string): ArtifactDirState | null {
  const path = join(dir, ARTIFACT_STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ArtifactDirState;
    if (typeof parsed.artifact === "string" && typeof parsed.version === "number" && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    // fall through
  }
  throw new CliError({
    code: "ARTIFACT_DIR_CONFLICT",
    message: `${path} is not a valid artifact state file`,
    suggestedNextAction: "Pull the artifact again into a new directory: raft artifact pull <artifact> --dir <new dir>",
  });
}

export function writeDirState(dir: string, state: ArtifactDirState): void {
  writeFileSync(join(dir, ARTIFACT_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** The longest folder name `pull` makes from a title, in characters. */
export const PULL_DIR_NAME_MAX = 60;

/** Names Windows keeps for devices, whatever the extension: never a folder of their own. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/**
 * `raft artifact pull`'s folder when no `--dir` is given: the artifact's
 * title as one folder name (letters of any script kept, CJK too; path
 * separators, control and format characters, those Windows refuses in a
 * name, `$` and `` ` `` (next steps quote the folder in double quotes), and
 * spaces (an unquoted command an agent writes would split the name, Sage)
 * become `-`, one `-` for each run; dots and hyphens trimmed at the ends; at most
 * PULL_DIR_NAME_MAX characters), else its short id (the one its link shows).
 */
export function pullDirName(artifact: { id: string; title: string }): string {
  const cleaned = artifact.title.normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\\/:*?"<>|$`\s]+/gu, "-")
    .replace(/-{2,}/gu, "-");
  const name = [...cleaned].slice(0, PULL_DIR_NAME_MAX).join("").replace(/^[\s.-]+|[\s.-]+$/gu, "");
  return name === "" || WINDOWS_DEVICE.test(name) ? artifactLinkId(asArtifactId(artifact.id)) : name;
}

export interface DirScan {
  /** artifact path (forward slashes) → sha256 and size of the local bytes. */
  files: Map<string, { sha256: string; size: number }>;
  /** Hidden files and tool folders left out because the artifact doesn't have them (top-most path each). */
  skipped: string[];
  /** Symbolic links: never followed, never pushed. */
  links: string[];
}

/**
 * Every file under `dir` as an artifact path, with its bytes' sha256. Hidden
 * files (`.env`, `.vscode/`) and tool folders (`.git`, `node_modules`) are
 * left out and reported, unless the artifact already has them (`recorded`) or
 * `includeHidden` asks for hidden ones: an agent's scratch files must not ride
 * along into an artifact others can see. The state file is never a file.
 */
export function scanDir(dir: string, recorded: Iterable<string> = [], includeHidden = false): DirScan {
  const known = new Set(recorded);
  const knownUnder = (prefix: string) => [...known].some((p) => p === prefix || p.startsWith(`${prefix}/`));
  const files = new Map<string, { sha256: string; size: number }>();
  const skipped: string[] = [];
  const links: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (isArtifactStateFilePath(rel)) continue;
      const hidden = TOOL_NAMES.has(entry.name) || (entry.name.startsWith(".") && !includeHidden);
      if (hidden && !knownUnder(rel)) {
        skipped.push(rel);
        continue;
      }
      if (entry.isSymbolicLink()) links.push(rel);
      else if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        files.set(rel, { sha256: sha256Of(bytes), size: bytes.byteLength });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files, skipped: skipped.sort(), links: links.sort() };
}

/** Local changes against the recorded base: changed or new files, and base files missing locally. */
export function localChanges(dir: string, state: ArtifactDirState): { changed: string[]; missing: string[] } {
  const local = scanDir(dir, Object.keys(state.files)).files;
  const changed = [...local].filter(([path, f]) => state.files[path] !== f.sha256).map(([path]) => path).sort();
  const missing = Object.keys(state.files).filter((path) => !local.has(path)).sort();
  return { changed, missing };
}

/** The deepest part of `path` that exists, with symbolic links resolved. */
function realExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return realpathSync(current);
}

/**
 * Where an artifact path lands under `dir`; refuses anything that would leave
 * it, by its words (`..`) or through a symbolic link already in the directory
 * (`assets -> /elsewhere`): the folders it would go through must resolve to
 * inside the directory.
 */
export function fileTarget(dir: string, path: string): string {
  // The shared path rule first: no `..`, no `.git` part (a pulled `.git/config`
  // would run its commands on the next git command in this directory).
  if (!isWellFormedArtifactFilePath(path)) throw unsafeArtifactPath(path, dir);
  const root = resolve(dir);
  const target = resolve(root, ...path.split("/"));
  const outside = () => new CliError({
    code: "INVALID_PATH",
    message: `"${path}" would be written outside ${dir}`,
    suggestedNextAction: `Remove the symbolic link in ${dir} that leads out of it, or pull into a new directory.`,
  });
  if (target === root || !target.startsWith(root + sep)) throw outside();
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    const realParent = realExisting(dirname(target));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) throw outside();
  }
  return target;
}

/** A path the CLI never reads or writes under a directory (the shared rule refuses it). */
export function unsafeArtifactPath(path: string, dir: string): CliError {
  return new CliError({
    code: "INVALID_PATH",
    message: `"${path}" can't be written under ${dir}: an artifact file path may have no "..", empty or ".git" part (git would run the config it holds).`,
    suggestedNextAction: "Nothing was written. Ask its author to push it without that file; to read the other files, download them one by one with raft artifact download.",
  });
}

export function writeFileUnder(dir: string, path: string, bytes: Uint8Array): void {
  mkdirSync(dir, { recursive: true });
  const target = fileTarget(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

export function isEmptyDir(dir: string): boolean {
  return !existsSync(dir) || (statSync(dir).isDirectory() && readdirSync(dir).length === 0);
}
