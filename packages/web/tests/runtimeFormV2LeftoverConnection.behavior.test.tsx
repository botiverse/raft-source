import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers/domSetup";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { applyRuntimeFormV2Change, initialRuntimeFormV2Values, parseRuntimeFormV2, validateRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2Sources, RuntimeFormV2Value, RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import type { Server } from "@botiverse/raft-shared";
import api from "../src/api/client";
import RuntimeConfigFields from "../src/components/agent/RuntimeConfigFields";
import { useRuntimeFormV2 } from "../src/hooks/useRuntimeFormV2";
import { runtimeFormV2WithoutProviderConnections } from "../src/utils/runtimeFormV2WithoutProviderConnections";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// Saved provider connections are retired on the web (provider_connections_v0,
// #raft-feature-flag:#11). An agent whose stored config still binds one opens
// its runtime config without crashing: the agent-local provider fields (API
// key, base URL, model) show, and nothing is selected for the gone
// connection. The server here still has the feature, so it sends both the
// binding (`providerId: "connection:<id>"`) and the connection options.

const SERVER_ID = "server-1";
const MACHINE_ID = "machine-1";
const AGENT_ID = "agent-1";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_VALUE = `connection:${CONNECTION_ID}`;
const CONNECTION_LABEL = "Team shared DeepSeek key";

type Json = Record<string, unknown>;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as Json;

/** builtin.edit.json as a server with the feature serves it for a connection-bound agent. */
function boundEditForm(): Json {
  const edit = fixture("builtin.edit.json");
  const schema = edit.dataSchema as { properties: Record<string, Json> };
  for (const key of ["apiKey", "baseUrl", "supportsImageInput"]) {
    schema.properties[key] = { ...schema.properties[key], "x-connectionOwned": true };
  }
  return {
    ...edit,
    requiredClientCapabilities: ["provider.saved_connection"],
    revision: "rev-1",
    values: { ...(edit.values as Json), providerId: CONNECTION_VALUE, baseUrl: "", model: "deepseek/deepseek-v4-pro" },
  };
}

