// The first-party apps on for a server (AgentConfig.enabledApps, the agent
// context's features.enabledApps): each app's own flag, per server, in
// registry order. Real flag evaluation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FirstPartyApp } from "../platform/apps";
import { dbTest as test } from "../test/integration/dbTest";
import { createFeatureFlag, createFeatureFlagRule } from "./featureFlagService";
import { enabledFirstPartyAppIds } from "./firstPartyAppFlags";

const app = (id: string): FirstPartyApp => ({
  id,
  flag: `${id}_v0`,
  objectKinds: [{ kind: `${id}-object`, events: ["edited"], objectTables: [], homes: async () => new Map(), parseRef: (ref) => ref, summarize: async () => [] }],
  systemApp: `system.${id}`,
});

test("lists the apps whose flag is on for the server, in registry order, and none for an empty registry", async ({ db: _db }) => {
  const serverId = randomUUID();
  const otherServerId = randomUUID();
  const apps = [app("zulu"), app("alpha"), app("mike")];
  await createFeatureFlag({ key: "zulu_v0", randomizationUnit: "server", defaultEnabled: false });
  await createFeatureFlag({ key: "alpha_v0", randomizationUnit: "server", defaultEnabled: true });
  // mike_v0 has no flag row: off.
  assert.deepEqual(await enabledFirstPartyAppIds(serverId, "test", apps), ["alpha"]);
  await createFeatureFlagRule({ flagKey: "zulu_v0", stage: "server", decision: "allow", values: [serverId] });
  assert.deepEqual(await enabledFirstPartyAppIds(serverId, "test", apps), ["zulu", "alpha"]);
  assert.deepEqual(await enabledFirstPartyAppIds(otherServerId, "test", apps), ["alpha"]);
  assert.deepEqual(await enabledFirstPartyAppIds(serverId, "test", []), []);
});
