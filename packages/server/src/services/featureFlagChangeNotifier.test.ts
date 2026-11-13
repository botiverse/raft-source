import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  SERVER_FEATURES_CHANGED_SOCKET_EVENT,
  type ServerFeaturesChangedEvent,
  type ServerFeaturesChangedMachineMessage,
} from "@botiverse/raft-shared";
import { describe, test as unitTest } from "vitest";
import { getDb } from "../db/index";
import { labDefinitions } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import {
  createFeatureFlagChangeNotifier,
  diffFeatureFlagConfig,
  featureFlagKeysAffecting,
  startFeatureFlagChangeNotifier,
  type FeatureFlagChangeNotifier,
  type FeatureFlagConfigSnapshot,
  type FeatureFlagSnapshotFlag,
  type FeatureFlagSnapshotRule,
  type FeaturesChangedTransport,
} from "./featureFlagChangeNotifier";
import { computeFeatureFlagBucket } from "./featureFlagService";
import { setServerLabEnrollment, setServerLabsAccess } from "./serverLabService";

// ---------------------------------------------------------------------------
// Fakes: one "replica" = its own sockets and machine connections plus a shared
// peer bus standing in for socket.io's Redis-adapter serverSideEmit.

type FakeSocket = { id: string; serverId: string | null; userId: string; received: ServerFeaturesChangedEvent[] };
type FakeMachine = { id: string; serverId: string; received: ServerFeaturesChangedMachineMessage[] };

class PeerBus {
  private replicas = new Set<FakeReplica>();
  join(replica: FakeReplica) {
    this.replicas.add(replica);
    return () => this.replicas.delete(replica);
  }
  publish(from: FakeReplica, change: ServerFeaturesChangedEvent) {
    // serverSideEmit reaches every OTHER replica, not the sender.
    for (const replica of this.replicas) if (replica !== from) replica.peerHandler?.(structuredClone(change));
  }
}

class FakeReplica {
  sockets: FakeSocket[] = [];
  machines: FakeMachine[] = [];
  peerHandler: ((change: ServerFeaturesChangedEvent) => void) | null = null;
  constructor(private bus: PeerBus) {}

  socket(serverId: string | null, userId: string = randomUUID()): FakeSocket {
    const socket = { id: randomUUID(), serverId, userId, received: [] };
    this.sockets.push(socket);
    return socket;
  }

  machine(serverId: string): FakeMachine {
    const machine = { id: randomUUID(), serverId, received: [] };
    this.machines.push(machine);
    return machine;
  }

  transport(): FeaturesChangedTransport {
    return {
      localSockets: () => this.sockets.map((socket) => ({
        serverId: socket.serverId,
        userId: socket.userId,
        emit: (event: ServerFeaturesChangedEvent) => socket.received.push(structuredClone(event)),
      })),
      localMachines: () => this.machines.map((machine) => ({
        serverId: machine.serverId,
        send: (message: ServerFeaturesChangedMachineMessage) => machine.received.push(structuredClone(message)),
      })),
      publishServerChange: (change) => this.bus.publish(this, change),
      onPeerServerChange: (handler) => {
        this.peerHandler = handler;
        const leave = this.bus.join(this);
        return () => {
          this.peerHandler = null;
          leave();
        };
      },
    };
  }
}

const FAST = { pollIntervalMs: 0, quietMs: 40, maxWaitMs: 400, emitBatchIntervalMs: 5 } as const;

// ---------------------------------------------------------------------------
// Pure diff and targeting

function flag(overrides: Partial<FeatureFlagSnapshotFlag> = {}): FeatureFlagSnapshotFlag {
  return { enabled: true, killSwitch: false, randomizationUnit: "server", defaultEnabled: false, defaultVariant: null, salt: "s", ...overrides };
}

function rule(overrides: Partial<FeatureFlagSnapshotRule> & Pick<FeatureFlagSnapshotRule, "flagKey" | "stage">): FeatureFlagSnapshotRule {
  return {
    priority: 0,
    decision: "allow",
    values: [],
    percentageBasisPoints: null,
    variant: null,
    clientOs: null,
    minClientBuild: null,
    clientBuildTypes: null,
    ...overrides,
  };
}

