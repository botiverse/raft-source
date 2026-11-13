/**
 * Runtime form v2 client state, independent of any UI toolkit: initial values,
 * linkage when a field changes, visibility, choices, validation and the submit
 * body. The web renders on top of this; mobile mirrors the same rules.
 *
 * Everything here is driven by the parsed form (field kinds, option sources,
 * visibility, derived choices). Nothing refers to a field or runtime by name.
 */
import type { RuntimeFormV2Option, RuntimeFormV2OptionSource, RuntimeFormV2UnavailableOption } from "./generated/runtimeFormV2";
import type { ParsedRuntimeFormV2, RuntimeFormV2Field } from "./v2";
import { evaluateRuntimeFormV3Condition, evaluateRuntimeFormV3Schema } from "./v3Rules";

export type RuntimeFormV2Value = string | boolean | Record<string, string> | null;
export type RuntimeFormV2Values = Record<string, RuntimeFormV2Value>;
export type RuntimeFormV2Sources = Record<string, RuntimeFormV2OptionSource>;

/** A choice as displayed: label resolved per `choice.labels`, description only from FieldCopy.choices. */
export type RuntimeFormV2ChoiceOption = RuntimeFormV2Option & { description?: string };

export type RuntimeFormV2Choices =
  /**
   * allowCustom (`select.custom_value`): a combobox; any typed value is valid
   * besides the listed ones, and a stored unlisted value is shown as typed.
   */
  | { kind: "select"; options: RuntimeFormV2ChoiceOption[]; allowEmpty: boolean; allowCustom: boolean }
  | { kind: "free_text" };

export type RuntimeFormV2ErrorCode =
  | "required"
  | "invalid_url"
  | "not_a_choice"
  | "unsupported_required"
  /** A required field whose option source is `unavailable` (`option_source.status`): retry, or wait. */
  | "source_unavailable"
  /**
   * The selected saved provider connection option is marked `unavailable`
   * (capability `provider.saved_connection`): the stored binding stays visible
   * but cannot be saved over; pick something else.
   */
  | "connection_unavailable"
  /**
   * The current value is an `OptionSource.unavailableOptions` entry (v3: e.g. a
   * bound saved connection that is disabled) on a source that takes no typed
   * value: shown selected-and-unavailable, pick something else to save.
   */
  | "option_unavailable"
  /**
   * Edit: a blank secret that cannot keep the stored value because a field it
   * is bound to changed (`writeOnlyKeepRequiresUnchanged`); a new one is needed.
   */
  | "secret_reentry_required";

/** A source that is not live (`option_source.status`); null when live or when the source says nothing. */
export type RuntimeFormV2SourceStatus = {
  status: "fallback" | "unavailable";
  /** As sent; may be a reason this client does not know. */
  reason?: string;
  retryable: boolean;
  /**
   * `OptionSource.state: "stale"`: the Computer did not answer in time and the
   * list is the last one it reported (received at `fetchedAt`). Absent for any
   * other state, an unknown one included.
   */
  stale?: { fetchedAt?: string };
};

const str = (value: RuntimeFormV2Value | undefined) => (typeof value === "string" ? value : "");

/**
 * The selected option of a select field when it is a saved provider connection
 * (capability `provider.saved_connection`: Option.connectionId non-empty).
 * Undefined for any other selection or field.
 */
export function runtimeFormV2SelectedConnection(
  field: RuntimeFormV2Field,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
): RuntimeFormV2Option | undefined {
  if (field.kind !== "select") return undefined;
  const option = selectedOption(field.key, sources, values);
  return option && typeof option.connectionId === "string" && option.connectionId ? option : undefined;
}

/**
 * True while any field holds a saved-connection selection: connectionOwned
 * fields are disabled, not required, and stay out of the submission.
 */
export function runtimeFormV2ConnectionActive(
  form: ParsedRuntimeFormV2,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
): boolean {
  return form.fields.some((field) => runtimeFormV2SelectedConnection(field, sources, values) !== undefined);
}

/**
 * Label priority (`choice.labels`): FieldCopy.choices[value].label, else the
 * option's own label, else the raw value. The description comes only from
 * FieldCopy.choices; keys matching no option are simply never looked up.
 */
function labelled(field: RuntimeFormV2Field, option: RuntimeFormV2Option): RuntimeFormV2ChoiceOption {
  const copy = field.choices?.[option.value];
  const label = copy?.label || (typeof option.label === "string" && option.label ? option.label : option.value);
  return { ...option, label, ...(copy?.description ? { description: copy.description } : {}) };
}

