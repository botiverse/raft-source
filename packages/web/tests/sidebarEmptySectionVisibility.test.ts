import assert from "node:assert/strict";
import {
  defaultHideEmptySidebarSections,
  readHideEmptySidebarSections,
  shouldHideEmptySidebarSection,
  writeHideEmptySidebarSections,
} from "../src/components/layout/sidebarEmptySectionVisibility";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

type DesktopGlobal = { window?: { raftDesktop?: { isDesktop?: boolean } } };

function withDesktopShell(run: () => void) {
  const target = globalThis as DesktopGlobal;
  const hadWindow = "window" in globalThis;
  const originalWindow = target.window;
  target.window = { raftDesktop: { isDesktop: true } };
  try {
    run();
  } finally {
    if (hadWindow) target.window = originalWindow;
    else delete target.window;
  }
}

test("hide-empty-sections defaults to OFF on the web", () => {
  // No `window.raftDesktop` in the node test env → web default is OFF.
  assert.equal(defaultHideEmptySidebarSections(), false);
  assert.equal(readHideEmptySidebarSections(memoryStorage()), false);
});

test("hide-empty-sections defaults to OFF in the desktop shell too", () => {
  withDesktopShell(() => {
    assert.equal(defaultHideEmptySidebarSections(), false);
    assert.equal(readHideEmptySidebarSections(memoryStorage()), false);
  });
});

test("an explicit prior choice is preserved under the OFF default", () => {
  withDesktopShell(() => {
    // A desktop user who explicitly turned it on keeps it on…
    const chosenOn = memoryStorage();
    writeHideEmptySidebarSections(true, chosenOn);
    assert.equal(readHideEmptySidebarSections(chosenOn), true);

    // …and an explicit "off" stays off.
    const chosenOff = memoryStorage();
    writeHideEmptySidebarSections(false, chosenOff);
    assert.equal(readHideEmptySidebarSections(chosenOff), false);
  });
});

test("an explicit stored choice wins over the provided fallback", () => {
  const storage = memoryStorage();

  writeHideEmptySidebarSections(false, storage);
  assert.equal(readHideEmptySidebarSections(storage, true), false);

  writeHideEmptySidebarSections(true, storage);
  assert.equal(readHideEmptySidebarSections(storage, false), true);
});

test("with no stored value the provided fallback (platform default) is used", () => {
  const storage = memoryStorage();
  assert.equal(readHideEmptySidebarSections(storage, true), true);
  assert.equal(readHideEmptySidebarSections(storage, false), false);
});

test("persistence tolerates unavailable storage", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("unavailable");
    },
    setItem: () => {
      throw new Error("unavailable");
    },
  };

  assert.equal(readHideEmptySidebarSections(throwingStorage, true), true);
  assert.doesNotThrow(() => writeHideEmptySidebarSections(true, throwingStorage));
});

test("empty sidebar sections stay hidden unless they are active drag surfaces", () => {
  const base = {
    hideEmptySections: true,
    loading: false,
    itemCount: 0,
  };

  assert.equal(shouldHideEmptySidebarSection(base), true);
  assert.equal(shouldHideEmptySidebarSection({ ...base, itemCount: 1 }), false);
  assert.equal(shouldHideEmptySidebarSection({ ...base, loading: true }), false);
  assert.equal(shouldHideEmptySidebarSection({ ...base, hideEmptySections: false }), false);

  assert.equal(shouldHideEmptySidebarSection({ ...base, dragActive: true }), true);
  assert.equal(shouldHideEmptySidebarSection({
    ...base,
    dragActive: true,
    dragStartedInSection: true,
  }), false);
  assert.equal(shouldHideEmptySidebarSection({
    ...base,
    dragActive: true,
    revealWhileDragging: true,
  }), false);
});
