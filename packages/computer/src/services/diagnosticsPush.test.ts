// Byte-pin tests for the DiagnosticsPushService (V0 Sync diagnostics).
//
// task #102 (#wg-raft-computer:a87e1bdb) fixed the shipped b2 defect: the
// marker was named `diagnostics-marker-*` and written into dirs whose uploader
// either didn't exist (computerDir) or globbed only `daemon-trace-*` — so it
// NEVER uploaded and every shipped correlationId was a dead id. The fix:
//   - upload-bearing marker → `daemon-trace-diag-<id>.jsonl` (matches the
//     daemon uploader glob) into each RUNNING runner's machineDir/traces;
//   - fail-closed `NO_RUNNER` when zero running runners (no upload path) —
//     never a `queued` id that can't be looked up;
//   - computerDir marker kept as a LOCAL-ONLY breadcrumb (no uploader there).
//
// Several tests below are red-green guards (would FAIL on the pre-fix code):
//   - "upload marker filename matches the daemon-trace- glob" (old name failed)
//   - "attachment present but NOT running → NO_RUNNER" (old returned queued)
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { diagnosticsPush } from "./diagnosticsPush";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES, PEM_PRIVATE_KEY_BEGIN } from "../../../shared/src/test/diagnosticRedactionCredentialSamples";
import { getDaemonMachineLockId } from "../../../daemon/src/machineLock";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "raft-computer-diag-svc-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function seedUserSession(home: string): Promise<void> {
  const computerDir = path.join(home, "computer");
  await mkdir(computerDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(computerDir, "user-session.json"),
    JSON.stringify({ kind: "user-session", userId: "user-1", accessToken: "ACCESS_TOKEN_VALUE" }),
    { mode: 0o600 },
  );
}

async function seedAttachment(home: string, serverId: string, apiKey: string, serverUrl = "http://localhost:9999"): Promise<void> {
  const serverDir = path.join(home, "computer", "servers", serverId);
  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(serverDir, "runner.state.json"),
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      apiKey,
      serverUrl,
      serverMachineId: "smid-" + serverId,
    }),
    { mode: 0o600 },
  );
}

/** Attachment + a live runner pidfile (our own pid) so the running-runner gate
 *  treats it as a runner whose uploader is alive. */
async function seedRunningRunner(home: string, serverId: string, apiKey: string, serverUrl?: string): Promise<void> {
  await seedAttachment(home, serverId, apiKey, serverUrl);
  await writeFile(
    path.join(home, "computer", "servers", serverId, "runner.pid"),
    String(process.pid),
    { mode: 0o600 },
  );
}

async function seedLegacyRunningRunner(home: string, serverId: string, apiKey: string): Promise<void> {
  await seedAttachment(home, serverId, apiKey);
  await writeFile(
    path.join(home, "computer", "servers", serverId, "server-runner.pid"),
    String(process.pid),
    { mode: 0o600 },
  );
}

test("diagnosticsPush: happy path — 1 running runner → queued, upload marker in runner machineDir/traces", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_abc123def456");

    const events: { kind: string; line?: string; correlationId?: string }[] = [];
    const r = await diagnosticsPush(
      { slockHome: home },
      { onEvent: (e) => events.push(e as never) },
    );

    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    assert.match(r.correlationId, /^[0-9a-f-]{36}$/i, "correlationId must be a uuid");
    assert.equal(r.expectedWindowSec, 300);
    assert.equal(r.markerPaths.length, 1, "one upload-bearing marker per running runner");

    const markerPath = r.markerPaths[0];
    const content = await readFile(markerPath, "utf8");
    assert.match(content, /^\{"type":"span",/);
    assert.match(content, new RegExp(`"diagnostics_correlation_id":"${r.correlationId}"`));

    // typed step + prose fallback both fire.
    const typedQueued = events.find((e) => e.kind === "diagnosticsPush.queued");
    assert.ok(typedQueued, "diagnosticsPush.queued typed step should fire");
    assert.equal(typedQueued!.correlationId, r.correlationId);
    const logLine = events.find((e) => e.kind === "log.line");
    assert.ok(logLine && /Correlation id [0-9a-f-]{36}/i.test(logLine.line!));
  });
});

