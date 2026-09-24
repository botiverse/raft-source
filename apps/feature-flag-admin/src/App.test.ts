import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  audienceKeyValid,
  AudiencesSurface,
  defaultTargetRuleId,
  EvaluationPath,
  previewBody,
  serverAllowlistBody,
  serverCatalogPath,
  serverDisplayLabel,
  serverPickerMutation,
  ServerTargetPicker,
  serverTargetIsSelected,
  surfaceForPath,
  UNKNOWN_SERVER_LABEL,
} from "./App";

const PARTNER_RULE_ID = "a4362b16-4c5f-443a-853a-103648ff3c34";

function detailWithRules(rules: Array<{ ruleId: string; priority: number; serverTargets: Array<{ serverSlug: string | null; status: "active" | "unknown_or_deleted" }> }>) {
  return { serverAllowlistRules: rules } as Parameters<typeof defaultTargetRuleId>[1];
}

test("agent migration defaults only to the explicit partner rule id", () => {
  const detail = detailWithRules([
    { ruleId: PARTNER_RULE_ID, priority: -20, serverTargets: [{ serverSlug: "partner", status: "active" }] },
    { ruleId: "31a4b75b-c7d7-4f25-969c-ad492dd90050", priority: 0, serverTargets: [{ serverSlug: "botiverse", status: "active" }] },
  ]);

  assert.equal(defaultTargetRuleId("agent_migration_v0", detail), PARTNER_RULE_ID);
  assert.equal(defaultTargetRuleId("another_flag", detail), "");
});

test("audiences have a real route and stable typed-key admission", () => {
  assert.equal(surfaceForPath("/audiences"), "audiences");
  assert.equal(surfaceForPath("/audiences/insiders"), "audiences");
  assert.equal(surfaceForPath("/labs"), "labs");
  assert.equal(surfaceForPath("/unknown"), "flags");
  assert.equal(audienceKeyValid("internal_insiders"), true);
  assert.equal(audienceKeyValid("Internal Insiders"), false);
});

test("audience UI exposes reusable user OR server membership, draft creation, and affected flags", () => {
  const html = renderToStaticMarkup(createElement(AudiencesSurface, {
    audiences: [{
      audienceKey: "insiders",
      name: "Insiders",
      description: "Reusable cohort",
      enabled: true,
      members: [
        { memberId: "00000000-0000-4000-8000-000000000001", kind: "user", userId: "00000000-0000-4000-8000-000000000002", status: "active" },
        { memberId: "00000000-0000-4000-8000-000000000003", kind: "server", serverSlug: "internal-alpha", status: "active" },
      ],
      affectedFlags: ["example_v0"],
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    }],
    serverOptions: [{ serverSlug: "internal-alpha" }],
    serverSearch: "internal",
    onServerSearch: () => undefined,
    serverOptionsLoading: false,
    serverOptionsError: null,
    reason: "review audience",
    onReason: () => undefined,
    busyAction: null,
    configVersion: 4,
    onCreate: async () => true,
    onUpdate: async () => true,
  }));
  assert.match(html, /Named audiences/);
  assert.match(html, /User IDs \(one per line\)/);
  assert.match(html, /matching any listed user ID or any selected server is enough/i);
  assert.match(html, /Create audience draft/);
  assert.match(html, /example_v0/);
});

test("agent migration never guesses a target by priority", () => {
  const detail = detailWithRules([
    { ruleId: "11111111-1111-4111-8111-111111111111", priority: -20, serverTargets: [{ serverSlug: "partner", status: "active" }] },
    { ruleId: "31a4b75b-c7d7-4f25-969c-ad492dd90050", priority: 0, serverTargets: [{ serverSlug: "botiverse", status: "active" }] },
  ]);

  assert.equal(defaultTargetRuleId("agent_migration_v0", detail), "");
});

