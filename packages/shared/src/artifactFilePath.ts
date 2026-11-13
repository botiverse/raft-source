// The one rule for an Artifact file path, shared by the Server (the file
// routes check a requested path before matching it; publish checks every
// path it is given) and clients (the CLI checks local paths before sending).
//
// The rules are Porthole's file path rules (`@botiverse/porthole` files/paths,
// which every published version is held to): no empty, `.` or `..` segment,
// and none of `\ % ? #` or a control or format character. Forbidding `%`
// is what makes encodings harmless: a router decodes a path once, and
// anything still percent-encoded after that (`%2e%2e`, `%252e`, a stray `%`
// beside them) is refused as it stands, so no deeper decoding can hide a
// segment. On the read side a path is only ever compared, exactly, with
// version_files.path; storage is reached through the matched row's blob,
// never through anything built from the path.

const FORBIDDEN = /[\p{Cc}\p{Cf}\\%?#]/u;

/**
 * Whether one path segment is a name git treats as its own: `.git` in any
 * case (case-insensitive file systems), also with trailing dots or spaces
 * (Windows drops them) and as its 8.3 short name `git~1`, the names git's own
 * verify_path refuses, and the same names before an NTFS stream suffix
 * (`.git::$INDEX_ALLOCATION` opens the `.git` folder on Windows). A file or
 * folder by that name in a directory someone pulls into is a repository config
 * (`core.fsmonitor`, hooks, a gitfile pointing elsewhere) that any later git
 * command there would run.
 */
export function isGitPathSegment(segment: string): boolean {
  const name = segment.toLowerCase().split(":")[0]!;
  return name.replace(/[. ]+$/u, "") === ".git" || name === "git~1";
}

/**
 * Whether `path` (decoded once by a router) may name a file: not empty; no
 * leading, trailing or doubled slash; no `.` or `..` segment; no `.git`
 * segment (isGitPathSegment); no backslash, `%`, `?`, `#`, control or format
 * character.
 */
export function isWellFormedArtifactFilePath(path: string): boolean {
  if (path.length === 0 || FORBIDDEN.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !isGitPathSegment(segment));
}
