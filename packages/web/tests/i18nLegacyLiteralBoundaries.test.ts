import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

/**
 * Named decision: retain 22 legacy FormatJS baseline literals, but prove they
 * stay unconsumed so they cannot silently become production-visible.
 *
 * Families:
 * 1. SETTINGS_LABEL_BY_ID / SETTINGS_TABS English labels
 * 2. reaction sprite `.label` strings
 * 3. runtimeApiUrlUnsupportedCopy
 */

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

const SETTINGS_NAV = "src/components/settings/settingsNavigation.ts";
const REACTION_MANIFEST = "src/generated/reactionSpriteManifest.ts";
const RUNTIME_CONFIG_FORM = "src/utils/runtimeConfigForm.ts";

type SourceMap = Map<string, string>;

function listTsSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listTsSources(path);
    // Exclude declaration files; `*.d.ts` also matches `\.(?:ts|tsx)$`.
    if (entry.name.endsWith(".d.ts")) return [];
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function loadProductionSources(): SourceMap {
  const map: SourceMap = new Map();
  for (const absolute of listTsSources(srcRoot)) {
    map.set(relative(repoRoot, absolute).replaceAll("\\", "/"), readFileSync(absolute, "utf8"));
  }
  return map;
}

/**
 * Return relative paths (posix) under src that reference `symbol`, excluding
 * the declaration file itself. Scans identifiers with word boundaries so
 * substring collisions do not count.
 */
function findSymbolConsumers(
  sources: SourceMap,
  symbol: string,
  declarationRelPath: string,
): string[] {
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const consumers: string[] = [];
  for (const [relPath, source] of sources) {
    if (relPath === declarationRelPath) continue;
    if (!relPath.startsWith("src/")) continue;
    if (pattern.test(source)) consumers.push(relPath);
  }
  return consumers.sort();
}

/**
 * True when `source` reads property `field` via `.field`, `["field"]` /
 * `['field']`, or destructuring `{ field }` / `{ field: alias }` / `{ …, field }`.
 */
