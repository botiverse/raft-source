import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { kitchenSinkOutputs } from "../kitchen-sink/outputs";

import {
  buildKitchenSink,
  KITCHEN_SINK_KIND_STATES,
  KITCHEN_SINK_MAX_ROWS_PER_PAGE,
  KITCHEN_SINK_PAGE_NAMES,
  KITCHEN_SINK_PAGES,
  KITCHEN_SINK_ROWS,
  KITCHEN_SINK_STATES,
  kitchenSinkRows,
  REAL_FORM_HIDDEN_FIELDS,
  RUNTIME_FORM_VISUAL_CASES_FILE,
  type KitchenSinkPage,
  type RuntimeFormVisualCase,
} from "./kitchenSink";
import { parseRuntimeFormV2, RUNTIME_FORM_V2_FIELD_KINDS, RUNTIME_FORM_V2_OPTION_SOURCE_STATUSES } from "./v2";
import {
  initialRuntimeFormV2Values,
  isRuntimeFormV2FieldVisible,
  RUNTIME_FORM_V2_ERROR_CODES,
  runtimeFormV2Choices,
  runtimeFormV2SourceStatus,
  validateRuntimeFormV2,
  type RuntimeFormV2Sources,
} from "./v2State";

const ROOT = new URL("../", import.meta.url).pathname;
const fixture = (name: string) => JSON.parse(readFileSync(`${ROOT}fixtures/${name}`, "utf8")) as unknown;

/** Error codes no v3 create form can show, with why. Every other code needs a row that shows it. */
const UNREACHABLE_ERROR_CODES: Record<string, string> = {
  connection_unavailable: "v2 saved provider connections only (retired); v3 sends them as unavailableOptions (option_unavailable)",
  secret_reentry_required: "edit only (writeOnlyKeepRequiresUnchanged); the kitchen sink is a create form",
};

function rendered(page: KitchenSinkPage) {
  const { form, sources, state } = buildKitchenSink(page);
  const parsed = parseRuntimeFormV2(form);
  assert.ok(parsed, "the kitchen sink parses as a v3 form");
  const typedSources = sources as RuntimeFormV2Sources;
  const values = { ...initialRuntimeFormV2Values(parsed, typedSources), ...state.values };
  return { parsed, sources: typedSources, values, errors: validateRuntimeFormV2(parsed, typedSources, values), state };
}

test("the generated fixtures are fresh: regenerating produces no diff", () => {
  // What kitchen-sink/generate.ts would write, compared in process.
  const { outputs, stale } = kitchenSinkOutputs(readdirSync(`${ROOT}fixtures`), fixture);
  for (const [name, content] of Object.entries(outputs)) {
    let current: string | null = null;
    try { current = readFileSync(`${ROOT}fixtures/${name}`, "utf8"); } catch { /* missing */ }
    assert.ok(current === content, `fixtures/${name} is stale: run pnpm --filter @botiverse/raft-runtime-form kitchen-sink:generate`);
  }
  assert.deepEqual(stale, [], "kitchen-sink fixtures no longer generated: run kitchen-sink:generate");
});

test("every field kind of the protocol has rows, or says why it cannot appear in a v3 form", () => {
  assert.deepEqual(Object.keys(KITCHEN_SINK_ROWS).sort(), [...RUNTIME_FORM_V2_FIELD_KINDS].sort());
  for (const kind of RUNTIME_FORM_V2_FIELD_KINDS) {
    const rows = KITCHEN_SINK_ROWS[kind];
    if (Array.isArray(rows)) assert.ok(rows.length > 0, `${kind} has no rows`);
    else assert.ok(rows.exempt.trim().length > 0, `${kind}: an exemption needs a reason`);
  }
});

test("each kind's own rows show every state of the kind x state matrix that applies to it", () => {
  for (const kind of RUNTIME_FORM_V2_FIELD_KINDS) {
    const matrix = KITCHEN_SINK_KIND_STATES[kind];
    const rows = KITCHEN_SINK_ROWS[kind];
    if ("exempt" in matrix) {
      assert.ok(!Array.isArray(rows), `${kind}: the matrix exempts it, so it has no rows`);
      continue;
    }
    // Complete: every state is decided for every kind, required or not applicable with a reason.
    for (const state of KITCHEN_SINK_STATES) {
      const required = matrix.required.includes(state);
      const reason = matrix.notApplicable[state];
      assert.ok(required !== (reason !== undefined), `${kind} x ${state}: list it as required or not applicable, not both or neither`);
      if (reason !== undefined) assert.ok(reason.trim().length > 0, `${kind} x ${state}: a reason is required`);
    }
    // Covered by this kind's rows, not by another kind's.
    const claimed = new Set(kitchenSinkRows().filter((row) => row.kind === kind).flatMap((row) => row.states));
    for (const state of matrix.required) assert.ok(claimed.has(state), `${kind} has no row in state ${state}`);
    for (const state of claimed) assert.ok(matrix.required.includes(state), `${kind} claims ${state}, which its matrix says does not apply`);
  }
});

