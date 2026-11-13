// A hosted personal assistant as production makes it: the personal_assistant
// flag on, the antiproton hosted runtime allowed for the server, and a fake
// provider that records each call and answers it with success.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { featureFlagRules, featureFlags } from "../db/schema";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { __setAgentRuntimeProviderTransportForTests } from "../services/agentRuntimeProviderService";

const ENV_KEYS = ["SLOCK_PROVIDER_CREDENTIAL_KEY", "SERVER_URL", "DEPLOYMENT_ENV", "ANTIPROTON_PROVISIONING_TOKEN"] as const;

export type ProviderCall = { method: string; path: string };

/** Runs `run` with the hosted runtime configured; `calls` lists every provider request. */
export async function withHostedRuntime<T>(run: (calls: ProviderCall[]) => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SERVER_URL = "https://raft.example.test/";
  delete process.env.DEPLOYMENT_ENV;
  process.env.ANTIPROTON_PROVISIONING_TOKEN = "pt-fake-provider-token-0123456789abcdef";
  const calls: ProviderCall[] = [];
  __setAgentRuntimeProviderTransportForTests({
    baseUrl: "https://antiproton.example.test",
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname });
      return init?.method === "POST" && String(input).endsWith("/provision/agents")
        ? Response.json({ providerAgentId: `raft_${(JSON.parse(String(init.body)) as { raftAgentId: string }).raftAgentId}`, status: "active", push: { registered: true } }, { status: 201 })
        : Response.json({});
    },
  });
  try {
    return await run(calls);
  } finally {
    __setAgentRuntimeProviderTransportForTests(null);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

export async function enablePersonalAssistants(serverId: string): Promise<void> {
  const [flag] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (flag) {
    await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  } else {
    await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
  }
  const [hosted] = await getDb().select({ key: featureFlags.key }).from(featureFlags).where(eq(featureFlags.key, ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY));
  if (!hosted) await createFeatureFlag({ key: ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY,
    stage: "server",
    priority: -100,
    decision: "allow",
    values: [serverId],
  });
}
