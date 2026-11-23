/**
 * Released runtime form versions are frozen (task #1217, packages/runtime-form).
 *
 * Until v1 was retired (2026-11-18; its route now answers 410) the route
 * answered a released schemaVersion from its frozen sample in
 * @botiverse/raft-runtime-form. The builders still back submit validation and
 * the v2 conversion, so every released version must have a sample, and while the
 * code builder is still the source of server-side validation for that version it
 * must produce exactly the sample, so the form clients render and the rules the
 * server enforces cannot drift apart.
 *
 * A red here has two legal fixes: revert an unintended drift, or bump the
 * schemaVersion and add a new sample. Rewriting an existing sample is not one.
 */
import assert from "node:assert/strict";

import { RELEASED_RUNTIME_FORMS } from "@botiverse/raft-runtime-form";

import {
  buildBuiltInPiFormDefinition,
  buildBuiltInPiFormOptionSource,
  buildKimiSdkFormDefinition,
} from "./runtimeFormDefinitionService";

// JSON round trip: the sample is the wire body, so compare what res.json would send.
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const servedDefinitions = [buildBuiltInPiFormDefinition(), buildKimiSdkFormDefinition()];

test("every served runtime form version has a released sample", () => {
  for (const definition of servedDefinitions) {
    assert.ok(
      RELEASED_RUNTIME_FORMS.has(definition.schemaVersion),
      `${definition.schemaVersion} has no released sample: a new schemaVersion needs one captured from the released server`,
    );
  }
});

test("the code builder for a released version produces exactly its released sample", () => {
  for (const definition of servedDefinitions) {
    assert.deepEqual(
      wire(definition),
      RELEASED_RUNTIME_FORMS.get(definition.schemaVersion)?.definition,
      `${definition.schemaVersion} drifted from its released shape: revert the change, or bump the schemaVersion and add a new sample`,
    );
  }
});

test("Built-in Pi provider options may grow but never drop a released provider id", () => {
  // Saved agents and installed clients carry a providerId; removing one strands them.
  // Model catalogs are data that providers retire, so they are not frozen here.
  const released = RELEASED_RUNTIME_FORMS.get(buildBuiltInPiFormDefinition().schemaVersion)?.releasedOptionIds;
  assert.ok(released, "the Built-in Pi sample records its released provider ids");
  const provider = buildBuiltInPiFormOptionSource("provider");
  assert.equal(provider?.kind, "select");
  const served = new Set(provider.options.map((option) => option.value));
  for (const id of released.provider) assert.ok(served.has(id), `provider option ${id} was released and must stay`);
});
