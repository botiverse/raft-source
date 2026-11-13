import assert from "node:assert/strict";
import { entryModuleId, startupCodeSplittingGroups } from "../scripts/startupChunkGroups";

// A module graph as Vite names it: forward slashes, also on Windows.
const modules: Record<string, { code: string; importedIds: string[] }> = {
  "D:/a/slock/apps/desktop/frontend/src/main.tsx": {
    code: 'import { App } from "./App";\nApp();',
    importedIds: ["D:/a/slock/apps/desktop/frontend/src/App.tsx"],
  },
  "D:/a/slock/apps/desktop/frontend/src/App.tsx": {
    code: "export function App() {}",
    importedIds: [],
  },
  "D:/a/slock/apps/desktop/frontend/src/LazyPanel.tsx": {
    code: "export function LazyPanel() {}",
    importedIds: [],
  },
};

function fakeContext() {
  return {
    getModuleInfo: (id: string) => {
      const module = modules[id];
      return module ? { id, code: module.code, importedIds: module.importedIds } : null;
    },
  };
}

function appShellGroupOf(entry: string) {
  const group = startupCodeSplittingGroups(entry).find((candidate) => candidate.debugName === "app-shell");
  assert.ok(group && typeof group.name === "function");
  return group.name as (moduleId: string, ctx: ReturnType<typeof fakeContext>) => string | null;
}

test("a Windows entry path finds the forward-slash module id Vite gives it", () => {
  const ctx = fakeContext();
  assert.equal(
    entryModuleId("D:\\a\\slock\\apps\\desktop\\frontend\\src\\main.tsx", ctx),
    "D:/a/slock/apps/desktop/frontend/src/main.tsx",
  );
  assert.equal(entryModuleId("D:/a/slock/apps/desktop/frontend/src/main.tsx", ctx), "D:/a/slock/apps/desktop/frontend/src/main.tsx");
});

test("an entry path that matches no module is returned unchanged", () => {
  assert.equal(entryModuleId("/no/such/main.tsx", fakeContext()), "/no/such/main.tsx");
});

test("with a Windows entry path the startup closure still lands in app-shell (Desktop's Windows build)", () => {
  const appShell = appShellGroupOf("D:\\a\\slock\\apps\\desktop\\frontend\\src\\main.tsx");
  const ctx = fakeContext();
  assert.equal(appShell("D:/a/slock/apps/desktop/frontend/src/App.tsx", ctx), "app-shell");
  assert.equal(appShell("D:/a/slock/apps/desktop/frontend/src/LazyPanel.tsx", ctx), null);
  assert.equal(appShell("D:/a/slock/apps/desktop/frontend/src/main.tsx", ctx), null);
});

test("a POSIX entry path groups the same way", () => {
  const posix: Record<string, { code: string; importedIds: string[] }> = {
    "/repo/src/main.tsx": { code: 'import { App } from "./App";', importedIds: ["/repo/src/App.tsx"] },
    "/repo/src/App.tsx": { code: "export function App() {}", importedIds: [] },
  };
  const ctx = {
    getModuleInfo: (id: string) => (posix[id] ? { id, ...posix[id] } : null),
  };
  const group = startupCodeSplittingGroups("/repo/src/main.tsx").find((candidate) => candidate.debugName === "app-shell");
  assert.ok(group && typeof group.name === "function");
  const appShell = group.name as (moduleId: string, context: typeof ctx) => string | null;
  assert.equal(appShell("/repo/src/App.tsx", ctx), "app-shell");
});

