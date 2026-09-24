import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
  type ExternalAgentWakeEventEnvelope,
} from "@botiverse/raft-shared";
import type { AgentContext } from "../auth/env.js";
import { buildRaftChannelWakeInjectedEvent } from "../external/raftChannelWakeAdapter.js";
import {
  AgentCommsBridgeLockError,
  acquireAgentCommsBridgeLock,
  createFileAgentCommsBridgeStore,
  runAgentCommsBridgeOnce,
  runAgentCommsBridgeReconcile,
  sanitizeExternalAgentActivityEvents,
  type AgentCommsBridgeOutput,
  type AgentCommsHandoffEvent,
  type AgentCommsProofEvent,
  type AgentCommsWakeHintSource,
} from "./bridge.js";

const fixedNow = () => new Date("2026-06-08T05:00:00.000Z");

function profileContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    agentId: "agent-a",
    serverUrl: "https://slock.example.test",
    serverId: "server-1",
    token: "sk_agent_test",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileSlug: "agent-a-profile",
    profileCredentialPath: "/tmp/credential.json",
    ...overrides,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slock-agent-bridge-"));
}

function isCommsProof(event: AgentCommsBridgeOutput): event is AgentCommsProofEvent {
  return "type" in event && event.type === "agent_comms.proof";
}

function isHandoff(event: AgentCommsBridgeOutput): event is AgentCommsHandoffEvent {
  return "type" in event && event.type === "agent_comms.handoff";
}

function isWakeInjected(event: AgentCommsBridgeOutput): event is ExternalAgentWakeEventEnvelope & { kind: "proof"; proofLevel: "wake_injected" } {
  return "schema" in event && event.kind === "proof" && event.proofLevel === "wake_injected";
}

test("bridge records wake-only proofs and never stores body or upgrades to model_seen/read", async () => {
  const stateDir = tempDir();
  const source: AgentCommsWakeHintSource = {
    async fetchWakeHints() {
      return {
        hints: [{
          event_id: "wake-hint:msg-1",
          seq: 101,
          target: "channelId:channel-1",
          wake_reason: "message_pending",
          content: "must not be persisted by bridge",
        }],
        last_seen_hint_seq: 101,
        has_more: false,
      };
    },
  };

  const output = await runAgentCommsBridgeOnce({
    agentContext: profileContext(),
    source,
    stateDir,
    now: fixedNow,
    coreSessionId: "core-test",
  });

  const proofLevels = output
    .filter(isCommsProof)
    .map((event) => event.proof.level);
  assert.deepEqual(proofLevels, ["server_delivered", "harness_accepted"]);
  for (const event of output) {
    if (!isCommsProof(event)) continue;
    assert.match(event.eventId, /^event_/);
    assert.match(event.attemptId, /^attempt_/);
    assert.equal(event.runtimeSession, null);
    assert.equal(event.lifecycleState, "handoff_pending");
    assert.equal(event.profile, "agent-a-profile");
    assert.equal(event.source, "slock-agent-bridge");
    assert.equal(event.provenance.authority, event.proofLevel === "server_delivered" ? "server_core" : "comms_core");
    assert.equal(event.proofLevel, event.proof.level);
    assert.equal(event.wakeHintId, "wake-hint:msg-1");
    assert.equal(event.proof.cursorImpact.deliveryAck, false);
    assert.equal(event.proof.cursorImpact.modelSeen, false);
    assert.equal(event.proof.cursorImpact.read, false);
  }

  const store = createFileAgentCommsBridgeStore({ agentContext: profileContext(), stateDir });
  assert.deepEqual(store.readWakeHints().map((hint) => hint.seq), [101]);
  assert.equal("content" in store.readWakeHints()[0]!, false);
});

