/**
 * Required-Test Admission evidence (docs/sops/ci-check-maintenance.md)
 *
 * - Test/check: packages/web FormatJS + raft-i18n AST literal gate
 *   (`lint:i18n-literals` / check-i18n-literals.ts)
 * - Protected invariant: new UI literals in message-call / .ts return cannot
 *   bypass the catalog baseline ratchet
 * - RED proof (minimal production mutation): automated replay in
 *   "SOP minimal production-mutation RED replay for raft-i18n call/return"
 *   - mutation: MainLayout onFailure + toast.error("New copy");
 *     activity.ts + export helper return "New status"
 *   - oracle: real oxlint i18n config / collectCurrentFindings on temp root
 *   - exact RED signature: raft-i18n/no-literal-in-message-call source "New copy";
 *     raft-i18n/no-literal-return-prose source "New status"
 *   - control: unmodified production sources have neither finding
 * - Unique evidence vs FormatJS rules alone: call-sink + .ts return producers
 *   are outside FormatJS JSX/object include lists; RolePermissionHelpDialog
 *   object/heading coverage is AST-only (see corpus pin below)
 *
 * Migration receipt (Regex scanner + temporary parity ledger retired):
 * Before deletion, default web corpus parity was GREEN with
 * 124 hits / 114 keys, covered=90 exception=24 missingAST=0.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  aggregateFindings,
  assertAcceptedOxlintStatus,
  assertNoForbiddenI18nDisableDirectives,
  assertTargetInsideRoot,
  collectCurrentFindings,
  compareFindingsToBaseline,
  createFileSourceCache,
  extractSourceComments,
  extractSourceSnippet,
  filterIgnorableStructuralFindings,
  findForbiddenDisableDirectivesInSource,
  findingsFromOxlintDiagnostics,
  isDirectCliInvocation,
  isIgnorableStructuralLiteral,
  loadDefaultCatalogMessageIds,
  normalizeRuleId,
  normalizeSourceIdentity,
  parseFindingLiteralSource,
  parseOxlintJson,
  resolveDirectCliInvocation,
  resolveOxlintBin,
  runOxlintI18n,
  templateHoleHasStaticLiteral,
  toBaselineEntries,
  validateBaselineEntries,
} from "../scripts/check-i18n-literals";
import { OXC_NODE_ARGS } from "./helpers/oxcNode";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(WEB_ROOT, "scripts/check-i18n-literals.ts");
const CONFIG = resolve(WEB_ROOT, "scripts/oxlint-i18n.json");
const IS_WIN = process.platform === "win32";

function readFiles(map: Map<string, string>) {
  return (absPath: string) => {
    const content = map.get(absPath);
    if (content === undefined) throw new Error(`missing ${absPath}`);
    return content;
  };
}

/** Exact package-script wiring for the FormatJS literal required gate. */
function lintI18nWiringErrors(scripts: Record<string, string | undefined>): string[] {
  const errors: string[] = [];
  const gate = scripts["lint:i18n-literals"];
  // Compare mode only: no args, no print-current, no shell bypass.
  if (gate !== "node --import @oxc-node/core/register scripts/check-i18n-literals.ts") {
    errors.push(
      `lint:i18n-literals must be exact unparameterized compare mode, got ${JSON.stringify(gate)}`,
    );
  }
  const lint = scripts.lint ?? "";
  if (!lint.endsWith("&& pnpm run lint:i18n-literals")) {
    errors.push(
      `lint must end exactly with "&& pnpm run lint:i18n-literals" (no args/|| true/trailing bypass), got ${JSON.stringify(lint.slice(-80))}`,
    );
  }
  return errors;
}

test("normalizeRuleId maps oxlint plugin codes to eslint-style rule ids", () => {
  assert.equal(
    normalizeRuleId("formatjs(no-literal-string-in-jsx)"),
    "formatjs/no-literal-string-in-jsx",
  );
  assert.equal(
    normalizeRuleId("formatjs(no-literal-string-in-object)"),
    "formatjs/no-literal-string-in-object",
  );
  assert.equal(
    normalizeRuleId("raft-i18n(no-literal-in-message-call)"),
    "raft-i18n/no-literal-in-message-call",
  );
  assert.equal(
    normalizeRuleId("raft-i18n(no-literal-return-prose)"),
    "raft-i18n/no-literal-return-prose",
  );
});

test("extractSourceSnippet returns the exact diagnostic span text", () => {
  const source = 'const rows = [{ summary: "Full server control." }];\n';
  // span covers `"Full server control."` including quotes (offset 25, length 22)
  assert.equal(extractSourceSnippet(source, { offset: 25, length: 22 }), '"Full server control."');
  assert.equal(extractSourceSnippet("<h2>Agent roles</h2>", { offset: 4, length: 11 }), "Agent roles");
});

test("extractSourceSnippet uses UTF-8 byte offsets from oxlint", () => {
  // Multi-byte chars before the span must not shift the slice (JS string indices
  // would land past the end or on the wrong glyph).
  const source = 'const label = "你好";\n<span>{"Hi"}</span>\n';
  const needle = '"Hi"';
  const offset = Buffer.from(source, "utf8").indexOf(needle);
  assert.ok(offset > 0);
  assert.equal(
    extractSourceSnippet(source, { offset, length: Buffer.byteLength(needle) }),
    '"Hi"',
  );
});

test("extractSourceSnippet throws when span exceeds UTF-8 byte length", () => {
  assert.throws(
    () => extractSourceSnippet("hi", { offset: 0, length: 10 }),
    /out of bounds|span/i,
  );
  assert.throws(
    () => extractSourceSnippet("hi", { offset: 2, length: 1 }),
    /out of bounds|span/i,
  );
  assert.throws(
    () => extractSourceSnippet("你好", { offset: 0, length: 10 }),
    /out of bounds|span/i,
  );
});

test("normalizeSourceIdentity trims and collapses multiline indent whitespace", () => {
  assert.equal(
    normalizeSourceIdentity("\n                        Auto\n                      "),
    "Auto",
  );
  assert.equal(
    normalizeSourceIdentity("\n                Feature flags\n              "),
    "Feature flags",
  );
  // Quoted single-space literals stay semantically `" "` — not emptied.
  assert.equal(normalizeSourceIdentity('" "'), '" "');
  assert.equal(normalizeSourceIdentity('  "Hi"  '), '"Hi"');
});

/**
 * Batch-1 structural diagnostic filter (pure space / listed punct / count).
 * RED signature when unimplemented: isIgnorableStructuralLiteral is not a function
 * (or returns false for every ignorable fixture below).
 */
test("isIgnorableStructuralLiteral: ignore pure space, listed punct, numbers, count templates", () => {
  const ignore = [
    '" "',
    " ",
    ".",
    ":",
    "/",
    "·",
    "—",
    "+",
    "-",
    "+/-",
    "*",
    "%",
    "…",
    '"…"',
    '"-"',
    '" · "',
    "100",
    '"100%"',
    'title="100%"',
    '"0/0"',
    "`${uploadProgress}%`",
    "`${n}/${total}`",
    "`${progress}%`",
    "`${threadSearchActiveIndex + 1}/${threadSearchMatches.length}`",
    // Approved widen from prior 13-key gap (exact shapes only).
    "→",
    "=",
    "(",
    ")",
    ",",
    "›",
    '" ›"',
    "/500",
    '"\\n"',
  ];
  for (const source of ignore) {
    assert.equal(
      isIgnorableStructuralLiteral(source),
      true,
      `expected ignorable structural literal: ${JSON.stringify(source)}`,
    );
  }
});

test("isIgnorableStructuralLiteral: keep protocol, B markers, prose, MessageId, glue, technical", () => {
  const keep = [
    "@",
    "#",
    '"99+"',
    "→ v",
    "⌘W",
    "Save",
    '"Full server control."',
    '"agent.scopes.group.action.label"',
    "@theme",
    "#E08585",
    "bg-palette-lavender/40",
    "`${formatMessage({ id: \"channel.edit.thisServer\" })} · ${email}`",
    "` · ${formatMessage({ id: \"channel.edit.thisServer\" })}`",
    "`${getAdminPrincipalLabel(principal, formatMessage)} · ${principal.email}`",
    "`${getAdminPrincipalLabel(principal, formatMessage)} · Agent`",
    "`/${currentServer.slug}`",
    "`${human.displayName || human.name}`",
    // Must not over-decode letterful escapes / protocols.
    '"\\t"',
    '"\\u0041"',
    "/settings",
  ];
  for (const source of keep) {
    assert.equal(
      isIgnorableStructuralLiteral(source),
      false,
      `must NOT ignore (later batch / intentional): ${JSON.stringify(source)}`,
    );
  }
});

/**
 * False-green guard: count quasi `/` or `%` must NOT ignore templates whose
 * holes still embed static string / template literals (user-visible prose).
 * RED when isIgnorableCountTemplate only checks quasis.
 */
test("isIgnorableStructuralLiteral: keep count-shaped templates with stringful holes", () => {
  // Nested-backtick hole uses a JS double-quoted string so inner ` stay literal.
  const nestedBacktickHole = "`${cond ? `Done` : `Todo`}/${total}`";
  const catalogIds = new Set<string>();
  const keep = [
    '`${cond ? "Done" : "Todo"}/${total}`',
    "`${busy ? 'Joining…' : 'Ready'}/${total}`",
    '`${done ? "Done" : "Todo"}%`',
    nestedBacktickHole,
    '`${prefix + " items"}/${total}`',
    '`${cond ? "Done" : "Todo"} / ${total}`',
  ];
  for (const source of keep) {
    assert.equal(
      isIgnorableStructuralLiteral(source, catalogIds),
      false,
      `count filter must NOT ignore stringful hole: ${source}`,
    );
  }
});

test("templateHoleHasStaticLiteral fails closed on TypeScript parseDiagnostics", () => {
  // quote-free malformed holes still produce a SourceFile + parseDiagnostics.
  // Fail closed: treat as stringful so count templates cannot ignore them.
  assert.equal(templateHoleHasStaticLiteral("foo("), true);
  assert.equal(templateHoleHasStaticLiteral(">>>"), true);
  assert.equal(templateHoleHasStaticLiteral("a +"), true);
  assert.equal(
    isIgnorableStructuralLiteral("`${foo(}/${total}`", new Set()),
    false,
    "malformed count hole must not be ignored as a clean count template",
  );
});

test("isIgnorableStructuralLiteral: ignore punctuation-only template glue around dynamic and translated values", () => {
  const catalogIds = new Set([
    "channel.edit.thisServer",
    "planBilling.usage.uploads",
    "pages.integrationInvite.installedSuffix",
    "task.status.done",
    "upload.progress",
  ]);
  const ignore = [
    '`${formatMessage({ id: "channel.edit.thisServer" })} · ${email}`',
    '`${getAdminPrincipalLabel(principal, formatMessage)} · ${principal.email}`',
    '`${formatBytes(used)} / ${formatBytes(limit)} ${formatMessage({ id: "planBilling.usage.uploads" })}`',
    '`${server.name} (${server.slug})`',
    '`/${currentServer.slug}`',
    '`${server.name}${server.installedAt ? formatMessage({ id: "pages.integrationInvite.installedSuffix" }) : ""}`',
    '`${formatMessage({ id: "task.status.done" })}/${total}`',
    '`${formatMessage({ id: "upload.progress" })}%`',
  ];

  for (const source of ignore) {
    assert.equal(
      isIgnorableStructuralLiteral(source, catalogIds),
      true,
      `expected ignorable template glue: ${source}`,
    );
  }
});