/** Choices the field offers under the current values; null for fields without choices. */
export function runtimeFormV2Choices(
  field: RuntimeFormV2Field,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
): RuntimeFormV2Choices | null {
  const source = field.optionSourceId ? sources[field.optionSourceId] : undefined;
  if (field.kind === "select") {
    return {
      kind: "select",
      options: (source?.options ?? []).map((option) => labelled(field, option)),
      allowEmpty: false,
      allowCustom: source?.customValueAllowed === true,
    };
  }
  if (field.kind === "dependent_select") {
    const parent = str(values[field.dependsOn ?? ""]);
    const options = (source?.optionsByValue?.[parent] ?? []).map((option) => labelled(field, option));
    const customAllowed = source?.customValueAllowedByValue?.[parent] === true;
    // Typed values only (a gateway: nothing listed) is a text box; listed
    // options that also take a typed value (Built-in OpenRouter, task #10) is
    // the same combobox as `select.custom_value`.
    if (customAllowed && options.length === 0) return { kind: "free_text" };
    return { kind: "select", options, allowEmpty: false, allowCustom: customAllowed };
  }
  if (field.kind === "derived_select" && field.derivedFrom) {
    const selected = selectedOption(field.derivedFrom.key, sources, values);
    const list = selected?.[field.derivedFrom.attribute];
    const options = Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string").map((item) => labelled(field, { value: item, label: item }))
      : [];
    // An empty value means "the runtime's default"; it is always a valid choice.
    return { kind: "select", options, allowEmpty: true, allowCustom: false };
  }
  return null;
}

/**
 * The field's option source status when it is not live (`option_source.status`).
 * Only fields that load a source themselves report one; a derived field follows
 * its parent. An unknown status is ignored (treated like a source without one).
 */
export function runtimeFormV2SourceStatus(
  field: RuntimeFormV2Field,
  sources: RuntimeFormV2Sources,
): RuntimeFormV2SourceStatus | null {
  const source = field.optionSourceId ? sources[field.optionSourceId] : undefined;
  if (!source || (source.status !== "fallback" && source.status !== "unavailable")) return null;
  return {
    status: source.status,
    ...(typeof source.reason === "string" && source.reason ? { reason: source.reason } : {}),
    retryable: source.retryable === true,
    ...(source.state === "stale"
      ? { stale: typeof source.fetchedAt === "string" && source.fetchedAt ? { fetchedAt: source.fetchedAt } : {} }
      : {}),
  };
}

/**
 * Whether the field is required under the current values: the unconditional
 * `required`, or (v3) a `dataSchema.allOf` entry whose condition gives the
 * branch that lists it.
 */
export function isRuntimeFormV2FieldRequired(field: RuntimeFormV2Field, values: RuntimeFormV2Values): boolean {
  return field.required || (field.requiredWhen ?? []).some((entry) => evaluateRuntimeFormV3Schema(entry.condition, values) === entry.when);
}

/**
 * Hidden but kept: an optional field whose source is unavailable, or an
 * optional dependent_select whose parent value has no key in its loaded
 * source (v3 reasoning effort for a typed or effort-less model). Its value is
 * kept: never reset, and on edit the stored one is submitted unchanged. A
 * required one stays to show why it blocks.
 */
function hiddenAsUnavailable(field: RuntimeFormV2Field, values: RuntimeFormV2Values, sources: RuntimeFormV2Sources | undefined): boolean {
  if (sources === undefined || isRuntimeFormV2FieldRequired(field, values)) return false;
  if (runtimeFormV2SourceStatus(field, sources)?.status === "unavailable") return true;
  if (field.kind !== "dependent_select") return false;
  const source = field.optionSourceId ? sources[field.optionSourceId] : undefined;
  if (!source) return false;
  const parent = str(values[field.dependsOn ?? ""]);
  return !Object.hasOwn(source.optionsByValue ?? {}, parent) && !Object.hasOwn(source.customValueAllowedByValue ?? {}, parent);
}

/** The `unavailableOptions` entry the field's current value names, if any. */
export function runtimeFormV2UnavailableSelection(
  field: RuntimeFormV2Field,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
): RuntimeFormV2UnavailableOption | undefined {
  const source = field.optionSourceId ? sources[field.optionSourceId] : undefined;
  const value = str(values[field.key]).trim();
  if (!value || !Array.isArray(source?.unavailableOptions)) return undefined;
  return source.unavailableOptions.find((option) => option?.value === value);
}

