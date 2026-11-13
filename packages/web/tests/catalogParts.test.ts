/**
 * The catalog split (i18n/messages/catalogParts.ts, scripts/catalogPartsPlugin.ts,
 * scripts/check-catalog-parts.ts): the first part has every id the first
 * download's code names, the boot part a boot-started page's, and a later
 * chunk's load waits for what it may show.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { idsNamedBy, splitCatalog } from "../src/i18n/messages/catalogParts";
import { bootDownload, catalogPartSource, firstDownload, wrapLazyImports } from "../scripts/catalogPartsPlugin";
import { dynamicImportTargets, validateCatalogParts } from "../scripts/check-catalog-parts";

const IDS = [
  "common.cancel",
  "push.mention.title",
  "push.reply.title",
  "agent.status.idle",
  "agent.status.busy",
  "task.statusOpen",
  "settings.title",
  "handoff.title",
];

test("the first part: ids named whole, and every id under a prefix one is built from", () => {
  const code = [
    'f({id:"common.cancel"});',
    'g("push."+k);',
    "h(`agent.status.${s}`);",
    "i(`task.status${s}`);",
    // Not ids: an undotted template head (a tag name), a word, a path.
    "j(`h${level}`);k(\"settings\");l(`/s/${slug}`);",
  ].join("");
  assert.deepEqual([...idsNamedBy([code], IDS)].sort(), [
    "agent.status.busy",
    "agent.status.idle",
    "common.cancel",
    "push.mention.title",
    "push.reply.title",
    "task.statusOpen",
  ]);
});

test("a catalog splits into three parts with no id in two", () => {
  const parts = splitCatalog({ a: "A", b: "B", c: "C", d: "D" }, new Set(["b"]), new Set(["b", "d"]));
  assert.deepEqual(parts, { first: { b: "B" }, boot: { d: "D" }, rest: { a: "A", c: "C" } });
  assert.equal(catalogPartSource(parts.first), 'export default {"b":"B"};\n');
});

const chunk = (fileName: string, more: Partial<{ isEntry: boolean; imports: string[]; facadeModuleId: string | null; moduleIds: string[] }> = {}) => ({
  fileName,
  isEntry: false,
  imports: [],
  facadeModuleId: `/repo/packages/web/src/${fileName}.tsx`,
  moduleIds: [`/repo/packages/web/src/${fileName}.tsx`],
  ...more,
});

test("a later chunk with app code loads through the gate (a boot-started page's with \"boot\"); the first download and a package do not", () => {
  const chunks = Object.fromEntries([
    chunk("assets/index-!~{001}~.js", { isEntry: true, imports: ["assets/app-shell-!~{04$}~.js"] }),
    chunk("assets/app-shell-!~{04$}~.js"),
    chunk("assets/Settings-!~{0a$}~.js"),
    chunk("assets/RegisterPage-!~{0b$}~.js", { imports: ["assets/authForm-!~{0c$}~.js", "assets/app-shell-!~{04$}~.js"] }),
    chunk("assets/authForm-!~{0c$}~.js"),
    chunk("assets/katex-!~{003}~.js", { moduleIds: ["/repo/node_modules/katex/dist/katex.mjs"] }),
  ].map((c) => [c.fileName, c]));
  const boot = new Set(["/repo/packages/web/src/assets/RegisterPage-!~{0b$}~.js.tsx"]);
  const first = firstDownload(Object.values(chunks));
  assert.deepEqual([...first].sort(), ["assets/app-shell-!~{04$}~.js", "assets/index-!~{001}~.js"]);
  assert.deepEqual([...bootDownload(Object.values(chunks), boot, first)].sort(), ["assets/RegisterPage-!~{0b$}~.js", "assets/authForm-!~{0c$}~.js"]);
  const code = [
    'a(()=>import("./Settings-!~{0a$}~.js"))',
    "r(()=>import(`./RegisterPage-!~{0b$}~.js`))",
    "b(()=>import('./app-shell-!~{04$}~.js'))",
    'd(()=>import("./katex-!~{003}~.js"))',
  ].join(";");
  const wrapped = wrapLazyImports(code, "assets/app-shell-!~{04$}~.js", chunks, first, boot);
  assert.deepEqual(wrapped.unresolved, []);
  assert.equal(wrapped.code, [
    'a(()=>(globalThis.__raftCatalogGate||(m=>m))(import("./Settings-!~{0a$}~.js")))',
    'r(()=>(globalThis.__raftCatalogGate||(m=>m))(import(`./RegisterPage-!~{0b$}~.js`),"boot"))',
    "b(()=>import('./app-shell-!~{04$}~.js'))",
    'd(()=>import("./katex-!~{003}~.js"))',
  ].join(";"));
  assert.deepEqual(wrapLazyImports('import("./Gone.js")', "assets/x.js", chunks, first).unresolved, ["./Gone.js"]);
});

test("the boot-started pages are what their loaders import", () => {
  const files = new Set(["src/pages/RegisterPage.tsx", "src/pages/landing/Invite.ts"]);
  assert.deepEqual(
    dynamicImportTargets("src/pages/landingPages.ts", 'a=()=>import("./RegisterPage");b=()=>import(\'./landing/Invite\')', (path) => files.has(path)),
    ["src/pages/RegisterPage.tsx", "src/pages/landing/Invite.ts"],
  );
  assert.throws(() => dynamicImportTargets("src/x.ts", 'import("./Gone")', () => false), /import\(\.\/Gone\) not found/);
});

const LOCALES = ["en", "es", "pt-br", "ru", "ko", "ja", "zh-cn", "zh-tw"];

function build(overrides: { appShell?: string; register?: string; enFirst?: Record<string, string>; enBoot?: Record<string, string> } = {}) {
  const map = Object.fromEntries(LOCALES.flatMap((l) => [[l, `/assets/${l}-first-AAAAAAAA.js`], [`${l}:boot`, `/assets/${l}-boot-AAAAAAAA.js`], [`${l}:rest`, `/assets/${l}-rest-AAAAAAAA.js`]]));
  const parts = new Map<string, Record<string, string>>();
  for (const l of LOCALES) {
    parts.set(l, overrides.enFirst && l === "en" ? overrides.enFirst : { "common.cancel": "Cancel" });
    parts.set(`${l}:boot`, overrides.enBoot && l === "en" ? overrides.enBoot : { "auth.register.title": "Create account" });
    parts.set(`${l}:rest`, { "settings.title": "Settings" });
  }
  return {
    manifest: {
      "index.html": { file: "assets/index-A.js", isEntry: true, imports: ["_app-shell.js"] },
      "_app-shell.js": { file: "assets/app-shell-A.js" },
      "src/Settings.tsx": { file: "assets/Settings-A.js", isDynamicEntry: true },
      "src/RegisterPage.tsx": { file: "assets/RegisterPage-A.js", isDynamicEntry: true },
    },
    files: new Map([
      ["assets/index-A.js", ""],
      ["assets/app-shell-A.js", overrides.appShell ?? 'f("common.cancel");a(()=>(globalThis.__raftCatalogGate||(e=>e))(import(`./Settings-A.js`)));r(()=>(globalThis.__raftCatalogGate||(e=>e))(import("./RegisterPage-A.js"),"boot"))'],
      ["assets/Settings-A.js", 'f("settings.title")'],
      ["assets/RegisterPage-A.js", overrides.register ?? 'f("auth.register.title")'],
    ]),
    html: `<head><script type="application/json" id="raft-locale-catalogs">${JSON.stringify(map)}</script></head>`,
    parts,
    bootPages: ["src/RegisterPage.tsx"],
  };
}

const SHELL_GATES = 'a(()=>(globalThis.__raftCatalogGate||(e=>e))(import(`./Settings-A.js`)));r(()=>(globalThis.__raftCatalogGate||(e=>e))(import("./RegisterPage-A.js"),"boot"))';

test("the build check passes a sound split and names what breaks one", () => {
  assert.deepEqual(validateCatalogParts(build()), { firstIds: 1, bootIds: 1, restIds: 1, gated: 2, bootGated: 1 });
  assert.throws(
    () => validateCatalogParts(build({ appShell: 'f("common.cancel");a(()=>import(\'./Settings-A.js\'));r(()=>(globalThis.__raftCatalogGate||(e=>e))(import("./RegisterPage-A.js"),"boot"))' })),
    /app-shell-A\.js loads assets\/Settings-A\.js without the catalog gate/,
  );
  assert.throws(
    () => validateCatalogParts(build({ appShell: 'f("common.cancel");a(()=>(globalThis.__raftCatalogGate||(e=>e))(import(`./Settings-A.js`)));r(()=>(globalThis.__raftCatalogGate||(e=>e))(import("./RegisterPage-A.js")))' })),
    /loads assets\/RegisterPage-A\.js with the rest gate; it is a boot-started page/,
  );
  assert.throws(
    () => validateCatalogParts(build({ appShell: `f("common.cancel");g("settings.title");${SHELL_GATES}` })),
    /names 1 ids its first part lacks \(settings\.title\)/,
  );
  assert.throws(
    () => validateCatalogParts(build({ register: 'f("settings.title")' })),
    /boot-started pages name 1 ids its first and boot parts lack \(settings\.title\)/,
  );
  assert.throws(
    () => validateCatalogParts(build({ enFirst: { "common.cancel": "Cancel", "settings.title": "Settings" } })),
    /en: 1 ids in two parts/,
  );
  assert.throws(() => validateCatalogParts(build({ appShell: 'f("common.cancel")' })), /no later chunk load goes through the catalog gate/);
  const withWhole = build();
  (withWhole.manifest as Record<string, { file: string }>)["src/i18n/messages/en.ts"] = { file: "assets/en-A.js" };
  assert.throws(() => validateCatalogParts(withWhole), /a whole catalog is still built/);
});
