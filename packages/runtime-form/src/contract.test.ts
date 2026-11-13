import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RELEASED_RUNTIME_FORMS } from "./index";
import {
  missingRuntimeFormV2Capabilities,
  parseRuntimeFormV2,
  RUNTIME_FORM_V2_MALFORMED_CAPABILITY,
  toRuntimeFormV2,
} from "./v2";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("generated TypeScript, Kotlin and JSON Schema are fresh from the contract", () => {
  // Throws (non-zero exit) when any generated file differs from the contract.
  execFileSync(process.execPath, ["--import", "@oxc-node/core/register", `${ROOT}contract/generate.ts`, "--check"], { stdio: "pipe" });
});

type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
  items?: Schema;
};
const contractSchema = JSON.parse(readFileSync(`${ROOT}generated/runtime-form-v2.schema.json`, "utf8")) as { $defs: Record<string, Schema> };

/** Minimal validator for the constructs the generator emits; returns the first error path. */
function violation(value: unknown, schema: Schema, path: string): string | null {
  if (schema.$ref) return violation(value, contractSchema.$defs[schema.$ref.replace("#/$defs/", "")]!, path);
  if (schema.const !== undefined && value !== schema.const) return `${path}: expected ${JSON.stringify(schema.const)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: not in enum`;
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  switch (schema.type) {
    case "string": if (typeof value !== "string") return `${path}: expected string`; break;
    case "integer": if (!Number.isInteger(value)) return `${path}: expected integer`; break;
    case "boolean": if (typeof value !== "boolean") return `${path}: expected boolean`; break;
    case "array":
      if (!Array.isArray(value)) return `${path}: expected array`;
      for (const [index, item] of value.entries()) {
        const error = violation(item, schema.items ?? {}, `${path}/${index}`);
        if (error) return error;
      }
      break;
    case "object": {
      if (!isObject) return `${path}: expected object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in record)) return `${path}/${key}: required`;
      for (const [key, item] of Object.entries(record)) {
        const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
        if (!child) continue;
        const error = violation(item, child, `${path}/${key}`);
        if (error) return error;
      }
    }
  }
  return null;
}

test("every released form served over v2 conforms to the generated contract", () => {
  for (const [version, form] of RELEASED_RUNTIME_FORMS) {
    assert.equal(violation(toRuntimeFormV2(form.definition), { $ref: "#/$defs/Definition" }, version), null);
  }
});

test("the contract validator rejects a malformed v2 body", () => {
  const form = toRuntimeFormV2(RELEASED_RUNTIME_FORMS.get("builtin-pi.create.v3")!.definition) as unknown as Record<string, unknown>;
  assert.match(violation({ ...form, protocolVersion: 1 }, { $ref: "#/$defs/Definition" }, "") ?? "", /protocolVersion/);
  assert.match(violation({ ...form, dataSchema: { type: "object" } }, { $ref: "#/$defs/Definition" }, "") ?? "", /properties: required/);
  // Unknown keys are allowed everywhere.
  assert.equal(violation({ ...form, brandNew: [1] }, { $ref: "#/$defs/Definition" }, ""), null);
});

test("a field's additionalProperties may be a boolean or a value schema", () => {
  // JSON Schema allows `additionalProperties: false` on any object field. The
  // contract must accept it, or a generated client class (Kotlin) that decodes
  // it as an object rejects the whole form.
  const form = toRuntimeFormV2(RELEASED_RUNTIME_FORMS.get("builtin-pi.create.v3")!.definition) as unknown as {
    dataSchema: { properties: Record<string, Record<string, unknown>> };
  };
  const [name, field] = Object.entries(form.dataSchema.properties)[0]!;
  for (const additionalProperties of [false, true, { type: "string" }]) {
    const body = {
      ...form,
      dataSchema: { ...form.dataSchema, properties: { ...form.dataSchema.properties, [name]: { ...field, additionalProperties } } },
    };
    assert.equal(violation(body, { $ref: "#/$defs/Definition" }, ""), null, JSON.stringify(additionalProperties));
  }
  const fieldDef = contractSchema.$defs.FieldSchema?.properties?.additionalProperties;
  assert.deepEqual(fieldDef, {}, "additionalProperties is typed as any JSON, not an object shape");
});

// requiredClientCapabilities (README, "Protocol v2"): absent or null means [];
// a capability the client does not implement, or a value that is not a list of
// strings, makes the whole v2 form unavailable to that client.
const capabilitiesSample = JSON.parse(readFileSync(`${ROOT}fixtures/capabilities.form.json`, "utf8")) as Record<string, unknown>;

test("requiredClientCapabilities is part of the contract: the sample conforms and every generated type carries it", () => {
  assert.equal(violation(capabilitiesSample, { $ref: "#/$defs/Definition" }, ""), null);
  assert.deepEqual(contractSchema.$defs.Definition?.properties?.requiredClientCapabilities, { type: "array", items: { type: "string" } });
  assert.equal(contractSchema.$defs.Definition?.required?.includes("requiredClientCapabilities"), false, "optional");
  assert.match(
    violation({ ...capabilitiesSample, requiredClientCapabilities: [1] }, { $ref: "#/$defs/Definition" }, "") ?? "",
    /requiredClientCapabilities\/0: expected string/,
  );
  assert.match(readFileSync(`${ROOT}src/generated/runtimeFormV2.ts`, "utf8"), /requiredClientCapabilities\?: string\[\];/);
  assert.match(readFileSync(`${ROOT}generated/kotlin/RuntimeFormV2.kt`, "utf8"), /val requiredClientCapabilities: List<String>\? = null,/);
});

test("requiredClientCapabilities parses: absent or null is [], a listed capability is reported until the client implements it", () => {
  const sample = parseRuntimeFormV2(capabilitiesSample);
  assert.ok(sample);
  assert.deepEqual(sample.requiredClientCapabilities, ["select.custom_value"]);
  assert.deepEqual(missingRuntimeFormV2Capabilities(sample, new Set()), ["select.custom_value"]);
  assert.deepEqual(missingRuntimeFormV2Capabilities(sample, new Set(["select.custom_value"])), []);

  const builtin = parseRuntimeFormV2(toRuntimeFormV2(RELEASED_RUNTIME_FORMS.get("builtin-pi.create.v3")!.definition));
  assert.ok(builtin);
  assert.equal("requiredClientCapabilities" in toRuntimeFormV2(RELEASED_RUNTIME_FORMS.get("builtin-pi.create.v3")!.definition), false);
  assert.deepEqual(builtin.requiredClientCapabilities, [], "absent means []");
  assert.deepEqual(parseRuntimeFormV2({ ...capabilitiesSample, requiredClientCapabilities: null })?.requiredClientCapabilities, [], "null means []");
});

test("a malformed requiredClientCapabilities fails closed as a capability no client implements", () => {
  for (const malformed of ["select.custom_value", { name: "select.custom_value" }, [1], ["choice.labels", null], true]) {
    const parsed = parseRuntimeFormV2({ ...capabilitiesSample, requiredClientCapabilities: malformed });
    assert.ok(parsed, "the body is still a v2 form");
    assert.deepEqual(parsed.requiredClientCapabilities, [RUNTIME_FORM_V2_MALFORMED_CAPABILITY], JSON.stringify(malformed));
    assert.equal(missingRuntimeFormV2Capabilities(parsed, new Set(["select.custom_value", "choice.labels"])).length, 1);
  }
});

// Batch 2 fixtures (OpenCode, and the edit-only Kimi CLI and Gemini CLI):
// every served form and option source conforms to the contract, parses
// without blocking fields, and needs no client capability.
const BATCH_2_FORMS = ["opencode.form.json", "opencode.edit.json", "kimi.edit.json", "gemini.edit.json"];
const BATCH_2_OPTION_SOURCES = ["opencode.option-source.fallback.json", "kimi.option-source.fallback.json", "gemini.option-source.json"];
const fixture = (name: string) => JSON.parse(readFileSync(`${ROOT}fixtures/${name}`, "utf8")) as Record<string, unknown>;

test("batch 2 fixtures conform to the contract and render with the base renderer", () => {
  for (const name of BATCH_2_FORMS) {
    const body = fixture(name);
    assert.equal(violation(body, { $ref: "#/$defs/Definition" }, name), null);
    const parsed = parseRuntimeFormV2(body);
    assert.ok(parsed, name);
    assert.deepEqual(parsed.requiredClientCapabilities, [], name);
    assert.deepEqual(parsed.blockingFieldKeys, [], name);
    assert.ok(parsed.fields.every((field) => field.kind === "select" || field.kind === "string_map"), name);
    assert.ok(parsed.values && typeof parsed.values === "object" || name.endsWith(".form.json"), name);
  }
  for (const name of BATCH_2_OPTION_SOURCES) {
    const body = fixture(name);
    assert.equal(violation(body, { $ref: "#/$defs/OptionSource" }, name), null);
    assert.equal(body.kind, "select", name);
    const options = body.options as Array<{ value: string }>;
    assert.ok(options.length > 0 && options.some((option) => option.value === body.defaultValue), name);
  }
});

// Batch 3a (Codex, Grok): served forms (which list neither `choice.labels` nor
// `option_source.status`: both are always on), the option sources that carry
// `option_source.status`, and the hand-written `choice.labels` sample (which
// still lists the reserved name; clients accept it). The server-produced files are byte-locked by
// packages/server/src/services/runtimeFormV2Fixtures.test.ts; the hand-written
// samples are byte-locked here.
const BATCH_3A_FORMS: Record<string, string[]> = {
  "codex.form.json": ["select.custom_value"],
  "codex.edit.json": ["select.custom_value"],
  "grok.form.json": [],
  "choices.form.json": ["choice.labels"],
};
const BATCH_3A_SOURCES: Record<string, { status?: string; reason?: string; retryable?: boolean; custom?: boolean }> = {
  "codex.option-source.live.json": { status: "live", custom: true },
  "codex.option-source.fallback.json": { status: "fallback", reason: "missing_config", retryable: false, custom: true },
  "codex.option-source.unavailable.json": { status: "unavailable", reason: "machine_offline", retryable: true, custom: true },
  "choices.option-source.json": {},
};

test("batch 3a fixtures conform to the contract and declare exactly the capabilities they use", () => {
  for (const [name, capabilities] of Object.entries(BATCH_3A_FORMS)) {
    const body = fixture(name);
    assert.equal(violation(body, { $ref: "#/$defs/Definition" }, name), null);
    const parsed = parseRuntimeFormV2(body);
    assert.ok(parsed, name);
    assert.deepEqual(parsed.requiredClientCapabilities, capabilities, name);
    assert.deepEqual(parsed.blockingFieldKeys, [], name);
    assert.ok(parsed.fields.some((field) => field.choices), `${name} uses choice.labels`);
  }
  for (const [name, expected] of Object.entries(BATCH_3A_SOURCES)) {
    const body = fixture(name);
    assert.equal(violation(body, { $ref: "#/$defs/OptionSource" }, name), null);
    assert.equal(body.status, expected.status, name);
    assert.equal(body.reason, expected.reason, name);
    assert.equal(body.retryable, expected.retryable, name);
    assert.equal(body.customValueAllowed, expected.custom, name);
    if (body.status === "live") assert.ok(!("reason" in body) && !("retryable" in body), `${name}: live has no reason`);
    if (body.status === "unavailable") assert.deepEqual(body.options, [], `${name}: unavailable has no options`);
    for (const option of body.options as Array<Record<string, unknown>>) {
      if (name.startsWith("codex.")) assert.ok(Array.isArray(option.supportedReasoningEfforts) && option.supportedReasoningEfforts.length > 0, `${name} ${String(option.value)}`);
    }
  }
});

// Batch 3b (Claude, Cursor, Copilot): server-produced, byte-locked by the
// server's fixtures test. Each form lists only select.custom_value where it uses
// it; choices (choice.labels) follow the reasoning effort, never the list.
const BATCH_3B_FORMS: Record<string, string[]> = {
  "claude.form.json": ["select.custom_value"],
  "claude.edit.json": ["select.custom_value"],
  "cursor.form.json": ["select.custom_value"],
  "cursor.edit.json": ["select.custom_value"],
  // Copilot CLI is deprecated: edit-only, so it ships an edit fixture and no create form.
  "copilot.edit.json": ["select.custom_value"],
  // Antigravity (catalog-deprecated, revived on the OAR host): the same live-list form.
  "antigravity.edit.json": ["select.custom_value"],
};
// Forms with a reasoning effort, whose choices carry labels.
const BATCH_3B_CHOICES = new Set(["claude.form.json", "claude.edit.json", "copilot.edit.json", "antigravity.edit.json"]);
const BATCH_3B_SOURCES: Record<string, { status?: string; reason?: string; retryable?: boolean; custom: boolean; efforts: boolean }> = {
  "claude.option-source.provider.json": { custom: false, efforts: false },
  "claude.option-source.fallback.json": { status: "fallback", reason: "machine_offline", retryable: true, custom: true, efforts: true },
  "cursor.option-source.fallback.json": { status: "fallback", reason: "missing_config", retryable: false, custom: true, efforts: false },
  "copilot.option-source.live.json": { status: "live", custom: true, efforts: true },
  "claude.option-source.live.json": { status: "live", custom: true, efforts: true },
  "antigravity.option-source.live.json": { status: "live", custom: true, efforts: true },
};

test("batch 3b fixtures conform to the contract and declare exactly the capabilities they use", () => {
  for (const [name, capabilities] of Object.entries(BATCH_3B_FORMS)) {
    const body = fixture(name);
    assert.equal(violation(body, { $ref: "#/$defs/Definition" }, name), null);
    const parsed = parseRuntimeFormV2(body);
    assert.ok(parsed, name);
    assert.deepEqual(parsed.requiredClientCapabilities, capabilities, name);
    assert.deepEqual(parsed.blockingFieldKeys, [], name);
    assert.equal(parsed.fields.some((field) => field.choices), BATCH_3B_CHOICES.has(name), `${name}: choices on the reasoning effort`);
    if (name.endsWith(".edit.json")) assert.ok(parsed.values, name);
  }
  assert.equal(JSON.stringify(fixture("claude.edit.json")).includes("fixture-secret-must-not-appear"), false);
  for (const [name, expected] of Object.entries(BATCH_3B_SOURCES)) {
    const body = fixture(name);
    assert.equal(violation(body, { $ref: "#/$defs/OptionSource" }, name), null);
    assert.equal(body.status, expected.status, name);
    assert.equal(body.reason, expected.reason, name);
    assert.equal(body.retryable, expected.retryable, name);
    assert.equal(body.customValueAllowed === true, expected.custom, name);
    for (const option of body.options as Array<Record<string, unknown>>) {
      assert.equal(Array.isArray(option.supportedReasoningEfforts), expected.efforts, `${name} ${String(option.value)}`);
    }
  }
});

test("unavailableOptions: Claude's live source keeps unusable models out of `options`, which every older client offers", () => {
  const body = fixture("claude.option-source.live.json") as { options: Array<{ value: string }>; unavailableOptions: Array<{ value: string; label: string; reason?: string }> };
  assert.equal(violation(body, { $ref: "#/$defs/OptionSource" }, ""), null);
  const listed = new Set(body.options.map((option) => option.value));
    for (const option of body.unavailableOptions) assert.ok(!listed.has(option.value), option.value);
  assert.deepEqual(body.unavailableOptions[0], { value: "claude-opus-9", label: "Claude Opus 9", reason: "Update Claude Code to use this model" });
  // Only the runtime's own disabled models: never bundled models its list lacks.
  assert.deepEqual(body.unavailableOptions.map((option) => option.value), ["claude-opus-9"]);
  assert.match(violation({ ...body, unavailableOptions: [{ label: "no value" }] }, { $ref: "#/$defs/OptionSource" }, "") ?? "", /value: required/);
  // No fallback source carries it: the bundled list is not the Computer's.
  assert.ok(!("unavailableOptions" in fixture("claude.option-source.fallback.json")));
  assert.match(readFileSync(`${ROOT}generated/kotlin/RuntimeFormV2.kt`, "utf8"), /val unavailableOptions: List<RuntimeFormV2UnavailableOption>\? = null,/);
});

test("the status vocabulary is closed in the contract: an unknown status or reason is not a valid server body", () => {
  const live = { ...fixture("choices.option-source.json"), status: "live" };
  assert.equal(violation(live, { $ref: "#/$defs/OptionSource" }, ""), null);
  assert.match(violation({ ...live, status: "degraded" }, { $ref: "#/$defs/OptionSource" }, "") ?? "", /status: not in enum/);
  assert.match(violation({ ...live, reason: "probe_crashed" }, { $ref: "#/$defs/OptionSource" }, "") ?? "", /reason: not in enum/);
  assert.match(violation({ ...live, customValueAllowed: "yes" }, { $ref: "#/$defs/OptionSource" }, "") ?? "", /customValueAllowed: expected boolean/);
  const form = fixture("choices.form.json") as { uiSchema: { localization: Record<string, { choices: Record<string, unknown> }> } };
  const broken = structuredClone(form);
  broken.uiSchema.localization.tier!.choices.fast = { description: "no label" };
  assert.match(violation(broken, { $ref: "#/$defs/Definition" }, "") ?? "", /choices\/fast\/label: required/);
  assert.match(readFileSync(`${ROOT}generated/kotlin/RuntimeFormV2.kt`, "utf8"), /val customValueAllowed: Boolean\? = null,/);
  assert.match(readFileSync(`${ROOT}generated/kotlin/RuntimeFormV2.kt`, "utf8"), /data class RuntimeFormV2ChoiceCopy\(/);
});

test("hand-written batch 3a samples are byte-locked (change them only with a client-visible reason)", () => {
  const sha = (name: string) => createHash("sha256").update(readFileSync(`${ROOT}fixtures/${name}`)).digest("hex");
  assert.deepEqual({ form: sha("choices.form.json"), source: sha("choices.option-source.json") }, {
    form: "75fd1a7a157898bb4b5bbaa2b7f097cd7891b76a694e8d71e8f38a5637808417",
    source: "26f822b3c7d10d6d678c9e83a7833bd2639222d9b1c66621273690cea270bc4e",
  });
});

// Protocol v3 (`*.v3.json`): server-produced, byte-locked by
// packages/server/src/services/runtimeFormV3Fixtures.test.ts. v3 forms carry
// rules (never visibility), a revision, no capabilities, no x-optionsFrom or
// x-connectionOwned; v3 sources never put an unavailable option in `options`.
const V3_FORMS = [
  "builtin.form.v3.json", "builtin.form.saved-connections.v3.json", "builtin.edit.connection-unavailable.v3.json",
  "codex.form.v3.json", "codex.edit.v3.json", "grok.form.v3.json", "claude.form.v3.json", "claude.edit.v3.json",
  "copilot.edit.v3.json", "kimi-sdk.form.v3.json", "kimi-sdk.edit.v3.json", "pi.form.v3.json", "pi.edit.v3.json",
  "antigravity.edit.v3.json",
];
const V3_SOURCES = [
  "builtin.option-source.provider.saved-connections.v3.json", "codex.option-source.reasoning-effort.v3.json",
  "claude.option-source.reasoning-effort.v3.json", "kimi-sdk.option-source.reasoning-effort.v3.json",
  "pi.option-source.reasoning-effort.v3.json", "pi.option-source.provider-reasoning-effort.v3.json",
  "antigravity.option-source.reasoning-effort.v3.json",
];

test("v3 fixtures conform to the contract and parse as protocol 3 with nothing unsupported", () => {
  for (const name of V3_FORMS) {
    const body = fixture(name) as Record<string, unknown> & { uiSchema: Record<string, unknown>; dataSchema: { properties: Record<string, Record<string, unknown>> } };
    assert.equal(violation(body, { $ref: "#/$defs/Definition" }, name), null);
    assert.equal(body.protocolVersion, 3, name);
    assert.ok(typeof body.revision === "string" && body.revision, `${name}: revision`);
    assert.equal("requiredClientCapabilities" in body, false, name);
    assert.equal("visibility" in body.uiSchema, false, name);
    for (const [key, property] of Object.entries(body.dataSchema.properties)) {
      assert.equal("x-optionsFrom" in property, false, `${name}/${key}`);
      assert.equal("x-connectionOwned" in property, false, `${name}/${key}`);
    }
    const parsed = parseRuntimeFormV2(body);
    assert.ok(parsed, name);
    assert.equal(parsed.protocolVersion, 3);
    assert.deepEqual(parsed.requiredClientCapabilities, [], name);
    assert.deepEqual(parsed.blockingFieldKeys, [], name);
    assert.ok(!parsed.fields.some((field) => field.kind === "derived_select"), `${name}: no derived_select on v3`);
  }
  for (const name of V3_SOURCES) {
    const body = fixture(name) as Record<string, unknown>;
    assert.equal(violation(body, { $ref: "#/$defs/OptionSource" }, name), null);
    for (const option of (body.options ?? []) as Array<Record<string, unknown>>) assert.equal("unavailable" in option, false, `${name}: ${String(option.value)}`);
    for (const options of Object.values((body.optionsByValue ?? {}) as Record<string, Array<{ value: string; label: string }>>)) {
      assert.deepEqual(options[0], { value: "", label: "Default" }, `${name}: the server-sent Default comes first`);
    }
  }
});
