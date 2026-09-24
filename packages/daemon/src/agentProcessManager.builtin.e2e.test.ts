import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  RUNTIME_CONFIG_VERSION,
  type AgentConfig,
  type MachineToServerMessage,
} from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager.js";
import { installDaemonFetchMockForTests } from "./daemonFetch.js";
import { BuiltInDriver } from "./drivers/pi.js";

const BUILTIN_AUTH_ERROR_MESSAGE =
  "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.";

async function withOpenAiCompatible401Provider(
  fn: (baseUrl: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    res.writeHead(401, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({
      error: {
        message: "Invalid API key",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

function makeBuiltInGatewayConfig(baseUrl: string): AgentConfig {
  return {
    name: "builtin-agent",
    displayName: "Built-in Agent",
    description: "test agent",
    model: "gateway-auth-e2e-model",
    runtime: "builtin",
    reasoningEffort: null,
    envVars: null,
    runtimeConfig: {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "openai-compatible",
        baseUrl,
        apiKey: "sk-invalid-provider-key",
      },
      hostUserState: "forbidden",
      model: { kind: "custom", name: "gateway-auth-e2e-model" },
      mode: { kind: "default" },
      envVars: {
        OPENAI_API_KEY: "sk-host-openai-should-not-win",
        OPENAI_BASE_URL: "https://host-openai-should-not-win.example/v1",
      },
    },
    sessionId: null,
    serverUrl: "https://daemon.example.com",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    agentCredentialId: "cred-test",
  };
}

async function waitForActivity(
  sent: MachineToServerMessage[],
  detailKind: Extract<MachineToServerMessage, { type: "agent:activity" }>["detailKind"],
): Promise<Extract<MachineToServerMessage, { type: "agent:activity" }>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (let index = sent.length - 1; index >= 0; index -= 1) {
      const msg = sent[index];
      if (msg.type === "agent:activity" && msg.detailKind === detailKind) {
        return msg;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${detailKind} fact. Sent=${JSON.stringify(sent.slice(-5))}`);
}

function installManagedRunnerMintFetch(): () => void {
  const originalFetch = globalThis.fetch;
  return installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return new Response(JSON.stringify({
        apiKey: "sk_agent_test_1",
        credentialId: "cred-test-1",
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return originalFetch(input, init);
  }) as typeof fetch);
}

function cleanupTestManager(manager: AgentProcessManager): void {
  if ((manager as any).agentStartPumpTimer) clearTimeout((manager as any).agentStartPumpTimer);
  for (const ap of (manager as any).agents?.values?.() ?? []) {
    ap.notifications.clearTimer();
    if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
    if (ap.activityHeartbeat?.kind === "active") clearInterval(ap.activityHeartbeat.timer);
    if (ap.startup?.kind === "waiting" && ap.startup.timer) clearTimeout(ap.startup.timer);
    if (ap.exit?.kind === "live" && ap.exit.stalledRecoverySigtermTimer) clearTimeout(ap.exit.stalledRecoverySigtermTimer);
    if (ap.compaction?.kind === "active" && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
    if (ap.runtimeErrorDeliveryBackoff?.kind === "backing_off" && ap.runtimeErrorDeliveryBackoff.timer) {
      clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
    }
  }
  (manager as any).agents?.clear?.();
}

test("Built-in native SDK provider 401 is surfaced as action-required runtime error activity", { timeout: 45_000 }, async () => {
  await withOpenAiCompatible401Provider(async (baseUrl, providerRequests) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-auth-e2e-"));
    const sent: MachineToServerMessage[] = [];
    const restoreFetch = installManagedRunnerMintFetch();
    const manager = new AgentProcessManager(
      (msg) => sent.push(msg),
      "sk_machine_test",
      {
        dataDir,
        serverUrl: "https://daemon.example.com",
        slockHome: dataDir,
        slockCliPath: "__cli",
        runtimeSessionHomeDir: dataDir,
        driverResolver: () => new BuiltInDriver(),
      },
    );

    try {
      await manager.startAgent(
        "agent-1",
        makeBuiltInGatewayConfig(baseUrl),
        undefined,
        undefined,
        undefined,
        "launch-native-provider-401",
      );

      const errorEvent = await waitForActivity(sent, "runtime_error");
      assert.equal(errorEvent.launchId, "launch-native-provider-401");
      assert.equal(errorEvent.detail, BUILTIN_AUTH_ERROR_MESSAGE);
      assert.equal(
        errorEvent.entries?.some((entry) =>
          entry.kind === "text" && entry.text.includes("Built-in provider authentication failed")
        ),
        true,
      );
      assert.ok(
        providerRequests.length > 0,
        "expected the native Built-in SDK session to call the local provider",
      );
    } finally {
      await manager.stopAgent("agent-1").catch(() => {});
      cleanupTestManager(manager);
      restoreFetch();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// Witness (a) for #460 PR-beta-2 (Kai wiring-review gate): the producer-declared
// three-state heartbeat bit. `isHeartbeat` is the canonical replay-provenance
// key; an *undefined* value falls into the server's legacy content-identity
// compat shim, so every genuine daemon `agent:activity` send MUST declare the
// bit explicitly (true only at the heartbeat timer, false everywhere else).
// This pins the "no undefined leak" invariant end-to-end on the sends a real
// launch actually emits; the heartbeat=true site (60s ACTIVITY_HEARTBEAT_MS
// timer) is covered by code review + the 6/6 send-site audit, not an e2e wait.
// Mutation-RED: drop the `isHeartbeat: false` from any genuine send site and the
// typeof assertion below fires.
test("every daemon agent:activity send declares an explicit isHeartbeat bit (three-state, no undefined leak)", { timeout: 45_000 }, async () => {
  await withOpenAiCompatible401Provider(async (baseUrl) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-builtin-heartbeat-bit-e2e-"));
    const sent: MachineToServerMessage[] = [];
    const restoreFetch = installManagedRunnerMintFetch();
    const manager = new AgentProcessManager(
      (msg) => sent.push(msg),
      "sk_machine_test",
      {
        dataDir,
        serverUrl: "https://daemon.example.com",
        slockHome: dataDir,
        slockCliPath: "__cli",
        runtimeSessionHomeDir: dataDir,
        driverResolver: () => new BuiltInDriver(),
      },
    );

    try {
      await manager.startAgent(
        "agent-1",
        makeBuiltInGatewayConfig(baseUrl),
        undefined,
        undefined,
        undefined,
        "launch-heartbeat-bit",
      );

      // The 401 provider path emits a genuine "error" activity — a real
      // observation, not a heartbeat replay — so at least one agent:activity
      // has been produced by the time this resolves.
      const errorEvent = await waitForActivity(sent, "runtime_error");

      const activitySends = sent.filter(
        (m): m is Extract<MachineToServerMessage, { type: "agent:activity" }> =>
          m.type === "agent:activity",
      );
      assert.ok(activitySends.length > 0, "expected at least one agent:activity send");
      for (const msg of activitySends) {
        assert.equal(
          typeof msg.isHeartbeat,
          "boolean",
          `agent:activity (detailKind=${msg.detailKind}) leaked isHeartbeat=${String(msg.isHeartbeat)} — undefined would fall into the server legacy content-shim`,
        );
      }
      // A genuine observation (the 401 error) declares false, never true.
      assert.equal(
        errorEvent.isHeartbeat,
        false,
        "the genuine error activity is a real observation, must declare isHeartbeat=false",
      );
    } finally {
      await manager.stopAgent("agent-1").catch(() => {});
      cleanupTestManager(manager);
      restoreFetch();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("handoff marker persists launchId and processInstanceId for the L1<->L2 join (#460 V3)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolveRuntimeSessionRef } = await import("./agentProcessManager.js");
  const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "slock-v3-marker-"));
  try {
    // Unknown session in an empty home -> native lookup misses -> the daemon
    // writes the handoff marker. Without persisted join keys the
    // session->launch mapping lives only in daemon memory and old L1
    // transcripts can never re-join their launch after restart/adopt
    // (phantom-74 pilot, violation V3).
    const ref = resolveRuntimeSessionRef(
      "claude",
      "sess-v3-witness",
      await mkdtemp(path.join(os.tmpdir(), "slock-v3-home-")),
      fallbackDir,
      { agentId: "agent-1", launchId: "launch-v3", processInstanceId: "pi-v3" },
    );
    const markerPath = ref.path;
    assert.ok(typeof markerPath === "string" && markerPath.includes("runtime-sessions"), "expected the daemon handoff marker fallback");
    const marker = JSON.parse((await readFile(markerPath as string, "utf8")).trim());
    assert.equal(marker.type, "runtime_session_handoff");
    assert.equal(marker.launchId, "launch-v3", "marker must persist launchId (V3 red: field was absent)");
    assert.equal(marker.processInstanceId, "pi-v3", "marker must persist processInstanceId (V3 red: field was absent)");
    // ids-only scrub discipline: only closed, known metadata keys (ids /
    // provenance / enums / path lists) and never a transcript/body/content
    // payload. #3870 added negative-space diagnostics (resolveStatus /
    // lookupMethod / searchedPaths), so this asserts the closed key set + an
    // explicit no-content-payload guard rather than a frozen 7-key list.
    const KNOWN_MARKER_KEYS = [
      "createdAt",
      "launchId",
      "lookupMethod",
      "note",
      "processInstanceId",
      "resolveStatus",
      "runtime",
      "searchedPaths",
      "sessionId",
      "type",
    ];
    for (const key of Object.keys(marker)) {
      assert.ok(
        KNOWN_MARKER_KEYS.includes(key),
        `marker carries only closed known metadata keys; unexpected key ${key}`,
      );
    }
    for (const forbidden of ["transcript", "body", "content", "messages", "text", "prompt", "response"]) {
      assert.ok(!(forbidden in marker), `marker must not carry content payload key ${forbidden}`);
    }
  } finally {
    await rm(fallbackDir, { recursive: true, force: true });
  }
});

test("idle restart snapshot produces a handoff marker carrying the cached launch join keys (#460 V3, Leiysky blocker)", async () => {
  const { readFile } = await import("node:fs/promises");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-v3-idle-snapshot-"));
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      slockHome: dataDir,
      slockCliPath: "__cli",
      runtimeSessionHomeDir: dataDir,
      driverResolver: () => new BuiltInDriver(),
    },
  );
  try {
    // No live AgentProcess — the agent exists only as an idle restart
    // snapshot (the restart/adopt window). The original fix populated the
    // marker join keys from this.agents.get() only, so exactly this path
    // wrote launchId:null — the V3 class the marker exists to close.
    (manager as unknown as {
      lifecycleRecords: { setRestartSnapshot: (id: string, snap: unknown) => void };
    }).lifecycleRecords.setRestartSnapshot("agent-idle", {
      config: { runtime: "claude", model: "sonnet" },
      sessionId: "sess-idle-v3",
      launchId: "launch-idle-v3",
      processInstanceId: "pi-idle-v3",
    });

    const report = manager.getAgentRuntimeProfileReport("agent-idle");
    assert.ok(report, "expected a runtime profile report from the idle snapshot");
    const ref = report!.facts.sessionRef;
    assert.ok(ref && typeof ref === "object", "expected a structured session ref");
    const refPath = (ref as { path?: unknown }).path;
    assert.ok(typeof refPath === "string" && refPath.includes("runtime-sessions"),
      "idle snapshot with unresolvable session must fall back to the handoff marker");
    const marker = JSON.parse((await readFile(refPath as string, "utf8")).trim());
    assert.equal(marker.launchId, "launch-idle-v3",
      "idle-snapshot marker must carry the CACHED launchId (blocker red: null from live-only read)");
    assert.equal(marker.processInstanceId, "pi-idle-v3",
      "idle-snapshot marker must carry the cached processInstanceId when available");
  } finally {
    cleanupTestManager(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("real live->idle snapshot paths cache processInstanceId (startup-timeout retry, #460 V3 completion)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-v3-realpath-"));
  const sent: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      slockHome: dataDir,
      slockCliPath: "__cli",
      runtimeSessionHomeDir: dataDir,
      driverResolver: () => new BuiltInDriver(),
    },
  );
  try {
    // Exercise the REAL production caching path (cacheStartupTimeoutRetryConfig),
    // not a hand-seeded record: the function must carry ap.processInstanceId
    // into the snapshot so a later idle marker keeps the L1<->L2 join.
    const m = manager as unknown as {
      cacheStartupTimeoutRetryConfig: (id: string, ap: unknown) => void;
      lifecycleRecords: { getRestartSnapshot: (id: string) => { launchId: string | null; processInstanceId?: string } | undefined };
      restartSafeSessionId: (ap: unknown) => string | null;
    };
    m.cacheStartupTimeoutRetryConfig("agent-real", {
      config: { runtime: "claude", model: "sonnet" },
      sessionId: "sess-real-v3",
      launchId: "launch-real-v3",
      processInstanceId: "pi-real-v3",
    });
    const snap = m.lifecycleRecords.getRestartSnapshot("agent-real");
    assert.ok(snap, "expected the startup-timeout retry path to cache a restart snapshot");
    assert.equal(snap!.launchId, "launch-real-v3", "real path must cache launchId");
    assert.equal(snap!.processInstanceId, "pi-real-v3",
      "real live->idle path must cache processInstanceId (Leiysky remaining blocker: sites cached launchId only)");
  } finally {
    cleanupTestManager(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("daemon activity trace rows carry the isHeartbeat provenance bit matching the wire (#460 V1)", { timeout: 45_000 }, async () => {
  await withOpenAiCompatible401Provider(async (baseUrl) => {
    const { BasicTracer, MemoryTraceSink, createSpanAttrContractTracer } = await import("@botiverse/raft-shared");
    const { DAEMON_CORE_TRACE_ATTR_CONTRACTS } = await import("./core.js");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-v1-tracebit-e2e-"));
    const sent: MachineToServerMessage[] = [];
    const sink = new MemoryTraceSink();
    const restoreFetch = installManagedRunnerMintFetch();
    const manager = new AgentProcessManager(
      (msg) => sent.push(msg),
      "sk_machine_test",
      {
        dataDir,
        serverUrl: "https://daemon.example.com",
        slockHome: dataDir,
        slockCliPath: "__cli",
        runtimeSessionHomeDir: dataDir,
        // Production-isomorphic oracle (pilot violation V4): the real daemon
        // tracer is wrapped in the span-attr contract layer, which runtime-
        // scrubs any key missing from DAEMON_CORE_TRACE_ATTR_CONTRACTS. The
        // original V1 witness read a bare BasicTracer sink — the pre-scrub
        // surface — and false-passed while the disk trace lost the bit. The
        // oracle must cross every layer production crosses.
        tracer: createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS),
      },
    );
    try {
      await manager.startAgent(
        "agent-1",
        makeBuiltInGatewayConfig(baseUrl),
        undefined,
        undefined,
        undefined,
        "launch-v1-tracebit",
      );
      await waitForActivity(sent, "runtime_error");

      // L2 evidence: every daemon.agent.activity.produced trace span must
      // carry the closed is_heartbeat boolean so the L2<->L3 seam is
      // independently verifiable (pilot violation V1: wire had the bit,
      // daemon-side trace did not -> grep=0 was the standing red). Oracle =
      // the manager's own tracer sink (stored-const read, labeled asserts).
      const producedSpans = sink.getAllSpans().filter((span) => span.name === "daemon.agent.activity.produced");
      assert.ok(producedSpans.length > 0, "expected at least one activity.produced trace span");
      for (const span of producedSpans) {
        const attrs = (span.attrs ?? {}) as Record<string, unknown>;
        assert.equal(
          typeof attrs.is_heartbeat,
          "boolean",
          "activity.produced trace span missing closed is_heartbeat (V1 red state)",
        );
      }
      // Wire<->trace consistency on the genuine (non-heartbeat) observation.
      const genuine = producedSpans.filter((span) => ((span.attrs ?? {}) as Record<string, unknown>).is_heartbeat === false);
      assert.ok(genuine.length > 0, "genuine observations must record is_heartbeat=false");
      // V3 span-side join key must also survive the contract scrub: the disk
      // marker carries the triple, but the produced span is the per-emission
      // L2 join leg the readtable uses. Emission is `ap?.processInstanceId`,
      // so the obligation is scoped to ap-present spans (an ap-absent
      // emission has no instance to name — same explicit-omission contract
      // as the no-handle adoption branch in #3863).
      const apPresent = producedSpans.filter((span) => ((span.attrs ?? {}) as Record<string, unknown>).ap_present === true);
      assert.ok(apPresent.length > 0, "expected at least one ap-present activity.produced span to witness the join key");
      for (const span of apPresent) {
        const attrs = (span.attrs ?? {}) as Record<string, unknown>;
        assert.equal(
          typeof attrs.process_instance_id,
          "string",
          "ap-present activity.produced span missing process_instance_id (V4 scrub: contract key absent)",
        );
      }
    } finally {
      await manager.stopAgent("agent-1").catch(() => {});
      cleanupTestManager(manager);
      restoreFetch();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("produced-span contract completeness: every emitted attr is either allowlisted or an explicit scrub decision (task #460 V4)", async () => {
  // "Silent scrub must be a loud red" (gamma-2 witness obligation): the
  // difference between what recordActivityProducedTrace emits and what the
  // runtime attr contract admits must be an EXPLICITLY decided set. A new
  // emission-site key that is neither allowlisted nor decided fails here,
  // instead of dying silently at the contract layer like V4 did.
  const { BasicTracer, MemoryTraceSink } = await import("@botiverse/raft-shared");
  const { DAEMON_CORE_TRACE_ATTR_CONTRACTS } = await import("./core.js");

  // Decided scrubs, each with an owner ruling — NOT drive-by candidates:
  // - producerFactId/producer_fact_id: banned join key (#460 classification
  //   ruling); admitting it to the readable surface needs its own ruling.
  // - activity_kind/detail_kind: pre-existing duplicate-key drift; widening
  //   is the contract owner's call (flagged in #3873, deliberately not taken).
  const DECIDED_SCRUBBED = ["producerFactId", "producer_fact_id", "activity_kind", "detail_kind"];

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const probe = {
    tracer,
    recordDaemonTrace(name: string, attrs?: Record<string, unknown>) {
      const span = tracer.startSpan(name, { surface: "daemon", kind: "internal", attrs });
      span.end("ok");
    },
  };
  // Drive the real emission function against a bare (pre-scrub) tracer so
  // the emitted key set is observed, not hand-maintained.
  (AgentProcessManager.prototype as any).recordActivityProducedTrace.call(
    probe,
    "agent-1",
    "working",
    "Running command…",
    "running_command",
    [{ kind: "status", activity: "working", detail: "", detailKind: "running_command" }],
    undefined,
    "L-1",
    1,
    "daemon_activity:agent-1:L-1:1",
    false,
  );

  const spans = sink.getAllSpans().filter((span) => span.name === "daemon.agent.activity.produced");
  assert.equal(spans.length, 1, "probe emission must produce exactly one span");
  const emittedKeys = Object.entries(spans[0].attrs ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  assert.ok(emittedKeys.length > 0, "probe emission produced no attrs — probe broken, not contract complete");

  const contract = DAEMON_CORE_TRACE_ATTR_CONTRACTS["daemon.agent.activity.produced"];
  assert.ok(contract, "produced-span contract entry missing");
  const allowed = new Set<string>(contract.spanAttrs ?? []);
  const decided = new Set(DECIDED_SCRUBBED);

  for (const key of decided) {
    assert.ok(!allowed.has(key), `key "${key}" is both allowlisted and marked as a decided scrub — resolve the contradiction`);
  }
  const silent = emittedKeys.filter((key) => !allowed.has(key) && !decided.has(key));
  assert.deepEqual(
    silent,
    [],
    `silently scrubbed produced-span attrs (add to the contract or to DECIDED_SCRUBBED with an owner ruling): ${JSON.stringify(silent)}`,
  );
});
