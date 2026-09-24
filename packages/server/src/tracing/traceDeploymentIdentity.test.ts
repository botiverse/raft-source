import assert from "node:assert/strict";
import { test } from "vitest";
import { traceSpanFactRowForSpan, type CompletedTraceSpan } from "@botiverse/raft-shared";
import {
  resolveTraceDeploymentIdentity,
  traceDeploymentResourceOptions,
} from "./traceDeploymentIdentity.js";

function metadataFetch(taskArn: string, family = "slock-prod", revision: string | number = "16"): typeof fetch {
  return (async () => new Response(JSON.stringify({
    TaskARN: taskArn,
    Family: family,
    Revision: revision,
    Credentials: { AccessKeyId: "must-not-leak" },
    Containers: [{ Networks: [{ IPv4Addresses: ["10.0.0.42"] }] }],
  }), { status: 200 })) as typeof fetch;
}

test("ECS deployment identity is stable per task and distinct across same-version rollouts", async () => {
  const firstArn = "arn:aws:ecs:us-east-1:123456789012:task/slock-prod/task-one";
  const secondArn = "arn:aws:ecs:us-east-1:123456789012:task/slock-prod/task-two";
  const env = { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/container" };

  const processIdFactory = () => "same-process";
  const first = await resolveTraceDeploymentIdentity(env, { fetchImpl: metadataFetch(firstArn), processIdFactory });
  const firstAgain = await resolveTraceDeploymentIdentity(env, { fetchImpl: metadataFetch(firstArn), processIdFactory });
  const second = await resolveTraceDeploymentIdentity(env, { fetchImpl: metadataFetch(secondArn), processIdFactory });

  assert.equal(first.serviceInstanceId, firstAgain.serviceInstanceId);
  assert.notEqual(first.serviceInstanceId, second.serviceInstanceId);
  assert.equal(first.deploymentInstanceSource, "aws_ecs_task");
  assert.equal(first.deploymentIdentityState, "resolved");
  assert.equal(first.ecsTaskFamily, "slock-prod");
  assert.equal(first.ecsTaskRevision, "16");
  assert.equal(first.ecsTaskId?.length, 32);

  const restarted = await resolveTraceDeploymentIdentity(env, {
    fetchImpl: metadataFetch(firstArn),
    processIdFactory: () => "restarted-process",
  });
  assert.equal(restarted.ecsTaskId, first.ecsTaskId);
  assert.notEqual(restarted.serviceInstanceId, first.serviceInstanceId);

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /123456789012|task-one|must-not-leak|10\.0\.0\.42/);
});