test("diagnosticsPush: upload marker carries scrubbed bounded runner.log tail with truncation metadata", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const serverId = randomUUID();
    const secret = "sk_computer_runner_log_secret";
    await seedRunningRunner(home, serverId, secret);
    const serverDir = path.join(home, "computer", "servers", serverId);
    const logLines = Array.from({ length: 130 }, (_, index) => {
      if (index === 0) return `old line with ${secret}`;
      if (index === 126) return "path line /Users/richard/.slock/computer/servers/local/server-runner.log and /home/alice/.slock/token";
      if (index === 127) return "windows path C:\\Users\\Alice\\AppData\\Roaming\\Raft\\runner.log";
      if (index === 128) return "url line https://raft.example.test/callback?token=query-secret&email=person@example.com";
      if (index === 129) return `latest line with Bearer ${"a".repeat(32)} and sk-ant-${"b".repeat(16)} and test.person@example.com`;
      return `line-${String(index).padStart(3, "0")}`;
    });
    await writeFile(path.join(serverDir, "runner.log"), `${logLines.join("\n")}\n`, { mode: 0o600 });

    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;

    const markerText = await readFile(r.markerPaths[0], "utf8");
    const records = markerText.trim().split("\n").map((line) => JSON.parse(line));
    const tail = records.find((record) => record.name === "diagnostics.runner_log_tail");
    assert.ok(tail, "upload-bearing marker must include a runner.log tail record");
    assert.equal(tail.attrs.diagnostics_consent_surface, "diagnostics_push");
    assert.equal(tail.attrs.server_id, serverId);
    assert.equal(tail.attrs.log_path_kind, "runner.log");
    assert.equal(tail.attrs.source_line_count, 130);
    assert.equal(tail.attrs.lines_count, 120);
    assert.equal(tail.attrs.max_lines, 120);
    assert.equal(tail.attrs.tail_truncated, true);
    assert.equal(tail.events.length, 120);
    assert.match(tail.events[0].attrs.text, /line-010/);
    const tailText = tail.events.map((event: { attrs: { text: string } }) => event.attrs.text).join("\n");
    assert.doesNotMatch(tailText, /old line with/);
    assert.doesNotMatch(tailText, new RegExp(secret));
    assert.doesNotMatch(tailText, /Bearer a{32}/);
    assert.doesNotMatch(tailText, /sk-ant-b{16}/);
    assert.doesNotMatch(tailText, /test\.person@example\.com/);
    assert.doesNotMatch(tailText, /person@example\.com/);
    assert.doesNotMatch(tailText, /\/Users\/richard/);
    assert.doesNotMatch(tailText, /\/home\/alice/);
    assert.doesNotMatch(tailText, /C:\\Users\\Alice/);
    assert.doesNotMatch(tailText, /query-secret/);
    assert.match(tailText, /\*\*\*REDACTED\*\*\*/);
    assert.match(tailText, /\[REDACTED_QUERY\]/);
  });
});

test("diagnosticsPush: writes one upload-bearing marker into EACH running runner (multi-runner redundancy)", async () => {
  // The marker is written into every running runner's machineDir/traces so the
  // upload doesn't depend on which runner's uploader cycles first; the
  // server/ScopeDB dedups by correlationId. (Yingjun note, #wg-raft-computer:a87e1bdb.)
  await withHome(async (home) => {
    await seedUserSession(home);
    const idA = randomUUID();
    const idB = randomUUID();
    await seedRunningRunner(home, idA, "sk_computer_runner_a");
    await seedRunningRunner(home, idB, "sk_computer_runner_b");
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    assert.equal(r.markerPaths.length, 2, "one marker per running runner");
    // Both under distinct machine dirs, both carrying the same correlationId.
    const lockA = getDaemonMachineLockId("sk_computer_runner_a");
    const lockB = getDaemonMachineLockId("sk_computer_runner_b");
    assert.ok(r.markerPaths.some((p) => p.includes(lockA)), "marker for runner A's machineDir");
    assert.ok(r.markerPaths.some((p) => p.includes(lockB)), "marker for runner B's machineDir");
    for (const p of r.markerPaths) {
      assert.match(await readFile(p, "utf8"), new RegExp(`"diagnostics_correlation_id":"${r.correlationId}"`));
    }
  });
});

