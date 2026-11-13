import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));

// pnpm 11+ reads its settings from pnpm-workspace.yaml and ignores the `pnpm`
// field in package.json, so patches are declared there. The block is read
// line by line (the server package has no YAML parser) and anything it cannot
// read fails the test rather than counting as "no patches".
function declaredDependencyPatches(): string[] {
  const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  assert.equal(
    rootPkg.pnpm,
    undefined,
    "package.json has a `pnpm` field; pnpm 11+ ignores it, move the settings to pnpm-workspace.yaml",
  );
  const lines = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8").split("\n");
  const blocks = lines.flatMap((line, index) => (/^patchedDependencies\s*:/.test(line) ? [index] : []));
  if (!blocks.length) return [];
  assert.equal(blocks.length, 1, "pnpm-workspace.yaml declares patchedDependencies more than once");
  assert.match(lines[blocks[0]], /^patchedDependencies:\s*(#.*)?$/, "patchedDependencies must be a block mapping");
  const patches: string[] = [];
  for (const line of lines.slice(blocks[0] + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s+(?:"[^"]+"|'[^']+'|[^\s:"'#]+):\s+(?:"([^"]+)"|'([^']+)'|([^\s"'#]+))\s*(#.*)?$/.exec(line);
    assert.ok(entry, `unreadable patchedDependencies entry: ${line}`);
    patches.push(entry[1] ?? entry[2] ?? entry[3]);
  }
  return patches;
}

test.skipIf(inSourceSnapshot)("AWS image cache keys hash dependency patches exactly when patches are declared", () => {
  const patches = declaredDependencyPatches();
  for (const [script, dockerfile] of [
    ["scripts/deploy/aws-build-push-server-image.sh", "packages/server/Dockerfile"],
    ["scripts/deploy/aws-build-push-trace-upload-image.sh", "packages/trace-upload-worker/Dockerfile"],
  ]) {
    const source = readFileSync(resolve(repoRoot, script), "utf8");
    const hashesPatches = source.includes('"patches"');
    if (patches.length) {
      assert.ok(hashesPatches, `${script} must hash patch contents`);
    } else {
      // hash_git_inputs resolves each input with `git rev-parse HEAD:<path>`,
      // which fails for a path that is not in the tree.
      assert.equal(hashesPatches, false, `${script} hashes patches/ but the directory no longer exists`);
    }
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
    entry: "packages/trace-upload-worker",
    cacheKeyScript: "scripts/deploy/aws-build-push-trace-upload-image.sh",
  },
  {
    entry: "packages/server",
    cacheKeyScript: "scripts/deploy/aws-build-push-server-image.sh",
  },
];

for (const image of RUNTIME_IMAGES) {
  test.skipIf(inSourceSnapshot)(`deploy-aws-staging.yml redeploys ${image.entry} when any package in its closure changes`, () => {
    // The staging deploy only runs on pushes that touch its `paths:` filter. A
    // closure package missing from that filter means a merge that changes only
    // that package builds no image at all, and staging keeps serving the old code.
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/deploy-aws-staging.yml"), "utf8");
    const paths = workflow.split("\n    paths:\n")[1]?.split("\n\n")[0] ?? "";
    for (const dep of [image.entry, ...workspaceClosure(image.entry)]) {
      assert.ok(
        paths.includes(`- "${dep}/**"`),
        `deploy-aws-staging.yml paths must include "${dep}/**" — otherwise a ${dep}-only merge does not redeploy ${image.entry}`,
      );
    }
  });

  test.skipIf(inSourceSnapshot)(`${image.cacheKeyScript} hashes its whole workspace dependency closure`, () => {
    // If a dependency copied into the image is not a hash input, a release that
    // changes ONLY that package reuses the previous image tag and ships stale
    // code, so this is derived from the manifest closure rather than maintained
    // by hand.
    const script = readFileSync(resolve(repoRoot, image.cacheKeyScript), "utf8");
    for (const dep of workspaceClosure(image.entry)) {
      assert.ok(
        script.includes(`"${dep}"`),
        `${image.cacheKeyScript} must hash ${dep} — otherwise a ${dep}-only change reuses the old image tag`,
      );
    }
  });
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
