import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test } from "vitest";
import {
  agentIdHashAttrs,
  apiKeyPrefixHashAttrs,
  exportTraceIdentityKeyHex,
  serverIdHashAttrs,
  traceAgentIdHash,
  traceServerIdHash,
} from "./traceIdentity";
import { TRACE_IDENTITY_PARITY_VECTOR as VECTOR } from "./traceIdentityVector";

const saved = process.env.JWT_SECRET;
afterEach(() => {
  if (saved === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = saved;
});

test("agent_id_hash is a stable 16-hex keyed hash that never contains the id", () => {
  process.env.JWT_SECRET = "trace-identity-test-secret";
  const id = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";
  const hash = traceAgentIdHash(id);
  assert.match(hash ?? "", /^[0-9a-f]{16}$/);
  assert.equal(traceAgentIdHash(id), hash, "stable for grouping");
  assert.notEqual(traceAgentIdHash("0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5c"), hash);
  assert.ok(!id.replaceAll("-", "").includes(hash!));
  assert.deepEqual(agentIdHashAttrs(id), { agent_id_hash: hash });
});

test("the hash is keyed: a different root secret gives a different hash", () => {
  const id = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";
  process.env.JWT_SECRET = "secret-a";
  const a = traceAgentIdHash(id);
  process.env.JWT_SECRET = "secret-b";
  assert.notEqual(traceAgentIdHash(id), a);
});

test("no id or no key yields no attr rather than throwing", () => {
  process.env.JWT_SECRET = "trace-identity-test-secret";
  assert.equal(traceAgentIdHash(null), null);
  assert.equal(traceAgentIdHash("  "), null);
  assert.deepEqual(agentIdHashAttrs(undefined), {});
  delete process.env.JWT_SECRET;
  assert.equal(traceAgentIdHash("0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b"), null);
});

test("server_id_hash uses its own key: same id, different hash from agent_id_hash", () => {
  process.env.JWT_SECRET = "trace-identity-test-secret";
  const id = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b";
  const serverHash = traceServerIdHash(id);
  assert.match(serverHash ?? "", /^[0-9a-f]{16}$/);
  assert.equal(traceServerIdHash(id), serverHash, "stable for grouping");
  assert.notEqual(serverHash, traceAgentIdHash(id), "kinds never collide");
  assert.deepEqual(serverIdHashAttrs(id), { server_id_hash: serverHash });
  assert.deepEqual(serverIdHashAttrs(null), {});
});

test("parity vector: pinned derived keys and hashes (the Feature Flag Admin Worker asserts the same)", () => {
  process.env.JWT_SECRET = VECTOR.jwtSecret;
  assert.equal(exportTraceIdentityKeyHex("agent_id_hash"), VECTOR.agentKeyHex);
  assert.equal(exportTraceIdentityKeyHex("server_id_hash"), VECTOR.serverKeyHex);
  assert.equal(traceAgentIdHash(VECTOR.id), VECTOR.agentIdHash);
  assert.equal(traceServerIdHash(VECTOR.id), VECTOR.serverIdHash);

  // What the Worker does with the exported key must equal the server's hash.
  const workerHash = (keyHex: string) =>
    createHmac("sha256", Buffer.from(keyHex, "hex")).update(VECTOR.id, "utf8").digest("hex").slice(0, 16);
  assert.equal(workerHash(exportTraceIdentityKeyHex("agent_id_hash")!), traceAgentIdHash(VECTOR.id));
  assert.equal(workerHash(exportTraceIdentityKeyHex("server_id_hash")!), traceServerIdHash(VECTOR.id));
});

test("exported keys are absent without JWT_SECRET", () => {
  delete process.env.JWT_SECRET;
  assert.equal(exportTraceIdentityKeyHex("agent_id_hash"), null);
  assert.equal(exportTraceIdentityKeyHex("server_id_hash"), null);
});

test("apiKeyPrefixHashAttrs hashes the prefix and is stable", () => {
  process.env.JWT_SECRET ??= "test-jwt-secret-for-key-prefix-hash";
  const { key_prefix_hash: hash } = apiKeyPrefixHashAttrs("sk_agent_abcdefg");
  assert.ok(hash);
  assert.equal(hash.includes("sk_agent"), false);
  assert.equal(apiKeyPrefixHashAttrs("sk_agent_abcdefg").key_prefix_hash, hash);
  assert.notEqual(apiKeyPrefixHashAttrs("sk_agent_zzzzzzz").key_prefix_hash, hash);
});
