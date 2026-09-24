import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));

const rootLockfileDockerfiles = [
  "packages/server/Dockerfile",
  "packages/trace-upload-worker/Dockerfile",
  "packages/web/Dockerfile",
];

test.skipIf(inSourceSnapshot)("every root-lockfile Docker build supplies declared patches before installing", () => {
  const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const patches = Object.values(rootPkg.pnpm?.patchedDependencies ?? {}) as string[];
  for (const patch of patches) assert.ok(existsSync(resolve(repoRoot, patch)), `missing ${patch}`);
  for (const dockerfile of [...rootLockfileDockerfiles, "scripts/agent-migration-e2e/Dockerfile"]) {
    const source = readFileSync(resolve(repoRoot, dockerfile), "utf8");
    const installIndex = source.indexOf("RUN pnpm install --frozen-lockfile");
    assert.ok(installIndex >= 0);
    if (patches.length) {
      const copyIndex = source.indexOf("COPY patches/ patches/");
      assert.ok(copyIndex >= 0 && copyIndex < installIndex, `${dockerfile} must supply patches before install`);
    }
  }
});

test.skipIf(inSourceSnapshot)("AWS image cache keys cover dependency patches and Dockerfile", () => {
  for (const [script, dockerfile] of [
    ["scripts/deploy/aws-build-push-server-image.sh", "packages/server/Dockerfile"],
    ["scripts/deploy/aws-build-push-trace-upload-image.sh", "packages/trace-upload-worker/Dockerfile"],
  ]) {
    const source = readFileSync(resolve(repoRoot, script), "utf8");
    assert.ok(source.includes('"patches"'), `${script} must hash patch contents`);
    assert.ok(source.includes(`"${dockerfile}"`));
  }
});

test.skipIf(inSourceSnapshot)("AWS server and trace-upload image cache keys include release sha", () => {
  const scripts = [
    "scripts/deploy/aws-build-push-server-image.sh",
    "scripts/deploy/aws-build-push-trace-upload-image.sh",
  ];

  for (const script of scripts) {
    const source = readFileSync(resolve(repoRoot, script), "utf8");
    const releaseIndex = source.indexOf("release_sha=");
    const hashIndex = source.indexOf("input_hash=");
    assert.ok(releaseIndex >= 0, `${script} should compute release_sha`);
    assert.ok(hashIndex >= 0, `${script} should compute input_hash`);
    assert.ok(
      releaseIndex < hashIndex,
      `${script} must compute release_sha before hashing image inputs`,
    );
    assert.match(
      source,
      /"[^"]*release:\$\{release_sha\}[^"]*"/,
      `${script} image hash prefix must include release_sha so ref-only deploys do not reuse stale release metadata`,
    );
  }
});

test.skipIf(inSourceSnapshot)("trace-upload image contains and hashes its shared workspace runtime dependency", () => {
  const dockerfile = readFileSync(resolve(repoRoot, "packages/trace-upload-worker/Dockerfile"), "utf8");
  const installIndex = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");
  const startIndex = dockerfile.indexOf('CMD ["pnpm", "--filter", "@botiverse/raft-trace-upload-worker", "start"]');
  const sharedManifestIndex = dockerfile.indexOf("COPY packages/shared/package.json packages/shared/");
  const sharedSourceIndex = dockerfile.indexOf("COPY packages/shared/ packages/shared/");

  assert.ok(sharedManifestIndex >= 0, "trace-upload image must copy the shared manifest");
  assert.ok(
    sharedManifestIndex < installIndex,
    "trace-upload image must expose the shared workspace package before pnpm install links workspace dependencies",
  );
  assert.ok(sharedSourceIndex >= 0, "trace-upload image must contain shared runtime source");
  assert.ok(sharedSourceIndex < startIndex, "trace-upload image must copy shared runtime source before starting the worker");

  const buildScript = readFileSync(
    resolve(repoRoot, "scripts/deploy/aws-build-push-trace-upload-image.sh"),
    "utf8",
  );
  assert.match(
    buildScript,
    /"packages\/shared"/,
    "trace-upload image cache key must change when its shared runtime dependency changes",
  );
});

/**
 * Resolve a package's TRANSITIVE workspace dependency closure from the actual
 * manifests, rather than naming packages literally.
 *
 * The literal version of this check existed and still passed while the
 * trace-upload image failed to boot: it asserted `packages/shared` was copied,
 * and shared had just gained a runtime re-export of a NEW workspace package
 * that no Dockerfile copied. A closure derived from the manifests fails the
 * moment a package split adds a hop, without anyone remembering to update it.
 */
function workspaceClosure(entryPackageDir: string): string[] {
  const seen = new Set<string>();
  const dirByName = new Map<string, string>();
  for (const dir of readdirSync(resolve(repoRoot, "packages"))) {
    const manifestPath = resolve(repoRoot, "packages", dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    dirByName.set(JSON.parse(readFileSync(manifestPath, "utf8")).name, `packages/${dir}`);
  }
  const walk = (packageDir: string) => {
    const manifestPath = resolve(repoRoot, packageDir, "package.json");
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const [name, range] of Object.entries({ ...(manifest.dependencies ?? {}) })) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
      const depDir = dirByName.get(name);
      if (!depDir || seen.has(depDir)) continue;
      seen.add(depDir);
      walk(depDir);
    }
  };
  walk(entryPackageDir);
  return [...seen].sort();
}

