import assert from "node:assert/strict";
import { vi } from "vitest";
import { PI_REASONING_EFFORTS } from "@botiverse/raft-shared";
import {
  initialRuntimeFormV2Values,
  parseRuntimeFormV2,
  releasedRuntimeFormDefinition,
  runtimeFormV2Choices,
  runtimeFormV2Submission,
  type RuntimeFormV2OptionSource,
} from "@botiverse/raft-runtime-form";
import {
  buildRuntimeConfigFromFormValues,
  buildRuntimeFormV2,
  buildRuntimeFormV2EditBody,
  runtimeFormV2Entry,
  runtimeFormValuesFromRuntimeConfig,
  type RuntimeFormOptionSourceContext,
} from "./runtimeFormV2Registry";

vi.mock("./providerConnectionFeature", () => ({ isProviderConnectionsEnabled: vi.fn(async () => false) }));
vi.mock("./providerConnectionService", () => ({ listProviderConnections: vi.fn(async () => []) }));

const preset = { providerId: "deepseek", apiKey: "test-key", model: "deepseek/deepseek-flash" };

test("Built-in v2 offers every Pi effort without changing the released v1 form", async () => {
  const form = parseRuntimeFormV2(buildRuntimeFormV2("builtin"))!;
  const effort = form.fields.find((field) => field.key === "reasoningEffort");
  assert.ok(effort);
  assert.equal(effort.advanced, false);
  const resolution = await runtimeFormV2Entry("builtin")!.resolveOptionSource({
    sourceId: "reasoningEffort",
  } as RuntimeFormOptionSourceContext);
  assert.equal(resolution.kind, "source");
  if (resolution.kind !== "source") return;
  // Exercise the released consumer with the source as serialized on the wire.
  const source = JSON.parse(JSON.stringify(resolution.source)) as RuntimeFormV2OptionSource;
  const choices = runtimeFormV2Choices(effort, { reasoningEffort: source }, {});
  assert.ok(choices);
  assert.equal(choices.kind, "select");
  if (choices.kind === "select") {
    assert.deepEqual(choices.options.map((option) => option.value), ["", ...PI_REASONING_EFFORTS]);
  }
  assert.equal(releasedRuntimeFormDefinition("builtin-pi.create.v3")!.dataSchema.properties.reasoningEffort, undefined);
});

test("preset, gateway and saved connection edits round-trip effort and allow explicit default", () => {
  const providers = [
    preset,
    { providerId: "openai-compatible", apiKey: "test-key", baseUrl: "https://example.test/v1", model: "custom-model" },
    { providerId: "connection:c1", model: "custom-model" },
  ];
  for (const values of providers) {
    for (const effort of PI_REASONING_EFFORTS) {
      const built = buildRuntimeConfigFromFormValues("builtin", { ...values, reasoningEffort: effort });
      assert.ok(built.ok);
      if (!built.ok) continue;
      assert.equal(built.runtimeConfig.reasoningEffort, effort);
      const edited = runtimeFormValuesFromRuntimeConfig(built.runtimeConfig)!;
      assert.equal(edited.reasoningEffort, effort);
    }
    for (const effort of [null, "", undefined]) {
      const built = buildRuntimeConfigFromFormValues("builtin", { ...values, reasoningEffort: effort });
      assert.ok(built.ok);
      if (built.ok) assert.equal(built.runtimeConfig.reasoningEffort, null);
    }
  }
});

test("Built-in rejects effort values outside the Pi contract", () => {
  for (const reasoningEffort of ["ultra", "bogus", 7, {}]) {
    const built = buildRuntimeConfigFromFormValues("builtin", { ...preset, reasoningEffort });
    assert.equal(built.ok, false);
    if (!built.ok) assert.equal(built.issue.pointer, "/formValues/reasoningEffort");
  }
});

test("an unrelated edit retains Extra high through generic client state; Default clears it", () => {
  const built = buildRuntimeConfigFromFormValues("builtin", { ...preset, reasoningEffort: "xhigh" });
  assert.ok(built.ok);
  if (!built.ok) return;
  const form = parseRuntimeFormV2(buildRuntimeFormV2EditBody("builtin", built.runtimeConfig))!;
  const values = initialRuntimeFormV2Values(form, {});
  assert.equal(values.reasoningEffort, "xhigh");
  values.envVars = { EXAMPLE_FLAG: "1" };
  for (const expected of ["xhigh", null]) {
    if (expected === null) values.reasoningEffort = "";
    const submitted = runtimeFormV2Submission(form, values);
    const saved = buildRuntimeConfigFromFormValues("builtin", submitted, { editing: true });
    assert.ok(saved.ok);
    if (saved.ok) assert.equal(saved.runtimeConfig.reasoningEffort, expected);
  }
});
