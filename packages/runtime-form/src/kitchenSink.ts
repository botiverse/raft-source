/**
 * The runtime form kitchen sink: one protocol v3 create form with a row for
 * every field kind a client renders (RUNTIME_FORM_V2_FIELD_KINDS) in each
 * state it can be in, its option sources, and the client state (values,
 * sources being retried) a visual case renders it with. Generated into
 * fixtures/kitchen-sink-<page>.* by kitchen-sink/generate.ts; web and mobile visual
 * cases render those files (fixtures/visual-cases.v3.json lists them).
 *
 * `KITCHEN_SINK_ROWS` is keyed by field kind, so a new kind in
 * RUNTIME_FORM_V2_FIELD_KINDS does not typecheck until it has rows (or an
 * exemption saying why it cannot appear in a v3 form), and
 * src/kitchenSink.test.ts checks every row really is in the state it claims
 * by running it through the reference client state rules.
 */
import type {
  RuntimeFormV2Definition,
  RuntimeFormV2FieldCopy,
  RuntimeFormV2FieldSchema,
  RuntimeFormV2OptionSource,
  RuntimeFormV2Rule,
} from "./generated/runtimeFormV2";
import type { RuntimeFormV2FieldKind } from "./v2";
import type { RuntimeFormV2ErrorCode, RuntimeFormV2Value } from "./v2State";
import type { RuntimeFormV3Schema } from "./v3Rules";

/**
 * The kitchen sink is cut into pages, one form and one visual case each: a
 * capture grows to at most 2700 dp (both providers' full-length cap), and the
 * whole sink is taller. Each kind belongs to one page; a row only refers to
 * rows on its own page (rules read the switch, dependent selects the select).
 */
export const KITCHEN_SINK_PAGES = {
  inputs: ["text", "secret", "url", "boolean", "string_map", "unsupported"],
  choices: ["select", "dependent_select", "derived_select"],
} as const satisfies Record<string, readonly RuntimeFormV2FieldKind[]>;
export type KitchenSinkPage = keyof typeof KITCHEN_SINK_PAGES;
export const KITCHEN_SINK_PAGE_NAMES = Object.keys(KITCHEN_SINK_PAGES) as KitchenSinkPage[];
/** Rows per page that still fit under the full-length cap (the tallest row is about 120 dp). */
export const KITCHEN_SINK_MAX_ROWS_PER_PAGE = 20;

export const kitchenSinkRuntimeId = (page: KitchenSinkPage) => `kitchen-sink-${page}`;
export const kitchenSinkCaseId = (page: KitchenSinkPage) => `components.runtime-form.kitchen-sink.${page}`;
export const kitchenSinkFormFile = (page: KitchenSinkPage) => `${kitchenSinkRuntimeId(page)}.form.v3.json`;
export const kitchenSinkStateFile = (page: KitchenSinkPage) => `${kitchenSinkRuntimeId(page)}.state.v3.json`;

/** The states a row can claim; the test checks each claim against the state rules. */
export const KITCHEN_SINK_STATES = [
  "empty",
  "filled",
  "required_missing",
  "invalid",
  "shown_by_rule",
  "hidden_by_rule",
  "required_by_rule",
  "advanced",
  "choice_labels",
  "source_live",
  "source_fallback",
  "source_stale",
  "source_unavailable",
  "source_retrying",
  "source_unavailable_hidden",
  "option_unavailable",
  "not_a_choice",
  "custom_value",
  "list_only",
  "combobox",
  "free_text",
  "no_key_hidden",
  "skipped",
  "blocking",
] as const;
export type KitchenSinkState = (typeof KITCHEN_SINK_STATES)[number];

type SourceBody = Pick<
  RuntimeFormV2OptionSource,
  "options" | "defaultValue" | "optionsByValue" | "defaultValueByValue" | "customValueAllowedByValue" | "customValueAllowed" | "status" | "reason" | "retryable" | "state" | "fetchedAt" | "unavailableOptions"
>;

