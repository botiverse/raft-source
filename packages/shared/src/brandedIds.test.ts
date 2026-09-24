import assert from "node:assert/strict";
import test from "node:test";
import {
  asServerId,
  asMachineId,
  asMessageId,
  asChannelId,
  type ServerId,
  type MachineId,
  type MessageId,
  type ChannelId,
} from "./brandedIds.js";

// A representative consumer that demands a *proven* server id — stands in for
// real boundary-sensitive functions (e.g. the access-control check that #945
// had to fix by making serverId a mandatory, non-confusable argument).
function requiresServerId(id: ServerId): ServerId {
  return id;
}

function requiresMachineId(id: MachineId): MachineId {
  return id;
}

function requiresMessageId(id: MessageId): MessageId {
  return id;
}

function requiresChannelId(id: ChannelId): ChannelId {
  return id;
}

// --- Type-level guarantees (enforced by `tsc --noEmit`; never executed) ---
declare const someOtherId: string;
function _typeLevelChecks(branded: ServerId): void {
  // A branded ServerId is accepted:
  void requiresServerId(branded);
  // A ServerId is still a string, so it flows into plain-string consumers with
  // no cascade onto code that doesn't care:
  const asPlainString: string = branded;
  void asPlainString;
  // @ts-expect-error — a raw string literal is NOT assignable to ServerId: the
  // exact mistake (passing an unvalidated string as the server scope) is a
  // compile error, not a silent runtime leak.
  void requiresServerId("11111111-1111-1111-1111-111111111111");
  // @ts-expect-error — an arbitrary string variable cannot stand in for ServerId.
  void requiresServerId(someOtherId);

  // Distinct brands do not interchange — this is what stops a serverId from
  // being silently passed where a machine id is expected (the serverId→machine
  // confusion class). Both directions must fail:
  const server = asServerId("s");
  const machine = asMachineId("m");
  void requiresMachineId(machine); // OK
  void requiresServerId(server); // OK
  // @ts-expect-error — a ServerId is not a MachineId.
  void requiresMachineId(server);
  // @ts-expect-error — a MachineId is not a ServerId.
  void requiresServerId(machine);

  const message = asMessageId("msg-1");
  const channel = asChannelId("chan-1");
  void requiresMessageId(message); // OK
  void requiresChannelId(channel); // OK
  // @ts-expect-error — a MessageId is not a ChannelId.
  void requiresChannelId(message);
  // @ts-expect-error — a ChannelId is not a MessageId.
  void requiresMessageId(channel);
}
void _typeLevelChecks;

test("id brand constructors are identity-at-runtime brands", () => {
  const raw = "abc-123";
  assert.equal(asServerId(raw), raw);
  assert.equal(asMachineId(raw), raw);
  assert.equal(asMessageId(raw), raw);
  assert.equal(asChannelId(raw), raw);
  // Branding does not copy or transform — same value, just a compile-time tag.
  assert.equal(typeof asServerId(raw), "string");
  assert.equal(typeof asMachineId(raw), "string");
  assert.equal(typeof asMessageId(raw), "string");
  assert.equal(typeof asChannelId(raw), "string");
});
