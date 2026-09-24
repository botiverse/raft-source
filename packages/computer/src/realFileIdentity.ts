export type ResolveRealPath = (filePath: string) => string;

export type RealFileIdentity = "same" | "different" | "unknown";

/**
 * Compare two existing path spellings by their canonical on-disk identity.
 * `unknown` is deliberately distinct from `different`: callers use it to
 * fail closed instead of swallowing an argument or handing off to a slot
 * whose relationship to the running executable could not be proven.
 */
export function compareRealFiles(
  left: string,
  right: string,
  resolveRealPath: ResolveRealPath,
  caseInsensitive = false,
): RealFileIdentity {
  try {
    const normalize = (value: string): string => caseInsensitive
      ? value.toLocaleLowerCase("en-US")
      : value;
    return normalize(resolveRealPath(left)) === normalize(resolveRealPath(right))
      ? "same"
      : "different";
  } catch {
    return "unknown";
  }
}
