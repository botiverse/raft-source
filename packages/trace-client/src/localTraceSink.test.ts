import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "./localTraceSink.js";

test("LocalRotatingTraceSink writes sanitized jsonl spans under machine traces dir", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.agent.delivery", {
      surface: "daemon",
      kind: "consumer",
      attrs: {
        agentId: "agent-raw",
        launchId: "launch-raw",
        machineId: "machine-raw",
        runtime: "codex",
        wake_message_present: true,
        content: "do not write content",
      },
    });

    span.addEvent("daemon.receive", {
      messageId: "message-raw",
      seq: 42,
      messages_count: 2,
      message: "do not write runtime error message",
      prompt: "do not write prompt",
    });
    span.end("ok");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.name, "daemon.agent.delivery");
    assert.equal(record.schema_version, 1);
    assert.equal(record.attrs.agentId, "agent-raw");
    assert.equal(record.attrs.launchId, "launch-raw");
    assert.equal(record.attrs.machineId, "machine-raw");
    assert.equal(record.attrs.runtime, "codex");
    assert.equal(record.attrs.wake_message_present, true);
    assert.equal(record.events[0].attrs.messageId, "message-raw");
    assert.equal(record.events[0].attrs.messages_count, 2);
    assert.equal(record.events[0].attrs.seq, 42);
    assert.equal(raw.includes("do not write"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink keeps diagnostic ids while dropping content and secrets", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-id-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.agent.start.queued", {
      surface: "daemon",
      attrs: {
        agentId: "agent-a",
        launchId: "launch-a",
        messageId: "message-a",
        machineId: "machine-a",
        apiKey: "secret-api-key",
        prompt: "secret prompt",
        stdout: "secret stdout",
      },
    });
    span.end("ok");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.agentId, "agent-a");
    assert.equal(record.attrs.launchId, "launch-a");
    assert.equal(record.attrs.messageId, "message-a");
    assert.equal(record.attrs.machineId, "machine-a");
    assert.equal(raw.includes("secret"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink keeps closed message kind attrs while dropping raw message fields", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-message-kind-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.connection.inbound_received", {
      surface: "daemon",
      attrs: {
        inbound_message_kind: "agent:start",
        message: "do not write raw message",
        message_content: "do not write raw content",
        last_inbound_age_ms_bucket: "0",
      },
    });
    span.end("ok");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.inbound_message_kind, "agent:start");
    assert.equal(record.attrs.last_inbound_age_ms_bucket, "0");
    assert.equal(Object.hasOwn(record.attrs, "message"), false);
    assert.equal(Object.hasOwn(record.attrs, "message_content"), false);
    assert.equal(raw.includes("do not write"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink drops sensitive presence and count summaries", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-sensitive-summary-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.agent.delivery.routed", {
      surface: "daemon",
      attrs: {
        token_present: true,
        secret_count: 2,
        password_present: true,
        api_key_count: 1,
        cookie_present: true,
        credential_count: 3,
        authToken_present: true,
        delivery_outcome: "queued",
        messages_count: 2,
      },
    });
    span.end("ok");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.delivery_outcome, "queued");
    assert.equal(record.attrs.messages_count, 2);
    assert.equal(Object.hasOwn(record.attrs, "token_present"), false);
    assert.equal(Object.hasOwn(record.attrs, "secret_count"), false);
    assert.equal(Object.hasOwn(record.attrs, "password_present"), false);
    assert.equal(Object.hasOwn(record.attrs, "api_key_count"), false);
    assert.equal(Object.hasOwn(record.attrs, "cookie_present"), false);
    assert.equal(Object.hasOwn(record.attrs, "credential_count"), false);
    assert.equal(Object.hasOwn(record.attrs, "authToken_present"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink keeps Claude custom provider policy attrs", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-claude-policy-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: {
        claude_custom_provider: true,
        claude_custom_provider_settings_sources_policy: "project,local",
        claude_custom_provider_inherited_provider_scrub: true,
        claude_custom_provider_host_managed_flag: false,
        claude_custom_provider_home_override: false,
        claude_custom_provider_config_dir_override: false,
        claude_custom_provider_inherited_env_scrub: true,
        claude_custom_provider_host_managed_env: false,
      },
    });
    span.addEvent("daemon.turn.started", {
      claude_custom_provider_settings_sources_policy: "project,local",
      claude_custom_provider_inherited_provider_scrub: true,
      claude_custom_provider_host_managed_flag: false,
    });
    span.end("ok");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.claude_custom_provider, true);
    assert.equal(record.attrs.claude_custom_provider_settings_sources_policy, "project,local");
    assert.equal(record.attrs.claude_custom_provider_inherited_provider_scrub, true);
    assert.equal(record.attrs.claude_custom_provider_host_managed_flag, false);
    assert.equal(record.attrs.claude_custom_provider_home_override, false);
    assert.equal(record.attrs.claude_custom_provider_config_dir_override, false);
    assert.equal(record.events[0].attrs.claude_custom_provider_settings_sources_policy, "project,local");
    assert.equal(record.events[0].attrs.claude_custom_provider_inherited_provider_scrub, true);
    assert.equal(record.events[0].attrs.claude_custom_provider_host_managed_flag, false);
    assert.equal(Object.hasOwn(record.attrs, "claude_custom_provider_inherited_env_scrub"), false);
    assert.equal(Object.hasOwn(record.attrs, "claude_custom_provider_host_managed_env"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink only keeps schema-owned diagnostic ids", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-id-allowlist-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.bundle.upload", {
      surface: "daemon",
      attrs: {
        serverId: "server-a",
        machineId: "machine-a",
        agentId: "agent-a",
        messageId: "message-a",
        launchId: "launch-a",
        uploadId: "upload-a",
        bundleId: "bundle-a",
        deliveryId: "delivery-a",
        delivery_correlation_id: "delivery-correlation-a",
        agent_id: "agent-snake-a",
        server_id: "server-snake-a",
        machine_id: "machine-snake-a",
        process_instance_id: "pi-uuid-a",
        launch_id: "launch-snake-a",
        correlation_id: "correlation-a",
        migration_attempt_id: "migration-attempt-a",
        operation_id: "operation-a",
        sessionId: "session-raw",
        sender_id: "sender-raw",
        externalToolId: "external-tool-raw",
      },
    });
    span.end("ok");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.serverId, "server-a");
    assert.equal(record.attrs.machineId, "machine-a");
    assert.equal(record.attrs.agentId, "agent-a");
    assert.equal(record.attrs.messageId, "message-a");
    assert.equal(record.attrs.launchId, "launch-a");
    assert.equal(record.attrs.uploadId, "upload-a");
    assert.equal(record.attrs.bundleId, "bundle-a");
    assert.equal(record.attrs.deliveryId, "delivery-a");
    assert.equal(record.attrs.delivery_correlation_id, "delivery-correlation-a");
    assert.equal(record.attrs.agent_id, "agent-snake-a");
    assert.equal(record.attrs.server_id, "server-snake-a");
    assert.equal(record.attrs.machine_id, "machine-snake-a");
    assert.equal(record.attrs.process_instance_id, "pi-uuid-a");
    assert.equal(record.attrs.launch_id, "launch-snake-a");
    assert.equal(record.attrs.correlation_id, "correlation-a");
    assert.equal(record.attrs.migration_attempt_id, "migration-attempt-a");
    assert.equal(record.attrs.operation_id, "operation-a");
    assert.equal(Object.hasOwn(record.attrs, "sessionId"), false);
    assert.equal(Object.hasOwn(record.attrs, "sender_id"), false);
    assert.equal(Object.hasOwn(record.attrs, "externalToolId"), false);
    assert.equal(raw.includes("session-raw"), false);
    assert.equal(raw.includes("sender-raw"), false);
    assert.equal(raw.includes("external-tool-raw"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink drops shell, path, and raw error fields while keeping structural summaries", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-privacy-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.agent.tool.executed", {
      surface: "daemon",
      attrs: {
        tool_kind: "bash",
        shell_kind: "bash",
        command: "cat /Users/alice/customer-secret.txt",
        argv: ["cat", "/Users/alice/customer-secret.txt"],
        env: { API_KEY: "secret" },
        cwd: "/Users/alice/customer-repo",
        path: "/Users/alice/customer-repo/file.txt",
        stdout: "customer stdout",
        stderr: "customer stderr",
        error: "command failed with /Users/alice/customer-secret.txt",
        errorMessage: "raw error message",
        rawPath: "/Users/alice/customer-repo",
        argv_count: 2,
        cwd_present: true,
        timeout_ms: 1000,
        exit_code: 1,
        stdout_bytes_bucket: "1k+",
        stderr_bytes_bucket: "1-100",
        output_truncated: true,
        error_class: "Error",
        error_message_present: true,
      },
    });
    span.addEvent("daemon.agent.tool.completed", {
      tool_input: "secret input",
      tool_output: "secret output",
      file_content: "secret file content",
      content_length_bucket: "100-1k",
      stdout_present: true,
    });
    span.end("error");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.tool_kind, "bash");
    assert.equal(record.attrs.shell_kind, "bash");
    assert.equal(record.attrs.argv_count, 2);
    assert.equal(record.attrs.cwd_present, true);
    assert.equal(record.attrs.timeout_ms, 1000);
    assert.equal(record.attrs.exit_code, 1);
    assert.equal(record.attrs.stdout_bytes_bucket, "1k+");
    assert.equal(record.attrs.stderr_bytes_bucket, "1-100");
    assert.equal(record.attrs.output_truncated, true);
    assert.equal(record.attrs.error_class, "Error");
    assert.equal(record.attrs.error_message_present, true);
    assert.equal(record.events[0].attrs.content_length_bucket, "100-1k");
    assert.equal(record.events[0].attrs.stdout_present, true);

    for (const forbidden of [
      "customer-secret",
      "customer-repo",
      "customer stdout",
      "customer stderr",
      "secret input",
      "secret output",
      "secret file content",
      "raw error message",
      "API_KEY",
    ]) {
      assert.equal(raw.includes(forbidden), false, `expected trace to drop ${forbidden}`);
    }
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink keeps bounded runtime error diagnostics while dropping raw error payloads", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-runtime-error-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: {
        outcome: "runtime-error",
        errorMessage: "raw provider error with /Users/alice/secret.txt",
        runtime_error_class: "ProviderModelNotFoundError",
        runtime_error_fingerprint: "0123456789abcdef",
        runtime_error_http_status: 404,
        runtime_error_message_present: true,
        runtime_error_message_length_bucket: "1k-4k",
        runtime_error_message_truncated: false,
      },
    });
    span.addEvent("runtime.error", {
      message: "raw runtime message",
      stderr: "raw stderr",
      runtime_error_class: "ProviderModelNotFoundError",
      runtime_error_fingerprint: "0123456789abcdef",
      runtime_error_message_excerpt: "ProviderModelNotFoundError: model opencode/gpt-5-nano was not found",
      runtime_error_message_truncated: false,
    });
    span.end("error");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.runtime_error_class, "ProviderModelNotFoundError");
    assert.equal(record.attrs.runtime_error_fingerprint, "0123456789abcdef");
    assert.equal(record.attrs.runtime_error_http_status, 404);
    assert.equal(record.attrs.runtime_error_message_present, true);
    assert.equal(record.attrs.runtime_error_message_length_bucket, "1k-4k");
    assert.equal(record.attrs.runtime_error_message_truncated, false);
    assert.equal(record.events[0].attrs.runtime_error_message_excerpt, "ProviderModelNotFoundError: model opencode/gpt-5-nano was not found");
    assert.equal(raw.includes("raw provider error"), false);
    assert.equal(raw.includes("raw runtime message"), false);
    assert.equal(raw.includes("raw stderr"), false);
    assert.equal(raw.includes("secret.txt"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink keeps sanitized transport original_message diagnostics", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-transport-error-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.transport.normalized_error", {
      surface: "daemon",
      attrs: {
        normalized_code: "transport_failure",
        route_family: "tasks/claim",
        response_started: false,
        upstream_layer: "tcp",
        original_message: "fetch failed http://127.0.0.1:9999/internal/agent-api/send?token=sk_agent_secret sap_secret",
      },
    });
    span.end("error");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.original_message, "fetch failed [url] sap_[redacted]");
    assert.equal(raw.includes("127.0.0.1"), false);
    assert.equal(raw.includes("sk_agent_secret"), false);
    assert.equal(raw.includes("sap_secret"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink omits absent transport optional diagnostics", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-transport-optional-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.transport.normalized_error", {
      surface: "daemon",
      attrs: {
        producer: "daemon",
        normalized_code: "transport_failure",
        route_family: "tasks",
        response_started: false,
        upstream_layer: "tcp",
        upstream_status: undefined,
        original_message: undefined,
      },
    });
    span.end("error");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(Object.hasOwn(record.attrs, "upstream_status"), false);
    assert.equal(Object.hasOwn(record.attrs, "original_message"), false);
    assert.equal(raw.includes("undefined"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink omits absent diagnostic ids instead of writing fake values", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-absent-id-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("daemon.agent.delivery", {
      surface: "daemon",
      attrs: {
        agentId: "agent-a",
        launchId: undefined,
        messageId: "",
        machineId: null,
      },
    });
    span.end("ok");

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(machineDir, "traces", files[0]), "utf8");
    const record = JSON.parse(raw.trim());

    assert.equal(record.attrs.agentId, "agent-a");
    assert.equal(Object.hasOwn(record.attrs, "launchId"), false);
    assert.equal(Object.hasOwn(record.attrs, "messageId"), false);
    assert.equal(Object.hasOwn(record.attrs, "machineId"), false);
    assert.equal(raw.includes("undefined"), false);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink rotates and prunes old files", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-rotate-test-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024, maxFiles: 2 });
    const tracer = new BasicTracer({ sink });

    for (let i = 0; i < 8; i += 1) {
      const span = tracer.startSpan("daemon.runtime.turn", {
        surface: "daemon",
        attrs: { runtime: "codex", seq: i, padding: "x".repeat(600) },
      });
      span.end("ok");
    }

    const files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 2);
    assert.ok(files.every((name) => name.startsWith("daemon-trace-") && name.endsWith(".jsonl")));
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink rotates on max file age when new spans arrive", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-age-test-"));
  try {
    let nowMs = Date.parse("2026-05-09T01:27:53.094Z");
    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFileAgeMs: 5 * 60 * 1000,
      maxFiles: 4,
      nowMsProvider: () => nowMs,
    });
    const tracer = new BasicTracer({ sink });

    const firstSpan = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: { runtime: "codex", seq: 1 },
    });
    firstSpan.end("ok");

    nowMs += 4 * 60 * 1000;
    const secondSpan = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: { runtime: "codex", seq: 2 },
    });
    secondSpan.end("ok");

    let files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1);

    nowMs += 60 * 1000;
    const thirdSpan = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: { runtime: "codex", seq: 3 },
    });
    thirdSpan.end("ok");

    files = (await readdir(path.join(machineDir, "traces"))).sort();
    assert.equal(files.length, 2);

    const firstFileLines = (await readFile(path.join(machineDir, "traces", files[0]), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const secondFileLines = (await readFile(path.join(machineDir, "traces", files[1]), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(
      firstFileLines.map((line) => line.attrs.seq),
      [1, 2],
    );
    assert.deepEqual(
      secondFileLines.map((line) => line.attrs.seq),
      [3],
    );
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("LocalRotatingTraceSink applies maxFileAgeJitterMs to extend effective rotation age", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "slock-daemon-local-trace-age-jitter-test-"));
  try {
    const baseAgeMs = 5 * 60 * 1000;
    const ageJitterMs = 30_000;
    let nowMs = Date.parse("2026-05-09T02:00:00.000Z");

    const sink = new LocalRotatingTraceSink({
      machineDir,
      maxFileBytes: 1024 * 1024,
      maxFileAgeMs: baseAgeMs,
      maxFileAgeJitterMs: ageJitterMs,
      maxFiles: 4,
      nowMsProvider: () => nowMs,
    });

    assert.equal(sink.getMaxFileAgeMs(), baseAgeMs + ageJitterMs);

    const tracer = new BasicTracer({ sink });

    // Write span 1
    const firstSpan = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: { runtime: "codex", seq: 1 },
    });
    firstSpan.end("ok");

    // Advance to just past base age (5min) but before effective age (5min30s)
    nowMs += baseAgeMs + 1_000; // 5:01 — would rotate without jitter
    const secondSpan = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: { runtime: "codex", seq: 2 },
    });
    secondSpan.end("ok");

    // Should still be 1 file because effective age = baseAgeMs + ageJitterMs
    let files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 1, "should NOT rotate before effective age (base + jitter)");

    // Now advance past effective age
    nowMs += ageJitterMs; // total elapsed = 5:31 from first span > 5:30 effective
    const thirdSpan = tracer.startSpan("daemon.runtime.turn", {
      surface: "daemon",
      attrs: { runtime: "codex", seq: 3 },
    });
    thirdSpan.end("ok");

    files = await readdir(path.join(machineDir, "traces"));
    assert.equal(files.length, 2, "should rotate after effective age (base + jitter)");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
