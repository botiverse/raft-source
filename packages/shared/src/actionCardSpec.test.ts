import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_CARD_FORM_ISSUE_CODES, ACTION_CARD_FORM_ISSUE_MESSAGES, ACTION_CARD_OPEN_IN_WEB_LABEL, ACTION_CARD_SPEC_CAPABILITIES, ACTION_CARD_SPEC_FIELD_CAPABILITIES,
  ACTION_CARD_SPEC_FIELD_TYPES, ACTION_CARD_SPEC_ICONS, ACTION_CARD_SPEC_INTENTS, ACTION_CARD_SPEC_LIMITS, ACTION_CARD_SPEC_RESULT_INTENTS, actionCardFormIssue, actionCardRawText, actionCardSpecIssues,
  checkActionCardFormValues, parseActionCardSpec, pickActionCardTemplate, renderActionCardMsg, stripActionCardSpec, type ActionCardSpecMsg, type ActionCardSpecReadCard,
} from "./actionCardSpec";
import { buildActionCardPresentation } from "./actionCards";
import {
  cardDurationElement, cardDurationElementSchema, cardRelativeTimeElement, cardRelativeTimeElementSchema, cardStackElement, cardStackElementSchema, checkBoundedTree,
} from "./cardElements";
import { DISPLAY_LOCALES } from "./displayLocales";

const here = dirname(fileURLToPath(import.meta.url));
const vectorBytes = readFileSync(join(here, "actionCard.v1.vector.json"));
type CardVector = { name: string; note: string; card: unknown; emit: "accept" | "reject"; read: "accept" | "reject"; parsed?: unknown; strip?: Record<string, unknown> };
const vectors = JSON.parse(vectorBytes.toString("utf8")) as {
  contract: string;
  schemaVersion: number;
  capabilitySets: Record<string, string[]>;
  cards: CardVector[];
  formValues: { name: string; form: unknown; values: unknown; client: unknown[]; server: unknown[] }[];
  messages: { name: string; msg: ActionCardSpecMsg; locale: string; segments: unknown[] }[];
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const msg = (en: string, key = "actionCard.test.msg"): ActionCardSpecMsg => ({ key, text: { en } });
const card = (elements: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  catalog: "action-card.v1",
  title: msg("Test"),
  spec: { root: "root", elements: { root: { type: "Stack", props: {}, children: Object.keys(elements) }, ...elements } },
  ...extra,
});
const read = (raw: unknown): ActionCardSpecReadCard => {
  const parsed = parseActionCardSpec(raw, { mode: "read" });
  assert.ok(parsed.ok, JSON.stringify(actionCardSpecIssues(raw, { mode: "read" })));
  return parsed.card;
};