export type KitchenSinkRow = {
  key: string;
  states: KitchenSinkState[];
  label: string;
  schema: Pick<RuntimeFormV2FieldSchema, "type" | "format" | "writeOnly" | "minLength" | "additionalProperties">;
  required?: boolean;
  /** v3 `dataSchema.allOf`: required while this condition (over all values) holds. */
  requiredWhen?: RuntimeFormV3Schema;
  advanced?: boolean;
  rule?: Pick<RuntimeFormV2Rule, "effect" | "condition">;
  copy?: Pick<RuntimeFormV2FieldCopy, "hint" | "placeholder" | "choices">;
  /** The field's option source; its kind follows the row's kind. */
  source?: SourceBody;
  /** dependent_select: the field whose value keys the source. */
  dependsOn?: string;
  /** The value the case sets over the form's initial values (initialRuntimeFormV2Values). */
  value?: RuntimeFormV2Value;
  /** The case shows this field's source as being re-requested (the per-source loading state). */
  retrying?: boolean;
  /** What the reference state rules must say about the row under the case's values. */
  expect: { visible: boolean; error?: RuntimeFormV2ErrorCode };
};

export type KitchenSinkExemption = { exempt: string };

const CHOICES = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma" },
];

const live = (options = CHOICES, defaultValue?: string): SourceBody => ({
  options,
  ...(defaultValue ? { defaultValue } : {}),
  status: "live",
});

// The parent of every dependent_select row; its value ("beta") keys their lists.
const PARENT = "selectFilled";
const BOOLEAN_ON = "booleanOn";
const WHEN_BOOLEAN_ON = { properties: { [BOOLEAN_ON]: { const: true } } };

/**
 * Rows by field kind. The order here is the form's order (kinds in
 * RUNTIME_FORM_V2_FIELD_KINDS order, rows in the order listed).
 */