function snapshot(input: {
  flags?: Record<string, FeatureFlagSnapshotFlag>;
  rules?: Record<string, FeatureFlagSnapshotRule>;
  audiences?: Record<string, { enabled: boolean; members: string[] }>;
  labs?: Record<string, string>;
}): FeatureFlagConfigSnapshot {
  return {
    version: 0,
    flags: new Map(Object.entries(input.flags ?? {})),
    rules: new Map(Object.entries(input.rules ?? {})),
    audiences: new Map(Object.entries(input.audiences ?? {}).map(([key, value]) => [key, { enabled: value.enabled, members: new Set(value.members) }])),
    labs: new Map(Object.entries(input.labs ?? {})),
  };
}

describe("diffFeatureFlagConfig + featureFlagKeysAffecting", () => {
  const serverA = "00000000-0000-4000-8000-0000000000a1";
  const serverB = "00000000-0000-4000-8000-0000000000b1";
  const userA = "00000000-0000-4000-8000-0000000000c1";
  const userB = "00000000-0000-4000-8000-0000000000c2";

  unitTest("a server-allowlist edit reaches only the listed Servers, clients and Computers alike", () => {
    const before = snapshot({ flags: { f: flag() } });
    const after = snapshot({ flags: { f: flag() }, rules: { r1: rule({ flagKey: "f", stage: "server", values: [serverA] }) } });
    const changes = diffFeatureFlagConfig(before, after);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverA, userId: userA, client: true }), ["f"]);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverA, userId: null, client: false }), ["f"]);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverB, userId: userA, client: true }), []);
  });

  unitTest("a user-rule edit reaches only that user's sockets, never a Computer", () => {
    const before = snapshot({ flags: { f: flag() } });
    const after = snapshot({ flags: { f: flag() }, rules: { r1: rule({ flagKey: "f", stage: "user", values: [userA] }) } });
    const changes = diffFeatureFlagConfig(before, after);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverB, userId: userA, client: true }), ["f"]);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverA, userId: userB, client: true }), []);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverA, userId: null, client: false }), []);
  });

  unitTest("kill switch, default and flag create/delete reach everyone", () => {
    for (const after of [
      snapshot({ flags: { f: flag({ killSwitch: true }) } }),
      snapshot({ flags: { f: flag({ defaultEnabled: true }) } }),
      snapshot({ flags: {} }),
    ]) {
      const changes = diffFeatureFlagConfig(snapshot({ flags: { f: flag() } }), after);
      assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverB, userId: null, client: false }), ["f"]);
    }
  });

  unitTest("nothing evaluation reads changed: no keys", () => {
    const before = snapshot({ flags: { f: flag() }, rules: { r1: rule({ flagKey: "f", stage: "server", values: [serverA, serverB] }) } });
    // Same rule, values in another order: matching ignores order.
    const after = snapshot({ flags: { f: flag() }, rules: { r1: rule({ flagKey: "f", stage: "server", values: [serverB, serverA] }) } });
    assert.equal(diffFeatureFlagConfig(before, after).size, 0);
  });

  unitTest("a percentage ramp reaches only the units whose bucket crossed", () => {
    const servers = Array.from({ length: 200 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const before = snapshot({ flags: { f: flag({ salt: "ramp" }) }, rules: { p: rule({ flagKey: "f", stage: "percentage", percentageBasisPoints: 1000 }) } });
    const after = snapshot({ flags: { f: flag({ salt: "ramp" }) }, rules: { p: rule({ flagKey: "f", stage: "percentage", percentageBasisPoints: 3000 }) } });
    const changes = diffFeatureFlagConfig(before, after);
    let notified = 0;
    for (const serverId of servers) {
      const bucket = computeFeatureFlagBucket({ key: "f", salt: "ramp", unit: "server", unitId: serverId });
      const keys = featureFlagKeysAffecting(changes, { serverId, userId: null, client: false });
      assert.deepEqual(keys, bucket >= 1000 && bucket < 3000 ? ["f"] : [], `bucket ${bucket}`);
      if (keys.length > 0) notified += 1;
    }
    assert.ok(notified > 0 && notified < servers.length);
  });

  unitTest("audience membership edits reach only the added or removed members", () => {
    const rules = { a: rule({ flagKey: "f", stage: "audience", values: ["insiders"] }) };
    const before = snapshot({ flags: { f: flag() }, rules, audiences: { insiders: { enabled: true, members: [`user:${userA}`] } } });
    const after = snapshot({ flags: { f: flag() }, rules, audiences: { insiders: { enabled: true, members: [`user:${userA}`, `server:${serverA}`] } } });
    const changes = diffFeatureFlagConfig(before, after);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverA, userId: userB, client: true }), ["f"]);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverB, userId: userA, client: true }), []);
  });

  unitTest("platform rules reach human clients, not Computers", () => {
    const before = snapshot({ flags: { f: flag() } });
    const after = snapshot({ flags: { f: flag() }, rules: { p: rule({ flagKey: "f", stage: "platform", values: ["web"] }) } });
    const changes = diffFeatureFlagConfig(before, after);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverA, userId: userA, client: true }), ["f"]);
    assert.deepEqual(featureFlagKeysAffecting(changes, { serverId: serverA, userId: null, client: false }), []);
  });
});

