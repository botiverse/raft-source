import { and, eq, sql } from "drizzle-orm";
import { currentTimeMs } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agents, rapAppConfigs } from "../db/schema.js";
import { BUILT_IN_RAP_APPS } from "./rapBuiltinAppManifests.js";
import type {
  AppConfigField,
  AppConfigPublicField,
  AppConfigSchema,
  AppId,
} from "./rapRegistry.js";
import type { BuiltInRapAppDefinition } from "./rapBuiltinAppManifests.js";

export type RapAppConfigValue = boolean | number;

export interface RapAppConfigSnapshot {
  appId: string;
  revision: number;
  schema: Record<string, AppConfigPublicField>;
  defaults: Record<string, RapAppConfigValue>;
  overrides: Record<string, RapAppConfigValue>;
  effective: Record<string, RapAppConfigValue>;
}

export class RapAppConfigError extends Error {
  constructor(
    readonly code:
      | "RAP_APP_CONFIG_APP_UNKNOWN"
      | "RAP_APP_CONFIG_OWNER_MISMATCH"
      | "RAP_APP_CONFIG_KEY_UNKNOWN"
      | "RAP_APP_CONFIG_VALUE_INVALID"
      | "RAP_APP_CONFIG_DUPLICATE_KEY"
      | "RAP_APP_CONFIG_REVISION_INVALID"
      | "RAP_APP_CONFIG_REVISION_STALE"
      | "RAP_APP_CONFIG_NO_CHANGES"
      | "RAP_APP_CONFIG_STORED_INVALID",
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "RapAppConfigError";
  }
}

function definitionFor(appId: string): BuiltInRapAppDefinition {
  const matches = BUILT_IN_RAP_APPS.filter((entry) => entry.appId === appId);
  if (matches.length !== 1) {
    throw new RapAppConfigError("RAP_APP_CONFIG_APP_UNKNOWN", `Unknown RAP App: ${appId}`);
  }
  return matches[0];
}

async function assertOwnerBinding(serverId: string, subjectAgentId: string): Promise<void> {
  const [row] = await getDb().select({ id: agents.id }).from(agents).where(and(
    eq(agents.id, subjectAgentId),
    eq(agents.serverId, serverId),
  ));
  if (!row) {
    throw new RapAppConfigError(
      "RAP_APP_CONFIG_OWNER_MISMATCH",
      "The bound Agent does not belong to this Server",
    );
  }
}

function validateValue(key: string, field: AppConfigField, value: unknown): RapAppConfigValue {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new RapAppConfigError(
        "RAP_APP_CONFIG_VALUE_INVALID",
        `${key} must be a boolean`,
      );
    }
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    throw new RapAppConfigError(
      "RAP_APP_CONFIG_VALUE_INVALID",
      `${key} must be an integer`,
    );
  }
  const integer = value as number;
  if (integer < field.minimum || integer > field.maximum) {
    throw new RapAppConfigError(
      "RAP_APP_CONFIG_VALUE_INVALID",
      `${key} must be between ${field.minimum} and ${field.maximum}`,
    );
  }
  return integer;
}

function validateOverrides(
  schema: AppConfigSchema,
  overrides: Record<string, unknown>,
  stored = false,
): Record<string, RapAppConfigValue> {
  const validated: Record<string, RapAppConfigValue> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const field = schema[key];
    if (!field) {
      if (stored) {
        throw new RapAppConfigError(
          "RAP_APP_CONFIG_STORED_INVALID",
          `Stored config contains undeclared key: ${key}`,
        );
      }
      throw new RapAppConfigError("RAP_APP_CONFIG_KEY_UNKNOWN", `Unknown config key: ${key}`);
    }
    try {
      validated[key] = validateValue(key, field, value);
    } catch (error) {
      if (stored && error instanceof RapAppConfigError) {
        throw new RapAppConfigError("RAP_APP_CONFIG_STORED_INVALID", error.message);
      }
      throw error;
    }
  }
  return validated;
}

function projectSnapshot(
  appId: AppId,
  schema: AppConfigSchema,
  revision: number,
  overrides: Record<string, unknown>,
): RapAppConfigSnapshot {
  const defaults: Record<string, RapAppConfigValue> = {};
  const projectedSchema: Record<string, AppConfigPublicField> = {};
  for (const [key, field] of Object.entries(schema)) {
    defaults[key] = field.default;
    projectedSchema[key] = field.type === "boolean"
      ? { type: "boolean" }
      : { type: "integer", minimum: field.minimum, maximum: field.maximum };
  }
  const validatedOverrides = validateOverrides(schema, overrides, true);
  return {
    appId,
    revision,
    schema: projectedSchema,
    defaults,
    overrides: validatedOverrides,
    effective: { ...defaults, ...validatedOverrides },
  };
}

