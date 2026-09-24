import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  AGENT_INBOX_PREVIEW_MAX_CHARS,
  formatAgentInboxFullSnapshot,
  formatAgentInboxSnapshot,
  shortIdFromSourceRef,
  type AgentInboxSourceRef,
} from "@botiverse/raft-shared";
import {
  createAgentAppInboxStore,
  deriveStableItemId,
  type AgentAppInboxRegistry,
  type AgentAppSourceRefNormalizeResult,
} from "./agentAppInbox.js";
import {
  createScopedAppStorageFactory,
  type ScopedAppStorage,
} from "./scopedAppStorage.js";

const SOURCE_REF_KEYS = new Set(["kind", "id", "revision"]);

function normalizeFixtureDue(raw: unknown): AgentAppSourceRefNormalizeResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "sourceRef must be structured {kind,id,revision}" };
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!SOURCE_REF_KEYS.has(key)) {
      return { ok: false, message: `sourceRef rejects field: ${key}` };
    }
  }
  if (o.kind !== "fixture") {
    return { ok: false, message: "sourceRef.kind must be fixture" };
  }
  if (typeof o.id !== "string" || !/^[0-9a-fA-F-]{8,}$/.test(o.id)) {
    return { ok: false, message: "sourceRef.id required" };
  }
  if (typeof o.revision !== "string" || o.revision.length === 0) {
    return { ok: false, message: "sourceRef.revision required for due class" };
  }
  return { ok: true, ref: { kind: "fixture", id: o.id, revision: o.revision } };
}

function normalizeFixtureMeasure(raw: unknown): AgentAppSourceRefNormalizeResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "sourceRef must be structured {kind,id}" };
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!SOURCE_REF_KEYS.has(key)) {
      return { ok: false, message: `sourceRef rejects field: ${key}` };
    }
  }
  if (o.kind !== "fixture-measure") {
    return { ok: false, message: "sourceRef.kind must be fixture-measure" };
  }
  if (typeof o.id !== "string" || o.id.length === 0) {
    return { ok: false, message: "sourceRef.id required" };
  }
  if (o.revision !== undefined) {
    return { ok: false, message: "fixture-measure must not carry revision" };
  }
  return { ok: true, ref: { kind: "fixture-measure", id: o.id } };
}

/**
 * Fake injected registry for Phase 1 substrate teeth.
 * Uses non-product app ids so OS files stay free of declared APP-name roots.
 */
const FIXTURE_REGISTRY: AgentAppInboxRegistry = {
  "test.fixture": {
    due: {
      retention: "until_source_read",
      primaryAction: { kind: "run_command", commandId: "fixture.log" },
      normalizeSourceRef: normalizeFixtureDue,
      materializeActionCli: ({ sourceRef }) =>
        `raft fixture log --id ${shortIdFromSourceRef(sourceRef)}`,
    },
    over_threshold: {
      retention: "transient",
      primaryAction: { kind: "run_command", commandId: "fixture.review" },
      normalizeSourceRef: normalizeFixtureMeasure,
      materializeActionCli: () => "raft fixture review",
    },
  },
};

const REF_R1: AgentInboxSourceRef = {
  kind: "fixture",
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  revision: "1",
};
const REF_R2: AgentInboxSourceRef = {
  kind: "fixture",
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  revision: "2",
};
const REF_OTHER: AgentInboxSourceRef = {
  kind: "fixture",
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  revision: "1",
};
const REF_MEASURE_A: AgentInboxSourceRef = { kind: "fixture-measure", id: "owner-a" };

function storeWithFixture(opts?: {
  idFactory?: () => string;
  nowMs?: () => number;
  ownerAgentId?: string;
  beforeAck?: (item: import("@botiverse/raft-shared").AgentInboxAppItem) => boolean | void;
  beforeServerAuthorizedAck?: (
    item: import("@botiverse/raft-shared").AgentInboxAppItem,
    intent: import("./agentAppInbox.js").AgentAppInboxAckIntent,
  ) => boolean | void;
  storage?: ScopedAppStorage;
  trace?: (name: string, attrs: Record<string, unknown>, status?: "ok" | "error") => void;
}) {
  return createAgentAppInboxStore({ registry: FIXTURE_REGISTRY, ...opts });
}

function createTestStorage(root: string, agentId = "agent-a"): ScopedAppStorage {
  return createScopedAppStorageFactory({
    slockHome: root,
    owner: { machineId: "machine-test", serverId: "server-test" },
  }).open({ appId: "test.fixture", agentId });
}

