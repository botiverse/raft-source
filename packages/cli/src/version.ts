import { readFileSync } from "node:fs";

declare const __RAFT_CLI_VERSION__: string | undefined;

const UNKNOWN_VERSION = "unknown";
const VERSION_VALUE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > 128 || !VERSION_VALUE.test(trimmed)) return null;
  if (/^0\.0\.0(?:$|-)/.test(trimmed) || trimmed === UNKNOWN_VERSION) return null;
  return trimmed;
}

function readVersionFrom(candidate: URL): string | null {
  try {
    const pkg = JSON.parse(readFileSync(candidate, "utf8"));
    return normalizeVersion(pkg.version);
  } catch {
    return null;
  }
}

function readBakedCliVersion(): string | undefined {
  return typeof __RAFT_CLI_VERSION__ === "string" ? __RAFT_CLI_VERSION__ : undefined;
}

export function readCliVersion(
  baseUrl: string = import.meta.url,
  bakedVersion: unknown = readBakedCliVersion(),
): string {
  return (
    // Computer SEA builds replace the otherwise-absent identifier with the CLI
    // package version. Runtime environment variables are intentionally not a
    // version source: inherited values must not override the invoked carrier.
    normalizeVersion(bakedVersion)
    ??
    // Built package and daemon-bundled CLI: dist/package.json travels with dist/index.js.
    readVersionFrom(new URL("./package.json", baseUrl))
    // Source-run CLI: package.json is one level above src/.
    ?? readVersionFrom(new URL("../package.json", baseUrl))
    // Never invent a semantic version: "unknown" is an explicit missing-data
    // state and is safer in bug reports than the old misleading 0.0.0.
    ?? UNKNOWN_VERSION
  );
}
