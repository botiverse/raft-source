import type { ParsedRuntimeFormV2, RuntimeFormV2OptionSource } from "@botiverse/raft-runtime-form";

/**
 * Saved provider connections (flag `provider_connections_v0`) are retired on
 * the web: a stored API key shared by several agents is no longer offered.
 * An agent's provider is configured in its own runtime config (provider, API
 * key, base URL, model), always shown.
 *
 * A server that still has the feature may keep sending connection options
 * (`Option.connectionId`, value `connection:<id>`) and, on edit, a value that
 * names the agent's bound connection. Both are dropped here, so the form reads
 * as one with no connection selected: the agent-local fields show and nothing
 * is pre-selected for the gone connection. A server without the feature sends
 * neither, and this is a no-op.
 */
const CONNECTION_VALUE_PREFIX = "connection:";

function isConnectionValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(CONNECTION_VALUE_PREFIX);
}

function isConnectionOption(option: { value?: unknown; connectionId?: unknown }): boolean {
  return (typeof option.connectionId === "string" && option.connectionId !== "") || isConnectionValue(option.value);
}

/** The option without its saved/direct grouping, which only ever split connections from direct providers. */
function ungrouped<T extends { group?: unknown }>(option: T): T {
  if (option.group !== "saved" && option.group !== "direct") return option;
  const { group: _group, ...rest } = option;
  return rest as T;
}

function withoutConnectionKeys<T>(byValue: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!byValue) return byValue;
  return Object.fromEntries(Object.entries(byValue).filter(([key]) => !isConnectionValue(key)));
}

/** An option source with no saved-connection options, listed or unavailable. */
export function runtimeFormV2SourceWithoutProviderConnections(source: RuntimeFormV2OptionSource): RuntimeFormV2OptionSource {
  const next: RuntimeFormV2OptionSource = { ...source };
  if (Array.isArray(source.options)) {
    next.options = source.options.filter((option) => !isConnectionOption(option)).map(ungrouped);
  }
  if (Array.isArray(source.unavailableOptions)) {
    next.unavailableOptions = source.unavailableOptions.filter((option) => !isConnectionOption(option)).map(ungrouped);
  }
  if (isConnectionValue(source.defaultValue)) next.defaultValue = "";
  if (source.optionsByValue) next.optionsByValue = withoutConnectionKeys(source.optionsByValue);
  if (source.defaultValueByValue) next.defaultValueByValue = withoutConnectionKeys(source.defaultValueByValue);
  if (source.customValueAllowedByValue) next.customValueAllowedByValue = withoutConnectionKeys(source.customValueAllowedByValue);
  return next;
}

/**
 * The form with a leftover connection binding cleared from its edit values:
 * the field that named the connection is blank (nothing pre-selected, so it
 * must be chosen again before a save), and the fields that follow it (its
 * models, their effort) start over from their defaults, as when a provider is
 * picked for the first time.
 *
 * Only a plain `select` can hold a connection (the contract's
 * runtimeFormV2SelectedConnection reads no other kind), so a typed value in
 * any other field (a custom model id that happens to start with
 * `connection:`) is kept. The select is not narrowed further by what its
 * source lists: a caller who may not list connections (no manageExternalAuth)
 * still gets the bound value, with no connection option to match it.
 */
export function runtimeFormV2WithoutProviderConnections(form: ParsedRuntimeFormV2): ParsedRuntimeFormV2 {
  const stored = form.values;
  if (!stored) return form;
  const cleared = new Set(form.fields
    .filter((field) => field.kind === "select" && isConnectionValue(stored[field.key]))
    .map((field) => field.key));
  if (cleared.size === 0) return form;
  const reset = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const field of form.fields) {
      const parent = field.dependsOn ?? field.derivedFrom?.key;
      if (parent && (cleared.has(parent) || reset.has(parent)) && !reset.has(field.key) && !cleared.has(field.key)) {
        reset.add(field.key);
        grew = true;
      }
    }
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (cleared.has(key)) values[key] = "";
    else if (!reset.has(key)) values[key] = value;
  }
  return { ...form, values };
}
