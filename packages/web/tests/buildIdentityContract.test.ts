import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));

function read(path: string): string {
  return readFileSync(resolve(repoRoot, "packages/web", path), "utf8");
}

test("web bundle exposes build identity through browser-readable globals and DOM dataset", () => {
  const source = read("src/buildIdentity.ts");
  assert.match(source, /__RAFT_BUILD_IDENTITY__/);
  assert.match(source, /dataset\.raftBuildSha/);
  assert.match(source, /dataset\.raftBuildBuiltAt/);
  assert.match(source, /dataset\.raftBuildBranch/);
  assert.match(source, /__RAFT_FRONTEND_RELEASE_IDENTITY__/);
  assert.match(source, /dataset\.raftFrontendReleaseId/);
  const generator = read("scripts/frontendReleaseIdentity.ts");
  assert.match(generator, /VITE_COMMIT_SHA/);
  assert.match(generator, /VITE_BUILD_AT/);
  assert.match(generator, /VITE_RELEASE_BRANCH/);
  assert.match(generator, /VITE_FRONTEND_RELEASE_ID/);

  const main = read("src/main.tsx");
  assert.match(main, /import "\.\/buildIdentity";/);

  const vite = read("vite.config.ts");
  assert.match(vite, /resolveFrontendReleaseIdentity\(process\.env\)/);
  assert.match(vite, /createFrontendReleaseIdentityDefines\(frontendReleaseIdentity\)/);
  assert.match(vite, /createDesktopManifestContractAdapter\(process\.env\)/);
  assert.match(
    vite,
    /createFrontendReleaseIdentityPlugin\(\s*frontendReleaseIdentity,\s*desktopManifestContract,\s*\)/,
  );
});

test("web build identity env vars are declared and injected by preview workflow", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const envTypes = read("src/vite-env.d.ts");
  assert.match(envTypes, /VITE_COMMIT_SHA/);
  assert.match(envTypes, /VITE_BUILD_AT/);
  assert.match(envTypes, /VITE_RELEASE_BRANCH/);
  assert.match(envTypes, /VITE_FRONTEND_RELEASE_ID/);

  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/deploy-web-preview.yml"), "utf8");
  assert.match(workflow, /built_at: \$\{\{ steps\.identity\.outputs\.built_at \}\}/);
  assert.match(workflow, /echo "built_at=\$\(date -u \+"\%Y-\%m-\%dT\%H:\%M:\%SZ"\)"/);
  assert.match(workflow, /VITE_COMMIT_SHA: \$\{\{ steps\.identity\.outputs\.commit_sha \}\}/);
  assert.match(workflow, /VITE_BUILD_AT: \$\{\{ steps\.identity\.outputs\.built_at \}\}/);
  assert.match(workflow, /VITE_RELEASE_BRANCH: \$\{\{ steps\.identity\.outputs\.branch \}\}/);
  assert.match(workflow, /VITE_FRONTEND_RELEASE_ID: \$\{\{ steps\.identity\.outputs\.commit_sha \}\}/);
});

test("web Dockerfile accepts build identity args before Vite build", () => {
  const dockerfile = readFileSync(resolve(repoRoot, "packages/web/Dockerfile"), "utf8");
  const buildIndex = dockerfile.indexOf("RUN pnpm --filter @botiverse/raft-web run build");
  assert.notEqual(buildIndex, -1, "web Dockerfile should run the Vite build");
  const beforeBuild = dockerfile.slice(0, buildIndex);

  assert.match(beforeBuild, /ARG VITE_COMMIT_SHA=""/);
  assert.match(beforeBuild, /ARG VITE_BUILD_AT=""/);
  assert.match(beforeBuild, /ARG VITE_RELEASE_BRANCH=""/);
  assert.match(beforeBuild, /ARG VITE_FRONTEND_RELEASE_ID=""/);
  assert.match(beforeBuild, /ENV VITE_COMMIT_SHA=\$VITE_COMMIT_SHA/);
  assert.match(beforeBuild, /ENV VITE_BUILD_AT=\$VITE_BUILD_AT/);
  assert.match(beforeBuild, /ENV VITE_RELEASE_BRANCH=\$VITE_RELEASE_BRANCH/);
  assert.match(beforeBuild, /ENV VITE_FRONTEND_RELEASE_ID=\$VITE_FRONTEND_RELEASE_ID/);
});

test("nginx reserves the desktop manifest path and never serves the SPA shell there", () => {
  const nginx = readFileSync(resolve(repoRoot, "packages/web/nginx.conf"), "utf8");
  assert.match(nginx, /location = \/desktop-manifest\.json/);
  assert.match(nginx, /try_files \$uri @desktop_manifest_missing/);
  assert.match(nginx, /location @desktop_manifest_missing/);
  assert.match(nginx, /return 404 '\{"error":"desktop_manifest_unavailable"\}'/);
  assert.match(nginx, /no-cache, must-revalidate/);
  assert.match(nginx, /X-Content-Type-Options "nosniff"/);
  assert.match(nginx, /etag off/);
  assert.match(nginx, /include \/etc\/nginx\/desktop-manifest-etag\.conf/);

  const dockerfile = readFileSync(resolve(repoRoot, "packages/web/Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /sha256sum \/usr\/share\/nginx\/html\/desktop-manifest\.json/,
  );
  assert.match(dockerfile, /sha256-%s/);
});