export const KITCHEN_SINK_ROWS: { [K in RuntimeFormV2FieldKind]: KitchenSinkRow[] | KitchenSinkExemption } = {
  text: [
    { key: "textEmpty", states: ["empty"], label: "Text, empty", schema: { type: "string" }, copy: { placeholder: "Placeholder text" }, expect: { visible: true } },
    {
      key: "textFilled",
      states: ["filled"],
      label: "Text, filled",
      schema: { type: "string" },
      copy: { hint: "A hint with a [link](https://raft.example/docs)." },
      value: "Hello from the kitchen sink",
      expect: { visible: true },
    },
    { key: "textRequired", states: ["required_missing"], label: "Text, required", schema: { type: "string", minLength: 1 }, required: true, expect: { visible: true, error: "required" } },
    {
      key: "textShownByRule",
      states: ["shown_by_rule"],
      label: "Text, shown by rule",
      schema: { type: "string" },
      rule: { effect: "SHOW", condition: { scope: `#/properties/${BOOLEAN_ON}`, schema: { const: true } } },
      value: "Shown while the switch is on",
      expect: { visible: true },
    },
    {
      key: "textHiddenByRule",
      states: ["hidden_by_rule"],
      label: "Text, hidden by rule",
      schema: { type: "string" },
      rule: { effect: "HIDE", condition: { scope: `#/properties/${BOOLEAN_ON}`, schema: { const: true } } },
      value: "Never drawn",
      expect: { visible: false },
    },
    {
      key: "textRequiredByRule",
      states: ["required_by_rule", "required_missing"],
      label: "Text, required by rule",
      schema: { type: "string" },
      requiredWhen: WHEN_BOOLEAN_ON,
      expect: { visible: true, error: "required" },
    },
    { key: "textAdvanced", states: ["advanced", "filled"], label: "Text, advanced", schema: { type: "string" }, advanced: true, value: "--verbose", expect: { visible: true } },
  ],
  secret: [
    { key: "secretEmpty", states: ["empty"], label: "Secret, empty", schema: { type: "string", writeOnly: true }, expect: { visible: true } },
    { key: "secretFilled", states: ["filled"], label: "Secret, filled", schema: { type: "string", writeOnly: true }, value: "sk-kitchen-sink", expect: { visible: true } },
    { key: "secretRequired", states: ["required_missing"], label: "Secret, required", schema: { type: "string", writeOnly: true, minLength: 1 }, required: true, expect: { visible: true, error: "required" } },
  ],
  url: [
    { key: "urlEmpty", states: ["empty"], label: "URL, empty", schema: { type: "string", format: "uri" }, copy: { placeholder: "https://" }, expect: { visible: true } },
    { key: "urlFilled", states: ["filled"], label: "URL, filled", schema: { type: "string", format: "uri" }, value: "https://gateway.example.test/v1", expect: { visible: true } },
    { key: "urlInvalid", states: ["invalid"], label: "URL, invalid", schema: { type: "string", format: "uri" }, value: "gateway.example.test", expect: { visible: true, error: "invalid_url" } },
    { key: "urlRequired", states: ["required_missing"], label: "URL, required", schema: { type: "string", format: "uri", minLength: 1 }, required: true, expect: { visible: true, error: "required" } },
  ],
  boolean: [
    { key: "booleanOff", states: ["empty"], label: "Switch, off", schema: { type: "boolean" }, copy: { hint: "A switch carries its hint on the option card." }, expect: { visible: true } },
    { key: BOOLEAN_ON, states: ["filled"], label: "Switch, on", schema: { type: "boolean" }, value: true, expect: { visible: true } },
  ],
  string_map: [
    { key: "mapEmpty", states: ["empty", "advanced"], label: "Key/value, empty", schema: { type: "object", additionalProperties: { type: "string" } }, advanced: true, expect: { visible: true } },
    {
      key: "mapFilled",
      states: ["filled", "advanced"],
      label: "Key/value, filled",
      schema: { type: "object", additionalProperties: { type: "string" } },
      advanced: true,
      value: { EXAMPLE_FLAG: "1", REGION: "eu-west" },
      expect: { visible: true },
    },
  ],
  select: [
    {
      key: PARENT,
      states: ["filled", "source_live", "choice_labels"],
      label: "Select, filled",
      schema: { type: "string" },
      copy: {
        hint: "Choice labels and descriptions come from the form copy.",
        choices: {
          alpha: { label: "Alpha", description: "The first choice" },
          beta: { label: "Beta", description: "The second choice, picked" },
        },
      },
      source: live(CHOICES, "beta"),
      expect: { visible: true },
    },
    { key: "selectEmpty", states: ["empty", "source_live"], label: "Select, empty", schema: { type: "string" }, source: live(), value: "", expect: { visible: true } },
    { key: "selectRequired", states: ["required_missing", "source_live"], label: "Select, required", schema: { type: "string", minLength: 1 }, required: true, source: live(), value: "", expect: { visible: true, error: "required" } },
    {
      key: "selectNotAChoice",
      states: ["not_a_choice"],
      label: "Select, value not listed",
      schema: { type: "string" },
      source: live(),
      value: "delta",
      expect: { visible: true, error: "not_a_choice" },
    },
    {
      key: "selectFallback",
      states: ["source_fallback", "filled"],
      label: "Select, fallback list",
      schema: { type: "string" },
      source: { options: CHOICES, defaultValue: "alpha", status: "fallback", reason: "missing_config", retryable: false },
      expect: { visible: true },
    },
    {
      key: "selectStale",
      states: ["source_stale", "filled"],
      label: "Select, last known list",
      schema: { type: "string" },
      source: { options: CHOICES, defaultValue: "alpha", status: "fallback", reason: "probe_timeout", retryable: true, state: "stale", fetchedAt: "2026-11-18T08:00:00.000Z" },
      expect: { visible: true },
    },
    {
      key: "selectUnavailable",
      states: ["source_unavailable", "required_missing"],
      label: "Select, unavailable",
      schema: { type: "string", minLength: 1 },
      required: true,
      source: { options: [], status: "unavailable", reason: "probe_failed", retryable: true },
      expect: { visible: true, error: "source_unavailable" },
    },
    {
      key: "selectRetrying",
      states: ["source_retrying", "source_unavailable"],
      label: "Select, loading",
      schema: { type: "string", minLength: 1 },
      required: true,
      source: { options: [], status: "unavailable", reason: "machine_offline", retryable: true },
      retrying: true,
      expect: { visible: true, error: "source_unavailable" },
    },
    {
      key: "selectUnavailableOptional",
      states: ["source_unavailable_hidden"],
      label: "Select, unavailable and optional",
      schema: { type: "string" },
      source: { options: [], status: "unavailable", reason: "unsupported", retryable: false },
      expect: { visible: false },
    },
    {
      key: "selectOptionUnavailable",
      states: ["option_unavailable", "source_live"],
      label: "Select, value no longer available",
      schema: { type: "string", minLength: 1 },
      required: true,
      source: { ...live(), unavailableOptions: [{ value: "retired", label: "Retired", reason: "Disabled by the runtime" }] },
      value: "retired",
      expect: { visible: true, error: "option_unavailable" },
    },
    {
      key: "selectCustomValue",
      states: ["custom_value", "filled"],
      label: "Select, typed value",
      schema: { type: "string" },
      source: { ...live(CHOICES, "alpha"), customValueAllowed: true },
      value: "my-org/custom-model",
      expect: { visible: true },
    },
  ],
  dependent_select: [
    {
      key: "dependentListOnly",
      states: ["list_only", "filled"],
      label: "Dependent select, list only",
      schema: { type: "string" },
      dependsOn: PARENT,
      source: {
        optionsByValue: { alpha: [{ value: "a1", label: "Alpha one" }], beta: [{ value: "b1", label: "Beta one" }, { value: "b2", label: "Beta two" }] },
        defaultValueByValue: { alpha: "a1", beta: "b2" },
        status: "live",
      },
      expect: { visible: true },
    },
    {
      key: "dependentCombobox",
      states: ["combobox", "custom_value"],
      label: "Dependent select, list or typed",
      schema: { type: "string" },
      dependsOn: PARENT,
      source: {
        optionsByValue: { beta: [{ value: "b1", label: "Beta one" }] },
        defaultValueByValue: { beta: "b1" },
        customValueAllowedByValue: { beta: true },
        status: "live",
      },
      value: "beta-typed",
      expect: { visible: true },
    },
    {
      key: "dependentFreeText",
      states: ["free_text", "filled"],
      label: "Dependent select, typed only",
      schema: { type: "string" },
      dependsOn: PARENT,
      source: { optionsByValue: { beta: [] }, customValueAllowedByValue: { beta: true }, status: "live" },
      value: "typed-only-value",
      expect: { visible: true },
    },
    {
      key: "dependentEmpty",
      states: ["empty", "list_only"],
      label: "Dependent select, empty",
      schema: { type: "string" },
      dependsOn: PARENT,
      source: { optionsByValue: { beta: [{ value: "b1", label: "Beta one" }] }, status: "live" },
      expect: { visible: true },
    },
    {
      key: "dependentRequired",
      states: ["required_missing", "list_only"],
      label: "Dependent select, required",
      schema: { type: "string", minLength: 1 },
      required: true,
      dependsOn: PARENT,
      source: { optionsByValue: { beta: [{ value: "b1", label: "Beta one" }] }, status: "live" },
      expect: { visible: true, error: "required" },
    },
    {
      key: "dependentNoKey",
      states: ["no_key_hidden"],
      label: "Dependent select, no list for this value",
      schema: { type: "string" },
      dependsOn: PARENT,
      source: { optionsByValue: { alpha: [{ value: "a1", label: "Alpha one" }] }, status: "live" },
      expect: { visible: false },
    },
  ],
  derived_select: { exempt: "v2 only (`x-optionsFrom`); a v3 form sends the same choices as a dependent_select" },
  unsupported: [
    { key: "numberOptional", states: ["skipped"], label: "Number, optional", schema: { type: "number" }, expect: { visible: true } },
    { key: "numberRequired", states: ["blocking"], label: "Number, required", schema: { type: "number" }, required: true, expect: { visible: true, error: "unsupported_required" } },
  ],
};