// Why each rejected vector is rejected (TypeScript's issue messages; the
// Kotlin App only compares verdicts). A vector rejected for another reason
// would still pass on verdicts alone.
const REJECT_REASONS: Record<string, string> = {
  read_unknown_action_kind: "Invalid input",
  read_unknown_intent: "Invalid input",
  read_unknown_field_type: "Invalid discriminator value",
  read_unknown_envelope_key: "Unrecognized key",
  read_unknown_icon: "Invalid option",
  read_unknown_locale: "Unrecognized key",
  read_oversized_card: "bytes",
  limit_elements_25: "At most 24 elements",
  limit_depth_5: "one bounded tree",
  limit_children_13: "Too big",
  limit_buttons_3: "At most 2 buttons",
  two_execute_buttons: "At most one execute button",
  two_primary_buttons: "At most one primary",
  destructive_plain_execute: "can be destructive",
  destructive_navigate: "can be destructive",
  unknown_emphasis: "Invalid option",
  button_variant_prop: "Unrecognized key",
  confirm_elements_13: "At most 12 elements",
  confirm_with_button: "no buttons",
  result_with_execute: "only navigate",
  result_with_open: "only navigate",
  spec_open_feedback_ticket: "opens only from a result",
  result_open_other_intent: "only navigate",
  read_unknown_intent_in_result: "Invalid input",
  limit_forms_3: "At most 2 entries",
  limit_confirms_3: "At most 2 entries",
  limit_fields_13: "Too big",
  form_no_fields: "Too small",
  limit_options_33: "Too big",
  select_duplicate_option: "Option values must be unique",
  select_default_not_option: "The default must be an option",
  select_option_value_pattern: "Invalid string",
  limit_params_9: "At most 8 entries",
  badge_61_emoji: "Expected 1-60 characters",
  badge_empty: "Expected 1-60 characters",
  title_81: "Expected 1-80 characters",
  text_2001: "Expected 1-2000 characters",
  param_string_501: "Expected 0-500 characters",
  param_unsafe_integer: "Too big",
  param_float: "Invalid input",
  param_boolean: "Invalid input",
  param_name_pattern: "Invalid key",
  param_reserved_name: "Invalid key in record",
  msg_key_seven_segments: "Invalid string",
  msg_key_long_segment: "Invalid string",
  msg_key_prefix: "Invalid string",
  msg_key_no_segment: "Invalid string",
  msg_key_colon: "Invalid string",
  msg_no_en: "Invalid input",
  msg_empty_en: "Expected 1-500 characters",
  msg_values_fallback_gone: "Unrecognized key",
  msg_lone_open_brace: "placeholders",
  msg_lone_close_brace: "placeholders",
  msg_bad_placeholder: "placeholders",
  msg_three_braces: "placeholders",
  msg_missing_param: "No param for {name}",
  msg_missing_param_zh: "No param for {who}",
  msg_bad_locale_key: "Unknown locale key",
  msg_zh_too_long: "Expected 1-500 characters",
  entity_uuid_uppercase: "lowercase UUID",
  entity_server_id_uppercase: "lowercase UUID",
  entity_unknown_kind: "Invalid option",
  field_value_empty_refs: "Too small",
  navigate_message_needs_channel: "Invalid input",
  navigate_target_and_url: "Invalid input",
  navigate_url_http: "Expected a public HTTPS URL",
  navigate_url_credentials: "Expected a public HTTPS URL",
  navigate_url_fragment: "Expected a public HTTPS URL",
  navigate_url_port: "Expected a public HTTPS URL",
  navigate_url_ip: "Expected a public HTTPS URL",
  navigate_url_single_label: "Expected a public HTTPS URL",
  navigate_url_relative: "Expected a public HTTPS URL",
  forbidden_id_constructor: "reserved ID",
  forbidden_id_prototype: "reserved ID",
  forbidden_id_proto: "Reserved key",
  element_id_pattern: "Invalid string",
  tree_cycle: "one bounded tree",
  tree_unreachable: "one bounded tree",
  tree_reused_node: "one bounded tree",
  tree_missing_child: "one bounded tree",
  tree_missing_root: "one bounded tree",
  children_on_text: "Only a Stack has children",
  stack_column_wrap: "Only a row can wrap",
  unknown_element_type: "Invalid discriminator value",
  input_element: "Invalid discriminator value",
  unknown_element_prop: "Unrecognized key",
  expression_in_text: "Invalid input",
  text_clamp_7: "Too big",
  scopes_duplicate: "Scopes must be unique",
  scopes_65: "Too big",
  field_clamp_0: "Too small",
  field_clamp_7: "Too big",
  groups_33: "Too big",
  groups_duplicate: "Groups must be unique",
  groups_bad_id: "Invalid string",
  groups_empty: "Too small",
  groups_without_scopes: "Invalid input",
  duration_backwards: "cannot end before",
  relative_time_not_utc: "RFC 3339",
  catalog_v2: "Invalid input",
  catalog_missing: "Invalid input",
  title_plain_string: "Invalid input",
  icon_not_string: "Invalid",
  open_web_input: "Invalid input",
  unsupported_input: "Invalid input",
  unknown_kind_bad_pattern: "Invalid input",
  action_not_object: "Invalid input",
  execute_unknown_prop: "Unrecognized key",
  open_known_intent_bad_gate: "Only upgrade_dialog takes a gate",
  open_gate_pattern: "must match pattern",
  missing_form_reference: "No form \"a\"",
  missing_confirm_reference: "No confirm \"c\"",
  form_id_pattern: "Invalid key in record",
  form_id_reserved: "Reserved name",
  toggle_required: "Unrecognized key",
  field_help_renamed: "Unrecognized key",
  field_unknown_prop: "Unrecognized key",
  field_name_pattern: "Invalid",
  field_name_reserved: "Reserved name",
  field_names_unique: "Field names must be unique",
  unknown_field_same_name: "Field names must be unique",
  unknown_field_bad_name: "Invalid discriminator value",
  unknown_field_type_pattern: "Invalid discriminator value",
  text_input_default_too_long: "longer than maxLength",
  text_input_max_501: "Too big",
  text_area_rows_11: "Too big",
  picker_single_max_2: "A single picker takes one item",
  picker_default_kind_mismatch: "does not fit the picker",
  channel_picker_default_user: "does not fit the picker",
  agent_picker_default_computer: "does not fit the picker",
  picker_default_too_many: "More defaults",
  picker_single_two_defaults: "More defaults",
  picker_default_duplicate: "Defaults must be unique",
  picker_kinds_order: "Invalid input",
  picker_max_51: "Too big",
  picker_missing_multiple: "Invalid input",
  limit_title_81: "Expected 1-80 characters",
  limit_button_label_25: "Expected 1-24 characters",
  limit_disabled_reason_201: "Expected 1-200 characters",
  limit_field_label_41: "Expected 1-40 characters",
  limit_confirm_title_81: "Expected 1-80 characters",
  limit_confirm_label_25: "Expected 1-24 characters",
  limit_form_title_81: "Expected 1-80 characters",
  limit_submit_label_25: "Expected 1-24 characters",
  limit_form_field_label_41: "Expected 1-40 characters",
  limit_placeholder_121: "Expected 1-120 characters",
  limit_field_description_301: "Expected 1-300 characters",
  limit_option_label_41: "Expected 1-40 characters",
  limit_empty_text_121: "Expected 1-120 characters",
  read_drops_text_prop: "Unrecognized key",
  read_drops_field_prop: "Unrecognized key",
  read_drops_scope_list_prop: "Unrecognized key",
  read_drops_stack_prop: "Unrecognized key",
  read_drops_element_key: "Unrecognized key",
  read_drops_display_props: "Unrecognized key",
  read_drops_msg_key: "Unrecognized key",
  read_drops_entity_ref_key: "Unrecognized key",
  read_drops_entity_ref_param_key: "Unrecognized key",
  read_drops_picker_default_key: "Unrecognized key",
  read_drops_select_option_key: "Unrecognized key",
  read_drops_form_field_prop: "Unrecognized key",
  read_drops_form_key: "Unrecognized key",
  read_drops_tree_key: "Unrecognized key",
  read_drops_navigate_target_key: "Unrecognized key",
  read_drops_but_checks_known: "Too big",
  read_unknown_prop_execute: "Unrecognized key",
  read_unknown_prop_open_form: "Unrecognized key",
  read_unknown_prop_open: "Unrecognized key",
  read_unknown_prop_navigate: "Unrecognized key",
  read_unknown_prop_unknown_intent: "Unrecognized key",
  read_unknown_prop_marker_rules: "Unrecognized key",
  read_unknown_prop_bad_confirm_id: "must match pattern",
  read_unknown_prop_gate_on_other_intent: "Only upgrade_dialog takes a gate",
  read_unknown_prop_bad_url: "Expected a public HTTPS URL",
  read_unknown_prop_target_and_url: "Unrecognized key: \"url\"",
  read_unknown_prop_missing_form: "expected string, received undefined",
  read_unknown_prop_button: "Unrecognized key",
  read_unknown_prop_button_kinds: "Unrecognized key",
  read_unknown_prop_button_bad_label: "expected object, received string",
  read_unknown_prop_confirm: "Unrecognized key",
  read_unknown_prop_confirm_unreferenced: "Unrecognized key",
  read_unknown_prop_confirm_bad_spec: "no buttons",
  read_unknown_prop_confirm_two_executes: "At most one execute button",
  read_unknown_prop_spec_feedback_ticket: "Unrecognized key",
  stack_role_unknown: "Invalid option",
  stack_role_wrong_direction: "A reason Stack is a column and an actions Stack a row",
  form_submit_labels_not_select: "submitLabels name a Select of the form and its options",
  form_submit_labels_unknown_option: "submitLabels name a Select of the form and its options",
  question_card_older_reader: "Invalid discriminator value",
  choice_options_33: "Too big",
  choice_reserved_other_value: "is reserved for the Other text",
  choice_duplicate_values: "Option values must be unique",
  choice_single_with_max_items: "Only a multiple Choice takes minItems and maxItems",
  choice_min_over_max: "minItems is more than maxItems",
  choice_max_over_items: "maxItems is more than the Choice offers",
  choice_default_not_option: "The default selects options of the Choice",
  choice_default_other_without_other: "The default's other needs the Choice's Other",
  choice_default_too_many: "The default chooses more than the Choice takes",
  choice_other_max_length_501: "Too big",
  read_drops_choice_keys: "Unrecognized key",
  form_steps_11: "Too big",
  form_steps_one: "Too small",
  form_steps_missing_field: "Steps name every field of the form exactly once",
  form_steps_duplicate_field: "Steps name every field of the form exactly once",
  form_steps_unknown_field: "Steps name every field of the form exactly once",
  raw_text_501: "Expected 0-500 characters",
};

