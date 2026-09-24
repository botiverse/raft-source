import assert from "node:assert/strict";
import { test } from "vitest";
import { requestProviderConnectionLaunch } from "./providerConnectionLaunch.js";
import { installDaemonFetchMockForTests } from "./daemonFetch.js";

const request = {
  serverUrl: "http://localhost:3001",
  daemonApiKey: "sk_machine_test",
  agentId: "agent-1",
  connectionId: "11111111-1111-4111-8111-111111111111",
};

async function withFetchResponse(body: unknown, run: () => Promise<void>) {
  const restore = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "http://localhost:3001/internal/computer/runners/agent-1/provider-connection");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_machine_test");
    assert.deepEqual(JSON.parse(String(init?.body)), { connectionId: request.connectionId });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  try {
    await run();
  } finally {
    restore();
  }
}

test("provider connection launch accepts an exact DeepSeek projection", async () => {
  await withFetchResponse({
    envVars: { DEEPSEEK_API_KEY: "spawn-only-secret" },
    providerConnection: {
      providerId: "deepseek",
      endpointUrl: null,
      supportsImageInput: false,
    },
  }, async () => {
    const result = await requestProviderConnectionLaunch(request);
    assert.equal(result.envVars.DEEPSEEK_API_KEY, "spawn-only-secret");
    assert.equal(result.providerConnection.providerId, "deepseek");
  });
});

test("provider connection launch accepts generated preset-provider environment keys", async () => {
  await withFetchResponse({
    envVars: { GEMINI_API_KEY: "spawn-only-google-secret" },
    providerConnection: {
      providerId: "google",
      endpointUrl: null,
      supportsImageInput: false,
    },
  }, async () => {
    const result = await requestProviderConnectionLaunch(request);
    assert.deepEqual(result.envVars, { GEMINI_API_KEY: "spawn-only-google-secret" });
    assert.equal(result.providerConnection.providerId, "google");
  });
});

test("provider connection launch rejects unknown response fields", async () => {
  await withFetchResponse({
    envVars: { DEEPSEEK_API_KEY: "spawn-only-secret" },
    providerConnection: {
      providerId: "deepseek",
      endpointUrl: null,
      supportsImageInput: false,
    },
    credentialAlias: "must-not-pass",
  }, async () => {
    await assert.rejects(() => requestProviderConnectionLaunch(request), /invalid payload/);
  });
});

test("provider connection launch rejects inconsistent gateway environment", async () => {
  await withFetchResponse({
    envVars: {
      OPENAI_COMPATIBLE_API_KEY: "spawn-only-secret",
      OPENAI_COMPATIBLE_BASE_URL: "https://wrong.example.test/v1",
    },
    providerConnection: {
      providerId: "openai-compatible",
      endpointUrl: "https://gateway.example.test/v1",
      supportsImageInput: true,
    },
  }, async () => {
    await assert.rejects(() => requestProviderConnectionLaunch(request), /invalid environment/);
  });
});