test("message-only full snapshot matches legacy format byte-for-byte", () => {
  const rows = [
    {
      target: "#proj-aiax",
      pendingCount: 1,
      firstPendingMsgId: "aaaaaaaa-0000-4000-8000-000000000000",
      latestMsgId: "bbbbbbbb-0000-4000-8000-000000000000",
      latestSenderName: "tygg",
      flags: ["mention" as const],
    },
  ];
  const legacy = formatAgentInboxSnapshot(rows);
  const composed = formatAgentInboxFullSnapshot({
    messageRows: rows,
    appItems: [],
    formatMessageRows: formatAgentInboxSnapshot,
  });
  assert.equal(composed, legacy);
});

test("default registry is empty — product apps unknown until injected", () => {
  const store = createAgentAppInboxStore();
  assert.equal(
    store.mint({ appId: "test.fixture", notificationClass: "due", sourceRef: REF_R1 }).ok,
    false,
  );
});

test("mint app item has primaryAction, actionCli, structured sourceRef, zero msg fields", () => {
  const store = storeWithFixture({ idFactory: () => "item-fixed-id" });
  const minted = store.mint({
    appId: "test.fixture",
    notificationClass: "over_threshold",
    sourceRef: REF_MEASURE_A,
    title: "file over threshold",
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(minted.item.source, "app");
  assert.deepEqual(minted.item.sourceRef, REF_MEASURE_A);
  assert.equal(minted.item.primaryAction.kind, "run_command");
  assert.equal(minted.item.primaryAction.commandId, "fixture.review");
  assert.equal(minted.item.actionCli, "raft fixture review");
  assert.equal(minted.item.retention, "transient");
  assert.equal("latestMsgId" in minted.item, false);
  assert.equal("firstPendingMsgId" in minted.item, false);
  assert.equal("latestSeq" in minted.item, false);
  assert.equal("latestSenderName" in minted.item, false);
});

test("App Inbox mint and ack expose the same content-free correlation identity", () => {
  const traces: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const store = storeWithFixture({
    ownerAgentId: "agent-a",
    idFactory: () => "item-fixed-id",
    trace: (name, attrs) => traces.push({ name, attrs }),
  });
  const minted = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
    title: "must never enter trace attrs",
    summary: "nor this",
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(store.ack(minted.item.itemId), true);

  assert.deepEqual(
    traces.map((trace) => trace.name),
    ["daemon.app_inbox.mint", "daemon.app_inbox.ack"],
  );
  assert.equal(
    traces[0]!.attrs.app_correlation_id,
    traces[1]!.attrs.app_correlation_id,
  );
  assert.equal(traces[0]!.attrs.item_id, "item-fixed-id");
  for (const trace of traces) {
    assert.equal(Object.hasOwn(trace.attrs, "title"), false);
    assert.equal(Object.hasOwn(trace.attrs, "summary"), false);
    assert.equal(Object.hasOwn(trace.attrs, "actionCli"), false);
  }
});

test("source ACK rejection preserves the item and emits an error terminal", () => {
  const traces: Array<{
    name: string;
    attrs: Record<string, unknown>;
    status?: "ok" | "error";
  }> = [];
  const store = storeWithFixture({
    ownerAgentId: "agent-a",
    beforeAck: () => false,
    trace: (name, attrs, status) => traces.push({ name, attrs, status }),
  });
  const minted = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;

  assert.equal(store.ack(minted.item.itemId), false);
  assert.equal(store.list().length, 1);
  const ack = traces.find((trace) => trace.name === "daemon.app_inbox.ack");
  assert.equal(ack?.attrs.outcome, "source_ack_rejected");
  assert.equal(ack?.status, "error");
  assert.equal(
    ack?.attrs.app_correlation_id,
    `source:agent-a:fixture:${REF_R1.id}:${REF_R1.revision}`,
  );
});

test("server-authorized ACK intent persists, reuses attempt id, and completes exact item atomically", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-app-inbox-ack-intent-"));
  const storage = createTestStorage(dir);
  try {
    const calls: Array<{ itemId: string; ackAttemptId: string }> = [];
    const store = storeWithFixture({
      storage,
      beforeServerAuthorizedAck: (item, intent) => {
        calls.push({ itemId: item.itemId, ackAttemptId: intent.ackAttemptId });
        return true;
      },
    });
    const minted = store.mint({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    });
    assert.equal(minted.ok, true);
    if (!minted.ok) return;

    const firstIntent = store.beginServerAuthorizedAckIntent({
      itemId: minted.item.itemId,
      ackAttemptId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(firstIntent?.ackAttemptId, "11111111-1111-4111-8111-111111111111");

    const restored = storeWithFixture({ storage });
    const replayedIntent = restored.beginServerAuthorizedAckIntent({
      itemId: minted.item.itemId,
      ackAttemptId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(replayedIntent?.ackAttemptId, "11111111-1111-4111-8111-111111111111");
    assert.equal(
      restored.completeServerAuthorizedAck({
        itemId: minted.item.itemId,
        ackAttemptId: "22222222-2222-4222-8222-222222222222",
      }),
      false,
    );
    assert.equal(
      restored.completeServerAuthorizedAck({
        itemId: minted.item.itemId,
        ackAttemptId: "11111111-1111-4111-8111-111111111111",
      }),
      true,
    );
    assert.deepEqual(calls, []);
    assert.equal(restored.list().length, 0);
    assert.equal(restored.listAcknowledgedSources().length, 1);

    const finalRestore = storeWithFixture({ storage });
    assert.equal(finalRestore.list().length, 0);
    assert.equal(finalRestore.listAcknowledgedSources().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown app or class or raw command fields fail closed", () => {
  const store = storeWithFixture();
  assert.equal(
    store.mint({ appId: "test.evil", notificationClass: "x", sourceRef: REF_R1 }).ok,
    false,
  );
  assert.equal(
    store.mint({ appId: "test.fixture", notificationClass: "nope", sourceRef: REF_R1 }).ok,
    false,
  );

  const shellInjected = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
    requestedPrimaryAction: {
      kind: "run_command",
      commandId: "fixture.log",
      shell: "rm -rf /",
    } as never,
  });
  assert.equal(shellInjected.ok, false);
  if (!shellInjected.ok) {
    assert.equal(shellInjected.code, "raw_command_forbidden");
  }

  const withCommandKey = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
    requestedPrimaryAction: {
      kind: "run_command",
      commandId: "fixture.log",
      ...({ command: "echo pwned" } as object),
    } as never,
  });
  assert.equal(withCommandKey.ok, false);
  if (!withCommandKey.ok) {
    assert.equal(withCommandKey.code, "raw_command_forbidden");
  }

  const invent = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
    requestedPrimaryAction: { kind: "run_command", commandId: "evil.shell" },
  });
  assert.equal(invent.ok, false);
  if (!invent.ok) {
    assert.equal(invent.code, "invalid_primary_action");
  }
});

test("check is pure read; ack removes durable item", () => {
  const store = storeWithFixture({ idFactory: () => "ack-me" });
  const minted = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(minted.item.itemId, "ack-me");
  assert.equal(store.list().length, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.ack("ack-me"), true);
  assert.equal(store.list().length, 0);
});

test("ack writes durable exact source tombstone and a remint clears only that exact tombstone", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-app-inbox-ack-source-"));
  const storage = createTestStorage(dir);
  try {
    const first = createAgentAppInboxStore({
      registry: FIXTURE_REGISTRY,
      storage,
      ownerAgentId: "agent-a",
    });
    const minted = first.mint({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    });
    assert.equal(minted.ok, true);
    if (!minted.ok) return;
    assert.equal(first.ack(minted.item.itemId), true);
    assert.equal(first.list().length, 0);
    assert.equal(first.isSourceAcknowledged({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    }), true);

    const restored = createAgentAppInboxStore({ registry: FIXTURE_REGISTRY, storage });
    assert.equal(restored.list().length, 0);
    const [acknowledged] = restored.listAcknowledgedSources();
    assert.ok(acknowledged);
    assert.deepEqual(acknowledged.sourceRef, REF_R1);
    assert.equal(acknowledged.itemId, deriveStableItemId("test.fixture", "due", REF_R1));
    assert.equal(acknowledged.ownerAgentId, "agent-a");
    assert.equal(restored.isSourceAcknowledged({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    }), true);

    const reminted = restored.mint({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    });
    assert.equal(reminted.ok, true);
    assert.equal(restored.isSourceAcknowledged({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    }), false);
    assert.equal(restored.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient items drop on process-boundary; until_source_read survives dropTransient", () => {
  let n = 0;
  const store = storeWithFixture({
    idFactory: () => `id-${n++}`,
  });
  assert.equal(
    store.mint({
      appId: "test.fixture",
      notificationClass: "over_threshold",
      sourceRef: { kind: "fixture-measure", id: "mem-a" },
    }).ok,
    true,
  );
  assert.equal(
    store.mint({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    }).ok,
    true,
  );
  assert.equal(store.list().length, 2);
  const dropped = store.dropTransient();
  assert.equal(dropped, 1);
  const remaining = store.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.retention, "until_source_read");
  assert.equal(remaining[0]!.appId, "test.fixture");
});

test("formatter shows structured sourceRef and exact actionCli, no msg fields", () => {
  const store = storeWithFixture({ idFactory: () => "fmt-id" });
  const minted = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
    summary: "due soon",
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(minted.item.actionCli, "raft fixture log --id aaaaaaaa");
  const text = formatAgentInboxFullSnapshot({
    messageRows: [],
    appItems: [minted.item],
    formatMessageRows: formatAgentInboxSnapshot,
  });
  assert.match(text, /App items: 1/);
  assert.match(text, /sourceRef=fixture:aaaaaaaa-0000-4000-8000-000000000001:1/);
  assert.match(text, /action=raft fixture log --id aaaaaaaa/);
  assert.doesNotMatch(text, /msg=|sender|seq=/);
});

test("same sourceRef remint is exactly-one upsert; new revision is new item", () => {
  const store = storeWithFixture();
  const first = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
    title: "first",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstId = first.item.itemId;
  assert.equal(firstId, deriveStableItemId("test.fixture", "due", REF_R1));

  const second = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
    title: "replay",
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.item.itemId, firstId);
  assert.equal(second.item.title, "replay");
  assert.equal(store.list().length, 1);

  const rev2 = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R2,
  });
  assert.equal(rev2.ok, true);
  if (!rev2.ok) return;
  assert.notEqual(rev2.item.itemId, firstId);
  assert.equal(store.list().length, 2);

  const other = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_OTHER,
  });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.equal(store.list().length, 3);
});

