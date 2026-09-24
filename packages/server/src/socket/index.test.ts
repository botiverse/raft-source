import assert from "node:assert/strict";
import { test } from "vitest";
import { parseSocketHandshakeAuth } from "./index.js";

test("socket handshake auth parser accepts current web auth shape", () => {
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "web",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: null }), {
    ok: true,
    token: "access-token",
    serverId: null,
    clientKind: "web",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token" }), {
    ok: true,
    token: "access-token",
    serverId: null,
    clientKind: "web",
  });
});

test("socket handshake auth parser accepts explicit clientKind values", () => {
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1", clientKind: "mobile" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "mobile",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1", clientKind: "desktop" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "desktop",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "server-1", clientKind: "cli" }), {
    ok: true,
    token: "access-token",
    serverId: "server-1",
    clientKind: "cli",
  });
});

test("socket handshake auth parser rejects malformed auth bags before authentication", () => {
  assert.deepEqual(parseSocketHandshakeAuth(null), { ok: false, reason: "auth_not_object" });
  assert.deepEqual(parseSocketHandshakeAuth("token"), { ok: false, reason: "auth_not_object" });
  assert.deepEqual(parseSocketHandshakeAuth(["access-token"]), { ok: false, reason: "auth_not_object" });
  assert.deepEqual(parseSocketHandshakeAuth({}), { ok: false, reason: "token_missing" });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "" }), { ok: false, reason: "token_missing" });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: "" }), {
    ok: false,
    reason: "server_id_invalid",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", serverId: 123 }), {
    ok: false,
    reason: "server_id_invalid",
  });
  assert.deepEqual(parseSocketHandshakeAuth({ token: "access-token", clientKind: "watch" }), {
    ok: false,
    reason: "client_kind_invalid",
  });
});
