import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDesktopManifestContractAdapter,
  createFrontendReleaseIdentityDefines,
  createFrontendReleaseIdentityPlugin,
  injectFrontendReleaseIdentity,
  MAX_DESKTOP_MANIFEST_BYTES,
  resolveFrontendReleaseIdentity,
  renderDesktopManifestArtifact,
} from "../scripts/frontendReleaseIdentity";
import type {
  DesktopManifestContractAdapter,
} from "../scripts/frontendReleaseIdentity";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const identity = Object.freeze({
  releaseId: "release-abc123",
  commitSha,
  builtAt: "2026-07-22T00:00:00Z",
  branch: "feature/desktop-manifest",
  deploymentEnvironment: "staging",
});

describe("frontend release identity build seam", () => {
  test("resolves one immutable identity from build-time inputs", () => {
    const resolved = resolveFrontendReleaseIdentity({
      VITE_FRONTEND_RELEASE_ID: " release-abc123 ",
      VITE_COMMIT_SHA: ` ${commitSha} `,
      VITE_BUILD_AT: " 2026-07-22T00:00:00Z ",
      VITE_RELEASE_BRANCH: " feature/desktop-manifest ",
      VITE_PREVIEW_BRANCH: "ignored-preview-branch",
      VITE_DEPLOYMENT_ENV: " staging ",
    });

    assert.deepEqual(resolved, identity);
    assert.equal(Object.isFrozen(resolved), true);
  });

  test("uses the exact commit as the release id when older trusted builders omit the explicit id", () => {
    const resolved = resolveFrontendReleaseIdentity({
      VITE_COMMIT_SHA: ` ${commitSha} `,
      VITE_BUILD_AT: " 2026-07-22T00:00:00Z ",
      VITE_RELEASE_BRANCH: " feature/desktop-manifest ",
    });

    assert.deepEqual(resolved, {
      releaseId: commitSha,
      commitSha,
      builtAt: "2026-07-22T00:00:00Z",
      branch: "feature/desktop-manifest",
      deploymentEnvironment: null,
    });
  });

  test("embeds the exact same identity in the pre-main HTML data block", () => {
    const html = injectFrontendReleaseIdentity(
      '<html><head><title>Raft</title></head><body><script type="module" src="/src/main.tsx"></script></body></html>',
      identity,
    );

    const match = html.match(
      /<script id="raft-frontend-release-identity" type="application\/json">([^<]+)<\/script>/,
    );
    assert.ok(match, "identity data block should be injected before app bootstrap");
    assert.deepEqual(JSON.parse(match[1]), identity);
    assert.deepEqual(
      JSON.parse(
        createFrontendReleaseIdentityDefines(identity)
          .__RAFT_FRONTEND_RELEASE_IDENTITY__,
      ),
      JSON.parse(match[1]),
      "bundle define and HTML bootstrap must be semantic twins",
    );
    assert.ok(
      html.indexOf("raft-frontend-release-identity") < html.indexOf("/src/main.tsx"),
      "identity must be present before the main module runs",
    );
  });

  test("escapes script-breaking input without changing parsed identity bytes", () => {
    const hostile = Object.freeze({
      ...identity,
      branch: "</script><script>throw new Error('executed')</script>",
    });
    const html = injectFrontendReleaseIdentity("<html><head></head><body></body></html>", hostile);

    assert.doesNotMatch(html, /<script>throw new Error/);
    assert.match(html, /\\u003c\/script>/);
  });

  test("manifest emission requires a validating contract adapter and exact identity projection", () => {
    let validations = 0;
    const adapter: DesktopManifestContractAdapter = {
      render(sourceIdentity) {
        return `${JSON.stringify({
          manifestVersion: 1,
          frontendReleaseId: sourceIdentity.releaseId,
          commitSha: sourceIdentity.commitSha,
        })}\n`;
      },
      assertValid(bytes) {
        validations += 1;
        const value = JSON.parse(bytes) as { manifestVersion?: number };
        assert.equal(value.manifestVersion, 1);
      },
      readReleaseIdentity(bytes) {
        const value = JSON.parse(bytes) as {
          frontendReleaseId: string;
          commitSha: string;
        };
        return {
          releaseId: value.frontendReleaseId,
          commitSha: value.commitSha,
        };
      },
    };

    const bytes = renderDesktopManifestArtifact(identity, adapter);
    assert.equal(validations, 1);
    assert.deepEqual(JSON.parse(bytes), {
      manifestVersion: 1,
      frontendReleaseId: identity.releaseId,
      commitSha: identity.commitSha,
    });

    const plugin = createFrontendReleaseIdentityPlugin(identity, adapter);
    let emitted:
      | { type: string; fileName?: string; source?: string | Uint8Array }
      | undefined;
    assert.equal(typeof plugin.generateBundle, "function");
    (plugin.generateBundle as Function).call(
      {
        emitFile(file: typeof emitted) {
          emitted = file;
          return "desktop-manifest-asset";
        },
      },
      {},
      {},
      false,
    );
    assert.equal(emitted?.type, "asset");
    assert.equal(emitted?.fileName, "desktop-manifest.json");
    assert.equal(emitted?.source, bytes);
  });

  test("canonical adapter emits exact shared capabilities and makes preview updates advisory-only", () => {
    const previewAdapter = createDesktopManifestContractAdapter({
      VITE_DEPLOYMENT_ENV: "web-preview",
    });
    const bytes = renderDesktopManifestArtifact(identity, previewAdapter);
    const manifest = JSON.parse(bytes);

    assert.deepEqual(manifest, {
      manifestVersion: 1,
      frontendReleaseId: identity.releaseId,
      frontendCommitSha: identity.commitSha,
      compatibility: {
        appSemver: ">=0.1.0, <0.2.0",
        protocolMin: 1,
        protocolMax: 1,
        requiredCapabilities: ["desktop.handshake", "window.focus", "window.bindServer"],
      },
      updateRecommendation: "none",
    });
    assert.ok(Buffer.byteLength(bytes) <= MAX_DESKTOP_MANIFEST_BYTES);

    const officialBytes = renderDesktopManifestArtifact(
      identity,
      createDesktopManifestContractAdapter({}),
    );
    assert.equal(JSON.parse(officialBytes).updateRecommendation, "current");
  });

  test("canonical adapter rejects schema drift and manifest bytes beyond the native bound", () => {
    const canonical = createDesktopManifestContractAdapter({});
    const unknownField = {
      ...canonical,
      render: () =>
        `${JSON.stringify({
          manifestVersion: 1,
          frontendReleaseId: identity.releaseId,
          frontendCommitSha: identity.commitSha,
          compatibility: {
            appSemver: ">=0.1.0, <0.2.0",
            protocolMin: 1,
            protocolMax: 1,
            requiredCapabilities: ["desktop.handshake", "window.focus"],
          },
          updateRecommendation: "current",
          unknown: true,
        })}\n`,
    };
    assert.throws(
      () => renderDesktopManifestArtifact(identity, unknownField),
      /manifest fields are not closed/,
    );

    const oversized = {
      ...canonical,
      render: () =>
        JSON.stringify({ padding: "x".repeat(MAX_DESKTOP_MANIFEST_BYTES) }),
    };
    assert.throws(
      () => renderDesktopManifestArtifact(identity, oversized),
      /exceeds 65536 bytes/,
    );
  });

  test("fails closed when adapter bytes do not project the embedded identity", () => {
    const mismatched: DesktopManifestContractAdapter = {
      render: () =>
        `{"frontendReleaseId":"other","commitSha":"${commitSha}"}\n`,
      assertValid: () => {},
      readReleaseIdentity: () => ({ releaseId: "other", commitSha }),
    };

    assert.throws(
      () => renderDesktopManifestArtifact(identity, mismatched),
      /desktop manifest release identity does not match frontend artifact/,
    );
  });

  test("does not emit a permissive manifest when the contract adapter is absent", () => {
    const plugin = createFrontendReleaseIdentityPlugin(identity);
    assert.equal(plugin.name, "raft-frontend-release-identity");
    assert.equal("generateBundle" in plugin, false);
  });

  test("does not emit a plausible manifest when build identity is incomplete", () => {
    const plugin = createFrontendReleaseIdentityPlugin(
      {
        releaseId: null,
        commitSha: null,
        builtAt: null,
        branch: null,
        deploymentEnvironment: null,
      },
      createDesktopManifestContractAdapter({}),
    );
    assert.equal("generateBundle" in plugin, false);
  });
});
