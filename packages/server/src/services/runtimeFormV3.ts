/**
 * Runtime form protocol v3 at the edge (packages/runtime-form README,
 * "Protocol v3"). The registry keeps building v2 forms and sources; a request
 * that advertises `runtime_form.v3` gets them converted here, and any other
 * request gets exactly the v2 bodies it always got.
 *
 * - visibility -> `uiSchema.rules` (SHOW on an enum condition)
 * - `x-connectionOwned` -> a HIDE rule (provider matches ^connection:) plus a
 *   `dataSchema.allOf` if/else required; a non-owned field shown for a provider
 *   (the gateway limit fields) lists the connection values whose provider is
 *   in its condition, and that connection set is folded into `revision`
 * - `x-optionsFrom` (a reasoning effort) -> an `x-optionSource`
 *   dependent_select keyed by the parent's option values, with a server-sent
 *   Default ("") first and the parent's status
 * - `Option.unavailable` -> `OptionSource.unavailableOptions`
 * - `revision` on every form; `requiredClientCapabilities` empty
 */
import {
  RUNTIME_FORM_V3_CLIENT_CAPABILITY,
  RUNTIME_FORM_V3_PROTOCOL_VERSION,
  type RuntimeFormV2Definition,
  type RuntimeFormV2Option,
  type RuntimeFormV2UnavailableOption,
} from "@botiverse/raft-runtime-form";
import { REASONING_EFFORTS, type AgentCreateFormOption } from "@botiverse/raft-shared";
import { createHash } from "node:crypto";

import { isProviderConnectionsEnabled } from "./providerConnectionFeature";
import { listProviderConnections } from "./providerConnectionService";
import {
  buildRuntimeFormV2ForServer,
  runtimeFormV2Entry,
  SAVED_CONNECTION_FIELD,
  SAVED_CONNECTION_VALUE_PREFIX,
  type RuntimeFormOptionSourceContext,
  type RuntimeFormOptionSourceResolution,
  type RuntimeFormV2OptionSourceBody,
} from "./runtimeFormV2Registry";

/** Whether the request advertised `runtime_form.v3`. */
export function isRuntimeFormV3Request(clientCapabilities: readonly string[] | undefined): boolean {
  return (clientCapabilities ?? []).includes(RUNTIME_FORM_V3_CLIENT_CAPABILITY);
}

/** A saved connection as a rule condition sees it: its option value and its provider. */
export type RuntimeFormV3Connection = { value: string; underlyingProviderId: string };

const CONNECTION_PATTERN = `^${SAVED_CONNECTION_VALUE_PREFIX}`;
const REVISION_SALT = "runtime-form.v3";

/**
 * The saved connections a v3 form's conditions may name: only for an entry
 * that offers them, on a server with provider connections enabled, to a
 * caller who may list them (the same gate as the connection options).
 */
export async function runtimeFormV3Connections(
  runtimeId: string,
  serverId: string,
  connectionsVisible: boolean,
): Promise<RuntimeFormV3Connection[]> {
  if (!connectionsVisible || !runtimeFormV2Entry(runtimeId)?.savedConnection) return [];
  if (!await isProviderConnectionsEnabled(serverId)) return [];
  return (await listProviderConnections(serverId)).map((connection) => ({
    value: `${SAVED_CONNECTION_VALUE_PREFIX}${connection.id}`,
    underlyingProviderId: connection.providerId as string,
  }));
}

/**
 * The v3 revision: the served v2 form's semantics (runtime, schemaVersion,
 * capabilities, incl. the saved-connection flag), the advertised capabilities
 * and the connection set the conditions are built from. A new or removed
 * connection makes option-source requests answer 409 form_revision_stale.
 */
