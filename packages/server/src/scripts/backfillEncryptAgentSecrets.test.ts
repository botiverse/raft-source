import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { agents, servers, users } from "../db/schema";
import {
  AGENT_SECRET_KEY_ENV,
  AGENT_SECRET_PREVIOUS_KEY_ENV,
  hasPlaintextAgentSecrets,
  isEncryptedAgentSecret,
  isSealedUnderCurrentAgentSecretKey,
  openAgentRowSecrets,
} from "../services/agentSecretCrypto";
import { parseArgs, runAgentSecretBackfill } from "../../scripts/backfill-encrypt-agent-secrets";

const KEY_A = Buffer.alloc(32, 0x31).toString("base64");
const KEY_B = Buffer.alloc(32, 0x42).toString("base64");

test("parseArgs defaults to dry-run and validates bounds", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "dry-run",
    batchSize: 100,
    sleepMs: 0,
    startAfter: null,
    maxBatches: null,
    reseal: false,
  });
  assert.equal(parseArgs(["--apply", "--batch", "50", "--sleep-ms", "10", "--reseal"]).mode, "apply");
  assert.equal(parseArgs(["--verify"]).mode, "verify");
  // pnpm forwards bare `--` separators into workspace scripts (#proj-runtime:#79).
  assert.equal(parseArgs(["--", "--dry-run"]).mode, "dry-run");
  assert.deepEqual(parseArgs(["--", "--apply", "--batch", "25"]), {
    mode: "apply",
    batchSize: 25,
    sleepMs: 0,
    startAfter: null,
    maxBatches: null,
    reseal: false,
  });
  assert.equal(parseArgs(["--", "--verify"]).mode, "verify");
  assert.throws(() => parseArgs(["--batch", "0"]));
  assert.throws(() => parseArgs(["--unknown"]));
});

