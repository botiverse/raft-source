import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  currentDate,
  decideFeatureFlagRolloutGuardrail,
  type FeatureFlagRolloutGuardrailDecision,
  type FeatureFlagRolloutGuardrailDependencies,
  type FeatureFlagRolloutIntent,
  type FeatureFlagRolloutNarrowingOperation,
  type FeatureFlagRolloutWideningOperation,
} from "@botiverse/raft-shared";
import { getDb, type Database, type DatabaseTransaction } from "../db/index.js";
import {
  featureFlagConfigVersions,
  featureFlagRolloutAuditEvents,
  featureFlagRules,
  featureFlags,
} from "../db/schema.js";
import {
  acquireFeatureFlagConfigVersionLock,
  acquireFeatureFlagLock,
  FEATURE_FLAG_CONFIG_SCOPE_GLOBAL,
} from "./featureFlagService.js";

type AuthoritativeRolloutIntentKind = Extract<
  FeatureFlagRolloutIntent["kind"],
  "kill_switch_set" | "server_allowlist_set" | "percentage_set"
>;
type AllowedRolloutOperation =
  | Extract<
      FeatureFlagRolloutNarrowingOperation,
      { kind: "kill_switch_enable" | "server_allowlist_remove" | "percentage_decrease" }
    >
  | Extract<
      FeatureFlagRolloutWideningOperation,
      { kind: "kill_switch_disable" | "server_allowlist_add" | "percentage_increase" }
    >;
type BlockedDecision = Extract<FeatureFlagRolloutGuardrailDecision, { allowed: false }>;
type AllowedMutationDecision = Extract<
  FeatureFlagRolloutGuardrailDecision,
  { allowed: true; operation: AllowedRolloutOperation }
>;

export type FeatureFlagRolloutActor = {
  type: "human" | "agent" | "system";
  id: string;
};

export interface FeatureFlagRolloutWriteInput {
  /** Operator/request correlation id preserved in the authoritative audit. */
  requestId: string;
  /** Required human/operator rationale preserved in the authoritative audit. */
  reason: string;
  /** Lock key selected by the server adapter; the intent must name the same key. */
  flagKey: string;
  /**
   * Raw request-adjacent desired state. This writer accepts only kill-switch,
   * canonical server-allowlist, and percentage intents; user/plan stages and
   * generic rule CRUD are deliberately outside the authoritative surface.
   */
  intent: unknown;
  /** Opaque id only. Receipt content is loaded by the trusted provider. */
  receiptId?: unknown;
  actor: FeatureFlagRolloutActor;
}

export type FeatureFlagRolloutWriteResult =
  | {
      applied: false;
      reason: BlockedDecision["reason"] | "no_op";
      configVersion: number;
    }
  | {
      applied: true;
      reason: AllowedMutationDecision["reason"];
      flagKey: string;
      configVersionBefore: number;
      configVersionAfter: number;
      auditEventId: string;
      operation: AllowedRolloutOperation;
      receiptId: string | null;
    };

export interface FeatureFlagRolloutWriterDependencies {
  /** Server-owned deployment identity; never copied from request JSON. */
  controlPlaneId: string;
  /** Server-owned receipt reader/clock; never copied from request JSON. */
  guardrail: FeatureFlagRolloutGuardrailDependencies;
  /** Test seam only: production callers use the shared guardrail decision. */
  decideGuardrail?: typeof decideFeatureFlagRolloutGuardrail;
  /** Test seam only. Production callers omit it and use the primary DB. */
  getDatabase?: () => Pick<Database, "transaction">;
}

export class FeatureFlagRolloutWriteConflictError extends Error {
  readonly code = "FEATURE_FLAG_ROLLOUT_WRITE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "FeatureFlagRolloutWriteConflictError";
  }
}

type LockedRolloutState = {
  state: unknown;
  snapshot: RolloutAuditSnapshot | null;
  configVersion: number;
};

type RolloutAuditSnapshot = {
  controlPlaneId: string;
  configVersion: number;
  flag: typeof featureFlags.$inferSelect;
  rules: Array<typeof featureFlagRules.$inferSelect>;
};

const AUTHORITATIVE_ROLLOUT_INTENT_KINDS: ReadonlySet<AuthoritativeRolloutIntentKind> = new Set([
  "kill_switch_set",
  "server_allowlist_set",
  "percentage_set",
]);

