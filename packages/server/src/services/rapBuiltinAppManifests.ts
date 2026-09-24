/**
 * RAP v1 built-in manifests.
 *
 * This is the single OS-layer file permitted to name a real app. The registry,
 * authorization, delivery, and hook machinery consume these declarations and
 * must never special-case an app id elsewhere.
 *
 * Hooks deliberately describe what is registerable on the exact that ships
 * this file, not the eventual target capability: a committed hook set is
 * always exactly that app's currently registerable, event-carrying hooks.
 * Reminder execution is Computer-local, so the Server catalog deliberately
 * registers no Reminder hook or delivery syscall. Each future hook must add
 * its manifest declaration in the same commit that brings its own envelope
 * and slot.
 */
import type { AppConfigSchema, AppId, HookName, SyscallName } from "./rapRegistry.js";
import {
  BUILT_IN_MEMORY_CLEANER_APP,
  BUILT_IN_SIZE_MONITOR_CONFIG_PROJECTOR,
} from "../apps/cleaner/definition.js";
import { BUILT_IN_REMINDER_APP } from "../apps/reminder/definition.js";
import type { AppConfigWireSnapshot } from "@botiverse/raft-shared/src/appConfigTransport.js";

/**
 * A built-in's PURE projection from durable config to the Computer wire
 * (task #204). The catalog exposes these; it deliberately does not read the
 * database itself, so importing the catalog never pulls in the config service.
 * Composition lives in `appConfigTransportComposition.ts`, one layer above.
 */
export interface BuiltInAppConfigProjector {
  readonly appId: AppId;
  readonly project: (input: {
    ownerAgentId: string;
    revision: number;
    effective: Record<string, boolean | number>;
  }) => AppConfigWireSnapshot;
}

/** Built-in config projectors, in registry order. Names no app itself. */
export const BUILT_IN_APP_CONFIG_PROJECTORS: readonly BuiltInAppConfigProjector[] = [
  BUILT_IN_SIZE_MONITOR_CONFIG_PROJECTOR,
];

export interface BuiltInRapAppDefinition {
  readonly appId: AppId;
  /**
   * Explicit opt-in for user-facing composer references. Registry membership
   * alone is not presentation authority: internal fixtures and operational
   * apps stay out of the picker unless their product definition supplies a
   * stable display name here.
   */
  readonly composerReference: { readonly displayName: string } | null;
  readonly manifest: {
    readonly app_id: AppId;
    readonly hooks: readonly HookName[];
    readonly syscalls: readonly SyscallName[];
    readonly notifications: readonly string[];
    readonly config: AppConfigSchema;
  };
  /**
   * v1 rule constant: every agent that exists on this server is granted.
   *
   * This server-wide scope is allowed ONLY for this closed set of product-
   * shipped system built-ins, which users cannot extend or install. It is not
   * precedent for a third-party app: when third-party installation returns,
   * grants need their own explicit authority and must preserve the reachable
   * existing-but-ungranted refusal. Changing that boundary is a contract
   * change, not a catalog tuning knob.
   *
   * Deliberate v1 cost: for these three production entries, an existing agent
   * on the named server can never be "ungranted". The refusal can distinguish
   * a missing/cross-server agent, but its intended existing-but-ungranted RED
   * is reachable only through the test catalog until third-party grants return.
   */
  readonly grant: "all_server_agents";
}

export const BUILT_IN_RAP_APPS = [
  BUILT_IN_REMINDER_APP,
  BUILT_IN_MEMORY_CLEANER_APP,
  {
    appId: "system.canary" as AppId,
    composerReference: null,
    manifest: {
      app_id: "system.canary" as AppId,
      hooks: [],
      syscalls: ["resolveConversation", "notify"],
      notifications: ["canary.ping"],
      config: {},
    },
    grant: "all_server_agents",
  },
] as const satisfies readonly BuiltInRapAppDefinition[];

export function getBuiltInComposerReference(appId: AppId): { readonly displayName: string } | null {
  return BUILT_IN_RAP_APPS.find((definition) => definition.appId === appId)?.composerReference ?? null;
}
