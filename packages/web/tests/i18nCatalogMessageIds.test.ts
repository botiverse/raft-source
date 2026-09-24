/**
 * Catalog MessageId exact filter for FormatJS object-literal findings.
 *
 * Required-Test Admission evidence (docs/sops/ci-check-maintenance.md)
 *
 * - Test/check: packages/web FormatJS literal gate catalog MessageId filter
 *   (`lint:i18n-literals` / i18n-catalog-message-ids.mjs)
 * - Protected invariant: object-literal values that are exact en.ts MessageIds
 *   are not debt; JSX / misspelled / random dotted / prose / templates stay
 * - RED proof: this file fails until loadCatalogMessageIds* + filter exist and
 *   collectCurrentFindings applies them after structural / before aggregate
 * - Unique evidence vs structural filter: membership is AST-derived catalog
 *   keys, not punctuation/shape heuristics
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  aggregateFindings,
  collectCurrentFindings,
  compareFindingsToBaseline,
  filterCatalogMessageIdFindings,
  filterIgnorableStructuralFindings,
  findingsFromOxlintDiagnostics,
  isCatalogMessageIdObjectLiteralFinding,
  loadCatalogMessageIdsFromPath,
  loadCatalogMessageIdsFromSource,
  runOxlintI18n,
} from "../scripts/check-i18n-literals.mjs";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const CONFIG = resolve(WEB_ROOT, "scripts/oxlint-i18n.json");
const EN_CATALOG = resolve(WEB_ROOT, "src/i18n/messages/en.ts");
const BASELINE_PATH = resolve(WEB_ROOT, "scripts/i18n-literal-baseline.json");

const FIXTURE_EN = `export const en = {
  "agent.scopes.group.action.label": "Action cards",
  "billing.startBuildingWithAgents": "Start building",
  "settings.roles.title": "Roles",
} as const;

export type MessageId = keyof typeof en;
`;

test("loadCatalogMessageIdsFromSource: AST extracts export const en keys", () => {
  const ids = loadCatalogMessageIdsFromSource(FIXTURE_EN, "fixture-en.ts");
  assert.ok(ids instanceof Set);
  assert.deepEqual(
    [...ids].sort(),
    [
      "agent.scopes.group.action.label",
      "billing.startBuildingWithAgents",
      "settings.roles.title",
    ],
  );
});

test("loadCatalogMessageIdsFromSource: fail closed on missing/non-object/unsupported key", () => {
  assert.throws(
    () => loadCatalogMessageIdsFromSource("export const other = {};\n", "bad.ts"),
    /missing|export const en/i,
  );
  assert.throws(
    () =>
      loadCatalogMessageIdsFromSource(
        'export const en = "not-an-object" as const;\n',
        "bad.ts",
      ),
    /object/i,
  );
  assert.throws(
    () =>
      loadCatalogMessageIdsFromSource(
        "export const en = { [computed]: \"x\" } as const;\nconst computed = \"k\";\n",
        "bad.ts",
      ),
    /unsupported|computed/i,
  );
  assert.throws(
    () =>
      loadCatalogMessageIdsFromSource(
        "export const en = { ...spread } as const;\nconst spread = {};\n",
        "bad.ts",
      ),
    /unsupported|spread/i,
  );
});

test("loadCatalogMessageIdsFromPath reads real packages/web en.ts", () => {
  const ids = loadCatalogMessageIdsFromPath(EN_CATALOG);
  assert.ok(ids.has("agent.scopes.group.action.label"));
  assert.ok(ids.has("billing.startBuildingWithAgents"));
  assert.ok(ids.size > 100);
});

/**
 * RED signature when unimplemented: isCatalogMessageIdObjectLiteralFinding /
 * filterCatalogMessageIdFindings is not a function (or keeps catalog members).
 */
test("isCatalogMessageIdObjectLiteralFinding: only object + plain quoted + catalog member", () => {
  const catalog = loadCatalogMessageIdsFromSource(FIXTURE_EN, "fixture-en.ts");
  const keep = [
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: '"agent.scopes.group.action.label"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"agent.scopes.group.action.labell"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"foo.bar.baz.not.in.catalog"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"Full server control."',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: "`agent.scopes.group.action.label`",
    },
    {
      path: "A.tsx",
      rule: "raft-i18n/no-literal-in-message-call",
      source: '"agent.scopes.group.action.label"',
    },
  ];
  for (const finding of keep) {
    assert.equal(
      isCatalogMessageIdObjectLiteralFinding(finding, catalog),
      false,
      `must KEEP: ${finding.rule} ${finding.source}`,
    );
  }
  assert.equal(
    isCatalogMessageIdObjectLiteralFinding(
      {
        path: "A.tsx",
        rule: "formatjs/no-literal-string-in-object",
        source: '"agent.scopes.group.action.label"',
      },
      catalog,
    ),
    true,
  );
  assert.equal(
    isCatalogMessageIdObjectLiteralFinding(
      {
        path: "A.tsx",
        rule: "formatjs/no-literal-string-in-object",
        source: '"billing.startBuildingWithAgents"',
      },
      catalog,
    ),
    true,
  );
});

