import { dbTest as test } from "../test/integration/dbTest.js";
import assert from "node:assert/strict";

import { runNamedCase } from "../test/runNamedCase.js";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
  type FeatureFlagRolloutGuardrailReceiptV1,
} from "@botiverse/raft-shared";
import { getDb, type Database } from "../db/index.js";
import {
  featureFlagConfigVersions,
  featureFlagRolloutAuditEvents,
  featureFlagRules,
  featureFlags,
} from "../db/schema.js";
import {
  createFeatureFlagRolloutWriterService,
  FeatureFlagRolloutWriteConflictError,
  type FeatureFlagRolloutWriteInput,
} from "./featureFlagRolloutWriterService.js";


const CONTROL_PLANE_ID = "production";
const SERVER_A = "00000000-0000-4000-8000-0000000000a1";
const SERVER_B = "00000000-0000-4000-8000-0000000000b2";
const RECEIPT_ID = "00000000-0000-4000-8000-0000000000c3";
const PERCENTAGE_RECEIPT_ID = "00000000-0000-4000-8000-0000000000c4";
const UNKILL_RECEIPT_ID = "00000000-0000-4000-8000-0000000000c5";
const MALFORMED_RECEIPT_ID = "00000000-0000-4000-8000-0000000000c6";
const STALE_RECEIPT_ID = "00000000-0000-4000-8000-0000000000c7";
const MISMATCH_RECEIPT_ID = "00000000-0000-4000-8000-0000000000c8";
const EXISTING_RULE_RECEIPT_ID = "00000000-0000-4000-8000-0000000000c9";
const FIRST_PERCENTAGE_RECEIPT_ID = "00000000-0000-4000-8000-0000000000ca";
const NOW_MS = Date.parse("2026-07-11T00:00:30.000Z");

function baseInput(
  flagKey: string,
  intent: FeatureFlagRolloutWriteInput["intent"],
  overrides: Partial<FeatureFlagRolloutWriteInput> = {},
): FeatureFlagRolloutWriteInput {
  return {
    requestId: `request-${flagKey}`,
    reason: `roll out ${flagKey}`,
    flagKey,
    intent,
    actor: { type: "human", id: "operator-1" },
    ...overrides,
  };
}

function passingReceipt(input: {
  id: string;
  flagKey: string;
  configVersion: number;
  operation: FeatureFlagRolloutGuardrailReceiptV1["operation"];
  controlPlaneId?: string;
  evaluatedAt?: string;
  expiresAt?: string;
}): FeatureFlagRolloutGuardrailReceiptV1 {
  return {
    schema: FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
    id: input.id,
    verdict: "pass",
    issuer: FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
    controlPlaneId: input.controlPlaneId ?? CONTROL_PLANE_ID,
    flagKey: input.flagKey,
    configVersion: input.configVersion,
    operation: input.operation,
    policyVersion: FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
    evaluatedAt: input.evaluatedAt ?? "2026-07-11T00:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-07-11T00:01:00.000Z",
  };
}

async function insertFlag(flagKey: string, killSwitch = false): Promise<void> {
  await getDb().insert(featureFlags).values({
    key: flagKey,
    randomizationUnit: "server",
    defaultEnabled: false,
    killSwitch,
    salt: `${flagKey}-salt`,
  });
}

async function currentConfigVersion(): Promise<number> {
  const [row] = await getDb().select({ version: featureFlagConfigVersions.version })
    .from(featureFlagConfigVersions)
    .where(eq(featureFlagConfigVersions.scope, "global"));
  return row?.version ?? 0;
}

async function auditRows() {
  return getDb().select().from(featureFlagRolloutAuditEvents)
    .orderBy(featureFlagRolloutAuditEvents.configVersionAfter);
}