test("bridge can call a wake adapter after harness acceptance without cursor authority", async () => {
  const stateDir = tempDir();
  const source: AgentCommsWakeHintSource = {
    async fetchWakeHints() {
      return {
        hints: [{
          event_id: "wake-hint:msg-1",
          message_id: "msg-1",
          seq: 101,
          target: "channelId:channel-1",
          wake_reason: "message_pending",
          content: "must not be sent to adapter by bridge",
        }],
        last_seen_hint_seq: 101,
        has_more: false,
      };
    },
  };
  const wakeInputs: unknown[] = [];

  const output = await runAgentCommsBridgeOnce({
    agentContext: profileContext(),
    source,
    stateDir,
    now: fixedNow,
    coreSessionId: "core-test",
    runtimeSession: "claude-session-1",
    wakeAdapter: {
      manifest: {} as never,
      async wake(input) {
        wakeInputs.push(input);
        return buildRaftChannelWakeInjectedEvent({
          ...input,
          runtimeSession: "claude-session-1",
        });
      },
    },
  });

  assert.equal(wakeInputs.length, 1);
  const wakeInput = wakeInputs[0] as Record<string, unknown>;
  assert.match(String(wakeInput.eventId), /^event_/);
  assert.match(String(wakeInput.attemptId), /^attempt_/);
  assert.equal(wakeInput.messageId, "msg-1");
  assert.equal(wakeInput.agentId, "agent-a");
  assert.equal(wakeInput.profile, "agent-a-profile");
  assert.equal(wakeInput.coreSessionId, "core-test");
  assert.equal(wakeInput.adapterInstance, "default");
  assert.equal(wakeInput.runtimeSession, "claude-session-1");
  assert.equal(wakeInput.occurredAt, "2026-06-08T05:00:00.000Z");
  const wakeInjected = output.find(isWakeInjected);
  assert.ok(wakeInjected);
  assert.equal(wakeInjected.agentId, "agent-a");
  assert.equal(wakeInjected.authority.source, "wake_adapter");
  assert.equal(wakeInjected.runtimeSession, "claude-session-1");

  const store = createFileAgentCommsBridgeStore({ agentContext: profileContext(), stateDir });
  const stored = fs.readFileSync(store.paths.proofFile, "utf-8");
  assert.match(stored, /"proofLevel":"wake_injected"/);
  assert.doesNotMatch(stored, /must not be sent/);
});

test("bridge replays locally accepted wake hints on restart without duplicating wake-dedup state", async () => {
  const stateDir = tempDir();
  let calls = 0;
  const source: AgentCommsWakeHintSource = {
    async fetchWakeHints() {
      calls += 1;
      return calls === 1
        ? { hints: [{ event_id: "wake-hint:msg-1", seq: 101, target: "channelId:channel-1", wake_reason: "message_pending" }], last_seen_hint_seq: 101 }
        : { hints: [], last_seen_hint_seq: 101 };
    },
  };
  const agentContext = profileContext();

  await runAgentCommsBridgeOnce({
    agentContext,
    source,
    stateDir,
    now: fixedNow,
    coreSessionId: "core-test",
  });
  const second = await runAgentCommsBridgeOnce({
    agentContext,
    source,
    stateDir,
    now: fixedNow,
  });

  const replayed = second.filter((event) => isHandoff(event) && event.replay);
  assert.equal(replayed.length, 1);
  const [replayedHandoff] = replayed;
  assert.ok(replayedHandoff && isHandoff(replayedHandoff));
  assert.equal(replayedHandoff.acceptedProof.level, "harness_accepted");
  const store = createFileAgentCommsBridgeStore({ agentContext, stateDir });
  assert.equal(store.readWakeHints().length, 1);
});

test("bridge state is isolated by agent, profile, and adapter instance", async () => {
  const root = tempDir();
  const env = { SLOCK_HOME: root };
  const agentA = profileContext({
    agentId: "agent-a",
    profileSlug: "profile-a",
    profileCredentialPath: path.join(root, "profiles/profile-a/credential.json"),
  });
  const agentB = profileContext({
    agentId: "agent-b",
    profileSlug: "profile-b",
    profileCredentialPath: path.join(root, "profiles/profile-b/credential.json"),
  });
  const sourceA: AgentCommsWakeHintSource = {
    async fetchWakeHints() {
      return { hints: [{ event_id: "a", seq: 1, target: "channelId:a", wake_reason: "message_pending" }], last_seen_hint_seq: 1 };
    },
  };
  const sourceB: AgentCommsWakeHintSource = {
    async fetchWakeHints() {
      return { hints: [{ event_id: "b", seq: 2, target: "channelId:b", wake_reason: "message_pending" }], last_seen_hint_seq: 2 };
    },
  };

  await runAgentCommsBridgeOnce({ agentContext: agentA, source: sourceA, env, now: fixedNow, adapterInstance: "cc" });
  await runAgentCommsBridgeOnce({ agentContext: agentB, source: sourceB, env, now: fixedNow, adapterInstance: "cc" });

  const storeA = createFileAgentCommsBridgeStore({ agentContext: agentA, env, adapterInstance: "cc" });
  const storeB = createFileAgentCommsBridgeStore({ agentContext: agentB, env, adapterInstance: "cc" });
  assert.deepEqual(storeA.readWakeHints().map((hint) => hint.event_id), ["a"]);
  assert.deepEqual(storeB.readWakeHints().map((hint) => hint.event_id), ["b"]);
  assert.notEqual(storeA.paths.rootDir, storeB.paths.rootDir);
});

