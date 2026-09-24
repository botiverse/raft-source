import assert from "node:assert/strict";
import { test } from "vitest";
import {
  OBSERVABLE_SEND_ROUTE_SUBKINDS,
  TAGGABLE_SEND_ROUTE_SUBKINDS,
  SendRouteError,
  resolveSendRouteSubkind,
  type SendRouteSubkind,
} from "./sendRouteFailure.js";

test("resolveSendRouteSubkind returns the tagged subkind for a SendRouteError", () => {
  assert.equal(resolveSendRouteSubkind(new SendRouteError("target_forbidden", "x")), "target_forbidden");
  assert.equal(resolveSendRouteSubkind(new SendRouteError("channel_archived", "x")), "channel_archived");
  assert.equal(resolveSendRouteSubkind(new SendRouteError("bad_request", "x")), "bad_request");
});

test("MentionValidationError (by structural name) classifies as mention_validation, not server_internal", () => {
  // Mirror the messageService MentionValidationError shape: an Error whose
  // `name` is set to the class name. Classification is a typed-identity check
  // on that constant marker, NOT message sniffing.
  class MentionValidationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "MentionValidationError";
    }
  }
  assert.equal(
    resolveSendRouteSubkind(new MentionValidationError("Mention @x is not visible in this channel")),
    "mention_validation",
  );
  // Same message text on a plain Error must NOT classify as mention_validation
  // (proves we match the typed name, not the message string).
  const plain = new Error("Mention @x is not visible in this channel");
  assert.equal(resolveSendRouteSubkind(plain), "server_internal");
});

test("genuine Error defaults to server_internal; non-Error throw to unknown — never sniffed", () => {
  assert.equal(resolveSendRouteSubkind(new Error("ECONNREFUSED writing to db")), "server_internal");
  assert.equal(resolveSendRouteSubkind(new TypeError("cannot read property")), "server_internal");
  assert.equal(resolveSendRouteSubkind("some string"), "unknown");
  assert.equal(resolveSendRouteSubkind(undefined), "unknown");
  assert.equal(resolveSendRouteSubkind(null), "unknown");
  assert.equal(resolveSendRouteSubkind({ weird: true }), "unknown");
});

test("unknown is reachable only as the non-Error catch-all (drift-signal posture)", () => {
  // Per contract: unknown must mean "an unclassified non-Error throw", i.e. a
  // taxonomy-drift signal — NOT a bucket any typed/Error path falls into.
  // Every Error-shaped input lands on a classified bucket, never unknown.
  for (const e of [new Error("a"), new TypeError("b"), new RangeError("c")]) {
    assert.notEqual(resolveSendRouteSubkind(e), "unknown");
  }
  // Only genuinely unclassifiable (non-Error) values are unknown.
  assert.equal(resolveSendRouteSubkind(42), "unknown");
});

test("observable closed set is exactly the ratified 9 values (#proj-daemon:6676803a)", () => {
  assert.deepEqual(
    [...OBSERVABLE_SEND_ROUTE_SUBKINDS].sort(),
    [
      "agent_not_found",
      "bad_request",
      "channel_archived",
      "freshness_not_enabled",
      "mention_validation",
      "server_internal",
      "target_forbidden",
      "target_not_found",
      "unknown",
    ],
  );
});

test("taggable set = observable set MINUS unknown (8 values; unknown is resolver-only)", () => {
  assert.deepEqual(
    [...TAGGABLE_SEND_ROUTE_SUBKINDS].sort(),
    [
      "agent_not_found",
      "bad_request",
      "channel_archived",
      "freshness_not_enabled",
      "mention_validation",
      "server_internal",
      "target_forbidden",
      "target_not_found",
    ],
  );
  // unknown is observable but NOT taggable — the structural guarantee that a
  // call-site can never deliberately emit the drift-signal bucket.
  assert.ok((OBSERVABLE_SEND_ROUTE_SUBKINDS as readonly string[]).includes("unknown"));
  assert.ok(!(TAGGABLE_SEND_ROUTE_SUBKINDS as readonly string[]).includes("unknown"));
});

test("every taggable subkind round-trips through SendRouteError", () => {
  for (const subkind of TAGGABLE_SEND_ROUTE_SUBKINDS) {
    assert.equal(resolveSendRouteSubkind(new SendRouteError(subkind, "x")), subkind);
  }
});

test("SendRouteError REJECTS unknown — cannot be call-site tagged (type + runtime)", () => {
  // Runtime backstop: `unknown` cast through `as never` must throw (it is
  // resolver-only, never a deliberate tag).
  assert.throws(() => new SendRouteError("unknown" as never, "x"), /not a taggable/);
  // Any non-taggable value also rejected at runtime.
  assert.throws(() => new SendRouteError("not_a_subkind" as never, "x"), /not a taggable/);
  // Compile-time guard: `unknown` is not a TaggableSendRouteSubkind.
  // @ts-expect-error unknown is observable-only, not taggable
  void (() => new SendRouteError("unknown", "must not compile"));
});

// Type-level: SendRouteSubkind and the observable array stay in lockstep.
const _exhaustive: SendRouteSubkind = OBSERVABLE_SEND_ROUTE_SUBKINDS[0];
void _exhaustive;