function hasAuthoritativeRolloutIntentKind(intent: unknown): boolean {
  if (typeof intent !== "object" || intent === null || Array.isArray(intent)) return false;
  const kind = (intent as { kind?: unknown }).kind;
  return typeof kind === "string" && AUTHORITATIVE_ROLLOUT_INTENT_KINDS.has(
    kind as AuthoritativeRolloutIntentKind,
  );
}

function assertWriterInput(input: FeatureFlagRolloutWriteInput): void {
  if (typeof input.flagKey !== "string" || input.flagKey.length === 0) {
    throw new TypeError("feature flag rollout writer requires a flagKey");
  }
  if (typeof input.requestId !== "string" || input.requestId.trim().length === 0) {
    throw new TypeError("feature flag rollout writer requires a requestId");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new TypeError("feature flag rollout writer requires a reason");
  }
  if (
    !input.actor
    || !["human", "agent", "system"].includes(input.actor.type)
    || typeof input.actor.id !== "string"
    || input.actor.id.trim().length === 0
  ) {
    throw new TypeError("feature flag rollout writer requires an attributable actor");
  }
}

async function loadRawRolloutSnapshot(
  tx: DatabaseTransaction,
  controlPlaneId: string,
  flagKey: string,
  configVersion: number,
): Promise<RolloutAuditSnapshot | null> {
  const [flag] = await tx
    .select()
    .from(featureFlags)
    .where(eq(featureFlags.key, flagKey))
    .limit(1)
    .for("update");
  if (!flag) return null;

  // Keep values and nullable columns raw. The shared contract, not this DB
  // adapter, decides whether every persisted rule has the canonical shape.
  const rules = await tx
    .select()
    .from(featureFlagRules)
    .where(eq(featureFlagRules.flagKey, flagKey))
    .orderBy(asc(featureFlagRules.stage), asc(featureFlagRules.priority), asc(featureFlagRules.id))
    .for("update");

  return {
    controlPlaneId,
    configVersion,
    flag,
    rules,
  };
}

async function loadLockedRolloutState(
  tx: DatabaseTransaction,
  controlPlaneId: string,
  flagKey: string,
): Promise<LockedRolloutState> {
  const [versionRow] = await tx
    .select({ version: featureFlagConfigVersions.version })
    .from(featureFlagConfigVersions)
    .where(eq(featureFlagConfigVersions.scope, FEATURE_FLAG_CONFIG_SCOPE_GLOBAL))
    .limit(1)
    .for("update");
  const configVersion = versionRow?.version ?? 0;
  const snapshot = await loadRawRolloutSnapshot(tx, controlPlaneId, flagKey, configVersion);
  return {
    configVersion,
    snapshot,
    state: snapshot === null
      ? null
      : {
          controlPlaneId: snapshot.controlPlaneId,
          flagKey: snapshot.flag.key,
          configVersion: snapshot.configVersion,
          killSwitch: snapshot.flag.killSwitch,
          rules: snapshot.rules,
        },
  };
}

function canonicalServerRulePredicate(flagKey: string, ruleId: string) {
  return and(
    eq(featureFlagRules.flagKey, flagKey),
    eq(featureFlagRules.id, ruleId),
    eq(featureFlagRules.stage, "server"),
    eq(featureFlagRules.priority, 0),
    eq(featureFlagRules.decision, "allow"),
    isNull(featureFlagRules.percentageBasisPoints),
    isNull(featureFlagRules.variant),
  );
}

function canonicalPercentageRulePredicate(flagKey: string, ruleId: string) {
  return and(
    eq(featureFlagRules.flagKey, flagKey),
    eq(featureFlagRules.id, ruleId),
    eq(featureFlagRules.stage, "percentage"),
    eq(featureFlagRules.priority, 0),
    eq(featureFlagRules.decision, "allow"),
    sql`${featureFlagRules.values} = '[]'::jsonb`,
    isNull(featureFlagRules.variant),
  );
}

