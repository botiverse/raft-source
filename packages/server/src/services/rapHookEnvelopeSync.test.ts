import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { HOOKS } from "./rapRegistry.js";

/**
 * Contract §4d-8b/§4d-8c, generalised to EVERY hook.
 *
 * The invariant, in @Huaihuai's words: after any change here, the return value an
 * app receives must match what that app can actually do -- and that has to hold for
 * all six hooks, not just the one most recently worked on.
 *
 * Operationally, for each hook: it may have a registration slot only if it can be
 * given what it needs to do its job.
 *
 *   lifecycle hooks    need nothing, so a slot is enough
 *   event hooks        need the event, so slot present <=> dispatch requires an event
 *
 * ⇒ The two ways to break it, and why neither reds anywhere else:
 *
 *   slot without envelope -- the handler IS invoked and dispatchHook returns
 *   `called`, while the handler receives nothing and cannot tell which occurrence
 *   fired. A visible misattribution (`no_handler`, which at least looks like a
 *   problem) is replaced by a silent false success (`called`, which looks normal).
 *
 *   envelope without slot -- the capability exists and nothing can reach it. The
 *   deliberate block keeps every other test green while the feature simply never
 *   appears: a temporary measure outliving its reason, the same family as §4d-5's
 *   fixed window silently dropping its oldest entry.
 *
 * ⇒ So this is at once the EXPIRY ALARM for a deliberate block and the CONNECTION
 * PROOF for an envelope. A block's lifetime is made equal to its reason's lifetime
 * rather than depending on anyone remembering.
 *
 * ⚠️ If you just added an envelope and this went red: nothing is broken and it is
 * not your change's fault. This is the alarm reaching expiry -- the deliberate block
 * on that hook's registration must be removed in the same change (task #151).
 *
 * The probes are structural on purpose: the invariant is a relationship between
 * declarations, so it is checked where those declarations live. A behavioural probe
 * would have to cast past the very type doing the blocking, and would therefore
 * measure something no compliant app can do.
 */

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), "rapRegistryStore.ts");

/**
 * Hooks that carry an occurrence and are therefore useless without one: being told
 * "something became due" without being told WHICH is not a capability. Lifecycle
 * hooks are deliberately absent -- install/enable/disable/uninstall are complete
 * facts in themselves.
 *
 * ⚠️ Listed rather than derived because "does this hook carry an occurrence" is a
 * design fact, not something the code states. It is asserted to be a subset of
 * HookName below, so renaming a hook breaks this loudly instead of silently
 * dropping it out of coverage.
 */
const EVENT_HOOKS = ["onDue", "onThresholdCrossed"] as const;

function sliceBetween(source: string, startAnchor: string, endAnchor: string, what: string): string {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" not found -- this tooth cannot see ${what} any more, so it must fail rather than pass blind`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `end anchor "${endAnchor}" not found after "${startAnchor}" -- ${what} is no longer delimited as expected`);
  return source.slice(start, end);
}


/**
 * Every `dispatchHook` declaration, each as its own string: the overloads and the
 * implementation signature. Splitting them is the whole point -- a check that reads
 * across the boundary can satisfy itself from a neighbouring signature.
 */
function splitDispatchDeclarations(store: string): string[] {
  const out: string[] = [];
  const head = /export\s+(?:async\s+)?function\s+dispatchHook\s*\(/g;
  for (let m = head.exec(store); m !== null; m = head.exec(store)) {
    const rest = store.slice(m.index);
    const end = rest.search(/\)\s*:\s*Promise<HookDispatch>/);
    if (end === -1) continue;
    out.push(rest.slice(0, end));
  }
  return out;
}

