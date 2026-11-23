import assert from "node:assert/strict";

import type { ServerToMachineMessage } from "@botiverse/raft-shared";

import { REPLICA_HOP_SEAL_TTL_MS, __clearReplicaHopSealsForTests, openAfterReplicaHop, sealForReplicaHop } from "./runtimeAuthReplicaSeal";

const API_KEY = "sk-Zq7XwP3mT9vK2rL8nB4cY6dF1gH5jJ0a";
const connect: ServerToMachineMessage = {
  type: "machine:runtime_auth:connect_provider",
  requestId: "req-1",
  runtime: "qwen",
  providerId: "custom-openai-compatible",
  apiKey: API_KEY,
  baseUrl: "http://127.0.0.1:11434/v1",
  modelIds: ["qwen3-coder"],
};
const NOW = 1_800_000_000_000;

/** What Redis pub/sub carries, as the receiving replica reads it back. */
const overRedis = (msg: ServerToMachineMessage) => JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
const asMessage = (wire: Record<string, unknown>) => wire as unknown as ServerToMachineMessage;

const previous = { jwt: process.env.JWT_SECRET, replay: process.env.SLOCK_REPLICA_REPLAY_SECRET };
beforeEach(() => {
  __clearReplicaHopSealsForTests();
  process.env.JWT_SECRET = "replica-hop-test-secret";
  delete process.env.SLOCK_REPLICA_REPLAY_SECRET;
});
afterAll(() => {
  for (const [name, value] of [["JWT_SECRET", previous.jwt], ["SLOCK_REPLICA_REPLAY_SECRET", previous.replay]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("a provider connect crosses replicas sealed whole: nothing it acts on is readable or changeable on the way", () => {
  const wire = overRedis(sealForReplicaHop("machine-1", connect, NOW));
  assert.deepEqual(Object.keys(wire).sort(), ["requestId", "sealed", "type"], "only the type and request id are readable");
  for (const secretOrSetting of [API_KEY, "127.0.0.1", "qwen3-coder", "custom-openai-compatible"]) {
    assert.ok(!JSON.stringify(wire).includes(secretOrSetting), secretOrSetting);
  }
  // A field added on the way is not what the Computer gets: the sealed message is.
  const withAttackerEndpoint = asMessage({ ...wire, baseUrl: "http://attacker.example/v1", providerId: "deepseek" });
  assert.deepEqual(openAfterReplicaHop("machine-1", withAttackerEndpoint, NOW), { ok: true, message: connect });
});

test("a sealed connect opens for its own Computer and request only, unchanged, and only once", () => {
  const wire = overRedis(sealForReplicaHop("machine-1", connect, NOW));
  const refusal = (machineId: string, message: Record<string, unknown>, now = NOW) => {
    const opened = openAfterReplicaHop(machineId, asMessage(message), now);
    assert.ok(!JSON.stringify(opened).includes(API_KEY));
    return opened.ok ? null : opened.reason;
  };
  assert.equal(refusal("machine-2", wire), "unopenable", "bound to its Computer");
  assert.equal(refusal("machine-1", { ...wire, requestId: "req-2" }), "unopenable", "and to its request");
  const [version, iv, tag, sealed] = String(wire.sealed).split(":") as [string, string, string, string];
  // One flipped character at the start of the ciphertext (a final base64 character may carry only padding bits).
  const flipped = `${sealed[0] === "A" ? "B" : "A"}${sealed.slice(1)}`;
  assert.equal(refusal("machine-1", { ...wire, sealed: [version, iv, tag, flipped].join(":") }), "unopenable", "a changed ciphertext (endpoint, key, anything) fails to open");
  assert.equal(refusal("machine-1", { ...wire, sealed: [version, iv, tag].join(":") }), "malformed");

  assert.deepEqual(openAfterReplicaHop("machine-1", asMessage(wire), NOW + 1_000), { ok: true, message: connect });
  assert.equal(refusal("machine-1", wire, NOW + 2_000), "replayed", "a second copy of the same request is refused");
});

test("a sealed connect with a truncated or padded auth tag, or a wrong-size IV, is refused", () => {
  const wire = overRedis(sealForReplicaHop("machine-1", connect, NOW));
  const [version, iv, tag, sealed] = String(wire.sealed).split(":");
  const tagBytes = Buffer.from(tag!, "base64url");
  const withParts = (nextIv: string, nextTag: string) => asMessage({ ...wire, sealed: [version, nextIv, nextTag, sealed].join(":") });
  // A genuine tag cut short: GCM without a pinned tag length would verify only these bytes.
  for (const bytes of [4, 8, 12, 15]) {
    assert.deepEqual(openAfterReplicaHop("machine-1", withParts(iv!, tagBytes.subarray(0, bytes).toString("base64url")), NOW), {
      ok: false, reason: "malformed", requestId: "req-1",
    }, `a ${bytes}-byte tag`);
  }
  assert.equal(
    (openAfterReplicaHop("machine-1", withParts(iv!, Buffer.concat([tagBytes, Buffer.from([0])]).toString("base64url")), NOW) as { reason?: string }).reason,
    "malformed",
    "a 17-byte tag",
  );
  assert.equal(
    (openAfterReplicaHop("machine-1", withParts(Buffer.from(iv!, "base64url").subarray(0, 8).toString("base64url"), tag!), NOW) as { reason?: string }).reason,
    "malformed",
    "an 8-byte IV",
  );
  // None of them used up the request: the genuine seal still opens once.
  assert.equal(openAfterReplicaHop("machine-1", asMessage(wire), NOW).ok, true);
});

test("a sealed connect is refused once it is too old, or sealed with another secret", () => {
  const late = overRedis(sealForReplicaHop("machine-1", connect, NOW));
  const late2 = overRedis(sealForReplicaHop("machine-1", { ...connect, requestId: "req-late" } as ServerToMachineMessage, NOW));
  assert.deepEqual(openAfterReplicaHop("machine-1", asMessage(late), NOW + REPLICA_HOP_SEAL_TTL_MS + 1), { ok: false, reason: "expired", requestId: "req-1" });
  assert.equal((openAfterReplicaHop("machine-1", asMessage(late2), NOW - REPLICA_HOP_SEAL_TTL_MS - 1) as { reason: string }).reason, "expired", "nor one from a clock far ahead");

  const fresh = overRedis(sealForReplicaHop("machine-1", { ...connect, requestId: "req-rotated" } as ServerToMachineMessage, NOW));
  process.env.SLOCK_REPLICA_REPLAY_SECRET = "a-different-replica-secret";
  assert.deepEqual(openAfterReplicaHop("machine-1", asMessage(fresh), NOW), { ok: false, reason: "unopenable", requestId: "req-rotated" });
});

test("a connect that arrives from another replica unsealed is never written to a socket; other messages pass unchanged", () => {
  assert.deepEqual(openAfterReplicaHop("machine-1", connect, NOW), { ok: false, reason: "unsealed", requestId: "req-1" }, "a key in the clear on the hop is refused, not forwarded");
  const logout: ServerToMachineMessage = { type: "machine:runtime_auth:logout", requestId: "req-3", runtime: "claude" };
  assert.equal(sealForReplicaHop("machine-1", logout), logout);
  assert.deepEqual(openAfterReplicaHop("machine-1", logout), { ok: true, message: logout });
});

test("without a server secret the connect is not sent across replicas at all, and openAfterReplicaHop returns unopenable instead of throwing", () => {
  const wire = overRedis(sealForReplicaHop("machine-1", connect, NOW));
  delete process.env.JWT_SECRET;
  delete process.env.SLOCK_REPLICA_REPLAY_SECRET;
  assert.throws(() => sealForReplicaHop("machine-1", connect), (error: Error) => !error.message.includes(API_KEY));
  assert.deepEqual(openAfterReplicaHop("machine-1", asMessage(wire), NOW), { ok: false, reason: "unopenable", requestId: "req-1" });
});

test("agent:start and agent:config support rolling-deploy receive_only, staged seal, and strict enforcement modes (#proj-runtime:#79)", () => {
  const startMsg: ServerToMachineMessage = {
    type: "agent:start",
    agentId: "agent-1",
    config: {
      name: "alpha",
      displayName: "Alpha",
      description: null,
      model: "claude-opus-4-6",
      runtime: "claude",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "custom", apiUrl: "https://gw.example.test/v1", apiKey: API_KEY },
        model: { kind: "custom", name: "claude-opus-4-6" },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars: { SECRET_ENV: API_KEY },
      },
      reasoningEffort: null,
      executionMode: "byoc",
      envVars: { ANTHROPIC_API_KEY: API_KEY },
      sessionId: null,
      serverUrl: "https://raft.example.test",
      authToken: "",
    },
  };
  const configMsg: ServerToMachineMessage = {
    type: "agent:config",
    agentId: "agent-1",
    config: startMsg.config,
    revision: 3,
  };

  // 1. Default receive_only (PR 1 rolling-deploy safe): receive-ready without breaking older replicas
  assert.equal(sealForReplicaHop("machine-1", startMsg, NOW, "receive_only"), startMsg);
  assert.deepEqual(openAfterReplicaHop("machine-1", startMsg, NOW, "receive_only"), { ok: true, message: startMsg });

  // 2. Staged send-sealing ("seal"): seals outbound frames while still accepting unsealed from draining peers
  const stagedWire = overRedis(sealForReplicaHop("machine-1", startMsg, NOW, "seal"));
  assert.equal(JSON.stringify(stagedWire).includes(API_KEY), false);
  // Even in default receive_only mode, a new replica opens sealed frames strictly!
  assert.deepEqual(openAfterReplicaHop("machine-1", asMessage(stagedWire), NOW, "receive_only"), { ok: true, message: startMsg });
  assert.deepEqual(openAfterReplicaHop("machine-1", asMessage(stagedWire), NOW, "receive_only"), { ok: false, reason: "replayed", requestId: null });

  // 3. Strict mode ("strict"): seals outbound AND refuses unsealed, tampered, replayed, or wrong-machine copies
  for (const original of [startMsg, configMsg]) {
    const wire = overRedis(sealForReplicaHop("machine-1", original, NOW, "strict"));
    assert.equal(JSON.stringify(wire).includes(API_KEY), false, `${original.type}: key must not appear on the Redis wire`);
    assert.equal(sealForReplicaHop("machine-1", asMessage(wire), NOW, "strict"), wire, `${original.type}: already-sealed hop is not double-sealed`);

    assert.deepEqual(
      openAfterReplicaHop("machine-2", asMessage(wire), NOW, "strict"),
      { ok: false, reason: "unopenable", requestId: null },
      `${original.type}: wrong machine cannot open`,
    );
    assert.deepEqual(
      openAfterReplicaHop("machine-1", asMessage({ ...wire, agentId: "agent-other" }), NOW, "strict"),
      { ok: false, reason: "unopenable", requestId: null },
      `${original.type}: wrong agentId cannot open`,
    );
    assert.deepEqual(
      openAfterReplicaHop("machine-1", original, NOW, "strict"),
      { ok: false, reason: "unsealed", requestId: null },
      `${original.type}: unsealed frame on Redis is refused in strict mode`,
    );
    assert.deepEqual(openAfterReplicaHop("machine-1", asMessage(wire), NOW, "strict"), { ok: true, message: original });
    assert.deepEqual(
      openAfterReplicaHop("machine-1", asMessage(wire), NOW, "strict"),
      { ok: false, reason: "replayed", requestId: null },
      `${original.type}: second open is refused as replay`,
    );
  }
});

test("replay cache evicts expired head entries in insertion order while keeping unexpired entries", () => {
  const mkStart = (agentId: string): ServerToMachineMessage => ({
    type: "agent:config",
    agentId,
    revision: 1,
    config: {
      name: agentId,
      displayName: agentId,
      description: null,
      model: "claude-opus-4-6",
      runtime: "claude",
      reasoningEffort: null,
      envVars: null,
      sessionId: null,
      serverUrl: "https://raft.example.test",
      authToken: "",
    },
  });
  const wireOld = overRedis(sealForReplicaHop("machine-1", mkStart("agent-old"), NOW, "seal"));
  const wireMid = overRedis(sealForReplicaHop("machine-1", mkStart("agent-mid"), NOW + 30_000, "seal"));
  const wireNew = overRedis(sealForReplicaHop("machine-1", mkStart("agent-new"), NOW + REPLICA_HOP_SEAL_TTL_MS + 1_000, "seal"));

  assert.equal(openAfterReplicaHop("machine-1", asMessage(wireOld), NOW, "seal").ok, true);
  assert.equal(openAfterReplicaHop("machine-1", asMessage(wireMid), NOW + 30_000, "seal").ok, true);
  // At NOW + TTL + 1s, wireOld has expired and is evicted from head; wireMid is still live and must remain protected against replay.
  const later = NOW + REPLICA_HOP_SEAL_TTL_MS + 1_000;
  assert.equal(openAfterReplicaHop("machine-1", asMessage(wireNew), later, "seal").ok, true);
  assert.deepEqual(
    openAfterReplicaHop("machine-1", asMessage(wireMid), later, "seal"),
    { ok: false, reason: "replayed", requestId: null },
  );
  assert.deepEqual(
    openAfterReplicaHop("machine-1", asMessage(wireOld), later, "seal"),
    { ok: false, reason: "expired", requestId: null },
  );
});