test("the vector file matches its recorded SHA-256 (the Kotlin App pins it)", () => {
  const recorded = readFileSync(join(here, "actionCard.v1.vector.sha256"), "utf8").trim().split(/\s+/);
  assert.equal(recorded[1], "actionCard.v1.vector.json");
  assert.equal(createHash("sha256").update(vectorBytes).digest("hex"), recorded[0],
    "actionCard.v1.vector.json changed: re-record with `shasum -a 256 actionCard.v1.vector.json > actionCard.v1.vector.sha256` in packages/shared/src and tell the App owner (Lagoon) to re-sync.");
  assert.equal(vectors.contract, "action-card.v1");
  assert.equal(vectors.schemaVersion, 9);
  assert.deepEqual(vectors.capabilitySets.all, [...ACTION_CARD_SPEC_CAPABILITIES]);
});

test("card vectors: verdicts in both modes, the read-parsed card and every strip output", () => {
  const names = new Set<string>();
  for (const vector of vectors.cards) {
    assert.ok(!names.has(vector.name), `duplicate vector ${vector.name}`);
    names.add(vector.name);
    const emit = parseActionCardSpec(clone(vector.card), { mode: "emit" });
    const readResult = parseActionCardSpec(clone(vector.card), { mode: "read" });
    assert.equal(emit.ok ? "accept" : "reject", vector.emit, `${vector.name} (emit): ${JSON.stringify(actionCardSpecIssues(vector.card, { mode: "emit" }))}`);
    assert.equal(readResult.ok ? "accept" : "reject", vector.read, `${vector.name} (read): ${JSON.stringify(actionCardSpecIssues(vector.card, { mode: "read" }))}`);
    if (readResult.ok) {
      assert.deepEqual(readResult.card, vector.parsed, `${vector.name}: parsed`);
      if (emit.ok) assert.deepEqual(emit.card, vector.parsed, `${vector.name}: an emitted card reads back the same`);
      for (const [set, expected] of Object.entries(vector.strip ?? {})) {
        const capabilities = vectors.capabilitySets[set];
        assert.ok(capabilities, `${vector.name}: unknown capability set ${set}`);
        assert.deepEqual(stripActionCardSpec(readResult.card, capabilities), expected, `${vector.name}: strip ${set}`);
      }
    } else {
      assert.equal(vector.parsed, undefined, vector.name);
    }
    if (vector.emit === "reject" || vector.read === "reject") {
      const reason = REJECT_REASONS[vector.name];
      assert.ok(reason, `${vector.name}: add the reason it is rejected to REJECT_REASONS`);
      const issues = actionCardSpecIssues(clone(vector.card), { mode: vector.read === "reject" ? "read" : "emit" });
      assert.ok(issues.some((issue) => issue.message.includes(reason)), `${vector.name}: expected "${reason}" in ${JSON.stringify(issues)}`);
    }
  }
  assert.deepEqual(Object.keys(REJECT_REASONS).filter((name) => !names.has(name)), [], "reasons for vectors that no longer exist");
});

test("form value vectors: exact client and server issues", () => {
  for (const vector of vectors.formValues) {
    const parsed = read({ catalog: "action-card.v1", title: msg("Form"), spec: { root: "b", elements: {
      b: { type: "Button", props: { label: msg("Open"), action: { kind: "open_form", form: "f" } } },
    } }, forms: { f: vector.form } });
    const form = parsed.forms!.f!;
    assert.deepEqual(checkActionCardFormValues(form, clone(vector.values), { mode: "client" }), vector.client, `${vector.name}: client`);
    assert.deepEqual(checkActionCardFormValues(form, clone(vector.values), { mode: "server" }), vector.server, `${vector.name}: server`);
  }
});

test("message vectors: each Msg is valid and renders to its segments", () => {
  for (const vector of vectors.messages) {
    assert.ok(parseActionCardSpec({ ...card({ t: { type: "Text", props: { text: "x" } } }), title: vector.msg }, { mode: "emit" }).ok, vector.name);
    assert.deepEqual(renderActionCardMsg(vector.msg, vector.locale), vector.segments, vector.name);
  }
});

test("keepParams: each string or number param is its own segment, marked; the text joined is the same", () => {
  const msg: ActionCardSpecMsg = {
    key: "actionCard.result.channelMembers.other",
    text: { en: "{count} added to #{channel}" },
    params: { count: 2, channel: "launch-week" },
  };
  assert.deepEqual(renderActionCardMsg(msg, "en", { keepParams: true }), [
    { text: "2", param: true }, { text: " added to #" }, { text: "launch-week", param: true },
  ]);
  assert.deepEqual(renderActionCardMsg(msg, "en"), [{ text: "2 added to #launch-week" }]);
  for (const vector of vectors.messages) {
    const kept = renderActionCardMsg(vector.msg, vector.locale, { keepParams: true });
    const joined = kept.map((segment) => ("text" in segment ? segment.text : `<${segment.ref.id}>`)).join("");
    const merged = (vector.segments as { text?: string; ref?: { id: string } }[]).map((segment) => segment.text ?? `<${segment.ref!.id}>`).join("");
    assert.equal(joined, merged, vector.name);
  }
});

