import assert from "node:assert/strict";
import { configureMetricsDeploymentIdentity, register, releaseShaLabel } from "./metrics";
import { readBuildIdentityStatus, SERVER_VERSION } from "./version";

test("application metrics include privacy-safe deployment identity labels", async () => {
  configureMetricsDeploymentIdentity({
    serviceInstanceId: "ecs:test-instance",
    deploymentInstanceSource: "aws_ecs_task",
    deploymentIdentityState: "resolved",
    ecsTaskId: "0123456789abcdef0123456789abcdef",
  });

  const metrics = await register.metrics();

  assert.match(metrics, /slock_app_metrics_info\{[^}]*app="slock-server"[^}]*\} 1/);
  assert.match(metrics, /slock_app_metrics_info\{[^}]*service_instance_id="ecs:test-instance"[^}]*\} 1/);
  assert.match(metrics, /slock_app_metrics_info\{[^}]*deployment_instance_source="aws_ecs_task"[^}]*\} 1/);
  assert.match(metrics, /slock_app_metrics_info\{[^}]*deployment_identity_state="resolved"[^}]*\} 1/);
  assert.match(metrics, /slock_app_metrics_info\{[^}]*ecs_task_id="0123456789abcdef0123456789abcdef"[^}]*\} 1/);
  assert.match(metrics, /slock_app_metrics_info\{[^}]*git_sha="[^"]+"[^}]*\} 1/);
  assert.match(metrics, new RegExp(`slock_app_metrics_info\\{[^}]*service_version="${SERVER_VERSION.replaceAll(".", "\\.")}"[^}]*\\} 1`));
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+/);
  assert.match(metrics, /# HELP slock_attachment_lifecycle_sweeps_total/);
  assert.match(metrics, /# HELP slock_attachment_lifecycle_gc_outcomes_total/);
  assert.match(metrics, /# HELP slock_attachment_lifecycle_gc_jobs/);
  assert.match(metrics, /# HELP slock_attachment_lifecycle_gc_oldest_pending_seconds/);
});

test("git_sha is the release commit, or unknown without a valid build identity", () => {
  const sha = "B064FCE3".padEnd(40, "0");
  assert.equal(
    releaseShaLabel(readBuildIdentityStatus({
      RAFT_RELEASE_SHA: sha,
      RAFT_BUILD_AT: "2026-10-06T18:00:00Z",
      RAFT_RELEASE_BRANCH: "release/v1.21.3",
    })),
    sha.toLowerCase(),
  );
  assert.equal(releaseShaLabel(readBuildIdentityStatus({})), "unknown");
  assert.equal(releaseShaLabel(readBuildIdentityStatus({ RAFT_RELEASE_SHA: "not-a-sha" })), "unknown");
});
