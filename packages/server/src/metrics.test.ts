import assert from "node:assert/strict";
import {
  agentDeliveryE2eSeconds,
  agentDeliveryQueueSeconds,
  agentWakeStartSeconds,
  configureMetricsDeploymentIdentity,
  messagePushLagSeconds,
  observeMessagePushLag,
  observeMetricSafely,
  oncePushLagObserver,
  PUSH_LATENCY_BUCKETS_SECONDS,
  register,
  releaseShaLabel,
  secondsSince,
  serviceVersionLabel,
  observeSyncResumeReplay,
  syncResumeHorizonResetTotal,
} from "./metrics";
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

test("serviceVersionLabel keeps semver on release/candidate branches and stamps branch-sha8 on non-release builds", () => {
  const sha = "2A583382A7".padEnd(40, "0");
  assert.equal(
    serviceVersionLabel(
      readBuildIdentityStatus({
        RAFT_RELEASE_SHA: sha,
        RAFT_BUILD_AT: "2026-11-19T00:00:00Z",
        RAFT_RELEASE_BRANCH: "release/v1.30.0",
      }),
      "1.30.0",
    ),
    "1.30.0",
  );
  assert.equal(
    serviceVersionLabel(
      readBuildIdentityStatus({
        RAFT_RELEASE_SHA: sha,
        RAFT_BUILD_AT: "2026-11-19T00:00:00Z",
        RAFT_RELEASE_BRANCH: "candidate/v1.31.0",
      }),
      "1.31.0",
    ),
    "1.31.0",
  );
  assert.equal(
    serviceVersionLabel(
      readBuildIdentityStatus({
        RAFT_RELEASE_SHA: sha,
        RAFT_BUILD_AT: "2026-11-19T00:00:00Z",
        RAFT_RELEASE_BRANCH: "staging",
      }),
      "1.21.54",
    ),
    "staging-2a583382",
  );
  assert.equal(
    serviceVersionLabel(
      readBuildIdentityStatus({
        RAFT_RELEASE_SHA: sha,
        RAFT_BUILD_AT: "2026-11-19T00:00:00Z",
        RAFT_RELEASE_BRANCH: "agent/notzz-preview",
      }),
      "1.21.54",
    ),
    "agent-notzz-preview-2a583382",
  );
  assert.equal(serviceVersionLabel(readBuildIdentityStatus({}), "1.21.54"), "1.21.54");
});

const PUSH_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

type SampleValue = { value: number; labels: Partial<Record<string, string | number>>; metricName?: string };

async function samples(name: string): Promise<SampleValue[]> {
  const metric = register.getSingleMetric(name);
  assert.ok(metric, `${name} is registered`);
  return (await metric.get()).values as SampleValue[];
}

async function bucketBounds(name: string, labels: Record<string, string>): Promise<number[]> {
  const values = await samples(name);
  return values
    .filter((v) => v.metricName === `${name}_bucket`
      && Object.entries(labels).every(([key, value]) => v.labels[key] === value))
    .map((v) => v.labels.le)
    .filter((le): le is number => typeof le === "number");
}

async function bucketCount(name: string, labels: Record<string, string>, le: number | "+Inf"): Promise<number> {
  const values = await samples(name);
  return values.find((v) => v.metricName === `${name}_bucket`
    && v.labels.le === le
    && Object.entries(labels).every(([key, value]) => v.labels[key] === value))?.value ?? 0;
}