function instrumentTransactions(db: Database) {
  const dialect = new PgDialect();
  const lockQueries: Array<{ sql: string; params: unknown[] }> = [];
  let transactionCount = 0;
  const wrapped = {
    async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      transactionCount += 1;
      return db.transaction(async (tx) => {
        const proxy = new Proxy(tx as object, {
          get(target, property) {
            if (property === "execute") {
              return async (statement: SQL) => {
                lockQueries.push(dialect.sqlToQuery(statement));
                return tx.execute(statement);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(proxy);
      });
    },
  };
  return {
    getDatabase: () => wrapped as Pick<Database, "transaction">,
    lockQueries,
    get transactionCount() {
      return transactionCount;
    },
  };
}

function instrumentDatabaseWrites(db: Database) {
  const writeMethods = new Set<PropertyKey>(["delete", "insert", "update"]);
  let writeCount = 0;
  const wrapped = {
    async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const proxy = new Proxy(tx as object, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (writeMethods.has(property)) writeCount += 1;
              return Reflect.apply(value, target, args);
            };
          },
        });
        return callback(proxy);
      });
    },
  };
  return {
    getDatabase: () => wrapped as Pick<Database, "transaction">,
    get writeCount() {
      return writeCount;
    },
  };
}

function rejectFeatureFlagUpdates(db: Database) {
  return {
    transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const proxy = new Proxy(tx as object, {
          get(target, property) {
            if (property === "update") {
              return (table: unknown) => {
                if (table === featureFlags) {
                  return {
                    set() {
                      return {
                        where() {
                          return {
                            returning: async () => [],
                          };
                        },
                      };
                    },
                  };
                }
                return tx.update(table as never);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(proxy);
      });
    },
  } as Pick<Database, "transaction">;
}

function rejectConfigVersionUpdates(db: Database) {
  return {
    transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const proxy = new Proxy(tx as object, {
          get(target, property) {
            if (property === "update") {
              return (table: unknown) => {
                if (table === featureFlagConfigVersions) {
                  return {
                    set() {
                      return {
                        where() {
                          return {
                            returning: async () => [],
                          };
                        },
                      };
                    },
                  };
                }
                return tx.update(table as never);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(proxy);
      });
    },
  } as Pick<Database, "transaction">;
}

test("authoritative feature flag rollout writer", async ({ db }) => {
  await runNamedCase("blocked widening and no-op return with zero state/audit/version writes", async () => {
    const noOpKey = "writer_no_op_v0";
    const wideningKey = "writer_missing_receipt_v0";
    await insertFlag(noOpKey);
    await insertFlag(wideningKey);
    let noOpProviderCalls = 0;
    const noOpWriter = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          noOpProviderCalls += 1;
          throw new Error("no-op must not load a receipt");
        },
        nowMs: () => NOW_MS,
      },
    });
    assert.deepEqual(await noOpWriter(baseInput(noOpKey, {
      kind: "kill_switch_set",
      flagKey: noOpKey,
      desired: false,
    })), {
      applied: false,
      reason: "no_op",
      configVersion: 0,
    });
    assert.equal(noOpProviderCalls, 0);

    let missingReceiptProviderCalls = 0;
    const failClosedWriter = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          missingReceiptProviderCalls += 1;
          return null;
        },
        nowMs: () => NOW_MS,
      },
    });
    assert.deepEqual(await failClosedWriter(baseInput(wideningKey, {
      kind: "server_allowlist_set",
      flagKey: wideningKey,
      expectedConfigVersion: 0,
      serverId: SERVER_A,
      desired: "present",
    }, { receiptId: RECEIPT_ID })), {
      applied: false,
      reason: "receipt_missing",
      configVersion: 0,
    });
    assert.equal(missingReceiptProviderCalls, 1, "guardrail decision/provider is one-shot");
    assert.equal(await currentConfigVersion(), 0);
    assert.deepEqual(await auditRows(), []);
    assert.deepEqual(
      await getDb().select().from(featureFlagRules)
        .where(eq(featureFlagRules.flagKey, wideningKey)),
      [],
    );
  });

  await runNamedCase("writer-local intent-kind guard rejects unsupported intents with a permissive shared stub", async () => {
    const cases: Array<{ label: string; flagKey: string; intent: unknown }> = [
      {
        label: "user-stage",
        flagKey: "writer_reject_user_rule_v0",
        intent: {
          kind: "user_rule_set",
          flagKey: "writer_reject_user_rule_v0",
          stage: "user",
          decision: "allow",
          values: ["user-target"],
        },
      },
      {
        label: "plan-stage",
        flagKey: "writer_reject_plan_rule_v0",
        intent: {
          kind: "plan_rule_set",
          flagKey: "writer_reject_plan_rule_v0",
          stage: "plan",
          decision: "allow",
          values: ["enterprise"],
        },
      },
      {
        label: "generic-rule-set",
        flagKey: "writer_reject_generic_rule_v0",
        intent: {
          kind: "rule_set",
          flagKey: "writer_reject_generic_rule_v0",
          stage: "server",
          decision: "deny",
          values: [SERVER_A],
        },
      },
    ];

    for (const { label, flagKey, intent } of cases) {
      await insertFlag(flagKey);
      await getDb().insert(featureFlagRules).values([
        {
          flagKey,
          stage: "user",
          priority: 1,
          decision: "deny",
          values: [`${label}-user`],
          percentageBasisPoints: null,
          variant: null,
        },
        {
          flagKey,
          stage: "plan",
          priority: 2,
          decision: "allow",
          values: [`${label}-plan`],
          percentageBasisPoints: null,
          variant: null,
        },
      ]);
      const beforeRules = await getDb().select().from(featureFlagRules)
        .where(eq(featureFlagRules.flagKey, flagKey))
        .orderBy(featureFlagRules.id);
      const writeInstrumentation = instrumentDatabaseWrites(getDb());
      let sharedDecisionCalls = 0;
      let providerCalls = 0;
      const writer = createFeatureFlagRolloutWriterService({
        controlPlaneId: CONTROL_PLANE_ID,
        guardrail: {
          loadTrustedReceipt: async () => {
            providerCalls += 1;
            return null;
          },
          nowMs: () => NOW_MS,
        },
        decideGuardrail: async (_state, _intent, _receiptId, guardrail) => {
          sharedDecisionCalls += 1;
          await guardrail.loadTrustedReceipt(RECEIPT_ID);
          return {
            allowed: true,
            reason: "narrowing",
            operation: { kind: "kill_switch_enable" },
          };
        },
        getDatabase: writeInstrumentation.getDatabase,
      });

      assert.deepEqual(await writer(baseInput(flagKey, intent, {
        receiptId: RECEIPT_ID,
        requestId: `request-reject-${label}`,
      })), {
        applied: false,
        reason: "invalid_intent",
        configVersion: 0,
      });
      assert.equal(
        sharedDecisionCalls,
        0,
        `${label} must stop before the permissive shared decision stub`,
      );
      assert.equal(providerCalls, 0, `${label} must not load a trusted receipt`);
      assert.equal(writeInstrumentation.writeCount, 0, `${label} must issue no database writes`);
      assert.equal(await currentConfigVersion(), 0, `${label} must not advance version`);
      assert.deepEqual(await auditRows(), [], `${label} must not write an audit row`);
      const [flag] = await getDb().select({ killSwitch: featureFlags.killSwitch })
        .from(featureFlags)
        .where(eq(featureFlags.key, flagKey));
      assert.equal(flag.killSwitch, false, `${label} must not execute the stubbed mutation`);
      assert.deepEqual(
        await getDb().select().from(featureFlagRules)
          .where(eq(featureFlagRules.flagKey, flagKey))
          .orderBy(featureFlagRules.id),
        beforeRules,
        `${label} must not mutate preexisting rules`,
      );
    }
  });

  await runNamedCase("safe kill uses one transaction, global-then-flag locks, audit, and N-to-N+1", async () => {
    const flagKey = "writer_safe_kill_v0";
    await insertFlag(flagKey);
    let providerCalls = 0;
    const instrumentation = instrumentTransactions(getDb());
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          providerCalls += 1;
          throw new Error("safe kill must not load a receipt");
        },
        nowMs: () => NOW_MS,
      },
      getDatabase: instrumentation.getDatabase,
    });
    const input = baseInput(flagKey, {
      kind: "kill_switch_set",
      flagKey,
      desired: true,
    }, {
      requestId: "request-safe-kill",
      reason: "halt a bad rollout",
    });
    const result = await writer(input);
    assert.equal(result.applied, true);
    if (!result.applied) assert.fail("safe kill should apply");
    assert.equal(result.reason, "narrowing");
    assert.deepEqual(result.operation, { kind: "kill_switch_enable" });
    assert.equal(result.configVersionBefore, 0);
    assert.equal(result.configVersionAfter, 1);
    assert.equal(providerCalls, 0);
    assert.equal(instrumentation.transactionCount, 1);
    assert.equal(instrumentation.lockQueries.length, 2);
    assert.deepEqual(instrumentation.lockQueries[0].params, [0x46464356, 0]);
    assert.equal(instrumentation.lockQueries[1].params[0], 0x46464c47);
    assert.equal(typeof instrumentation.lockQueries[1].params[1], "number");

    const [flag] = await getDb().select({ killSwitch: featureFlags.killSwitch })
      .from(featureFlags)
      .where(eq(featureFlags.key, flagKey));
    assert.equal(flag.killSwitch, true);
    assert.equal(await currentConfigVersion(), 1);
    const [audit] = await auditRows();
    assert.equal(audit.id, result.auditEventId);
    assert.equal(audit.requestId, "request-safe-kill");
    assert.equal(audit.reason, "halt a bad rollout");
    assert.equal(audit.actorType, "human");
    assert.equal(audit.actorId, "operator-1");
    assert.equal(audit.controlPlaneId, CONTROL_PLANE_ID);
    assert.equal(audit.flagKey, flagKey);
    assert.equal(audit.configVersionBefore, 0);
    assert.equal(audit.configVersionAfter, 1);
    assert.equal(audit.authorization, "narrowing");
    assert.equal(audit.receiptId, null);
    assert.deepEqual(audit.operation, { kind: "kill_switch_enable" });
    assert.equal((audit.beforeSnapshot.flag as { killSwitch: boolean }).killSwitch, false);
    assert.equal(audit.beforeSnapshot.configVersion, 0);
    assert.equal((audit.afterSnapshot.flag as { killSwitch: boolean }).killSwitch, true);
    assert.equal(audit.afterSnapshot.configVersion, 1);
  });

  await runNamedCase("safe allowlist removal retains one canonical empty rule and audits it", async () => {
    const flagKey = "writer_safe_remove_v0";
    await insertFlag(flagKey);
    const [rule] = await getDb().insert(featureFlagRules).values({
      flagKey,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: [SERVER_B],
      percentageBasisPoints: null,
      variant: null,
    }).returning();
    const preservedRules = await getDb().insert(featureFlagRules).values([
      {
        flagKey,
        stage: "user",
        priority: 10,
        decision: "deny",
        values: ["user-target"],
        percentageBasisPoints: null,
        variant: null,
      },
      {
        flagKey,
        stage: "plan",
        priority: 20,
        decision: "allow",
        values: ["enterprise"],
        percentageBasisPoints: null,
        variant: "plan-variant",
      },
    ]).returning();
    let providerCalls = 0;
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          providerCalls += 1;
          throw new Error("narrowing must not load a receipt");
        },
        nowMs: () => NOW_MS,
      },
    });
    const result = await writer(baseInput(flagKey, {
      kind: "server_allowlist_set",
      flagKey,
      serverId: SERVER_B,
      desired: "absent",
    }, {
      requestId: "request-safe-remove",
      reason: "remove the canary server",
    }));
    assert.equal(result.applied, true);
    if (!result.applied) assert.fail("safe removal should apply");
    assert.equal(result.reason, "narrowing");
    assert.deepEqual(result.operation, {
      kind: "server_allowlist_remove",
      ruleId: rule.id,
      serverId: SERVER_B,
    });
    assert.equal(providerCalls, 0);
    assert.equal(await currentConfigVersion(), 2);

    const [updatedRule] = await getDb().select().from(featureFlagRules)
      .where(eq(featureFlagRules.id, rule.id));
    assert.deepEqual(
      updatedRule.values,
      [],
      "empty allowlists retain the canonical rule instead of deleting its identity",
    );
    const rows = await auditRows();
    const audit = rows.at(-1)!;
    const beforeRules = audit.beforeSnapshot.rules as Array<{
      id: string;
      stage: string;
      values: string[];
    }>;
    const afterRules = audit.afterSnapshot.rules as typeof beforeRules;
    assert.deepEqual(beforeRules.find((row) => row.id === rule.id)?.values, [SERVER_B]);
    assert.deepEqual(afterRules.find((row) => row.id === rule.id)?.values, []);
    for (const preservedRule of preservedRules) {
      const beforeRule = beforeRules.find((row) => row.id === preservedRule.id);
      const afterRule = afterRules.find((row) => row.id === preservedRule.id);
      assert.ok(beforeRule, `${preservedRule.stage} rule must be present in the before snapshot`);
      assert.deepEqual(
        afterRule,
        beforeRule,
        `${preservedRule.stage} rule must be preserved exactly in the after snapshot`,
      );
    }
  });

  await runNamedCase("valid widening loads one trusted receipt and executes only its matching operation", async () => {
    const flagKey = "writer_guardrail_add_v0";
    await insertFlag(flagKey);
    const operation = {
      kind: "server_allowlist_add" as const,
      ruleId: null,
      serverId: SERVER_A,
    };
    const receipt = passingReceipt({
      id: RECEIPT_ID,
      flagKey,
      configVersion: 2,
      operation,
    });
    let providerCalls = 0;
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async (id) => {
          providerCalls += 1;
          assert.equal(id, RECEIPT_ID);
          return receipt;
        },
        nowMs: () => NOW_MS,
      },
    });
    const result = await writer(baseInput(flagKey, {
      kind: "server_allowlist_set",
      flagKey,
      expectedConfigVersion: 2,
      serverId: SERVER_A,
      desired: "present",
    }, {
      receiptId: RECEIPT_ID,
      requestId: "request-widening",
      reason: "expand a passing canary",
    }));
    assert.equal(result.applied, true);
    if (!result.applied) assert.fail("receipt-authorized widening should apply");
    assert.equal(result.reason, "guardrail_passed");
    assert.deepEqual(result.operation, operation);
    assert.equal(result.receiptId, RECEIPT_ID);
    assert.equal(providerCalls, 1, "decideFeatureFlagRolloutGuardrail must be called once");
    assert.equal(await currentConfigVersion(), 3);
    const [createdRule] = await getDb().select().from(featureFlagRules)
      .where(and(
        eq(featureFlagRules.flagKey, flagKey),
        eq(featureFlagRules.stage, "server"),
      ));
    assert.deepEqual(createdRule.values, [SERVER_A]);
    const audit = (await auditRows()).at(-1)!;
    assert.equal(audit.receiptId, RECEIPT_ID);
    assert.equal(audit.authorization, "guardrail_passed");
    assert.deepEqual(audit.operation, operation);
  });

  await runNamedCase("server allowlist add updates an existing canonical rule by decision ruleId", async () => {
    const flagKey = "writer_existing_server_rule_v0";
    await insertFlag(flagKey);
    const [rule] = await getDb().insert(featureFlagRules).values({
      flagKey,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: [SERVER_A],
      percentageBasisPoints: null,
      variant: null,
    }).returning();
    const versionBefore = await currentConfigVersion();
    const operation = {
      kind: "server_allowlist_add" as const,
      ruleId: rule.id,
      serverId: SERVER_B,
    };
    const receipt = passingReceipt({
      id: EXISTING_RULE_RECEIPT_ID,
      flagKey,
      configVersion: versionBefore,
      operation,
    });
    let providerCalls = 0;
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          providerCalls += 1;
          return receipt;
        },
        nowMs: () => NOW_MS,
      },
    });
    const result = await writer(baseInput(flagKey, {
      kind: "server_allowlist_set",
      flagKey,
      expectedConfigVersion: versionBefore,
      serverId: SERVER_B,
      desired: "present",
    }, {
      receiptId: EXISTING_RULE_RECEIPT_ID,
      requestId: "request-existing-rule-add",
      reason: "add a second passing canary",
    }));
    assert.equal(result.applied, true);
    if (!result.applied) assert.fail("existing-rule server add should apply");
    assert.deepEqual(result.operation, operation);
    assert.equal(providerCalls, 1);
    const [updated] = await getDb().select().from(featureFlagRules)
      .where(eq(featureFlagRules.id, rule.id));
    assert.deepEqual(updated.values, [SERVER_A, SERVER_B]);
    assert.equal(await currentConfigVersion(), versionBefore + 1);
  });

  await runNamedCase("percentage increase inserts the first canonical percentage rule", async () => {
    const flagKey = "writer_first_percentage_rule_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const operation = {
      kind: "percentage_increase" as const,
      ruleId: null,
      fromBasisPoints: 0,
      toBasisPoints: 2_500,
    };
    const receipt = passingReceipt({
      id: FIRST_PERCENTAGE_RECEIPT_ID,
      flagKey,
      configVersion: versionBefore,
      operation,
    });
    let providerCalls = 0;
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          providerCalls += 1;
          return receipt;
        },
        nowMs: () => NOW_MS,
      },
    });
    const result = await writer(baseInput(flagKey, {
      kind: "percentage_set",
      flagKey,
      expectedConfigVersion: versionBefore,
      desiredBasisPoints: 2_500,
    }, {
      receiptId: FIRST_PERCENTAGE_RECEIPT_ID,
      requestId: "request-first-percentage-rule",
      reason: "start a passing percentage canary",
    }));
    assert.equal(result.applied, true);
    if (!result.applied) assert.fail("first percentage rule should apply");
    assert.deepEqual(result.operation, operation);
    assert.equal(providerCalls, 1);
    const [created] = await getDb().select().from(featureFlagRules)
      .where(and(
        eq(featureFlagRules.flagKey, flagKey),
        eq(featureFlagRules.stage, "percentage"),
      ));
    assert.equal(created.priority, 0);
    assert.equal(created.decision, "allow");
    assert.deepEqual(created.values, []);
    assert.equal(created.percentageBasisPoints, 2_500);
    assert.equal(created.variant, null);
    assert.equal(await currentConfigVersion(), versionBefore + 1);
  });

  await runNamedCase("percentage increase and decrease map to exact guarded operations", async () => {
    const flagKey = "writer_percentage_v0";
    await insertFlag(flagKey);
    const [rule] = await getDb().insert(featureFlagRules).values({
      flagKey,
      stage: "percentage",
      priority: 0,
      decision: "allow",
      values: [],
      percentageBasisPoints: 1_000,
      variant: null,
    }).returning();
    const versionBeforeIncrease = await currentConfigVersion();
    const increaseOperation = {
      kind: "percentage_increase" as const,
      ruleId: rule.id,
      fromBasisPoints: 1_000,
      toBasisPoints: 5_000,
    };
    const receipt = passingReceipt({
      id: PERCENTAGE_RECEIPT_ID,
      flagKey,
      configVersion: versionBeforeIncrease,
      operation: increaseOperation,
    });
    let wideningProviderCalls = 0;
    const wideningWriter = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          wideningProviderCalls += 1;
          return receipt;
        },
        nowMs: () => NOW_MS,
      },
    });
    const increased = await wideningWriter(baseInput(flagKey, {
      kind: "percentage_set",
      flagKey,
      expectedConfigVersion: versionBeforeIncrease,
      desiredBasisPoints: 5_000,
    }, {
      receiptId: PERCENTAGE_RECEIPT_ID,
      requestId: "request-percentage-increase",
      reason: "expand a passing percentage canary",
    }));
    assert.equal(increased.applied, true);
    if (!increased.applied) assert.fail("percentage increase should apply");
    assert.deepEqual(increased.operation, increaseOperation);
    assert.equal(wideningProviderCalls, 1);

    let narrowingProviderCalls = 0;
    const narrowingWriter = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          narrowingProviderCalls += 1;
          throw new Error("percentage decrease must not load a receipt");
        },
        nowMs: () => NOW_MS,
      },
    });
    const decreased = await narrowingWriter(baseInput(flagKey, {
      kind: "percentage_set",
      flagKey,
      desiredBasisPoints: 500,
    }, {
      requestId: "request-percentage-decrease",
      reason: "contract a noisy canary",
    }));
    assert.equal(decreased.applied, true);
    if (!decreased.applied) assert.fail("percentage decrease should apply");
    assert.deepEqual(decreased.operation, {
      kind: "percentage_decrease",
      ruleId: rule.id,
      fromBasisPoints: 5_000,
      toBasisPoints: 500,
    });
    assert.equal(narrowingProviderCalls, 0);
    const [updated] = await getDb().select().from(featureFlagRules)
      .where(eq(featureFlagRules.id, rule.id));
    assert.equal(updated.percentageBasisPoints, 500);
    assert.equal(await currentConfigVersion(), versionBeforeIncrease + 2);
  });

  await runNamedCase("kill disable is widening and requires one matching trusted receipt", async () => {
    const flagKey = "writer_safe_kill_v0";
    const versionBefore = await currentConfigVersion();
    const operation = { kind: "kill_switch_disable" as const };
    const receipt = passingReceipt({
      id: UNKILL_RECEIPT_ID,
      flagKey,
      configVersion: versionBefore,
      operation,
    });
    let providerCalls = 0;
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          providerCalls += 1;
          return receipt;
        },
        nowMs: () => NOW_MS,
      },
    });
    const result = await writer(baseInput(flagKey, {
      kind: "kill_switch_set",
      flagKey,
      expectedConfigVersion: versionBefore,
      desired: false,
    }, {
      receiptId: UNKILL_RECEIPT_ID,
      requestId: "request-unkill",
      reason: "restore after a passing health receipt",
    }));
    assert.equal(result.applied, true);
    if (!result.applied) assert.fail("receipt-authorized unkill should apply");
    assert.equal(result.reason, "guardrail_passed");
    assert.deepEqual(result.operation, operation);
    assert.equal(providerCalls, 1);
    const [flag] = await getDb().select({ killSwitch: featureFlags.killSwitch })
      .from(featureFlags)
      .where(eq(featureFlags.key, flagKey));
    assert.equal(flag.killSwitch, false);
    assert.equal(await currentConfigVersion(), versionBefore + 1);
  });

  await runNamedCase("malformed, stale, and mismatched receipts block with zero writes", async () => {
    const flagKey = "writer_bad_receipts_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const auditCountBefore = (await auditRows()).length;
    const operation = {
      kind: "server_allowlist_add" as const,
      ruleId: null,
      serverId: SERVER_A,
    };
    const cases: Array<{
      name: string;
      id: string;
      stored: unknown;
      expectedReason: "receipt_invalid" | "receipt_stale" | "receipt_mismatch";
    }> = [
      {
        name: "malformed",
        id: MALFORMED_RECEIPT_ID,
        stored: { id: MALFORMED_RECEIPT_ID },
        expectedReason: "receipt_invalid",
      },
      {
        name: "stale",
        id: STALE_RECEIPT_ID,
        stored: passingReceipt({
          id: STALE_RECEIPT_ID,
          flagKey,
          configVersion: versionBefore,
          operation,
          evaluatedAt: "2026-07-10T23:59:30.000Z",
          expiresAt: "2026-07-11T00:00:10.000Z",
        }),
        expectedReason: "receipt_stale",
      },
      {
        name: "mismatched",
        id: MISMATCH_RECEIPT_ID,
        stored: passingReceipt({
          id: MISMATCH_RECEIPT_ID,
          flagKey: "writer_other_flag_v0",
          configVersion: versionBefore,
          operation,
        }),
        expectedReason: "receipt_mismatch",
      },
    ];
    let providerCalls = 0;
    for (const receiptCase of cases) {
      const writer = createFeatureFlagRolloutWriterService({
        controlPlaneId: CONTROL_PLANE_ID,
        guardrail: {
          loadTrustedReceipt: async (id) => {
            providerCalls += 1;
            assert.equal(id, receiptCase.id, receiptCase.name);
            return receiptCase.stored;
          },
          nowMs: () => NOW_MS,
        },
      });
      assert.deepEqual(await writer(baseInput(flagKey, {
        kind: "server_allowlist_set",
        flagKey,
        expectedConfigVersion: versionBefore,
        serverId: SERVER_A,
        desired: "present",
      }, {
        receiptId: receiptCase.id,
        requestId: `request-${receiptCase.name}-receipt`,
      })), {
        applied: false,
        reason: receiptCase.expectedReason,
        configVersion: versionBefore,
      });
    }
    assert.equal(providerCalls, cases.length);
    assert.equal(await currentConfigVersion(), versionBefore);
    assert.equal((await auditRows()).length, auditCountBefore);
    assert.deepEqual(
      await getDb().select().from(featureFlagRules)
        .where(eq(featureFlagRules.flagKey, flagKey)),
      [],
    );
  });

  await runNamedCase("version precondition failure rolls mutation and audit back", async () => {
    const flagKey = "writer_version_rollback_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    const auditCountBefore = (await auditRows()).length;
    let providerCalls = 0;
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          providerCalls += 1;
          throw new Error("safe kill must not load a receipt");
        },
        nowMs: () => NOW_MS,
      },
      getDatabase: () => rejectConfigVersionUpdates(getDb()),
    });
    await assert.rejects(
      writer(baseInput(flagKey, {
        kind: "kill_switch_set",
        flagKey,
        desired: true,
      })),
      (error: unknown) => (
        error instanceof FeatureFlagRolloutWriteConflictError
        && error.message === "feature flag config version precondition failed"
      ),
    );
    assert.equal(providerCalls, 0);
    assert.equal(await currentConfigVersion(), versionBefore);
    assert.equal((await auditRows()).length, auditCountBefore);
    const [flag] = await getDb().select({ killSwitch: featureFlags.killSwitch })
      .from(featureFlags)
      .where(eq(featureFlags.key, flagKey));
    assert.equal(flag.killSwitch, false);
  });

  await runNamedCase("affected-row mismatch aborts before audit and version writes", async () => {
    const flagKey = "writer_precondition_v0";
    await insertFlag(flagKey);
    const auditCountBefore = (await auditRows()).length;
    const versionBefore = await currentConfigVersion();
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          throw new Error("safe kill must not load a receipt");
        },
        nowMs: () => NOW_MS,
      },
      getDatabase: () => rejectFeatureFlagUpdates(getDb()),
    });
    await assert.rejects(
      writer(baseInput(flagKey, {
        kind: "kill_switch_set",
        flagKey,
        desired: true,
      })),
      (error: unknown) => (
        error instanceof FeatureFlagRolloutWriteConflictError
        && error.message === "kill switch before-value precondition failed"
      ),
    );
    assert.equal((await auditRows()).length, auditCountBefore);
    assert.equal(await currentConfigVersion(), versionBefore);
    const [flag] = await getDb().select({ killSwitch: featureFlags.killSwitch })
      .from(featureFlags)
      .where(eq(featureFlags.key, flagKey));
    assert.equal(flag.killSwitch, false);
  });

  await runNamedCase("missing audit relation rolls the allowed mutation back", async () => {
    const flagKey = "writer_missing_audit_table_v0";
    await insertFlag(flagKey);
    const versionBefore = await currentConfigVersion();
    await getDb().execute(sql.raw('DROP TABLE "feature_flag_rollout_audit_events"'));
    const writer = createFeatureFlagRolloutWriterService({
      controlPlaneId: CONTROL_PLANE_ID,
      guardrail: {
        loadTrustedReceipt: async () => {
          throw new Error("safe kill must not load a receipt");
        },
        nowMs: () => NOW_MS,
      },
    });
    await assert.rejects(writer(baseInput(flagKey, {
      kind: "kill_switch_set",
      flagKey,
      desired: true,
    })));
    const [flag] = await getDb().select({ killSwitch: featureFlags.killSwitch })
      .from(featureFlags)
      .where(eq(featureFlags.key, flagKey));
    assert.equal(flag.killSwitch, false, "mutation must roll back with the failed audit insert");
    assert.equal(await currentConfigVersion(), versionBefore);
  });
});