test("invalid or unavailable ECS metadata stays non-null and fail-visible", async () => {
  const identity = await resolveTraceDeploymentIdentity(
    { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/container" },
    {
      fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
      processIdFactory: () => "deterministic-process-id",
    },
  );

  assert.match(identity.serviceInstanceId, /^process:[0-9a-f]{32}$/);
  assert.equal(identity.deploymentInstanceSource, "generated_process");
  assert.equal(identity.deploymentIdentityState, "ecs_metadata_unavailable");
  assert.equal(identity.ecsTaskId, undefined);
  assert.equal(identity.ecsTaskFamily, undefined);
  assert.equal(identity.ecsTaskRevision, undefined);
});

test("ECS metadata lookup is bounded to the allowlisted task endpoint", async () => {
  let observedUrl = "";
  let observedSignal: AbortSignal | null = null;
  const identity = await resolveTraceDeploymentIdentity(
    { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/container/" },
    {
      fetchImpl: (async (input, init) => {
        observedUrl = String(input);
        observedSignal = init?.signal ?? null;
        return new Response(JSON.stringify({
          TaskARN: "arn:aws:ecs:us-east-1:123456789012:task/slock-prod/task-one",
          Family: "invalid family with spaces",
          Revision: "16",
        }), { status: 200 });
      }) as typeof fetch,
      timeoutMs: 25,
      processIdFactory: () => "fallback-process",
    },
  );

  assert.equal(observedUrl, "http://169.254.170.2/v4/container/task");
  assert.ok(observedSignal);
  assert.equal(identity.deploymentIdentityState, "ecs_metadata_unavailable");
  assert.equal(identity.deploymentInstanceSource, "generated_process");
});

test("Fly and local fallback identities are non-null without claiming ECS metadata", async () => {
  const fly = await resolveTraceDeploymentIdentity(
    { FLY_MACHINE_ID: "fly-machine-private-id" },
    { processIdFactory: () => "fly-process" },
  );
  const local = await resolveTraceDeploymentIdentity({}, { processIdFactory: () => "local-process" });

  assert.match(fly.serviceInstanceId, /^fly:[0-9a-f]{32}$/);
  assert.equal(fly.deploymentInstanceSource, "fly_machine");
  assert.equal(fly.deploymentIdentityState, "resolved");
  assert.match(local.serviceInstanceId, /^process:[0-9a-f]{32}$/);
  assert.equal(local.deploymentInstanceSource, "generated_process");
  assert.equal(local.deploymentIdentityState, "non_ecs");
});

test("one deployment identity maps to the shared Sink A and Sink B resource options", () => {
  const resource = traceDeploymentResourceOptions({
    serviceInstanceId: "ecs:opaque-process",
    deploymentInstanceSource: "aws_ecs_task",
    deploymentIdentityState: "resolved",
    ecsTaskId: "opaque-task",
    ecsTaskFamily: "slock-prod",
    ecsTaskRevision: "16",
  });

  assert.deepEqual(resource, {
    serviceInstanceId: "ecs:opaque-process",
    deploymentInstanceSource: "aws_ecs_task",
    deploymentIdentityState: "resolved",
    ecsTaskId: "opaque-task",
    ecsTaskFamily: "slock-prod",
    ecsTaskRevision: "16",
  });
});

test("same-version same-SHA rollouts split into typed task groups with first and last spans", async () => {
  const commonResource = {
    serviceName: "slock-server",
    deploymentEnvironment: "production",
    serviceVersion: "0.43.0",
    serviceRevision: "916ad3e3",
  };
  const firstIdentity = await resolveTraceDeploymentIdentity(
    { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/container" },
    {
      fetchImpl: metadataFetch("arn:aws:ecs:us-east-1:123456789012:task/slock-prod/task-one", "slock-prod", "15"),
      processIdFactory: () => "first-process",
    },
  );
  const secondIdentity = await resolveTraceDeploymentIdentity(
    { ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/container" },
    {
      fetchImpl: metadataFetch("arn:aws:ecs:us-east-1:123456789012:task/slock-prod/task-two", "slock-prod", "16"),
      processIdFactory: () => "second-process",
    },
  );
  const rows = [
    traceSpanFactRowForSpan(completedSpan("1", 100, 110), {
      ...commonResource,
      ...traceDeploymentResourceOptions(firstIdentity),
    }),
    traceSpanFactRowForSpan(completedSpan("2", 120, 130), {
      ...commonResource,
      ...traceDeploymentResourceOptions(firstIdentity),
    }),
    traceSpanFactRowForSpan(completedSpan("3", 125, 135), {
      ...commonResource,
      ...traceDeploymentResourceOptions(secondIdentity),
    }),
    traceSpanFactRowForSpan(completedSpan("4", 140, 150), {
      ...commonResource,
      ...traceDeploymentResourceOptions(secondIdentity),
    }),
  ];
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    assert.ok(row.ecs_task_id);
    const times = groups.get(row.ecs_task_id) ?? [];
    times.push(row.span_start_time_ms);
    groups.set(row.ecs_task_id, times);
  }

  assert.equal(groups.size, 2);
  assert.deepEqual(
    [...groups.values()].map((times) => [Math.min(...times), Math.max(...times)]).sort((a, b) => a[0]! - b[0]!),
    [[100, 120], [125, 140]],
  );
  assert.deepEqual(new Set(rows.map((row) => row.service_version)), new Set(["0.43.0"]));
  assert.deepEqual(new Set(rows.map((row) => row.service_revision)), new Set(["916ad3e3"]));
  assert.deepEqual(new Set(rows.map((row) => row.ecs_task_revision)), new Set(["15", "16"]));
});

function completedSpan(suffix: string, startTimeMs: number, endTimeMs: number): CompletedTraceSpan {
  return {
    context: {
      traceId: suffix.repeat(32),
      spanId: suffix.repeat(16),
      parentSpanId: null,
      traceFlags: "01",
    },
    name: "server.http.request",
    surface: "server",
    kind: "server",
    status: "ok",
    startTimeMs,
    endTimeMs,
    durationMs: endTimeMs - startTimeMs,
    events: [],
  };
}