test("every kind is on exactly one page, and a page stays short enough to capture whole", () => {
  const paged = KITCHEN_SINK_PAGE_NAMES.flatMap((page) => [...KITCHEN_SINK_PAGES[page]]);
  assert.deepEqual([...paged].sort(), [...RUNTIME_FORM_V2_FIELD_KINDS].sort());
  for (const page of KITCHEN_SINK_PAGE_NAMES) {
    assert.ok(kitchenSinkRows(page).length <= KITCHEN_SINK_MAX_ROWS_PER_PAGE, `page ${page} has more than ${KITCHEN_SINK_MAX_ROWS_PER_PAGE} rows: add a page`);
  }
});

test.each(KITCHEN_SINK_PAGE_NAMES)("page %s: each row parses as the kind it is listed under, in the form's order", (page) => {
  const { parsed } = rendered(page);
  assert.deepEqual(parsed.fields.map((field) => field.key), kitchenSinkRows(page).map((row) => row.key));
  for (const row of kitchenSinkRows(page)) {
    const field = parsed.fields.find((candidate) => candidate.key === row.key)!;
    assert.equal(field.kind, row.kind, row.key);
    assert.equal(field.advanced, row.advanced === true, `${row.key} advanced`);
  }
  assert.deepEqual(parsed.blockingFieldKeys, kitchenSinkRows(page).filter((row) => row.states.includes("blocking")).map((row) => row.key));
});

test.each(KITCHEN_SINK_PAGE_NAMES)("page %s: each row is in the state it claims under the reference client rules", (page) => {
  const { parsed, sources, values, errors, state } = rendered(page);
  for (const row of kitchenSinkRows(page)) {
    const field = parsed.fields.find((candidate) => candidate.key === row.key)!;
    assert.equal(isRuntimeFormV2FieldVisible(field, values, sources), row.expect.visible, `${row.key} visible`);
    assert.equal(errors[row.key], row.expect.error, `${row.key} error`);
    const status = runtimeFormV2SourceStatus(field, sources);
    const claims = new Set(row.states);
    if (claims.has("source_live")) assert.equal(sources[row.key]?.status, "live", row.key);
    if (claims.has("source_fallback")) assert.equal(status?.status === "fallback" && !status.stale, true, row.key);
    if (claims.has("source_stale")) assert.ok(status?.stale, row.key);
    if (claims.has("source_unavailable") || claims.has("source_unavailable_hidden")) assert.equal(status?.status, "unavailable", row.key);
    if (claims.has("source_retrying")) assert.ok(state.retryingSourceIds.includes(row.key), row.key);
    if (claims.has("empty")) assert.ok(values[row.key] === "" || values[row.key] === false || (typeof values[row.key] === "object" && Object.keys(values[row.key] ?? {}).length === 0), row.key);
    if (claims.has("filled")) assert.ok(values[row.key] === true || (typeof values[row.key] === "string" && values[row.key] !== "") || (typeof values[row.key] === "object" && Object.keys(values[row.key] ?? {}).length > 0), row.key);
    if (claims.has("shown_by_rule")) assert.ok(field.rule?.effect === "SHOW" && row.expect.visible, row.key);
    if (claims.has("hidden_by_rule")) assert.ok(field.rule?.effect === "HIDE" && !row.expect.visible, row.key);
    if (claims.has("required_by_rule")) assert.ok(!field.required && (field.requiredWhen ?? []).length > 0, row.key);
    if (claims.has("choice_labels")) assert.ok(Object.keys(field.choices ?? {}).length > 0, row.key);
    if (claims.has("required_missing")) assert.ok(row.expect.error === "required" || row.expect.error === "source_unavailable", row.key);
    if (claims.has("invalid")) assert.equal(row.expect.error, "invalid_url", row.key);
    if (claims.has("not_a_choice")) assert.equal(row.expect.error, "not_a_choice", row.key);
    if (claims.has("option_unavailable")) assert.equal(row.expect.error, "option_unavailable", row.key);
    if (claims.has("blocking")) assert.equal(row.expect.error, "unsupported_required", row.key);
    if (claims.has("skipped")) assert.ok(!field.required && row.expect.visible && row.expect.error === undefined, row.key);
    if (claims.has("advanced")) assert.ok(field.advanced, row.key);
    if (claims.has("no_key_hidden")) assert.ok(!row.expect.visible && field.kind === "dependent_select", row.key);
    const choices = runtimeFormV2Choices(field, sources, values);
    if (claims.has("list_only")) assert.ok(field.kind === "dependent_select" && choices?.kind === "select" && !choices.allowCustom, row.key);
    if (claims.has("combobox")) assert.ok(field.kind === "dependent_select" && choices?.kind === "select" && choices.allowCustom && choices.options.length > 0, row.key);
    if (claims.has("free_text")) assert.equal(choices?.kind, "free_text", row.key);
    if (claims.has("custom_value")) assert.ok(sources[row.key]?.customValueAllowed === true || Object.values(sources[row.key]?.customValueAllowedByValue ?? {}).includes(true), row.key);
  }
});

