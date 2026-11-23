import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import type { RuntimeConfig } from "@botiverse/raft-shared";
import {
  AGENT_SECRET_KEY_ENV,
  AGENT_SECRET_PREVIOUS_KEY_ENV,
  AgentSecretDecryptionError,
  AgentSecretInputError,
  AgentSecretKeyUnavailableError,
  agentEnvVarField,
  assertAgentSecretKeyConfigured,
  assertNoEncryptedAgentSecrets,
  containsReservedAgentSecretPrefix,
  findReservedAgentSecretPrefixInInput,
  getAgentSecretDecryptFailure,
  hasAgentSecretDecryptFailure,
  hasPlaintextAgentSecrets,
  hasRotatableAgentSecrets,
  isEncryptedAgentSecret,
  isSealedUnderCurrentAgentSecretKey,
  openAgentEnvVars,
  openAgentRowSecrets,
  openAgentRowSecretsIsolated,
  openAgentRuntimeConfig,
  openAgentSecret,
  providerApiKeyField,
  runtimeConfigEnvVarField,
  sealAgentEnvVars,
  sealAgentRuntimeConfig,
  sealAgentSecret,
} from "./agentSecretCrypto";

const KEY_A = Buffer.alloc(32, 0x11).toString("base64");
const KEY_B = Buffer.alloc(32, 0x22).toString("base64");
const PROD_ENV: NodeJS.ProcessEnv = {
  DEPLOYMENT_ENV: "production",
  [AGENT_SECRET_KEY_ENV]: KEY_A,
};