async function assertRuleStageAbsent(
  tx: DatabaseTransaction,
  flagKey: string,
  stage: "server" | "percentage",
): Promise<void> {
  const [existing] = await tx
    .select({ id: featureFlagRules.id })
    .from(featureFlagRules)
    .where(and(eq(featureFlagRules.flagKey, flagKey), eq(featureFlagRules.stage, stage)))
    .limit(1);
  if (existing) {
    throw new FeatureFlagRolloutWriteConflictError(
      `${stage} rule appeared after the locked rollout snapshot`,
    );
  }
}

async function insertCanonicalServerRule(
  tx: DatabaseTransaction,
  flagKey: string,
  serverId: string,
): Promise<void> {
  await assertRuleStageAbsent(tx, flagKey, "server");
  const inserted = await tx.insert(featureFlagRules).values({
    flagKey,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
    percentageBasisPoints: null,
    variant: null,
  }).returning({ id: featureFlagRules.id });
  if (inserted.length !== 1) {
    throw new FeatureFlagRolloutWriteConflictError("server allowlist rule insert affected no row");
  }
}

async function insertCanonicalPercentageRule(
  tx: DatabaseTransaction,
  flagKey: string,
  basisPoints: number,
): Promise<void> {
  await assertRuleStageAbsent(tx, flagKey, "percentage");
  const inserted = await tx.insert(featureFlagRules).values({
    flagKey,
    stage: "percentage",
    priority: 0,
    decision: "allow",
    values: [],
    percentageBasisPoints: basisPoints,
    variant: null,
  }).returning({ id: featureFlagRules.id });
  if (inserted.length !== 1) {
    throw new FeatureFlagRolloutWriteConflictError("percentage rule insert affected no row");
  }
}

/**
 * The mutation executor accepts only the executable operation returned by the
 * shared guardrail. It never accepts caller intent, a caller classification,
 * or caller-supplied before-values.
 */
async function executeDecisionOperation(
  tx: DatabaseTransaction,
  flagKey: string,
  operation: AllowedRolloutOperation,
): Promise<void> {
  const now = currentDate();
  switch (operation.kind) {
    case "kill_switch_enable":
    case "kill_switch_disable": {
      const before = operation.kind === "kill_switch_enable" ? false : true;
      const after = !before;
      const updated = await tx.update(featureFlags)
        .set({ killSwitch: after, updatedAt: now })
        .where(and(eq(featureFlags.key, flagKey), eq(featureFlags.killSwitch, before)))
        .returning({ key: featureFlags.key });
      if (updated.length !== 1) {
        throw new FeatureFlagRolloutWriteConflictError("kill switch before-value precondition failed");
      }
      return;
    }

    case "server_allowlist_add": {
      if (operation.ruleId === null) {
        await insertCanonicalServerRule(tx, flagKey, operation.serverId);
        return;
      }
      const updated = await tx.update(featureFlagRules)
        .set({
          values: sql`${featureFlagRules.values} || jsonb_build_array(${operation.serverId}::text)`,
          updatedAt: now,
        })
        .where(and(
          canonicalServerRulePredicate(flagKey, operation.ruleId),
          sql`NOT (${featureFlagRules.values} @> jsonb_build_array(${operation.serverId}::text))`,
        ))
        .returning({ id: featureFlagRules.id });
      if (updated.length !== 1) {
        throw new FeatureFlagRolloutWriteConflictError("server allowlist add before-value precondition failed");
      }
      return;
    }

    case "server_allowlist_remove": {
      // Retain the canonical rule with [] when the last server is removed.
      // This preserves rule identity for later audited re-adds while the
      // shared classifier still observes an empty allowlist.
      const updated = await tx.update(featureFlagRules)
        .set({
          values: sql`
            COALESCE(
              (
                SELECT jsonb_agg(item.value)
                FROM jsonb_array_elements_text(${featureFlagRules.values}) AS item(value)
                WHERE item.value <> ${operation.serverId}
              ),
              '[]'::jsonb
            )
          `,
          updatedAt: now,
        })
        .where(and(
          canonicalServerRulePredicate(flagKey, operation.ruleId),
          sql`${featureFlagRules.values} @> jsonb_build_array(${operation.serverId}::text)`,
        ))
        .returning({ id: featureFlagRules.id });
      if (updated.length !== 1) {
        throw new FeatureFlagRolloutWriteConflictError("server allowlist remove before-value precondition failed");
      }
      return;
    }

    case "percentage_increase": {
      if (operation.ruleId === null) {
        if (operation.fromBasisPoints !== 0) {
          throw new FeatureFlagRolloutWriteConflictError("absent percentage rule must start from zero");
        }
        await insertCanonicalPercentageRule(tx, flagKey, operation.toBasisPoints);
        return;
      }
      const updated = await tx.update(featureFlagRules)
        .set({ percentageBasisPoints: operation.toBasisPoints, updatedAt: now })
        .where(and(
          canonicalPercentageRulePredicate(flagKey, operation.ruleId),
          eq(featureFlagRules.percentageBasisPoints, operation.fromBasisPoints),
        ))
        .returning({ id: featureFlagRules.id });
      if (updated.length !== 1) {
        throw new FeatureFlagRolloutWriteConflictError("percentage increase before-value precondition failed");
      }
      return;
    }

    case "percentage_decrease": {
      const updated = await tx.update(featureFlagRules)
        .set({ percentageBasisPoints: operation.toBasisPoints, updatedAt: now })
        .where(and(
          canonicalPercentageRulePredicate(flagKey, operation.ruleId),
          eq(featureFlagRules.percentageBasisPoints, operation.fromBasisPoints),
        ))
        .returning({ id: featureFlagRules.id });
      if (updated.length !== 1) {
        throw new FeatureFlagRolloutWriteConflictError("percentage decrease before-value precondition failed");
      }
      return;
    }
  }
}

