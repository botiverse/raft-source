import { createHash } from "node:crypto";
import {
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  currentDate,
  type SlackBridgeFeatureFlagKey,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  evaluateFeatureFlags,
  getFeatureFlagConfigVersion,
  type FeatureFlagEvaluation,
} from "./featureFlagService.js";
import {
  resolveExternalBindingAuthority,
  type ExternalBindingAuthorityDecision,
  type ExternalBindingAuthorityReason,
} from "./externalAppControlPlaneService.js";

export const SLACK_BRIDGE_ACTIVE_PREDICATE_SCHEMA = "slack-bridge-active-predicate.v1" as const;
export const SLACK_BRIDGE_RELEASE_CONTRACT_REVISION = "slack-bridge-revision-5" as const;
export const SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA = "slack-bridge-oracle-receipt.v1" as const;

export type SlackBridgeRuntimeLevel = "top_level" | "thread";

const BASE_ACTIVE_FLAG_KEYS = [
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.directory,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.enqueue,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.dispatch,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.customAuthorship,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.nativeMention,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.eventIngress,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS.inboundProjection,
] as const satisfies readonly SlackBridgeFeatureFlagKey[];

export type SlackBridgeAppMembershipReason =
  | "missing"
  | "absent"
  | "unreadable";

export type SlackBridgeAppMembershipDecision =
  | {
    active: false;
    reason: SlackBridgeAppMembershipReason;
  }
  | {
    active: true;
    fact: {
      registrationId: string;
      installId: string;
      bindingId: string;
      connectionEpoch: number;
      bindingEpoch: number;
      providerAuthorityId: string;
      providerConversationId: string;
      receiptRevision: number;
      expiresAt: Date;
    };
  };

export type SlackBridgeReleaseOracleReason =
  | "missing"
  | "not_green"
  | "stale";

export type SlackBridgeReleaseOracleDecision =
  | {
    active: false;
    reason: SlackBridgeReleaseOracleReason;
  }
  | {
    active: true;
    fact: {
      bindingId: string;
      connectionEpoch: number;
      bindingEpoch: number;
      privacyClass: "public" | "private";
      level: SlackBridgeRuntimeLevel;
      releaseContractRevision: string;
      oracleReceiptSchema: string;
      oracleReceiptRevision: number;
      inboundGreen: boolean;
      outboundGreen: boolean;
      expiresAt: Date;
    };
  };

export type SlackBridgeBindingActiveReason =
  | `binding_authority_${ExternalBindingAuthorityReason}`
  | "runtime_level_invalid"
  | "clock_invalid"
  | "feature_flag_snapshot_invalid"
  | "feature_flag_disabled"
  | "app_membership_unavailable"
  | "app_membership_stale"
  | "app_membership_mismatch"
  | "release_oracle_unavailable"
  | "release_oracle_stale"
  | "release_oracle_mismatch"
  | "runtime_revision_mismatch";

type ActiveAuthorityFact = Extract<ExternalBindingAuthorityDecision, { active: true }>["fact"];

export type SlackBridgeBindingActiveDecision =
  | {
    active: false;
    reason: SlackBridgeBindingActiveReason;
    currentRuntimePredicateRevision?: string;
    disabledFlagKey?: SlackBridgeFeatureFlagKey;
  }
  | {
    active: true;
    fact: {
      schema: typeof SLACK_BRIDGE_ACTIVE_PREDICATE_SCHEMA;
      level: SlackBridgeRuntimeLevel;
      privacyClass: "public" | "private";
      bindingAuthority: ActiveAuthorityFact;
      featureFlagConfigVersion: number;
      requiredFlagKeys: SlackBridgeFeatureFlagKey[];
      appMembershipReceiptRevision: number;
      releaseContractRevision: typeof SLACK_BRIDGE_RELEASE_CONTRACT_REVISION;
      oracleReceiptSchema: typeof SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA;
      oracleReceiptRevision: number;
      runtimePredicateRevision: string;
    };
  };

