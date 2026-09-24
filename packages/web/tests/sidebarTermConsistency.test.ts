import assert from "node:assert/strict";
import test from "node:test";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Task #16. @AngLee settled the site-wide term for "sidebar" as 侧栏 during the
// wave-2 channel copy review, but three already-merged strings still said
// 侧边栏 — the drift predates the ruling and nothing was stopping it recurring.
//
// A resolved terminology decision is worthless if the next batch can silently
// re-litigate it, which is exactly what happened here: I introduced a fourth
// 侧边栏 in #5758 and only caught it because @Wug reviewed the batch for the
// CLASS after finding one instance.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("no zh value uses 侧边栏; the settled term is 侧栏", () => {
  const offenders = Object.entries(zh)
    .filter(([, v]) => v.includes("侧边栏"))
    .map(([k]) => k);
  assert.deepEqual(
    offenders, [],
    `these use 侧边栏 instead of the settled 侧栏: ${offenders.join(", ")}`,
  );
});

test("the term is actually in use, so this guard cannot pass vacuously", () => {
  // If every 侧栏 string were deleted or renamed, the check above would still
  // pass while guarding nothing. Anchor it to real usage.
  const users = Object.entries(zh).filter(([, v]) => v.includes("侧栏")).map(([k]) => k);
  assert.ok(users.length >= 4, `expected the established 侧栏 usages, found ${users.length}`);
});

test("every zh value that says 侧栏 translates an English string about the sidebar", () => {
  // Catches the opposite error: 侧栏 pasted into a message that is not about the
  // sidebar at all, which a term-consistency sweep would happily do.
  for (const [id, value] of Object.entries(zh)) {
    if (!value.includes("侧栏")) continue;
    const source = en[id];
    assert.ok(source, `${id} has no English counterpart`);
    assert.match(
      source, /sidebar/i,
      `${id} says 侧栏 but its English is not about the sidebar: ${source.slice(0, 60)}`,
    );
  }
});