export function runtimeFormV3Revision(
  runtimeId: string,
  servedV2: Pick<RuntimeFormV2Definition, "schemaVersion" | "requiredClientCapabilities">,
  clientCapabilities: readonly string[],
  connections: readonly RuntimeFormV3Connection[],
): string {
  const parts = [
    runtimeId,
    servedV2.schemaVersion,
    [...(servedV2.requiredClientCapabilities ?? [])].sort(),
    REVISION_SALT,
    [...clientCapabilities].sort(),
    connections.map((connection) => connection.value).sort(),
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

const scopeOf = (key: string) => `#/properties/${key}`;
const keyOf = (pointer: string) => pointer.replace(/^\//, "");

/** A served v2 definition (create or edit body) as v3. */
export function toRuntimeFormV3(
  form: RuntimeFormV2Definition,
  input: { revision: string; connections: readonly RuntimeFormV3Connection[] },
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

  // x-connectionOwned -> HIDE while a connection is selected; never an alias.
  const owned = new Set(Object.entries(properties).filter(([, property]) => property["x-connectionOwned"] === true).map(([key]) => key));
  for (const key of owned) delete properties[key]!["x-connectionOwned"];

  const visibility = new Map<string, Array<{ on: string; values: string[] }>>();
  for (const rule of v3.uiSchema?.visibility ?? []) {
    const key = keyOf(rule.pointer);
    const on = keyOf(rule.when.pointer);
    // A gateway connection drives the fields its provider shows (the limit
    // fields), except those the connection owns.
    const aliases = on === SAVED_CONNECTION_FIELD && !owned.has(key)
      ? input.connections.filter((connection) => rule.when.in.includes(connection.underlyingProviderId)).map((connection) => connection.value)
      : [];
    visibility.set(key, [...(visibility.get(key) ?? []), { on, values: [...rule.when.in, ...aliases] }]);
  }
  const rules: NonNullable<NonNullable<RuntimeFormV2Definition["uiSchema"]>["rules"]> = [];
  for (const key of Object.keys(properties)) {
    const shows = visibility.get(key);
    if (shows && shows.length === 1) {
      rules.push({ scope: scopeOf(key), effect: "SHOW", condition: { scope: scopeOf(shows[0]!.on), schema: { enum: shows[0]!.values } } });
    } else if (shows && shows.length > 1) {
      rules.push({
        scope: scopeOf(key),
        effect: "SHOW",
        condition: { scope: "#", schema: { allOf: shows.map((show) => ({ properties: { [show.on]: { enum: show.values } } })) } },
      });
    } else if (owned.has(key)) {
      rules.push({ scope: scopeOf(key), effect: "HIDE", condition: { scope: scopeOf(SAVED_CONNECTION_FIELD), schema: { pattern: CONNECTION_PATTERN } } });
    }
  }
  if (v3.uiSchema) {
    delete v3.uiSchema.visibility;
    v3.uiSchema.rules = rules;
  } else {
    v3.uiSchema = { rules };
  }

  // Owned fields are required only without a connection.
  const ownedRequired = (v3.dataSchema.required ?? []).filter((key) => owned.has(key));
  if (ownedRequired.length > 0) {
    v3.dataSchema.required = (v3.dataSchema.required ?? []).filter((key) => !owned.has(key));
    v3.dataSchema.allOf = [{
      if: { properties: { [SAVED_CONNECTION_FIELD]: { pattern: CONNECTION_PATTERN } } },
      else: { required: ownedRequired },
    }];
  }
  return v3;
}

/**
 * A v2 definition served as v3 for this request: the connection set (same
 * gate as the connection options), the revision and the conversion.
 */
export async function serveRuntimeFormV3(
  form: RuntimeFormV2Definition,
  input: { runtimeId: string; serverId: string; clientCapabilities: readonly string[]; connectionsVisible: boolean },
): Promise<RuntimeFormV2Definition> {
  const connections = await runtimeFormV3Connections(input.runtimeId, input.serverId, input.connectionsVisible);
  const served = await buildRuntimeFormV2ForServer(input.runtimeId, input.serverId, input.clientCapabilities) ?? form;
  return toRuntimeFormV3(form, {
    connections,
    revision: runtimeFormV3Revision(input.runtimeId, served, input.clientCapabilities, connections),
  });
}

/** Reason copy (English; localized with the option labels) for a connection that is not selectable. */
const CONNECTION_UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  disabled: "This saved provider is disabled.",
  missing_credential: "This saved provider has no credential.",
};

/** v2 `Option.unavailable` entries -> v3 `unavailableOptions` (never in `options`). */
export function toRuntimeFormV3OptionSource(source: RuntimeFormV2OptionSourceBody): RuntimeFormV2OptionSourceBody {
  if (source.kind !== "select") return source;
  const listed: AgentCreateFormOption[] = [];
  const unavailable: RuntimeFormV2UnavailableOption[] = [];
  for (const option of source.options as Array<AgentCreateFormOption & RuntimeFormV2Option>) {
    if (option.unavailable !== true) {
      listed.push(option);
      continue;
    }
    const reason = typeof option.unavailableReason === "string" ? CONNECTION_UNAVAILABLE_REASONS[option.unavailableReason] : undefined;
    unavailable.push({
      value: option.value,
      label: option.label,
      ...(reason ? { reason } : {}),
      ...(typeof option.connectionId === "string" ? { connectionId: option.connectionId } : {}),
      ...(typeof option.underlyingProviderId === "string" ? { underlyingProviderId: option.underlyingProviderId } : {}),
      ...(typeof option.group === "string" ? { group: option.group } : {}),
      ...(typeof option.providerKind === "string" ? { providerKind: option.providerKind } : {}),
    });
  }
  if (unavailable.length === 0) return source;
  return { ...source, options: listed, unavailableOptions: [...(source.unavailableOptions ?? []), ...unavailable] };
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
  if (!from) {
    const resolution = await entry.resolveOptionSource(context);
    return resolution.kind === "source" && resolution.source
      ? { kind: "source", source: toRuntimeFormV3OptionSource(resolution.source) }
      : resolution;
  }
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