test("the vectors cover every limit at the boundary and one past it", () => {
  const verdict = new Map(vectors.cards.map((vector) => [vector.name, vector.emit]));
  const pairs = [
    ["limit_elements_24", "limit_elements_25"], ["limit_depth_4", "limit_depth_5"], ["limit_children_12", "limit_children_13"],
    ["limit_buttons_2", "limit_buttons_3"], ["confirm_elements_12", "confirm_elements_13"], ["limit_forms_2", "limit_forms_3"],
    ["limit_fields_12", "limit_fields_13"], ["limit_options_32", "limit_options_33"], ["limit_params_8", "limit_params_9"],
    ["badge_60_emoji", "badge_61_emoji"], ["title_80_cjk_emoji", "title_81"], ["text_2000", "text_2001"], ["param_string_500", "param_string_501"],
    ["param_safe_integer", "param_unsafe_integer"], ["msg_key_six_segments", "msg_key_seven_segments"], ["picker_single_max_1", "picker_single_max_2"],
    ["text_input_default_emoji", "text_input_default_too_long"], ["all_lengths_at_limit", "limit_title_81"], ["all_lengths_at_limit", "limit_button_label_25"],
    ["all_lengths_at_limit", "limit_field_label_41"], ["all_lengths_at_limit", "limit_confirm_title_81"], ["all_lengths_at_limit", "limit_confirm_label_25"],
    ["all_lengths_at_limit", "limit_form_title_81"], ["all_lengths_at_limit", "limit_submit_label_25"], ["all_lengths_at_limit", "limit_form_field_label_41"],
    ["all_lengths_at_limit", "limit_placeholder_121"], ["all_lengths_at_limit", "limit_option_label_41"], ["all_lengths_at_limit", "limit_empty_text_121"],
    ["field_clamp_6", "field_clamp_7"], ["groups_32", "groups_33"], ["choice_options_32", "choice_options_33"], ["form_steps_10", "form_steps_11"],
  ];
  for (const [ok, past] of pairs) {
    assert.equal(verdict.get(ok!), "accept", ok);
    assert.equal(verdict.get(past!), "reject", past);
  }
});

test("capabilities, field capabilities, icons and limits are the documented ones", () => {
  assert.deepEqual([...ACTION_CARD_SPEC_CAPABILITIES], ["card.v1", "confirm.v1", "form.v1", "field.text_input", "field.text_area", "field.select",
    "field.toggle", "field.member_picker", "field.channel_picker", "field.agent_picker", "field.choice", "intent.create_channel", "intent.add_members",
    "intent.create_agent", "intent.feedback_form", "intent.upgrade_dialog", "intent.feedback_ticket", "intent.add_seats", "intent.migrate_agent"]);
  assert.equal(ACTION_CARD_SPEC_FIELD_CAPABILITIES.Choice, "field.choice");
  for (const type of ACTION_CARD_SPEC_FIELD_TYPES) assert.ok(ACTION_CARD_SPEC_CAPABILITIES.includes(ACTION_CARD_SPEC_FIELD_CAPABILITIES[type]), type);
  assert.deepEqual([...ACTION_CARD_SPEC_ICONS], ["hash", "bot", "user_plus", "key", "app", "package", "plug", "message", "sparkles", "shield", "credit_card"]);
  assert.deepEqual(ACTION_CARD_SPEC_LIMITS, { maxElements: 24, maxConfirmElements: 12, maxDepth: 4, maxButtons: 2, maxConfirms: 2, maxForms: 2,
    maxFields: 12, maxOptions: 32, maxParams: 8, maxPickerItems: 50, maxBytes: 24576 });
});

test("the 24 KiB limit: emit only, on the parsed card's JSON as UTF-8, exact at the boundary", () => {
  const sized = (last: string) => card({
    ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`t${i}`, { type: "Text", props: { text: "x".repeat(2000) } }])),
    last: { type: "Text", props: { text: last } },
  });
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const fill = ACTION_CARD_SPEC_LIMITS.maxBytes - bytes(read(sized("x"))) + 1;
  assert.ok(fill > 2 && fill <= 2000, String(fill));
  const atLimit = sized("x".repeat(fill));
  assert.equal(bytes(read(atLimit)), ACTION_CARD_SPEC_LIMITS.maxBytes);
  assert.ok(parseActionCardSpec(atLimit, { mode: "emit" }).ok, JSON.stringify(actionCardSpecIssues(atLimit, { mode: "emit" })));
  assert.ok(bytes(atLimit) < ACTION_CARD_SPEC_LIMITS.maxBytes, "measured on the parsed card: filled-in defaults count");
  // "é" is one code point and two UTF-8 bytes.
  const over = sized("x".repeat(fill - 1) + "é");
  assert.equal(bytes(read(over)), ACTION_CARD_SPEC_LIMITS.maxBytes + 1);
  assert.deepEqual(parseActionCardSpec(over, { mode: "emit" }), { ok: false });
  assert.deepEqual(actionCardSpecIssues(over, { mode: "emit" }), [{ path: [], message: "The card is 24577 bytes, over 24576" }]);
  assert.ok(parseActionCardSpec(over, { mode: "read" }).ok, "clients do not measure");
});

