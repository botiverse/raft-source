import assert from "node:assert/strict";
import { validateEntryChunkStructure } from "../scripts/check-entry-chunk-structure";

const manifest = {
  "index.html": {
    file: "assets/index-AAAAAAAA.js",
    isEntry: true,
    imports: ["_app-shell-BBBBBBBB.js", "_vendor-react-CCCCCCCC.js"],
  },
  "_app-shell-BBBBBBBB.js": { file: "assets/app-shell-BBBBBBBB.js", imports: ["_vendor-react-CCCCCCCC.js"] },
  "_vendor-react-CCCCCCCC.js": { file: "assets/vendor-react-CCCCCCCC.js" },
  "src/components/Lazy.tsx": { file: "assets/Lazy-DDDDDDDD.js", isDynamicEntry: true },
};

function chunks(overrides: Record<string, string> = {}) {
  return new Map(Object.entries({
    "assets/index-AAAAAAAA.js": 'import "./app-shell-BBBBBBBB.js"; async function boot() { await Promise.resolve(); } boot();',
    "assets/app-shell-BBBBBBBB.js": "export const shell = async () => { for await (const x of []) void x; };",
    "assets/vendor-react-CCCCCCCC.js": "export const react = 1;",
    "assets/Lazy-DDDDDDDD.js": "export default class Lazy { async load() { await 1; } }",
    ...overrides,
  }));
}

test("awaits inside functions and the named initial groups pass", () => {
  const result = validateEntryChunkStructure({ manifest, chunks: chunks() });
  assert.equal(result.jsChunkCount, 4);
  assert.deepEqual(result.initial.toSorted(), [
    "assets/app-shell-BBBBBBBB.js",
    "assets/index-AAAAAAAA.js",
    "assets/vendor-react-CCCCCCCC.js",
  ]);
});

test("a top-level await in any chunk, including a lazy one, fails", () => {
  for (const code of ["await Promise.resolve();", "for await (const x of []) void x;", "if (globalThis.x) { await 1; }"]) {
    assert.throws(
      () => validateEntryChunkStructure({ manifest, chunks: chunks({ "assets/Lazy-DDDDDDDD.js": code }) }),
      /Lazy-DDDDDDDD\.js contains a top-level await/,
    );
  }
});

test("an unexpected or duplicated chunk in the entry's static closure fails", () => {
  const split = {
    ...manifest,
    "index.html": { ...manifest["index.html"], imports: [...manifest["index.html"].imports, "_useIntl-EEEEEEEE.js", "_app-shell-FFFFFFFF.js"] },
    "_useIntl-EEEEEEEE.js": { file: "assets/useIntl-EEEEEEEE.js" },
    "_app-shell-FFFFFFFF.js": { file: "assets/app-shell-FFFFFFFF.js" },
  };
  const extra = chunks({ "assets/useIntl-EEEEEEEE.js": "export {};", "assets/app-shell-FFFFFFFF.js": "export {};" });
  assert.throws(
    () => validateEntryChunkStructure({ manifest: split, chunks: extra }),
    (error: Error) =>
      /unexpected chunk useIntl/.test(error.message) && /initial chunk app-shell is split into 2 files/.test(error.message),
  );
});

test("a missing chunk or a second entry fails closed", () => {
  const missing = chunks();
  missing.delete("assets/Lazy-DDDDDDDD.js");
  assert.throws(() => validateEntryChunkStructure({ manifest, chunks: missing }), /Lazy-DDDDDDDD\.js is missing/);
  assert.throws(
    () => validateEntryChunkStructure({
      manifest: { ...manifest, "other.html": { file: "assets/other-GGGGGGGG.js", isEntry: true } },
      chunks: chunks({ "assets/other-GGGGGGGG.js": "export {};" }),
    }),
    /expected exactly one entry chunk, found 2/,
  );
});

test("a deferred module must keep a chunk of its own outside the first download", () => {
  assert.doesNotThrow(() => validateEntryChunkStructure({ manifest, chunks: chunks(), deferred: ["src/components/Lazy.tsx"] }));
  // Rolldown merges a lazy module that something on the startup path also imports statically.
  const merged = { ...manifest, "src/components/Lazy.tsx": { file: "assets/app-shell-BBBBBBBB.js", isDynamicEntry: true } };
  assert.throws(
    () => validateEntryChunkStructure({ manifest: merged, chunks: chunks(), deferred: ["src/components/Lazy.tsx"] }),
    /deferred module src\/components\/Lazy\.tsx is in the first download \(app-shell\)/,
  );
  assert.throws(
    () => validateEntryChunkStructure({ manifest, chunks: chunks(), deferred: ["src/components/Gone.tsx"] }),
    /deferred module src\/components\/Gone\.tsx has no chunk of its own/,
  );
});

test("the deferred modules are found in src/ with their files", async () => {
  const { findDeferredModules } = await import("../scripts/check-entry-chunk-structure");
  const found: string[] = await findDeferredModules(new URL("..", import.meta.url).pathname);
  assert.ok(found.includes("src/features/agent/CreateAgentDialog.tsx"), found.join(", "));
  assert.ok(found.includes("src/components/task/TasksPanel.tsx"), found.join(", "));
  // Through one inline wrapper arrow: lazyDeferred(() => importHandledLocally(() => import("./ArtifactViewer"))).
  assert.ok(found.includes("src/apps/artifacts/ArtifactViewer.tsx"), found.join(", "));
  // lazyPanel inline, and named loaders (landing pages, setup steps).
  assert.ok(found.includes("src/components/window/ThreadWindowRoute.tsx"), found.join(", "));
  assert.ok(found.includes("src/pages/HumanLoginSetupPage.tsx"), found.join(", "));
  assert.ok(found.includes("src/components/onboarding/ServerSetupSurveyStep.tsx"), found.join(", "));
});
