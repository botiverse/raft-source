import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../RELEASE_SOURCE", import.meta.url));

const workflow = inSourceSnapshot ? "" : await readFile(
  new URL("../../../.github/workflows/deploy-feature-flag-admin-staging.yml", import.meta.url),
  "utf8",
);
const buildWorkflow = inSourceSnapshot ? "" : await readFile(
  new URL("../../../.github/workflows/build-feature-flag-admin.yml", import.meta.url),
  "utf8",
);
const triggerWorkflow = inSourceSnapshot ? "" : await readFile(
  new URL("../../../.github/workflows/trigger-feature-flag-admin-deploy.yml", import.meta.url),
  "utf8",
);
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

test("staging deploy has no API-caller-selected target", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m);
  assert.doesNotMatch(workflow, /inputs:/);
  assert.match(workflow, /test "\$\{GITHUB_REF\}" = "refs\/heads\/staging"/);
  assert.match(workflow, /environment: feature-flag-admin-staging/);
  assert.match(workflow, /--env staging/g);
  assert.doesNotMatch(workflow, /--env \$\{/);
  // The auto path reaches this executor as a child workflow, not by dispatching
  // it with a caller-chosen target. Both entry points must stay input-free: the
  // `doesNotMatch(/inputs:/)` above covers workflow_call as well.
  assert.match(workflow, /^  workflow_call:\s*$/m);
  // Single-writer against the staging Worker must hold in BOTH modes. A
  // workflow-level concurrency group is ignored when this workflow is invoked
  // with `uses:`, so the group has to sit on the job.
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(workflow, /^    concurrency:\n      group: deploy-feature-flag-admin-staging-worker\n      cancel-in-progress: false$/m);
});

test("the production trigger gates on the staging executor as a child workflow", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  // Production must never be dispatched for a commit staging did not deploy.
  // The gate is a job dependency, so it cannot be satisfied by a stale or
  // unrelated staging run the way a polled run-name match could be.
  assert.match(triggerWorkflow, /uses: \.\/\.github\/workflows\/deploy-feature-flag-admin-staging\.yml/);
  assert.match(triggerWorkflow, /^    needs: staging$/m);
  assert.match(triggerWorkflow, /secrets: inherit/);
  // Both legs stay behind the same enablement variable.
  assert.equal(
    (triggerWorkflow.match(/if: vars\.FFA_AUTO_DEPLOY_ENABLED == 'true'/g) ?? []).length,
    2,
  );
});

test("pull requests exercise the staging deployment contract without deploying", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assert.match(buildWorkflow, /\.github\/workflows\/deploy-feature-flag-admin-staging\.yml/);
  assert.match(buildWorkflow, /pnpm --filter @botiverse\/raft-feature-flag-admin check:staging-deploy-contract/);
  assert.doesNotMatch(buildWorkflow, /wrangler deploy(?! --dry-run)/);
});

test("staging deploy renders and verifies all identities before its only deploy write", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const render = workflow.indexOf("render-staging-wrangler.mjs");
  const dryRun = workflow.indexOf("--dry-run");
  const secrets = workflow.indexOf("Verify dedicated staging secrets exist");
  const deploy = workflow.indexOf("Deploy exact source to staging Worker");
  const readback = workflow.indexOf("Read back exact deployment and bindings");
  assert.ok(render > 0 && render < dryRun && dryRun < secrets && secrets < deploy && deploy < readback);
  assert.equal((workflow.match(/name: Deploy exact source to staging Worker/g) ?? []).length, 1);
  assert.match(workflow, /--message "source_sha=\$\{SOURCE_SHA\};github_run=\$\{GITHUB_RUN_ID\}:\$\{GITHUB_RUN_ATTEMPT\}"/);
  assert.match(workflow, /workers\/scripts\/slock-feature-flag-admin-staging\/settings/);
  assert.match(workflow, /observability "\$\{RUNNER_TEMP\}\/feature-flag-admin-staging-settings\.json"/);
  for (const name of [
    "FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS",
    "FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID",
    "FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID",
    "FEATURE_FLAG_ADMIN_STAGING_CLOUDFLARE_ACCOUNT_ID",
    "FEATURE_FLAG_ADMIN_STAGING_CLOUDFLARE_API_TOKEN",
  ]) {
    assert.match(workflow, new RegExp(name));
  }
});

test("production configuration remains top-level and staging identities stay under env.staging", () => {
  const stagingIndex = config.indexOf("[env.staging]");
  assert.ok(stagingIndex > 0);
  const production = config.slice(0, stagingIndex);
  const staging = config.slice(stagingIndex);
  assert.match(production, /name = "slock-feature-flag-admin"/);
  assert.match(production, /RAFT_API_ORIGIN = "https:\/\/api\.raft\.build"/);
  assert.match(staging, /name = "slock-feature-flag-admin-staging"/);
  assert.match(staging, /RAFT_ORIGIN = "https:\/\/app\.raft\.build"/);
  assert.match(staging, /RAFT_API_ORIGIN = "https:\/\/api\.raft\.build"/);
  assert.match(staging, /\[\[env\.staging\.hyperdrive\]\]/);
  assert.match(staging, /\[\[env\.staging\.d1_databases\]\]/);
  assert.match(staging, /\[env\.staging\.observability\][\s\S]*enabled = true/);
  assert.match(staging, /\[env\.staging\.observability\.logs\][\s\S]*invocation_logs = true[\s\S]*persist = true/);
});

test("workflow never references production deployment identities or secrets", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  assert.doesNotMatch(workflow, /slock-feature-flag-admin"/);
  assert.doesNotMatch(workflow, /https:\/\/api\.raft\.build/);
  assert.doesNotMatch(workflow, /95f993fa-2a68-4797-b8ae-7beb7d984ada/);
  assert.doesNotMatch(workflow, /4d73351671b9464a8cbc37e978002169/);
  assert.doesNotMatch(workflow, /db117923-c16f-4893-b49e-d3bfbb56fac9/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
});
