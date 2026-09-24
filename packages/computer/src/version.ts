import { createRequire } from "node:module";

declare const __RAFT_COMPUTER_VERSION__: string | undefined;
declare const __RAFT_DAEMON_VERSION__: string | undefined;
declare const __RAFT_CLI_VERSION__: string | undefined;

function readBakedComputerVersion(): string | undefined {
  return typeof __RAFT_COMPUTER_VERSION__ === "string" ? __RAFT_COMPUTER_VERSION__ : undefined;
}

function readBakedDaemonVersion(): string | undefined {
  return typeof __RAFT_DAEMON_VERSION__ === "string" ? __RAFT_DAEMON_VERSION__ : undefined;
}

function readBakedCliVersion(): string | undefined {
  return typeof __RAFT_CLI_VERSION__ === "string" ? __RAFT_CLI_VERSION__ : undefined;
}

export function readComputerVersion(
  moduleUrl: string = import.meta.url,
  bakedVersion: unknown = readBakedComputerVersion(),
): string {
  // Single-executable builds replace an otherwise-absent identifier with the
  // package version. Runtime environment variables are not trusted as build
  // identity and cannot override a non-SEA package read.
  const baked = bakedVersion;
  if (typeof baked === "string" && baked.length > 0) return baked;
  const require = createRequire(moduleUrl);
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(candidate) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      // Try the next supported bundle depth.
    }
  }
  return "0.0.0-dev";
}

export const COMPUTER_VERSION = readComputerVersion();

export function readBundledDaemonVersion(
  bakedVersion: unknown = readBakedDaemonVersion(),
): string | undefined {
  // Native Computer SEA builds replace an otherwise-absent identifier with the
  // daemon package version. Keeping the value in Computer-owned code lets the
  // resident runner pass it explicitly even if daemon core stays a dynamic
  // package import instead of being rewritten by the Computer bundle pass.
  const baked = bakedVersion;
  return typeof baked === "string" && baked.length > 0 ? baked : undefined;
}

export const BUNDLED_DAEMON_VERSION = readBundledDaemonVersion();

export function readBundledCliVersion(
  bakedVersion: unknown = readBakedCliVersion(),
): string | undefined {
  const baked = bakedVersion;
  return typeof baked === "string" && baked.length > 0 ? baked : undefined;
}

export const BUNDLED_CLI_VERSION = readBundledCliVersion();
