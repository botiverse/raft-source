import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { vi } from "vitest";
import { INBOX_ITEMS_LAUNCH_AT_ENV } from "../services/agentInboxItems";
// GET /internal/agent-api/context — identity bootstrap. A managed agent gets
// its identity and the CLI guide from the standing prompt its daemon builds;
// an external agent asks here. The prompt must be the daemon's self-hosted
// render (one shared builder), not a second copy of the text.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  buildRaftCliGuideMarkdown,
  CONTINUATIONS_PILOT_FEATURE_FLAG_KEY,
  guideAppCapabilities,
  INBOX_ITEMS_CAPABILITY,
  MANUAL_CONTEXT_CAPABILITY,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  type AgentApiAgentContextResponse,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { eq } from "drizzle-orm";
import { agents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, createFeatureFlag, createFeatureFlagRule, REMINDER_APP_FEATURE_FLAG_KEY, VAULT_APP_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { __answerFlagForTests } from "../services/deploymentAnsweredFlags";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seed() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `agent-context-${suffix}@slock.test`,
    name: `agent-context-${suffix}`,
    displayName: "Context Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Context Test Server", `agent-context-${suffix.slice(0, 8)}`, owner!.id);
  return { server, ownerId: owner!.id };
}

/** What a current CLI declares: the Manual context contract and the app entries it carries. */
const CLI_CAPABILITIES = [MANUAL_CONTEXT_CAPABILITY, ...guideAppCapabilities()].join(",");

async function getContext(baseUrl: string, apiKey: string, capabilities?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (capabilities !== undefined) headers[RAFT_CLIENT_CAPABILITIES_HEADER] = capabilities;
  return fetch(`${baseUrl}/internal/agent-api/context`, { headers });
}

test("GET /context returns an external agent's identity, credential capabilities, and the daemon's self-hosted guide render", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-external", {
    runtime: "external",
    model: "external",
    description: "Reviews pull requests",
  });
  await getDb().update(agents).set({ displayName: "Context External" }).where(eq(agents.id, agent.id));
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "ctx", issuedVia: "computer", createdByUserId: null });

  const res = await getContext(app.baseUrl, minted.apiKey);
  assert.equal(res.status, 200);
  const body = await res.json() as AgentApiAgentContextResponse;
  assert.deepEqual(body.agent, {
    id: agent.id,
    name: "ctx-external",
    displayName: "Context External",
    description: "Reviews pull requests",
    runtime: "external",
    external: true,
    assistantOf: null,
    serverRole: "member",
  });
  assert.deepEqual(body.server, { id: server.id, slug: server.slug, name: "Context Test Server" });
  assert.deepEqual([...body.credential.capabilities].sort(), ["read", "send"]);
  assert.equal(body.prompt?.audience, "self-hosted-runner");
  assert.equal(body.prompt?.text, buildRaftCliGuideMarkdown({
    handle: "ctx-external",
    displayName: "Context External",
    description: "Reviews pull requests",
    serverName: "Context Test Server",
    serverRole: "member",
  }));
  assert.match(body.prompt!.text, /Your server role is member\. Permission checks always use your current role/);
  assert.match(body.prompt!.text, /You are "Context External" \(@ctx-external\), an external AI agent in the Raft server "Context Test Server"/);
  assert.match(body.prompt!.text, /Initial role: Reviews pull requests\./);
  assert.match(body.prompt!.text, /reminders_unsupported_for_external_agents/);
  assert.doesNotMatch(body.prompt!.text, /<your-handle>|<your-display-name>/);
});

test("GET /context returns no prompt for a managed agent: its prompt comes from its daemon", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-managed", { runtime: "claude" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null });

  const res = await getContext(app.baseUrl, minted.apiKey);
  assert.equal(res.status, 200);
  const body = await res.json() as AgentApiAgentContextResponse;
  assert.equal(body.agent.external, false);
  assert.equal(body.agent.name, "ctx-managed");
  assert.equal(body.prompt, null);
});

test("GET /context is gated by the read capability", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-noread", { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send"], name: "ctx", issuedVia: "computer", createdByUserId: null });

  const res = await getContext(app.baseUrl, minted.apiKey);
  assert.equal(res.status, 403);
  const body = await res.json() as { code?: string; requiredCapability?: string };
  assert.equal(body.code, "capability_not_authorized");
  assert.equal(body.requiredCapability, "read");
});

