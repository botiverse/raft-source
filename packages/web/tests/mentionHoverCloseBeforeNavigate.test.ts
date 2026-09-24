import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * Every navigation out of the mention hover card must dismiss it FIRST.
 *
 * The card is portaled and hover-driven, so navigating without closing leaves
 * it floating over the page it just opened until the pointer moves. The
 * existing avatar/mention handlers all call `previewActionsRef.current?.close()`
 * before navigating; a new affordance that forgets is invisible in jsdom —
 * there is no real portal or hover lifecycle there, so behavioural tests stay
 * green while the actual UI is wrong. That is exactly how the first attempt at
 * this feature passed its own tests.
 *
 * Source-shape is therefore the only place this rule can hold, and unlike the
 * reconnect case there is no observable count to assert instead.
 */

const SOURCE = readFileSync(
  resolve(import.meta.dirname, "../src/components/message/MessageItem.tsx"),
  "utf8",
);

/** Body of an arrow handler declared as `const <name> = (...) => { ... }`. */
function handlerBody(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = (`);
  assert.notEqual(start, -1, `${name} must exist in MessageItem.tsx`);
  const end = SOURCE.indexOf("\n  };", start);
  assert.notEqual(end, -1, `${name} must be a brace-delimited arrow body`);
  return SOURCE.slice(start, end);
}

test("opening an agent's activity from the hover card closes the card first", () => {
  const body = handlerBody("onOpenAgentActivity");
  assert.match(
    body,
    /previewActionsRef\.current\?\.close\(\)/,
    "must dismiss the hover card before navigating, or it stays over the destination",
  );
  const closeAt = body.indexOf("previewActionsRef.current?.close()");
  const navAt = body.indexOf("onNavigateAgentActivity(");
  assert.ok(navAt > closeAt, "close() must come BEFORE the navigation call, not after");
});

test("the sibling hover-card navigations still close first", () => {
  // Pins the convention this feature had to follow, so a future edit cannot
  // quietly drop it from the handlers that established it.
  for (const name of ["onClickAgent", "onClickHuman"]) {
    const body = handlerBody(name);
    assert.match(
      body,
      /previewActionsRef\.current\?\.close\(\)/,
      `${name} must keep closing the hover card before navigating`,
    );
  }
});