test("bridge lock enforces single owner per agent, profile, and adapter instance", () => {
  const root = tempDir();
  const env = { SLOCK_HOME: root };
  const agentContext = profileContext({
    agentId: "agent-a",
    profileSlug: "profile-a",
    profileCredentialPath: path.join(root, "profiles/profile-a/credential.json"),
  });

  const first = acquireAgentCommsBridgeLock({
    agentContext,
    env,
    adapterInstance: "cc",
    ownerId: "owner-1",
  });
  try {
    assert.throws(
      () => acquireAgentCommsBridgeLock({
        agentContext,
        env,
        adapterInstance: "cc",
        ownerId: "owner-2",
      }),
      AgentCommsBridgeLockError,
    );
  } finally {
    first.release();
  }

  const second = acquireAgentCommsBridgeLock({
    agentContext,
    env,
    adapterInstance: "cc",
    ownerId: "owner-2",
  });
  second.release();
});

test("bridge lock reclaims a stale lock when the recorded pid is gone", () => {
  const root = tempDir();
  const env = { SLOCK_HOME: root };
  const agentContext = profileContext({
    agentId: "agent-a",
    profileSlug: "profile-a",
    profileCredentialPath: path.join(root, "profiles/profile-a/credential.json"),
  });
  const store = createFileAgentCommsBridgeStore({ agentContext, env, adapterInstance: "cc" });
  fs.writeFileSync(store.paths.lockFile, `${JSON.stringify({
    ownerId: "stale",
    pid: 999_999_999,
  })}\n`);

  const lock = acquireAgentCommsBridgeLock({
    agentContext,
    env,
    adapterInstance: "cc",
    ownerId: "owner-2",
  });
  try {
    assert.equal(lock.path, store.paths.lockFile);
  } finally {
    lock.release();
  }
});

test("bridge fails closed without a self-hosted profile credential", async () => {
  const source: AgentCommsWakeHintSource = {
    async fetchWakeHints() {
      return { hints: [] };
    },
  };
  await assert.rejects(
    () => runAgentCommsBridgeOnce({
      agentContext: profileContext({
        clientMode: "managed-runner",
        secretSource: "agent-proxy-token-file",
        profileSlug: undefined,
        profileCredentialPath: undefined,
      }),
      source,
      stateDir: tempDir(),
      now: fixedNow,
    }),
    /requires a self-hosted profile credential/,
  );
});

test("bridge drains plugin activity, truncates content, and does not forward transcript paths", async () => {
  const stateDir = tempDir();
  const forwarded: unknown[] = [];
  const source: AgentCommsWakeHintSource = {
    async fetchWakeHints() {
      return { hints: [], last_seen_hint_seq: null, has_more: false };
    },
  };

  const output = await runAgentCommsBridgeOnce({
    agentContext: profileContext(),
    source,
    stateDir,
    now: fixedNow,
    coreSessionId: "core-test",
    activitySource: {
      async drainActivity() {
        return {
          schema: EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA,
          dropped: 2,
          events: [{
            event_id: "activity-1",
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: "x".repeat(4500),
            transcript_path: "/tmp/should-not-forward",
          } as any],
        };
      },
    },
    activitySink: {
      async forwardActivity(input) {
        forwarded.push(input);
      },
    },
  });

  const drain = output.find((event) => "type" in event && event.type === "agent_comms.activity_drain") as Record<string, unknown> | undefined;
  assert.ok(drain);
  assert.equal(drain.outcome, "forwarded");
  assert.equal(drain.forwardedCount, 1);
  assert.equal(drain.droppedCount, 2);
  assert.equal(forwarded.length, 1);

  const body = forwarded[0] as { schema?: string; events?: Array<Record<string, unknown>> };
  assert.equal(body.schema, EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA);
  assert.equal(body.events?.length, 1);
  const event = body.events?.[0] ?? {};
  assert.equal(event.hookEventName, "PreToolUse");
  assert.equal(event.toolName, "Bash");
  assert.equal(typeof event.toolInput, "string");
  assert.ok(String(event.toolInput).length <= 4096);
  assert.match(String(event.toolInput), /\[truncated\]$/);
  assert.doesNotMatch(JSON.stringify(body), /transcript_path|should-not-forward/);
});