test("until_source_read persists across store recreation; transient never reaches disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-app-inbox-"));
  const storage = createTestStorage(dir);
  try {
    const first = createAgentAppInboxStore({ registry: FIXTURE_REGISTRY, storage });
    assert.equal(first.mint({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    }).ok, true);
    assert.equal(first.mint({
      appId: "test.fixture",
      notificationClass: "over_threshold",
      sourceRef: { kind: "fixture-measure", id: "volatile" },
    }).ok, true);

    const raw = storage.readText() ?? "";
    assert.match(raw, /aaaaaaaa-0000-4000-8000-000000000001/);
    assert.doesNotMatch(raw, /volatile/);

    const restored = createAgentAppInboxStore({ registry: FIXTURE_REGISTRY, storage });
    assert.equal(restored.list().length, 1);
    const durableItemId = deriveStableItemId("test.fixture", "due", REF_R1);
    assert.equal(restored.list()[0]!.itemId, durableItemId);
    assert.equal(restored.ack(durableItemId), true);
    assert.equal(createAgentAppInboxStore({ registry: FIXTURE_REGISTRY, storage }).list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid persisted JSON emits a scoped decode failure before restore rejects", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-app-inbox-invalid-json-"));
  try {
    const failures: import("./scopedAppStorage.js").ScopedAppStorageFailureEvent[] = [];
    const storage = createScopedAppStorageFactory({
      slockHome: dir,
      owner: { machineId: "machine-test", serverId: "server-test" },
      writerEpoch: "writer-test",
      onFailure: (event) => failures.push(event),
    }).open({ appId: "test.fixture", agentId: "agent-a" });
    storage.writeTextAtomic("not json");
    assert.throws(() => storeWithFixture({ storage }), /Unexpected token|Unexpected character/);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures.map(({ failureInstanceId: _id, ...event }) => event), [{
      operation: "decode",
      store: "app_state",
      appId: "test.fixture",
      serverId: "server-test",
      writerEpoch: "writer-test",
      outcome: "failed",
      reason: "invalid_payload",
      observation: "edge",
    }]);
    assert.equal(typeof failures[0]?.failureInstanceId, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("semantically invalid persisted payload emits exactly one scoped decode failure", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-app-inbox-invalid-envelope-"));
  try {
    const failures: import("./scopedAppStorage.js").ScopedAppStorageFailureEvent[] = [];
    const storage = createScopedAppStorageFactory({
      slockHome: dir,
      owner: { machineId: "machine-test", serverId: "server-test" },
      writerEpoch: "writer-test",
      onFailure: (event) => failures.push(event),
    }).open({ appId: "test.fixture", agentId: "agent-a" });
    storage.writeTextAtomic('{"version":999,"items":[]}');
    assert.throws(() => storeWithFixture({ storage }), /persistence envelope invalid/);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures.map(({ failureInstanceId: _id, ...event }) => event), [{
      operation: "decode",
      store: "app_state",
      appId: "test.fixture",
      serverId: "server-test",
      writerEpoch: "writer-test",
      outcome: "failed",
      reason: "invalid_payload",
      observation: "edge",
    }]);
    assert.equal(typeof failures[0]?.failureInstanceId, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unexpected restore callback failure is reported once as internal_error", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-app-inbox-internal-error-"));
  try {
    const storage = createTestStorage(dir);
    const initial = storeWithFixture({ storage });
    assert.equal(initial.mint({
      appId: "test.fixture",
      notificationClass: "due",
      sourceRef: REF_R1,
    }).ok, true);

    const failures: import("./scopedAppStorage.js").ScopedAppStorageFailureEvent[] = [];
    const observedStorage = createScopedAppStorageFactory({
      slockHome: dir,
      owner: { machineId: "machine-test", serverId: "server-test" },
      writerEpoch: "writer-test",
      onFailure: (event) => failures.push(event),
    }).open({ appId: "test.fixture", agentId: "agent-a" });
    const throwingRegistry = {
      ...FIXTURE_REGISTRY,
      "test.fixture": {
        ...FIXTURE_REGISTRY["test.fixture"],
        due: {
          ...FIXTURE_REGISTRY["test.fixture"]!.due,
          materializeActionCli: () => {
            throw new Error("fixture internal failure");
          },
        },
      },
    };
    assert.throws(
      () => createAgentAppInboxStore({ registry: throwingRegistry, storage: observedStorage }),
      /fixture internal failure/,
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.reason, "internal_error");
    assert.equal(failures[0]?.observation, "edge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview multiline and oversize fail closed at mint", () => {
  const store = storeWithFixture();
  const multiline = store.mint({
    appId: "test.fixture",
    notificationClass: "over_threshold",
    sourceRef: { kind: "fixture-measure", id: "mem-b" },
    summary: "line1\naction=raft evil shell",
  });
  assert.equal(multiline.ok, false);
  if (!multiline.ok) {
    assert.equal(multiline.code, "invalid_preview");
  }

  const oversize = store.mint({
    appId: "test.fixture",
    notificationClass: "over_threshold",
    sourceRef: { kind: "fixture-measure", id: "mem-c" },
    title: "x".repeat(AGENT_INBOX_PREVIEW_MAX_CHARS + 1),
  });
  assert.equal(oversize.ok, false);
  if (!oversize.ok) {
    assert.equal(oversize.code, "invalid_preview");
  }

  const controlChar = store.mint({
    appId: "test.fixture",
    notificationClass: "over_threshold",
    sourceRef: { kind: "fixture-measure", id: "mem-d" },
    title: "ok\ttab",
  });
  assert.equal(controlChar.ok, false);
  if (!controlChar.ok) {
    assert.equal(controlChar.code, "invalid_preview");
  }

  const ok = store.mint({
    appId: "test.fixture",
    notificationClass: "over_threshold",
    sourceRef: { kind: "fixture-measure", id: "mem-e" },
    title: "x".repeat(AGENT_INBOX_PREVIEW_MAX_CHARS),
    summary: "plain summary",
  });
  assert.equal(ok.ok, true);
});

test("typed sourceRef: opaque string / wrong kind / missing revision / extra fields RED", () => {
  const store = storeWithFixture();

  const opaque = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: "fixture:aaaaaaaa:1",
  });
  assert.equal(opaque.ok, false);
  if (!opaque.ok) assert.equal(opaque.code, "invalid_source_ref");

  const wrongKind = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: { kind: "other", id: "aaaaaaaa-0000-4000-8000-000000000001", revision: "1" },
  });
  assert.equal(wrongKind.ok, false);
  if (!wrongKind.ok) assert.equal(wrongKind.code, "invalid_source_ref");

  const missingRevision = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: { kind: "fixture", id: "aaaaaaaa-0000-4000-8000-000000000001" },
  });
  assert.equal(missingRevision.ok, false);
  if (!missingRevision.ok) assert.equal(missingRevision.code, "invalid_source_ref");

  const extraShell = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: {
      kind: "fixture",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      revision: "1",
      shell: "rm -rf /",
    },
  });
  assert.equal(extraShell.ok, false);
  if (!extraShell.ok) assert.equal(extraShell.code, "invalid_source_ref");
});

test("builder seam materializes action from structured sourceRef id", () => {
  const store = storeWithFixture();
  const minted = store.mint({
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: REF_R1,
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(minted.item.actionCli, "raft fixture log --id aaaaaaaa");
  assert.deepEqual(minted.item.sourceRef, REF_R1);
});