test("diagnosticsPush: RED-GREEN — upload marker filename matches the daemon uploader glob (daemon-trace-*)", async () => {
  // Without the task #102 fix the marker was `diagnostics-marker-*`, which the
  // daemon uploader's `startsWith("daemon-trace-")` glob NEVER matched → this
  // assertion fails on the pre-fix code. It pins that the upload-bearing marker
  // actually qualifies as an upload candidate.
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_glob_test");
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    const base = path.basename(r.markerPaths[0]);
    assert.ok(
      base.startsWith("daemon-trace-") && base.endsWith(".jsonl"),
      `upload marker must match the daemon-trace-*.jsonl uploader glob; got "${base}"`,
    );
  });
});

test("diagnosticsPush: RED-GREEN — attachment present but NOT running → NO_RUNNER (not queued)", async () => {
  // Pre-fix this returned `queued` with a dead correlationId (no uploader to
  // carry it). The fix fails-closed: no running runner = no upload path.
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedAttachment(home, randomUUID(), "sk_computer_not_running"); // attached, NOT running
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "failed");
    if (r.status !== "failed") return;
    assert.equal(r.reason, "NO_RUNNER");
  });
});

test("diagnosticsPush: NO_RUNNER writes a local redacted bundle for manual handoff", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const serverId = randomUUID();
    const secret = "sk_computer_not_running_secret";
    await seedAttachment(home, serverId, secret);
    const serverDir = path.join(home, "computer", "servers", serverId);
    await writeFile(path.join(home, "computer", "run", "service.log"), `service token ${secret}\n`, { mode: 0o600 })
      .catch(async (err) => {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
        await mkdir(path.join(home, "computer", "run"), { recursive: true, mode: 0o700 });
        await writeFile(path.join(home, "computer", "run", "service.log"), `service token ${secret}\n`, { mode: 0o600 });
      });
    await writeFile(path.join(serverDir, "runner.log"), `runner token ${secret}\n`, { mode: 0o600 });

    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "failed");
    if (r.status !== "failed") return;
    assert.equal(r.reason, "NO_RUNNER");
    assert.ok(r.localBundle, "NO_RUNNER should still produce local evidence");
    const info = await stat(r.localBundle!.path);
    assert.equal(info.mode & 0o777, 0o600);
    const text = await readFile(r.localBundle!.path, "utf8");
    assert.match(text, /raft-computer-local-diagnostics/);
    assert.match(text, /NO_RUNNER/);
    assert.match(text, /service token \*\*\*REDACTED\*\*\*/);
    assert.match(text, /runner token \*\*\*REDACTED\*\*\*/);
    assert.doesNotMatch(text, new RegExp(secret));
  });
});

test("diagnosticsPush: legacy server-runner.pid counts as running during version-split window", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedLegacyRunningRunner(home, randomUUID(), "sk_computer_legacy_runner");
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    assert.equal(r.markerPaths.length, 1);
  });
});

test("diagnosticsPush: NO_RUNNER when user session present but zero attachments/runners", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "failed");
    if (r.status !== "failed") return;
    assert.equal(r.reason, "NO_RUNNER");
  });
});

test("diagnosticsPush: UPLOAD_DISABLED when RAFT_COMPUTER_LOCAL_TRACE=0", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_abc");
    const prev = process.env.RAFT_COMPUTER_LOCAL_TRACE;
    process.env.RAFT_COMPUTER_LOCAL_TRACE = "0";
    try {
      const r = await diagnosticsPush({ slockHome: home });
      assert.equal(r.status, "failed");
      if (r.status !== "failed") return;
      assert.equal(r.reason, "UPLOAD_DISABLED");
    } finally {
      if (prev === undefined) delete process.env.RAFT_COMPUTER_LOCAL_TRACE;
      else process.env.RAFT_COMPUTER_LOCAL_TRACE = prev;
    }
  });
});

test("diagnosticsPush: UPLOAD_DISABLED under RAFT_PRIVACY_MODE, no marker and no forced upload", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_abc");
    const prev = process.env.RAFT_PRIVACY_MODE;
    process.env.RAFT_PRIVACY_MODE = "on";
    let calls = 0;
    try {
      const r = await diagnosticsPush({ slockHome: home }, {
        forceUploadNow: true,
        fetchImpl: async () => { calls += 1; return new Response("{}"); },
      });
      assert.equal(r.status, "failed");
      if (r.status !== "failed") return;
      assert.equal(r.reason, "UPLOAD_DISABLED");
      assert.equal(calls, 0);
    } finally {
      if (prev === undefined) delete process.env.RAFT_PRIVACY_MODE;
      else process.env.RAFT_PRIVACY_MODE = prev;
    }
  });
});