async function insertRolloutAuditEvent(
  tx: DatabaseTransaction,
  input: {
    actor: FeatureFlagRolloutActor;
    controlPlaneId: string;
    flagKey: string;
    requestId: string;
    reason: string;
    configVersionBefore: number;
    configVersionAfter: number;
    beforeSnapshot: RolloutAuditSnapshot;
    afterSnapshot: RolloutAuditSnapshot;
    decision: AllowedMutationDecision;
  },
): Promise<string> {
  const auditEventId = randomUUID();
  const receiptId = input.decision.reason === "guardrail_passed"
    ? input.decision.receiptId
    : null;
  const inserted = await tx.insert(featureFlagRolloutAuditEvents).values({
    id: auditEventId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    requestId: input.requestId,
    reason: input.reason,
    controlPlaneId: input.controlPlaneId,
    flagKey: input.flagKey,
    configVersionBefore: input.configVersionBefore,
    configVersionAfter: input.configVersionAfter,
    authorization: input.decision.reason,
    operation: input.decision.operation,
    receiptId,
    beforeSnapshot: input.beforeSnapshot,
    afterSnapshot: input.afterSnapshot,
  }).returning({ id: featureFlagRolloutAuditEvents.id });
  if (inserted.length !== 1 || inserted[0].id !== auditEventId) {
    throw new FeatureFlagRolloutWriteConflictError("rollout audit insert affected no row");
  }
  return auditEventId;
}

async function advanceConfigVersion(
  tx: DatabaseTransaction,
  input: {
    expectedVersion: number;
    updatedBy: string;
    auditEventId: string;
  },
): Promise<number> {
  const nextVersion = input.expectedVersion + 1;
  const now = currentDate();
  const [updated] = await tx.update(featureFlagConfigVersions)
    .set({
      version: nextVersion,
      updatedAt: now,
      updatedBy: input.updatedBy,
      lastAuditEventId: input.auditEventId,
    })
    .where(and(
      eq(featureFlagConfigVersions.scope, FEATURE_FLAG_CONFIG_SCOPE_GLOBAL),
      eq(featureFlagConfigVersions.version, input.expectedVersion),
    ))
    .returning({ version: featureFlagConfigVersions.version });
  if (updated) return updated.version;

  if (input.expectedVersion !== 0) {
    throw new FeatureFlagRolloutWriteConflictError("feature flag config version precondition failed");
  }
  const [inserted] = await tx.insert(featureFlagConfigVersions).values({
    scope: FEATURE_FLAG_CONFIG_SCOPE_GLOBAL,
    version: nextVersion,
    updatedAt: now,
    updatedBy: input.updatedBy,
    lastAuditEventId: input.auditEventId,
  }).onConflictDoNothing({
    target: featureFlagConfigVersions.scope,
  }).returning({ version: featureFlagConfigVersions.version });
  if (!inserted) {
    throw new FeatureFlagRolloutWriteConflictError("feature flag config version insert precondition failed");
  }
  return inserted.version;
}