export interface ResolveSlackBridgeBindingActiveInput {
  serverId: string;
  bindingId: string;
  expectedConnectionEpoch: number;
  expectedBindingEpoch: number;
  level: SlackBridgeRuntimeLevel;
  expectedRuntimePredicateRevision?: string;
  now?: Date;
}

export interface SlackBridgeRuntimeDependencies {
  withReadSnapshot<T>(fn: (executor: DatabaseExecutor) => Promise<T>): Promise<T>;
  resolveBindingAuthority(
    input: {
      serverId: string;
      bindingId: string;
      expectedConnectionEpoch: number;
      expectedBindingEpoch: number;
      now: Date;
    },
    executor: DatabaseExecutor,
  ): Promise<ExternalBindingAuthorityDecision>;
  evaluateFlags(
    inputs: Array<{ key: SlackBridgeFeatureFlagKey; serverId: string }>,
    executor: DatabaseExecutor,
  ): Promise<FeatureFlagEvaluation[]>;
  getFlagConfigVersion(executor: DatabaseExecutor): Promise<number>;
  /**
   * Read a durable provider-membership receipt through the supplied snapshot
   * executor. Implementations must not perform live provider I/O here.
   */
  resolveAppMembership(
    authority: ActiveAuthorityFact,
    executor: DatabaseExecutor,
  ): Promise<SlackBridgeAppMembershipDecision>;
  /**
   * Read a durable release/Oracle receipt through the supplied snapshot
   * executor. T2 consumes this authority but never self-issues GREEN.
   */
  resolveReleaseOracle(
    input: {
      authority: ActiveAuthorityFact;
      level: SlackBridgeRuntimeLevel;
    },
    executor: DatabaseExecutor,
  ): Promise<SlackBridgeReleaseOracleDecision>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isFreshDate(value: unknown, now: Date): value is Date {
  return value instanceof Date
    && Number.isFinite(value.getTime())
    && value > now;
}

function requiredActiveFlagKeys(
  privacyClass: "public" | "private",
  level: SlackBridgeRuntimeLevel,
): SlackBridgeFeatureFlagKey[] {
  const keys: SlackBridgeFeatureFlagKey[] = [...BASE_ACTIVE_FLAG_KEYS];
  if (privacyClass === "private") keys.push(SLACK_BRIDGE_FEATURE_FLAG_KEYS.privateBinding);
  if (level === "thread") keys.push(SLACK_BRIDGE_FEATURE_FLAG_KEYS.threadDelivery);
  return keys.sort();
}

function appMembershipMatches(
  authority: ActiveAuthorityFact,
  membership: Extract<SlackBridgeAppMembershipDecision, { active: true }>["fact"],
): boolean {
  return membership.registrationId === authority.registrationId
    && membership.installId === authority.installId
    && membership.bindingId === authority.bindingId
    && membership.connectionEpoch === authority.connectionEpoch
    && membership.bindingEpoch === authority.bindingEpoch
    && membership.providerAuthorityId === authority.providerAuthorityId
    && membership.providerConversationId === authority.providerConversationId
    && isPositiveSafeInteger(membership.receiptRevision);
}

function releaseOracleMatches(
  authority: ActiveAuthorityFact,
  level: SlackBridgeRuntimeLevel,
  oracle: Extract<SlackBridgeReleaseOracleDecision, { active: true }>["fact"],
): boolean {
  return oracle.bindingId === authority.bindingId
    && oracle.connectionEpoch === authority.connectionEpoch
    && oracle.bindingEpoch === authority.bindingEpoch
    && oracle.privacyClass === authority.privacyClass
    && oracle.level === level
    && oracle.releaseContractRevision === SLACK_BRIDGE_RELEASE_CONTRACT_REVISION
    && oracle.oracleReceiptSchema === SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA
    && isPositiveSafeInteger(oracle.oracleReceiptRevision)
    && oracle.inboundGreen
    && oracle.outboundGreen;
}

function runtimePredicateRevision(input: {
  authority: ActiveAuthorityFact;
  level: SlackBridgeRuntimeLevel;
  featureFlagConfigVersion: number;
  requiredFlagKeys: SlackBridgeFeatureFlagKey[];
  membership: Extract<SlackBridgeAppMembershipDecision, { active: true }>["fact"];
  oracle: Extract<SlackBridgeReleaseOracleDecision, { active: true }>["fact"];
}): string {
  const bindingAuthority = {
    provider: input.authority.provider,
    environment: input.authority.environment,
    registrationId: input.authority.registrationId,
    serverId: input.authority.serverId,
    serverGrantId: input.authority.serverGrantId,
    grantEpoch: input.authority.grantEpoch,
    installId: input.authority.installId,
    providerAppId: input.authority.providerAppId,
    connectionEpoch: input.authority.connectionEpoch,
    scopeRevision: input.authority.scopeRevision,
    credentialRevision: input.authority.credentialRevision,
    bindingId: input.authority.bindingId,
    bindingEpoch: input.authority.bindingEpoch,
    privacyClass: input.authority.privacyClass,
    channelId: input.authority.channelId,
    providerAuthorityId: input.authority.providerAuthorityId,
    providerConversationId: input.authority.providerConversationId,
    installGrantReceiptRevision: input.authority.installGrantReceiptRevision,
    audienceRevision: input.authority.audienceRevision,
  } satisfies ActiveAuthorityFact;
  return sha256(JSON.stringify({
    schema: SLACK_BRIDGE_ACTIVE_PREDICATE_SCHEMA,
    level: input.level,
    bindingAuthority,
    featureFlagConfigVersion: input.featureFlagConfigVersion,
    requiredFlagKeys: input.requiredFlagKeys,
    appMembership: {
      ...input.membership,
      expiresAt: input.membership.expiresAt.toISOString(),
    },
    releaseContractRevision: SLACK_BRIDGE_RELEASE_CONTRACT_REVISION,
    oracleReceiptSchema: SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA,
    releaseOracle: {
      ...input.oracle,
      expiresAt: input.oracle.expiresAt.toISOString(),
    },
  }));
}

const DEFAULT_DEPENDENCIES: SlackBridgeRuntimeDependencies = {
  async withReadSnapshot<T>(fn: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return getDb().transaction(async (tx) => fn(tx), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  },
  resolveBindingAuthority: (input, executor) =>
    resolveExternalBindingAuthority(input, executor as ReturnType<typeof getDb>),
  evaluateFlags: (inputs, executor) => evaluateFeatureFlags(inputs, executor),
  getFlagConfigVersion: (executor) => getFeatureFlagConfigVersion(executor),
  // T2 owns the receipt shape, while the provider reconciler/storage adapter is
  // a later independent increment. Production callers must inject it; the
  // default is deliberately fail-closed.
  resolveAppMembership: async () => ({ active: false, reason: "missing" }),
  // T4/T13 own live Oracle/release approval. T2 consumes their authoritative
  // exact-bound fact and never self-issues a GREEN receipt.
  resolveReleaseOracle: async () => ({ active: false, reason: "missing" }),
};

export async function resolveSlackBridgeBindingActive(
  input: ResolveSlackBridgeBindingActiveInput,
  dependencies: Partial<SlackBridgeRuntimeDependencies> = {},
): Promise<SlackBridgeBindingActiveDecision> {
  const deps: SlackBridgeRuntimeDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const now = input.now ?? currentDate();
  if (input.level !== "top_level" && input.level !== "thread") {
    return { active: false, reason: "runtime_level_invalid" };
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { active: false, reason: "clock_invalid" };
  }

  return deps.withReadSnapshot(async (executor) => {
    const authority = await deps.resolveBindingAuthority({
      serverId: input.serverId,
      bindingId: input.bindingId,
      expectedConnectionEpoch: input.expectedConnectionEpoch,
      expectedBindingEpoch: input.expectedBindingEpoch,
      now,
    }, executor);
    if (!authority.active) {
      return {
        active: false,
        reason: `binding_authority_${authority.reason}`,
      };
    }

    const requiredFlagKeys = requiredActiveFlagKeys(authority.fact.privacyClass, input.level);
    const featureFlagConfigVersion = await deps.getFlagConfigVersion(executor);
    const evaluations = await deps.evaluateFlags(
      requiredFlagKeys.map((key) => ({ key, serverId: input.serverId })),
      executor,
    );
    const evaluationByKey = new Map(evaluations.map((evaluation) => [evaluation.key, evaluation]));
    if (
      !isPositiveSafeInteger(featureFlagConfigVersion)
      || evaluationByKey.size !== requiredFlagKeys.length
      || evaluations.length !== requiredFlagKeys.length
      || requiredFlagKeys.some((key) => !evaluationByKey.has(key))
    ) {
      return { active: false, reason: "feature_flag_snapshot_invalid" };
    }
    const disabledFlagKey = requiredFlagKeys.find((key) => !evaluationByKey.get(key)!.enabled);
    if (disabledFlagKey) {
      return {
        active: false,
        reason: "feature_flag_disabled",
        disabledFlagKey,
      };
    }

    const membership = await deps.resolveAppMembership(authority.fact, executor);
    if (!membership.active) {
      return { active: false, reason: "app_membership_unavailable" };
    }
    if (!isFreshDate(membership.fact.expiresAt, now)) {
      return { active: false, reason: "app_membership_stale" };
    }
    if (!appMembershipMatches(authority.fact, membership.fact)) {
      return { active: false, reason: "app_membership_mismatch" };
    }

    const releaseOracle = await deps.resolveReleaseOracle({
      authority: authority.fact,
      level: input.level,
    }, executor);
    if (!releaseOracle.active) {
      return {
        active: false,
        reason: releaseOracle.reason === "stale"
          ? "release_oracle_stale"
          : releaseOracle.reason === "not_green"
            ? "release_oracle_mismatch"
            : "release_oracle_unavailable",
      };
    }
    if (!isFreshDate(releaseOracle.fact.expiresAt, now)) {
      return { active: false, reason: "release_oracle_stale" };
    }
    if (!releaseOracleMatches(authority.fact, input.level, releaseOracle.fact)) {
      return { active: false, reason: "release_oracle_mismatch" };
    }

    const revision = runtimePredicateRevision({
      authority: authority.fact,
      level: input.level,
      featureFlagConfigVersion,
      requiredFlagKeys,
      membership: membership.fact,
      oracle: releaseOracle.fact,
    });
    if (
      input.expectedRuntimePredicateRevision !== undefined
      && input.expectedRuntimePredicateRevision !== revision
    ) {
      return {
        active: false,
        reason: "runtime_revision_mismatch",
        currentRuntimePredicateRevision: revision,
      };
    }

    return {
      active: true,
      fact: {
        schema: SLACK_BRIDGE_ACTIVE_PREDICATE_SCHEMA,
        level: input.level,
        privacyClass: authority.fact.privacyClass,
        bindingAuthority: authority.fact,
        featureFlagConfigVersion,
        requiredFlagKeys,
        appMembershipReceiptRevision: membership.fact.receiptRevision,
        releaseContractRevision: SLACK_BRIDGE_RELEASE_CONTRACT_REVISION,
        oracleReceiptSchema: SLACK_BRIDGE_ORACLE_RECEIPT_SCHEMA,
        oracleReceiptRevision: releaseOracle.fact.oracleReceiptRevision,
        runtimePredicateRevision: revision,
      },
    };
  });
}