test("diagnosticsPush: an invalid RAFT_PRIVACY_MODE is a result (UPLOAD_DISABLED), never a throw", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_abc");
    const prev = process.env.RAFT_PRIVACY_MODE;
    process.env.RAFT_PRIVACY_MODE = "sometimes";
    try {
      const r = await diagnosticsPush({ slockHome: home });
      assert.equal(r.status, "failed");
      if (r.status !== "failed") return;
      assert.equal(r.reason, "UPLOAD_DISABLED");
    } finally {
      if (prev === undefined) delete process.env.RAFT_PRIVACY_MODE;
      else process.env.RAFT_PRIVACY_MODE = prev;
    }
  });
});

/** A forced upload with the receiver chosen by the daemon's rule (no workerUrl override, no env URL). */
async function forcedUploadUrls(serverUrl: string): Promise<{ result: Awaited<ReturnType<typeof diagnosticsPush>>; urls: string[] }> {
  const saved = { url: process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL, disabled: process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED };
  delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
  delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED;
  try {
    return await withHome(async (home) => {
      await seedUserSession(home);
      await seedRunningRunner(home, randomUUID(), "sk_computer_receiver", serverUrl);
      const urls: string[] = [];
      const result = await diagnosticsPush({ slockHome: home }, {
        forceUploadNow: true,
        privacyMode: false,
        fetchImpl: async (input) => {
          urls.push(String(input));
          if (String(input).endsWith("/scope-attestation")) return Response.json({ attestation: "att" });
          return new Response("unavailable", { status: 503 });
        },
      });
      return { result, urls };
    });
  } finally {
    if (saved.url === undefined) delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL;
    else process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL = saved.url;
    if (saved.disabled === undefined) delete process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED;
    else process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED = saved.disabled;
  }
}

test("diagnosticsPush: a forced upload for a self-hosted server's attachment uploads nowhere by default", async () => {
  const { result, urls } = await forcedUploadUrls("https://raft.example.org");
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.reason, "UPLOAD_DISABLED");
  assert.deepEqual(urls, []);
});

test("diagnosticsPush: a forced upload for a Raft server's attachment still goes to Raft's receiver", async () => {
  const { urls } = await forcedUploadUrls("https://api.raft.build");
  // Attestation from the attachment's own server, then Raft's receiver (its 503 ends it).
  assert.deepEqual(urls, [
    "https://api.raft.build/internal/machine/scope-attestation",
    "https://slock-trace-upload.botiverse.dev/api/trace-bundles",
  ]);
});

test("diagnosticsPush: OFFLINE when no user session AND no attachments", async () => {
  await withHome(async (home) => {
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "failed");
    if (r.status !== "failed") return;
    assert.equal(r.reason, "OFFLINE");
  });
});

test("diagnosticsPush: daemon machineDir derivation matches getDaemonMachineLockId byte-for-byte", async () => {
  // Cross-package contract pin: the lib duplicates the
  // `machine-<sha256(apiKey).slice(0,16)>` derivation to avoid importing the
  // daemon; this asserts byte-equality against the daemon's helper so drift in
  // the lockId scheme (which would break upload routing) fails before review.
  await withHome(async (home) => {
    await seedUserSession(home);
    const apiKey = "sk_computer_FIXTURE_KEY_FOR_DERIVATION_TEST";
    await seedRunningRunner(home, randomUUID(), apiKey);

    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;

    const daemonLockId = getDaemonMachineLockId(apiKey);
    const expectedDaemonDir = path.join(home, "machines", daemonLockId, "traces");
    assert.ok(
      r.markerPaths.some((p) => p.startsWith(expectedDaemonDir)),
      `marker must land under ${expectedDaemonDir}; got: ${r.markerPaths.join(", ")}`,
    );
    const expectedFp = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
    assert.equal(daemonLockId, `machine-${expectedFp}`);
  });
});

test("diagnosticsPush: marker span schema (type=span, schema_version=1, name=diagnostics.push)", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_schema");
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    const parsed = JSON.parse((await readFile(r.markerPaths[0], "utf8")).trim());
    assert.equal(parsed.type, "span");
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.name, "diagnostics.push");
    assert.equal(parsed.surface, "daemon");
    assert.equal(parsed.kind, "internal");
    assert.equal(parsed.attrs.diagnostics_trigger, "user_action");
    assert.equal(parsed.attrs.diagnostics_correlation_id, r.correlationId);
  });
});