test("parsing never throws: garbage, cycles and prototype keys are just invalid", () => {
  const cyclic: Record<string, unknown> = { catalog: "action-card.v1" };
  cyclic.self = cyclic;
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let i = 0; i < 2000; i++) cursor = (cursor.next = {}) as Record<string, unknown>;
  [null, undefined, 0, "card", [], [card({})], cyclic, deep, Object.create(null), { ...card({}), spec: cyclic }].forEach((raw, i) => {
    for (const mode of ["emit", "read"] as const) assert.deepEqual(parseActionCardSpec(raw, { mode }), { ok: false }, `${mode}: input ${i}`);
  });
  const proto = JSON.parse('{"catalog":"action-card.v1","title":{"key":"actionCard.x","text":{"en":"x"},"params":{"__proto__":"x"}},"spec":{"root":"t","elements":{"t":{"type":"Text","props":{"text":"x"}}}}}');
  assert.equal(parseActionCardSpec(proto, { mode: "read" }).ok, false, "zod would drop a __proto__ param silently; Kotlin keeps it, so it is refused");
  const protoForm = JSON.parse('{"catalog":"action-card.v1","title":{"key":"actionCard.x","text":{"en":"x"}},"spec":{"root":"t","elements":{"t":{"type":"Text","props":{"text":"x"}}}},"forms":{"__proto__":{}}}');
  assert.equal(parseActionCardSpec(protoForm, { mode: "read" }).ok, false);
  const protoEnvelope = JSON.parse('{"catalog":"action-card.v1","__proto__":{"x":1},"title":{"key":"actionCard.x","text":{"en":"x"}},"spec":{"root":"t","elements":{"t":{"type":"Text","props":{"text":"x"}}}}}');
  assert.equal(parseActionCardSpec(protoEnvelope, { mode: "emit" }).ok, false, "an unknown envelope key, emit");
  assert.equal(parseActionCardSpec(protoEnvelope, { mode: "read" }).ok, true, "an unknown envelope key, dropped on read");
  // On an object with fixed keys a raw __proto__ is an unknown key like any other: dropped (no prototype change), or on an action, unsupported.
  const protoKeys = JSON.parse('{"catalog":"action-card.v1","title":{"key":"actionCard.x","text":{"en":"x"}},"spec":{"root":"r","elements":{"r":{"type":"Stack","props":{},"children":["t","b"]},'
    + '"t":{"type":"Text","props":{"text":"x","__proto__":{"polluted":1}}},"b":{"type":"Button","props":{"label":{"key":"actionCard.b","text":{"en":"Go"}},"action":{"kind":"execute","__proto__":{"confirm":"c"}}}}}}}');
  assert.equal(parseActionCardSpec(protoKeys, { mode: "emit" }).ok, false);
  const protoRead = read(protoKeys);
  assert.deepEqual(protoRead.spec.elements.t, { type: "Text", props: { text: "x", tone: "default", mono: false } });
  assert.equal(Object.getPrototypeOf(protoRead.spec.elements.t!.props), Object.prototype);
  assert.deepEqual((protoRead.spec.elements.b as { props: { action: unknown } }).props.action, { kind: "unsupported", originalKind: "execute" });
  // Where a key could change a press, a raw __proto__ fails safe too: on the Button's props, and on the confirm it opens.
  const protoPress = JSON.parse('{"catalog":"action-card.v1","title":{"key":"actionCard.x","text":{"en":"x"}},"spec":{"root":"r","elements":{"r":{"type":"Stack","props":{},"children":["a","b"]},'
    + '"a":{"type":"Button","props":{"label":{"key":"actionCard.a","text":{"en":"A"}},"action":{"kind":"navigate","url":"https://example.com/"},"__proto__":{"emphasis":"primary"}}},'
    + '"b":{"type":"Button","props":{"label":{"key":"actionCard.b","text":{"en":"B"}},"action":{"kind":"execute","confirm":"c"}}}}},'
    + '"confirms":{"c":{"title":{"key":"actionCard.c","text":{"en":"Sure?"}},"confirmLabel":{"key":"actionCard.y","text":{"en":"Yes"}},"spec":{"root":"t","elements":{"t":{"type":"Text","props":{"text":"x"}}}},"__proto__":{"x":1}}}}');
  assert.equal(parseActionCardSpec(protoPress, { mode: "emit" }).ok, false);
  const pressRead = read(protoPress);
  const actionOf = (id: string) => (pressRead.spec.elements[id] as { props: { action: unknown } }).props.action;
  assert.deepEqual(actionOf("a"), { kind: "unsupported", originalKind: "navigate" });
  assert.deepEqual(actionOf("b"), { kind: "unsupported", originalKind: "execute" });
  assert.deepEqual(pressRead.confirms, {}, "the confirm with an unknown key is dropped");
});

test("result intents (S0.3): exactly feedback_ticket opens from a result, never from the body; without its capability it strips to Open in web", () => {
  assert.deepEqual([...ACTION_CARD_SPEC_RESULT_INTENTS], ["feedback_ticket"], "an allowlist of exactly this one, never any open (Tenny)");
  const viewTicket = (intent: string) => ({ type: "Button", props: { label: msg("View in Settings"), action: { kind: "open", intent } } });
  const done = (intent: string) => card({ t: { type: "Text", props: { text: "x" } } }, {
    result: { root: "root", elements: { root: { type: "Stack", props: {}, children: ["summary", "b"] }, summary: { type: "Text", props: { text: "Sent." } }, b: viewTicket(intent) } },
  });
  const inBody = (intent: string) => card({ b: viewTicket(intent) });
  const has = (raw: unknown, mode: "emit" | "read", message: string) => actionCardSpecIssues(raw, { mode }).some((issue) => issue.message === message);
  for (const mode of ["emit", "read"] as const) {
    assert.ok(parseActionCardSpec(done("feedback_ticket"), { mode }).ok, `${mode}: in a result`);
    assert.deepEqual(parseActionCardSpec(inBody("feedback_ticket"), { mode }), { ok: false }, `${mode}: in the body`);
    assert.ok(has(inBody("feedback_ticket"), mode, "feedback_ticket opens only from a result"), mode);
    // Every other intent is still refused in a result (and stays allowed in the body).
    for (const intent of ACTION_CARD_SPEC_INTENTS.filter((each) => each !== "feedback_ticket")) {
      assert.deepEqual(parseActionCardSpec(done(intent), { mode }), { ok: false }, `${mode}: ${intent} in a result`);
      assert.ok(has(done(intent), mode, "Result buttons only navigate or open feedback_ticket"), `${mode}: ${intent}`);
      assert.ok(parseActionCardSpec(inBody(intent), { mode }).ok, `${mode}: ${intent} in the body`);
    }
  }
  const parsed = read(done("feedback_ticket"));
  assert.deepEqual(stripActionCardSpec(parsed, ACTION_CARD_SPEC_CAPABILITIES)!.result, parsed.result, "kept with intent.feedback_ticket");
  const openWeb = { type: "Button", props: { label: ACTION_CARD_OPEN_IN_WEB_LABEL, emphasis: "secondary", action: { kind: "open_web" } } };
  for (const capabilities of [ACTION_CARD_SPEC_CAPABILITIES.filter((capability) => capability !== "intent.feedback_ticket"), ["card.v1"]]) {
    assert.deepEqual(stripActionCardSpec(parsed, capabilities)!.result!.elements.b, openWeb, "an older reader, or the web until it declares the intent");
  }
});

