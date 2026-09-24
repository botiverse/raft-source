import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CAPABILITY_IDS } from "@raft/desktop-contract/capabilities";
import {
  type DesktopManifest,
  validateManifestSchema,
} from "@raft/desktop-contract/manifest";
import type { FrontendReleaseIdentity } from "../src/buildIdentity";

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

export const MAX_DESKTOP_MANIFEST_BYTES = 65_536;
export const DESKTOP_APP_SEMVER = ">=0.1.0, <0.2.0";
export const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_MANIFEST_ETAG_PLACEHOLDER =
  "__RAFT_DESKTOP_MANIFEST_ETAG__";

export type DesktopManifestReleaseIdentity = Readonly<{
  releaseId: string;
  commitSha: string;
}>;

/**
 * Adapter boundary for the canonical monorepo desktop contract.
 *
 * This module deliberately does not know manifestVersion, compatibility ranges,
 * capability IDs, or handshake bytes. The future packages/desktop-contract adapter
 * must render and validate those canonical bytes before this plugin will emit them.
 */
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
 * Canonical Web producer adapter for the shared Phase 1A contract.
 *
 * Preview artifacts remain compatibility-only and never advertise a
 * production update. All schema, capability, and IPC names come from
 * @raft/desktop-contract rather than a Web-local copy.
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
          requiredCapabilities: [...CAPABILITY_IDS],
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