test("diagnosticsPush: computerDir breadcrumb is written but NOT counted as an upload marker", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_breadcrumb");
    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    // markerPaths holds only the upload-bearing per-runner marker(s).
    assert.ok(r.markerPaths.every((p) => !p.includes(path.join("computer", "traces"))),
      "computerDir breadcrumb must not be in markerPaths (it has no uploader)");
    // But the local breadcrumb file does exist for inspection.
    const computerTraces = path.join(home, "computer", "traces");
    const files = await readdir(computerTraces).catch(() => [] as string[]);
    assert.ok(
      files.some((f) => f.startsWith("diagnostics-marker-") && f.includes(r.correlationId)),
      "local computerDir breadcrumb should exist",
    );
  });
});

test("diagnosticsPush: forced upload includes sanitized Computer migration spans with attempt id", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    await seedRunningRunner(home, randomUUID(), "sk_computer_force_upload");
    const computerTraceDir = path.join(home, "computer", "traces");
    await mkdir(computerTraceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(computerTraceDir, "daemon-trace-computer-migration.jsonl"),
      `${JSON.stringify({
        type: "span",
        schema_version: 1,
        trace_id: "1".repeat(32),
        span_id: "2".repeat(16),
        parent_span_id: null,
        name: "computer.migration.decision",
        surface: "computer",
        kind: "internal",
        status: "ok",
        start_time: "2026-07-01T00:00:00.000Z",
        end_time: "2026-07-01T00:00:00.001Z",
        duration_ms: 1,
        attrs: {
          migration_attempt_id: "attempt-force-1",
          decision: "adopt",
          reason: "migrate-from",
        },
        events: [],
      })}\n`,
      { mode: 0o600 },
    );

    let uploadedText = "";
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/internal/machine/scope-attestation")) {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer sk_computer_force_upload");
        return new Response(JSON.stringify({ attestation: "signed-attestation" }), { status: 200 });
      }
      if (input.endsWith("/api/trace-bundles")) {
        return new Response(JSON.stringify({
          upload: {
            method: "PUT",
            url: "http://upload.local/object",
            headers: { "x-upload": "1" },
          },
        }), { status: 200 });
      }
      if (input === "http://upload.local/object") {
        const body = init?.body;
        assert.ok(body instanceof Blob);
        uploadedText = gunzipSync(Buffer.from(await body.arrayBuffer())).toString("utf8");
        return new Response("", { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const r = await diagnosticsPush(
      { slockHome: home },
      {
        forceUploadNow: true,
        includeComputerTraceRecords: true,
        migrationAttemptId: "attempt-force-1",
        correlationId: "00000000-0000-4000-8000-000000000001",
        trigger: "migration",
        workerUrl: "http://worker.local",
        fetchImpl,
      },
    );

    assert.equal(r.status, "queued", JSON.stringify(r));
    if (r.status !== "queued") return;
    assert.deepEqual(r.uploadResults?.map((u) => u.status), ["uploaded"]);
    assert.match(uploadedText, /"name":"diagnostics.push"/);
    assert.match(uploadedText, /"diagnostics_upload_forced":true/);
    assert.match(uploadedText, /"diagnostics_trigger":"migration"/);
    assert.match(uploadedText, /"name":"computer.migration.decision"/);
    assert.match(uploadedText, /"migration_attempt_id":"attempt-force-1"/);
    assert.equal(uploadedText.includes("sk_computer_force_upload"), false);
    assert.equal(uploadedText.includes("ACCESS_TOKEN_VALUE"), false);
    assert.equal(uploadedText.includes("owner.json"), false);
  });
});


