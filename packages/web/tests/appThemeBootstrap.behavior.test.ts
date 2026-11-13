import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  APP_THEME_PREFERENCES_STORAGE_KEY,
  APP_THEME_PRESET_STORAGE_KEY_PREFIX,
  APP_THEME_STORAGE_KEY,
  DEFAULT_APP_THEME_PREFERENCES,
} from "../src/theme/appTheme";
import { RAFT_DARK_THEME_CHROME_COLOR, RAFT_LIGHT_THEME_CHROME_COLOR } from "../src/theme/appThemeChrome";

function executeBootstrap({
  storageEntries,
  systemDark = false,
}: {
  storageEntries: Record<string, string>;
  systemDark?: boolean;
}) {
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    classList: {
      toggle(name: string, force?: boolean) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    style: {} as Record<string, string>,
  };
  const themeColor = { content: "#FFD440" };
  const script = readFileSync(new URL("../public/app-theme-bootstrap.js", import.meta.url), "utf8");
  vm.runInNewContext(script, {
    document: {
      documentElement: root,
      querySelector(selector: string) {
        return selector === 'meta[name="theme-color"]' ? themeColor : null;
      },
    },
    localStorage: {
      get length() {
        return Object.keys(storageEntries).length;
      },
      key(index: number) {
        return Object.keys(storageEntries)[index] ?? null;
      },
      getItem(key: string) {
        return storageEntries[key] ?? null;
      },
      setItem(key: string, value: string) {
        storageEntries[key] = value;
      },
    },
    matchMedia() {
      return { matches: systemDark };
    },
  });
  return { classes, root, storageEntries, themeColor };
}

test("every first paint sets only the mode; no theme family is named", () => {
  // raft-ui has no family axis and AppThemeProvider writes only the mode
  // (light/dark class + color-scheme), so the first paint must not leave a
  // `data-theme` family on <html> that nothing reads or updates.
  for (const systemDark of [false, true]) {
    const { classes, root } = executeBootstrap({ storageEntries: {}, systemDark });
    assert.equal(root.dataset.theme, undefined, "public/app-theme-bootstrap.js still writes a data-theme family");
    assert.deepEqual([...classes].sort(), [systemDark ? "dark" : "light"]);
  }
});

test("a browser with no saved choice follows the system appearance", () => {
  assert.equal(DEFAULT_APP_THEME_PREFERENCES.mode, "system");

  const light = executeBootstrap({ storageEntries: {}, systemDark: false });
  assert.equal(light.classes.has("light"), true);
  assert.equal(light.classes.has("dark"), false);
  assert.equal(light.root.style.colorScheme, "light");
  assert.equal(light.themeColor.content, RAFT_LIGHT_THEME_CHROME_COLOR);

  const dark = executeBootstrap({ storageEntries: {}, systemDark: true });
  assert.equal(dark.classes.has("dark"), true);
  assert.equal(dark.classes.has("light"), false);
  assert.equal(dark.root.style.colorScheme, "dark");
  assert.equal(dark.themeColor.content, RAFT_DARK_THEME_CHROME_COLOR);
});

test("an explicit device preference overrides the system appearance, including a two-axis record", () => {
  const current = executeBootstrap({
    storageEntries: { [APP_THEME_PREFERENCES_STORAGE_KEY]: JSON.stringify({ mode: "light" }) },
    systemDark: true,
  });
  assert.equal(current.classes.has("light"), true);
  assert.equal(current.root.style.colorScheme, "light");

  const twoAxis = executeBootstrap({
    storageEntries: {
      [APP_THEME_PREFERENCES_STORAGE_KEY]: JSON.stringify({ mode: "dark", lightThemeId: "brutal", darkThemeId: "elegant" }),
    },
    systemDark: false,
  });
  // The record's old theme ids select nothing; only its mode applies.
  assert.equal(twoAxis.classes.has("dark"), true);
  assert.equal(twoAxis.classes.has("light"), false);
  assert.equal(twoAxis.root.style.colorScheme, "dark");
});

test("legacy brutal stays light when the system is dark and storage cannot be written", () => {
  const entries: Record<string, string> = { [APP_THEME_STORAGE_KEY]: "brutal" };
  const storageEntries = new Proxy(entries, {
    set() {
      throw new Error("storage is read-only");
    },
  });
  const { classes, root } = executeBootstrap({ storageEntries, systemDark: true });

  assert.equal(classes.has("dark"), false);
  assert.equal(root.style.colorScheme, "light");
  assert.equal(entries[APP_THEME_PREFERENCES_STORAGE_KEY], undefined);
});

test("a legacy device preset is promoted once when the current key is empty", () => {
  const { classes, themeColor, storageEntries } = executeBootstrap({
    storageEntries: { [APP_THEME_STORAGE_KEY]: "elegant-dark" },
    systemDark: false,
  });

  assert.equal(classes.has("dark"), true);
  assert.equal(themeColor.content, RAFT_DARK_THEME_CHROME_COLOR);
  assert.equal(storageEntries[APP_THEME_PREFERENCES_STORAGE_KEY], JSON.stringify({ mode: "dark" }));

  storageEntries[APP_THEME_STORAGE_KEY] = "brutal";
  const second = executeBootstrap({ storageEntries, systemDark: false });
  assert.equal(second.classes.has("dark"), true);
});

test("one old account preference migrates, but several accounts do not", () => {
  const one = executeBootstrap({
    storageEntries: {
      [`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-a`]: "elegant-light",
    },
    systemDark: true,
  });
  assert.equal(one.classes.has("light"), true);

  const many = executeBootstrap({
    storageEntries: {
      [`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-a`]: "elegant-dark",
      [`${APP_THEME_PRESET_STORAGE_KEY_PREFIX}account-b`]: "elegant-light",
    },
    systemDark: false,
  });
  assert.equal(many.classes.has("dark"), false, "several accounts disagree: the system default applies");
});

test("corrupt device storage falls back to the system default", () => {
  const { classes } = executeBootstrap({
    storageEntries: { [APP_THEME_PREFERENCES_STORAGE_KEY]: "{" },
    systemDark: true,
  });

  assert.equal(classes.has("dark"), true);
});