test("startup dependencies that change often, or are large and stable, get their own chunks (task #164)", () => {
  const nm = "/repo/node_modules/.pnpm";
  const graph: Record<string, { code: string; importedIds: string[] }> = {
    "/repo/src/main.tsx": {
      code: 'import { a } from "x";',
      importedIds: [
        `${nm}/lucide-react@1/node_modules/lucide-react/dist/icon.js`,
        `${nm}/@base-ui+react@1/node_modules/@base-ui/react/button.js`,
        `${nm}/zod@4/node_modules/zod/index.js`,
        `${nm}/axios@1/node_modules/axios/index.js`,
        `${nm}/zustand@5/node_modules/zustand/index.js`,
      ],
    },
  };
  for (const id of graph["/repo/src/main.tsx"].importedIds) graph[id] = { code: "export const a = 1;", importedIds: [] };
  graph[`${nm}/lazy-only@1/node_modules/lazy-only/index.js`] = { code: "export const a = 1;", importedIds: [] };
  const ctx = { getModuleInfo: (id: string) => (graph[id] ? { id, ...graph[id] } : null) };
  const groups = startupCodeSplittingGroups("/repo/src/main.tsx");
  // The first group whose name() answers wins, as in Rolldown.
  const chunkOf = (id: string) => {
    for (const group of groups) {
      const name = typeof group.name === "function" ? (group.name as (m: string, c: typeof ctx) => string | null)(id, ctx) : null;
      if (name) return name;
    }
    return null;
  };
  assert.equal(chunkOf(`${nm}/lucide-react@1/node_modules/lucide-react/dist/icon.js`), "vendor-icons-base-ui");
  assert.equal(chunkOf(`${nm}/@base-ui+react@1/node_modules/@base-ui/react/button.js`), "vendor-icons-base-ui");
  assert.equal(chunkOf(`${nm}/zod@4/node_modules/zod/index.js`), "vendor-zod-axios");
  assert.equal(chunkOf(`${nm}/axios@1/node_modules/axios/index.js`), "vendor-zod-axios");
  assert.equal(chunkOf(`${nm}/zustand@5/node_modules/zustand/index.js`), "vendor-startup");
  // Not on the startup path: left to Rolldown's default splitting.
  assert.equal(chunkOf(`${nm}/lazy-only@1/node_modules/lazy-only/index.js`), null);
});

test("a bundled library's import/export barrel only brings the parts startup imports (raft-ui dist/index.mjs)", () => {
  const ui = "/repo/node_modules/.pnpm/@botiverse+raft-ui@1/node_modules/@botiverse/raft-ui/dist";
  const graph: Record<string, { code: string; importedIds: string[] }> = {
    "/repo/src/main.tsx": {
      code: 'import { Button, AnnouncementDialog } from "@botiverse/raft-ui";\nButton(); AnnouncementDialog();',
      importedIds: [`${ui}/index.mjs`],
    },
    "/repo/src/LazyPage.tsx": {
      code: 'import { SelectionToolbar } from "@botiverse/raft-ui";\nexport default SelectionToolbar;',
      importedIds: [`${ui}/index.mjs`],
    },
    [`${ui}/index.mjs`]: {
      code: [
        'import "./lib/drag-escape.mjs";',
        'import { Button } from "./components/button/button.mjs";',
        'import { Dialog as AnnouncementDialog } from "./components/dialog/dialog.mjs";',
        'import { SelectionToolbar } from "./components/selection-toolbar/selection-toolbar.mjs";',
        "export { AnnouncementDialog, Button, SelectionToolbar };",
      ].join("\n"),
      importedIds: [
        `${ui}/lib/drag-escape.mjs`,
        `${ui}/components/button/button.mjs`,
        `${ui}/components/dialog/dialog.mjs`,
        `${ui}/components/selection-toolbar/selection-toolbar.mjs`,
      ],
    },
    [`${ui}/lib/drag-escape.mjs`]: { code: "function guard() {}\nguard();\nexport { guard };", importedIds: [] },
    [`${ui}/components/button/button.mjs`]: { code: "function Button() {}\nexport { Button };", importedIds: [] },
    [`${ui}/components/dialog/dialog.mjs`]: { code: "function Dialog() {}\nexport { Dialog };", importedIds: [] },
    [`${ui}/components/selection-toolbar/selection-toolbar.mjs`]: { code: "function SelectionToolbar() {}\nexport { SelectionToolbar };", importedIds: [] },
  };
  const ctx = { getModuleInfo: (id: string) => (graph[id] ? { id, ...graph[id] } : null) };
  const group = startupCodeSplittingGroups("/repo/src/main.tsx").find((candidate) => candidate.debugName === "vendor-raft-ui");
  assert.ok(group && typeof group.name === "function");
  const raftUi = group.name as (moduleId: string, context: typeof ctx) => string | null;
  assert.equal(raftUi(`${ui}/components/button/button.mjs`, ctx), "vendor-raft-ui");
  // Exported under another name: the source module's own name is what startup needs.
  assert.equal(raftUi(`${ui}/components/dialog/dialog.mjs`, ctx), "vendor-raft-ui");
  // A side-effect import is always startup.
  assert.equal(raftUi(`${ui}/lib/drag-escape.mjs`, ctx), "vendor-raft-ui");
  // Only a lazy page uses it.
  assert.equal(raftUi(`${ui}/components/selection-toolbar/selection-toolbar.mjs`, ctx), null);
});