export async function getRapAppConfig(input: {
  serverId: string;
  subjectAgentId: string;
  appId: string;
}): Promise<RapAppConfigSnapshot> {
  const definition = definitionFor(input.appId);
  await assertOwnerBinding(input.serverId, input.subjectAgentId);
  const [row] = await getDb().select({
    overrides: rapAppConfigs.overrides,
    revision: rapAppConfigs.revision,
  }).from(rapAppConfigs).where(and(
    eq(rapAppConfigs.serverId, input.serverId),
    eq(rapAppConfigs.appId, definition.appId),
    eq(rapAppConfigs.subjectAgentId, input.subjectAgentId),
  ));
  return projectSnapshot(
    definition.appId,
    definition.manifest.config,
    row?.revision ?? 0,
    row?.overrides ?? {},
  );
}

export async function patchRapAppConfig(input: {
  serverId: string;
  subjectAgentId: string;
  appId: string;
  expectedRevision: number;
  set: Record<string, unknown>;
  unset: readonly string[];
}): Promise<RapAppConfigSnapshot> {
  const definition = definitionFor(input.appId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new RapAppConfigError(
      "RAP_APP_CONFIG_REVISION_INVALID",
      "expectedRevision must be a non-negative integer",
    );
  }
  if (Object.keys(input.set).length === 0 && input.unset.length === 0) {
    throw new RapAppConfigError("RAP_APP_CONFIG_NO_CHANGES", "Provide at least one set or unset mutation");
  }
  const duplicateUnset = input.unset.find((key, index) => input.unset.indexOf(key) !== index);
  if (duplicateUnset !== undefined || input.unset.some((key) => Object.hasOwn(input.set, key))) {
    throw new RapAppConfigError(
      "RAP_APP_CONFIG_DUPLICATE_KEY",
      `A config key may appear only once per mutation${duplicateUnset ? `: ${duplicateUnset}` : ""}`,
    );
  }
  const validatedSet = validateOverrides(definition.manifest.config, input.set);
  for (const key of input.unset) {
    if (!definition.manifest.config[key]) {
      throw new RapAppConfigError("RAP_APP_CONFIG_KEY_UNKNOWN", `Unknown config key: ${key}`);
    }
  }
  await assertOwnerBinding(input.serverId, input.subjectAgentId);

  return getDb().transaction(async (tx) => {
    const [observed] = await tx.select({
      overrides: rapAppConfigs.overrides,
      revision: rapAppConfigs.revision,
    }).from(rapAppConfigs).where(and(
      eq(rapAppConfigs.serverId, input.serverId),
      eq(rapAppConfigs.appId, definition.appId),
      eq(rapAppConfigs.subjectAgentId, input.subjectAgentId),
    ));
    const currentRevision = observed?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw new RapAppConfigError(
        "RAP_APP_CONFIG_REVISION_STALE",
        `Config revision is stale; current revision is ${currentRevision}`,
        currentRevision,
      );
    }

    const nextOverrides: Record<string, RapAppConfigValue> = {
      ...validateOverrides(definition.manifest.config, observed?.overrides ?? {}, true),
      ...validatedSet,
    };
    for (const key of input.unset) delete nextOverrides[key];
    const now = new Date(currentTimeMs());
    const [written] = await tx.insert(rapAppConfigs).values({
      serverId: input.serverId,
      appId: definition.appId,
      subjectAgentId: input.subjectAgentId,
      overrides: nextOverrides,
      revision: currentRevision + 1,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [rapAppConfigs.serverId, rapAppConfigs.appId, rapAppConfigs.subjectAgentId],
      set: {
        overrides: nextOverrides,
        revision: sql`${rapAppConfigs.revision} + 1`,
        updatedAt: now,
      },
      setWhere: eq(rapAppConfigs.revision, currentRevision),
    }).returning({
      overrides: rapAppConfigs.overrides,
      revision: rapAppConfigs.revision,
    });
    if (!written) {
      const [latest] = await tx.select({ revision: rapAppConfigs.revision }).from(rapAppConfigs).where(and(
        eq(rapAppConfigs.serverId, input.serverId),
        eq(rapAppConfigs.appId, definition.appId),
        eq(rapAppConfigs.subjectAgentId, input.subjectAgentId),
      ));
      throw new RapAppConfigError(
        "RAP_APP_CONFIG_REVISION_STALE",
        `Config revision is stale; current revision is ${latest?.revision ?? 0}`,
        latest?.revision ?? 0,
      );
    }
    return projectSnapshot(
      definition.appId,
      definition.manifest.config,
      written.revision,
      written.overrides,
    );
  });
}