const RUNTIME_IMAGES = [
  {
    dockerfile: "packages/trace-upload-worker/Dockerfile",
    entry: "packages/trace-upload-worker",
    cacheKeyScript: "scripts/deploy/aws-build-push-trace-upload-image.sh",
  },
  {
    dockerfile: "packages/server/Dockerfile",
    entry: "packages/server",
    cacheKeyScript: "scripts/deploy/aws-build-push-server-image.sh",
  },
  // The web image is built by CF Pages / the AWS web workflow rather than a
  // hash-input script in scripts/deploy, so it has no cache-key file to pin.
  { dockerfile: "packages/web/Dockerfile", entry: "packages/web", cacheKeyScript: null },
];

for (const image of RUNTIME_IMAGES) {
  test(`${image.dockerfile} copies its whole workspace dependency closure`, () => {
    const dockerfile = readFileSync(resolve(repoRoot, image.dockerfile), "utf8");
    const installIndex = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");
    assert.ok(installIndex >= 0, `${image.dockerfile} must run a frozen install`);

    for (const dep of workspaceClosure(image.entry)) {
      const manifestIndex = dockerfile.indexOf(`COPY ${dep}/package.json ${dep}/`);
      const sourceIndex = dockerfile.indexOf(`COPY ${dep}/ ${dep}/`);
      assert.ok(
        manifestIndex >= 0,
        `${image.dockerfile} must copy ${dep}/package.json — it is a transitive workspace dependency`,
      );
      assert.ok(
        manifestIndex < installIndex,
        `${image.dockerfile} must copy ${dep}/package.json BEFORE the frozen install links workspace deps`,
      );
      assert.ok(
        sourceIndex >= 0,
        `${image.dockerfile} must copy ${dep}/ source — missing it boots to ERR_MODULE_NOT_FOUND`,
      );
    }
  });

  if (image.cacheKeyScript) {
    test.skipIf(inSourceSnapshot)(`${image.cacheKeyScript} hashes its whole workspace dependency closure`, () => {
      // Copying a dependency into the image is only half the contract: if the
      // dependency is not a hash input, a release that changes ONLY that
      // package reuses the previous image tag and ships stale code. The COPY
      // check above passes in that state, so this must be derived from the same
      // manifest closure rather than maintained by hand.
      const script = readFileSync(resolve(repoRoot, image.cacheKeyScript!), "utf8");
      for (const dep of workspaceClosure(image.entry)) {
        assert.ok(
          script.includes(`"${dep}"`),
          `${image.cacheKeyScript} must hash ${dep} — otherwise a ${dep}-only change reuses the old image tag`,
        );
      }
    });
  }
}

test.skipIf(inSourceSnapshot)("hosted CI builds and boots the trace-upload image", () => {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/test.yml"), "utf8");
  assert.match(
    workflow,
    /trace-upload-image-boot:/,
    "hosted CI must expose a dedicated trace-upload image boot job",
  );
  assert.match(
    workflow,
    /bash scripts\/ci\/check-trace-upload-image\.sh/,
    "hosted CI must execute the real trace-upload image boot probe",
  );

  const probe = readFileSync(resolve(repoRoot, "scripts/ci/check-trace-upload-image.sh"), "utf8");
  assert.match(probe, /docker build/);
  assert.match(
    probe,
    /traceEventProjector\.ts/,
    "the image probe must import the exact module whose workspace dependency failed in ECS",
  );
  assert.match(probe, /docker run/);
  assert.match(probe, /\/healthz/);
});

test.skipIf(inSourceSnapshot)("server image build receives complete build identity without runtime git", () => {
  const dockerfile = readFileSync(resolve(repoRoot, "packages/server/Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG SLOCK_RELEASE_SHA=""/);
  assert.match(dockerfile, /ARG SLOCK_BUILD_AT=""/);
  assert.match(dockerfile, /ARG SLOCK_RELEASE_BRANCH=""/);
  assert.match(dockerfile, /ENV SLOCK_RELEASE_SHA=\$SLOCK_RELEASE_SHA/);
  assert.match(dockerfile, /ENV SLOCK_BUILD_AT=\$SLOCK_BUILD_AT/);
  assert.match(dockerfile, /ENV SLOCK_RELEASE_BRANCH=\$SLOCK_RELEASE_BRANCH/);

  const awsScript = readFileSync(resolve(repoRoot, "scripts/deploy/aws-build-push-server-image.sh"), "utf8");
  assert.match(awsScript, /release_branch=/);
  assert.match(awsScript, /build_at=/);
  assert.match(
    awsScript,
    /"[^"]*release:\$\{release_sha\} branch:\$\{release_branch\}"/,
    "server image cache key must include branch so the same SHA deployed through different branches does not reuse stale branch metadata",
  );
  assert.match(awsScript, /--build-arg "SLOCK_RELEASE_SHA=\$release_sha"/);
  assert.match(awsScript, /--build-arg "SLOCK_BUILD_AT=\$build_at"/);
  assert.match(awsScript, /--build-arg "SLOCK_RELEASE_BRANCH=\$release_branch"/);
});

test("web Dockerfile includes visual testing fixtures used by web typecheck", () => {
  const dockerfile = "packages/web/Dockerfile";
  const source = readFileSync(resolve(repoRoot, dockerfile), "utf8");
  const buildIndex = source.indexOf("RUN pnpm --filter @botiverse/raft-web run build");
  assert.notEqual(buildIndex, -1, `${dockerfile} should build the web package`);

  const beforeBuild = source.slice(0, buildIndex);
  assert.match(
    beforeBuild,
    /COPY\s+packages\/visual-testing\/shared\/\s+packages\/visual-testing\/shared\//,
    `${dockerfile} must copy visual-testing fixtures before web typecheck`,
  );
});