test("evaluation path renders canonical precedence, named Labs, and explicit Fallback", () => {
  const detail = {
    flag: {
      key: "example_v0",
      description: null,
      enabled: true,
      killSwitch: false,
      randomizationUnit: "server",
      defaultEnabled: false,
      defaultVariant: null,
      updatedAt: "2026-07-22T00:00:00.000Z",
    },
    rules: [
      { id: "lab-late", stage: "lab", priority: 20, decision: "deny", values: ["lab_a"], percentageBasisPoints: null, variant: null, updatedAt: "2026-07-22T00:00:00.000Z" },
      { id: "server-first", stage: "server", priority: 100, decision: "allow", serverTargets: [{ serverSlug: "partner-alpha", status: "active" }], percentageBasisPoints: null, variant: null, updatedAt: "2026-07-22T00:00:00.000Z" },
      { id: "lab-early", stage: "lab", priority: 10, decision: "allow", values: ["lab_a"], percentageBasisPoints: null, variant: null, updatedAt: "2026-07-22T00:00:00.000Z" },
    ],
    serverAllowlist: { managed: true, ruleId: null, serverTargets: [] },
    serverAllowlistRules: [],
    unsupportedRuleShapes: [],
  } as Parameters<typeof EvaluationPath>[0]["detail"];
  const labs = [{
    labKey: "lab_a",
    name: "Agent Inbox",
    description: "Try the new inbox.",
    state: "open",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  }] as Parameters<typeof EvaluationPath>[0]["labs"];

  const html = renderToStaticMarkup(createElement(EvaluationPath, {
    detail,
    labs,
    audiences: [],
    reason: "review rollout",
    busyAction: null,
    onFallback: async () => undefined,
    onRemoveLabRule: async () => undefined,
    onRemoveAudienceRule: async () => undefined,
  }));

  assert.ok(html.indexOf("partner-alpha") < html.indexOf("Agent Inbox"));
  assert.doesNotMatch(html, /server-a/);
  assert.ok(html.indexOf("priority 10") < html.indexOf("priority 20"));
  assert.ok(html.indexOf("Fallback") > html.indexOf("priority 20"));
  assert.match(html, /first matching allow or deny stops evaluation/i);
  assert.match(html, /Set On/);
});

test("server targets display exact active slugs and opaque unknown/deleted labels", () => {
  assert.equal(serverDisplayLabel({ serverSlug: "partner-alpha", status: "active" }), "partner-alpha");
  assert.equal(serverDisplayLabel({ serverSlug: null, status: "unknown_or_deleted" }), UNKNOWN_SERVER_LABEL);
});

test("allowlist and preview request helpers emit serverSlug and never serverId", () => {
  const mutation = serverAllowlistBody(" partner-alpha ", PARTNER_RULE_ID, " rollout ", 7);
  const preview = previewBody(" partner-beta ", " user-1 ");

  assert.deepEqual(mutation, {
    serverSlug: "partner-alpha",
    targetRuleId: PARTNER_RULE_ID,
    reason: "rollout",
    expectedConfigVersion: 7,
  });
  assert.deepEqual(preview, { serverSlug: "partner-beta", userId: "user-1" });
  assert.equal("serverId" in mutation, false);
  assert.equal("serverId" in preview, false);
  assert.deepEqual(previewBody("", "user-only"), { userId: "user-only" });
  assert.deepEqual(previewBody("server-only", ""), { serverSlug: "server-only" });
  assert.deepEqual(previewBody("", ""), {});
});

test("server catalog search and selection remain slug-only", () => {
  const targets = [
    { serverSlug: "internal-alpha", status: "active" as const },
    { serverSlug: null, status: "unknown_or_deleted" as const },
  ];
  assert.equal(serverCatalogPath(" Internal-Alpha "), "/api/operator/servers?query=internal-alpha");
  assert.equal(serverTargetIsSelected(targets, "internal-alpha"), true);
  assert.equal(serverTargetIsSelected(targets, "insider-beta"), false);
  assert.equal(serverPickerMutation(false, false), "create");
  assert.equal(serverPickerMutation(false, true), "add");
  assert.equal(serverPickerMutation(true, true), "remove");

  const html = renderToStaticMarkup(createElement(ServerTargetPicker, {
    options: [{ serverSlug: "internal-alpha" }, { serverSlug: "insider-beta" }],
    selectedTargets: targets,
    search: "in",
    onSearch: () => undefined,
    loading: false,
    error: null,
    disabled: false,
    onToggle: () => undefined,
    createsFirstRule: false,
  }));

  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /internal-alpha/);
  assert.match(html, /insider-beta/);
  assert.match(html, /Choose exact active servers/);
  assert.doesNotMatch(html, /serverId|server-id/i);
});

test("App source routes visible server rule values through the slug projection", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok((source.match(/serverDisplayLabel\(/g) ?? []).length >= 2);
  assert.doesNotMatch(source, />\s*Server id\s*</);
  assert.doesNotMatch(source, />\{id\}<\/span>/);
});