/**
 * The kind x state matrix: for each kind, the states its own rows must show
 * (`required`), and every other state with why it does not apply to that kind
 * (`notApplicable`). The test checks the matrix is complete (each state is in
 * exactly one of the two for every kind) and that the kind's rows claim every
 * required state, so a row deleted from one kind is caught even when another
 * kind still shows that state.
 */
export type KitchenSinkKindStates = {
  required: readonly KitchenSinkState[];
  notApplicable: Partial<Record<KitchenSinkState, string>>;
};

const VALUE_STATES = ["empty", "filled", "required_missing"] as const satisfies readonly KitchenSinkState[];
const SOURCE_STATES = [
  "choice_labels", "source_live", "source_fallback", "source_stale", "source_unavailable", "source_retrying",
  "source_unavailable_hidden", "option_unavailable", "not_a_choice",
] as const satisfies readonly KitchenSinkState[];
const DEPENDENT_STATES = ["list_only", "combobox", "free_text", "no_key_hidden"] as const satisfies readonly KitchenSinkState[];
const RULE_STATES = ["shown_by_rule", "hidden_by_rule", "required_by_rule"] as const satisfies readonly KitchenSinkState[];
const UNSUPPORTED_STATES = ["skipped", "blocking"] as const satisfies readonly KitchenSinkState[];