test("GET /context reports the server's app rollout flags, the values a Computer gets at agent start", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-features", { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null });
  const features = async () => (await (await getContext(app.baseUrl, minted.apiKey)).json() as AgentApiAgentContextResponse).features;

  assert.deepEqual(await features(), { reminderApp: false, vaultApp: false, enabledApps: [] }, "no flags: both off, no apps");
  await createFeatureFlag({ key: REMINDER_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  await createFeatureFlagRule({ flagKey: REMINDER_APP_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [server.id] });
  await createFeatureFlag({ key: VAULT_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  assert.deepEqual(await features(), { reminderApp: true, vaultApp: false, enabledApps: [] });
});

test("GET /context lists Artifacts among the first-party apps while the deployment has it, beside the unchanged booleans, and renders the prompt from them", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-apps", { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null });
  const context = async () => await (await getContext(app.baseUrl, minted.apiKey, CLI_CAPABILITIES)).json() as AgentApiAgentContextResponse;

  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  assert.deepEqual((await context()).features, { reminderApp: false, vaultApp: false, enabledApps: [] }, "Artifacts off: not listed");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const on = await context();
  assert.deepEqual(on.features, { reminderApp: false, vaultApp: false, enabledApps: ["artifacts"] });
  // The route passes enabledApps to the guide: the Artifacts entry's line is in the text.
  assert.match(on.prompt?.text ?? "", /raft artifact /);
  assert.equal(on.prompt?.text, buildRaftCliGuideMarkdown({
    handle: "ctx-apps",
    displayName: "ctx-apps",
    description: null,
    serverName: "Context Test Server",
    serverRole: "member",
  }, { enabledApps: ["artifacts"] }));
});

test("GET /context lists to a personal assistant only the apps its credential can reach: none of Artifacts' routes, so no app", async ({ app }) => {
  const { server, ownerId } = await seed();
  const keyOf = async (name: string) => {
    const agent = await createAgent(server.id, name, { runtime: "external", model: "external" });
    return { agent, apiKey: (await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null })).apiKey };
  };
  const ordinary = await keyOf("ctx-apps-ordinary");
  const assistant = await keyOf("ctx-apps-helper");
  await getDb().update(agents).set({ assistantOwnerUserId: ownerId }).where(eq(agents.id, assistant.agent.id));
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const features = async (apiKey: string) => (await (await getContext(app.baseUrl, apiKey, CLI_CAPABILITIES)).json() as AgentApiAgentContextResponse).features;

  assert.deepEqual((await features(ordinary.apiKey))?.enabledApps, ["artifacts"], "control: Artifacts on");
  assert.deepEqual(await features(assistant.apiKey), { reminderApp: false, vaultApp: false, enabledApps: [] });
});

test("GET /context reports the continuation pilot only while it is on for the agent's server, for managed and external agents alike", async ({ app }) => {
  const { server } = await seed();
  const other = await seed();
  const keyOf = async (name: string, runtime: string) => {
    const agent = await createAgent(server.id, name, { runtime, model: runtime });
    return (await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null })).apiKey;
  };
  const external = await keyOf("ctx-pilot-external", "external");
  const managed = await keyOf("ctx-pilot-managed", "claude");
  const features = async (apiKey: string) => (await (await getContext(app.baseUrl, apiKey)).json() as AgentApiAgentContextResponse).features;

  // The flag row ships with its migration, default off: the features keep their shape.
  for (const apiKey of [external, managed]) {
    assert.deepEqual(await features(apiKey), { reminderApp: false, vaultApp: false, enabledApps: [] }, "off: no field");
  }
  await createFeatureFlagRule({ flagKey: CONTINUATIONS_PILOT_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [other.server.id] });
  assert.equal((await features(external))?.continuationsPilot, undefined, "on for another server only");
  await createFeatureFlagRule({ flagKey: CONTINUATIONS_PILOT_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [server.id] });
  for (const apiKey of [external, managed]) {
    assert.deepEqual(await features(apiKey), { reminderApp: false, vaultApp: false, continuationsPilot: true, enabledApps: [] });
  }
});

