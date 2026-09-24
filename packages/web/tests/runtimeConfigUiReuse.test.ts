import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const createAgentSource = readFileSync(
  new URL("../src/components/agent/CreateAgentDialog.tsx", import.meta.url),
  "utf8",
);
const agentDetailSource = readFileSync(
  new URL("../src/components/agent/AgentDetailPanel.tsx", import.meta.url),
  "utf8",
);
const runtimeConfigFieldsSource = readFileSync(
  new URL("../src/components/agent/RuntimeConfigFields.tsx", import.meta.url),
  "utf8",
);
const webSrcRoot = fileURLToPath(new URL("../src", import.meta.url));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return listSourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry) ? [fullPath] : [];
  });
}

test("create and edit agent flows share the runtime config field component", () => {
  assert.match(createAgentSource, /<RuntimeConfigFields[\s\S]*envVarsMode="advanced"/);
  assert.match(agentDetailSource, /<RuntimeConfigFields[\s\S]*envVarsMode="advanced"/);
  assert.match(createAgentSource, /providerApiKey=\{providerApiKey\}/);
  assert.match(agentDetailSource, /providerApiKey=\{draftProviderApiKey\}/);
});

test("edit runtime choices follow daemon-detected availability like create agent", () => {
  assert.match(agentDetailSource, /useExistingAgentRuntimeSelectionOptions\(\s*agent\.id,\s*availableRuntimes,/);
  assert.match(agentDetailSource, /const runtimeOptions = runtimeAdmissionOptions\.flatMap/);
  assert.match(agentDetailSource, /disabled: !option\.canSelectInThisContext,/);
  assert.match(agentDetailSource, /runtimeCanSelect: draftRuntimeCanSelect/);
  assert.doesNotMatch(agentDetailSource, /Array\.from\(new Set\(\[\s*agent\.runtime/);
});

test("web runtime picker surfaces do not import the raw runtime registry directly", () => {
  const offenders = listSourceFiles(webSrcRoot)
    .filter((file) => /\/components\/(agent|machine|onboarding)\//.test(file))
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return /import\s*\{[^}]*\bRUNTIMES\b[^}]*\}\s*from\s*["']@botiverse\/raft-shared["']/.test(source);
    })
    .map((file) => relative(webSrcRoot, file));

  assert.deepEqual(offenders, []);
});

test("runtime config fields keep the create-agent model rescan layout", () => {
  // Was a hand-rolled <label>; now a FormField (cindyz 2026-08-22: the hand-rolled
  // labels structurally could not carry a required marker). The rescan control still
  // sits in the label row, and the label is still translated rather than hardcoded.
  // `<Field>` is the local indirection that picks StableField (reserved message
  // row) or plain FormField, per the page's opt-in — see StableField.tsx.
  assert.match(runtimeConfigFieldsSource, /<Field\s+label=\{formatMessage\(\{ id: "agent\.runtimeConfig\.model" \}\)\}/);
  assert.match(runtimeConfigFieldsSource, /className="ml-auto text-black\/40 hover:text-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"/);
  assert.doesNotMatch(runtimeConfigFieldsSource, /<FormField label="Model">/);
});

test("Built-in gateway and schema-backed model fields do not inherit host model defaults", () => {
  assert.match(runtimeConfigFieldsSource, /const customModelInputMode = customModelMode \|\| builtInGatewayProvider;/);
  assert.match(runtimeConfigFieldsSource, /: builtInGatewayProvider \? \[\] : modelOptions;/);
  assert.match(runtimeConfigFieldsSource, /const machineSourceApplies = \(!providerModelList && !builtInGatewayProvider\) \|\| builtInCatalogApplies;/);
  assert.match(runtimeConfigFieldsSource, /const showHeaderRescan = machineSourceApplies/);
  // `<FieldAction>` is the local indirection that renders a tokenised raft-ui
  // Button when the page opted in, and the original raw button otherwise —
  // so Agent Details keeps its appearance. The property this guard protects,
  // "the rescan control sits in the label row", is unchanged.
  assert.match(runtimeConfigFieldsSource, /labelAccessory=\{showHeaderRescan \? \(\s*<FieldAction/);
  assert.match(runtimeConfigFieldsSource, /\{builtInGatewayProvider \? null : \(\s*<RuntimeSelectControl/);
  assert.match(runtimeConfigFieldsSource, /id: builtInGatewayProvider[\s\S]*"agent\.runtimeConfig\.gatewayModelId"/);
  assert.match(createAgentSource, /if \(schemaBacked \|\| customModelMode \|\| builtInGatewayModelRequired\) return;/);
});

test("custom provider API key stays in the shared provider field surface", () => {
  // `\s+` rather than a literal space: the Field gained an `error` prop and now
  // spans several lines, so `label` and `required` are no longer adjacent on one.
  // What this test is for is that the API key field still lives here, labelled and
  // required — not how the JSX happens to be wrapped.
  assert.match(runtimeConfigFieldsSource, /label=\{formatMessage\(\{ id: "agent\.runtimeConfig\.apiKey" \}\)\}\s+required/);
  assert.match(runtimeConfigFieldsSource, /type="password"/);
  assert.match(runtimeConfigFieldsSource, /id: "agent\.runtimeConfig\.providerHint"/);
});

test("edit runtime config rejects a selected Pi built-in provider without an API key", () => {
  assert.match(agentDetailSource, /const draftPiProviderApiKeyInvalid = supportsRuntimePiProvider\(draftRuntime\)/);
  assert.match(agentDetailSource, /piProviderApiKeyInvalid: draftPiProviderApiKeyInvalid/);
  assert.match(agentDetailSource, /disabled=\{runtimeConfigSaveDisabled\}/);
});

test("reasoning effort keeps omitted Claude Code effort as Default, not implicit medium", () => {
  // The state has to carry runtime-owned Kimi effort ids without collapsing to
  // a client enum or an unbounded local `string`. It is still seeded through
  // reconcileReasoningEffort: models with a supported set (GPT-5.6) get their
  // default (Medium); Claude Code declares no set, so (..., null) stays null →
  // "Default" and does not manufacture a new value.
  assert.match(createAgentSource, /import type \{[^}]*\bRuntimeReasoningEffort\b[^}]*\} from "@botiverse\/raft-shared";/);
  assert.match(createAgentSource, /useState<RuntimeReasoningEffort \| null>\(\s*reconcileReasoningEffort\([^)]*null\)/);
  assert.doesNotMatch(createAgentSource, /useState<string \| null>\(\s*reconcileReasoningEffort/);
  assert.match(runtimeConfigFieldsSource, /label: formatMessage\(\{ id: "agent\.runtimeConfig\.default" \}\)/);
  assert.match(runtimeConfigFieldsSource, /value === DEFAULT_REASONING_EFFORT_SELECT_VALUE\s*\?\s*null\s*:\s*value as ReasoningEffort/);
  assert.doesNotMatch(runtimeConfigFieldsSource, /value=\{reasoningEffort \|\| "medium"\}/);
  assert.match(agentDetailSource, /currentRuntimeConfig\.reasoningEffort\s*\?\s*formatMessage\(\{ id: reasoningEffortLabelId\(currentRuntimeConfig\.reasoningEffort\)/);
  assert.doesNotMatch(agentDetailSource, /\(draftReasoningEffort \?\? null\) !== \(agent\.reasoningEffort \?\? null\)/);
});

// task #22: selecting a saved Provider connection means the credential comes from
// the connection reference, so the agent-local built-in provider block (provider
// picker, API key, gateway base URL, image-input) must not render at all. The
// sibling schema-driven section already guards every field with the same flag;
// this block was the one that missed it, which is why picking `ds 官方 api` still
// demanded a DeepSeek key. Behavior is covered by
// agentRuntimeConnectionFields.behavior.test.tsx; this one only pins the source
// form so the guard cannot be silently dropped.
test("connection mode hides the agent-local built-in provider fields", () => {
  assert.match(
    runtimeConfigFieldsSource,
    /\{builtInProviderSupported && !managedConnectionActive && \(/,
  );
  // The unguarded form is the regression: it renders a required API key field
  // (and its red "needs an API key" hint) while a connection is selected.
  assert.doesNotMatch(runtimeConfigFieldsSource, /\{builtInProviderSupported && \(/);
});

// task #22 wiring tooth. The pure predicates are covered by their own tests and
// the real dialog covers field hiding, but neither can see whether the panel
// actually CALLS the credential helper: replacing that call with an inline
// predicate that drops !managedConnectionActive leaves every behavior test green
// while a connection-backed agent is blocked from saving again.
//
// Bounded with [^;] rather than [\s\S] on purpose. A cross-declaration pattern
// matched a different `managedConnectionActive` eight lines away, so deleting the
// real guard still passed — the tooth could not go red at all.
test("the panel wires the credential helper into the save gate", () => {
  assert.match(
    agentDetailSource,
    // Shorthand (or explicit self-reference) only: matching the bare token would
    // also accept `managedConnectionActive: false`, which hardcodes the guard off
    // and reproduces the original bug while the tooth stays green. Found by
    // mutating this assertion rather than trusting it.
    /const draftBuiltInProviderApiKeyInvalid = isBuiltInProviderApiKeyInvalid\(\{[^;]*?managedConnectionActive(?:,|: managedConnectionActive,)[^;]*?\}\);/,
    "the panel must pass the live managedConnectionActive value, not a literal",
  );
  assert.match(
    agentDetailSource,
    /const runtimeConfigSaveDisabled = isRuntimeConfigSaveDisabled\(\{[^;]*?builtInProviderApiKeyInvalid: draftBuiltInProviderApiKeyInvalid[^;]*?\}\);/,
    "the credential result must be fed into the save gate",
  );
  assert.match(agentDetailSource, /disabled=\{runtimeConfigSaveDisabled\}/,
    "the submit button must render the gate's result, not a hand-built OR");
});