// ---------------------------------------------------------------------------
// Through the real write path (Feature Flag Admin's SQL) on two replicas

/** What Feature Flag Admin's Worker does: write the row and bump the cursor in one transaction. */
async function ffaWrite(statement: ReturnType<typeof sql>): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(statement);
    await tx.execute(sql`
      INSERT INTO feature_flag_config_versions (scope, version, updated_at, updated_by)
      VALUES ('global', 1, NOW(), 'ffa-test')
      ON CONFLICT (scope) DO UPDATE SET version = feature_flag_config_versions.version + 1, updated_at = NOW()
    `);
  });
}

async function ffaCreateFlag(key: string, unit: "server" | "user" = "server"): Promise<void> {
  await ffaWrite(sql`
    INSERT INTO feature_flags (key, enabled, kill_switch, randomization_unit, default_enabled, salt)
    VALUES (${key}, true, false, ${unit}, false, ${`salt-${key}`})
  `);
}

async function ffaAllowServers(flagKey: string, serverIds: string[]): Promise<void> {
  await ffaWrite(sql`
    INSERT INTO feature_flag_rules (id, flag_key, stage, priority, decision, values)
    VALUES (${randomUUID()}, ${flagKey}, 'server', 0, 'allow', ${JSON.stringify(serverIds)}::jsonb)
  `);
}

async function pollAll(notifiers: FeatureFlagChangeNotifier[]): Promise<void> {
  await Promise.all(notifiers.map((notifier) => notifier.pollOnce()));
}

async function settle(notifiers: FeatureFlagChangeNotifier[]): Promise<void> {
  await Promise.all(notifiers.map((notifier) => notifier.idle()));
}

function twoReplicas() {
  const bus = new PeerBus();
  const replicas = [new FakeReplica(bus), new FakeReplica(bus)] as const;
  const notifiers = replicas.map((replica) => createFeatureFlagChangeNotifier({ transport: replica.transport(), ...FAST }));
  return { replicas, notifiers };
}

dbTest("an FFA rule change sends exactly one event per affected connection on every replica, with only its own server id", async ({ db }) => {
  void db;
  const serverA = randomUUID();
  const serverB = randomUUID();
  await ffaCreateFlag("ffe_allowlist_v0");
  const { replicas, notifiers } = twoReplicas();
  try {
    await pollAll(notifiers); // baseline
    const a1 = replicas[0].socket(serverA);
    const a2 = replicas[1].socket(serverA);
    const b1 = replicas[0].socket(serverB);
    const b2 = replicas[1].socket(serverB);
    const noServer = replicas[1].socket(null);
    const computerA = replicas[1].machine(serverA);
    const computerB = replicas[0].machine(serverB);

    await ffaAllowServers("ffe_allowlist_v0", [serverA]);
    await pollAll(notifiers);
    await settle(notifiers);
    // Later polls with no new write send nothing more.
    await pollAll(notifiers);
    await settle(notifiers);

    const expected = { serverId: serverA, keys: ["ffe_allowlist_v0"] };
    assert.deepEqual(a1.received, [expected]);
    assert.deepEqual(a2.received, [expected]);
    assert.deepEqual(computerA.received, [{ type: SERVER_FEATURES_CHANGED_SOCKET_EVENT, ...expected }]);
    assert.deepEqual(b1.received, []);
    assert.deepEqual(b2.received, []);
    assert.deepEqual(noServer.received, []);
    assert.deepEqual(computerB.received, []);
  } finally {
    for (const notifier of notifiers) notifier.stop();
  }
});

dbTest("a burst of FFA edits inside the quiet window is one event carrying every changed key", async ({ db }) => {
  void db;
  const serverA = randomUUID();
  await ffaCreateFlag("ffe_burst_a_v0");
  await ffaCreateFlag("ffe_burst_b_v0");
  const { replicas, notifiers } = twoReplicas();
  try {
    await pollAll(notifiers);
    const socket = replicas[0].socket(serverA);
    for (const key of ["ffe_burst_a_v0", "ffe_burst_b_v0"]) {
      await ffaAllowServers(key, [serverA]);
      await pollAll(notifiers); // each poll sees a new cursor and restarts the quiet timer
    }
    await ffaWrite(sql`UPDATE feature_flags SET kill_switch = true WHERE key = 'ffe_burst_a_v0'`);
    await pollAll(notifiers);
    await settle(notifiers);

    assert.deepEqual(socket.received, [{ serverId: serverA, keys: ["ffe_burst_a_v0", "ffe_burst_b_v0"] }]);
  } finally {
    for (const notifier of notifiers) notifier.stop();
  }
});