test("activity sanitizer keeps tool content but strips non-contract hook payload fields", () => {
  const sanitized = sanitizeExternalAgentActivityEvents([{
    eventId: "activity-2",
    hookEventName: "PostToolUse",
    toolName: "Read",
    toolOutput: "visible output",
    transcript_path: "/tmp/not-forwarded",
  } as any], fixedNow);

  assert.equal(sanitized.rejectedCount, 0);
  assert.equal(sanitized.events.length, 1);
  assert.equal(sanitized.events[0]?.toolOutput, "visible output");
  assert.doesNotMatch(JSON.stringify(sanitized.events), /transcript_path|not-forwarded/);
});

test("activity sanitizer preserves plugin 0.3.0 event-level truncation provenance", () => {
  const sanitized = sanitizeExternalAgentActivityEvents([{
    event_id: "activity-3",
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_output: "x".repeat(4090),
    truncated: true,
  }], fixedNow);

  assert.equal(sanitized.rejectedCount, 0);
  assert.equal(sanitized.events.length, 1);
  assert.equal(sanitized.events[0]?.toolOutputTruncated, true);
});


// --- task #77: stale wake replay. wake-hints.jsonl entries must be pruned
// once their wake reached `wake_injected` (replay exists only for
// crash-before-inject), and NEVER pruned on failure (no-drop rule: a failed
// wake must stay replayable). Without pruning, every bridge start replayed
// the full hint history as stale wakes for long-drained messages.

function singleHintSource(): AgentCommsWakeHintSource {
  let calls = 0;
  return {
    async fetchWakeHints() {
      calls += 1;
      return calls === 1
        ? { hints: [{ event_id: "wake-hint:msg-prune", seq: 701, target: "channelId:channel-p", wake_reason: "message_pending" }], last_seen_hint_seq: 701 }
        : { hints: [], last_seen_hint_seq: 701 };
    },
  };
}

test("wake hint is pruned from the replay ledger after successful injection (task #77)", async () => {
  const stateDir = tempDir();
  const agentContext = profileContext();

  await runAgentCommsBridgeOnce({
    agentContext,
    source: singleHintSource(),
    stateDir,
    now: fixedNow,
    coreSessionId: "core-test",
    runtimeSession: "claude-session-prune",
    wakeAdapter: {
      manifest: {} as never,
      async wake(input) {
        return buildRaftChannelWakeInjectedEvent({
          ...input,
          runtimeSession: "claude-session-prune",
        });
      },
    },
  });

  const store = createFileAgentCommsBridgeStore({ agentContext, stateDir });
  assert.equal(store.readWakeHints().length, 0, "injected hint must leave the replay ledger");
});

test("wake hint stays in the replay ledger when injection fails (no-drop)", async () => {
  const stateDir = tempDir();
  const agentContext = profileContext();

  const output = await runAgentCommsBridgeOnce({
    agentContext,
    source: singleHintSource(),
    stateDir,
    now: fixedNow,
    coreSessionId: "core-test",
    runtimeSession: "claude-session-prune",
    wakeAdapter: {
      manifest: {} as never,
      async wake() {
        throw new Error("plugin endpoint down");
      },
    },
  });

  assert.ok(output.some((event) => "outcome" in event && event.outcome === "failed"));
  const store = createFileAgentCommsBridgeStore({ agentContext, stateDir });
  assert.equal(store.readWakeHints().length, 1, "failed wake must keep the hint replayable");
});

// --- task #87 / EAB invariant 7: at-least-once-until-consumed reconciliation.
// `wake_injected` is transport-written, not model-consumed; a wake can be
// silently dropped downstream. Server-pending is the consumption truth (the
// peek is non-draining), so reconcile re-peeks since=0 and re-injects what is
// still pending. Kai's conformance pins: (1) still-pending un-consumed hints
// are re-injected; (2) consumed hints (no longer pending) are not; (3) the
// re-peek never moves the session cursor (lastSeenHintSeq untouched).