test("diagnosticsPush: uploaded bundle masks every known credential sample (task263)", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const serverId = randomUUID();
    const apiKey = "sk_computer_cred_sample_upload";
    await seedRunningRunner(home, serverId, apiKey);
    const serverDir = path.join(home, "computer", "servers", serverId);
    // One sample per line: the tail redactor is line-oriented, so each sample
    // must survive on its own line exactly as a real log would carry it.
    // Newlines are preserved deliberately. Flattening them would test a
    // single-line PEM variant and hide that multi-line rules never fire on a
    // line-oriented path (archer's review catch, task #263).
    const logText = `${DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES
      .map((entry) => entry.sample)
      .join("\n")}\n`;
    await writeFile(path.join(serverDir, "runner.log"), logText, { mode: 0o600 });

    let uploadedText = "";
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/internal/machine/scope-attestation")) {
        return new Response(JSON.stringify({ attestation: "signed-attestation" }), { status: 200 });
      }
      if (input.endsWith("/api/trace-bundles")) {
        return new Response(JSON.stringify({
          upload: { method: "PUT", url: "http://upload.local/object", headers: {} },
        }), { status: 200 });
      }
      if (input === "http://upload.local/object") {
        const body = init?.body;
        assert.ok(body instanceof Blob);
        uploadedText = gunzipSync(Buffer.from(await body.arrayBuffer())).toString("utf8");
        return new Response("", { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };

    const r = await diagnosticsPush(
      { slockHome: home },
      {
        forceUploadNow: true,
        correlationId: "00000000-0000-4000-8000-0000000002 63".replace(" ", ""),
        workerUrl: "http://worker.local",
        fetchImpl,
      },
    );
    assert.equal(r.status, "queued", JSON.stringify(r));
    assert.ok(uploadedText.length > 0, "upload body must have been captured");

    const leaked = DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES
      .filter((entry) => uploadedText.includes(entry.mustNotContain))
      .map((entry) => entry.label);
    assert.deepEqual(leaked, [], `credential samples present in uploaded bundle: ${leaked.join(", ")}`);

    // The marker is a Raft-owned on-disk artifact, so it must be clean before
    // it is written, not merely before it is uploaded (XX's write-before rule).
    const onDisk = await readFile(r.markerPaths[0], "utf8");
    const leakedOnDisk = DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES
      .filter((entry) => onDisk.includes(entry.mustNotContain))
      .map((entry) => entry.label);
    assert.deepEqual(leakedOnDisk, [], `credential samples present in on-disk marker: ${leakedOnDisk.join(", ")}`);
  });
});


test("diagnosticsPush: identity and URL handling is unchanged by the shared-redaction swap (task263 invariant)", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const serverId = randomUUID();
    await seedRunningRunner(home, serverId, "sk_computer_invariant_probe");
    const serverDir = path.join(home, "computer", "servers", serverId);
    await writeFile(
      path.join(serverDir, "runner.log"),
      [
        "url line https://raft.example.test/callback?token=query-secret&x=1",
        "mail line ops.person@example.com reported it",
        "posix path /Users/richard/.slock/computer/servers/local/server-runner.log",
        "linux path /home/alice/.slock/token",
        "windows path C:\\Users\\Alice\\AppData\\Roaming\\Raft\\runner.log",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    const markerText = await readFile(r.markerPaths[0], "utf8");
    const tail = markerText.trim().split("\n").map((line) => JSON.parse(line))
      .find((record) => record.name === "diagnostics.runner_log_tail");
    assert.ok(tail, "marker must carry the runner.log tail");
    const tailText = tail.events.map((e: { attrs: { text: string } }) => e.attrs.text).join("\n");

    // Secrets and identities must be gone...
    assert.doesNotMatch(tailText, /query-secret/);
    assert.doesNotMatch(tailText, /ops\.person@example\.com/);
    assert.doesNotMatch(tailText, /\/Users\/richard/);
    assert.doesNotMatch(tailText, /\/home\/alice/);
    assert.doesNotMatch(tailText, /C:\\Users\\Alice/);

    // ...but the URL host+path must SURVIVE. This is the invariant the swap
    // could silently break: shared defaults to urls:"query" (mask the query,
    // keep host+path); passing urls:"drop" would replace the whole URL with
    // "[url]" and destroy the diagnostic value this path exists to carry.
    assert.match(tailText, /raft\.example\.test\/callback/);
    assert.doesNotMatch(tailText, /\[url\]/);
  });
});


