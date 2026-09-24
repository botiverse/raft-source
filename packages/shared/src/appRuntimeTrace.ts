import type { AgentInboxAppItem, AgentInboxSourceRef } from "./index.js";
import type { AppConfigWireSnapshot } from "./appConfigTransport.js";

/**
 * Content-free join attributes for Server/Computer built-in App telemetry.
 *
 * Keep this module deliberately smaller than an App payload: identifiers and
 * revisions only. Display copy, action CLI, raw arguments, paths, and config
 * values must never enter these attributes.
 */
export type AppRuntimeTraceAttrs = Readonly<Record<string, string | number>>;

export const APP_CONFIG_TRACE_IDENTITY_KEYS = [
  "app_id",
  "owner_agent_id",
  "config_revision",
  "app_correlation_id",
] as const;

export const APP_SOURCE_TRACE_IDENTITY_KEYS = [
  "app_id",
  "owner_agent_id",
  "notification_class",
  "source_kind",
  "source_id",
  "source_revision",
  "item_id",
  "app_correlation_id",
] as const;

export const APP_SNAPSHOT_TRACE_IDENTITY_KEYS = [
  "app_id",
  "owner_agent_id",
  "snapshot_kind",
  "app_correlation_id",
] as const;

/**
 * Closed Server-side allowlist for built-in App trace attributes. Any future
 * field must be reviewed here before it can cross the telemetry boundary.
 */
export const SERVER_BUILT_IN_APP_TRACE_ALLOWED_KEYS = [
  ...APP_CONFIG_TRACE_IDENTITY_KEYS,
  ...APP_SOURCE_TRACE_IDENTITY_KEYS,
  ...APP_SNAPSHOT_TRACE_IDENTITY_KEYS,
  "machine_id",
  "message_type",
  "receipt_type",
  "outcome",
  "reason",
  "catchup",
] as const;

export function filterAppRuntimeTraceAttrs(
  attrs: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[] = SERVER_BUILT_IN_APP_TRACE_ALLOWED_KEYS,
): Record<string, string | number | boolean> {
  const allowed = new Set(allowedKeys);
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (
      allowed.has(key)
      && (typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean")
    ) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function appConfigTraceAttrs(
  config: Pick<AppConfigWireSnapshot, "appId" | "ownerAgentId" | "revision">,
): AppRuntimeTraceAttrs {
  return {
    app_id: config.appId,
    owner_agent_id: config.ownerAgentId,
    config_revision: config.revision,
    app_correlation_id: `config:${config.appId}:${config.ownerAgentId}:${config.revision}`,
  };
}

export function appSourceTraceAttrs(input: {
  appId?: string;
  ownerAgentId: string;
  notificationClass?: string;
  sourceRef: AgentInboxSourceRef;
  itemId?: string;
}): AppRuntimeTraceAttrs {
  const revision = input.sourceRef.revision ?? "-";
  return {
    ...(input.appId === undefined ? {} : { app_id: input.appId }),
    owner_agent_id: input.ownerAgentId,
    ...(input.notificationClass === undefined
      ? {}
      : { notification_class: input.notificationClass }),
    source_kind: input.sourceRef.kind,
    source_id: input.sourceRef.id,
    ...(input.sourceRef.revision === undefined
      ? {}
      : { source_revision: input.sourceRef.revision }),
    ...(input.itemId === undefined ? {} : { item_id: input.itemId }),
    app_correlation_id: `source:${input.ownerAgentId}:${input.sourceRef.kind}:${input.sourceRef.id}:${revision}`,
  };
}

export function appSnapshotTraceAttrs(input: {
  appId?: string;
  ownerAgentId: string;
  snapshotKind: string;
}): AppRuntimeTraceAttrs {
  return {
    ...(input.appId === undefined ? {} : { app_id: input.appId }),
    owner_agent_id: input.ownerAgentId,
    snapshot_kind: input.snapshotKind,
    app_correlation_id: input.appId === undefined
      ? `snapshot:${input.snapshotKind}:${input.ownerAgentId}`
      : `snapshot:${input.snapshotKind}:${input.appId}:${input.ownerAgentId}`,
  };
}

export function appInboxItemTraceAttrs(
  ownerAgentId: string,
  item: Pick<
    AgentInboxAppItem,
    "appId" | "notificationClass" | "sourceRef" | "itemId"
  >,
): AppRuntimeTraceAttrs {
  return appSourceTraceAttrs({
    appId: item.appId,
    ownerAgentId,
    notificationClass: item.notificationClass,
    sourceRef: item.sourceRef,
    itemId: item.itemId,
  });
}