test("isIgnorableStructuralLiteral: keep template glue with prose or unformatted MessageIds in holes", () => {
  const catalogIds = new Set(["known.message"]);
  const keep = [
    "`${name} is online`",
    '`${cond ? "Done" : "Todo"}/${total}`',
    '`${prefix + " items"}/${total}`',
    '`${formatMessage({ id: "missing.message" })} · ${email}`',
    '`${formatMessage({ id: "known.message", defaultMessage: "Done" })} · ${email}`',
    '`${formatMessage({ id: "known.message", description: "Visible description" })} · ${email}`',
    '`${notFormatMessage({ id: "known.message" })} · ${email}`',
    '`${cond ? "known.message" : name}`',
    '`${cond ? `Ready ${name}` : name}`',
    '`${tag` · ${name}`}`',
    '`${unterminated`',
  ];

  for (const source of keep) {
    assert.equal(
      isIgnorableStructuralLiteral(source, catalogIds),
      false,
      `must not ignore prose/unformatted-id template: ${source}`,
    );
  }
});

test("parseFindingLiteralSource unwraps attr / quoted / template / bare", () => {
  assert.deepEqual(parseFindingLiteralSource('title="100%"'), {
    form: "attr",
    attrName: "title",
    text: "100%",
  });
  assert.deepEqual(parseFindingLiteralSource('" "'), {
    form: "quoted",
    attrName: null,
    text: " ",
  });
  assert.deepEqual(parseFindingLiteralSource("`${n}/${total}`"), {
    form: "template",
    attrName: null,
    text: "${n}/${total}",
  });
  assert.deepEqual(parseFindingLiteralSource("/"), {
    form: "bare",
    attrName: null,
    text: "/",
  });
});

test("filterIgnorableStructuralFindings drops ignorables before aggregate identity", () => {
  const raw = [
    { path: "src/A.tsx", rule: "formatjs/no-literal-string-in-jsx", source: '" "' },
    { path: "src/A.tsx", rule: "formatjs/no-literal-string-in-jsx", source: "@" },
    { path: "src/A.tsx", rule: "formatjs/no-literal-string-in-jsx", source: "`${n}/${total}`" },
    { path: "src/A.tsx", rule: "formatjs/no-literal-string-in-jsx", source: "Save" },
  ];
  assert.deepEqual(filterIgnorableStructuralFindings(raw), [
    { path: "src/A.tsx", rule: "formatjs/no-literal-string-in-jsx", source: "@" },
    { path: "src/A.tsx", rule: "formatjs/no-literal-string-in-jsx", source: "Save" },
  ]);
});

test("findingsFromOxlintDiagnostics normalize path+rule+source from span", () => {
  const fileContent = 'const rows = [{ summary: "Full server control." }];\n';
  const files = new Map([["/abs/src/Example.tsx", fileContent]]);
  const findings = findingsFromOxlintDiagnostics(
    [
      {
        code: "formatjs(no-literal-string-in-object)",
        filename: "/abs/src/Example.tsx",
        labels: [{ span: { offset: 25, length: 22 } }],
      },
    ],
    {
      root: "/abs",
      readFile: readFiles(files),
    },
  );
  assert.deepEqual(findings, [
    {
      path: "src/Example.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"Full server control."',
    },
  ]);
});

test("findingsFromOxlintDiagnostics normalizes multiline JSX span identity", () => {
  const fileContent = "<button>\n                        Auto\n                      </button>\n";
  const spanText = "\n                        Auto\n                      ";
  const offset = Buffer.from(fileContent, "utf8").indexOf(spanText);
  assert.ok(offset >= 0);
  const files = new Map([["/abs/src/A.tsx", fileContent]]);
  const findings = findingsFromOxlintDiagnostics(
    [
      {
        code: "formatjs(no-literal-string-in-jsx)",
        filename: "/abs/src/A.tsx",
        labels: [{ span: { offset, length: Buffer.byteLength(spanText) } }],
      },
    ],
    { root: "/abs", readFile: readFiles(files) },
  );
  assert.deepEqual(findings, [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Auto",
    },
  ]);
});

test("unknown diagnostic codes throw instead of being skipped", () => {
  assert.throws(
    () =>
      findingsFromOxlintDiagnostics(
        [
          {
            code: "eslint(no-unused-vars)",
            filename: "/abs/src/A.tsx",
            labels: [{ span: { offset: 0, length: 1 } }],
          },
        ],
        { root: "/abs", readFile: () => "x" },
      ),
    /unexpected diagnostic code|unsupported|unknown/i,
  );
});

test("FormatJS diagnostics without label/span throw", () => {
  assert.throws(
    () =>
      findingsFromOxlintDiagnostics(
        [
          {
            code: "formatjs(no-literal-string-in-jsx)",
            filename: "/abs/src/A.tsx",
            labels: [],
          },
        ],
        { root: "/abs", readFile: () => "<h2>Hi</h2>" },
      ),
    /label|span/i,
  );
  assert.throws(
    () =>
      findingsFromOxlintDiagnostics(
        [
          {
            code: "formatjs(no-literal-string-in-object)",
            filename: "/abs/src/A.tsx",
            labels: [{}],
          },
        ],
        { root: "/abs", readFile: () => 'const x = { title: "Hi" };' },
      ),
    /label|span/i,
  );
});

test("diagnostic path outside root throws instead of silent skip", () => {
  assert.throws(
    () =>
      findingsFromOxlintDiagnostics(
        [
          {
            code: "formatjs(no-literal-string-in-jsx)",
            filename: "/other/src/A.tsx",
            labels: [{ span: { offset: 0, length: 1 } }],
          },
        ],
        { root: "/abs", readFile: () => "x" },
      ),
    /outside root|must be inside/i,
  );
});

test("relative diagnostic.filename resolves against root, not process cwd", () => {
  const fileContent = "<h2>Hello</h2>\n";
  const root = "/fixture-root";
  const expectedAbs = resolve(root, "src/Hi.tsx");
  const findings = findingsFromOxlintDiagnostics(
    [
      {
        code: "formatjs(no-literal-string-in-jsx)",
        filename: "src/Hi.tsx",
        labels: [{ span: { offset: 4, length: 5 } }],
      },
    ],
    {
      root,
      readFile: (absPath: string) => {
        assert.equal(absPath, expectedAbs);
        return fileContent;
      },
    },
  );
  assert.deepEqual(findings, [
    {
      path: "src/Hi.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Hello",
    },
  ]);
});

test("aggregateFindings counts identical path+rule+source as a multiset", () => {
  const aggregated = aggregateFindings([
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
    },
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Cancel",
    },
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
    },
  ]);
  assert.deepEqual(aggregated, [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Cancel",
      count: 1,
    },
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 2,
    },
  ]);
});

test("compareFindingsToBaseline: exact multiset match exits 0", () => {
  const current = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 2,
    },
  ];
  const baseline = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 2,
      classification: "debt",
    },
  ];
  const result = compareFindingsToBaseline(current, baseline);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.newFindings, []);
  assert.deepEqual(result.staleBaseline, []);
});

test("compareFindingsToBaseline: a new finding fails", () => {
  const current = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 1,
    },
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "New copy",
      count: 1,
    },
  ];
  const baseline = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 1,
      classification: "debt",
    },
  ];
  const result = compareFindingsToBaseline(current, baseline);
  assert.equal(result.ok, false);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(result.newFindings, [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "New copy",
      count: 1,
    },
  ]);
});

test("compareFindingsToBaseline: a stale baseline entry fails", () => {
  const current = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 1,
    },
  ];
  const baseline = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 1,
      classification: "debt",
    },
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Gone",
      count: 1,
      classification: "debt",
    },
  ];
  const result = compareFindingsToBaseline(current, baseline);
  assert.equal(result.ok, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.staleBaseline.length, 1);
  assert.equal(result.staleBaseline[0]?.source, "Gone");
});

test("compareFindingsToBaseline: higher current count is a new finding", () => {
  const current = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 3,
    },
  ];
  const baseline = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 2,
      classification: "debt",
    },
  ];
  const result = compareFindingsToBaseline(current, baseline);
  assert.equal(result.ok, false);
  assert.deepEqual(result.newFindings, [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 1,
    },
  ]);
});

test("compareFindingsToBaseline: lower current count is a stale baseline delta", () => {
  const current = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 1,
    },
  ];
  const baseline = [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 3,
      classification: "debt",
    },
  ];
  const result = compareFindingsToBaseline(current, baseline);
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleBaseline, [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 2,
      classification: "debt",
    },
  ]);
});

test("intentional classifications require a non-empty reason", () => {
  const errors = validateBaselineEntries([
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Raft",
      count: 1,
      classification: "brand",
    },
    {
      path: "src/B.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Raft",
      count: 1,
      classification: "brand",
      reason: "   ",
    },
    {
      path: "src/C.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "ok",
      count: 1,
      classification: "debt",
    },
    {
      path: "src/D.tsx",
      rule: "formatjs/no-literal-string-in-object",
      source: '"sk_machine_"',
      count: 1,
      classification: "protocol",
      reason: "credential prefix shown in docs UI",
    },
  ]);
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? "", /brand/);
  assert.match(errors[1] ?? "", /brand/);
});

test("technical baseline entries are accepted only with an explicit reason", () => {
  const valid = validateBaselineEntries([
    {
      path: "src/pages/PaletteAuditPage.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "getActivityDotClass()",
      count: 1,
      classification: "technical",
      reason: "Function identifier shown as source-reference documentation.",
    },
  ]);
  assert.deepEqual(valid, []);

  const missingReason = validateBaselineEntries([
    {
      path: "src/pages/PaletteAuditPage.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "@theme",
      count: 1,
      classification: "technical",
    },
  ]);
  assert.equal(missingReason.length, 1);
  assert.match(missingReason[0] ?? "", /technical.*reason|reason.*technical/i);
});

/**
 * Baseline classification schema pin (Task 1).
 * Exact allowed set; every classification except debt requires a non-empty reason;
 * unknown values such as false_positive must fail validation.
 */