test("filterCatalogMessageIdFindings drops only exact catalog object literals", () => {
  const catalog = loadCatalogMessageIdsFromSource(FIXTURE_EN, "fixture-en.ts");
  const raw = [
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"agent.scopes.group.action.label"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: '"agent.scopes.group.action.label"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"agent.scopes.group.action.labell"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"foo.bar.baz.not.in.catalog"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"Full server control."',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: "`agent.scopes.group.action.label`",
    },
  ];
  assert.deepEqual(filterCatalogMessageIdFindings(raw, catalog), [
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: '"agent.scopes.group.action.label"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"agent.scopes.group.action.labell"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"foo.bar.baz.not.in.catalog"',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"Full server control."',
    },
    {
      path: "A.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: "`agent.scopes.group.action.label`",
    },
  ]);
});

test("collectCurrentFindings: injected catalog filters object MessageIds; keeps JSX/misspell/prose/template", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-msgid-filter-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Ids.tsx"),
      // Property names must be in formatjs/no-literal-string-in-object include list.
      `export const rows = {
  label: "agent.scopes.group.action.label",
  summary: "agent.scopes.group.action.labell",
  details: "foo.bar.baz.not.in.catalog",
  subtitle: "Full server control.",
  contextLoadError: \`agent.scopes.group.action.label\`,
};

export function RawJsx() {
  return <span>{"agent.scopes.group.action.label"}</span>;
}
`,
    );
    const catalog = loadCatalogMessageIdsFromSource(FIXTURE_EN, "fixture-en.ts");
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
      catalogMessageIds: catalog,
    });
    const sources = findings.map((f) => `${f.rule} ${f.source}`).sort();
    assert.ok(
      !sources.some(
        (s) =>
          s ===
          'formatjs/no-literal-string-in-object "agent.scopes.group.action.label"',
      ),
      `catalog object MessageId must be filtered; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some(
        (s) =>
          s.includes("formatjs/no-literal-string-in-jsx") &&
          s.includes("agent.scopes.group.action.label"),
      ),
      `JSX same-value MessageId must remain; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("agent.scopes.group.action.labell")),
      `misspelled key must remain; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("foo.bar.baz.not.in.catalog")),
      `random dotted string must remain; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Full server control")),
      `ordinary English object prose must remain; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("`agent.scopes.group.action.label`")),
      `template MessageId must remain; got ${JSON.stringify(sources)}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("collectCurrentFindings: temp root without en.ts stays GREEN via catalogMessageIds inject", () => {
  // Without inject, default catalog path is packages/web en.ts (not under temp
  // root). Pin that inject avoids needing a fragile copied en.ts in the fixture.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-msgid-inject-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Only.tsx"),
      `export const row = { label: "settings.roles.title" };\n`,
    );
    const catalog = loadCatalogMessageIdsFromSource(FIXTURE_EN, "fixture-en.ts");
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
      catalogMessageIds: catalog,
    });
    assert.deepEqual(findings, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real corpus: catalog MessageId filter drops exact 24 keys/33 hits (billing+workspace-grid+settings)", () => {
  const catalog = loadCatalogMessageIdsFromPath(EN_CATALOG);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Array<{
    path: string;
    rule: string;
    source: string;
    count: number;
    classification: string;
  }>;

  const { report } = runOxlintI18n({
    root: WEB_ROOT,
    configPath: CONFIG,
    target: "src",
  });
  const raw = findingsFromOxlintDiagnostics(report.diagnostics, {
    root: WEB_ROOT,
    readFile: (absPath: string) => readFileSync(absPath, "utf8"),
  });
  const afterStructural = filterIgnorableStructuralFindings(raw, catalog);
  const catalogFiltered = filterCatalogMessageIdFindings(afterStructural, catalog);
  const dropped = afterStructural.filter(
    (f) => isCatalogMessageIdObjectLiteralFinding(f, catalog),
  );
  const droppedAgg = aggregateFindings(dropped);
  const current = collectCurrentFindings({
    root: WEB_ROOT,
    configPath: CONFIG,
    target: "src",
  });

  assert.equal(droppedAgg.length, 24, `expected 24 filtered keys; got ${droppedAgg.length}`);
  assert.equal(
    droppedAgg.reduce((n, e) => n + e.count, 0),
    33,
    "expected 33 filtered hits",
  );
  assert.equal(
    droppedAgg.filter((e) => e.path === "src/components/agent/AgentScopesPanel.tsx").length,
    0,
  );
  assert.equal(
    droppedAgg.filter((e) => e.path === "src/utils/billingControls.ts").length,
    5,
  );
  assert.equal(
    droppedAgg.filter((e) => e.path === "src/components/workspace/workspaceGridUrlState.ts").length,
    17,
  );
  assert.equal(
    droppedAgg.filter((e) => e.path === "src/components/settings/settingsNavigation.ts").length,
    1,
  );
  for (const entry of droppedAgg) {
    assert.equal(entry.rule, "formatjs/no-literal-string-in-object");
    const text = entry.source.slice(1, -1);
    assert.ok(catalog.has(text), `filtered source must be in catalog: ${entry.source}`);
  }

  // 2026-08-19: the exact flag-off compatibility surfaces repeat the existing
  // ChannelMembers 99+ notation and EditChannelDialog #channel prefix. These
  // are the same protocol literals under separate source paths, not new copy.
  // 168 -> 161 keys / 200 -> 191 hits: the ten legacy `input-brutal` inputs in
  // RuntimeConfigFields became raft-ui <Input>, and formatjs/no-literal-string-in-jsx
  // only flags intrinsic elements — so their seven audited placeholder literals stopped
  // being reported. The baseline ratchets DOWN as literals leave; a rise means new
  // un-catalogued copy crept in.
  // Removing the retired TaskItem also retires its two protocol-literal entries.
  // 154 -> 153 keys / 183 -> 182 hits (2026-09-08): InviteHumanDialog's email box
  // became a raft-ui <Input> for per-row invite roles, so its audited
  // `name@company.com` placeholder stopped being reported — the same intrinsic-only
  // effect recorded above for RuntimeConfigFields, ratcheting DOWN again.
  assert.equal(current.length, 153, `final disposition baseline keys; got ${current.length}`);
  assert.equal(
    current.reduce((n, e) => n + e.count, 0),
    182,
    "final disposition baseline hits",
  );
  assert.equal(
    aggregateFindings(catalogFiltered).length,
    current.length,
    "collectCurrentFindings must apply catalog filter after structural before aggregate",
  );

  const compare = compareFindingsToBaseline(current, baseline);
  assert.equal(
    compare.ok,
    true,
    JSON.stringify({
      new: compare.newFindings.slice(0, 5),
      stale: compare.staleBaseline.slice(0, 5),
    }),
  );

  assert.equal(baseline.length, 153);
  assert.equal(
    baseline.filter((e) => e.path === "src/components/agent/AgentScopesPanel.tsx").length,
    0,
  );
  assert.equal(
    baseline.filter(
      (e) =>
        e.path === "src/utils/billingControls.ts" &&
        e.rule === "formatjs/no-literal-string-in-object" &&
        /^"[a-z]+(?:\.[a-zA-Z0-9_]+)+"$/.test(e.source),
    ).length,
    0,
  );
});

