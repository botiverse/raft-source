export type AgentMigrationUnsafeWorkspacePathCode =
  | "MIGRATION_OBJECT_STORE_UNSAFE_PATH"
  | "MIGRATION_MANIFEST_UNSAFE_PATH";

export function normalizeAgentMigrationWorkspaceRelativePath(
  relativePath: unknown,
  unsafePathCode: AgentMigrationUnsafeWorkspacePathCode,
): string {
  const unsafe = (): never => {
    throw new Error(unsafePathCode);
  };

  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.includes("\0")
  ) {
    return unsafe();
  }

  const portablePath = relativePath.replaceAll("\\", "/");
  if (portablePath.startsWith("/")) return unsafe();

  const segments = portablePath.split("/");
  if (segments.includes("..")) return unsafe();

  const canonicalSegments = segments.filter((segment) => segment !== "" && segment !== ".");
  if (
    canonicalSegments.length === 0
    || /^[A-Za-z]:/.test(canonicalSegments[0] ?? "")
  ) {
    return unsafe();
  }

  return canonicalSegments.join("/");
}
