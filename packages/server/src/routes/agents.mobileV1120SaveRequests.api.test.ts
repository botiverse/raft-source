// Released-client compatibility pin (task #1217 B).
//
// testdata/mobile-v1.12.0-save-requests.json holds VERBATIM request bodies produced
// by the released mobile app v1.12.0 (botiverse/mobile 2637cf9) through its own
// create/edit encoders -- provenance is recorded inside the file. Installed phones
// keep sending exactly these shapes, including the explicit nulls on edit
// (runtimeConfig provider/envVars/command/loadLocalPlugins/hostUserState and
// top-level description; task #152 was a 400 "loadLocalPlugins must be a boolean"
// on exactly that).
//
// DO NOT edit the JSON (or rewrite a sample here) to make a test pass. If the server
// changes, the server must keep accepting these bodies. The only substitutions made
// are the seeded machineId on creates and the target agent id in the PATCH URL.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import type { RuntimeConfig } from "@botiverse/raft-shared";
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { machines, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { getAgent } from "../services/agentService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type SampleBody = Record<string, unknown>;
const SAMPLES_FILE = new URL("./testdata/mobile-v1.12.0-save-requests.json", import.meta.url);
const { samples } = JSON.parse(readFileSync(SAMPLES_FILE, "utf8")) as { samples: Record<string, SampleBody> };

const RAW_SECRETS = ["sk-example", "sk-new-example"];

function sample(name: string): SampleBody {
  const body = samples[name];
  assert.ok(body, `sample ${name} missing from ${SAMPLES_FILE.pathname}`);
  return structuredClone(body);
}

type StoredConfig = RuntimeConfig & {
  provider?: { kind?: string; baseUrl?: string; apiKey?: string; supportsImageInput?: boolean; providerId?: string };
  envVars?: Record<string, string> | null;
  loadLocalPlugins?: boolean;
  hostUserState?: string;
  reasoningEffort?: string | null;
};

async function seed(app: { app: { get(key: string): unknown } }, slug: string, runtimes: string[]) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}-owner@slock.test`,
    name: `${slug}-owner`,
    displayName: `${slug}-owner`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`V1120 ${slug}`, slug, owner.id);
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: `${slug}-machine`,
    apiKeyHash: `${slug}-machine-hash`,
    runtimes,
  }).returning();
  Object.assign(app.app.get("agentOrchestrator") as object, {
    hasMachineLocally: () => true,
    validateBuiltInPresetForMachine: async () => ({
      authority: { connectionEpochId: "epoch-a", replicaGeneration: "generation-a" },
    }),
    acquireBuiltInCatalogAuthority: () => () => undefined,
    // Live Kimi model table in which `k2` publishes "high".
    detectMachineRuntimeModels: async () => ({
      kind: "live",
      value: {
        default: "k2",
        models: [{ id: "k2", label: "K2", supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }],
      },
    }),
  });
  const token = await tokenForHuman(owner.email);
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": server.id,
    "Content-Type": "application/json",
  };
  return { server, machine, headers };
}

async function send(url: string, method: "POST" | "PATCH", headers: Record<string, string>, body: SampleBody) {
  const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, `${method} ${url} rejected a released v1.12.0 body: ${res.status} ${text}`);
  for (const secret of RAW_SECRETS) {
    assert.equal(text.includes(secret), false, `${method} response leaked raw secret ${secret}`);
  }
  return JSON.parse(text) as { id: string; runtimeConfig: StoredConfig };
}

async function readBack(baseUrl: string, headers: Record<string, string>, id: string) {
  const res = await fetch(`${baseUrl}/api/agents/${id}`, { headers });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  for (const secret of RAW_SECRETS) {
    assert.equal(text.includes(secret), false, `GET leaked raw secret ${secret}`);
  }
  const stored = await getAgent(id);
  assert.ok(stored, `agent ${id} not persisted`);
  return stored as typeof stored & { runtimeConfig: StoredConfig };
}

async function createFromSample(baseUrl: string, headers: Record<string, string>, machineId: string, name: string) {
  const body = sample(name);
  body.machineId = machineId;
  return send(`${baseUrl}/api/agents`, "POST", headers, body);
}

test("v1.12.0 create.builtin.preset is accepted, stores the key server-side, never reads it back", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-c-preset", ["builtin"]);
  const created = await createFromSample(app.baseUrl, headers, machine.id, "create.builtin.preset");
  assert.equal(created.runtimeConfig.provider?.apiKey, "");
  const stored = await readBack(app.baseUrl, headers, created.id);
  assert.equal(stored.runtime, "builtin");
  assert.equal(stored.model, "deepseek/deepseek-v4-pro");
  assert.equal(stored.runtimeConfig.provider?.kind, "preset");
  assert.equal(stored.runtimeConfig.provider?.providerId, "deepseek");
  assert.equal(stored.runtimeConfig.provider?.apiKey, "sk-example");
  assert.deepEqual(stored.runtimeConfig.model, { kind: "preset", id: "deepseek/deepseek-v4-pro" });
  assert.equal(stored.runtimeConfig.loadLocalPlugins, false);
  assert.equal(stored.runtimeConfig.hostUserState, "forbidden");
});

test("v1.12.0 create.builtin.gateway is accepted with baseUrl, image input, env vars and local plugins", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-c-gateway", ["builtin"]);
  const created = await createFromSample(app.baseUrl, headers, machine.id, "create.builtin.gateway");
  assert.equal(created.runtimeConfig.provider?.apiKey, "");
  const stored = await readBack(app.baseUrl, headers, created.id);
  assert.equal(stored.runtime, "builtin");
  assert.equal(stored.model, "example-model");
  assert.equal(stored.runtimeConfig.provider?.kind, "gateway");
  assert.equal(stored.runtimeConfig.provider?.baseUrl, "https://gateway.example.test/v1");
  assert.equal(stored.runtimeConfig.provider?.supportsImageInput, true);
  assert.equal(stored.runtimeConfig.provider?.apiKey, "sk-example");
  assert.deepEqual(stored.runtimeConfig.model, { kind: "custom", name: "example-model" });
  assert.deepEqual(stored.runtimeConfig.envVars, { EXAMPLE_FLAG: "1" });
  assert.deepEqual(stored.envVars, { EXAMPLE_FLAG: "1" });
  assert.equal(stored.runtimeConfig.loadLocalPlugins, true);
  assert.equal(stored.runtimeConfig.hostUserState, "forbidden");
});

test("v1.12.0 create.kimi-sdk.explicit-effort is accepted and keeps effort \"high\"", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-c-kimi-eff", ["kimi-sdk"]);
  const created = await createFromSample(app.baseUrl, headers, machine.id, "create.kimi-sdk.explicit-effort");
  const stored = await readBack(app.baseUrl, headers, created.id);
  assert.equal(stored.runtime, "kimi-sdk");
  assert.equal(stored.model, "k2");
  // Kimi effort lives only in RuntimeConfig (the launch authority); the legacy
  // agents.reasoning_effort column is a closed enum and stays null for kimi-sdk.
  assert.equal(stored.runtimeConfig.reasoningEffort, "high");
  assert.deepEqual(stored.runtimeConfig.model, { kind: "preset", id: "k2" });
});

test("v1.12.0 create.kimi-sdk.default-effort is accepted with a null effort", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-c-kimi-def", ["kimi-sdk"]);
  const created = await createFromSample(app.baseUrl, headers, machine.id, "create.kimi-sdk.default-effort");
  const stored = await readBack(app.baseUrl, headers, created.id);
  assert.equal(stored.runtime, "kimi-sdk");
  assert.equal(stored.model, "k2");
  assert.equal(stored.reasoningEffort ?? null, null);
  assert.equal(stored.runtimeConfig.reasoningEffort ?? null, null);
});

test("v1.12.0 edit.builtin.keep-secret (provider without apiKey) is accepted and keeps the stored key", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-e-keep", ["builtin"]);
  const base = await createFromSample(app.baseUrl, headers, machine.id, "create.builtin.gateway");
  const edited = await send(`${app.baseUrl}/api/agents/${base.id}`, "PATCH", headers, sample("edit.builtin.keep-secret"));
  assert.equal(edited.runtimeConfig.provider?.apiKey, "");
  const stored = await readBack(app.baseUrl, headers, base.id);
  assert.equal(stored.runtimeConfig.provider?.apiKey, "sk-example", "edit without apiKey must keep the stored secret");
  assert.equal(stored.runtimeConfig.provider?.kind, "gateway");
  assert.equal(stored.runtimeConfig.provider?.baseUrl, "https://gateway.example.test/v1");
  assert.equal(stored.runtimeConfig.provider?.supportsImageInput, true);
  assert.deepEqual(stored.runtimeConfig.envVars, { EXAMPLE_FLAG: "1" });
  assert.equal(stored.runtimeConfig.loadLocalPlugins, false);
  assert.equal(stored.runtimeConfig.hostUserState, "forbidden");
  assert.equal(stored.model, "example-model");
});

test("v1.12.0 edit.builtin.replace-secret (new apiKey) is accepted and replaces the stored key", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-e-replace", ["builtin"]);
  const base = await createFromSample(app.baseUrl, headers, machine.id, "create.builtin.gateway");
  const edited = await send(`${app.baseUrl}/api/agents/${base.id}`, "PATCH", headers, sample("edit.builtin.replace-secret"));
  assert.equal(edited.runtimeConfig.provider?.apiKey, "");
  const stored = await readBack(app.baseUrl, headers, base.id);
  assert.equal(stored.runtimeConfig.provider?.apiKey, "sk-new-example");
  assert.equal(stored.runtimeConfig.provider?.baseUrl, "https://gateway.example.test/v1");
  assert.equal(stored.runtimeConfig.provider?.supportsImageInput, true);
  assert.deepEqual(stored.runtimeConfig.envVars, { EXAMPLE_FLAG: "1" });
  assert.equal(stored.runtimeConfig.loadLocalPlugins, false);
  assert.equal(stored.runtimeConfig.hostUserState, "forbidden");
});

test("v1.12.0 edit.kimi-sdk.effort-picked (explicit nulls + v1 ref) is accepted and stores \"high\"", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-e-kimi-eff", ["kimi-sdk"]);
  const base = await createFromSample(app.baseUrl, headers, machine.id, "create.kimi-sdk.default-effort");
  await send(`${app.baseUrl}/api/agents/${base.id}`, "PATCH", headers, sample("edit.kimi-sdk.effort-picked"));
  const stored = await readBack(app.baseUrl, headers, base.id);
  assert.equal(stored.runtime, "kimi-sdk");
  assert.equal(stored.model, "k2");
  // Kimi effort lives only in RuntimeConfig (the launch authority); the legacy
  // agents.reasoning_effort column is a closed enum and stays null for kimi-sdk.
  assert.equal(stored.runtimeConfig.reasoningEffort, "high");
});

test("v1.12.0 edit.kimi-sdk.untouched (explicit nulls, no ref) is accepted and keeps a null effort", async ({ app }) => {
  const { machine, headers } = await seed(app, "v1120-e-kimi-none", ["kimi-sdk"]);
  const base = await createFromSample(app.baseUrl, headers, machine.id, "create.kimi-sdk.default-effort");
  await send(`${app.baseUrl}/api/agents/${base.id}`, "PATCH", headers, sample("edit.kimi-sdk.untouched"));
  const stored = await readBack(app.baseUrl, headers, base.id);
  assert.equal(stored.runtime, "kimi-sdk");
  assert.equal(stored.model, "k2");
  assert.equal(stored.reasoningEffort ?? null, null);
  assert.equal(stored.runtimeConfig.reasoningEffort ?? null, null);
});