test("diagnosticsPush: PEM block straddling the tail window is masked (task263 boundary)", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const serverId = randomUUID();
    await seedRunningRunner(home, serverId, "sk_computer_pem_boundary");
    const serverDir = path.join(home, "computer", "servers", serverId);
    const keyBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    // 121 lines: the 120-line tail window starts at index 1, so BEGIN (index 0)
    // falls OUTSIDE the window while the key body and END fall inside. Redacting
    // after the cut would leave the body with no BEGIN to anchor the rule.
    const logLines = [
      // Built at runtime so secret scanners don't flag this test sample.
      PEM_PRIVATE_KEY_BEGIN,
      keyBody,
      "-----END PRIVATE KEY-----",
      ...Array.from({ length: 118 }, (_, i) => `filler-${String(i).padStart(3, "0")}`),
    ];
    assert.equal(logLines.length, 121);
    await writeFile(path.join(serverDir, "runner.log"), `${logLines.join("\n")}\n`, { mode: 0o600 });

    const r = await diagnosticsPush({ slockHome: home });
    assert.equal(r.status, "queued");
    if (r.status !== "queued") return;
    const markerText = await readFile(r.markerPaths[0], "utf8");
    assert.equal(markerText.includes(keyBody), false, "PEM body must not reach the marker");

    const tail = markerText.trim().split("\n").map((line) => JSON.parse(line))
      .find((record) => record.name === "diagnostics.runner_log_tail");
    assert.ok(tail);
    // sourceLineCount stays a property of the source file, not of the redacted text.
    assert.equal(tail.attrs.source_line_count, 121);
  });
});


// XX (task #263): the acceptance surface of this card is the REAL upload artifact.
// The shared unit tests prove the RULE; these prove the PATH. Both layers need
// teeth, because a correct rule can still be bypassed by how the caller slices
// the text before handing it over.
async function uploadRunnerLog(home: string, serverId: string, logText: string): Promise<{
  uploadedText: string;
  markerText: string;
}> {
  const serverDir = path.join(home, "computer", "servers", serverId);
  await writeFile(path.join(serverDir, "runner.log"), logText, { mode: 0o600 });

  let uploadedText = "";
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/internal/machine/scope-attestation")) {
      return new Response(JSON.stringify({ attestation: "signed-attestation" }), { status: 200 });
    }
    if (input.endsWith("/api/trace-bundles")) {
      return new Response(JSON.stringify({
        upload: { method: "PUT", url: "http://upload.local/object", headers: {} },
      }), { status: 200 });
    }
    if (input === "http://upload.local/object") {
      const body = init?.body;
      assert.ok(body instanceof Blob);
      uploadedText = gunzipSync(Buffer.from(await body.arrayBuffer())).toString("utf8");
      return new Response("", { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  };

  const r = await diagnosticsPush(
    { slockHome: home },
    { forceUploadNow: true, correlationId: randomUUID(), workerUrl: "http://worker.local", fetchImpl },
  );
  assert.equal(r.status, "queued", JSON.stringify(r));
  if (r.status !== "queued") throw new Error("unreachable");
  assert.ok(uploadedText.length > 0, "upload body must have been captured");
  return { uploadedText, markerText: await readFile(r.markerPaths[0], "utf8") };
}

test("diagnosticsPush: orphan BEGIN marker is masked in the uploaded body (task263 orphan-begin)", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const serverId = randomUUID();
    await seedRunningRunner(home, serverId, "sk_computer_orphan_begin");
    const keyBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    // archer's reproduction (msg=47ded091): the END line is absent because the
    // process is still WRITING the block. Needs no bounded read to occur, so a
    // paired BEGIN..END rule alone leaves the body in the clear.
    const logText = [
      "runner started",
      PEM_PRIVATE_KEY_BEGIN,
      keyBody,
    ].join("\n") + "\n";

    const { uploadedText, markerText } = await uploadRunnerLog(home, serverId, logText);
    assert.equal(uploadedText.includes(keyBody), false, "PEM body reached the uploaded bundle");
    assert.equal(markerText.includes(keyBody), false, "PEM body reached the on-disk marker");
  });
});

test("diagnosticsPush: orphan END marker is masked in the uploaded body (task263 orphan-end)", async () => {
  await withHome(async (home) => {
    await seedUserSession(home);
    const serverId = randomUUID();
    await seedRunningRunner(home, serverId, "sk_computer_orphan_end");
    const keyBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    // Rotation/truncation dropped the head of the file, so the body arrives with
    // only a trailing END to anchor it.
    const logText = [
      keyBody,
      "-----END PRIVATE KEY-----",
      "runner continued",
    ].join("\n") + "\n";

    const { uploadedText, markerText } = await uploadRunnerLog(home, serverId, logText);
    assert.equal(uploadedText.includes(keyBody), false, "PEM body reached the uploaded bundle");
    assert.equal(markerText.includes(keyBody), false, "PEM body reached the on-disk marker");
    // The orphan-END rule masks from the start of text, so prove it stops at the
    // marker and does not swallow the rest of the log.
    assert.ok(uploadedText.includes("runner continued"), "text after END must survive");
  });
});