test("the rows cover every state, every source status and every error code a v3 create form can show", () => {
  const errors = Object.assign({}, ...KITCHEN_SINK_PAGE_NAMES.map((page) => rendered(page).errors)) as Record<string, string>;
  const claimed = new Set(kitchenSinkRows().flatMap((row) => row.states));
  for (const state of KITCHEN_SINK_STATES) assert.ok(claimed.has(state), `no row in state ${state}`);
  const statuses = new Set(KITCHEN_SINK_PAGE_NAMES.flatMap((page) => Object.values(buildKitchenSink(page).sources)).map((source) => source.status));
  for (const status of RUNTIME_FORM_V2_OPTION_SOURCE_STATUSES) assert.ok(statuses.has(status), `no source with status ${status}`);
  const shown = new Set(Object.values(errors));
  for (const code of RUNTIME_FORM_V2_ERROR_CODES) {
    assert.equal(shown.has(code), !(code in UNREACHABLE_ERROR_CODES), `error ${code}`);
  }
});

test("the visual case list names the kitchen sink pages and every current v3 create form, each with all its sources", () => {
  const { cases } = fixture(RUNTIME_FORM_VISUAL_CASES_FILE) as { cases: RuntimeFormVisualCase[] };
  const ids = cases.map((entry) => entry.caseId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    // A case id that prefixes another collides in the mobile harness's per-case files.
    assert.ok(!ids.some((other) => other !== id && other.startsWith(id)), `${id} prefixes another case id`);
  }
  for (const entry of cases) {
    const form = fixture(entry.form) as { optionSources?: Record<string, unknown> };
    assert.deepEqual(Object.keys(entry.sources).sort(), Object.keys(form.optionSources ?? {}).sort(), entry.caseId);
    for (const [sourceId, file] of Object.entries(entry.sources)) {
      assert.equal((fixture(file) as { sourceId?: string }).sourceId, sourceId, `${entry.caseId} ${file}`);
    }
  }
});

test("each real create form's case draws every field, except those listed with a reason", () => {
  const { cases } = fixture(RUNTIME_FORM_VISUAL_CASES_FILE) as { cases: RuntimeFormVisualCase[] };
  for (const entry of cases.filter((candidate) => candidate.caseId.startsWith("components.runtime-form.create."))) {
    const form = parseRuntimeFormV2(fixture(entry.form));
    assert.ok(form, entry.form);
    const sources = Object.fromEntries(Object.entries(entry.sources).map(([id, file]) => [id, fixture(file)])) as RuntimeFormV2Sources;
    const state = entry.state ? (fixture(entry.state) as { values: Record<string, never> }) : { values: {} };
    const values = { ...initialRuntimeFormV2Values(form, sources), ...state.values };
    const hidden = REAL_FORM_HIDDEN_FIELDS[entry.runtimeId] ?? {};
    const notDrawn = form.fields
      .filter((field) => field.kind !== "unsupported" && !isRuntimeFormV2FieldVisible(field, values, sources))
      .map((field) => field.key);
    // A field not drawn needs values in REAL_FORM_VISUAL_VALUES that draw it, or a reason in REAL_FORM_HIDDEN_FIELDS.
    assert.deepEqual(notDrawn.sort(), Object.keys(hidden).sort(), `${entry.caseId}: fields not drawn`);
    for (const reason of Object.values(hidden)) assert.ok(reason.trim().length > 0, `${entry.caseId}: a hidden field needs a reason`);
  }
});

test("every visual case is declared in the shared visual case manifest", () => {
  // packages/visual-testing/shared/sharedCases.json drives the React and mobile
  // captures; a case listed here but not there is never shot.
  const { cases } = fixture(RUNTIME_FORM_VISUAL_CASES_FILE) as { cases: RuntimeFormVisualCase[] };
  const manifest = JSON.parse(readFileSync(`${ROOT}../visual-testing/shared/sharedCases.json`, "utf8")) as {
    cases: Array<{ id: string; capture?: { fullLength?: unknown } }>;
  };
  for (const entry of cases) {
    const declared = manifest.cases.find((candidate) => candidate.id === entry.caseId);
    assert.ok(declared, `${entry.caseId} is not in packages/visual-testing/shared/sharedCases.json`);
    // A form grows with its rows: capture it whole.
    assert.ok(declared.capture?.fullLength, `${entry.caseId} needs capture.fullLength`);
  }
});
