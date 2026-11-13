import assert from "node:assert/strict";
import { test } from "vitest";
import { SHORTCUT_OVERRIDES_MAX_COMMANDS, normalizeShortcutOverrides, parseShortcutOverridesPreference } from "./shortcutOverrides";

test("a stored map reads back as it was; anything else is no change", () => {
  const map = { search: [{ key: "J", mod: true as const }], "jump-ends": [{ key: "ArrowUp", alt: true as const }, { key: "ArrowDown", alt: true as const }], sidebar: [] };
  assert.deepEqual(normalizeShortcutOverrides(map), map);
  assert.deepEqual(normalizeShortcutOverrides(null), {});
  assert.deepEqual(normalizeShortcutOverrides("search"), {});
  assert.deepEqual(normalizeShortcutOverrides([]), {});
  assert.deepEqual(normalizeShortcutOverrides({ search: [{ key: "J", mod: "yes" }] }), {}, "one bad part spoils the map");
  assert.deepEqual(normalizeShortcutOverrides({ search: [{ key: "J", mod: false, shift: true }] }), { search: [{ key: "J", shift: true }] }, "false flags are dropped");
});

test("PATCH: undefined is unchanged, null and {} the defaults, a bad map is refused", () => {
  assert.equal(parseShortcutOverridesPreference(undefined), undefined);
  assert.equal(parseShortcutOverridesPreference(null), null);
  assert.equal(parseShortcutOverridesPreference({}), null);
  assert.deepEqual(parseShortcutOverridesPreference({ search: [{ key: "J", mod: true }] }), { search: [{ key: "J", mod: true }] });
  const refused = [
    "search",
    { Search: [{ key: "J" }] },
    { search: { key: "J" } },
    { search: [{ key: "" }] },
    { search: [{ key: "J", meta: true }] },
    { search: [{ key: "\n" }] },
    { search: [{ key: "J" }, { key: "K" }, { key: "L" }, { key: "M" }, { key: "N" }] },
    Object.fromEntries(Array.from({ length: SHORTCUT_OVERRIDES_MAX_COMMANDS + 1 }, (_, i) => [`c${i}`, []])),
  ];
  for (const raw of refused) assert.throws(() => parseShortcutOverridesPreference(raw), /shortcutOverrides must be/, JSON.stringify(raw));
});
