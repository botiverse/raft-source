import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  missingRuntimeFormV2Capabilities,
  parseRuntimeFormV2,
  RUNTIME_FORM_V2_RESERVED_CLIENT_CAPABILITIES,
} from "@botiverse/raft-runtime-form";

import { WEB_RUNTIME_FORM_V2_CAPABILITIES } from "../src/hooks/useRuntimeFormV2";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as unknown;

test("web implements every reserved runtime form v2 capability, so Codex, Grok, Claude, Cursor, Copilot and Pi open on v2", () => {
  assert.deepEqual([...WEB_RUNTIME_FORM_V2_CAPABILITIES].sort(), [...RUNTIME_FORM_V2_RESERVED_CLIENT_CAPABILITIES].sort());
  for (const name of [
    "codex.form.json", "codex.edit.json", "grok.form.json", "choices.form.json", "capabilities.form.json",
    "claude.form.json", "claude.edit.json", "cursor.form.json", "cursor.edit.json", "copilot.edit.json",
    "pi.form.json", "pi.edit.json", "pi.edit.configured.json",
  ]) {
    const form = parseRuntimeFormV2(fixture(name));
    assert.ok(form, name);
    assert.deepEqual(missingRuntimeFormV2Capabilities(form, WEB_RUNTIME_FORM_V2_CAPABILITIES), [], name);
  }
  // A capability web does not know still sends the form back to legacy.
  const future = parseRuntimeFormV2({ ...(fixture("codex.form.json") as object), requiredClientCapabilities: ["choice.labels", "future.capability"] });
  assert.deepEqual(missingRuntimeFormV2Capabilities(future!, WEB_RUNTIME_FORM_V2_CAPABILITIES), ["future.capability"]);
});

test("v2 form requests ask for the app's display language, not the browser's", async () => {
  const { runtimeFormV2RequestHeaders } = await import("../src/hooks/useRuntimeFormV2");
  assert.deepEqual(runtimeFormV2RequestHeaders("zh-cn"), { "Accept-Language": "zh-CN" });
  assert.deepEqual(runtimeFormV2RequestHeaders("en"), { "Accept-Language": "en" });
});

test("web advertises every advertised runtime form v2 capability, on form requests and v2 saves (task #10)", async () => {
  const { RUNTIME_FORM_V2_ADVERTISED_CLIENT_CAPABILITIES, RUNTIME_FORM_V2_CLIENT_CAPABILITIES_QUERY } = await import("@botiverse/raft-runtime-form");
  const { WEB_RUNTIME_FORM_V2_ADVERTISED_CAPABILITIES, runtimeFormV2ClientCapabilityParams } = await import("../src/utils/runtimeFormV2ClientCapabilities");
  assert.deepEqual([...WEB_RUNTIME_FORM_V2_ADVERTISED_CAPABILITIES].sort(), [...RUNTIME_FORM_V2_ADVERTISED_CLIENT_CAPABILITIES].sort());
  assert.deepEqual(runtimeFormV2ClientCapabilityParams(), { [RUNTIME_FORM_V2_CLIENT_CAPABILITIES_QUERY]: "dependent_select.custom_value_with_options,runtime_form.v3" });

  const { default: api } = await import("../src/api/client");
  const { useAgentStore } = await import("../src/store/agentStore");
  const originalPatch = api.patch.bind(api);
  const seen: unknown[] = [];
  api.patch = (async (_url: string, _body?: unknown, config?: unknown) => {
    seen.push(config);
    return { data: { id: "agent-1" } };
  }) as typeof api.patch;
  try {
    await useAgentStore.getState().updateAgent("agent-1", { formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: {} } as never);
    await useAgentStore.getState().updateAgent("agent-1", { formDefinitionRef: { protocolVersion: 3, runtimeId: "builtin" }, formValues: {} } as never);
    await useAgentStore.getState().updateAgent("agent-1", { name: "renamed" } as never);
  } finally {
    api.patch = originalPatch;
  }
  assert.deepEqual(seen[0], { params: runtimeFormV2ClientCapabilityParams() }, "a v2 save advertises the capability (the server's edit guard reads it)");
  assert.deepEqual(seen[1], { params: runtimeFormV2ClientCapabilityParams() }, "so does a v3 save");
  assert.equal(seen[2], undefined, "other edits are unchanged");
});