const head = { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" };
const SOURCES: Record<string, Json> = {
  provider: {
    ...head, sourceId: "provider", kind: "select", pointer: "/providerId",
    options: [
      { value: CONNECTION_VALUE, label: CONNECTION_LABEL, providerKind: "preset", connectionId: CONNECTION_ID, underlyingProviderId: "deepseek", group: "saved" },
      { value: "deepseek", label: "DeepSeek", providerKind: "preset", group: "direct" },
      { value: "openai-compatible", label: "OpenAI Compatible", providerKind: "gateway", group: "direct" },
    ],
    unavailableOptions: [
      { value: "connection:22222222-2222-4222-8222-222222222222", label: "Disabled shared key", connectionId: "22222222-2222-4222-8222-222222222222", group: "saved" },
    ],
    defaultValue: "deepseek",
    status: "live",
  },
  model: {
    ...head, sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId",
    optionsByValue: {
      [CONNECTION_VALUE]: [{ value: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" }],
      deepseek: [{ value: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" }],
      "openai-compatible": [],
    },
    defaultValueByValue: { [CONNECTION_VALUE]: "deepseek/deepseek-v4-pro", deepseek: "deepseek/deepseek-v4-pro" },
    customValueAllowedByValue: { [CONNECTION_VALUE]: false, deepseek: false, "openai-compatible": true },
    status: "live",
  },
  reasoningEffort: { sourceId: "reasoningEffort", kind: "select", pointer: "/reasoningEffort", options: [], defaultValue: "", status: "live" },
};

const originalGet = api.get.bind(api);

beforeEach(() => {
  useServerStore.setState({ current: { id: SERVER_ID, slug: "acme", name: "Acme" } as Server });
  api.get = (async (url: string) => {
    if (url === `/agents/${AGENT_ID}/runtime-form`) return { data: boundEditForm() };
    const sourceId = /\/option-sources\/([^?]+)/.exec(url)?.[1];
    if (sourceId && SOURCES[sourceId]) return { data: structuredClone(SOURCES[sourceId]) };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useServerStore.setState(useServerStore.getInitialState(), true);
});

let latest: {
  values: RuntimeFormV2Values | null;
  errors: Record<string, string>;
  sources?: RuntimeFormV2Sources;
  onChange?: (key: string, value: RuntimeFormV2Value) => void;
} = { values: null, errors: {} };

/** Agent Details' runtime editor, reduced to the form: the edit form, its initial values, the fields. */
function EditHarness() {
  const state = useRuntimeFormV2(MACHINE_ID, "builtin", AGENT_ID);
  const [draft, setDraft] = useState<RuntimeFormV2Values | null>(null);
  const initial = state.status === "ready" ? initialRuntimeFormV2Values(state.form, state.sources) : null;
  const values = draft ?? initial;
  latest = {
    values,
    errors: state.status === "ready" && values ? validateRuntimeFormV2(state.form, state.sources, values, { editing: true }) : {},
    sources: state.status === "ready" ? state.sources : undefined,
  };
  const onChange = (key: string, value: RuntimeFormV2Value) => {
    if (state.status === "ready" && values) setDraft(applyRuntimeFormV2Change(state.form, state.sources, values, key, value));
  };
  latest.onChange = onChange;
  return (
    <RuntimeConfigFields
      runtime="builtin"
      onRuntimeChange={() => {}}
      runtimeOptions={[{ value: "builtin", label: "Built-in" }]}
      runtimeFormV2={{ state, values, onChange, editing: true }}
    />
  );
}

test("an agent still bound to a provider connection shows its own provider fields, with nothing selected for the connection", async () => {
  const { container } = render(<TestIntlProvider><EditHarness /></TestIntlProvider>);
  const apiKey = await waitFor(() => screen.getByTestId("runtime-form-v2-apiKey"));

  // The agent-local API key is the user's to fill: enabled, empty, no "provided by" note.
  assert.equal((apiKey as HTMLInputElement).disabled, false);
  assert.equal((apiKey as HTMLInputElement).value, "");
  // The closed provider picker shows no connection as its value. (Its options
  // are not rendered while closed: the option lists are checked below.)
  const text = container.textContent ?? "";
  assert.ok(!text.includes(CONNECTION_LABEL), "the gone connection is not the picker's value");
  assert.ok(!/saved provider/i.test(text), "no saved-provider copy");

  // Nothing is pre-selected for the provider; its dependents start over, and a save needs a provider.
  assert.equal(latest.values?.providerId, "");
  assert.notEqual(latest.values?.model, "deepseek/deepseek-v4-pro");
  assert.equal(latest.errors.providerId, "required");

  // The option sources the form renders from offer no connection: none listed,
  // none in the unavailable group, no saved/direct grouping, and the model
  // source keeps no entry keyed by a connection value.
  const provider = latest.sources?.provider;
  const model = latest.sources?.model;
  assert.ok(provider && model, "both sources loaded");
  const isConnection = (option: { value: string; connectionId?: unknown }) => typeof option.connectionId === "string" || option.value.startsWith("connection:");
  assert.deepEqual(provider.options?.map((option) => option.value), ["deepseek", "openai-compatible"]);
  assert.equal(provider.options?.some((option) => isConnection(option) || option.group !== undefined), false);
  assert.equal((provider.unavailableOptions ?? []).some(isConnection), false);
  for (const byValue of [model.optionsByValue, model.defaultValueByValue, model.customValueAllowedByValue]) {
    assert.deepEqual(Object.keys(byValue ?? {}).filter((key) => key.startsWith("connection:")), []);
  }

  // Picking a gateway provider shows its base URL beside the key, both editable,
  // and the key must be entered (there is no agent-local one to keep).
  act(() => latest.onChange?.("providerId", "openai-compatible"));
  const baseUrl = await waitFor(() => screen.getByTestId("runtime-form-v2-baseUrl"));
  assert.equal((baseUrl as HTMLInputElement).disabled, false);
  assert.equal((screen.getByTestId("runtime-form-v2-apiKey") as HTMLInputElement).disabled, false);
  assert.equal(latest.errors.apiKey, "secret_reentry_required");
});

test("only the provider select's connection value is cleared: a typed model id that starts with connection: is kept", () => {
  const edit = fixture("builtin.edit.json");
  const form = parseRuntimeFormV2({ ...edit, values: { ...(edit.values as Json), providerId: "openai-compatible", model: "connection:my-gateway-model" } });
  assert.ok(form);
  assert.equal(runtimeFormV2WithoutProviderConnections(form).values?.model, "connection:my-gateway-model");
  const bound = parseRuntimeFormV2({ ...edit, values: { ...(edit.values as Json), providerId: CONNECTION_VALUE } });
  assert.ok(bound);
  assert.equal(runtimeFormV2WithoutProviderConnections(bound).values?.providerId, "");
});
