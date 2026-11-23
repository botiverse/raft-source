import assert from "node:assert/strict";
import { test } from "vitest";
import { configForms, type RuntimeConfigForm } from "@botiverse/oar/forms";
import { narrowOarForm, reasoningModelOptionsFromOar } from "./runtimeFormFromOar";
import { GROK_RAFT_NARROWING, grokRaftForm, runtimeFormV2Entry } from "./runtimeFormV2Registry";

/** OAR's Grok form: what the runtime accepts. */
const oarGrok = configForms.grok as RuntimeConfigForm;
/** What Raft serves: OAR's form narrowed. */
const grok = grokRaftForm;

test("the projection refuses OAR form shapes the v2 builder cannot serve", () => {
  const base = grok.fields;
  const withText: RuntimeConfigForm = { ...grok, fields: [...base, { id: "x", kind: "text", required: false, label: { key: "k", en: "X" } }] };
  assert.throws(() => reasoningModelOptionsFromOar(withText), /field x \(text\)/);
  const withInherit: RuntimeConfigForm = { ...grok, fields: base.map((field) => field.kind === "model" ? { ...field, modes: ["inherit", "preset"] as const } : field) };
  assert.throws(() => reasoningModelOptionsFromOar(withInherit), /inherit/);
  assert.deepEqual(reasoningModelOptionsFromOar(grok), {
    customModel: false, fastMode: false, reasoning: true, modelHint: "Models available from this computer's Grok CLI.",
  });
});

// Edit path, unchanged by the migration and pinned so it stays so: a stored
// typed Grok model reads back into the form exactly like a listed one (the edit
// form is identical), and today's save turns an unchanged one into a preset.
// Changing that save is a behavior change, tracked separately, not part of
// moving the form into OAR.
test("edit: a stored custom Grok model reads back like a preset; today's no-change save writes a preset", () => {
  const entry = runtimeFormV2Entry("grok");
  assert.ok(entry);
  const base = { version: 1, runtime: "grok", mode: { kind: "default" }, reasoningEffort: null, envVars: null };
  const custom = { ...base, model: { kind: "custom", name: "grok-4" } };
  const preset = { ...base, model: { kind: "preset", id: "grok-4" } };
  const values = entry.valuesFromRuntimeConfig(custom);
  assert.deepEqual(values, entry.valuesFromRuntimeConfig(preset));
  const saved = entry.runtimeConfigFromValues(values ?? {}, null, {});
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.ok ? saved.runtimeConfig.model : null, { kind: "preset", id: "grok-4" });
});

test("Raft's Grok form only narrows OAR's: nothing offered that OAR does not, nothing required made optional", () => {
  const modelOf = (form: RuntimeConfigForm) => form.fields.find((field) => field.kind === "model");
  const oarModel = modelOf(oarGrok);
  const raftModel = modelOf(grok);
  assert.ok(oarModel?.kind === "model" && raftModel?.kind === "model");
  assert.deepEqual(raftModel.modes.filter((mode) => !oarModel.modes.includes(mode)), []);
  assert.ok(raftModel.required || !oarModel.required);
  assert.deepEqual(raftModel.launchModes, oarModel.launchModes ?? oarModel.modes);
  assert.deepEqual(grok.fields.map((field) => field.id), oarGrok.fields.map((field) => field.id));
  // The narrowing itself refuses to widen or to relax.
  const presetOnly: RuntimeConfigForm = { ...oarGrok, fields: oarGrok.fields.map((field) => field.kind === "model" ? { ...field, modes: ["preset"] } : field) };
  assert.throws(() => narrowOarForm(presetOnly, { ...GROK_RAFT_NARROWING, modes: ["preset", "custom"] }), /does not/);
  const required: RuntimeConfigForm = { ...oarGrok, fields: oarGrok.fields.map((field) => field.kind === "model" ? { ...field, required: true } : field) };
  assert.throws(() => narrowOarForm(required, { ...GROK_RAFT_NARROWING, required: false }), /optional/);
  const hintless: RuntimeConfigForm = { ...oarGrok, fields: oarGrok.fields.map((field) => field.kind === "model" ? { ...field, hint: undefined } : field) };
  assert.throws(() => narrowOarForm(hintless, GROK_RAFT_NARROWING), /hint/);
});
