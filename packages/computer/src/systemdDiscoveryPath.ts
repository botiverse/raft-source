import path from "node:path";

const VERSIONED_RUNTIME_BIN_PATTERNS = [
  [".nvm", "versions", "node", "*", "bin"],
  [".asdf", "installs", "nodejs", "*", "bin"],
  [".local", "share", "mise", "installs", "node", "*", "bin"],
  [".local", "share", "fnm", "node-versions", "*", "installation", "bin"],
] as const;

function isSafeLinuxPathEntry(value: string): boolean {
  return (
    path.posix.isAbsolute(value) &&
    !value.includes(":") &&
    !/[\r\n\0]/.test(value)
  );
}

function isAllowedVersionedRuntimeBin(
  value: string,
  userHome: string,
): boolean {
  if (!isSafeLinuxPathEntry(value)) return false;
  const relative = path.posix.relative(
    path.posix.resolve(userHome),
    path.posix.resolve(value),
  );
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    return false;
  }
  const parts = relative.split("/");
  return VERSIONED_RUNTIME_BIN_PATTERNS.some(
    (pattern) =>
      parts.length === pattern.length &&
      parts.every((part, index) =>
        pattern[index] === "*" ? part.length > 0 : part === pattern[index],
      ),
  );
}

/**
 * Stable Linux service executable roots plus selected version-manager bins.
 * The installer PATH is only an observation of the selected runtime version;
 * arbitrary entries and shell rc code never become part of the user service.
 */
export function buildSystemdDiscoveryPath(
  userHome: string,
  runtimeSearchPath: string | undefined,
): string {
  const resolvedHome = path.posix.resolve(userHome);
  const selectedRuntimeBins = (runtimeSearchPath ?? "")
    .split(":")
    .filter((entry) => entry.length > 0)
    .filter(isSafeLinuxPathEntry)
    .map((entry) => path.posix.resolve(entry))
    .filter((entry) => isAllowedVersionedRuntimeBin(entry, resolvedHome));
  return [
    ...selectedRuntimeBins,
    path.posix.join(resolvedHome, ".local", "bin"),
    path.posix.join(resolvedHome, ".volta", "bin"),
    path.posix.join(resolvedHome, ".asdf", "shims"),
    path.posix.join(resolvedHome, ".local", "share", "mise", "shims"),
    "/home/linuxbrew/.linuxbrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/local/sbin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter(isSafeLinuxPathEntry)
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(":");
}