const because = (states: readonly KitchenSinkState[], reason: string): Partial<Record<KitchenSinkState, string>> =>
  Object.fromEntries(states.map((state) => [state, reason]));

const NO_SOURCE = "the kind has no option source";
const DEPENDENT_ONLY = "dependent_select only: the list is keyed by a parent field's value";
const UNSUPPORTED_ONLY = "the unsupported kind only: every other kind has a control";
const NO_FORMAT = "only a URL has a format check (invalid_url)";
const NO_CUSTOM = "only an option source can accept a typed value";
const RULES_ELSEWHERE = "rules and conditional required are evaluated by one kind-independent evaluator (v3Rules) and only toggle the field's visibility or required mark; their rows are text";
const ADVANCED_ELSEWHERE = "the Advanced group draws each field with its normal control; text and string_map rows sit in it";
const NEVER_REQUIRED = "validateRuntimeFormV2 never reports required for this kind: a switch is always true or false, a key/value map may be empty";

export const KITCHEN_SINK_KIND_STATES: { [K in RuntimeFormV2FieldKind]: KitchenSinkKindStates | KitchenSinkExemption } = {
  text: {
    required: [...VALUE_STATES, ...RULE_STATES, "advanced"],
    notApplicable: { invalid: NO_FORMAT, custom_value: NO_CUSTOM, ...because(SOURCE_STATES, NO_SOURCE), ...because(DEPENDENT_STATES, DEPENDENT_ONLY), ...because(UNSUPPORTED_STATES, UNSUPPORTED_ONLY) },
  },
  secret: {
    required: VALUE_STATES,
    notApplicable: { invalid: NO_FORMAT, advanced: ADVANCED_ELSEWHERE, custom_value: NO_CUSTOM, ...because(RULE_STATES, RULES_ELSEWHERE), ...because(SOURCE_STATES, NO_SOURCE), ...because(DEPENDENT_STATES, DEPENDENT_ONLY), ...because(UNSUPPORTED_STATES, UNSUPPORTED_ONLY) },
  },
  url: {
    required: [...VALUE_STATES, "invalid"],
    notApplicable: { advanced: ADVANCED_ELSEWHERE, custom_value: NO_CUSTOM, ...because(RULE_STATES, RULES_ELSEWHERE), ...because(SOURCE_STATES, NO_SOURCE), ...because(DEPENDENT_STATES, DEPENDENT_ONLY), ...because(UNSUPPORTED_STATES, UNSUPPORTED_ONLY) },
  },
  boolean: {
    required: ["empty", "filled"],
    notApplicable: { required_missing: NEVER_REQUIRED, invalid: NO_FORMAT, advanced: ADVANCED_ELSEWHERE, custom_value: NO_CUSTOM, ...because(RULE_STATES, RULES_ELSEWHERE), ...because(SOURCE_STATES, NO_SOURCE), ...because(DEPENDENT_STATES, DEPENDENT_ONLY), ...because(UNSUPPORTED_STATES, UNSUPPORTED_ONLY) },
  },
  string_map: {
    required: ["empty", "filled", "advanced"],
    notApplicable: { required_missing: NEVER_REQUIRED, invalid: NO_FORMAT, custom_value: NO_CUSTOM, ...because(RULE_STATES, RULES_ELSEWHERE), ...because(SOURCE_STATES, NO_SOURCE), ...because(DEPENDENT_STATES, DEPENDENT_ONLY), ...because(UNSUPPORTED_STATES, UNSUPPORTED_ONLY) },
  },
  select: {
    required: [...VALUE_STATES, ...SOURCE_STATES, "custom_value"],
    notApplicable: { invalid: NO_FORMAT, advanced: ADVANCED_ELSEWHERE, ...because(RULE_STATES, RULES_ELSEWHERE), ...because(DEPENDENT_STATES, DEPENDENT_ONLY), ...because(UNSUPPORTED_STATES, UNSUPPORTED_ONLY) },
  },
  dependent_select: {
    required: [...VALUE_STATES, ...DEPENDENT_STATES, "custom_value"],
    notApplicable: {
      invalid: NO_FORMAT,
      advanced: ADVANCED_ELSEWHERE,
      ...because(RULE_STATES, RULES_ELSEWHERE),
      ...because(SOURCE_STATES, "a source's status line, unavailable entries and choice copy are drawn by the same code for both option source kinds (runtimeFormV2SourceStatus, runtimeFormV2Choices); the select rows show them"),
      ...because(UNSUPPORTED_STATES, UNSUPPORTED_ONLY),
    },
  },
  derived_select: KITCHEN_SINK_ROWS.derived_select as KitchenSinkExemption,
  unsupported: {
    required: UNSUPPORTED_STATES,
    notApplicable: because(
      KITCHEN_SINK_STATES.filter((state) => !(UNSUPPORTED_STATES as readonly string[]).includes(state)),
      "an unsupported field has no control: optional is skipped, required shows only the update message",
    ),
  },
};