describe("agentSecretCrypto", () => {
  test("round-trips secrets with fresh random IVs and <16hex>:env-aes-256-gcm:v1 framing", () => {
    const first = sealAgentSecret("agent-1", providerApiKeyField(), "sk-ant-secret-123", PROD_ENV);
    const second = sealAgentSecret("agent-1", providerApiKeyField(), "sk-ant-secret-123", PROD_ENV);

    assert.notEqual(first, second, "each seal uses a fresh 12-byte IV");
    assert.equal(isEncryptedAgentSecret(first), true);
    assert.equal(first.includes("sk-ant-secret-123"), false);
    assert.equal(openAgentSecret("agent-1", providerApiKeyField(), first, PROD_ENV), "sk-ant-secret-123");
    assert.equal(openAgentSecret("agent-1", providerApiKeyField(), second, PROD_ENV), "sk-ant-secret-123");
    assert.equal(isSealedUnderCurrentAgentSecretKey(first, PROD_ENV), true);
  });

  test("preserves empty strings without encrypting", () => {
    assert.equal(sealAgentSecret("agent-1", agentEnvVarField("EMPTY"), "", PROD_ENV), "");
    assert.equal(openAgentSecret("agent-1", agentEnvVarField("EMPTY"), "", PROD_ENV), "");
  });

  test("AAD prevents cross-agent and cross-field ciphertext replay", () => {
    const sealed = sealAgentSecret("agent-a", agentEnvVarField("OPENAI_API_KEY"), "sk-proj-abc", PROD_ENV);

    assert.throws(
      () => openAgentSecret("agent-b", agentEnvVarField("OPENAI_API_KEY"), sealed, PROD_ENV),
      AgentSecretDecryptionError,
    );
    assert.throws(
      () => openAgentSecret("agent-a", agentEnvVarField("OTHER_KEY"), sealed, PROD_ENV),
      AgentSecretDecryptionError,
    );
    assert.throws(
      () => openAgentSecret("agent-a", runtimeConfigEnvVarField("OPENAI_API_KEY"), sealed, PROD_ENV),
      AgentSecretDecryptionError,
    );
    assert.throws(
      () => openAgentSecret("agent-a", providerApiKeyField(), sealed, PROD_ENV),
      AgentSecretDecryptionError,
    );
  });

  test("supports key rotation via SLOCK_PROVIDER_CREDENTIAL_KEY_PREVIOUS", () => {
    const sealedWithA = sealAgentSecret("agent-1", providerApiKeyField(), "sk-ant-rotate-me", PROD_ENV);
    const rotatedEnv: NodeJS.ProcessEnv = {
      DEPLOYMENT_ENV: "production",
      [AGENT_SECRET_KEY_ENV]: KEY_B,
      [AGENT_SECRET_PREVIOUS_KEY_ENV]: KEY_A,
    };

    assert.equal(isSealedUnderCurrentAgentSecretKey(sealedWithA, rotatedEnv), false);
    assert.equal(openAgentSecret("agent-1", providerApiKeyField(), sealedWithA, rotatedEnv), "sk-ant-rotate-me");

    const sealedWithB = sealAgentSecret("agent-1", providerApiKeyField(), "sk-ant-rotate-me", rotatedEnv);
    assert.equal(isSealedUnderCurrentAgentSecretKey(sealedWithB, rotatedEnv), true);
    assert.equal(openAgentSecret("agent-1", providerApiKeyField(), sealedWithB, rotatedEnv), "sk-ant-rotate-me");

    // Dropping KEY_A makes old ciphertexts fail closed.
    const afterDropEnv: NodeJS.ProcessEnv = {
      DEPLOYMENT_ENV: "production",
      [AGENT_SECRET_KEY_ENV]: KEY_B,
    };
    assert.throws(
      () => openAgentSecret("agent-1", providerApiKeyField(), sealedWithA, afterDropEnv),
      AgentSecretDecryptionError,
    );
  });

  test("PR 1 dual-read passes through legacy plaintext values unchanged", () => {
    assert.equal(openAgentSecret("agent-1", providerApiKeyField(), "sk-ant-legacy-plain", PROD_ENV), "sk-ant-legacy-plain");
    assert.equal(openAgentSecret("agent-1", agentEnvVarField("FOO"), "bar", PROD_ENV), "bar");
  });

  test("fails closed in production and staging (and NODE_ENV=production without DEPLOYMENT_ENV) when SLOCK_PROVIDER_CREDENTIAL_KEY is missing or malformed", () => {
    for (const missingEnv of [
      { DEPLOYMENT_ENV: "production", JWT_SECRET: "present-but-must-not-be-used" },
      { DEPLOYMENT_ENV: "PRODUCTION", JWT_SECRET: "present-but-must-not-be-used" },
      { DEPLOYMENT_ENV: "staging", JWT_SECRET: "present-but-must-not-be-used" },
      { NODE_ENV: "production", JWT_SECRET: "present-but-must-not-be-used" },
    ] as NodeJS.ProcessEnv[]) {
      assert.throws(() => assertAgentSecretKeyConfigured(missingEnv), AgentSecretKeyUnavailableError);
      assert.throws(() => sealAgentSecret("agent-1", providerApiKeyField(), "sk-secret", missingEnv), AgentSecretKeyUnavailableError);
    }

    for (const deployment of ["production", "staging"]) {
      const badEnv: NodeJS.ProcessEnv = { DEPLOYMENT_ENV: deployment, [AGENT_SECRET_KEY_ENV]: "not-32-bytes" };
      assert.throws(() => assertAgentSecretKeyConfigured(badEnv), AgentSecretKeyUnavailableError);
      assert.throws(() => sealAgentSecret("agent-1", providerApiKeyField(), "sk-secret", badEnv), AgentSecretKeyUnavailableError);
    }

    // Malformed PREVIOUS key fails fast even outside strict deployments.
    assert.throws(
      () => assertAgentSecretKeyConfigured({ [AGENT_SECRET_PREVIOUS_KEY_ENV]: "bad-prev" }),
      AgentSecretKeyUnavailableError,
    );
  });

  test("derives JWT fallback key outside production/staging (e.g. release-qa with NODE_ENV=production) and keeps it readable after adding primary key", () => {
    const qaEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", DEPLOYMENT_ENV: "release-qa", JWT_SECRET: "qa-jwt-secret" };
    const sealed = sealAgentSecret("agent-1", providerApiKeyField(), "sk-qa-secret", qaEnv);
    assert.equal(isEncryptedAgentSecret(sealed), true);
    assert.equal(openAgentSecret("agent-1", providerApiKeyField(), sealed, qaEnv), "sk-qa-secret");

    const upgradedDevEnv: NodeJS.ProcessEnv = {
      DEPLOYMENT_ENV: "release-qa",
      JWT_SECRET: "qa-jwt-secret",
      [AGENT_SECRET_KEY_ENV]: KEY_A,
    };
    assert.equal(openAgentSecret("agent-1", providerApiKeyField(), sealed, upgradedDevEnv), "sk-qa-secret");
    // In production, JWT fallback is NEVER consulted.
    assert.throws(
      () => openAgentSecret("agent-1", providerApiKeyField(), sealed, { ...PROD_ENV, JWT_SECRET: "qa-jwt-secret" }),
      AgentSecretDecryptionError,
    );
  });

  test("rejects double-encryption and reserved prefix in user input", () => {
    const sealed = sealAgentSecret("agent-1", providerApiKeyField(), "sk-real", PROD_ENV);
    assert.throws(() => sealAgentSecret("agent-1", providerApiKeyField(), sealed, PROD_ENV), AgentSecretInputError);
    assert.equal(containsReservedAgentSecretPrefix(sealed), true);
    assert.equal(containsReservedAgentSecretPrefix("env-aes-256-gcm:v1:forged"), true);
    assert.equal(containsReservedAgentSecretPrefix("sk-ant-normal"), false);

    assert.equal(
      findReservedAgentSecretPrefixInInput({ runtimeConfig: { provider: { apiKey: sealed } } }),
      "runtimeConfig.provider.apiKey",
    );
    assert.equal(
      findReservedAgentSecretPrefixInInput({ runtimeConfig: { envVars: { MY_KEY: "env-aes-256-gcm:v1:x" } } }),
      "runtimeConfig.envVars.MY_KEY",
    );
    assert.equal(
      findReservedAgentSecretPrefixInInput({ envVars: { FOO: sealed } }),
      "envVars.FOO",
    );
    assert.equal(
      findReservedAgentSecretPrefixInInput({ runtimeConfig: { provider: { apiKey: "sk-ok" }, envVars: { A: "1" } }, envVars: { B: "2" } }),
      null,
    );
  });

  test("seals and opens full runtimeConfig + envVars rows while keeping env keys and non-secret fields plaintext", () => {
    const runtimeConfig = {
      version: 1 as const,
      runtime: "claude" as const,
      provider: { kind: "custom" as const, apiUrl: "https://gw.example.test/v1", apiKey: "sk-ant-custom-secret" },
      model: { kind: "custom" as const, name: "claude-opus-4-6" },
      mode: { kind: "default" as const },
      reasoningEffort: null,
      envVars: { TEAM_TOKEN: "tok-123", EMPTY_VAR: "" },
    };
    const envVars = {
      TEAM_TOKEN: "tok-123",
      ANTHROPIC_API_KEY: "sk-ant-custom-secret",
      ANTHROPIC_BASE_URL: "https://gw.example.test/v1",
      EMPTY_VAR: "",
    };

    const sealedRc = sealAgentRuntimeConfig("agent-42", runtimeConfig, PROD_ENV);
    const sealedEnv = sealAgentEnvVars("agent-42", envVars, PROD_ENV);

    // Keys and non-secret metadata stay plaintext in DB JSONB
    assert.equal(sealedRc.provider.kind, "custom");
    assert.equal(sealedRc.provider.apiUrl, "https://gw.example.test/v1");
    assert.equal(isEncryptedAgentSecret(sealedRc.provider.apiKey), true);
    assert.deepEqual(Object.keys(sealedRc.envVars!), ["TEAM_TOKEN", "EMPTY_VAR"]);
    assert.equal(isEncryptedAgentSecret(sealedRc.envVars!.TEAM_TOKEN), true);
    assert.equal(sealedRc.envVars!.EMPTY_VAR, "");
    assert.deepEqual(Object.keys(sealedEnv!), ["TEAM_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "EMPTY_VAR"]);
    assert.equal(isEncryptedAgentSecret(sealedEnv!.ANTHROPIC_API_KEY), true);
    assert.equal(isEncryptedAgentSecret(sealedEnv!.ANTHROPIC_BASE_URL), true);
    assert.equal(sealedEnv!.EMPTY_VAR, "");

    assert.equal(hasPlaintextAgentSecrets({ runtimeConfig: sealedRc, envVars: sealedEnv }), false);
    assert.equal(hasPlaintextAgentSecrets({ runtimeConfig, envVars }), true);
    assert.equal(hasRotatableAgentSecrets({ runtimeConfig: sealedRc, envVars: sealedEnv }, PROD_ENV), false);
    assert.equal(
      hasRotatableAgentSecrets(
        { runtimeConfig: sealedRc, envVars: sealedEnv },
        { DEPLOYMENT_ENV: "production", [AGENT_SECRET_KEY_ENV]: KEY_B, [AGENT_SECRET_PREVIOUS_KEY_ENV]: KEY_A },
      ),
      true,
    );

    assert.throws(() => assertNoEncryptedAgentSecrets(sealedRc, sealedEnv), /Encrypted agent secret leaked/);

    const openedRow = openAgentRowSecrets({ id: "agent-42", runtimeConfig: sealedRc as unknown as RuntimeConfig, envVars: sealedEnv }, PROD_ENV);
    assert.deepEqual(openedRow.runtimeConfig, runtimeConfig);
    assert.deepEqual(openedRow.envVars, envVars);
    assert.doesNotThrow(() => assertNoEncryptedAgentSecrets(openedRow.runtimeConfig, openedRow.envVars));
    // Calling openAgentRowSecrets a second time is a no-op
    assert.equal(openAgentRowSecrets(openedRow, PROD_ENV), openedRow);
  });

  test("error messages never contain plaintext secrets", () => {
    const secret = "sk-ant-super-sensitive-plaintext-99999";
    try {
      sealAgentSecret("agent-1", providerApiKeyField(), secret, { DEPLOYMENT_ENV: "production" });
      assert.fail("expected throw");
    } catch (err) {
      assert.equal(err instanceof Error && err.message.includes(secret), false);
    }
    const sealed = sealAgentSecret("agent-1", providerApiKeyField(), secret, PROD_ENV);
    try {
      openAgentSecret("agent-2", providerApiKeyField(), sealed, PROD_ENV);
      assert.fail("expected throw");
    } catch (err) {
      assert.equal(err instanceof Error && err.message.includes(secret), false);
      assert.equal(err instanceof Error && err.message.includes(sealed), false);
    }
  });

  test("openAgentRowSecretsIsolated strips undecryptable fields, logs no secret values, preserves failure symbol across spreads, and strict openAgentRowSecrets refuses that row", () => {
    const keyAEnv: NodeJS.ProcessEnv = { DEPLOYMENT_ENV: "production", [AGENT_SECRET_KEY_ENV]: KEY_A };
    const keyBEnv: NodeJS.ProcessEnv = { DEPLOYMENT_ENV: "production", [AGENT_SECRET_KEY_ENV]: KEY_B };
    const secretKey = "sk-ant-unreadable-key-999";
    const secretEnv = "tok-unreadable-env-888";
    const sealedRc = sealAgentRuntimeConfig("agent-broken", {
      version: 1 as const,
      runtime: "claude" as const,
      provider: { kind: "custom" as const, apiUrl: "https://gw.example.test/v1", apiKey: secretKey },
      model: { kind: "custom" as const, name: "claude-opus-4-6" },
      mode: { kind: "default" as const },
      reasoningEffort: null,
      envVars: { BAD_SECRET: secretEnv } as Record<string, string>,
    }, keyAEnv);
    sealedRc.envVars = { ...sealedRc.envVars, GOOD_PLAIN: "ok" };
    const sealedEnv = sealAgentEnvVars("agent-broken", { BAD_TOP_ENV: secretEnv }, keyAEnv);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Opening under KEY_B (missing _PREVIOUS=KEY_A) must NOT throw in isolated mode
      const isolated = openAgentRowSecretsIsolated(
        { id: "agent-broken", runtimeConfig: sealedRc, envVars: sealedEnv },
        keyBEnv,
      );
      assert.equal(hasAgentSecretDecryptFailure(isolated), true);
      const failure = getAgentSecretDecryptFailure(isolated);
      assert.ok(failure);
      assert.equal(failure.agentId, "agent-broken");
      assert.deepEqual(
        [...failure.failedFields].sort(),
        ["env_vars:BAD_TOP_ENV", "runtime_config.envVars:BAD_SECRET", "runtime_config.provider.apiKey"],
      );
      // No ciphertext or secret value remains on the returned object
      const serialized = JSON.stringify(isolated);
      assert.equal(serialized.includes("env-aes-256-gcm"), false);
      assert.equal(serialized.includes(secretKey), false);
      assert.equal(serialized.includes(secretEnv), false);
      assert.equal((isolated.runtimeConfig as { provider: { apiKey?: string } }).provider.apiKey, undefined);
      assert.deepEqual((isolated.runtimeConfig as { envVars: Record<string, string> }).envVars, { GOOD_PLAIN: "ok" });
      assert.deepEqual(isolated.envVars, {});

      // Error log contains agentId + field names, never any ciphertext or secret
      assert.equal(errSpy.mock.calls.length, 1);
      const logged = String(errSpy.mock.calls[0]?.[0] ?? "");
      assert.equal(logged.includes("agent-broken"), true);
      assert.equal(logged.includes("env-aes-256-gcm"), false);
      assert.equal(logged.includes(secretKey), false);
      assert.equal(logged.includes(secretEnv), false);

      // Spread copies preserve the failure marker; calling isolated again is idempotent (no second log)
      const spread = { ...isolated };
      assert.equal(hasAgentSecretDecryptFailure(spread), true);
      assert.equal(openAgentRowSecretsIsolated(spread, keyBEnv), spread);
      assert.equal(errSpy.mock.calls.length, 1);

      // Strict openAgentRowSecrets still refuses the isolated row
      assert.throws(() => openAgentRowSecrets(spread, keyBEnv), AgentSecretDecryptionError);
    } finally {
      errSpy.mockRestore();
    }
  });
});