test("baseline classification contract: exact allowed set and reason rules", () => {
  const ALLOWED = [
    "debt",
    "brand",
    "protocol",
    "code_example",
    "user_data_example",
    "internal_dev",
    "legacy",
    "technical",
    "owner_managed",
  ] as const;

  for (const classification of ALLOWED) {
    const entry = {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Example",
      count: 1,
      classification,
      ...(classification === "debt"
        ? {}
        : { reason: `reviewed ${classification} exception` }),
    };
    assert.deepEqual(
      validateBaselineEntries([entry]),
      [],
      `expected ${classification} to be accepted with valid reason rules`,
    );
  }

  const intentional = ALLOWED.filter((c) => c !== "debt");
  for (const classification of intentional) {
    const missing = validateBaselineEntries([
      {
        path: "src/A.tsx",
        rule: "formatjs/no-literal-string-in-jsx",
        source: "Example",
        count: 1,
        classification,
      },
    ]);
    assert.ok(
      missing.length >= 1 && /reason/i.test(missing.join("\n")),
      `expected ${classification} without reason to fail; got ${JSON.stringify(missing)}`,
    );

    const blank = validateBaselineEntries([
      {
        path: "src/A.tsx",
        rule: "formatjs/no-literal-string-in-jsx",
        source: "Example",
        count: 1,
        classification,
        reason: "   ",
      },
    ]);
    assert.ok(
      blank.length >= 1 && /reason/i.test(blank.join("\n")),
      `expected ${classification} with blank reason to fail; got ${JSON.stringify(blank)}`,
    );
  }

  const unknown = validateBaselineEntries([
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Example",
      count: 1,
      classification: "false_positive",
      reason: "should not be accepted as a baseline classification",
    },
  ]);
  assert.ok(unknown.length >= 1, "unknown false_positive must fail");
  assert.match(unknown[0] ?? "", /classification|must be one of/i);
  assert.doesNotMatch(
    unknown.join("\n"),
    /\breason\b/i,
    "false_positive must fail as unknown classification, not as a missing-reason intentional",
  );
});

test("duplicate baseline path+rule+source keys fail validation", () => {
  const errors = validateBaselineEntries([
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 1,
      classification: "debt",
    },
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Save",
      count: 2,
      classification: "debt",
    },
  ]);
  assert.ok(errors.some((e) => /duplicate/i.test(e)));
});

test("baseline source must already be normalizeSourceIdentity'd", () => {
  const errors = validateBaselineEntries([
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "\n                        Auto\n                      ",
      count: 1,
      classification: "debt",
    },
    {
      path: "src/B.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Feature  flags",
      count: 1,
      classification: "debt",
    },
    {
      path: "src/C.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Auto",
      count: 1,
      classification: "debt",
    },
  ]);
  assert.ok(errors.some((e) => /normalize|normalized|source identity/i.test(e)));
  assert.equal(errors.filter((e) => /normalize|normalized|source identity/i.test(e)).length, 2);
});

test("parseOxlintJson rejects invalid JSON and missing diagnostics", () => {
  assert.throws(() => parseOxlintJson("not-json"), /JSON diagnostics|execution error/i);
  assert.throws(() => parseOxlintJson(""), /empty/i);
  assert.throws(() => parseOxlintJson("{}"), /diagnostics/i);
  assert.throws(() => parseOxlintJson('{"diagnostics":null}'), /diagnostics/i);
  assert.deepEqual(parseOxlintJson('{"diagnostics":[]}').diagnostics, []);
});

test("only the primary (first) label span is counted", () => {
  const fileContent = "<h2>Hello</h2>\n";
  const files = new Map([["/abs/src/A.tsx", fileContent]]);
  const findings = findingsFromOxlintDiagnostics(
    [
      {
        code: "formatjs(no-literal-string-in-jsx)",
        filename: "/abs/src/A.tsx",
        labels: [
          { span: { offset: 4, length: 5 } }, // Hello — primary
          { span: { offset: 0, length: 3 } }, // <h2 — must NOT be counted
        ],
      },
    ],
    { root: "/abs", readFile: readFiles(files) },
  );
  assert.deepEqual(findings, [
    {
      path: "src/A.tsx",
      rule: "formatjs/no-literal-string-in-jsx",
      source: "Hello",
    },
  ]);
});

test("findingsFromOxlintDiagnostics caches per-file reads", () => {
  const fileContent = "<h2>Hello</h2><span>World</span>\n";
  let reads = 0;
  const findings = findingsFromOxlintDiagnostics(
    [
      {
        code: "formatjs(no-literal-string-in-jsx)",
        filename: "/abs/src/A.tsx",
        labels: [{ span: { offset: 4, length: 5 } }],
      },
      {
        code: "formatjs(no-literal-string-in-jsx)",
        filename: "/abs/src/A.tsx",
        labels: [{ span: { offset: 20, length: 5 } }],
      },
    ],
    {
      root: "/abs",
      readFile: (absPath: string) => {
        assert.equal(absPath, "/abs/src/A.tsx");
        reads += 1;
        return fileContent;
      },
    },
  );
  assert.equal(reads, 1);
  assert.deepEqual(
    findings.map((f) => f.source).sort(),
    ["Hello", "World"],
  );
});

test("createFileSourceCache methods work when destructured (no this)", () => {
  let reads = 0;
  const { readText, readUtf8Bytes } = createFileSourceCache((absPath: string) => {
    reads += 1;
    assert.equal(absPath, "/abs/A.tsx");
    return "ab";
  });
  assert.equal(readText("/abs/A.tsx"), "ab");
  assert.equal(readUtf8Bytes("/abs/A.tsx").toString("utf8"), "ab");
  assert.equal(readUtf8Bytes("/abs/A.tsx").toString("utf8"), "ab");
  assert.equal(reads, 1);
});

