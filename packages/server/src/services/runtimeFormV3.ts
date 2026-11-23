/**
 * Runtime form protocol v3 at the edge (packages/runtime-form README,
 * "Protocol v3"). The registry keeps building v2 forms and sources; a request
 * that advertises `runtime_form.v3` gets them converted here, and any other
 * request gets exactly the v2 bodies it always got.
 *
 * - visibility -> `uiSchema.rules` (SHOW on an enum condition)
 * - `x-optionsFrom` (a reasoning effort) -> an `x-optionSource`
 *   dependent_select keyed by the parent's option values, with a server-sent
 *   Default ("") first and the parent's status
 * - `revision` on every form; `requiredClientCapabilities` empty
 */
import {
  RUNTIME_FORM_V3_CLIENT_CAPABILITY,
  RUNTIME_FORM_V3_PROTOCOL_VERSION,
  type RuntimeFormV2Definition,
} from "@botiverse/raft-runtime-form";
import { REASONING_EFFORTS, type AgentCreateFormOption } from "@botiverse/raft-shared";
import { createHash } from "node:crypto";

import {
  runtimeFormV2Entry,
  type RuntimeFormOptionSourceContext,
  type RuntimeFormOptionSourceResolution,
  type RuntimeFormV2OptionSourceBody,
} from "./runtimeFormV2Registry";

/** Whether the request advertised `runtime_form.v3`. */
export function isRuntimeFormV3Request(clientCapabilities: readonly string[] | undefined): boolean {
  return (clientCapabilities ?? []).includes(RUNTIME_FORM_V3_CLIENT_CAPABILITY);
}

const REVISION_SALT = "runtime-form.v3";

/**
 * The v3 revision: the served v2 form's semantics (runtime, schemaVersion,
 * capabilities) and the advertised capabilities.
 */