/** Every row of a page (all pages without one), in form order. */
export function kitchenSinkRows(page?: KitchenSinkPage): Array<KitchenSinkRow & { kind: RuntimeFormV2FieldKind }> {
  const kinds: readonly RuntimeFormV2FieldKind[] = page ? KITCHEN_SINK_PAGES[page] : KITCHEN_SINK_PAGE_NAMES.flatMap((name) => KITCHEN_SINK_PAGES[name]);
  return kinds.flatMap((kind) => {
    const rows = KITCHEN_SINK_ROWS[kind];
    return Array.isArray(rows) ? rows.map((row) => ({ ...row, kind })) : [];
  });
}

const kebab = (value: string) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The option-source fixture name for a form's source: `<runtime>.option-source.<source-id>.v3.json`. */
export function runtimeFormV3SourceFixtureName(runtimeId: string, sourceId: string): string {
  return `${runtimeId}.option-source.${kebab(sourceId)}.v3.json`;
}


export type KitchenSinkCaseState = {
  $comment: string;
  caseId: string;
  /** Set over initialRuntimeFormV2Values(form, sources). */
  values: Record<string, RuntimeFormV2Value>;
  retryingSourceIds: string[];
  showValidationErrors: true;
  editing: false;
  rows: Array<{ key: string; kind: RuntimeFormV2FieldKind; states: KitchenSinkState[]; expect: KitchenSinkRow["expect"] }>;
};

