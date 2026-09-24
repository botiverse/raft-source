import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  collectConsumerFiles,
  declaredAnimationClasses,
  findOrphans,
  isConsumerFile,
} from "../scripts/check-orphan-animations.mjs";

const tsx = (text: string) => ({ path: "/repo/packages/web/src/components/Thing.tsx", text });

/**
 * Controls for the orphan-animation gate.
 *
 * A gate that only reports "0 findings" on a clean tree proves nothing — it
 * looks identical to a gate whose predicate never matches anything. Each case
 * below is one of the ways a count went wrong while this gate was being
 * designed: predicate too tight (misses a real orphan), predicate too loose
 * (flags a live class), or wrong search domain (counts CSS or tests as
 * consumers).
 *
 * The positive control is frozen as a fixture on purpose. It is
 * `onboarding-runtime-ready-flash`, the real orphan this gate was built for —
 * CSS transplanted from an unmerged branch, consumer and tests left behind,
 * dead for about a month. Once it is deleted from the repo there is no known
 * positive left to aim the gate at, and a gate with no reachable positive
 * cannot be shown to fire.
 */

const FIXTURE_CSS = `
  @keyframes onboarding-runtime-ready-flash {
    0% { box-shadow: var(--shadow-brutal); }
    100% { box-shadow: none; }
  }

  .onboarding-runtime-ready-flash {
    animation: onboarding-runtime-ready-flash 480ms cubic-bezier(0.2, 0, 0.2, 1);
  }

  .onboarding-live-message {
    animation: onboarding-live-message 240ms cubic-bezier(0.2, 0, 0.2, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .onboarding-runtime-ready-flash,
    .onboarding-live-message {
      animation: none;
    }
  }
`;

test("positive control: a class with no production consumer is reported", () => {
  const orphans = findOrphans(FIXTURE_CSS, [tsx('<div className="onboarding-live-message" />')]);
  assert.deepEqual(orphans, ["onboarding-runtime-ready-flash"]);
});

test("negative control: a class with a real consumer is not reported", () => {
  const orphans = findOrphans(FIXTURE_CSS, [
    tsx('<div className="onboarding-live-message" />'),
    tsx('const cls = "onboarding-runtime-ready-flash";'),
  ]);
  assert.deepEqual(orphans, []);
});

test("the reduced-motion `animation: none` list does not declare classes", () => {
  // Every class in that block is re-listed to switch it off. Treating those as
  // declarations would invent one orphan per reduced-motion entry.
  assert.deepEqual(declaredAnimationClasses(FIXTURE_CSS), [
    "onboarding-live-message",
    "onboarding-runtime-ready-flash",
  ]);
});

test("the search domain rejects the ways this gate gets silently blinded", () => {
  // Each of these, if accepted as a consumer, makes the gate unable to fire.
  assert.equal(isConsumerFile("/repo/packages/web/src/index.css"), false, "CSS is a definition site, never a use");
  assert.equal(isConsumerFile("/repo/packages/web/tests/onboardingMotionContract.test.ts"), false, "a test asserting absence is not a use");
  assert.equal(isConsumerFile("/repo/packages/web/src/components/Thing.tsx"), true);
  assert.equal(isConsumerFile("/repo/packages/web/index.html"), true);

  // And the filter is enforced inside findOrphans, not left to the call site:
  // handing it the stylesheet itself must not mark the class consumed.
  const orphans = findOrphans(FIXTURE_CSS, [
    { path: "/repo/packages/web/src/index.css", text: FIXTURE_CSS },
    tsx('<div className="onboarding-live-message" />'),
  ]);
  assert.deepEqual(orphans, ["onboarding-runtime-ready-flash"]);
});

test("the traversal actually reaches every file kind the predicate accepts", () => {
  // Regression: `isConsumerFile` accepted `.html` and a unit test asserted it,
  // but the walk only covered `src/` — and every `.html` in this package lives at
  // the package root, so no HTML was ever read. Predicate green, gate blind. A
  // class used only from `index.html` would have been called an orphan, and the
  // gate tells you to delete it. Assert the real traversal, not the predicate.
  const webRoot = resolve(import.meta.dirname, "..");
  const files = collectConsumerFiles(webRoot);

  assert.ok(
    files.some((f) => f.endsWith("/index.html")),
    "index.html lives at the package root and must be read",
  );
  assert.ok(files.some((f) => f.endsWith(".tsx")), "src components must be read");
  assert.equal(files.filter((f) => f.endsWith(".css")).length, 0, "stylesheets are never consumers");
  assert.equal(
    files.filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f)).length,
    0,
    "test files are never consumers, colocated or not",
  );
});

test("a grouped selector declares every class in its prelude", () => {
  // `.a, .b { animation: … }` declares both. Capturing only the last one
  // under-reports — the safe direction, but still a blind spot.
  assert.deepEqual(
    declaredAnimationClasses(".alpha,\n.beta { animation: x 100ms linear; }"),
    ["alpha", "beta"],
  );
});

test("nesting does not swallow the first rule of a block", () => {
  // The rule body must exclude `{`. With `[^}]*` a match can begin at an
  // enclosing block's brace and eat the first rule inside it: `@layer` yielded
  // only the SECOND class, and a lone rule inside `@media` vanished entirely.
  // `index.css` already nests (`@layer` x3, `@media (prefers-reduced-motion)`),
  // so this was one ordinary edit away from firing — and it under-reports,
  // which is precisely how this gate loses its sight.
  assert.deepEqual(
    declaredAnimationClasses("@layer components { .alpha { animation: a 1s linear; } .beta { animation: b 1s linear; } }"),
    ["alpha", "beta"],
    "the first rule inside a @layer block must not be swallowed",
  );
  assert.deepEqual(
    declaredAnimationClasses("@media (min-width: 700px) { .gamma { animation: g 1s linear; } }"),
    ["gamma"],
    "a lone rule inside @media must not vanish",
  );
});