/**
 * The declarable hook list, IMPORTED rather than sliced out of the source.
 *
 * ⚠️ It used to be read by text anchor (`const HOOKS: readonly HookName[] = [`).
 * Task #237 made `HOOKS` the sole hand-written source and exported it, which
 * broke that anchor -- and the tooth failed CLOSED with its own message, exactly
 * as designed, rather than reporting a green it had not earned.
 *
 * Re-anchoring on the new text would just move the same fragility. Importing the
 * canonical value removes the class: this is the very fact the tooth wants, and
 * a rename now fails at compile time instead of silently un-anchoring.
 */
function declaredHookNames(): string[] {
  const names: string[] = [...HOOKS];
  assert.ok(names.length > 0, "no hook names in HOOKS -- refusing to report coverage this tooth does not have");
  return names;
}

test("§4d-8b: every hook may be registerable only if it can be given what it needs", () => {
  const store = readFileSync(STORE, "utf8");

  const hooks = declaredHookNames();
  for (const eventHook of EVENT_HOOKS) {
    assert.ok(
      hooks.includes(eventHook),
      `EVENT_HOOKS lists "${eventHook}" but HOOKS does not declare it -- this list has gone stale and would silently drop a hook out of coverage`,
    );
  }

  // task #151 moved the slot list to a canonical array that `AppHookHandlers` is
  // derived from, so this reads that array. The invariant is unchanged: presence
  // here IS presence of a registration slot, and now also decides the runtime
  // `not_registerable` classification, so one anchor covers both.
  const slots = sliceBetween(store, "export const REGISTERABLE_HOOKS = [", "]", "the canonical registerable-hook list");
  // Each dispatchHook declaration is read SEPARATELY. Searching one region spanning
  // every signature is what @Huaihuai reproduced as a false green: a regex starting
  // at `hook: "onDue"` runs on past the end of that overload and matches the
  // IMPLEMENTATION signature's event parameter instead. The tooth then stays green
  // with the defect present, and its correctness hangs on the `?` in `event?:` --
  // an unrelated signature, where removing an optional marker is a harmless-looking
  // refactor anyone might do.
  const declarations = splitDispatchDeclarations(store);
  assert.ok(
    declarations.length > 0,
    "no dispatchHook declaration found in either the plain or overloaded shape -- this tooth cannot see the dispatch surface, so it must fail rather than pass blind",
  );

  const broken: string[] = [];
  for (const hook of hooks) {
    const slotPresent = new RegExp(`"${hook}"`).test(slots);
    const carriesEvent = (EVENT_HOOKS as readonly string[]).includes(hook);

    if (!carriesEvent) {
      // A lifecycle hook needs nothing, so a declarable hook with no slot is just
      // unreachable for no reason.
      if (!slotPresent) broken.push(`${hook}: declarable but has no registration slot, and it needs no event -- nothing explains why it cannot be registered`);
      continue;
    }

    // An event hook is only honest if ITS OWN overload demands the event. The
    // declaration is located by the literal hook name in its parameter list, and
    // only that declaration is searched -- the implementation signature takes
    // `hook: HookName` rather than a literal, so it can never stand in for one.
    const own = declarations.find((d) => new RegExp(`hook:\\s*"${hook}"`).test(d));
    const overloadRequiresEvent = own !== undefined && /\bevent\s*[?:]/.test(own);
    if (slotPresent && !overloadRequiresEvent) {
      broken.push(`${hook}: registerable, but dispatch does not require an event for it -- the handler is invoked, cannot tell which occurrence fired, and dispatchHook still reports \`called\`. That is a silent false success replacing a visible misattribution. Land the envelope in this change, or restore the deliberate block.`);
    }
    if (!slotPresent && overloadRequiresEvent) {
      broken.push(`${hook}: the event envelope exists but the hook is still not registerable. NOTHING IS BROKEN AND THIS IS NOT YOUR CHANGE'S FAULT -- this is the expiry alarm on the deliberate block that held ${hook} unregisterable until its envelope existed. Its reason has now arrived, so the block must be removed in this change (task #151).`);
    }
  }

  assert.deepEqual(broken, [], `\n  ${broken.join("\n  ")}\n`);
});
