import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FrontendReleaseIdentity } from "../src/buildIdentity";

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

export const MAX_DESKTOP_MANIFEST_BYTES = 65_536;
export const DESKTOP_APP_SEMVER = ">=0.1.0, <0.2.0";
export const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_MANIFEST_ETAG_PLACEHOLDER =
  "__RAFT_DESKTOP_MANIFEST_ETAG__";

// The deployed /desktop-manifest.json shape. Its bytes are frozen: the preview
// deploy verifies them (deploy-web-preview.yml) and the Cloudflare worker and
// nginx serve them with a content ETag. The capability list is the historical
// one; nothing in the Electron desktop reads this file.
const DESKTOP_MANIFEST_CAPABILITIES = ["desktop.handshake", "window.focus", "window.bindServer"] as const;

type DesktopManifest = {
  manifestVersion: 1;
  frontendReleaseId: string;
  frontendCommitSha: string;
  compatibility: {
    appSemver: string;
    protocolMin: number;
    protocolMax: number;
    requiredCapabilities: string[];
  };
  updateRecommendation: "current" | "recommended" | "none";
};

function hasExactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validateManifestSchema(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "manifest must be an object";
  const manifest = value as Record<string, unknown>;
  if (!hasExactFields(manifest, ["manifestVersion", "frontendReleaseId", "frontendCommitSha", "compatibility", "updateRecommendation"])) {
    return "manifest fields are not closed";
  }
  if (manifest.manifestVersion !== 1) return "manifestVersion must be exactly 1";
  if (typeof manifest.frontendReleaseId !== "string" || manifest.frontendReleaseId.length === 0) {
    return "frontendReleaseId must be a non-empty string";
  }
  if (typeof manifest.frontendCommitSha !== "string" || !/^[0-9a-f]{40}$/.test(manifest.frontendCommitSha)) {
    return "frontendCommitSha must be a full lowercase 40-character SHA";
  }
  const compat = manifest.compatibility;
  if (typeof compat !== "object" || compat === null) return "compatibility must be an object";
  if (!hasExactFields(compat as Record<string, unknown>, ["appSemver", "protocolMin", "protocolMax", "requiredCapabilities"])) {
    return "compatibility fields are not closed";
  }
  const rec = manifest.updateRecommendation;
  if (rec !== "current" && rec !== "recommended" && rec !== "none") {
    return "updateRecommendation must be 'current' | 'recommended' | 'none'";
  }
  return null;
}

export type DesktopManifestReleaseIdentity = Readonly<{
  releaseId: string;
  commitSha: string;
}>;