test("GET /context reports the continuation pilot off for a codex agent, on a server where it is on (#wg-ax:#5)", async ({ app }) => {
  const { server } = await seed();
  const keyOf = async (name: string, runtime: string) => {
    const agent = await createAgent(server.id, name, { runtime, model: runtime });
    return (await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null })).apiKey;
  };
  const codex = await keyOf("ctx-pilot-codex", "codex");
  const claude = await keyOf("ctx-pilot-claude", "claude");
  const features = async (apiKey: string) => (await (await getContext(app.baseUrl, apiKey)).json() as AgentApiAgentContextResponse).features;
  await createFeatureFlagRule({ flagKey: CONTINUATIONS_PILOT_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [server.id] });

  assert.equal((await features(claude))?.continuationsPilot, true, "control: on for the server");
  // A CLI from before its own runtime check reads this, so the codex agent keeps the draft flow.
  assert.deepEqual(await features(codex), { reminderApp: false, vaultApp: false, enabledApps: [] });
});

test("GET /context names an app's commands only to a client built with them; no token, an unknown one, one without a version, or the flag off give the historical guide", async ({ app }) => {
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-declared", { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null });
  const context = async (capabilities?: string) => await (await getContext(app.baseUrl, minted.apiKey, capabilities)).json() as AgentApiAgentContextResponse;
  const identity = { handle: "ctx-declared", displayName: "ctx-declared", description: null, serverName: "Context Test Server", serverRole: "member" };
  const historical = buildRaftCliGuideMarkdown(identity);
  const withArtifacts = buildRaftCliGuideMarkdown(identity, { enabledApps: ["artifacts"] });
  assert.notEqual(withArtifacts, historical);

  const flagOff = await context(CLI_CAPABILITIES);
  assert.deepEqual(flagOff.features?.enabledApps, []);
  assert.equal(flagOff.prompt?.text, historical, "declared, but the flag is off");

  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  for (const [capabilities, why] of [
    [undefined, "no header: a CLI from before the tokens, or the SDK"],
    [MANUAL_CONTEXT_CAPABILITY, "capabilities without guide-app tokens"],
    [`${MANUAL_CONTEXT_CAPABILITY},guide-app:future-app@1`, "an unknown app only"],
    [`${MANUAL_CONTEXT_CAPABILITY},guide-app:artifacts`, "the app without a version"],
  ] as const) {
    const body = await context(capabilities);
    assert.deepEqual(body.features?.enabledApps, ["artifacts"], `${why}: the data still lists the app`);
    assert.equal(body.prompt?.text, historical, why);
  }
  assert.equal((await context(CLI_CAPABILITIES)).prompt?.text, withArtifacts, "a current CLI on a flag-on server");
});

test("GET /context teaches raft inbox read only to a CLI that declares it, on a server with inbox items on; otherwise the historical guide byte for byte", async ({ app, onTestFinished }) => {
  // Inbox items are on only with a launch time as well as the flag.
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "2026-01-01T00:00:00.000Z");
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const { server } = await seed();
  const agent = await createAgent(server.id, "ctx-inbox", { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "ctx", issuedVia: "computer", createdByUserId: null });
  const context = async (capabilities?: string) => (await (await getContext(app.baseUrl, minted.apiKey, capabilities)).json() as AgentApiAgentContextResponse).prompt?.text;
  const identity = { handle: "ctx-inbox", displayName: "ctx-inbox", description: null, serverName: "Context Test Server", serverRole: "member" };
  const historical = buildRaftCliGuideMarkdown(identity);
  const withInboxItems = buildRaftCliGuideMarkdown(identity, { inboxItems: true });
  assert.notEqual(withInboxItems, historical);
  const declared = `${MANUAL_CONTEXT_CAPABILITY},${INBOX_ITEMS_CAPABILITY}`;

  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  assert.equal(await context(declared), historical, "declared, but inbox items are off for the server");

  await createFeatureFlagRule({ flagKey: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [server.id] });
  for (const [capabilities, why] of [
    [undefined, "no header: an older CLI, or the SDK"],
    [MANUAL_CONTEXT_CAPABILITY, "a CLI from before raft inbox read"],
    [`${MANUAL_CONTEXT_CAPABILITY},inbox-items`, "the token without a version"],
    [`${MANUAL_CONTEXT_CAPABILITY},inbox-items@0`, "version 0 declares nothing"],
  ] as const) {
    assert.equal(await context(capabilities), historical, why);
  }
  assert.equal(await context(declared), withInboxItems, "a CLI with raft inbox read on a server with inbox items on");
});