test("strip is pure and never turns execute + confirm into a plain execute", () => {
  const raw = card({
    run: { type: "Button", props: { label: msg("Install"), emphasis: "destructive", action: { kind: "execute", confirm: "c" }, disabledReason: msg("Not yet") } },
  }, { confirms: { c: { title: msg("Sure?"), confirmLabel: msg("Yes"), spec: { root: "t", elements: { t: { type: "Text", props: { text: "x" } } } } } } });
  const parsed = read(raw);
  const frozen = JSON.stringify(parsed);
  const deepFreeze = (value: unknown): void => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(deepFreeze); } };
  deepFreeze(parsed);
  const all = stripActionCardSpec(parsed, ACTION_CARD_SPEC_CAPABILITIES);
  assert.deepEqual(all, parsed);
  assert.notEqual(all, parsed);
  assert.notEqual(all!.spec.elements.run, parsed.spec.elements.run, "a copy, not the input's objects");
  const noConfirm = stripActionCardSpec(parsed, ACTION_CARD_SPEC_CAPABILITIES.filter((capability) => capability !== "confirm.v1"))!;
  assert.deepEqual(noConfirm.spec.elements.run, { type: "Button", props: {
    label: ACTION_CARD_OPEN_IN_WEB_LABEL, emphasis: "secondary", action: { kind: "open_web" }, disabledReason: msg("Not yet"),
  } });
  assert.deepEqual(noConfirm.confirms, parsed.confirms, "confirms are kept");
  assert.equal(stripActionCardSpec(parsed, ["confirm.v1", "form.v1"]), null, "no card.v1");
  assert.equal(JSON.stringify(parsed), frozen);
  (noConfirm.spec.elements.run as { props: { label: { text: { en: string } } } }).props.label.text.en = "changed";
  assert.equal(ACTION_CARD_OPEN_IN_WEB_LABEL.text.en, "Open in web", "the shared label is copied");
});

test("issue messages, the open-in-web label and form issues are valid Msgs in every display locale", () => {
  const locales = (message: ActionCardSpecMsg) => Object.keys(message.text);
  assert.deepEqual(locales(ACTION_CARD_OPEN_IN_WEB_LABEL), [...DISPLAY_LOCALES]);
  for (const code of ACTION_CARD_FORM_ISSUE_CODES) {
    const issue = actionCardFormIssue("name", code, { max: 5, min: 2 });
    assert.equal(issue.message.key, `actionCard.form.issue.${code}`);
    assert.deepEqual(locales(issue.message), [...DISPLAY_LOCALES], code);
    const parsed = parseActionCardSpec({ ...card({ t: { type: "Notice", props: { text: issue.message } } }) }, { mode: "emit" });
    assert.ok(parsed.ok, `${code}: ${JSON.stringify(actionCardSpecIssues(card({ t: { type: "Notice", props: { text: issue.message } } }), { mode: "emit" }))}`);
    assert.ok([...(issue.message.text.en)].length <= 300);
  }
  assert.deepEqual(renderActionCardMsg(actionCardFormIssue("title", "too_long", { max: 80 }).message, "zh-cn"), [{ text: "最多 80 个字符。" }]);
  assert.deepEqual(renderActionCardMsg(actionCardFormIssue("title", "too_long", { max: 80 }).message, "ja"), [{ text: "80 文字以内で入力してください。" }]);
  assert.deepEqual(renderActionCardMsg(actionCardFormIssue("title", "too_long", { max: 80 }).message, "fr"), [{ text: "Use 80 characters or fewer." }]);
  assert.deepEqual(renderActionCardMsg(actionCardFormIssue("pick", "too_few", { min: 2 }).message, "en"), [{ text: "Choose at least 2." }]);
  assert.deepEqual(renderActionCardMsg(actionCardFormIssue("pick", "too_few", { min: 2 }).message, "zh-cn"), [{ text: "至少选择 2 项。" }]);
  assert.equal(ACTION_CARD_FORM_ISSUE_CODES.at(-1), "too_few", "schemaVersion 8 appends too_few; the older codes keep their place");
  assert.equal(ACTION_CARD_FORM_ISSUE_MESSAGES.required.params, undefined);
  assert.ok(parseActionCardSpec(card({ b: { type: "Button", props: { label: ACTION_CARD_OPEN_IN_WEB_LABEL, action: { kind: "execute" } } } }), { mode: "emit" }).ok);
});

test("templates: the locale's own key only, and a placeholder without a param stays as written", () => {
  const hello: ActionCardSpecMsg = { key: "actionCard.x", text: { en: "Hello {name}", "zh-cn": "你好 {name}" }, params: { name: "Ada" } };
  assert.equal(pickActionCardTemplate(hello, "zh-cn"), "你好 {name}");
  for (const locale of ["constructor", "__proto__", "toString", "zh-CN", ""]) assert.equal(pickActionCardTemplate(hello, locale), "Hello {name}", locale);
  assert.deepEqual(renderActionCardMsg({ key: "actionCard.x", text: { en: "Hi {name}, {{ok}}" } }, "en"), [{ text: "Hi {name}, {ok}" }]);
  assert.deepEqual(renderActionCardMsg({ key: "actionCard.x", text: { en: "{a}" }, params: { a: 0 } }, "en"), [{ text: "0" }]);
});

test("the shared elements: strict for link cards and an action-card emit; an action-card read drops unknown keys, but children stays a Stack's", () => {
  const at = { type: "RelativeTime", props: { at: "2026-10-26T03:00:00Z" } };
  const took = { type: "Duration", props: { start: "2026-10-26T02:00:00Z", end: "2026-10-26T02:04:10Z" } };
  const extra = [
    [cardStackElement, cardStackElementSchema, { type: "Stack", props: { gap: 8 }, key: 1 }, { type: "Stack", props: { direction: "column", wrap: false } }],
    [cardRelativeTimeElement, cardRelativeTimeElementSchema, { ...at, props: { ...at.props, format: "short" }, key: 1 }, at],
    [cardDurationElement, cardDurationElementSchema, { ...took, props: { ...took.props, precision: "s" }, key: 1 }, took],
  ] as const;
  for (const [linkCard, schema, raw, dropped] of extra) {
    assert.equal(linkCard.safeParse(raw).success, false, `link card: ${raw.type}`);
    assert.equal(schema("strict").safeParse(raw).success, false, `strict: ${raw.type}`);
    assert.deepEqual(schema("strip").parse(raw), dropped, `strip: ${raw.type}`);
  }
  for (const unknownKeys of ["strict", "strip"] as const) {
    assert.equal(cardRelativeTimeElementSchema(unknownKeys).safeParse({ ...at, children: [] }).success, false, unknownKeys);
    assert.equal(cardDurationElementSchema(unknownKeys).safeParse({ ...took, props: { ...took.props, end: "2026-10-26T01:00:00Z" }, key: 1 }).success, false, `${unknownKeys}: known rules hold`);
  }
});