/** One page's generated files. */
export function buildKitchenSink(page: KitchenSinkPage): {
  form: RuntimeFormV2Definition;
  sources: Record<string, RuntimeFormV2OptionSource>;
  state: KitchenSinkCaseState;
} {
  const rows = kitchenSinkRows(page);
  const runtimeId = kitchenSinkRuntimeId(page);
  const HEAD = { protocolVersion: 1, runtimeId, schemaVersion: `${runtimeId}.create.v1` };
  const properties: Record<string, RuntimeFormV2FieldSchema> = {};
  const localization: Record<string, RuntimeFormV2FieldCopy> = {};
  const rules: RuntimeFormV2Rule[] = [];
  const allOf: NonNullable<RuntimeFormV2Definition["dataSchema"]["allOf"]> = [];
  const optionSources: NonNullable<RuntimeFormV2Definition["optionSources"]> = {};
  const sources: Record<string, RuntimeFormV2OptionSource> = {};
  const values: Record<string, RuntimeFormV2Value> = {};
  for (const row of rows) {
    properties[row.key] = { ...row.schema, title: row.label, ...(row.source ? { "x-optionSource": row.key } : {}) };
    localization[row.key] = { label: row.label, ...row.copy };
    if (row.rule) rules.push({ scope: `#/properties/${row.key}`, ...row.rule });
    if (row.requiredWhen) allOf.push({ if: row.requiredWhen, then: { required: [row.key] } });
    if (row.source) {
      const kind = row.kind === "dependent_select" ? "dependent_select" : "select";
      const ref = { sourceId: row.key, kind, pointer: `/${row.key}`, ...(row.dependsOn ? { dependsOn: `/${row.dependsOn}` } : {}) } as const;
      optionSources[row.key] = { ...HEAD, ...ref } as typeof optionSources[string];
      sources[row.key] = { ...HEAD, ...ref, ...row.source } as RuntimeFormV2OptionSource;
    }
    if (row.value !== undefined) values[row.key] = row.value;
  }
  const form = {
    protocolVersion: 3,
    runtimeId,
    schemaVersion: HEAD.schemaVersion,
    dataSchema: {
      type: "object",
      additionalProperties: false,
      required: rows.filter((row) => row.required).map((row) => row.key),
      properties,
      ...(allOf.length > 0 ? { allOf } : {}),
    },
    uiSchema: {
      order: rows.map((row) => row.key),
      layout: { advanced: rows.filter((row) => row.advanced).map((row) => `/${row.key}`) },
      localization,
      rules,
    },
    optionSources,
    revision: "kitchen-sink",
  } as RuntimeFormV2Definition;
  return {
    form,
    sources,
    state: {
      $comment: "Generated by packages/runtime-form/kitchen-sink/generate.ts from src/kitchenSink.ts. Do not edit. A visual case renders the form with these values set over initialRuntimeFormV2Values(form, sources), the listed sources shown as being retried, and validation errors shown.",
      caseId: kitchenSinkCaseId(page),
      values,
      retryingSourceIds: rows.filter((row) => row.retrying).map((row) => row.key),
      showValidationErrors: true,
      editing: false,
      rows: rows.map((row) => ({ key: row.key, kind: row.kind, states: row.states, expect: row.expect })),
    },
  };
}

/** One visual case: a form fixture, a fixture per option source, and (kitchen sink) the case state. */
/**
 * A real create form's case starts at its initial values; these runtimes'
 * cases set values over them so a field drawn only after a choice is in the
 * capture. Codex: Speed shows directly for a model with more than one fast
 * tier (mutually exclusive with Fast mode). Claude: the Custom provider draws
 * its URL, auth and key. Built-in: a gateway provider draws its base URL and
 * image input (the model becomes typed).
 */
export const REAL_FORM_VISUAL_VALUES: Record<string, Record<string, RuntimeFormV2Value>> = {
  codex: { model: "gpt-6.2-astra" },
  claude: { provider: "custom" },
  builtin: { providerId: "openai-compatible", model: "" },
};

/**
 * Fields of a real create form its case leaves hidden, with why. Any other
 * field must be drawn in its case (src/kitchenSink.test.ts), so a new field
 * behind a rule or a model gets a value in REAL_FORM_VISUAL_VALUES or a reason here.
 */
