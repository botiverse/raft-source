// #proj-runtime:#50: a Built-in custom gateway model's optional limits on the v2 form.
import assert from "node:assert/strict";
import { vi } from "vitest";
import { parseRuntimeFormV2, releasedRuntimeFormDefinition, runtimeFormV2AdvancedStartsOpen } from "@botiverse/raft-runtime-form";
import { parseRuntimeConfig } from "@botiverse/raft-shared";
import { localizeRuntimeFormV2 } from "./runtimeFormV2Copy";
import { buildRuntimeConfigFromFormValues, buildRuntimeFormV2, runtimeFormValuesFromRuntimeConfig } from "./runtimeFormV2Registry";

vi.mock("./providerConnectionFeature", () => ({ isProviderConnectionsEnabled: vi.fn(async () => false) }));
vi.mock("./providerConnectionService", () => ({ listProviderConnections: vi.fn(async () => []) }));

const gateway = { providerId: "openai-compatible", apiKey: "test-key", baseUrl: "https://gateway.example.test/v1", model: "devin/swe-2-flash" };

test("the v2 form has both fields optional and in Advanced, shown for gateways and OpenRouter; the released v1 form is unchanged", () => {
  const raw = buildRuntimeFormV2("builtin");
  const form = parseRuntimeFormV2(raw)!;
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const field = form.fields.find((candidate) => candidate.key === key);
    assert.ok(field, key);
    assert.equal(field.advanced, true);
    assert.equal(field.required, false);
    assert.deepEqual(field.visibleWhen, [{ key: "providerId", in: ["openai-compatible", "anthropic-compatible", "openrouter"] }]);
  }
  // Standard layout only: no bespoke keys beside `advanced`.
  assert.deepEqual(raw.uiSchema?.layout, { advanced: ["/contextWindow", "/maxOutputTokens", "/loadLocalPlugins", "/envVars"] });
  // An override that takes effect is never collapsed out of sight: the
  // renderer convention opens Advanced for a visible field with a value.
  const gatewayValues = { providerId: "openai-compatible", envVars: {}, loadLocalPlugins: false, contextWindow: "", maxOutputTokens: "" };
  assert.equal(runtimeFormV2AdvancedStartsOpen(form, gatewayValues), false);
  assert.equal(runtimeFormV2AdvancedStartsOpen(form, { ...gatewayValues, maxOutputTokens: "8192" }), true);
  assert.equal(runtimeFormV2AdvancedStartsOpen(form, { ...gatewayValues, providerId: "anthropic", contextWindow: "200000" }), false, "hidden");
  const v1 = releasedRuntimeFormDefinition("builtin-pi.create.v3")!;
  assert.equal(v1.dataSchema.properties.contextWindow, undefined);
  assert.equal(v1.dataSchema.properties.maxOutputTokens, undefined);
});

test("both hints say a gateway can provide the limits and link the docs as an inline Markdown link, zh-CN to its own page", () => {
  const raw = buildRuntimeFormV2("builtin");
  const zhCn = localizeRuntimeFormV2(raw, "zh-cn");
  const ja = localizeRuntimeFormV2(raw, "ja");
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const copy = raw.uiSchema!.localization![key]!;
    assert.equal(Object.hasOwn(copy, "helpUrl"), false);
    assert.match(copy.hint!, /A gateway can provide both limits automatically\. \[Learn more\]\(https:\/\/docs\.raft\.build\/developers\/gateway-model-limits\/\)$/);
    assert.match(zhCn.uiSchema!.localization![key]!.hint!, /网关可以自动提供这两个上限。\[了解更多\]\(https:\/\/docs\.raft\.build\/zh-cn\/developers\/gateway-model-limits\/\)$/);
    // A locale without its own page links the English one.
    assert.match(ja.uiSchema!.localization![key]!.hint!, /\[詳細を見る\]\(https:\/\/docs\.raft\.build\/developers\/gateway-model-limits\/\)$/);
  }
});

test("a gateway custom model takes them (digits, spaces and separators allowed), stores them on the model, and edits round-trip", () => {
  const built = buildRuntimeConfigFromFormValues("builtin", { ...gateway, contextWindow: "128,000", maxOutputTokens: " 32000 " });
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.deepEqual(built.runtimeConfig.model, { kind: "custom", name: "devin/swe-2-flash", contextWindow: 128_000, maxOutputTokens: 32_000 });
  assert.equal(parseRuntimeConfig({ runtimeConfig: built.runtimeConfig }).ok, true, "what the form builds is a valid runtime config");
  const values = runtimeFormValuesFromRuntimeConfig(built.runtimeConfig)!;
  assert.equal(values.contextWindow, "128000");
  assert.equal(values.maxOutputTokens, "32000");

  const blank = buildRuntimeConfigFromFormValues("builtin", { ...gateway, contextWindow: "", maxOutputTokens: "  " });
  assert.ok(blank.ok);
  if (blank.ok) assert.deepEqual(blank.runtimeConfig.model, { kind: "custom", name: "devin/swe-2-flash" }, "blank means not set");
});

test("a saved gateway connection's custom model takes them too", () => {
  const built = buildRuntimeConfigFromFormValues("builtin", { providerId: "connection:c1", model: "devin/swe-2-flash", contextWindow: "64000" }, { savedConnectionProviderId: "openai-compatible" } as never);
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.deepEqual(built.runtimeConfig.model, { kind: "custom", name: "devin/swe-2-flash", contextWindow: 64_000 });
  assert.equal(runtimeFormValuesFromRuntimeConfig(built.runtimeConfig)!.contextWindow, "64000");
});

test("invalid values, output above the window, and limits on a preset model are refused on their own field", () => {
  for (const [values, pointer] of [
    [{ ...gateway, contextWindow: "lots" }, "/formValues/contextWindow"],
    [{ ...gateway, contextWindow: "0" }, "/formValues/contextWindow"],
    [{ ...gateway, contextWindow: "20000000" }, "/formValues/contextWindow"],
    [{ ...gateway, contextWindow: "8000", maxOutputTokens: "9000" }, "/formValues/maxOutputTokens"],
    [{ providerId: "deepseek", apiKey: "k", model: "deepseek/deepseek-flash", contextWindow: "128000" }, "/formValues/contextWindow"],
  ] as const) {
    const built = buildRuntimeConfigFromFormValues("builtin", values);
    assert.equal(built.ok, false, JSON.stringify(values));
    if (!built.ok) assert.equal(built.issue.pointer, pointer);
  }
});