test("the shared tree check: size, single bounded tree, depth from a root at 0", () => {
  const stack = (...children: string[]) => ({ type: "Stack", children });
  assert.equal(checkBoundedTree({ root: "a", elements: { a: stack("b"), b: { type: "Text" } } }, { maxElements: 2, maxDepth: 1 }), null);
  assert.equal(checkBoundedTree({ root: "a", elements: { a: stack("b"), b: { type: "Text" } } }, { maxElements: 1, maxDepth: 1 }), "size");
  assert.equal(checkBoundedTree({ root: "a", elements: { a: stack("b"), b: { type: "Text" } } }, { maxElements: 2, maxDepth: 0 }), "tree");
  assert.equal(checkBoundedTree({ root: "prototype", elements: { prototype: { type: "Text" } } }, { maxElements: 2, maxDepth: 1 }), "size");
  assert.equal(checkBoundedTree({ root: "a", elements: { a: { type: "Text", children: ["b"] }, b: { type: "Text" } } }, { maxElements: 2, maxDepth: 1 }), "tree",
    "only a Stack's children count");
  assert.equal(checkBoundedTree({ root: "toString", elements: {} }, { maxElements: 2, maxDepth: 1 }), "tree", "own elements only");
});

test("buildActionCardPresentation does not set a card yet (S1 does)", () => {
  const presentation = buildActionCardPresentation({ type: "plan:upgrade", reason: "You hit the upload limit." });
  assert.equal("card" in presentation, false);
});

// ---------------------------------------------------------------------------
// schemaVersion 8: the question card (Choice, steps, too_few, the raw Msg).

const vectorCard = (name: string) => {
  const vector = vectors.cards.find((each) => each.name === name);
  assert.ok(vector, name);
  return clone(vector.card) as Record<string, unknown>;
};
const formOf = (parsed: ActionCardSpecReadCard, id: string) => parsed.forms![id]!;
const buttonAction = (card: { spec: { elements: Record<string, unknown> } }, id: string) => (card.spec.elements[id] as { props: { action: unknown } }).props.action;

test("a question card as the server sends it: emit-valid, no open_web or unsupported, and only a reader with field.choice keeps its form button", () => {
  for (const name of ["question_card", "question_card_answered", "question_card_single_anyone", "question_card_text_only"]) {
    const raw = vectorCard(name);
    const emitted = parseActionCardSpec(raw, { mode: "emit" });
    assert.ok(emitted.ok, `${name}: ${JSON.stringify(actionCardSpecIssues(raw, { mode: "emit" }))}`);
    const json = JSON.stringify(emitted.card);
    assert.equal(json.includes("open_web"), false, `${name}: the server never sends open_web`);
    assert.equal(json.includes("unsupported"), false, `${name}: nor a read marker`);
  }
  const parsed = read(vectorCard("question_card"));
  assert.deepEqual(stripActionCardSpec(parsed, ACTION_CARD_SPEC_CAPABILITIES), parsed);
  const openWeb = { kind: "open_web" };
  const withoutChoice = ACTION_CARD_SPEC_CAPABILITIES.filter((capability) => capability !== "field.choice");
  assert.deepEqual(buttonAction(stripActionCardSpec(parsed, withoutChoice)!, "answer"), openWeb, "no field.choice: Open in web");
  assert.deepEqual(buttonAction(stripActionCardSpec(parsed, ACTION_CARD_SPEC_CAPABILITIES.filter((capability) => capability !== "form.v1"))!, "answer"), openWeb);
  // card_only still reads the card: For, the questions and the reason show, the button opens the web.
  const cardOnly = stripActionCardSpec(parsed, ["card.v1"])!;
  assert.deepEqual(buttonAction(cardOnly, "answer"), openWeb);
  assert.ok(cardOnly.spec.elements.q_window && cardOnly.spec.elements.reason);
  // A card of text questions only: a reader without field.choice can still answer it in place.
  const textOnly = read(vectorCard("question_card_text_only"));
  assert.deepEqual(buttonAction(stripActionCardSpec(textOnly, withoutChoice)!, "answer"), { kind: "open_form", form: "answers" });
});

test("an older reader on a question card: a Choice it does not know is unsupported, steps are dropped, fields stay whole", () => {
  // A reader before schemaVersion 8 reads `Choice` as any unknown field type and `steps` as any unknown
  // form key; this reader does the same with names it does not know either.
  const parsed = read(vectorCard("question_card_older_reader"));
  const form = formOf(parsed, "answers");
  assert.deepEqual(form.fields.map((field) => field.type), ["unsupported", "unsupported", "TextArea"]);
  assert.deepEqual(form.fields.map((field) => field.name), ["window", "envs", "notes"]);
  assert.equal("steps" in form, false);
  assert.equal("futureSteps" in form, false);
  assert.deepEqual(buttonAction(stripActionCardSpec(parsed, ACTION_CARD_SPEC_CAPABILITIES)!, "answer"), { kind: "open_web" });
  // The raw Msgs are ordinary Msgs: they read, and show the agent's text.
  const label = (form.fields[2] as { label: ActionCardSpecMsg }).label;
  assert.deepEqual(renderActionCardMsg(label, "ko"), [{ text: "还有什么要我注意的？" }]);
});

test("actionCardRawText: the agent's text as the only param of a {t} template, 1-500 code points, else a RangeError", () => {
  const fuzz = "{x} {{y}} } {z <b>bold</b>";
  assert.deepEqual(actionCardRawText(fuzz), { key: "actionCard.text.raw", text: { en: "{t}" }, params: { t: fuzz } });
  for (const locale of ["en", "zh-cn", "ja", "fr"]) assert.deepEqual(renderActionCardMsg(actionCardRawText(fuzz), locale), [{ text: fuzz }], locale);
  assert.deepEqual(actionCardRawText("x").params, { t: "x" });
  const astral = "🚀".repeat(500);
  assert.equal(actionCardRawText(astral).params!.t, astral, "500 code points (1000 UTF-16 units) fit");
  for (const bad of ["", "🚀".repeat(501), "x".repeat(501)]) assert.throws(() => actionCardRawText(bad), RangeError, `${[...bad].length} code points`);
  // Valid wherever a Msg goes, a form field's label included (its 40 bounds the template, not the param).
  const raw = card({ b: { type: "Button", props: { label: msg("Open"), action: { kind: "open_form", form: "f" } } } }, { forms: { f: {
    title: actionCardRawText("x".repeat(500)), submitLabel: msg("Send"),
    fields: [{ type: "TextInput", name: "t", label: actionCardRawText(astral), description: actionCardRawText(fuzz), maxLength: 10 }],
  } } });
  assert.ok(parseActionCardSpec(raw, { mode: "emit" }).ok, JSON.stringify(actionCardSpecIssues(raw, { mode: "emit" })));
  // A raw text past 500 is refused by the Msg rules too, so the helper's bound is the protocol's.
  const over = { key: "actionCard.text.raw", text: { en: "{t}" }, params: { t: "x".repeat(501) } };
  assert.equal(parseActionCardSpec({ ...card({ t: { type: "Text", props: { text: "x" } } }), title: over }, { mode: "emit" }).ok, false);
});