test("backfill encrypts legacy plaintext rows (including soft-deleted), is idempotent, supports key rotation, and logs zero secrets", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "backfill-owner@example.test",
    name: "backfill_owner",
    passwordHash: "hash",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Backfill Server",
    slug: "backfill-server",
    ownerId: owner!.id,
  }).returning();

  const secretKey1 = "sk-ant-legacy-live-secret-111";
  const secretKey2 = "sk-or-legacy-deleted-secret-222";
  const envSecret = "super-secret-db-password-333";

  // Insert raw legacy plaintext rows directly into Postgres (bypassing agentService)
  const [liveAgent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "legacy_live",
    runtime: "claude",
    model: "claude-opus-4-6",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gw.example.test/v1", apiKey: secretKey1 },
      model: { kind: "custom", name: "claude-opus-4-6" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: { CUSTOM_SECRET: envSecret, EMPTY: "" },
    },
    envVars: {
      CUSTOM_SECRET: envSecret,
      ANTHROPIC_API_KEY: secretKey1,
      ANTHROPIC_BASE_URL: "https://gw.example.test/v1",
    },
  }).returning();

  const [deletedAgent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "legacy_deleted",
    runtime: "builtin",
    model: "openai/gpt-5.4",
    runtimeConfig: {
      version: 1,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openrouter", apiKey: secretKey2 },
      model: { kind: "preset", id: "openai/gpt-5.4" },
      mode: { kind: "default" },
      reasoningEffort: null,
      hostUserState: "forbidden",
      envVars: null,
    },
    envVars: null,
    deletedAt: new Date("2026-10-01T00:00:00Z"),
  }).returning();

  const [cleanAgent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "no_secrets",
    runtime: "claude",
    model: "sonnet",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
    envVars: null,
  }).returning();

  const logs: string[] = [];
  const envA: NodeJS.ProcessEnv = { [AGENT_SECRET_KEY_ENV]: KEY_A };

  // 1. Dry-run finds both plaintext rows (live + soft-deleted) and writes nothing
  const dry = await runAgentSecretBackfill(
    db,
    { mode: "dry-run", batchSize: 2, sleepMs: 0, startAfter: null, maxBatches: null, reseal: false, env: envA },
    (line) => logs.push(line),
  );
  assert.equal(dry.rowsScanned, 3);
  assert.equal(dry.rowsNeedingEncryption, 2);
  assert.equal(dry.rowsUpdated, 0);
  const [liveAfterDry] = await db.select().from(agents).where(eq(agents.id, liveAgent!.id));
  assert.equal(hasPlaintextAgentSecrets(liveAfterDry!), true, "dry-run must not mutate DB");

  // 2. Apply encrypts both rows and verifies 0 plaintext remaining
  const applied = await runAgentSecretBackfill(
    db,
    { mode: "apply", batchSize: 2, sleepMs: 0, startAfter: null, maxBatches: null, reseal: false, env: envA },
    (line) => logs.push(line),
  );
  assert.equal(applied.rowsUpdated, 2);
  assert.equal(applied.rowsSkippedAlreadyEncrypted, 1);
  assert.equal(applied.remainingPlaintextRows, 0);
  assert.equal(applied.completedFullScan, true);

  // Verify raw DB rows contain ciphertext only, and decrypt back to original plaintext
  const [liveRaw] = await db.select().from(agents).where(eq(agents.id, liveAgent!.id));
  const [deletedRaw] = await db.select().from(agents).where(eq(agents.id, deletedAgent!.id));
  const [cleanRaw] = await db.select().from(agents).where(eq(agents.id, cleanAgent!.id));
  assert.equal(hasPlaintextAgentSecrets(liveRaw!), false);
  assert.equal(hasPlaintextAgentSecrets(deletedRaw!), false);
  assert.equal(hasPlaintextAgentSecrets(cleanRaw!), false);
  assert.equal(isEncryptedAgentSecret((liveRaw!.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey), true);
  assert.equal(isEncryptedAgentSecret(liveRaw!.envVars!.ANTHROPIC_API_KEY), true);
  assert.equal(isEncryptedAgentSecret(liveRaw!.envVars!.CUSTOM_SECRET), true);
  assert.equal(isEncryptedAgentSecret((deletedRaw!.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey), true);

  const liveOpened = openAgentRowSecrets(liveRaw!, envA);
  assert.equal((liveOpened.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey, secretKey1);
  assert.equal((liveOpened.runtimeConfig as { envVars: Record<string, string> }).envVars.CUSTOM_SECRET, envSecret);
  assert.equal((liveOpened.runtimeConfig as { envVars: Record<string, string> }).envVars.EMPTY, "");
  assert.equal(liveOpened.envVars!.ANTHROPIC_API_KEY, secretKey1);
  assert.equal(liveOpened.envVars!.ANTHROPIC_BASE_URL, "https://gw.example.test/v1");
  const deletedOpened = openAgentRowSecrets(deletedRaw!, envA);
  assert.equal((deletedOpened.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey, secretKey2);

  // 3. Re-running --apply is a complete no-op (idempotent)
  const rerun = await runAgentSecretBackfill(
    db,
    { mode: "apply", batchSize: 2, sleepMs: 0, startAfter: null, maxBatches: null, reseal: false, env: envA },
    (line) => logs.push(line),
  );
  assert.equal(rerun.rowsUpdated, 0);
  assert.equal(rerun.rowsNeedingEncryption, 0);
  assert.equal(rerun.remainingPlaintextRows, 0);

  // 4. Key rotation with --reseal re-encrypts rows under KEY_B
  const envRotated: NodeJS.ProcessEnv = {
    [AGENT_SECRET_KEY_ENV]: KEY_B,
    [AGENT_SECRET_PREVIOUS_KEY_ENV]: KEY_A,
  };
  const resealed = await runAgentSecretBackfill(
    db,
    { mode: "apply", batchSize: 2, sleepMs: 0, startAfter: null, maxBatches: null, reseal: true, env: envRotated },
    (line) => logs.push(line),
  );
  assert.equal(resealed.rowsNeedingReseal, 2);
  assert.equal(resealed.rowsUpdated, 2);
  const [liveRotated] = await db.select().from(agents).where(eq(agents.id, liveAgent!.id));
  assert.equal(
    isSealedUnderCurrentAgentSecretKey((liveRotated!.runtimeConfig as { provider: { apiKey: string } }).provider.apiKey, { [AGENT_SECRET_KEY_ENV]: KEY_B }),
    true,
  );
  assert.equal(
    (openAgentRowSecrets(liveRotated!, { [AGENT_SECRET_KEY_ENV]: KEY_B }).runtimeConfig as { provider: { apiKey: string } }).provider.apiKey,
    secretKey1,
  );

  // 5. --verify confirms 0 plaintext and all rows decrypt cleanly
  const verified = await runAgentSecretBackfill(
    db,
    { mode: "verify", batchSize: 2, sleepMs: 0, startAfter: null, maxBatches: null, reseal: false, env: { [AGENT_SECRET_KEY_ENV]: KEY_B } },
    (line) => logs.push(line),
  );
  assert.equal(verified.remainingPlaintextRows, 0);

  // 6. Zero secrets ever logged
  const combinedLogs = logs.join("\n");
  for (const s of [secretKey1, secretKey2, envSecret, "env-aes-256-gcm"]) {
    assert.equal(combinedLogs.includes(s), false, `log output leaked sensitive string: ${s}`);
  }
});