function sourceReadsProperty(source: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\.${escaped}\\b`).test(source)) return true;
  if (new RegExp(`\\[["']${escaped}["']\\]`).test(source)) return true;
  // Destructuring / binding forms: `{ field }`, `{ field, … }`, `{ field: x }`,
  // `{ width, field }`, `{ width, field: x }`.
  if (new RegExp(`\\{[^}]*\\b${escaped}\\s*[,}:]`).test(source)) return true;
  return false;
}

/**
 * Production files that import SETTINGS_TABS or SETTINGS_GROUPS and read an
 * item's legacy English `.label` / `.title` (the baseline literals live on
 * SETTINGS_TABS entries; SETTINGS_GROUPS exposes the same objects via `items`).
 */
function findSettingsTabLegacyFieldReaders(
  sources: SourceMap,
  declarationRelPath: string,
): string[] {
  const importPattern = /\bSETTINGS_(?:TABS|GROUPS)\b/;
  const readers: string[] = [];
  for (const [relPath, source] of sources) {
    if (relPath === declarationRelPath) continue;
    if (!relPath.startsWith("src/")) continue;
    if (!importPattern.test(source)) continue;
    if (sourceReadsProperty(source, "label") || sourceReadsProperty(source, "title")) {
      readers.push(relPath);
    }
  }
  return readers.sort();
}

/**
 * Among production files that import the reaction sprite manifest, return those
 * that read a `label` property (the legacy English strings) via `.label`,
 * `["label"]`, or destructuring. The manifest declaration itself is excluded.
 */
function findReactionSpriteLabelReaders(
  sources: SourceMap,
  declarationRelPath: string,
): string[] {
  const importPattern = /from\s+["'][^"']*reactionSpriteManifest["']/;
  const readers: string[] = [];
  for (const [relPath, source] of sources) {
    if (relPath === declarationRelPath) continue;
    if (!relPath.startsWith("src/")) continue;
    if (!importPattern.test(source)) continue;
    if (sourceReadsProperty(source, "label")) readers.push(relPath);
  }
  return readers.sort();
}

// ── Presence: retain the legacy values ──────────────────────────────────────

test("SETTINGS_LABEL_BY_ID remains exported from settings navigation", () => {
  const source = readFileSync(resolve(repoRoot, SETTINGS_NAV), "utf8");
  assert.match(source, /export const SETTINGS_LABEL_BY_ID\b/);
  assert.match(source, /label: "Account"/);
});

test("reaction sprite labels remain present on generated items", () => {
  const source = readFileSync(resolve(repoRoot, REACTION_MANIFEST), "utf8");
  assert.match(source, /label: string/);
  assert.match(source, /label: "Thumbs up"/);
  assert.match(source, /label: "Heart"/);
});

test("runtimeApiUrlUnsupportedCopy remains exported", () => {
  const source = readFileSync(resolve(repoRoot, RUNTIME_CONFIG_FORM), "utf8");
  assert.match(source, /export function runtimeApiUrlUnsupportedCopy\b/);
  assert.match(source, /Cursor CLI does not expose a per-agent API URL/);
});

// ── Non-consumption boundaries ──────────────────────────────────────────────

test("no production source reads SETTINGS_LABEL_BY_ID", () => {
  const consumers = findSymbolConsumers(
    loadProductionSources(),
    "SETTINGS_LABEL_BY_ID",
    SETTINGS_NAV,
  );
  assert.deepEqual(
    consumers,
    [],
    `SETTINGS_LABEL_BY_ID must stay unconsumed; new readers:\n${consumers.join("\n")}`,
  );
});

test("production settings nav does not read SETTINGS_TABS/GROUPS item label/title", () => {
  const readers = findSettingsTabLegacyFieldReaders(
    loadProductionSources(),
    SETTINGS_NAV,
  );
  assert.deepEqual(
    readers,
    [],
    `SETTINGS_TABS/GROUPS item .label/.title must stay unconsumed; new readers:\n${readers.join("\n")}`,
  );
});

test("production reaction renderers do not read .label", () => {
  const readers = findReactionSpriteLabelReaders(
    loadProductionSources(),
    REACTION_MANIFEST,
  );
  assert.deepEqual(
    readers,
    [],
    `reaction sprite .label must stay unconsumed; new readers:\n${readers.join("\n")}`,
  );
});

test("no production source imports or calls runtimeApiUrlUnsupportedCopy", () => {
  const consumers = findSymbolConsumers(
    loadProductionSources(),
    "runtimeApiUrlUnsupportedCopy",
    RUNTIME_CONFIG_FORM,
  );
  assert.deepEqual(
    consumers,
    [],
    `runtimeApiUrlUnsupportedCopy must stay unconsumed; new readers:\n${consumers.join("\n")}`,
  );
});

// ── Mutation-style RED: helpers report synthetic consumers ──────────────────

test("findSymbolConsumers reports a synthetic SETTINGS_LABEL_BY_ID reader", () => {
  const sources: SourceMap = new Map([
    [SETTINGS_NAV, 'export const SETTINGS_LABEL_BY_ID = { account: "Account" };\n'],
    [
      "src/components/settings/EvilConsumer.tsx",
      'import { SETTINGS_LABEL_BY_ID } from "./settingsNavigation";\nvoid SETTINGS_LABEL_BY_ID.account;\n',
    ],
  ]);
  assert.deepEqual(
    findSymbolConsumers(sources, "SETTINGS_LABEL_BY_ID", SETTINGS_NAV),
    ["src/components/settings/EvilConsumer.tsx"],
  );
});

test("findSettingsTabLegacyFieldReaders reports {item.label} / {item.title} reflux", () => {
  const sources: SourceMap = new Map([
    [SETTINGS_NAV, "export const SETTINGS_TABS = [];\nexport const SETTINGS_GROUPS = [];\n"],
    [
      "src/components/settings/EvilSettingsLabel.tsx",
      'import { SETTINGS_GROUPS } from "./settingsNavigation";\nexport const t = SETTINGS_GROUPS.flatMap((g) => g.items.map((item) => item.label));\n',
    ],
    [
      "src/components/settings/EvilSettingsTitle.tsx",
      'import { SETTINGS_GROUPS } from "./settingsNavigation";\nexport const t = SETTINGS_GROUPS.flatMap((g) => g.items.map((item) => <span>{item.title}</span>));\n',
    ],
    [
      "src/components/settings/SafeSettingsNav.tsx",
      'import { SETTINGS_GROUPS, SETTINGS_TAB_NAV_LABEL_ID } from "./settingsNavigation";\nexport const t = SETTINGS_GROUPS.map((group) => group.items.map((item) => SETTINGS_TAB_NAV_LABEL_ID[item.id]));\n',
    ],
  ]);
  assert.deepEqual(
    findSettingsTabLegacyFieldReaders(sources, SETTINGS_NAV),
    [
      "src/components/settings/EvilSettingsLabel.tsx",
      "src/components/settings/EvilSettingsTitle.tsx",
    ],
  );
});

test("findReactionSpriteLabelReaders reports .label, [\"label\"], and { label } readers", () => {
  const sources: SourceMap = new Map([
    [REACTION_MANIFEST, 'export const REACTION_SPRITE_ITEMS = { "👍": { label: "Thumbs up" } };\n'],
    [
      "src/components/message/EvilReactionDot.tsx",
      'import { REACTION_SPRITE_ITEMS } from "../../generated/reactionSpriteManifest";\nexport const t = REACTION_SPRITE_ITEMS["👍"].label;\n',
    ],
    [
      "src/components/message/EvilReactionBracket.tsx",
      'import { REACTION_SPRITE_ITEMS } from "../../generated/reactionSpriteManifest";\nexport const t = REACTION_SPRITE_ITEMS["👍"]["label"];\n',
    ],
    [
      "src/components/message/EvilReactionDestructure.tsx",
      'import { REACTION_SPRITE_ITEMS } from "../../generated/reactionSpriteManifest";\nconst { label } = REACTION_SPRITE_ITEMS["👍"];\nexport const t = label;\n',
    ],
    [
      "src/components/message/SafeReaction.tsx",
      'import { REACTION_SPRITE_ITEMS } from "../../generated/reactionSpriteManifest";\nexport const w = REACTION_SPRITE_ITEMS["👍"].width;\n',
    ],
  ]);
  assert.deepEqual(
    findReactionSpriteLabelReaders(sources, REACTION_MANIFEST),
    [
      "src/components/message/EvilReactionBracket.tsx",
      "src/components/message/EvilReactionDestructure.tsx",
      "src/components/message/EvilReactionDot.tsx",
    ],
  );
});

test("findSymbolConsumers reports a synthetic runtimeApiUrlUnsupportedCopy caller", () => {
  const sources: SourceMap = new Map([
    [RUNTIME_CONFIG_FORM, "export function runtimeApiUrlUnsupportedCopy() { return null; }\n"],
    [
      "src/components/agent/EvilRuntimeForm.tsx",
      'import { runtimeApiUrlUnsupportedCopy } from "../../utils/runtimeConfigForm";\nexport const copy = runtimeApiUrlUnsupportedCopy("cursor");\n',
    ],
  ]);
  assert.deepEqual(
    findSymbolConsumers(sources, "runtimeApiUrlUnsupportedCopy", RUNTIME_CONFIG_FORM),
    ["src/components/agent/EvilRuntimeForm.tsx"],
  );
});