/**
 * Build the server-owned authoritative rollout writer. Receipt dependencies
 * are bound once when the service is constructed and are never accepted from
 * an individual request. Legacy admin/internal generic rule CRUD still
 * bypasses this writer and remains an explicit cutover blocker; keep this
 * service unwired until those production paths are closed or isolated.
 */
export function createFeatureFlagRolloutWriterService(
  dependencies: FeatureFlagRolloutWriterDependencies,
) {
  const decideGuardrail = dependencies.decideGuardrail ?? decideFeatureFlagRolloutGuardrail;
  const getDatabase = dependencies.getDatabase ?? getDb;

  return async function writeFeatureFlagRollout(
    input: FeatureFlagRolloutWriteInput,
  ): Promise<FeatureFlagRolloutWriteResult> {
    assertWriterInput(input);
    const db = getDatabase();
    return db.transaction(async (tx) => {
      // Global first, per-flag second: every authoritative writer must use the
      // same order so multi-flag/version contention cannot deadlock.
      await acquireFeatureFlagConfigVersionLock(tx);
      await acquireFeatureFlagLock(tx, input.flagKey);

      const locked = await loadLockedRolloutState(
        tx,
        dependencies.controlPlaneId,
        input.flagKey,
      );
      // Fail closed before the trusted receipt provider can run. The shared
      // parser still performs strict field-level validation for the three
      // explicitly supported intent kinds below.
      if (!hasAuthoritativeRolloutIntentKind(input.intent)) {
        return {
          applied: false,
          reason: "invalid_intent",
          configVersion: locked.configVersion,
        };
      }
      const decision = await decideGuardrail(
        locked.state,
        input.intent,
        input.receiptId,
        dependencies.guardrail,
      );

      if (!decision.allowed) {
        return {
          applied: false,
          reason: decision.reason,
          configVersion: locked.configVersion,
        };
      }
      if (decision.reason === "no_op") {
        return {
          applied: false,
          reason: "no_op",
          configVersion: locked.configVersion,
        };
      }

      const configVersionAfter = locked.configVersion + 1;
      if (!Number.isSafeInteger(configVersionAfter)) {
        throw new FeatureFlagRolloutWriteConflictError("feature flag config version overflow");
      }

      // Only the shared decision's canonical executable operation crosses the
      // mutation boundary. Any downstream failure rolls mutation + audit back.
      await executeDecisionOperation(tx, input.flagKey, decision.operation);
      if (locked.snapshot === null) {
        throw new FeatureFlagRolloutWriteConflictError("allowed rollout has no before snapshot");
      }
      // Tag the after snapshot with the intended N+1 before the version CAS.
      // If that CAS fails, the surrounding transaction rolls back this state
      // and its audit row; the returned result still checks the committed N+1.
      const afterSnapshot = await loadRawRolloutSnapshot(
        tx,
        dependencies.controlPlaneId,
        input.flagKey,
        configVersionAfter,
      );
      if (afterSnapshot === null) {
        throw new FeatureFlagRolloutWriteConflictError("allowed rollout has no after snapshot");
      }
      const auditEventId = await insertRolloutAuditEvent(tx, {
        actor: input.actor,
        controlPlaneId: dependencies.controlPlaneId,
        flagKey: input.flagKey,
        requestId: input.requestId,
        reason: input.reason,
        configVersionBefore: locked.configVersion,
        configVersionAfter,
        beforeSnapshot: locked.snapshot,
        afterSnapshot,
        decision,
      });
      const committedVersion = await advanceConfigVersion(tx, {
        expectedVersion: locked.configVersion,
        updatedBy: `rollout:${input.actor.type}:${input.actor.id}`,
        auditEventId,
      });
      if (committedVersion !== configVersionAfter) {
        throw new FeatureFlagRolloutWriteConflictError("feature flag config version did not advance by one");
      }

      return {
        applied: true,
        reason: decision.reason,
        flagKey: input.flagKey,
        configVersionBefore: locked.configVersion,
        configVersionAfter: committedVersion,
        auditEventId,
        operation: decision.operation,
        receiptId: decision.reason === "guardrail_passed" ? decision.receiptId : null,
      };
    });
  };
}