test("a module that declares an export of its own is not a barrel: all of its imports are startup", () => {
  const graph: Record<string, { code: string; importedIds: string[] }> = {
    "/repo/src/main.tsx": { code: 'import { a } from "./mixed";\na();', importedIds: ["/repo/src/mixed.ts"] },
    "/repo/src/mixed.ts": {
      code: 'import { b } from "./b";\nconst a = () => b();\nexport { a, b };',
      importedIds: ["/repo/src/b.ts"],
    },
    "/repo/src/b.ts": { code: "export function c() {}", importedIds: [] },
  };
  const ctx = { getModuleInfo: (id: string) => (graph[id] ? { id, ...graph[id] } : null) };
  const appShell = startupCodeSplittingGroups("/repo/src/main.tsx").find((candidate) => candidate.debugName === "app-shell");
  assert.ok(appShell && typeof appShell.name === "function");
  const name = appShell.name as (moduleId: string, context: typeof ctx) => string | null;
  assert.equal(name("/repo/src/b.ts", ctx), "app-shell");
});

test("on the web the app's slow-moving startup code (small workspace packages, generated data) gets app-stable, ahead of app-shell", () => {
  const graph: Record<string, { code: string; importedIds: string[] }> = {
    "/repo/packages/web/src/main.tsx": {
      code: 'import { a } from "@botiverse/raft-sync-core"; import { b } from "../../shared/src/piBuiltinModels.generated"; import { c } from "./generated/composerPinyinData"; import d from "../../shared/assets/pixelAvatars.json"; import { e } from "./App";',
      importedIds: [
        "/repo/packages/sync-core/src/index.ts",
        "/repo/packages/shared/src/piBuiltinModels.generated.ts",
        "/repo/packages/web/src/generated/composerPinyinData.ts",
        "/repo/packages/shared/assets/pixelAvatars.json",
        "/repo/packages/web/src/App.tsx",
      ],
    },
    "/repo/packages/sync-core/src/index.ts": { code: "export const a = 1;", importedIds: [] },
    "/repo/packages/shared/src/piBuiltinModels.generated.ts": { code: "export const b = 1;", importedIds: [] },
    "/repo/packages/web/src/generated/composerPinyinData.ts": { code: "export const c = 1;", importedIds: [] },
    "/repo/packages/shared/assets/pixelAvatars.json": { code: "export default {};", importedIds: [] },
    "/repo/packages/web/src/App.tsx": { code: "export const e = 1;", importedIds: [] },
  };
  const ctx = { getModuleInfo: (id: string) => (graph[id] ? { id, ...graph[id] } : null) };
  assert.ok(!startupCodeSplittingGroups("/repo/packages/web/src/main.tsx").some((group) => group.debugName === "app-stable"), "Raft Desktop: no app-stable");
  const groups = startupCodeSplittingGroups("/repo/packages/web/src/main.tsx", { appStable: true });
  const names = groups.map((group) => group.debugName ?? group.name);
  assert.ok(names.indexOf("app-stable") === names.indexOf("app-shell") - 1, "app-stable is grouped right before app-shell");
  const stable = groups.find((group) => group.debugName === "app-stable")!.name as (moduleId: string, context: typeof ctx) => string | null;
  for (const id of Object.keys(graph).filter((id) => !id.endsWith("main.tsx") && !id.endsWith("App.tsx"))) {
    assert.equal(stable(id, ctx), "app-stable", id);
  }
  assert.equal(stable("/repo/packages/web/src/App.tsx", ctx), null);
  // Off the startup path it stays where the lazy page that imports it goes.
  assert.equal(stable("/repo/packages/runtime-form/src/lazyOnly.ts", ctx), null);
});