test("boundary: @/#/99+/technical/object English stay; safe glue leaves baseline; JSX raw MessageId stays", () => {
  const catalog = loadCatalogMessageIdsFromPath(EN_CATALOG);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Array<{
    path: string;
    rule: string;
    source: string;
  }>;
  const bySource = (pred: (s: string) => boolean) => baseline.filter((e) => pred(e.source));

  assert.ok(bySource((s) => s === "@").length >= 1, "B @ must remain");
  assert.ok(bySource((s) => s === "#").length >= 1, "B # must remain");
  assert.ok(bySource((s) => s === '"99+"').length >= 1, "B 99+ must remain");
  assert.equal(
    bySource((s) => s.includes("formatMessage") && s.startsWith("`")).length,
    0,
    "safe translated template glue must be filtered",
  );
  assert.ok(
    bySource((s) => s === "@theme" || s === "#E08585" || s.includes("bg-brutal-lavender"))
      .length >= 3,
    "technical-token research bucket must remain",
  );
  // RolePermissionHelpDialog object prose was migrated; remaining object
  // English in baseline is intentional exception copy (code/user-data examples).
  assert.equal(
    bySource((s) => s === '"Full server control."').length,
    0,
    "migrated RolePermissionHelpDialog object English must leave the baseline",
  );
  // Was `placeholder="name@company.com"` until that input moved onto the raft-ui
  // <Input> and left the corpus; re-pinned to a placeholder still on an intrinsic
  // element so the property under test — reviewed code_example attr English stays
  // in the baseline — keeps a live subject instead of silently testing nothing.
  assert.ok(
    bySource((s) => s === 'placeholder="https://example.com"').length >= 1,
    "reviewed code_example object/attr English must remain",
  );

  // JSX raw MessageId is not in baseline today; pin diagnostic keep via fixture.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-msgid-jsx-boundary-"));
  try {
    const abs = join(fixtureRoot, "src", "JsxId.tsx");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      `export function Raw() {\n  return <h2>{"agent.scopes.group.action.label"}</h2>;\n}\n`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: "src",
      catalogMessageIds: catalog,
    });
    assert.ok(
      findings.some(
        (f) =>
          f.rule === "formatjs/no-literal-string-in-jsx" &&
          f.source.includes("agent.scopes.group.action.label"),
      ),
      `JSX raw MessageId must remain in diagnostics; got ${JSON.stringify(findings)}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