describe("Choice values (schemaVersion 8)", () => {
  const options = ["a", "b", "c"].map((value) => ({ value, label: msg(value.toUpperCase()) }));
  const other = { label: msg("Other…"), maxLength: 5 };
  const formWith = (field: Record<string, unknown>) => {
    const parsed = read(card({ b: { type: "Button", props: { label: msg("Open"), action: { kind: "open_form", form: "f" } } } }, { forms: { f: {
      title: msg("Form"), submitLabel: msg("Send"), fields: [{ type: "Choice", name: "pick", label: msg("Pick"), multiple: false, options, ...field }],
    } } }));
    return formOf(parsed, "f");
  };
  const codes = (form: ReturnType<typeof formWith>, value: unknown, mode: "client" | "server") =>
    checkActionCardFormValues(form, value === undefined ? {} : { pick: value }, { mode }).map((issue) => [issue.code, issue.message.params ?? null]);

  test("required: nothing chosen and Other absent or blank", () => {
    const form = formWith({ required: true, other });
    for (const value of [undefined, { selected: [] }, { selected: [], other: "" }, { selected: [], other: "\u3000\t" }]) {
      for (const mode of ["client", "server"] as const) assert.deepEqual(codes(form, value, mode), [["required", null]], `${mode}: ${JSON.stringify(value)}`);
    }
    for (const value of [{ selected: ["a"] }, { selected: [], other: "mine" }]) {
      for (const mode of ["client", "server"] as const) assert.deepEqual(codes(form, value, mode), [], `${mode}: ${JSON.stringify(value)}`);
    }
    // Not required: nothing is no answer.
    assert.deepEqual(codes(formWith({ other }), { selected: [], other: " " }, "server"), []);
  });

  test("too_many, too_few and too_long, the same on both sides", () => {
    const multiple = formWith({ multiple: true, minItems: 2, maxItems: 3, other });
    const both = (value: unknown, expected: unknown[]) => {
      for (const mode of ["client", "server"] as const) assert.deepEqual(codes(multiple, value, mode), expected, `${mode}: ${JSON.stringify(value)}`);
    };
    both({ selected: ["a"] }, [["too_few", { min: 2 }]]);
    both({ selected: ["a"], other: "own" }, []);
    both({ selected: ["a"], other: "   " }, [["too_few", { min: 2 }]]);
    both({ selected: ["a", "b", "c"], other: "own" }, [["too_many", { max: 3 }]]);
    both({ selected: ["a", "b"], other: "123456" }, [["too_long", { max: 5 }]]);
    // A single Choice takes one item: an option and Other is too many.
    for (const mode of ["client", "server"] as const) assert.deepEqual(codes(formWith({ other }), { selected: ["a"], other: "own" }, mode), [["too_many", { max: 1 }]]);
    // A multiple Choice without bounds takes 1 to all of its items.
    const open = formWith({ multiple: true, other });
    assert.deepEqual(codes(open, { selected: ["a", "b", "c"], other: "own" }, "server"), []);
  });

  test("server only: the value's shape, repeats, the reserved value, Other where there is none, two on a single Choice, and options", () => {
    const single = formWith({});
    for (const value of ["a", ["a"], { selected: "a" }, { selected: ["a"], other: 1 }, { selected: ["a"], extra: true }, null]) {
      assert.deepEqual(codes(single, value, "server"), [["invalid_format", null]], JSON.stringify(value));
      assert.deepEqual(codes(single, value, "client"), [], `client leaves ${JSON.stringify(value)} to the server`);
    }
    assert.deepEqual(codes(formWith({ multiple: true }), { selected: ["a", "a"] }, "server"), [["invalid_format", null]]);
    assert.deepEqual(codes(formWith({ multiple: true, other }), { selected: ["other"] }, "server"), [["invalid_format", null]]);
    assert.deepEqual(codes(single, { selected: [], other: "x" }, "server"), [["invalid_format", null]], "no Other on this Choice");
    assert.deepEqual(codes(single, { selected: ["a", "b"] }, "server"), [["invalid_format", null]]);
    assert.deepEqual(codes(single, { selected: ["a", "b"] }, "client"), [["too_many", { max: 1 }]]);
    assert.deepEqual(codes(single, { selected: ["zzz"] }, "server"), [["invalid_option", null]]);
    assert.deepEqual(codes(single, { selected: ["zzz"] }, "client"), []);
  });

  test("a Choice a client cannot read is skipped, as every unsupported field", () => {
    const parsed = read(vectorCard("question_card_older_reader"));
    assert.deepEqual(checkActionCardFormValues(formOf(parsed, "answers"), {}, { mode: "client" }), []);
  });
});

test("steps: emit refuses names that do not cover the fields exactly once; read drops such steps and keeps the form", () => {
  for (const name of ["form_steps_missing_field", "form_steps_duplicate_field", "form_steps_unknown_field"]) {
    const raw = vectorCard(name);
    assert.equal(parseActionCardSpec(raw, { mode: "emit" }).ok, false, name);
    const form = formOf(read(raw), "f");
    assert.equal("steps" in form, false, name);
    assert.deepEqual(form.fields.map((field) => field.name), ["one", "two", "three"], name);
  }
  const titled = formOf(read(vectorCard("form_steps_title")), "f");
  assert.deepEqual(titled.steps, [{ title: { key: "actionCard.test.step", text: { en: "First" } }, fields: ["one", "two"] }, { fields: ["three"] }]);
  // steps adds no capability: a reader with form.v1 and the fields' capabilities keeps the button.
  assert.deepEqual(buttonAction(stripActionCardSpec(read(vectorCard("form_steps_10")), ["card.v1", "form.v1", "field.text_area"])!, "open"), { kind: "open_form", form: "f" });
});