function selectedOption(
  key: string,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
): RuntimeFormV2Option | undefined {
  const value = str(values[key]);
  for (const source of Object.values(sources)) {
    if (source.pointer !== `/${key}`) continue;
    if (source.options) return source.options.find((option) => option.value === value);
    const parent = source.dependsOn?.replace(/^\//, "") ?? "";
    return source.optionsByValue?.[str(values[parent])]?.find((option) => option.value === value);
  }
  return undefined;
}

function defaultFor(field: RuntimeFormV2Field, sources: RuntimeFormV2Sources, values: RuntimeFormV2Values): RuntimeFormV2Value {
  const source = field.optionSourceId ? sources[field.optionSourceId] : undefined;
  switch (field.kind) {
    case "boolean": return false;
    case "string_map": return {};
    case "select": return source?.defaultValue ?? source?.options?.[0]?.value ?? "";
    case "dependent_select": {
      const parent = str(values[field.dependsOn ?? ""]);
      // A typed-only value starts blank; a list (custom allowed or not) starts at its default.
      const typedOnly = source?.customValueAllowedByValue?.[parent] === true && (source?.optionsByValue?.[parent] ?? []).length === 0;
      return typedOnly ? "" : source?.defaultValueByValue?.[parent] ?? "";
    }
    case "derived_select": {
      const from = field.derivedFrom;
      const selected = from ? selectedOption(from.key, sources, values) : undefined;
      const fallback = from?.defaultAttribute ? selected?.[from.defaultAttribute] : undefined;
      return typeof fallback === "string" ? fallback : "";
    }
    case "unsupported": return null;
    default: return "";
  }
}

/**
 * Starting values: for edit, the agent's stored values (form.values) where they
 * fit the field's kind; otherwise each field's default. Parents come before
 * their dependents so defaults follow the stored parent. writeOnly fields are
 * never stored in form.values, so they start blank, which on edit means "keep".
 *
 * Edit: an optional dependent_select or derived_select (a reasoning effort)
 * with no stored string (null or absent: the agent uses the runtime default)
 * starts at "" (Default), never at the parent's default
 * (`defaultValueByValue` / `defaultAttribute`): saving untouched must not turn
 * Default into the model's default effort. The parent's default applies on
 * create, and on edit only once the parent changes (applyRuntimeFormV2Change).
 */
export function initialRuntimeFormV2Values(form: ParsedRuntimeFormV2, sources: RuntimeFormV2Sources): RuntimeFormV2Values {
  const values: RuntimeFormV2Values = {};
  const editing = form.values !== undefined;
  for (const field of dependencyOrder(form.fields)) {
    const stored = form.values?.[field.key];
    values[field.key] = storedFits(field, stored)
      ? stored
      : editing && keepsRuntimeDefault(field) && parentStored(form, field) ? "" : defaultFor(field, sources, values);
  }
  return values;
}

/**
 * The field's parent has a stored value: the field is in effect for the agent
 * as saved. A parent with none (a branch the saved agent is not on, e.g. Pi's
 * "configured" model while it uses a provider) means the field does not apply,
 * so switching to that branch starts at the parent's default, as on create.
 */
function parentStored(form: ParsedRuntimeFormV2, field: RuntimeFormV2Field): boolean {
  const parentKey = field.dependsOn ?? field.derivedFrom?.key;
  const parent = parentKey ? form.fields.find((candidate) => candidate.key === parentKey) : undefined;
  return parent !== undefined && storedFits(parent, form.values?.[parent.key]) && form.values?.[parent.key] !== "";
}

/** An optional choice field whose empty value means "the runtime's default" and whose default follows a parent. */
function keepsRuntimeDefault(field: RuntimeFormV2Field): boolean {
  return (field.kind === "dependent_select" || field.kind === "derived_select")
    && !field.required && (field.requiredWhen ?? []).length === 0;
}

function storedFits(field: RuntimeFormV2Field, stored: unknown): stored is RuntimeFormV2Value {
  if (stored === undefined) return false;
  switch (field.kind) {
    case "boolean": return typeof stored === "boolean";
    case "string_map":
      return stored !== null && typeof stored === "object" && !Array.isArray(stored)
        && Object.values(stored).every((item) => typeof item === "string");
    case "unsupported": return true;
    default: return typeof stored === "string";
  }
}

/**
 * Set one field and cascade: fields whose choices depend on it are reset to
 * their defaults, recursively, so a stale model can never survive a provider
 * change.
 */
export function applyRuntimeFormV2Change(
  form: ParsedRuntimeFormV2,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
  key: string,
  value: RuntimeFormV2Value,
): RuntimeFormV2Values {
  const next = { ...values, [key]: value };
  const changed = new Set([key]);
  for (const field of dependencyOrder(form.fields)) {
    const parent = field.dependsOn ?? field.derivedFrom?.key;
    if (parent && changed.has(parent)) {
      next[field.key] = defaultFor(field, sources, next);
      changed.add(field.key);
    }
  }
  // Moving onto or off a saved-connection selection (provider.saved_connection)
  // hands the connectionOwned fields to the connection or back to the user:
  // either way their old value must not survive the switch.
  if (runtimeFormV2ConnectionActive(form, sources, next) !== runtimeFormV2ConnectionActive(form, sources, values)) {
    for (const field of form.fields) {
      if (field.connectionOwned) next[field.key] = defaultFor(field, sources, next);
    }
  }
  return next;
}

/**
 * The values a visibility rule sees for a field: the raw one, plus — when the
 * field holds a saved-connection selection (`provider.saved_connection`) — the
 * connection's underlying provider id. A gateway connection keeps driving the
 * gateway schema's endpoint fields: they stay visible as disabled managed
 * fields instead of disappearing with the raw `connection:<id>` value.
 */
function visibilityValuesOf(key: string, values: RuntimeFormV2Values, sources?: RuntimeFormV2Sources): string[] {
  const raw = str(values[key]);
  if (!sources) return [raw];
  for (const source of Object.values(sources)) {
    if (source.pointer !== `/${key}` || !source.options) continue;
    const underlying = source.options.find((option) => option.value === raw)?.underlyingProviderId;
    return typeof underlying === "string" && underlying ? [raw, underlying] : [raw];
  }
  return [raw];
}

/**
 * Visibility rules (v2 `visibility`, v3 `rules`), plus (when `sources` is
 * given) `option_source.status`: an optional field whose source is
 * unavailable is hidden, and so is an optional dependent_select whose parent
 * value has no key in its source.
 */
export function isRuntimeFormV2FieldVisible(
  field: RuntimeFormV2Field,
  values: RuntimeFormV2Values,
  sources?: RuntimeFormV2Sources,
): boolean {
  if (field.rule && evaluateRuntimeFormV3Condition(field.rule.condition, values) !== (field.rule.effect === "SHOW")) return false;
  if (hiddenAsUnavailable(field, values, sources)) return false;
  return field.visibleWhen.every((rule) =>
    visibilityValuesOf(rule.key, values, sources).some((candidate) => rule.in.includes(candidate)));
}

/**
 * Renderer convention (no contract key): the Advanced section starts open when
 * any visible field in it has a non-blank value (a non-blank string, a
 * non-empty map, or `true`), so a value in effect is never collapsed out of
 * sight. Clients open it when this turns true (on edit, or once a value is
 * set) and let the user collapse it afterwards.
 */
export function runtimeFormV2AdvancedStartsOpen(
  form: ParsedRuntimeFormV2,
  values: RuntimeFormV2Values,
  sources?: RuntimeFormV2Sources,
): boolean {
  return form.fields.some((field) => {
    if (!field.advanced) return false;
    if (!isRuntimeFormV2FieldVisible(field, values, sources)) return false;
    const value = values[field.key];
    if (typeof value === "string") return value.trim() !== "";
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return value === true;
  });
}

/** Errors by field key for visible fields; an empty object means the form can be submitted. */
export function validateRuntimeFormV2(
  form: ParsedRuntimeFormV2,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
  options: { editing?: boolean } = {},
): Record<string, RuntimeFormV2ErrorCode> {
  const errors: Record<string, RuntimeFormV2ErrorCode> = {};
  const connectionActive = runtimeFormV2ConnectionActive(form, sources, values);
  for (const field of form.fields) {
    if (!isRuntimeFormV2FieldVisible(field, values, sources)) continue;
    if (field.kind === "unsupported") {
      if (field.required) errors[field.key] = "unsupported_required";
      continue;
    }
    // A bound-but-unavailable connection stays visible and blocks the save:
    // the binding is never silently rewritten (provider.saved_connection).
    if (connectionActive && runtimeFormV2SelectedConnection(field, sources, values)?.unavailable === true) {
      errors[field.key] = "connection_unavailable";
      continue;
    }
    const required = isRuntimeFormV2FieldRequired(field, values);
    if (required && runtimeFormV2SourceStatus(field, sources)?.status === "unavailable") {
      errors[field.key] = "source_unavailable";
      continue;
    }
    const choices = runtimeFormV2Choices(field, sources, values);
    // A value that is an unavailable entry blocks, unless the source takes
    // typed values: then it is accepted as typed, as before.
    if (choices?.kind === "select" && !choices.allowCustom && runtimeFormV2UnavailableSelection(field, sources, values)) {
      errors[field.key] = "option_unavailable";
      continue;
    }
    const value = values[field.key];
    const text = str(value).trim();
    // While a saved connection is selected, the fields it owns are not the
    // user's to fill: not required, not submitted — and a changed provider
    // binding never demands a re-entered secret for them (the connection
    // owns the credential; there is nothing to re-enter).
    const connectionOwnedNow = connectionActive && field.connectionOwned === true;
    if (options.editing === true && field.kind === "secret" && !text && !connectionOwnedNow
      && keepBindingChanged(form, sources, values, field.key)) {
      errors[field.key] = "secret_reentry_required";
      continue;
    }
    // On edit a blank secret (writeOnly) field keeps the stored value.
    const blankAllowed = (options.editing === true && field.kind === "secret") || connectionOwnedNow;
    if (required && !blankAllowed && (field.kind === "text" || field.kind === "secret" || field.kind === "url"
      || field.kind === "select" || field.kind === "dependent_select") && !text) {
      errors[field.key] = "required";
      continue;
    }
    if (field.kind === "url" && text && !/^https?:\/\//i.test(text)) errors[field.key] = "invalid_url";
    // A derived list with nothing to offer (a model without an effort menu, or
    // a typed custom model no option describes) is not shown, so it cannot be
    // corrected here: its value goes to the server unchanged, which validates it.
    const unconstrained = field.kind === "derived_select" && choices?.kind === "select" && choices.options.length === 0;
    if (choices?.kind === "select" && !choices.allowCustom && !unconstrained && text
      && !choices.options.some((option) => option.value === text)) {
      errors[field.key] = "not_a_choice";
    }
  }
  return errors;
}

/** `writeOnlyKeepRequiresUnchanged` comparison: as strings, trimmed, trailing slashes removed. */
const boundValue = (value: unknown) =>
  (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)).trim().replace(/\/+$/, "");

/** Whether a visible field the secret `key` is bound to differs from its stored value. */
function keepBindingChanged(
  form: ParsedRuntimeFormV2,
  sources: RuntimeFormV2Sources,
  values: RuntimeFormV2Values,
  key: string,
): boolean {
  const bound = form.writeOnlyKeepRequiresUnchanged?.[key] ?? [];
  return bound.some((boundKey) => {
    const boundField = form.fields.find((candidate) => candidate.key === boundKey);
    if (!boundField || !isRuntimeFormV2FieldVisible(boundField, values, sources)) return false;
    return boundValue(values[boundKey]) !== boundValue(form.values?.[boundKey]);
  });
}

/**
 * The `formValues` body: every visible field, plus the stored value of any
 * field this client could not render so it survives unchanged. An optional
 * field hidden because its source is unavailable keeps its stored value too
 * (edit); on create it has none and is omitted.
 */
export function runtimeFormV2Submission(
  form: ParsedRuntimeFormV2,
  values: RuntimeFormV2Values,
  sources?: RuntimeFormV2Sources,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const connectionActive = sources ? runtimeFormV2ConnectionActive(form, sources, values) : false;
  for (const field of form.fields) {
    // Connection-owned fields never enter formValues while a saved connection
    // is selected — not even as empty strings. The server refuses any value
    // for them on a connection submit (contract, provider.saved_connection).
    if (connectionActive && field.connectionOwned) continue;
    if (hiddenAsUnavailable(field, values, sources)) {
      const stored = form.values?.[field.key];
      if (stored !== undefined) out[field.key] = stored;
      continue;
    }
    if (field.kind !== "unsupported" && !isRuntimeFormV2FieldVisible(field, values, sources)) continue;
    const value = values[field.key];
    if (value === undefined) continue;
    out[field.key] = typeof value === "string" ? value.trim() || (field.kind === "derived_select" ? null : "") : value;
  }
  return out;
}

function dependencyOrder(fields: RuntimeFormV2Field[]): RuntimeFormV2Field[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const ordered: RuntimeFormV2Field[] = [];
  const seen = new Set<string>();
  const visit = (field: RuntimeFormV2Field, depth: number) => {
    if (seen.has(field.key) || depth > fields.length) return;
    const parent = field.dependsOn ?? field.derivedFrom?.key;
    const parentField = parent ? byKey.get(parent) : undefined;
    if (parentField) visit(parentField, depth + 1);
    if (!seen.has(field.key)) {
      seen.add(field.key);
      ordered.push(field);
    }
  };
  for (const field of fields) visit(field, 0);
  return ordered;
}
