import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isAppId,
  manifestDeclaresHook,
  manifestPermitsSyscall,
  mintAppPrincipal,
  parseAppPrincipal,
  parseManifest,
  HOOKS,
  SYSCALLS,
  type AppId,
} from "./rapRegistry.js";

// ⚠️ No app names anywhere in this file either -- the ids below are synthetic
// (`x.alpha`, `x.beta`). Naming a real app in a test would put the name in an
// OS-layer file, which is exactly what #137's ratchet counts.

const ALPHA = "x.alpha" as AppId;

test("app_id accepts dotted lowercase and rejects the shapes that widen an exemption", () => {
  assert.ok(isAppId("x.alpha"));
  assert.ok(isAppId("x.alpha.beta"));

  // Each rejection below is a value that would behave as a literal in one
  // consumer and as a pattern or path escape in another.
  for (const bad of [
    "alpha",        // no dot: not the allocated shape
    "X.Alpha",      // case: two ids differing only by case would collide
    "x.",           // empty segment
    ".alpha",
    "x..alpha",
    "x.al pha",     // whitespace
    "x.alpha*",     // glob -- would widen a directory exemption
    "x.alpha/..",   // path traversal
    "x.alpha\n",    // newline: line-oriented consumers would see two values
    "",
  ]) {
    assert.equal(isAppId(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(isAppId(undefined), false);
  assert.equal(isAppId(42), false);
});

test("a principal is derived from the registered id and round-trips", () => {
  const principal = mintAppPrincipal(ALPHA);
  assert.equal(principal, "app@x.alpha");
  assert.equal(parseAppPrincipal(principal), "x.alpha");
});

test("parseAppPrincipal refuses anything that is not a well-formed app handle", () => {
  // An app must not be able to make the OS read some other principal kind as an
  // app -- the namespace is the identity check, so it has to be exact.
  for (const bad of ["x.alpha", "@x.alpha", "app@", "app@Alpha", "app@alpha", "agent@x.alpha", "app@x.alpha/.."]) {
    assert.equal(parseAppPrincipal(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("a well-formed manifest parses, de-duplicating declarations", () => {
  const parsed = parseManifest({
    app_id: "x.alpha",
    hooks: ["onInstall", "onDue", "onInstall"],
    syscalls: ["notify", "schedule", "notify"],
    notifications: ["threshold_crossed", "x.event", "threshold_crossed"],
  });
  assert.equal(parsed.kind, "parsed");
  if (parsed.kind !== "parsed") return;
  assert.deepEqual(parsed.manifest.hooks, ["onInstall", "onDue"]);
  assert.deepEqual(parsed.manifest.syscalls, ["notify", "schedule"]);
  assert.deepEqual(parsed.manifest.notificationClasses, ["threshold_crossed", "x.event"]);
});

test("config schema is closed and preserves typed defaults and integer bounds", () => {
  const parsed = parseManifest({
    app_id: "x.alpha",
    config: {
      enabled: { type: "boolean", default: true },
      threshold: { type: "integer", default: 10, minimum: 1, maximum: 20 },
    },
  });
  assert.equal(parsed.kind, "parsed");
  if (parsed.kind === "parsed") {
    assert.deepEqual(parsed.manifest.config, {
      enabled: { type: "boolean", default: true },
      threshold: { type: "integer", default: 10, minimum: 1, maximum: 20 },
    });
  }

  for (const config of [
    { enabled: { type: "boolean", default: true, extra: false } },
    { threshold: { type: "integer", default: 0, minimum: 1, maximum: 20 } },
    { threshold: { type: "integer", default: 10, minimum: 20, maximum: 1 } },
    { bad_key: { type: "string", default: "x" } },
    { "Bad-Key": { type: "boolean", default: true } },
  ]) {
    const rejected = parseManifest({ app_id: "x.alpha", config });
    assert.equal(rejected.kind, "rejected");
    if (rejected.kind === "rejected") assert.equal(rejected.reason, "config_schema_invalid");
  }
});

test("notification classes accept dotted namespaces and reject ambiguous shapes", () => {
  for (const notificationClass of ["x.event", "memory_size_hint", "x.deep_event.v1"]) {
    assert.equal(
      parseManifest({ app_id: "x.alpha", notifications: [notificationClass] }).kind,
      "parsed",
      notificationClass,
    );
  }
  for (const notificationClass of ["x..event", ".event", "x.event.", "X.event", "x/event", "x.*"]) {
    const parsed = parseManifest({ app_id: "x.alpha", notifications: [notificationClass] });
    assert.equal(parsed.kind, "rejected", notificationClass);
    if (parsed.kind === "rejected") assert.equal(parsed.reason, "notification_class_malformed");
  }
});

test("an unknown hook or syscall is REJECTED, not dropped", () => {
  // Dropping is the dangerous alternative: the app would install, believe the
  // capability was granted, and fail at first use -- and the manifest would no
  // longer describe what was actually registered.
  const badHook = parseManifest({ app_id: "x.alpha", hooks: ["onInstall", "onWhatever"] });
  assert.equal(badHook.kind, "rejected");
  if (badHook.kind === "rejected") {
    assert.equal(badHook.reason, "hook_unknown");
    assert.equal(badHook.detail, "onWhatever");
  }

  const badCall = parseManifest({ app_id: "x.alpha", syscalls: ["notify", "sendToChannel"] });
  assert.equal(badCall.kind, "rejected");
  if (badCall.kind === "rejected") {
    assert.equal(badCall.reason, "syscall_unknown");
    assert.equal(badCall.detail, "sendToChannel");
  }
});

test("a malformed or missing app_id is rejected before anything else is read", () => {
  assert.equal(parseManifest({ hooks: ["onInstall"] }).kind, "rejected");
  assert.equal(parseManifest({ app_id: "Alpha" }).kind, "rejected");
  assert.equal(parseManifest(null).kind, "rejected");
  assert.equal(parseManifest([{ app_id: "x.alpha" }]).kind, "rejected");
  assert.equal(parseManifest("x.alpha").kind, "rejected");
});

test("undeclared capabilities fail closed -- and being first-party is not an input", () => {
  // §2 Q3: exemption is scoped to the declared manifest, never to the identity.
  // There is deliberately no "first party" parameter to pass, so this cannot be
  // relaxed for a built-in without changing the signature in a reviewable way.
  const parsed = parseManifest({ app_id: "x.alpha", hooks: ["onInstall"], syscalls: ["notify"] });
  assert.equal(parsed.kind, "parsed");
  if (parsed.kind !== "parsed") return;
  const m = parsed.manifest;

  assert.equal(manifestPermitsSyscall(m, "notify"), true);
  assert.equal(manifestPermitsSyscall(m, "cancel"), false);
  assert.equal(manifestPermitsSyscall(m, "schedule"), false);

  assert.equal(manifestDeclaresHook(m, "onInstall"), true);
  assert.equal(manifestDeclaresHook(m, "onUninstall"), false);
});

/**
 * Task #237: every name in the canonical `HOOKS` array must be acceptable to
 * `parseManifest`.
 *
 * ⚠️ Ceiling: this proves the canonical list and the parser agree on the SET.
 * That `HookName` is derived from `HOOKS` is a compile-time fact of the source,
 * ⛔ not something this runtime test can observe or is claiming.
 *
 * ⚠️ Iterated from the canonical list, NOT a copy of it. A hand-written set here
 * would be the third closed set -- the exact shape this card collapsed -- and it
 * would keep passing after a member was deleted from the source.
 *
 * ⇒ Deleting any canonical member REDs here (the deleted name stops parsing) and
 * in the registration/classification paths that consume the same list.
 */
test("§237: every canonical hook is declarable in a manifest", () => {
  // Anti-vacuity first: an empty or truncated canonical list would make the loop
  // below pass by iterating nothing, reporting coverage that never ran.
  assert.ok(
    HOOKS.length >= 6,
    `canonical hook list looks truncated (${HOOKS.length}) -- refusing to report a coverage this test did not perform`,
  );
  for (const hook of HOOKS) {
    const parsed = parseManifest({ app_id: "x.alpha", hooks: [hook] });
    assert.equal(parsed.kind, "parsed", `canonical hook "${hook}" was refused by parseManifest`);
    if (parsed.kind !== "parsed") return;
    assert.ok(
      manifestDeclaresHook(parsed.manifest, hook),
      `canonical hook "${hook}" parsed but does not read back as declared`,
    );
  }
});

test("§237: the canonical hook list has exact membership and fails closed outside it", () => {
  // ⚠️ EVIDENCE CEILING -- read before citing this test for anything.
  //
  // It pins the canonical VALUE SET and nothing more: the declarable names are
  // present (deleting one REDs here), and a name outside the set fails closed
  // with `hook_unknown`.
  //
  // ⛔ It does NOT prove `HookName` is DERIVED from `HOOKS`. An earlier version
  // of this test was named and commented as if it did, and that claim was
  // measured FALSE: @ApplePI restored `HookName` to a hand-written union of
  // identical values and the focused suite stayed 35/35 GREEN with typecheck
  // clean. A runtime test cannot see a type, so it cannot tell a derivation
  // from a restatement while their values agree -- the same thing @Huaihuai's
  // mutations proved six times over on task #151.
  //
  // The derivation is a SOURCE / COMPILE-TIME structural fact
  // (`HookName = (typeof HOOKS)[number]`) and is deliberately left as one:
  // building a second list or an AST probe to "prove" it would recreate the
  // exact second closed set this card exists to remove (@XX).
  //
  // ⚠️ Coverage record, in @XX's frozen vocabulary (task #228's matrix, adopted
  // here so both cards read the same way):
  //
  //   assertion_kind     = symbol
  //   evidence_ceiling   = exact membership of the canonical array, and
  //                        fail-closed for any name outside it
  //   behavior_semantics = NOT_COVERED (registration/envelope teeth bear it)
  //
  // ⚠️ The mutations backing this card are behaviour-SHAPED (deleting `onDue`
  // REDs 5 tests; emptying the list REDs 11). They show the canonical set
  // propagates into downstream constraints. They do NOT show the registration
  // or rejection paths authorize correctly -- running a behaviour-shaped
  // mutation does not upgrade a symbol assertion into a behavioural one
  // (@Maggie).
  //
  // @Maggie's test -- "could a right-symbol, wrong-body implementation pass
  // this?" -- answers YES here, and that is HONEST rather than a defect: the
  // claim this test makes IS symbol-level, so a symbol-level check is exactly
  // the right instrument and owes no behavioural tooth. Manufacturing one to
  // look thorough would be the actual error.
  const canonical: readonly string[] = HOOKS;
  for (const declared of ["onInstall", "onEnable", "onDisable", "onUninstall", "onDue", "onThresholdCrossed"]) {
    assert.ok(canonical.includes(declared), `"${declared}" vanished from the canonical hook list`);
  }
  const rejected = parseManifest({ app_id: "x.alpha", hooks: ["onNotAHook"] });
  assert.equal(rejected.kind, "rejected", "a name outside the canonical list must fail closed");
  if (rejected.kind !== "rejected") return;
  assert.equal(rejected.reason, "hook_unknown");
});

/**
 * Task #141-A: the syscall set is CLOSED, and `readOwnState`/`writeOwnState`
 * are outside it.
 *
 * These two names were declarable in a manifest while having no implementation
 * anywhere -- declarable but uncallable. They are now deleted, and a manifest
 * that still declares one must fail closed rather than parse into a capability
 * the OS cannot honour.
 *
 * ⚠️ This tooth PINS a behaviour that `parseManifest` already had; it does not
 * build it. The rejection comes from the canonical list, so the test's value is
 * that deleting the names cannot later be quietly undone.
 */
test("§141: deleted own-state syscalls are rejected, exactly and by name", () => {
  for (const deleted of ["readOwnState", "writeOwnState"]) {
    const parsed = parseManifest({ app_id: "x.alpha", syscalls: [deleted] });
    assert.equal(
      parsed.kind,
      "rejected",
      `"${deleted}" is deleted and must not parse -- a manifest may not declare a syscall the OS cannot perform`,
    );
    if (parsed.kind !== "rejected") return;
    // The REASON is pinned, not merely "some rejection": an app author has to be
    // told the name is unknown, and a different reason here would mean the
    // manifest was refused for an unrelated cause and the deletion is unproven.
    assert.equal(parsed.reason, "syscall_unknown", `"${deleted}" must be refused as an unknown syscall`);
    assert.equal(parsed.detail, deleted, "the refusal must name the offending syscall back to the author");
  }
});

test("§141: the canonical syscall list no longer contains the deleted names", () => {
  // Guards the other direction from the test above: that one proves a manifest
  // declaring them is refused, this one proves nobody re-added them to the
  // source. Re-adding either would silently make the rejection test pass for
  // the wrong reason -- it would no longer be rejected at all.
  const canonical: readonly string[] = SYSCALLS;
  for (const deleted of ["readOwnState", "writeOwnState"]) {
    assert.ok(
      !canonical.includes(deleted),
      `"${deleted}" is back in SYSCALLS -- reintroducing it requires an execution surface first (task #227), not just the name`,
    );
  }
  // Anti-vacuity: if the canonical list were empty or unreadable, every loop in
  // this file would pass by iterating nothing. Fail rather than report coverage
  // that was never exercised.
  assert.ok(SYSCALLS.length >= 4, `canonical syscall list looks truncated (${SYSCALLS.length}) -- refusing to pass blind`);
  for (const live of ["notify", "schedule", "cancel", "resolveConversation"]) {
    assert.ok(canonical.includes(live), `"${live}" vanished from the canonical list`);
  }
});

test("an empty manifest grants nothing", () => {
  // The floor: registering does not by itself confer any capability.
  const parsed = parseManifest({ app_id: "x.beta" });
  assert.equal(parsed.kind, "parsed");
  if (parsed.kind !== "parsed") return;
  // Iterated from the canonical list, NOT a copy of it: a hand-written set here
  // would keep asserting the old names after they were deleted, and would miss
  // any name added later -- the exact drift this card collapsed the pair to stop.
  assert.ok(SYSCALLS.length > 0, "no canonical syscalls -- refusing to report coverage this test does not have");
  for (const s of SYSCALLS) {
    assert.equal(manifestPermitsSyscall(parsed.manifest, s), false, `${s} must not be granted`);
  }
});