test(
  "isDirectCliInvocation follows symlinks to the real script path",
  { skip: IS_WIN ? "symlink creation may EPERM without Developer Mode on Windows" : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-symlink-"));
    const link = join(dir, "gate-wrapper.mjs");
    const other = join(dir, "other.mjs");
    try {
      symlinkSync(SCRIPT, link);
      writeFileSync(other, "// not the gate\n");
      assert.equal(isDirectCliInvocation(SCRIPT), true);
      assert.equal(isDirectCliInvocation(link), true);
      assert.equal(isDirectCliInvocation(other), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("isDirectCliInvocation returns false when realpath fails", () => {
  const missing = join(tmpdir(), `i18n-missing-${process.pid}-${Date.now()}.mjs`);
  assert.equal(isDirectCliInvocation(missing), false);
});

test("resolveDirectCliInvocation fails closed on realpath errors", () => {
  const missing = join(tmpdir(), `i18n-missing-${process.pid}-${Date.now()}.mjs`);
  const result = resolveDirectCliInvocation(missing);
  assert.equal(result.kind, "error");
  assert.match(String(result.message ?? ""), /ENOENT|no such file|realpath|resolve/i);
  assert.deepEqual(resolveDirectCliInvocation(SCRIPT), { kind: "direct" });
  assert.deepEqual(resolveDirectCliInvocation(undefined), { kind: "not-cli" });
});

test("assertTargetInsideRoot rejects targets outside root before spawn", () => {
  assert.throws(
    () => assertTargetInsideRoot("/abs/root", "/tmp/outside"),
    /target must be inside root/i,
  );
  assert.throws(
    () => assertTargetInsideRoot("/abs/root", "../sibling"),
    /target must be inside root/i,
  );
  assert.equal(
    assertTargetInsideRoot("/abs/root", "src"),
    resolve("/abs/root", "src"),
  );
});

test("assertAcceptedOxlintStatus only allows 0 and 1", () => {
  assert.doesNotThrow(() => assertAcceptedOxlintStatus(0));
  assert.doesNotThrow(() => assertAcceptedOxlintStatus(1));
  assert.throws(() => assertAcceptedOxlintStatus(2), /status|exit/i);
  assert.throws(() => assertAcceptedOxlintStatus(null), /status|exit/i);
});

test("resolveOxlintBin always resolves from packages/web, not --root", () => {
  const fromWeb = resolveOxlintBin();
  assert.match(fromWeb, /oxlint/);
  // A disposable --root without node_modules must still resolve the same binary.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-bin-"));
  try {
    writeFileSync(join(fixtureRoot, "package.json"), '{"name":"fixture"}\n');
    assert.equal(resolveOxlintBin(), fromWeb);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("runOxlintI18n works with a temp --root fixture (oxlint from packages/web)", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-root-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Hi.tsx"),
      "export const Hi = () => <h2>Hello</h2>;\n",
    );
    const { report, status } = runOxlintI18n({
      root: fixtureRoot,
      target: ".",
      configPath: CONFIG,
    });
    assert.ok(status === 0 || status === 1);
    assert.ok(Array.isArray(report.diagnostics));
    assert.ok(report.diagnostics.length >= 1);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("CLI rejects --target outside --root before oxlint spawn", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-cli-"));
  try {
    writeFileSync(join(fixtureRoot, "Hi.tsx"), "export const x = 1;\n");
    const result = spawnSync(
      process.execPath,
      [...OXC_NODE_ARGS, SCRIPT, "--root", fixtureRoot, "--target", "/tmp", "--print-current"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /target must be inside root/i);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test(
  "CLI --print-current succeeds via symlink wrapper path",
  { skip: IS_WIN ? "symlink creation may EPERM without Developer Mode on Windows" : false },
  () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-print-"));
    const linkDir = mkdtempSync(join(tmpdir(), "i18n-link-"));
    const link = join(linkDir, "check-i18n-literals.ts");
    try {
      writeFileSync(
        join(fixtureRoot, "Hi.tsx"),
        "export const Hi = () => <h2>Hello</h2>;\n",
      );
      symlinkSync(SCRIPT, link);
      const result = spawnSync(
        process.execPath,
        [...OXC_NODE_ARGS, link, "--root", fixtureRoot, "--target", ".", "--print-current"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
      const entries = JSON.parse(result.stdout);
      assert.ok(Array.isArray(entries));
      assert.ok(entries.some((e: { source: string }) => e.source === "Hello"));
      assert.ok(entries.every((e: { classification: string }) => e.classification === "debt"));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(linkDir, { recursive: true, force: true });
    }
  },
);

test("CLI --print-current flushes JSON larger than the stdout pipe buffer", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-print-large-"));
  try {
    const spans = Array.from(
      { length: 900 },
      (_, index) => `<span>Large output message ${index}</span>`,
    ).join("\n");
    writeFileSync(
      join(fixtureRoot, "Many.tsx"),
      `export const Many = () => <>\n${spans}\n</>;\n`,
    );
    const result = spawnSync(
      process.execPath,
      [...OXC_NODE_ARGS, SCRIPT, "--root", fixtureRoot, "--target", ".", "--print-current"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.ok(
      Buffer.byteLength(result.stdout, "utf8") > 64 * 1024,
      "fixture must exceed the typical pipe buffer",
    );
    const entries = JSON.parse(result.stdout) as Array<{ source: string }>;
    assert.equal(entries.length, 900);
    assert.equal(entries[0]?.source, "Large output message 0");
    assert.ok(entries.some((entry) => entry.source === "Large output message 899"));
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("lint:i18n-literals wiring rejects print-current, || true, and trailing bypass", () => {
  const baseLint =
    "node --import @oxc-node/core/register scripts/check-source-extensions.ts && pnpm run lint:i18n-literals";
  const goodGate = "node --import @oxc-node/core/register scripts/check-i18n-literals.ts";

  assert.ok(
    lintI18nWiringErrors({
      lint: `${baseLint} -- --print-current`,
      "lint:i18n-literals": goodGate,
    }).length > 0,
    "trailing --print-current on lint chain must RED",
  );
  assert.ok(
    lintI18nWiringErrors({
      lint: `${baseLint} || true`,
      "lint:i18n-literals": goodGate,
    }).length > 0,
    "|| true trailing bypass must RED",
  );
  assert.ok(
    lintI18nWiringErrors({
      lint: `${baseLint} && echo ok`,
      "lint:i18n-literals": goodGate,
    }).length > 0,
    "any trailing command after the gate must RED",
  );
  assert.ok(
    lintI18nWiringErrors({
      lint: baseLint,
      "lint:i18n-literals": "node --import @oxc-node/core/register scripts/check-i18n-literals.ts --print-current",
    }).length > 0,
    "lint:i18n-literals with --print-current must RED",
  );
  assert.ok(
    lintI18nWiringErrors({
      lint: baseLint,
      "lint:i18n-literals": "node --import @oxc-node/core/register scripts/check-i18n-literals.ts || true",
    }).length > 0,
    "lint:i18n-literals with || true must RED",
  );
  assert.deepEqual(
    lintI18nWiringErrors({
      lint: baseLint,
      "lint:i18n-literals": goodGate,
    }),
    [],
  );
});

test("real oxlint temp-root fixture covers JSX/ternary/multiline/prop/object RED shapes", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-red-shapes-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Shapes.tsx"),
      `export const rows = [
  {
    summary: "Full server control.",
    details: "Billing and ownership.",
  },
];

export function GateShapes({ busy }: { busy: boolean }) {
  return (
    <div>
      <h2>Agent roles</h2>
      <button>{busy ? "Joining…" : "Agree & Continue"}</button>
      <button>
                        Auto
                      </button>
      <ConfirmDialog confirmLabel="Delete Task" />
    </div>
  );
}

declare function ConfirmDialog(props: { confirmLabel: string }): JSX.Element;
`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    const bySource = new Map(findings.map((f) => [f.source, f]));

    assert.equal(bySource.get("Agent roles")?.rule, "formatjs/no-literal-string-in-jsx");
    assert.equal(bySource.get('"Joining…"')?.rule, "formatjs/no-literal-string-in-jsx");
    assert.equal(bySource.get('"Agree & Continue"')?.rule, "formatjs/no-literal-string-in-jsx");
    assert.equal(bySource.get("Auto")?.rule, "formatjs/no-literal-string-in-jsx");
    assert.equal(
      bySource.get('confirmLabel="Delete Task"')?.rule,
      "formatjs/no-literal-string-in-jsx",
    );
    assert.equal(
      bySource.get('"Full server control."')?.rule,
      "formatjs/no-literal-string-in-object",
    );
    assert.equal(
      bySource.get('"Billing and ownership."')?.rule,
      "formatjs/no-literal-string-in-object",
    );
    assert.equal(findings.length, 7);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real oxlint temp-root fixture: title prop + subtitle/contextLoadError object RED shapes", () => {
  // Pins the Task 2 FormatJS config expansion: custom-component title
  // literals/templates plus object subtitle / contextLoadError fields.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-red-title-object-"));
  try {
    writeFileSync(
      join(fixtureRoot, "TitleObject.tsx"),
      `export const panel = {
  subtitle: "Agent panel",
  contextLoadError: "Message not found",
};

export function TitleShapes({ name }: { name: string }) {
  return (
    <div>
      <Tooltip title="Download" />
      <Tooltip title={\`\${name} · Drag to move\`} />
    </div>
  );
}

declare function Tooltip(props: { title: string }): JSX.Element;
`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    const bySource = new Map(findings.map((f) => [f.source, f]));

    assert.equal(
      bySource.get('title="Download"')?.rule,
      "formatjs/no-literal-string-in-jsx",
      "custom component title literal must be caught",
    );
    assert.ok(
      [...bySource.keys()].some(
        (source) =>
          source.includes("Drag to move") &&
          bySource.get(source)?.rule === "formatjs/no-literal-string-in-jsx",
      ),
      `custom component title template must be caught; got ${JSON.stringify([...bySource.keys()])}`,
    );
    assert.equal(
      bySource.get('"Agent panel"')?.rule,
      "formatjs/no-literal-string-in-object",
      "object subtitle must be caught",
    );
    assert.equal(
      bySource.get('"Message not found"')?.rule,
      "formatjs/no-literal-string-in-object",
      "object contextLoadError must be caught",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real oxlint temp-root fixture: formatMessage in JSX is GREEN", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-green-fmt-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Green.tsx"),
      `export function Green() {
  return <span>{formatMessage({ id: "settings.roles.title" })}</span>;
}
declare function formatMessage(desc: { id: string }): string;
`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    assert.deepEqual(findings, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real oxlint temp-root fixture: retired-regex false-positive shapes stay GREEN", () => {
  // Migrated from the 16 false_positive_regex ledger exceptions: AST gate must
  // stay silent on generics/comparison/querySelector/new Set/className/internal throw.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-green-fp-"));
  try {
    writeFileSync(
      join(fixtureRoot, "RetiredRegexFalsePositives.tsx"),
      `export function RetiredRegexFalsePositives({
  a,
  b,
  clientX,
  rect,
  provider,
}: {
  a: number;
  b: number;
  clientX: number;
  rect: { left: number };
  provider: string;
}) {
  const seen = new Set<string>();
  const node = document.querySelector(".role-row");
  const active = rect.left && clientX;
  const cmp = a > b;
  type Maybe = void | Promise<string>;
  const keep: Maybe = undefined;
  void seen;
  void node;
  void active;
  void cmp;
  void keep;
  return <div className={\`\${provider} sign-in\`} data-testid="regex-false-positive-noise" />;
}
`,
    );
    writeFileSync(
      join(fixtureRoot, "internalThrow.ts"),
      `export function resolve(): never {
  throw new Error("Could not resolve destination");
}
export function group<T>(results: T[]): T[] {
  return results;
}
`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    assert.deepEqual(
      findings,
      [],
      `generics/comparison/querySelector/new Set/className/internal throw must stay GREEN; got ${JSON.stringify(findings)}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real oxlint temp-root fixture: raft-i18n call-sink RED shapes", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-red-call-sink-"));
  try {
    writeFileSync(
      join(fixtureRoot, "CallSink.tsx"),
      `declare const toast: {
  error(msg: string): void;
  success(msg: string): void;
  info(msg: string): void;
  warning(msg: string): void;
  message(msg: string): void;
};
declare function setError(msg: string): void;
declare function setStatus(msg: string): void;
declare function setStatusMessage(msg: string): void;

export function boom(apiError: string | undefined, busy: boolean, name: string) {
  toast.error("Unable to open thread. It may be unavailable or deleted.");
  toast.success("Saved successfully.");
  toast.info("Heads up about this channel.");
  toast.warning("This action cannot be undone.");
  toast.message("Something happened in the background.");
  setError(apiError || "Enter at least one email, or copy the invite link above.");
  setStatus(busy ? "Connecting to computer…" : "Computer is ready.");
  setStatusMessage(\`Could not prepare the Windows command. Try again.\`);
  setError(name ? \`Couldn't save your answers. Try again.\` : "Please try again later.");
}
`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    const byRule = findings.filter((f) => f.rule === "raft-i18n/no-literal-in-message-call");
    const sources = byRule.map((f) => f.source);

    assert.ok(
      sources.some((s) => s.includes("Unable to open thread")),
      `toast.error literal must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Saved successfully")),
      `toast.success literal must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Heads up about this channel")),
      `toast.info literal must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("This action cannot be undone")),
      `toast.warning literal must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Something happened in the background")),
      `toast.message literal must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Enter at least one email")),
      `setError logical fallback must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Connecting to computer")),
      `setStatus conditional true branch must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Computer is ready")),
      `setStatus conditional false branch must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Could not prepare the Windows command")),
      `setStatusMessage template must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Couldn't save your answers")),
      `setError conditional template must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Please try again later")),
      `setError conditional literal must be caught; got ${JSON.stringify(sources)}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real oxlint temp-root fixture: raft-i18n TS wrapper call/return RED shapes", () => {
  // Before unwrap recursion: as/satisfies/!/assertion wrappers hide literals → 0 findings.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-red-ts-wrap-"));
  try {
    writeFileSync(
      join(fixtureRoot, "WrappedCall.tsx"),
      `declare const toast: { error(msg: string): void };
declare function setError(msg: string): void;
declare function setStatus(msg: string): void;

export function wrapped(apiError: string | undefined, busy: boolean) {
  toast.error(("Unable to open wrapped thread." as const));
  setError((apiError || ("Enter wrapped email please." as string)));
  setStatus((busy ? ("Connecting wrapped…" as const) : ("Wrapped ready." as string))!);
}
`,
    );
    writeFileSync(
      join(fixtureRoot, "wrappedReturn.ts"),
      `export function wrappedStatus(online: boolean): string {
  if (online) return ("Online" as const);
  return (("Offline" as string)!);
}

export function wrappedPrefix(kind: "line" | "row"): string {
  const prefix = (kind === "line" ? "L" : "Row label ") as string;
  return \`\${prefix}1\`;
}
`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    const callSources = findings
      .filter((f) => f.rule === "raft-i18n/no-literal-in-message-call")
      .map((f) => f.source);
    const returnSources = findings
      .filter((f) => f.rule === "raft-i18n/no-literal-return-prose")
      .map((f) => f.source);

    assert.ok(
      callSources.some((s) => s.includes("Unable to open wrapped thread")),
      `toast.error as-const wrapper must be caught; got ${JSON.stringify(callSources)}`,
    );
    assert.ok(
      callSources.some((s) => s.includes("Enter wrapped email please")),
      `setError as-string wrapper must be caught; got ${JSON.stringify(callSources)}`,
    );
    assert.ok(
      callSources.some((s) => s.includes("Connecting wrapped") || s.includes("Wrapped ready")),
      `setStatus non-null assertion wrapper must be caught; got ${JSON.stringify(callSources)}`,
    );
    assert.ok(
      returnSources.some((s) => s.includes("Online")),
      `return as-const Online must be caught; got ${JSON.stringify(returnSources)}`,
    );
    assert.ok(
      returnSources.some((s) => s.includes("Offline")),
      `return non-null Offline must be caught; got ${JSON.stringify(returnSources)}`,
    );
    assert.ok(
      returnSources.some((s) => s.includes("Row label")),
      `returned local prefix producer with as-string must be caught; got ${JSON.stringify(returnSources)}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real oxlint temp-root fixture: raft-i18n .ts return prose RED + GREEN shapes", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-red-return-prose-"));
  try {
    writeFileSync(
      join(fixtureRoot, "statusProse.ts"),
      `export function getStatus(online: boolean, detail?: string): string {
  if (online) return "Online";
  return detail ? \`Offline: \${detail}\` : "Offline";
}

export function getComputerTitle(kind: "status" | "offline"): string {
  return kind === "offline" ? "Computer offline" : "Computer status";
}

export function getRegionLabel(): string {
  return "HTML region";
}

/** Concise arrow expression body (not a ReturnStatement). */
export const arrowHello = (): string => "Hello World";
export const arrowTemplate = (n: number): string => \`\${n} Tasks remaining\`;

/** Mirrors attachmentCommentAnchors prefix producer: local conditional used in return. */
export function getPrefix(kind: "line" | "row"): string {
  const prefix = kind === "line" ? "L" : "Row label ";
  return \`\${prefix}1\`;
}

/** Mirrors translationStore selectedLabel: local conditional referenced from returned object. */
export function timezoneOptions(effective: string | null): Array<{ value: string; label: string }> {
  const selectedLabel = effective ? effective : "Select timezone";
  return [{ value: "", label: selectedLabel }];
}

/** Local logical / static producers that flow into a same-function return. */
export function logicalFallback(detail?: string): string {
  const label = detail || "Working\u2026";
  return label;
}

export function logicalAnd(flag: boolean): string {
  const label = flag && "Thinking\u2026";
  return String(label || "");
}

export function concatProducer(): string {
  const label = "Hello " + "World Tasks";
  return label;
}

export function templateProducer(n: number): string {
  const label = \`\${n} Tasks remaining\`;
  return label;
}
`,
    );
    writeFileSync(
      join(fixtureRoot, "internalGreen.ts"),
      `export type Mode = "online" | "offline";
export function pathFor(id: string): string {
  return \`/agents/\${id}/status\`;
}
export function code(): string {
  return "AGENT_STATUS";
}
export function throwDiagnostic(): never {
  throw new Error("Could not resolve destination");
}
export function nonProse(): string {
  return "ok";
}

/** Local debug conditional never flows into a return → must stay GREEN. */
export function withUnusedDebug(flag: boolean): string {
  const debugLabel = flag ? "Debug Online" : "Debug Offline";
  void debugLabel;
  return "ok";
}

/** Unused logical / concat producers must stay GREEN (same nested/key guards). */
export function withUnusedLogical(flag: boolean): string {
  const unusedLogical = flag || "Unused Logical Online";
  const unusedConcat = "Unused " + "Concat Offline";
  const unusedTemplate = \`Unused Template Online\`;
  void unusedLogical;
  void unusedConcat;
  void unusedTemplate;
  return "ok";
}

/** Outer unused conditional GREEN; nested returned local producer still RED. */
export function withNestedReturn(flag: boolean): string {
  const outerLabel = flag ? "Outer Online" : "Outer Offline";
  const nested = () => {
    const innerLabel = flag ? "Inner Online" : "Inner Offline";
    return innerLabel;
  };
  void outerLabel;
  return nested();
}

/** Object key / non-computed member property must NOT count as value refs. */
export function keyOnlyObjectReturn(flag: boolean, localized: string): { message: string } {
  const message = flag ? "Key Only Online" : "Key Only Offline";
  void message;
  return { message: localized };
}

export function keyOnlyArrayObjectReturn(flag: boolean, localized: string): Array<{ message: string }> {
  const message = flag ? "Array Key Online" : "Array Key Offline";
  void message;
  return [{ message: localized }];
}

export function keyOnlyMemberReturn(flag: boolean, obj: { label: string }): string {
  const label = flag ? "Member Key Online" : "Member Key Offline";
  void label;
  return obj.label;
}

export function keyOnlyLogicalReturn(flag: boolean, localized: string): { message: string } {
  const message = flag || "Key Only Logical Online";
  void message;
  return { message: localized };
}
`,
    );
    writeFileSync(
      join(fixtureRoot, "valueRefProse.ts"),
      `/** Shorthand / computed / direct return still count as value refs. */
export function shorthandReturn(flag: boolean): { message: string } {
  const message = flag ? "Shorthand Online" : "Shorthand Offline";
  return { message };
}

export function computedKeyReturn(flag: boolean, x: string): Record<string, string> {
  const message = flag ? "Computed Key Online" : "Computed Key Offline";
  return { [message]: x };
}

export function computedMemberReturn(flag: boolean, obj: Record<string, string>): string {
  const message = flag ? "Computed Member Online" : "Computed Member Offline";
  return obj[message];
}

export function directReturn(flag: boolean): string {
  const message = flag ? "Direct Online" : "Direct Offline";
  return message;
}

export function directLogicalReturn(flag: boolean): string {
  const message = flag || "Direct Logical Online";
  return message;
}
`,
    );
    writeFileSync(
      join(fixtureRoot, "JsxReturn.tsx"),
      `export function Badge() {
  return "Online";
}
`,
    );
    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    const returnFindings = findings.filter(
      (f) => f.rule === "raft-i18n/no-literal-return-prose",
    );
    const sources = returnFindings.map((f) => f.source);
    const byPath = (path: string) => returnFindings.filter((f) => f.path === path);
    const greenSources = byPath("internalGreen.ts").map((f) => f.source);

    assert.ok(
      sources.some((s) => s.includes("Online")),
      `return Online must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Offline")),
      `return Offline / template must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Computer status")),
      `return Computer status must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Computer offline")),
      `return Computer offline must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("HTML region")),
      `return HTML region must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Hello World")),
      `concise arrow literal body must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Tasks remaining")),
      `concise arrow / local template residue must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Row label")),
      `returned local prefix producer Row label must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Select timezone")),
      `returned local selectedLabel producer must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Working") && s.includes("\u2026")),
      `returned local logical Working… producer must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("Thinking") && s.includes("\u2026")),
      `returned local logical Thinking… producer must be caught; got ${JSON.stringify(sources)}`,
    );
    assert.ok(
      sources.some((s) => s.includes("World Tasks")),
      `returned local concat producer must be caught; got ${JSON.stringify(sources)}`,
    );

    assert.ok(
      !greenSources.some((s) => s.includes("Debug Online") || s.includes("Debug Offline")),
      `unused debug conditional must stay GREEN; got ${JSON.stringify(greenSources)}`,
    );
    assert.ok(
      !greenSources.some(
        (s) =>
          s.includes("Unused Logical Online") ||
          s.includes("Unused Concat Offline") ||
          s.includes("Unused Template Online"),
      ),
      `unused logical/concat/template producers must stay GREEN; got ${JSON.stringify(greenSources)}`,
    );
    assert.ok(
      !greenSources.some((s) => s.includes("Outer Online") || s.includes("Outer Offline")),
      `outer unused conditional must stay GREEN; got ${JSON.stringify(greenSources)}`,
    );
    assert.ok(
      greenSources.some((s) => s.includes("Inner Online") || s.includes("Inner Offline")),
      `nested returned local producer must still be caught; got ${JSON.stringify(greenSources)}`,
    );
    assert.ok(
      !greenSources.some(
        (s) =>
          s.includes("Key Only Online") ||
          s.includes("Key Only Offline") ||
          s.includes("Array Key Online") ||
          s.includes("Array Key Offline") ||
          s.includes("Member Key Online") ||
          s.includes("Member Key Offline") ||
          s.includes("Key Only Logical Online"),
      ),
      `object/member key-only Identifiers must stay GREEN; got ${JSON.stringify(greenSources)}`,
    );

    const valueRefSources = byPath("valueRefProse.ts").map((f) => f.source);
    assert.ok(
      valueRefSources.some((s) => s.includes("Shorthand Online") || s.includes("Shorthand Offline")),
      `shorthand { message } must count as value ref; got ${JSON.stringify(valueRefSources)}`,
    );
    assert.ok(
      valueRefSources.some(
        (s) => s.includes("Computed Key Online") || s.includes("Computed Key Offline"),
      ),
      `computed {[message]: x} must count as value ref; got ${JSON.stringify(valueRefSources)}`,
    );
    assert.ok(
      valueRefSources.some(
        (s) => s.includes("Computed Member Online") || s.includes("Computed Member Offline"),
      ),
      `obj[message] must count as value ref; got ${JSON.stringify(valueRefSources)}`,
    );
    assert.ok(
      valueRefSources.some((s) => s.includes("Direct Online") || s.includes("Direct Offline")),
      `direct return message must count as value ref; got ${JSON.stringify(valueRefSources)}`,
    );
    assert.ok(
      valueRefSources.some((s) => s.includes("Direct Logical Online")),
      `direct logical return must count as value ref; got ${JSON.stringify(valueRefSources)}`,
    );
    assert.equal(
      byPath("JsxReturn.tsx").length,
      0,
      ".tsx returns must not use return-prose rule",
    );
    assert.equal(
      findings.filter(
        (f) =>
          f.path === "internalGreen.ts" &&
          f.rule === "raft-i18n/no-literal-in-message-call",
      ).length,
      0,
      "throw new Error must not be flagged by raft-i18n call rule",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

/**
 * SOP minimal production-mutation RED replay (docs/sops/ci-check-maintenance.md Required-Test Admission).
 * Replays the parent-agent lint mutation against real production sources in a
 * temp root so reviewers need not rely on invisible Shell transcripts.
 */
test("SOP minimal production-mutation RED replay for raft-i18n call/return", () => {
  const MAIN_REL = "src/components/layout/MainLayout.tsx";
  const ACTIVITY_REL = "src/utils/activity.ts";
  const mainNeedle =
    'toast.error(formatMessage({ id: "message.messageItem.threadUnavailable" }));';
  const activityNeedle =
    "export function getActivityText(activity: AgentActivity, detail?: string, detailKind?: AgentActivityDetailKind, errorCode?: RuntimeErrorCode | null): string {";

  const mainSrc = readFileSync(join(WEB_ROOT, MAIN_REL), "utf8");
  const activitySrc = readFileSync(join(WEB_ROOT, ACTIVITY_REL), "utf8");
  assert.ok(mainSrc.includes(mainNeedle), "MainLayout onFailure toast needle must exist");
  assert.ok(activitySrc.includes(activityNeedle), "activity.ts getActivityText needle must exist");
  assert.ok(
    !mainSrc.includes('toast.error("New copy")'),
    "production MainLayout must not already contain mutation toast",
  );
  assert.ok(
    !activitySrc.includes('return "New status"'),
    "production activity.ts must not already contain mutation return",
  );

  const liveFindings = collectCurrentFindings({
    root: WEB_ROOT,
    configPath: CONFIG,
    target: "src",
  });
  assert.ok(
    !liveFindings.some(
      (f) =>
        f.rule === "raft-i18n/no-literal-in-message-call" && f.source === '"New copy"',
    ),
    "unmodified corpus must not report New copy",
  );
  assert.ok(
    !liveFindings.some(
      (f) =>
        f.rule === "raft-i18n/no-literal-return-prose" && f.source === '"New status"',
    ),
    "unmodified corpus must not report New status",
  );

  const mutatedMain = mainSrc.replace(
    mainNeedle,
    `${mainNeedle}\n        toast.error("New copy");`,
  );
  assert.notEqual(mutatedMain, mainSrc, "MainLayout mutation must change source");
  const mutatedActivity = `${activitySrc}\nexport function mutationRedReplayStatus(): string {\n  return "New status";\n}\n`;

  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-prod-mutation-replay-"));
  try {
    for (const [rel, content] of [
      [MAIN_REL, mutatedMain],
      [ACTIVITY_REL, mutatedActivity],
    ] as const) {
      const abs = join(fixtureRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }

    const findings = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    const newCopy = findings.filter(
      (f) =>
        f.path === MAIN_REL &&
        f.rule === "raft-i18n/no-literal-in-message-call" &&
        f.source === '"New copy"',
    );
    const newStatus = findings.filter(
      (f) =>
        f.path === ACTIVITY_REL &&
        f.rule === "raft-i18n/no-literal-return-prose" &&
        f.source === '"New status"',
    );
    assert.deepEqual(
      newCopy,
      [
        {
          path: MAIN_REL,
          rule: "raft-i18n/no-literal-in-message-call",
          source: '"New copy"',
          count: 1,
        },
      ],
      `expected exact New copy raft-i18n call finding; got ${JSON.stringify(findings)}`,
    );
    assert.deepEqual(
      newStatus,
      [
        {
          path: ACTIVITY_REL,
          rule: "raft-i18n/no-literal-return-prose",
          source: '"New status"',
          count: 1,
        },
      ],
      `expected exact New status raft-i18n return finding; got ${JSON.stringify(findings)}`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("CLI with real oxlint + temp baseline reports NEW and STALE", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-cli-baseline-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Hi.tsx"),
      "export const Hi = () => <h2>Hello</h2>;\n",
    );
    const emptyBaseline = join(fixtureRoot, "baseline-empty.json");
    writeFileSync(emptyBaseline, "[]\n");

    const newResult = spawnSync(
      process.execPath,
      [
        ...OXC_NODE_ARGS,
        SCRIPT,
        "--root",
        fixtureRoot,
        "--target",
        ".",
        "--config",
        CONFIG,
        "--baseline",
        emptyBaseline,
      ],
      { encoding: "utf8" },
    );
    assert.equal(newResult.status, 1, `stderr=${newResult.stderr}\nstdout=${newResult.stdout}`);
    assert.match(`${newResult.stderr}\n${newResult.stdout}`, /NEW findings/i);
    assert.match(`${newResult.stderr}\n${newResult.stdout}`, /Hello/);

    const current = collectCurrentFindings({
      root: fixtureRoot,
      configPath: CONFIG,
      target: ".",
    });
    const staleBaseline = join(fixtureRoot, "baseline-stale.json");
    writeFileSync(
      staleBaseline,
      `${JSON.stringify(
        [
          ...toBaselineEntries(current, "debt"),
          {
            path: "Hi.tsx",
            rule: "formatjs/no-literal-string-in-jsx",
            source: "Gone",
            count: 1,
            classification: "debt",
          },
        ],
        null,
        2,
      )}\n`,
    );

    const staleResult = spawnSync(
      process.execPath,
      [
        ...OXC_NODE_ARGS,
        SCRIPT,
        "--root",
        fixtureRoot,
        "--target",
        ".",
        "--config",
        CONFIG,
        "--baseline",
        staleBaseline,
      ],
      { encoding: "utf8" },
    );
    assert.equal(staleResult.status, 1, `stderr=${staleResult.stderr}\nstdout=${staleResult.stdout}`);
    assert.match(`${staleResult.stderr}\n${staleResult.stdout}`, /STALE baseline/i);
    assert.match(`${staleResult.stderr}\n${staleResult.stdout}`, /Gone/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("extractSourceComments uses TS scanner and ignores quoted disable text", () => {
  const source = [
    "const tip = \"// oxlint-disable formatjs/no-literal-string-in-jsx\";",
    "const tip2 = '/* eslint-disable */';",
    "export const Hi = () => <h2>Hello</h2>;",
    "",
  ].join("\n");
  const comments = extractSourceComments(source, "Quoted.tsx");
  assert.equal(comments.length, 0, `quoted text must not be comments: ${JSON.stringify(comments)}`);
});

test("forbidden disable directives cover eslint/oxlint line and block forms", () => {
  const cases: Array<{ source: string; why: string }> = [
    {
      why: "oxlint-disable-next-line formatjs rule",
      source: "// oxlint-disable-next-line formatjs/no-literal-string-in-jsx\nexport const x = 1;\n",
    },
    {
      why: "eslint-disable-next-line formatjs rule",
      source: "// eslint-disable-next-line formatjs/no-literal-string-in-object\nexport const x = 1;\n",
    },
    {
      why: "eslint-disable-line formatjs rule",
      source: 'export const x = <h2>Hi</h2>; // eslint-disable-line formatjs/no-literal-string-in-jsx\n',
    },
    {
      why: "oxlint-disable-line formatjs rule",
      source: 'export const x = 1; // oxlint-disable-line formatjs/no-literal-string-in-jsx\n',
    },
    {
      why: "block eslint-disable formatjs rule",
      source: "/* eslint-disable formatjs/no-literal-string-in-jsx */\nexport const x = 1;\n",
    },
    {
      why: "block oxlint-disable formatjs rule with reason",
      source:
        "/* oxlint-disable formatjs/no-literal-string-in-object -- temp */\nexport const x = 1;\n",
    },
    {
      why: "bare oxlint-disable",
      source: "// oxlint-disable\nexport const x = 1;\n",
    },
    {
      why: "bare eslint-disable block",
      source: "/* eslint-disable */\nexport const x = 1;\n",
    },
    {
      why: "bare oxlint-disable with reason only",
      source: "// oxlint-disable -- suppress everything for now\nexport const x = 1;\n",
    },
    {
      why: "bare eslint-disable-next-line",
      source: "// eslint-disable-next-line\nexport const x = 1;\n",
    },
    {
      why: "oxlint-disable-next-line raft-i18n rule",
      source:
        "// oxlint-disable-next-line raft-i18n/no-literal-in-message-call\nexport const x = 1;\n",
    },
    {
      why: "eslint-disable raft-i18n return prose",
      source:
        "/* eslint-disable raft-i18n/no-literal-return-prose */\nexport const x = 1;\n",
    },
  ];

  for (const { source, why } of cases) {
    const hits = findForbiddenDisableDirectivesInSource(source, "Case.tsx");
    assert.ok(hits.length >= 1, `${why} must be forbidden`);
  }
});

test("unrelated-rule disables and quoted strings stay allowed", () => {
  const source = [
    "// oxlint-disable-next-line react-doctor/no-derived-state -- seed-once",
    "// eslint-disable-next-line react-hooks/exhaustive-deps",
    "/* eslint-disable no-alert, no-console */",
    '// oxlint-disable react-hooks/exhaustive-deps -- scoped',
    'const tip = "// oxlint-disable formatjs/no-literal-string-in-jsx";',
    "export const Hi = () => <h2>Hello</h2>;",
    "",
  ].join("\n");
  assert.deepEqual(findForbiddenDisableDirectivesInSource(source, "Ok.tsx"), []);
});

test("assertNoForbiddenI18nDisableDirectives fails closed before oxlint", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-disable-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Bad.tsx"),
      "// oxlint-disable-next-line formatjs/no-literal-string-in-jsx\nexport const Hi = () => <h2>Hello</h2>;\n",
    );
    assert.throws(
      () =>
        assertNoForbiddenI18nDisableDirectives({
          root: fixtureRoot,
          target: ".",
        }),
      /forbidden-directive|formatjs|disable/i,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("CLI exits 2 on forbidden formatjs disable directive before baseline compare", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "i18n-disable-cli-"));
  try {
    writeFileSync(
      join(fixtureRoot, "Bad.tsx"),
      "/* eslint-disable */\nexport const Hi = () => <h2>Hello</h2>;\n",
    );
    writeFileSync(join(fixtureRoot, "baseline.json"), "[]\n");
    const result = spawnSync(
      process.execPath,
      [
        ...OXC_NODE_ARGS,
        SCRIPT,
        "--root",
        fixtureRoot,
        "--target",
        ".",
        "--baseline",
        join(fixtureRoot, "baseline.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, `stderr=${result.stderr}\nstdout=${result.stdout}`);
    assert.match(`${result.stderr}\n${result.stdout}`, /forbidden-directive/i);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("real corpus: structural, catalog-id, and template-glue filters remove audited keys only", () => {
  // Applies the same predicate used before aggregate. Audited C-sub-batch is
  // 73 space/punct/count keys; exact safe shapes must filter all 73.
  const baselinePath = resolve(WEB_ROOT, "scripts/i18n-literal-baseline.json");
  const current = collectCurrentFindings({
    root: WEB_ROOT,
    configPath: CONFIG,
    target: "src",
  });
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Array<{
    path: string;
    rule: string;
    source: string;
    count: number;
    classification: string;
  }>;

  // Gate compare: after baseline shrink, current must match (new=0/stale=0).
  const compare = compareFindingsToBaseline(current, baseline);
  assert.equal(compare.ok, true, JSON.stringify({
    new: compare.newFindings.slice(0, 5),
    stale: compare.staleBaseline.slice(0, 5),
  }));
  assert.equal(compare.newFindings.length, 0);
  assert.equal(compare.staleBaseline.length, 0);

  // No remaining baseline entry may still be ignorable structural noise.
  const catalogIds = loadDefaultCatalogMessageIds();
  const leaked = baseline.filter((e) =>
    isIgnorableStructuralLiteral(e.source, catalogIds),
  );
  assert.deepEqual(
    leaked,
    [],
    `baseline still contains ignorable structural keys: ${JSON.stringify(leaked.slice(0, 10))}`,
  );

  // Reconstruct what the filter would drop from a raw (unfiltered) pass by
  // scanning oxlint diagnostics without the structural filter.
  const { report } = runOxlintI18n({
    root: WEB_ROOT,
    configPath: CONFIG,
    target: "src",
  });
  const raw = findingsFromOxlintDiagnostics(report.diagnostics, {
    root: WEB_ROOT,
    readFile: (absPath: string) => readFileSync(absPath, "utf8"),
  });
  const rawAgg = aggregateFindings(raw);
  const filteredOut = rawAgg.filter((e) => isIgnorableStructuralLiteral(e.source));
  const filteredKeys = filteredOut.length;
  const filteredHits = filteredOut.reduce((n, e) => n + e.count, 0);
  const glueFilteredOut = rawAgg.filter(
    (e) =>
      !isIgnorableStructuralLiteral(e.source) &&
      isIgnorableStructuralLiteral(e.source, catalogIds),
  );

  // The task history status badges add the structural Badge API enum
  // `variant="accent"`; it is not user-visible copy and must not be cataloged.
  // The Dev tools header intentionally removed its inline hyphen/space when
  // the environment and signed-in identity became separate rows, reducing
  // this audited structural total by two.
  // HandoffCreateFlow (formerly HandoffPanel) adds one structural `"-"` placeholder
  // for absent cwd/model metadata — punctuation, not user copy.
  // VerifiedOnRow (provider probe shadow UI) adds one structural `" "` spacer
  // between the "Verified on" label and the Computer name in a chip —
  // layout glue, not user copy.
  // The RUI themed-surface migration (c9f42e5d2) removed one structural
  // literal, so the merged tree audits one fewer than staging's 80.
  // The wave-2 title→Tooltip migration deleted PaletteAuditPage's redundant
  // `title="100%"` and `title={`${t}%`}` swatch duplicates (rule: title ==
  // visible text), removing two more structural findings.
  // B5's Textarea migration moved the pre-join counter/error markup onto RUI's
  // TextareaCounter/Field shapes, retiring one structural literal with the old
  // shell: 80 -> 76.
  // Create Agent's "Start from" options (task #104, #8024) moved the handoff
  // surface into HandoffCreateFlow.tsx and render the selected session's tool
  // row as bare JSX text `{tool} · {cwd}` — the middot is a separator between
  // two dynamic values, layout glue rather than user copy: 76 -> 77.
  // Removing WikiPanel retires JSX structural keys ":", "·", "—", "→"
  // (2, 4, 1, 1 hits respectively), lowering 77 keys to 73.
  // Agent profile edits moved into per-field dialogs (task #672); the inline
  // description editor's `{length}/{max}` counter and its "/" glue went with it:
  // 73 -> 72. Splitting the agent's computer status and version into their own
  // rows retired the "· " glue between them: 72 -> 71.
  // Joint channel limits v0.3 (task #25) removed CreateJointChannelDialog's
  // free-host paywall, and with it that file's only `{" "}` spacer: 71 -> 70.
  // One extracted component per file (task #709) moved two rows out of files
  // that keep a literal of the same kind: AgentDetailPanel's `=` (2 hits) is
  // now split with EnvVarEntryRow, and SettingsPanel's `/` (6 hits) with
  // PlanSectionContent. Keys are per file, so 70 -> 72; no literal was added
  // and the hit total is unchanged.
  // AnnouncementDialog replaces the paginated Modal, retiring its JSX
  // `{pageIndex + 1} / {totalPages}` separator: 72 -> 71.
  // MachineDetailPanel's workspace path left JSX for a helper (slock#9190),
  // taking its `/` template glue with it: 71 -> 70.
  // AttachmentMetaText moved out of MessageItem into its own module so the
  // public read-only attachment list can reuse it; its `·` separator is now a
  // key in that file as well. Keys are per file, so 70 -> 71; no literal was
  // added and the hit total is unchanged.
  // ActionCard's field rows moved out of JSX into useActionCardDetail (task
  // #752, raft-ui MessageActionCard), dropping one audited key in
  // ActionCard.tsx: 71 -> 70.
  // RaftBench's overview has three audited per-file delimiter keys
  // (RaftBenchPage's JSX space and middle dot, ManagerOverview's cost slash);
  // TaskOverview and CostOverview are gone. The Raft Design System rewrite
  // drops five structural keys (the inline replies' ` ›` chevron, the thread
  // header's `—`, the channel overflow's `+` and the palette audit's `/` and
  // `100` swatch labels) and adds three (the channel header's `·` and the
  // thread header's `" "` and `" · "` subtitle glue). No business text is
  // exempted.
  // Paginated share images (#10026) add SelectShareLightbox's page counter
  // `{currentPage + 1}/{pageCount}` — a `/` between two numbers, the same
  // shape as ThreadPanel's search counter: 71 -> 72.
  // RaftBench insight category headings add a middle-dot separator between
  // a translated category and its formatted count: structural punctuation only.
  // AgentSkills' stale note (a Computer that did not answer in time) adds a
  // `{" "}` spacer between the translated sentence and its Retry TextLink —
  // layout glue, the same shape as RuntimeFormV2SourceStatusLine's: 73 -> 74.
  // App link preview cards show the link's real host after the App's name
  // (`{appName} · {host}`): a `·` between two dynamic values, structural
  // punctuation only: 74 -> 75.
  // The Agent MCP tab (AgentMcpTab / McpServerListItem) was deleted when MCP Apps
  // became rows of the Agent's Apps tab, taking its separator key with it: 75 -> 74.
  // The search page's Free history notice adds a `{" "}` spacer between its
  // translated sentence and its Upgrade TextLink — layout glue: 74 -> 75.
  // The phone's server tab (MobileServerTab, raft-design #712) shows each
  // server's address as `/{server.slug}` under its name, as Home's switcher
  // does: a `/` before a dynamic value, structural punctuation in a new file:
  // 75 -> 76.
  // ServerRowUnread, the server rows' shared unread count (Home's switcher and
  // the server tab's popover), puts a ", " between a muted count and its
  // screen-reader reason: structural punctuation in a new file: 76 -> 77.
  // The Artifacts home page (S7) leads a mentioning comment's excerpt with
  // its sender and a colon, as Activity's InboxItemSender does, and ends a
  // truncated excerpt with an ellipsis — punctuation only: 77 -> 79.
  // The Computers rack overview joins a row's
  // facts with `·` (OS release · version; Offline · Last seen …), as JSX text
  // around translated or reported values: two structural keys in a new file,
  // no business text: 79 -> 81.
  // Action cards drawn from their spec (ActionCardSpecRenderer) join a
  // property's entity chips with ", ": structural punctuation between dynamic
  // values in a new file: 81 -> 82.
  // The private-share install page names the link's one target server as
  // `/{server.slug}` under its name (#proj-apps:769a57d4), as Home's switcher
  // and the server tab do: a `/` before a dynamic value, structural punctuation
  // only; the file already had a `.` key: 82 -> 83.
  // The Artifact link's hover card (ArtifactLinkPreview) joins its type,
  // version, facts and home with `·`, as the App link card does: structural
  // punctuation between dynamic values in a new file: 83 -> 84.
  // The v2 runtime-form source status joins its reason and fallback sentences
  // with a " " array item so the Retry tail can glue to the last one
  // (withInlineActionTail): structural whitespace between two translated
  // sentences: 84 -> 85.
  // The rack's runtime account meters (RackRuntimeUsage) print `{left}%`
  // after the runtime's mark, as RackMeter prints Disk / Memory's `{percent}%`
  // beside them: a `%` after a number, structural punctuation in a new file:
  // 82 -> 83.
  // The touch Select Text sheet (MessageSelectTextDrawer) heads the message's
  // text with `{sender} · {time}`, as the Computers rack joins its facts: a
  // `·` between two dynamic values, structural punctuation in a new file:
  // 83 -> 84.
  // AddSeatsDialog (task #10, adding Pro seats in place) puts a `{" "}` spacer
  // between a failed price's translated sentence and its "Try again" TextLink —
  // layout glue in a new file, the same shape as AgentSkills' stale note: 84 -> 85.
  // With feat's Artifacts keys merged (feat was at 87 over staging's 84): 88.
  // The Artifact review notice (ArtifactReviewParts) puts a `{" "}` spacer
  // between its draft count and the muted hint, two translated sentences:
  // layout glue in a new file, the AddSeatsDialog shape: 88 -> 89.
  // The composer's upload banners went (upload limits open the upgrade dialog),
  // and with them MessageInput's `{" "}` spacer before their Upgrade TextLink: 89 -> 88.
  // The Apps page's Marketplace row (MarketplaceListingsTab) joins its by-line
  // and the App's description with a ` · ` span: structural punctuation
  // between a translated line and a dynamic one, in a new file: 88 -> 89.
  // The Artifact review notice became raft-ui's ModeBar (title and description
  // are separate parts), so its `{" "}` spacer between them went: 89 -> 88.
  // The migration log (MigrationLogPage) prints `—` for an empty value, `%`
  // after the success rate, a `/` between the ring-1 legend's two swatches and
  // `···` for a removed computer's code: structural punctuation only, in a new
  // file; its routes, lists and ranges go through agent.migrationLog.fmt.*: 88 -> 92.
  // The rack's Disk / Memory say "62% used" through machine.rack.percentUsed
  // (usage shows what is used, stdrc 2026-10-29), so RackResource's bare
  // `{percent}%` went: 92 -> 91.
  // The Qwen Code provider dialog (RuntimeProviderConnectDialog) heads the key step with
  // `{group} · {provider}`, Qwen's own group and provider names: a `·` between
  // two dynamic values, structural punctuation: 91 -> 92.
  // The runtime field's label (RuntimeConfigFields) holds name, `{" "}` and
  // the Experimental badge in one span, so the closed Select's flex trigger
  // keeps the space: layout glue between a name and a badge: 92 -> 93.
  // Plan & Billing became an overview (task #13): the seat form's `/` between
  // used and bought and the confirm dialog's `label: value` rows went, and its
  // separators are catalog text now (planBilling.*): 93 -> 91.
  // The Custom MCP App form (McpAppServerSection) puts a `{" "}` spacer between
  // its Marketplace hint and the Browse Marketplace TextLink, two translated
  // strings: layout glue, the AddSeatsDialog shape: 91 -> 92.
  // The error trace id note (TraceIdNote, #proj-o11y:#18) shows the first 8 hex
  // digits followed by `…`: an ellipsis after a dynamic value, structural
  // punctuation in a new file: 92 -> 93.
  // ThreadsInbox moved into features/thread (#proj-frontend:#18): its two
  // row components went to their own files, so its `:` glue (one key, 2
  // hits) is now one key in InboxRow and one in ObjectInboxRow: 93 -> 94.
  // ManagerOverview's cost comparison became a date-labeled table, removing
  // the cost slash between the two amounts: 94 -> 93.
  // RaftBench's All view lists every finding instead of a newest-three sample
  // per kind, dropping the ` · ` between a kind heading and its count: 93 -> 92.
  // An App link card's details row (LinkCardElements) puts a `·` between two
  // drawn details that aren't the state Badge (artin, Kirby, 2026-11-01): a
  // `·` between App-supplied values, structural punctuation: 92 -> 93.
  // The channel drawer head (ChannelOverflowMenu) reads "Settings · #name" on
  // a phone (stdrc, 2026-11-03): an aria-hidden `·` between the title and the
  // channel ref, structural punctuation: 93 -> 94.
  // The thread head's subtitle (ThreadPanelHeader, #189 rule 6) holds its
  // `{" · "}{N replies}` in a span of its own, so it ellipsizes after the
  // channel name: the same `·` glue, now an element's child: 94 -> 95.
  // The downgrade banner (DowngradeWarningCard) is one sentence now (task #3 in
  // #proj-commercial): the `(`, `/` and `)` around each "N over limit" row's
  // count and limit went with those rows: 95 -> 92.
  // The Artifacts home (#proj-workspace:#133) moved a waiting row's `name: `
  // and `…` out of ArtifactsDashboard into ArtifactMentionExcerpt, shared with
  // the table's waiting rows: its `:` is still one key there, the `…` no longer
  // counts as one: 92 -> 91.
  // The keyboard shortcuts list (ShortcutHelpList) puts a `/` between a row's
  // two Kbds (⌘↑ / ⌘↓), as Artea's mockup draws it: structural punctuation
  // between keys, not copy: 91 -> 92. Its ranges' `…` (⌘1…⌘9), between two
  // KbdShortcut now rather than glue inside one string, is the same: 92 -> 93.
  // View Context's folded tool result (AgentContextViewMessageList) shows the
  // output's first characters followed by `…` when there is more: an ellipsis
  // after a dynamic value, structural punctuation in a new file, the
  // TraceIdNote shape: 93 -> 94.
  // The typed action card left the web (every card renders from its spec,
  // #proj-apps:#40 P9), and with it ActionCard.tsx's busy button `…` and its
  // result line's `→ ` arrow: 94 -> 92.
  // The editable shortcuts panel (#proj-frontend:#37): the message box's note puts a `{" "}` spacer between its
  // sentence and the "Change in Settings" TextLink, the McpAppServerSection shape: 92 -> 93. The `/` and `…` between
  // Kbds moved with them from ShortcutHelpList into ShortcutKeysView: the same keys.
  // The Artifacts home's one list (#proj-workspace:#210) has no waiting rows, and with them ArtifactMentionExcerpt
  // and its `:` left: 93 -> 92.
  // The agent read line (MessageReadStatusLine, #proj-raft-ui:#212) puts an aria-hidden `·` between who won't get the
  // message and the hint to mention them, the ChannelOverflowMenu shape: structural punctuation: 92 -> 93.
  // A channel's header no longer says who is working (#proj-raft-ui:#211): ChannelHeaderSubtitle and its aria-hidden
  // `·` between the working line and the description went; the line above the composer joins its parts in the catalog
  // (message.agentTyping.typingAndOthers): 93 -> 92.
  // The display report dialog (ArtifactDisplayReportDialog, #proj-workspace:#243) put a `{" "}` spacer between the
  // page area's mono size and its unit, and between the two translated sentences of who sees the report: layout glue
  // in a new file, the AddSeatsDialog shape: 92 -> 93. The dialog went (the report is the comment list's own box,
  // xxchan), and its spacers with it: 93 -> 92.
  // The Members page's agents list (MembersAgentList) shows `—` in a Runtime,
  // Model or Computer cell with no value (raft-design members.md, "a dash for
  // an agent on no computer"): structural punctuation, not copy: 92 -> 93.
  // HelperText step 1 cut McpAppServerSection's Marketplace sentence; its "Browse marketplace" TextLink stands alone,
  // and the `{" "}` spacer between them went: 93 -> 92.
  // Adding seats to prepaid Pro (PrepaidSeatsPart, task #19 in #proj-commercial) puts a `{" "}` spacer between a
  // refused price and its Retry TextLink, the AddSeatsDialog shape: layout glue in a new file: 92 -> 93.
  // A task hand-off card (TaskHandoffCard, #wg-task-v2:#20) puts a `→` between who handed the task and to whom:
  // structural punctuation, not copy: 93 -> 94.
  // The member-connect dialog row and the Connected servers row separate the
  // slug from their note with an aria-hidden ` · ` span (#wg-rbac:#36): 94 -> 96.
  // The channel details are a column titled Details (raft-design channel.md, stdrc 2026-11-10): the drawer head's
  // "Settings · #name" and its `·` went with ChannelDrawerTitle: 96 -> 95.
  // The Computers list (ComputerRackRow) shows an aria-hidden `—` in the Agents cell of a computer with no agents,
  // as an empty usage cell, with the words for a screen reader: structural punctuation, not copy: 95 -> 96.
  // An agent profile's Computer version row (AgentProfileInfo) is the version only, `—` when there is none (its
  // Online / Offline is the row above, approved status design): structural punctuation, not copy: 96 -> 97.
  // The Computers page's needs-attention line (ComputersAttentionSummary, #proj-raft-computer:#68) separates its
  // parts with an aria-hidden `·`: structural punctuation, not copy: 97 -> 98.
  // The Computers list usage cell's model line (RackRuntimeUsage, OAR 0.102 window scope) puts a `{" · "}` between
  // the model name and its value ("Opus · 40%"): structural punctuation, not copy: 98 -> 99.
  assert.equal(filteredKeys, 99, `audited structural key count; got ${filteredKeys}`);
  assert.ok(filteredHits > 100, `hits must exceed prior 100; got ${filteredHits}`);
  // HandoffCreateFlow's `· ${session.model}` suffix is dynamic metadata glue, the
  // same shape as EditChannelDialog's `· ${…}` suffixes.
  // VerifiedOnRow's chip title `` `${runtime} · ${model} · ${verifiedAt}` `` is
  // the same dynamic-metadata glue shape: coordinates, not user copy.
  // 18 -> 16 glue keys/hits (2026-09-16): the title= -> RUI Tooltip migration
  // moved `${key}=${value}` (env-var reveal) and `${human.displayName || human.name}`
  // (sidebar human row) from intrinsic-element title attributes into <Tooltip>
  // content props — and formatjs/no-literal-string-in-jsx only flags intrinsic
  // elements, the same intrinsic-only effect recorded above for RuntimeConfigFields.
  // The literals remain in source; they simply leave the audited surface.
  // 16 -> 15 (2026-09-16): the same migration DELETED HumanDetailPanel's redundant
  // handle-span title `` `@${human.name}` `` (title == visible text); the surviving
  // occurrence lives on the PanelHeader component prop, also outside the intrinsic
  // surface.
  // 15 -> 14 (2026-10-04): #8831 deleted the fresh-install upgrade block, and with it
  // MachineDetailPanel's `` ` ${formatMessage(pinnedVersion)}` `` suffix glue.
  // 14 -> 15 (2026-10-14): channelKindIcon's sr-only `` `${label}, ` `` (#9826): a
  // translated sentence plus the comma that keeps it a separate spoken phrase
  // before the channel name. Glue, not user copy.
  // 15 -> 16 (2026-10-21): MessageInput's external-mention description
  // `` `${providerBadge} · ${external.workspaceName}` `` (#231): the translated
  // provider badge joined by the middot separator to a runtime workspace name.
  // Glue, not user copy.
  // 16 -> 15 (2026-10-23): HumanLoginSetupPage's app-card aria-label
  // `` `${openAppAriaPrefix} ${client.name}` `` now goes through
  // opensInNewTabAriaLabel(), which adds "(opens in a new tab)" for links that
  // leave Raft (task #160); a template passed as an argument is not JSX glue.
  // 15 -> 14 keys and hits: a private share link installs on one target server
  // (#proj-apps:769a57d4), so the install page dropped its server picker and
  // with it the option label `` `${server.name}${installedSuffix}` ``.
  // 14 -> 12 keys and hits: Plan & Billing became an overview (task #13); its
  // upload row `` `${used} / ${limit} ${thisMonth}` `` and the Free upload
  // label `` `${limit}/${month}` `` are planBilling.* messages now.
  assert.equal(
    glueFilteredOut.length,
    12,
    `audited dynamic/translated template-glue key count; got ${JSON.stringify(glueFilteredOut)}`,
  );
  assert.equal(
    glueFilteredOut.reduce((n, e) => n + e.count, 0),
    12,
    "each audited glue key currently occurs once",
  );
  // Structural drops 75 (including the two compatibility source paths);
  // catalog MessageIds drop N; template glue drops 17 (the compatibility
  // settings source repeats the existing channel-server suffix).
  const catalogIdDrops = rawAgg.length - filteredKeys - glueFilteredOut.length - current.length;
  assert.equal(
    current.length,
    rawAgg.length - filteredKeys - catalogIdDrops - glueFilteredOut.length,
    "collectCurrentFindings must drop structural, template-glue, and catalog MessageId keys",
  );
  // The retired AgentScopesPanel contributed 37 catalog keys.
  // Removing settingsNavigation's "wiki.settings" entry lowers 24 to 23.
  // Removing the Workspace grid layout deleted workspaceGridUrlState.ts and its
  // 17 catalog-id keys, lowering 23 to 6.
  assert.ok(catalogIdDrops >= 6, `catalog MessageId drops should stay >= 6; got ${catalogIdDrops}`);
  // Direction matters. Removing a literal lowers these numbers; that is the only
  // legitimate reason they move. RAISING them silences a failure instead of fixing
  // it — and the diff looks almost identical to a legitimate lowering, just with the
  // sign flipped. Treat any upward edit here as a red flag and demand the literal it
  // corresponds to. (Raised by @Bugen: the pins catch drift, not someone editing the
  // pin to make red go away.)
  // ReleaseNotesPanel's owner-managed strings moved into the message catalogs (143/171),
  // and the wave-2 title→Tooltip migration removes the HumanDetailPanel handle-span
  // protocol literal (redundant title deletion): 143 -> 142 keys / 171 -> 170 hits.
  // The corpus-size totals that used to be pinned here (142 keys / 170 hits) are
  // gone for the same reason as the baseline totals below: the compare.ok
  // assertion above already requires `current` to match the baseline finding for
  // finding, so the size of `current` is implied. Pinning it again only meant
  // editing two more numbers whenever a literal was legitimately removed.
  assert.ok(current.length > 0, "current corpus must not be empty");

  for (const entry of filteredOut) {
    assert.equal(
      isIgnorableStructuralLiteral(entry.source),
      true,
      `filtered key must be ignorable: ${entry.path} ${entry.source}`,
    );
  }

  // Former gap shapes must now be among the filtered set.
  const formerGapSources = new Set([
    "→",
    "=",
    "(",
    ")",
    ",",
    '" ›"',
    "/500",
    '"\\n"',
  ]);
  const formerGapFiltered = filteredOut.filter((e) => formerGapSources.has(e.source));
  assert.equal(
    formerGapFiltered.length,
    // WikiPanel's removed "→" was one former-gap key; #8831 removed the Sidebar
    // row's "→ v{targetVersion}" arrow literal (2026-10-04): 13 -> 12.
    // Task #709 moved one of AgentDetailPanel's two "=" into EnvVarEntryRow;
    // keys are per file, so the same two hits are now two keys: 12 -> 13.
    // The Raft Design System replies summary drops its `" ›"` chevron (the DS
    // `rf-replies` block has none): 13 -> 12.
    // ServerRowUnread reads a muted count as "5, Notifications muted": the
    // ", " before its screen-reader reason is a new per-file "," key: 12 -> 13.
    // The downgrade notice's `(` and `)` around each count/limit went with its
    // "N over limit" lines (DowngradeWarningCard): 13 -> 11.
    // The typed action card's result line, and its "→" arrow, left ActionCard.tsx
    // (every card renders from its spec, #proj-apps:#40 P9): 11 -> 10.
    // A task hand-off card's "→" between who handed it and to whom (TaskHandoffCard, #wg-task-v2:#20): 10 -> 11.
    11,
    `expected 11 former-gap keys filtered; got ${JSON.stringify(formerGapFiltered)}`,
  );

  // B examples + technical tokens remain; catalog MessageIds and safe glue are gone.
  const bySource = (pred: (s: string) => boolean) =>
    baseline.filter((e) => pred(e.source));
  assert.ok(bySource((s) => s === "@").length >= 1, "B @ must remain");
  assert.ok(bySource((s) => s === "#").length >= 1, "B # must remain");
  assert.ok(bySource((s) => s === '"99+"').length >= 1, "B 99+ must remain");
  assert.ok(bySource((s) => s.includes("→ v")).length >= 1, "B → v must remain");
  assert.equal(
    bySource((s) => /^"[a-z]+(?:\.[a-zA-Z0-9_]+)+"$/.test(s)).length,
    0,
    "exact catalog MessageId object bucket must be filtered (not glue/technical)",
  );
  assert.equal(
    bySource((s) => s.includes("formatMessage") && s.startsWith("`")).length,
    0,
    "translated punctuation-only template glue must be filtered",
  );
  assert.ok(
    bySource((s) => s === "@theme" || s === "file:line" || s === "packages/web/src/index.css").length >= 3,
    "technical-token research bucket must remain",
  );
});
