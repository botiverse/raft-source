import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "../..");
const releaseWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/release-raft-computer-app.yml"),
  "utf8",
);
const reusableWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/_macos-sign-notarize.yml"),
  "utf8",
);
const devWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/build-raft-computer-app.yml"),
  "utf8",
);
const baseConfig = readFileSync(resolve(appRoot, "electron-builder.yml"), "utf8");
const releaseConfig = readFileSync(
  resolve(appRoot, "electron-builder.release.yml"),
  "utf8",
);

test("the supported legacy Desktop identity installs through the canonical Applications target", () => {
  assert.match(baseConfig, /^appId: build\.raft\.computer-app$/m);
  assert.match(baseConfig, /^productName: Raft Computer$/m);
  assert.match(reusableWorkflow, /ln -s \/Applications "\$stage\/Applications"/);
  assert.match(
    reusableWorkflow,
    /dmg_link_target="\$\(readlink "\$\{MOUNT_DIR\}\/Applications"[^\n]*\|\| true\)"/,
  );
  assert.match(reusableWorkflow, /\[ "\$dmg_link_target" != "\/Applications" \]/);
});

test("the macOS release lane fails closed on signing and notarization credentials", () => {
  assert.match(
    releaseWorkflow,
    /uses: \.\/\.github\/workflows\/_macos-sign-notarize\.yml/,
  );
  assert.match(releaseWorkflow, /secrets: inherit/);
  assert.match(
    releaseWorkflow,
    /release-tag: \$\{\{ inputs\.release_tag \}\}/,
  );
  assert.match(releaseWorkflow, /tag-prefix: computer-app-v/);
  assert.match(
    releaseWorkflow,
    /release-tag-pattern: '\^computer-app-v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$'/,
  );
  assert.match(
    releaseWorkflow,
    /build-command: pnpm --filter @botiverse\/raft-computer-app dist:mac:release/,
  );
  assert.match(releaseWorkflow, /bundle-id: build\.raft\.computer-app/);
  assert.match(releaseWorkflow, /expected-app-count: 2/);
  assert.match(releaseWorkflow, /expected-dmg-count: 2/);
  assert.match(releaseWorkflow, /dmg-arch-mode: per-arch/);
  assert.match(releaseWorkflow, /enable-var-name: COMPUTER_MACOS_RELEASE_ENABLED/);
  assert.match(releaseWorkflow, /self-test-mode: cli-version/);

  for (const secret of [
    "MACOS_CERT_P12_BASE64",
    "MACOS_CERT_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_ISSUER_ID",
    "APPLE_API_KEY_ID",
    "APPLE_API_PRIVATE_KEY",
  ]) {
    assert.match(
      reusableWorkflow,
      new RegExp(`${secret}:\\n\\s+required: true`),
      `${secret} is required by the reusable workflow`,
    );
    assert.match(
      reusableWorkflow,
      new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`),
      `${secret} is wired into a fail-closed implementation step`,
    );
  }
  assert.match(reusableWorkflow, /Missing \$\{name\}/);
  assert.match(reusableWorkflow, /environment:\s*computer-release-macos/);
  assert.match(releaseWorkflow, /on:\n  workflow_dispatch:/);
  assert.doesNotMatch(releaseWorkflow, /\n  push:/);
  assert.match(releaseWorkflow, /release_tag:\n        description:[^\n]+\n        required: true/);
  assert.match(releaseWorkflow, /COMPUTER_MACOS_RELEASE_ENABLED/);
  assert.match(reusableWorkflow, /vars\[inputs\.enable-var-name\]/);
  assert.match(reusableWorkflow, /protected refs\/heads\/staging/);
  assert.match(reusableWorkflow, /git rev-parse "\$\{RELEASE_TAG\}\^\{commit\}"/);
  assert.match(reusableWorkflow, /security import "\$\{CERT_PATH\}"/);
  assert.match(
    reusableWorkflow,
    /Build Developer ID-signed apps \(per-arch\)[\s\S]*?APPLE_TEAM_ID: \$\{\{ secrets\.APPLE_TEAM_ID \}\}/,
  );
  assert.match(reusableWorkflow, /Developer ID Application/);
  assert.match(reusableWorkflow, /\(\$\{APPLE_TEAM_ID\}\)/);
  assert.match(reusableWorkflow, /umask 077/);
  assert.match(reusableWorkflow, /chmod 600 "\$NOTARY_KEY_PATH"/);
  assert.match(reusableWorkflow, /unset APPLE_API_PRIVATE_KEY/);
  assert.match(reusableWorkflow, /unset MACOS_CERT_P12_BASE64/);
  assert.match(reusableWorkflow, /unset MACOS_CERT_PASSWORD/);
  assert.match(reusableWorkflow, /rm -f "\$\{RUNNER_TEMP\}"\/AuthKey_\*\.p8/);
  assert.doesNotMatch(releaseWorkflow, /HANDS_/);
  assert.doesNotMatch(releaseWorkflow, /hands builds notarize/);
  assert.doesNotMatch(reusableWorkflow, /HANDS_/);
  assert.doesNotMatch(reusableWorkflow, /hands builds notarize/);
  assert.match(releaseConfig, /forceCodeSigning:\s*true/);
  assert.doesNotMatch(baseConfig, /identity:\s*null/);
  assert.match(devWorkflow, /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/);
});

test("notarization, staple, and final-byte verification precede draft publication", () => {
  const detachFunction = reusableWorkflow.slice(
    reusableWorkflow.indexOf("detach_verified_mount()"),
    reusableWorkflow.indexOf("cd verified-release"),
  );
  const verifyPlanJob = reusableWorkflow.slice(
    reusableWorkflow.indexOf("  plan_verify_matrix:"),
    reusableWorkflow.indexOf("  build_sign_notarize:"),
  );
  const publishJob = reusableWorkflow.slice(
    reusableWorkflow.indexOf("  publish_draft_release:"),
  );
  const build = reusableWorkflow.indexOf('eval "${BUILD_COMMAND}"');
  const notarize = reusableWorkflow.indexOf("xcrun notarytool submit");
  const staple = reusableWorkflow.indexOf("xcrun stapler staple");
  const artifactUpload = reusableWorkflow.indexOf("Upload notarized release bytes");
  const artifactDownload = reusableWorkflow.indexOf("Download the release artifact");
  const strictVerify = reusableWorkflow.lastIndexOf("codesign --verify --deep --strict");
  const gatekeeper = reusableWorkflow.lastIndexOf("spctl --assess --type exec");
  const packagedLaunch = reusableWorkflow.indexOf("result = subprocess.run(");
  const detachInvocation = reusableWorkflow.lastIndexOf('detach_verified_mount "$MOUNT_DIR"');
  const draftRelease = reusableWorkflow.indexOf("gh release create");

  assert.ok(build >= 0, "release build exists");
  assert.ok(notarize > build, "notarization follows the signed build");
  assert.ok(staple > notarize, "stapling follows an Accepted notarization");
  assert.ok(artifactUpload > staple, "only locally stapled bytes are uploaded");
  assert.ok(artifactDownload > artifactUpload, "verification downloads the uploaded artifact");
  assert.ok(strictVerify > artifactDownload, "downloaded app bundle gets strict codesign verification");
  assert.ok(gatekeeper > strictVerify, "Gatekeeper assesses the downloaded app");
  assert.ok(packagedLaunch > gatekeeper, "the packaged executable runs after Gatekeeper accepts it");
  assert.ok(detachInvocation > packagedLaunch, "the success-path detach follows the packaged launch");
  assert.ok(draftRelease > gatekeeper, "draft publication waits for final-byte verification");

  assert.match(reusableWorkflow, /NOTARY_STATUS.*Accepted/);
  assert.match(reusableWorkflow, /invalid submission id/);
  assert.match(reusableWorkflow, /xcrun notarytool log/);
  assert.match(reusableWorkflow, /\.status == "Accepted" and \(\(\.issues \/\/ \[\]\) \| length == 0\)/);
  assert.match(reusableWorkflow, /stat -f '%d:%i'/);
  assert.match(reusableWorkflow, /DMG bytes or inode changed between notarization submit and staple/);
  assert.match(reusableWorkflow, /source_sha256:\$source_sha256/);
  assert.match(reusableWorkflow, /source_size_bytes:\$source_size_bytes/);
  assert.match(reusableWorkflow, /final_sha256:\$final_sha256/);
  assert.match(reusableWorkflow, /final_size_bytes:\$final_size_bytes/);
  assert.match(reusableWorkflow, /xcrun stapler validate "\$dmg"/);
  assert.match(reusableWorkflow, /shasum -a 256 --check SHA256SUMS/);
  assert.match(reusableWorkflow, /name: Verify downloaded notarized bytes \(\$\{\{ matrix\.dmg_suffix \}\}\)/);
  assert.match(reusableWorkflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(
    verifyPlanJob,
    /"runner":"blacksmith-6vcpu-macos-15","runner_arch":"arm64","dmg_suffix":"arm64"/,
  );
  assert.match(
    verifyPlanJob,
    /"runner":"macos-14-large","runner_arch":"x86_64","dmg_suffix":"x64"/,
  );
  assert.doesNotMatch(
    verifyPlanJob,
    /"runner_arch":"arm64","dmg_suffix":"x64"/,
  );
  assert.doesNotMatch(
    verifyPlanJob,
    /"runner_arch":"x86_64","dmg_suffix":"arm64"/,
  );
  assert.match(reusableWorkflow, /ACTUAL_RUNNER_ARCH="\$\(uname -m\)"/);
  assert.match(
    reusableWorkflow,
    /Runner architecture \$\{ACTUAL_RUNNER_ARCH\} does not match \$\{EXPECTED_RUNNER_ARCH\}/,
  );
  assert.match(reusableWorkflow, /-name "\*-\$\{DMG_SUFFIX\}\.dmg" -print0/);
  assert.match(reusableWorkflow, /Expected EXACTLY ONE \$\{DMG_SUFFIX\} DMG/);
  assert.match(publishJob, /needs: \[build_sign_notarize, verify_downloaded_release\]/);
  assert.match(reusableWorkflow, /detach_verified_mount\(\)/);
  assert.match(reusableWorkflow, /for attempt in 1 2 3 4 5/);
  assert.match(reusableWorkflow, /Detach attempt \$\{attempt\}\/5 failed/);
  assert.match(
    reusableWorkflow,
    /Normal detach failed after 5 attempts; forcing detach for \$\{mount_dir\}/,
  );
  assert.match(
    reusableWorkflow,
    /Could not detach \$\{mount_dir\} after 5 attempts and force fallback/,
  );
  assert.match(reusableWorkflow, /lsof \+D "\$mount_dir" \|\| true/);
  assert.match(detachFunction, /hdiutil detach "\$mount_dir" -force/);
  assert.ok(
    detachFunction.indexOf('hdiutil detach "$mount_dir" -force') >
      detachFunction.lastIndexOf('lsof +D "$mount_dir" || true'),
  );
  assert.equal(
    reusableWorkflow.match(/^\s+detach_verified_mount "\$MOUNT_DIR"$/gm)?.length,
    1,
  );
  assert.match(reusableWorkflow, /detach_verified_mount "\$MOUNT_DIR"/);
  assert.doesNotMatch(reusableWorkflow, /^\s+hdiutil detach "\$MOUNT_DIR"$/m);
  assert.match(reusableWorkflow, /--draft --verify-tag/);
  assert.match(reusableWorkflow, /--json isDraft --jq '\.isDraft'/);
  assert.match(reusableWorkflow, /Refusing to replace assets on an already-published release/);
  assert.doesNotMatch(reusableWorkflow, /gh release create[^\n]*--latest/);
  assert.match(reusableWorkflow, /xcrun notarytool submit/);
  assert.match(reusableWorkflow, /xcrun stapler staple/);
});

test("the release entitlement set stays narrow", () => {
  for (const file of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
    const contents = readFileSync(resolve(appRoot, "assets", file), "utf8");
    assert.match(contents, /com\.apple\.security\.cs\.allow-jit/);
    assert.match(contents, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
    assert.doesNotMatch(contents, /disable-library-validation/);
    assert.doesNotMatch(contents, /app-sandbox/);
  }
});