function reconcileFixture(pendingSeqs: number[]) {
  const stateDir = tempDir();
  const wakes: number[] = [];
  const source: AgentCommsWakeHintSource = {
    async fetchWakeHints(input) {
      assert.equal(input.since, 0, "reconcile must peek the FULL pending set (since=0)");
      return {
        hints: pendingSeqs.map((seq) => ({
          event_id: `wake-hint:msg-${seq}`,
          seq,
          target: "channelId:channel-1",
          wake_reason: "message_pending",
        })),
        last_seen_hint_seq: pendingSeqs[pendingSeqs.length - 1] ?? null,
      };
    },
  };
  const wakeAdapter = {
    manifest: {} as never,
    async wake(input: Parameters<NonNullable<Parameters<typeof runAgentCommsBridgeOnce>[0]["wakeAdapter"]>["wake"]>[0]) {
      wakes.push(Number(String(input.messageId ?? "").replace(/\D/g, "")) || -1);
      return buildRaftChannelWakeInjectedEvent({ ...input, runtimeSession: "claude-session-reconcile" });
    },
  };
  return { stateDir, source, wakeAdapter, wakes };
}

test("reconcile re-injects still-pending hints and leaves the session cursor untouched (EAB-7)", async () => {
  const { stateDir, source, wakeAdapter, wakes } = reconcileFixture([401, 402]);
  const agentContext = profileContext();
  const store = createFileAgentCommsBridgeStore({ agentContext, stateDir });
  // Simulate the silent-drop history: these hints were already injected once
  // (lastSeenHintSeq advanced past them, ledger pruned), but never consumed —
  // they are still pending server-side.
  store.writeSession({ coreSessionId: "core-reconcile", lastSeenHintSeq: 402 });

  const result = await runAgentCommsBridgeReconcile({
    agentContext,
    source,
    stateDir,
    now: fixedNow,
    wakeAdapter,
    recentInjections: new Map(),
    graceMs: 30_000,
  });

  assert.equal(result.pendingCount, 2);
  assert.equal(result.reinjectedCount, 2, "at-most-once seen-filter must be bypassed");
  assert.deepEqual(wakes, [401, 402]);
  const session = store.readSession();
  assert.equal(session?.lastSeenHintSeq, 402, "reconcile must not move the seen cursor");
});

test("reconcile does not re-inject consumed hints (empty pending) nor fresh wakes inside the grace window", async () => {
  // Consumed: server-pending empty → nothing re-injected.
  const consumed = reconcileFixture([]);
  const agentContextA = profileContext();
  const emptyResult = await runAgentCommsBridgeReconcile({
    agentContext: agentContextA,
    source: consumed.source,
    stateDir: consumed.stateDir,
    now: fixedNow,
    wakeAdapter: consumed.wakeAdapter,
  });
  assert.equal(emptyResult.pendingCount, 0);
  assert.equal(emptyResult.reinjectedCount, 0);
  assert.equal(consumed.wakes.length, 0);

  // Grace: a hint the live path injected moments ago is skipped, not doubled.
  const fresh = reconcileFixture([501]);
  const recent = new Map<string, number>([["id:wake-hint:msg-501", fixedNow().getTime() - 1000]]);
  const graceResult = await runAgentCommsBridgeReconcile({
    agentContext: profileContext(),
    source: fresh.source,
    stateDir: fresh.stateDir,
    now: fixedNow,
    wakeAdapter: fresh.wakeAdapter,
    recentInjections: recent,
    graceMs: 30_000,
  });
  assert.equal(graceResult.pendingCount, 1);
  assert.equal(graceResult.reinjectedCount, 0);
  assert.equal(graceResult.skippedRecentCount, 1);
  assert.equal(fresh.wakes.length, 0, "fresh wake must not be doubled by reconcile");
});

test("bridge.log: store.appendLog writes timestamped NDJSON and rotates at the size cap", () => {
  const stateDir = tempDir();
  const store = createFileAgentCommsBridgeStore({ agentContext: profileContext(), stateDir });
  store.appendLog({ type: "bridge_process_started", pid: 123 });
  store.appendLog({ type: "bridge_retry", consecutiveFailures: 1 });
  const lines = fs.readFileSync(store.paths.logFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "bridge_process_started");
  assert.ok(typeof lines[0].ts === "string" && lines[0].ts.length > 0);

  // Rotation: oversize log moves to .1 and a fresh file starts.
  fs.writeFileSync(store.paths.logFile, "x".repeat(5 * 1024 * 1024 + 1));
  store.appendLog({ type: "after_rotation" });
  assert.ok(fs.existsSync(`${store.paths.logFile}.1`), "oversize log must rotate to .1");
  const freshLines = fs.readFileSync(store.paths.logFile, "utf-8").trim().split("\n");
  assert.equal(freshLines.length, 1);
  assert.equal(JSON.parse(freshLines[0]!).type, "after_rotation");
});