/** Renders and validates the desktop-manifest.json bytes the plugin emits. */
export interface DesktopManifestContractAdapter {
  render(identity: FrontendReleaseIdentity): string;
  assertValid(bytes: string): void;
  readReleaseIdentity(bytes: string): DesktopManifestReleaseIdentity;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveFrontendReleaseIdentity(
  environment: BuildEnvironment,
): FrontendReleaseIdentity {
  const commitSha = clean(environment.VITE_COMMIT_SHA);
  return Object.freeze({
    releaseId: clean(environment.VITE_FRONTEND_RELEASE_ID) ?? commitSha,
    commitSha,
    builtAt: clean(environment.VITE_BUILD_AT),
    branch:
      clean(environment.VITE_RELEASE_BRANCH) ??
      clean(environment.VITE_PREVIEW_BRANCH),
    deploymentEnvironment: clean(environment.VITE_DEPLOYMENT_ENV),
  });
}

function serializeForHtml(identity: FrontendReleaseIdentity): string {
  return JSON.stringify(identity)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function isPreviewBuild(environment: BuildEnvironment): boolean {
  const deploymentEnvironment = clean(environment.VITE_DEPLOYMENT_ENV);
  return (
    deploymentEnvironment === "web-preview" ||
    deploymentEnvironment === "preview" ||
    clean(environment.VITE_PREVIEW_BRANCH) !== null
  );
}

function parseDesktopManifest(bytes: string): DesktopManifest {
  const byteLength = new TextEncoder().encode(bytes).byteLength;
  if (byteLength > MAX_DESKTOP_MANIFEST_BYTES) {
    throw new Error(
      `desktop manifest exceeds ${MAX_DESKTOP_MANIFEST_BYTES} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("desktop manifest contract rendered invalid JSON");
  }
  const validationError = validateManifestSchema(parsed);
  if (validationError !== null) {
    throw new Error(`desktop manifest contract invalid: ${validationError}`);
  }
  return parsed as DesktopManifest;
}

/**
 * The Web producer of desktop-manifest.json. Preview artifacts never advertise
 * a production update.
 */
export function createDesktopManifestContractAdapter(
  environment: BuildEnvironment,
): DesktopManifestContractAdapter {
  const updateRecommendation: DesktopManifest["updateRecommendation"] =
    isPreviewBuild(environment) ? "none" : "current";

  return {
    render(identity) {
      const manifest: DesktopManifest = {
        manifestVersion: 1,
        frontendReleaseId: identity.releaseId ?? "",
        frontendCommitSha: identity.commitSha ?? "",
        compatibility: {
          appSemver: DESKTOP_APP_SEMVER,
          protocolMin: DESKTOP_PROTOCOL_VERSION,
          protocolMax: DESKTOP_PROTOCOL_VERSION,
          requiredCapabilities: [...DESKTOP_MANIFEST_CAPABILITIES],
        },
        updateRecommendation,
      };
      return `${JSON.stringify(manifest)}\n`;
    },
    assertValid(bytes) {
      parseDesktopManifest(bytes);
    },
    readReleaseIdentity(bytes) {
      const manifest = parseDesktopManifest(bytes);
      return {
        releaseId: manifest.frontendReleaseId,
        commitSha: manifest.frontendCommitSha,
      };
    },
  };
}

export function injectFrontendReleaseIdentity(
  html: string,
  identity: FrontendReleaseIdentity,
): string {
  const dataBlock =
    `<script id="raft-frontend-release-identity" type="application/json">` +
    `${serializeForHtml(identity)}</script>`;
  const headEnd = html.indexOf("</head>");
  if (headEnd === -1) {
    throw new Error("frontend release identity requires an HTML <head>");
  }
  const moduleScript = html.search(/<script\s+[^>]*type=["']module["']/i);
  const insertionPoint =
    moduleScript !== -1 && moduleScript < headEnd ? moduleScript : headEnd;
  return `${html.slice(0, insertionPoint)}    ${dataBlock}\n    ${html.slice(insertionPoint)}`;
}

export function createFrontendReleaseIdentityDefines(
  identity: FrontendReleaseIdentity,
): Record<string, string> {
  return {
    __RAFT_FRONTEND_RELEASE_IDENTITY__: JSON.stringify(identity),
  };
}

export function renderDesktopManifestArtifact(
  identity: FrontendReleaseIdentity,
  adapter: DesktopManifestContractAdapter,
): string {
  if (identity.releaseId === null || identity.commitSha === null) {
    throw new Error(
      "desktop manifest emission requires frontend releaseId and commitSha",
    );
  }

  const bytes = adapter.render(identity);
  if (!bytes.trim()) {
    throw new Error("desktop manifest contract rendered empty bytes");
  }
  adapter.assertValid(bytes);
  const projected = adapter.readReleaseIdentity(bytes);
  if (
    projected.releaseId !== identity.releaseId ||
    projected.commitSha !== identity.commitSha
  ) {
    throw new Error(
      "desktop manifest release identity does not match frontend artifact",
    );
  }
  return bytes;
}

export function createFrontendReleaseIdentityPlugin(
  identity: FrontendReleaseIdentity,
  desktopContract?: DesktopManifestContractAdapter,
): Plugin {
  let emittedManifestBytes: string | null = null;
  const plugin: Plugin = {
    name: "raft-frontend-release-identity",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return injectFrontendReleaseIdentity(html, identity);
      },
    },
  };

  if (
    desktopContract !== undefined &&
    identity.releaseId !== null &&
    identity.commitSha !== null
  ) {
    plugin.generateBundle = function generateBundle() {
      emittedManifestBytes = renderDesktopManifestArtifact(
        identity,
        desktopContract,
      );
      this.emitFile({
        type: "asset",
        fileName: "desktop-manifest.json",
        source: emittedManifestBytes,
      });
    };
    plugin.writeBundle = async function writeBundle(outputOptions) {
      if (emittedManifestBytes === null || outputOptions.dir === undefined) {
        throw new Error("desktop manifest output directory is unavailable");
      }
      const etag =
        `"sha256-${createHash("sha256").update(emittedManifestBytes).digest("hex")}"`;
      const headersPath = resolve(outputOptions.dir, "_headers");
      const headers = await readFile(headersPath, "utf8");
      if (!headers.includes(DESKTOP_MANIFEST_ETAG_PLACEHOLDER)) {
        throw new Error("desktop manifest ETag placeholder is missing");
      }
      await writeFile(
        headersPath,
        headers.replaceAll(DESKTOP_MANIFEST_ETAG_PLACEHOLDER, etag),
      );
    };
  }

  return plugin;
}
