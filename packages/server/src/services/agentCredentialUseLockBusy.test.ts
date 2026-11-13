import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// A fake transaction: records what the write runs and fails or succeeds the
// UPDATE the way node-postgres through drizzle does (the SQLSTATE on `.cause`).
const executed: string[] = [];
let updateOutcome: "ok" | "lock_busy" | "other" = "ok";
vi.mock("../db/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/index")>()),
  getDb: () => ({
    transaction: async <T>(work: (tx: unknown) => Promise<T>) => work({
      execute: async (query: SQL) => {
        executed.push(new PgDialect().sqlToQuery(query).sql);
      },
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              executed.push("update agent_credentials");
              if (updateOutcome === "lock_busy") {
                throw new DrizzleQueryError("update agent_credentials", [], Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
              }
              if (updateOutcome === "other") throw new DrizzleQueryError("update agent_credentials", [], new Error("connection reset"));
              return [{ id: "credential" }];
            },
          }),
        }),
      }),
    }),
  }),
}));

const { __setAgentCredentialUseThrottleMsForTests, recordAgentCredentialUse } = await import("./agentCredentialService");

afterEach(() => {
  executed.length = 0;
  updateOutcome = "ok";
  __setAgentCredentialUseThrottleMsForTests(null);
});

test("the last-used write sets a short lock timeout before its UPDATE", async () => {
  assert.ok(await recordAgentCredentialUse({ credentialId: randomUUID(), ip: null, userAgent: null }));
  assert.deepEqual(executed, ["SET LOCAL lock_timeout = '100ms'", "update agent_credentials"]);
});

test("a busy credential row skips this window's last-used write instead of waiting", async () => {
  __setAgentCredentialUseThrottleMsForTests(60_000);
  const credentialId = randomUUID();
  updateOutcome = "lock_busy";
  assert.equal(await recordAgentCredentialUse({ credentialId, ip: null, userAgent: null }), null);
  // The window stays claimed: the next request in it does not retry the write.
  updateOutcome = "ok";
  assert.equal(await recordAgentCredentialUse({ credentialId, ip: null, userAgent: null }), null);
  assert.equal(executed.filter((step) => step === "update agent_credentials").length, 1);
});

test("any other failure releases the window so the next request retries", async () => {
  __setAgentCredentialUseThrottleMsForTests(60_000);
  const credentialId = randomUUID();
  updateOutcome = "other";
  assert.equal(await recordAgentCredentialUse({ credentialId, ip: null, userAgent: null }), null);
  updateOutcome = "ok";
  assert.ok(await recordAgentCredentialUse({ credentialId, ip: null, userAgent: null }));
  assert.equal(executed.filter((step) => step === "update agent_credentials").length, 2);
});