export const REAL_FORM_HIDDEN_FIELDS: Record<string, Record<string, string>> = {
  codex: {
    fastMode: "mutually exclusive with Speed on a model that offers more than one fast tier (gpt-6.2-astra); Fast mode shows for single-tier models",
    reasoningEffort: "the model with more than one fast tier (gpt-6.2-astra, the server fixture's tiered probe) lists no reasoning efforts, so Reasoning hides; the other runtimes' cases draw a reasoning field",
  },
  "kimi-sdk": {
    reasoningEffort: "the bundled fallback list (the Computer's probe reports missing config) has one model and no efforts, so the effort source has no key",
  },
  pi: {
    apiKey: "the DeepSeek provider's fields: one provider branch per case, and the form starts on Configured",
    providerModel: "the DeepSeek provider's fields: one provider branch per case, and the form starts on Configured",
    providerReasoningEffort: "the DeepSeek provider's fields: one provider branch per case, and the form starts on Configured",
  },
};

/** `<runtime>.visual-state.v3.json`: the values a real create form's case sets. */
export const realFormVisualStateFile = (runtimeId: string) => `${runtimeId}.visual-state.v3.json`;

/** A real create form's case state (as kitchen-sink state, without rows). */
export function realFormVisualState(runtimeId: string) {
  const values = REAL_FORM_VISUAL_VALUES[runtimeId];
  return values
    ? {
      $comment: "Generated by packages/runtime-form/kitchen-sink/generate.ts from REAL_FORM_VISUAL_VALUES in src/kitchenSink.ts. Do not edit. Values the visual case sets over initialRuntimeFormV2Values(form, sources).",
      caseId: `components.runtime-form.create.${runtimeId}`,
      values,
      retryingSourceIds: [],
      showValidationErrors: false,
      editing: false,
    }
    : null;
}

export type RuntimeFormVisualCase = {
  caseId: string;
  runtimeId: string;
  form: string;
  sources: Record<string, string>;
  state?: string;
};

export const RUNTIME_FORM_VISUAL_CASES_FILE = "visual-cases.v3.json";

/** Create forms whose shape the server no longer sends (saved provider connections are retired). */
const RETIRED_FORMS = new Set(["builtin.form.saved-connections.v3.json"]);

/**
 * The visual cases: the kitchen sink pages, then every server-produced v3 create
 * form (`<runtime>.form.v3.json`) with its option sources
 * (`<runtime>.option-source.<source-id>.v3.json`, from
 * packages/server/src/services/runtimeFormV3Fixtures.test.ts). Throws when a
 * form names a source with no fixture.
 */
export function buildRuntimeFormVisualCases(
  fixtureNames: readonly string[],
  readFixture: (name: string) => unknown,
): RuntimeFormVisualCase[] {
  const names = new Set(fixtureNames);
  const cases: RuntimeFormVisualCase[] = KITCHEN_SINK_PAGE_NAMES.map((page) => ({
    caseId: kitchenSinkCaseId(page),
    runtimeId: kitchenSinkRuntimeId(page),
    form: kitchenSinkFormFile(page),
    sources: Object.fromEntries(Object.keys(buildKitchenSink(page).sources).map((id) => [id, runtimeFormV3SourceFixtureName(kitchenSinkRuntimeId(page), id)])),
    state: kitchenSinkStateFile(page),
  }));
  const forms = [...names].filter((name) => /^[a-z0-9-]+\.form\.v3\.json$/.test(name) && !name.startsWith("kitchen-sink") && !RETIRED_FORMS.has(name)).sort();
  for (const name of forms) {
    const form = readFixture(name) as RuntimeFormV2Definition;
    const sources: Record<string, string> = {};
    for (const sourceId of Object.keys(form.optionSources ?? {})) {
      const file = runtimeFormV3SourceFixtureName(form.runtimeId, sourceId);
      if (!names.has(file)) {
        throw new Error(`${name}: option source "${sourceId}" has no fixture ${file} (add it to packages/server/src/services/runtimeFormV3Fixtures.test.ts)`);
      }
      sources[sourceId] = file;
    }
    cases.push({
      caseId: `components.runtime-form.create.${form.runtimeId}`,
      runtimeId: form.runtimeId,
      form: name,
      sources,
      ...(REAL_FORM_VISUAL_VALUES[form.runtimeId] ? { state: realFormVisualStateFile(form.runtimeId) } : {}),
    });
  }
  return cases;
}
