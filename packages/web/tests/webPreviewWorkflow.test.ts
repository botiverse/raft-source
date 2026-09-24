import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));
const workflow = inSourceSnapshot
  ? ""
  : readFileSync(resolve(repoRoot, ".github/workflows/deploy-web-preview.yml"), "utf8");

test("untrusted preview code only crosses the credential boundary as an inert artifact", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /rm -f packages\/web\/dist\/_worker\.js packages\/web\/dist\/_routes\.json/);
  assert.match(workflow, /Validate inert artifact boundary[\s\S]*find web-preview-dist -type l/);

  const buildJob = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  deploy:"));
  assert.doesNotMatch(buildJob, /CLOUDFLARE_API_TOKEN|RAFT_ENV_MANAGER_DEPLOYMENTS_KV_NAMESPACE_ID/);
});

test("credentialed jobs execute only the immutable standalone Action", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const credentialedJobs = workflow.slice(workflow.indexOf("  deploy:"));
  assert.match(
    credentialedJobs,
    /uses: botiverse\/raft-env-manager\/\.github\/actions\/web-preview@[0-9a-f]{40}/,
  );
  assert.equal(
    workflow.match(
      /botiverse\/raft-env-manager\/\.github\/actions\/web-preview@ab81a655ea9ee89fa554a3d6b3086211719a45c0/g,
    )?.length,
    2,
    "deploy and cleanup must pin the reviewed/deployed substrate exact",
  );
  assert.match(credentialedJobs, /operation: deploy/);
  assert.match(credentialedJobs, /operation: disable/);
  assert.doesNotMatch(credentialedJobs, /actions\/checkout|packages\/web-preview-worker|git clone|git fetch/);
  assert.match(credentialedJobs, /Verify public deployed identity[\s\S]*\/__raft_preview/);
  assert.match(credentialedJobs, /Verify public deployed identity[\s\S]*\/desktop-manifest\.json/);
  assert.match(credentialedJobs, /--retry-all-errors/);
  assert.match(credentialedJobs, /for round in 1 2 3 4 5/);
  assert.equal(
    credentialedJobs.match(/--header 'Cache-Control: no-cache'/g)?.length,
    4,
    "readiness and all three strict round probes must bypass intermediary caches",
  );
  assert.match(credentialedJobs, /raft_verify_nonce=.*-metadata/);
  assert.match(credentialedJobs, /raft_verify_nonce=.*-root/);
  assert.match(credentialedJobs, /raft_verify_nonce=.*-manifest/);
  assert.match(credentialedJobs, /branch == \$branch/);
  assert.match(credentialedJobs, /apiTarget == \$api_target/);
  assert.match(credentialedJobs, /environmentStatus == "active"/);
  assert.match(credentialedJobs, /lifecycleStatus == "active"/);
  assert.equal(credentialedJobs.match(/header_value x-raft-preview-commit/g)?.length, 2);
  assert.equal(credentialedJobs.match(/header_value x-raft-preview-api-target/g)?.length, 2);
  assert.equal(credentialedJobs.match(/header_value x-raft-preview-lifecycle/g)?.length, 2);
  assert.match(credentialedJobs, /manifest_status[\s\S]*200/);
  assert.match(credentialedJobs, /wc -c[\s\S]*65536/);
  assert.match(credentialedJobs, /frontendReleaseId == \$sha/);
  assert.match(credentialedJobs, /\.compatibility\.appSemver \| type\) == "string"/);
  assert.match(credentialedJobs, /\.compatibility\.requiredCapabilities \| type\) == "array"/);
  assert.match(credentialedJobs, /\.compatibility\.requiredCapabilities \| all\(type == "string"\)/);
  assert.doesNotMatch(credentialedJobs, /requiredCapabilities": \[/);
  assert.match(credentialedJobs, /updateRecommendation == "none"/);
  assert.match(credentialedJobs, /content-type:[\s\S]*application\/json/);
  assert.match(credentialedJobs, /cache-control:[\s\S]*no-cache.*must-revalidate/);
  assert.match(credentialedJobs, /x-content-type-options:[\s\S]*nosniff/);
  assert.match(credentialedJobs, /round_manifest_etag=.*sha256sum "\$manifest_body"/);
  assert.match(credentialedJobs, /header_value etag "\$manifest_headers"/);
  assert.match(credentialedJobs, /round_manifest_etag.*expected_manifest_etag/);
  assert.match(credentialedJobs, /raft-frontend-release-identity/);
  assert.match(credentialedJobs, /identity_json=.*sed -n/s);
  assert.doesNotMatch(credentialedJobs, /\bnode\s+-e\b/);
  assert.doesNotMatch(credentialedJobs, /CF_ACCESS|RAFT_ENV_MANAGER_ACCESS|CF-Access-Client/);
});

test("deployment infrastructure uses one credential boundary and an explicit data target", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assert.match(workflow, /name: Deploy Branch Preview/);
  assert.match(workflow, /branch-preview-staging-data/);
  assert.doesNotMatch(workflow, /branch-preview-prod-data/);
  assert.match(workflow, /api_target:[\s\S]*options: \[staging, prod\]/);
  assert.match(workflow, /PREVIEW_API_TARGET: \$\{\{ inputs\.api_target \|\| 'staging' \}\}/);
  assert.match(workflow, /RAFT_ENV_MANAGER_PAGES_PROJECT/);
  assert.match(workflow, /RAFT_ENV_MANAGER_DEPLOYMENTS_KV_NAMESPACE_ID/);
  assert.match(workflow, /CLOUDFLARE_RAFT_ENV_MANAGER_DEPLOY_TOKEN/);
  assert.doesNotMatch(workflow, /RAFT_WEB_PREVIEW|CLOUDFLARE_WEB_PREVIEW/);
  assert.doesNotMatch(workflow, /web-preview-(?:staging|prod|gateway)/);
});

test("deployment consumers read the composite Action preview-url output", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assert.equal(workflow.match(/steps\.deployment\.outputs\['preview-url'\]/g)?.length, 3);
  assert.doesNotMatch(workflow, /steps\.deployment\.outputs\.preview_url/);
});

test("cleanup is workflow-dispatch-only and carries Env Manager correlation", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assert.match(workflow, /operation_id:[\s\S]*Optional Env Manager operation correlation ID/);
  assert.match(workflow, /run-name: Branch preview/);
  const cleanupJob = workflow.slice(workflow.indexOf("  cleanup:"));
  assert.match(cleanupJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(cleanupJob, /inputs\.action == 'disable'/);
  assert.doesNotMatch(cleanupJob, /pull_request_target|github\.event\.action == 'unlabeled'/);
});

test("workflow declares and forwards the authoritative preview_host to deploy and disable", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  // Live-wiring tooth (Env Manager P0-3): the workflow must declare the
  // preview_host input and forward it to BOTH the deploy and disable action
  // invocations. Removing any of these turns this test RED.
  assert.match(workflow, /preview_host:\n\s+description: Authoritative stored preview hostname/);
  const actionCalls = workflow.match(/preview-host: \$\{\{ inputs\.preview_host \}\}/g);
  assert.equal(actionCalls?.length, 2, "deploy and cleanup must both forward preview_host");
});