dbTest("a cursor bump that changes nothing evaluation reads sends nothing", async ({ db }) => {
  void db;
  const serverA = randomUUID();
  await ffaCreateFlag("ffe_noop_v0");
  const { replicas, notifiers } = twoReplicas();
  try {
    await pollAll(notifiers);
    const socket = replicas[0].socket(serverA);
    const computer = replicas[1].machine(serverA);
    await ffaWrite(sql`UPDATE feature_flags SET description = 'renamed', updated_at = NOW() WHERE key = 'ffe_noop_v0'`);
    await pollAll(notifiers);
    await settle(notifiers);
    assert.deepEqual(socket.received, []);
    assert.deepEqual(computer.received, []);
  } finally {
    for (const notifier of notifiers) notifier.stop();
  }
});

dbTest("a change that reaches everyone is paced in batches", async ({ db }) => {
  void db;
  await ffaCreateFlag("ffe_paced_v0");
  const replica = new FakeReplica(new PeerBus());
  const notifier = createFeatureFlagChangeNotifier({ transport: replica.transport(), ...FAST, emitBatchSize: 2, emitBatchIntervalMs: 60 });
  try {
    await notifier.pollOnce();
    const sockets = Array.from({ length: 5 }, () => replica.socket(randomUUID()));
    await ffaWrite(sql`UPDATE feature_flags SET default_enabled = true WHERE key = 'ffe_paced_v0'`);
    await notifier.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, FAST.quietMs + 30));
    const firstBatch = sockets.filter((socket) => socket.received.length > 0).length;
    assert.equal(firstBatch, 2);
    await notifier.idle();
    for (const socket of sockets) assert.deepEqual(socket.received, [{ serverId: socket.serverId, keys: ["ffe_paced_v0"] }]);
  } finally {
    notifier.stop();
  }
});

dbTest("a Server Labs enrollment change notifies that one Server on every replica, once", async ({ db, seed }) => {
  void db;
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const other = await seed.server({ owner });
  const bus = new PeerBus();
  const local = new FakeReplica(bus);
  const peer = new FakeReplica(bus);
  // The process-wide notifier (what server.ts starts) and a second replica.
  const started = startFeatureFlagChangeNotifier({ transport: local.transport(), ...FAST });
  const peerNotifier = createFeatureFlagChangeNotifier({ transport: peer.transport(), ...FAST });
  try {
    const actor = { type: "human" as const, id: owner.id };
    const access = await setServerLabsAccess({ serverId: server.id, enabled: true, expectedVersion: 0, actor, requestId: randomUUID() });
    await getDb().insert(labDefinitions).values({ key: "ffe-lab", name: "FFE Lab", description: "Lab for the features-changed test", state: "open" });
    await ffaCreateFlag("ffe_lab_v0");
    await ffaWrite(sql`
      INSERT INTO feature_flag_rules (id, flag_key, stage, priority, decision, values)
      VALUES (${randomUUID()}, 'ffe_lab_v0', 'lab', 0, 'allow', '["ffe-lab"]'::jsonb)
    `);
    await settle([started, peerNotifier]);

    const here = local.socket(server.id, owner.id);
    const there = peer.socket(server.id, owner.id);
    const otherServer = peer.socket(other.id, owner.id);
    const computer = peer.machine(server.id);
    const version = access.labs.version;
    await setServerLabEnrollment({ serverId: server.id, labKey: "ffe-lab", enabled: true, expectedVersion: version, actor, requestId: randomUUID() });
    // Wait for the after-commit key lookup to queue the change, then for the flush.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle([started, peerNotifier]);

    const expected = { serverId: server.id, keys: ["ffe_lab_v0"] };
    assert.deepEqual(here.received, [expected]);
    assert.deepEqual(there.received, [expected]);
    assert.deepEqual(computer.received, [{ type: SERVER_FEATURES_CHANGED_SOCKET_EVENT, ...expected }]);
    assert.deepEqual(otherServer.received, []);
  } finally {
    started.stop();
    peerNotifier.stop();
  }
});
