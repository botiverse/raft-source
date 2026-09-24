import assert from "node:assert/strict";
import { test } from "vitest";
import { configureMetricsDeploymentIdentity, register } from "./metrics.js";

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
  assert.match(metrics, /# HELP slock_attachment_lifecycle_sweeps_total/);
  assert.match(metrics, /# HELP slock_attachment_lifecycle_gc_outcomes_total/);
  assert.match(metrics, /# HELP slock_attachment_lifecycle_gc_jobs/);
  assert.match(metrics, /# HELP slock_attachment_lifecycle_gc_oldest_pending_seconds/);
});