test("push-latency histograms are registered with closed labels and the shared buckets", async () => {
  assert.deepEqual(PUSH_LATENCY_BUCKETS_SECONDS, PUSH_BUCKETS);
  const cases: Array<{ name: string; labels: Record<string, string>; observe: () => void }> = [
    { name: "slock_message_push_lag_seconds", labels: { receiver: "web" }, observe: () => messagePushLagSeconds.observe({ receiver: "web" }, 0) },
    { name: "slock_agent_delivery_queue_seconds", labels: { online_at_first_attempt: "true", delivery_kind: "plain" }, observe: () => agentDeliveryQueueSeconds.observe({ online_at_first_attempt: "true", delivery_kind: "plain" }, 0) },
    { name: "slock_agent_delivery_e2e_seconds", labels: { online_at_first_attempt: "true", delivery_kind: "plain" }, observe: () => agentDeliveryE2eSeconds.observe({ online_at_first_attempt: "true", delivery_kind: "plain" }, 0) },
    { name: "slock_agent_wake_start_seconds", labels: { outcome: "acked", human_start: "false" }, observe: () => agentWakeStartSeconds.observe({ outcome: "acked", human_start: "false" }, 0) },
  ];
  for (const { name, labels, observe } of cases) {
    observe();
    assert.deepEqual(await bucketBounds(name, labels), PUSH_BUCKETS, name);
    const values = await samples(name);
    // Registry default labels (app, service_version, deployment identity) are not the metric's own.
    const defaultLabels = new Set(["le", "app", "service_version", "service_instance_id", "deployment_instance_source", "deployment_identity_state", "ecs_task_id"]);
    const labelNames = new Set(values.flatMap((v) => Object.keys(v.labels)).filter((key) => !defaultLabels.has(key)));
    assert.deepEqual([...labelNames].sort(), Object.keys(labels).sort(), `${name} carries only its closed labels`);
  }
  const metrics = await register.metrics();
  assert.match(metrics, /# TYPE slock_socketio_resume_replayed_messages histogram/);
  assert.match(metrics, /# TYPE slock_socketio_resume_horizon_reset_total counter/);
  assert.match(metrics, /# TYPE slock_sync_changes_reset_total counter/);
});

test("secondsSince skips a missing or unparseable createdAt and clamps a future one to 0", () => {
  const now = Date.parse("2026-11-17T00:00:10.000Z");
  assert.equal(secondsSince(new Date("2026-11-17T00:00:07.500Z"), now), 2.5);
  assert.equal(secondsSince("2026-11-17T00:00:09.000Z", now), 1);
  assert.equal(secondsSince(now - 250, now), 0.25);
  assert.equal(secondsSince("2026-11-17T00:00:20.000Z", now), 0, "future createdAt (clock skew) clamps to 0");
  assert.equal(secondsSince(null, now), null);
  assert.equal(secondsSince(undefined, now), null);
  assert.equal(secondsSince("", now), null);
  assert.equal(secondsSince("not a date", now), null);
});

test("observeMessagePushLag records once per observer and never for a missing createdAt", async () => {
  const before = await bucketCount("slock_message_push_lag_seconds", { receiver: "web_push" }, "+Inf");
  const note = oncePushLagObserver("web_push", new Date(Date.now() - 3_000));
  note();
  note();
  note();
  oncePushLagObserver("web_push", null)();
  observeMessagePushLag("web_push", "garbage");
  const after = await bucketCount("slock_message_push_lag_seconds", { receiver: "web_push" }, "+Inf");
  assert.equal(after - before, 1);
  assert.ok(await bucketCount("slock_message_push_lag_seconds", { receiver: "web_push" }, 5) >= 1, "3 s lands in le=5");
});

test("observeMetricSafely swallows an observation error", () => {
  assert.doesNotThrow(() => observeMetricSafely(() => { throw new Error("boom"); }));
});

test("sync:resume replay helper records page and late counts and horizon resets", async () => {
  const resetBefore = (await syncResumeHorizonResetTotal.get()).values[0]?.value ?? 0;
  const pageBefore = await bucketCount("slock_socketio_resume_replayed_messages", { kind: "page" }, 10);
  const lateZeroBefore = await bucketCount("slock_socketio_resume_replayed_messages", { kind: "late" }, 0);
  observeSyncResumeReplay({ pageCount: 7, lateCount: 0, horizonReset: true });
  assert.equal((await syncResumeHorizonResetTotal.get()).values[0]?.value ?? 0, resetBefore + 1);
  assert.equal(await bucketCount("slock_socketio_resume_replayed_messages", { kind: "page" }, 10), pageBefore + 1);
  assert.equal(await bucketCount("slock_socketio_resume_replayed_messages", { kind: "late" }, 0), lateZeroBefore + 1);
  observeSyncResumeReplay({ pageCount: 0, lateCount: 3, horizonReset: false });
  assert.equal((await syncResumeHorizonResetTotal.get()).values[0]?.value ?? 0, resetBefore + 1, "no reset, no increment");
});