export function runtimeFormV3Revision(
  runtimeId: string,
  servedV2: Pick<RuntimeFormV2Definition, "schemaVersion" | "requiredClientCapabilities">,
  clientCapabilities: readonly string[],
): string {
  const parts = [
    runtimeId,
    servedV2.schemaVersion,
    [...(servedV2.requiredClientCapabilities ?? [])].sort(),
    REVISION_SALT,
    [...clientCapabilities].sort(),
    // Was the saved provider connection set; kept empty so revisions of forms
    // served before its removal stay valid.
    [],
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

const scopeOf = (key: string) => `#/properties/${key}`;
const keyOf = (pointer: string) => pointer.replace(/^\//, "");

/** A served v2 definition (create or edit body) as v3. */
export function toRuntimeFormV3(
  form: RuntimeFormV2Definition,
  input: { revision: string },
): RuntimeFormV2Definition {
  const v3 = structuredClone(form);
  v3.protocolVersion = RUNTIME_FORM_V3_PROTOCOL_VERSION;
  delete v3.requiredClientCapabilities;
  v3.revision = input.revision;
  const properties = v3.dataSchema.properties;

  // x-optionsFrom -> an x-optionSource dependent_select on the parent field.
  for (const [key, property] of Object.entries(properties)) {
    const from = property["x-optionsFrom"];
    if (!from) continue;
    delete property["x-optionsFrom"];
    const parent = Object.values(v3.optionSources ?? {}).find((ref) => ref.pointer === `/${from.field}`);
    if (!parent) continue;
    property["x-optionSource"] = key;
    v3.optionSources = {
      ...v3.optionSources,
      [key]: { ...parent, sourceId: key, kind: "dependent_select", pointer: `/${key}`, dependsOn: `/${from.field}` },
    };
  }

  const visibility = new Map<string, Array<{ on: string; values: string[] }>>();
  for (const rule of v3.uiSchema?.visibility ?? []) {
    const key = keyOf(rule.pointer);
    const on = keyOf(rule.when.pointer);
    visibility.set(key, [...(visibility.get(key) ?? []), { on, values: [...rule.when.in] }]);
  }
  const rules: NonNullable<NonNullable<RuntimeFormV2Definition["uiSchema"]>["rules"]> = [...(v3.uiSchema?.rules ?? [])];
  // On a boolean parent (a checkbox), `in: ["true"]` is `const: true` and
  // `in: ["false"]` is `not: { const: true }` (unchecked or absent). An enum of
  // strings would never match the JSON boolean the checkbox writes.
  const conditionOf = (show: { on: string; values: string[] }) => {
    if (properties[show.on]?.type !== "boolean") return { enum: show.values };
    const shown = show.values.includes("true");
    const hidden = show.values.includes("false");
    if (shown && hidden) return {};
    return shown ? { const: true } : { not: { const: true } };
  };
  for (const key of Object.keys(properties)) {
    const shows = visibility.get(key);
    if (shows && shows.length === 1) {
      rules.push({ scope: scopeOf(key), effect: "SHOW", condition: { scope: scopeOf(shows[0]!.on), schema: conditionOf(shows[0]!) } });
    } else if (shows && shows.length > 1) {
      rules.push({
        scope: scopeOf(key),
        effect: "SHOW",
        condition: { scope: "#", schema: { allOf: shows.map((show) => ({ properties: { [show.on]: conditionOf(show) } })) } },
      });
    }
  }
  if (v3.uiSchema) {
    delete v3.uiSchema.visibility;
    v3.uiSchema.rules = rules;
  } else {
    v3.uiSchema = { rules };
  }

  return v3;
}

/** A v2 definition served as v3 for this request: the revision and the conversion. */
export async function serveRuntimeFormV3(
  form: RuntimeFormV2Definition,
  input: {
    runtimeId: string;
    clientCapabilities: readonly string[];
  },
): Promise<RuntimeFormV2Definition> {
  const served = runtimeFormV2Entry(input.runtimeId)?.buildForm() ?? form;
  return toRuntimeFormV3(form, {
    revision: runtimeFormV3Revision(input.runtimeId, served, input.clientCapabilities),
  });
}

const effortLabel = (effort: string) => REASONING_EFFORTS.find((candidate) => candidate.id === effort)?.label ?? effort;

/**
 * Resolve an option source for a v3 request. A derived field (v2
 * `x-optionsFrom`) is answered from its parent's source, resolved with the
 * same context (the probe cache makes the second read near-free): one key per
 * parent option that offers choices, Default ("") first, the parent's default
 * as the default, and the parent's status. A parent option without choices
 * (or a typed value) has no key: the optional field is hidden there.
 */
export async function resolveRuntimeFormV3OptionSource(
  form: RuntimeFormV2Definition,
  context: RuntimeFormOptionSourceContext,
): Promise<RuntimeFormOptionSourceResolution> {
  const entry = runtimeFormV2Entry(form.runtimeId);
  if (!entry) return { kind: "source", source: null };
  const from = form.optionSources?.[context.sourceId] ? undefined : form.dataSchema.properties[context.sourceId]?.["x-optionsFrom"];
  if (!from) return entry.resolveOptionSource(context);
  const parentRef = Object.values(form.optionSources ?? {}).find((ref) => ref.pointer === `/${from.field}`);
  if (!parentRef) return { kind: "source", source: null };
  const resolution = await entry.resolveOptionSource({ ...context, sourceId: parentRef.sourceId });
  if (resolution.kind !== "source" || !resolution.source) return resolution;
  const parent = resolution.source;
  const parentOptions = parent.kind === "dependent_select" ? Object.values(parent.optionsByValue).flat() : parent.options;
  const optionsByValue: Record<string, AgentCreateFormOption[]> = {};
  const defaultValueByValue: Record<string, string> = {};
  for (const option of parentOptions as Array<Record<string, unknown> & AgentCreateFormOption>) {
    const choices = Array.isArray(option[from.attribute])
      ? (option[from.attribute] as unknown[]).filter((item): item is string => typeof item === "string" && item !== "")
      : [];
    if (choices.length === 0) continue;
    optionsByValue[option.value] = [{ value: "", label: "Default" }, ...choices.map((choice) => ({ value: choice, label: effortLabel(choice) }))];
    const fallback = from.defaultAttribute ? option[from.defaultAttribute] : undefined;
    defaultValueByValue[option.value] = typeof fallback === "string" && choices.includes(fallback) ? fallback : "";
  }
  const { status, reason, retryable, state, fetchedAt } = parent;
  return {
    kind: "source",
    source: {
      protocolVersion: parent.protocolVersion,
      runtimeId: parent.runtimeId,
      schemaVersion: parent.schemaVersion,
      sourceId: context.sourceId,
      kind: "dependent_select",
      pointer: `/${context.sourceId}`,
      dependsOn: `/${from.field}`,
      optionsByValue,
      defaultValueByValue,
      customValueAllowedByValue: {},
      ...(status ? { status } : {}),
      ...(reason ? { reason } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      ...(state ? { state } : {}),
      ...(fetchedAt ? { fetchedAt } : {}),
    } as RuntimeFormV2OptionSourceBody,
  };
}
