import { isAdminOrOwner, isOwnerRole } from "@botiverse/raft-shared";
import type { ServerRole } from "@botiverse/raft-shared";
import type { MessageId } from "../i18n/messages/en";

export type ServerLabLifecycleState = "draft" | "open" | "paused" | "retired";

export interface ServerLabSettingsLab {
  key: string;
  name: string;
  description: string;
  state: ServerLabLifecycleState;
  enrolled: boolean;
  effective: boolean;
}

export interface ServerLabSettingsPermissions {
  canSetMasterAccess: boolean;
  canSetEnrollments: boolean;
}

export interface ServerLabSettingsReadback {
  serverId: string;
  serverLabVersion: number;
  masterEnabled: boolean;
  permissions?: Partial<ServerLabSettingsPermissions>;
  labs: ServerLabSettingsLab[];
}

export interface CanonicalServerLabSettingsLab {
  labKey: string;
  name: string;
  description: string;
  state: ServerLabLifecycleState;
  enrolled: boolean;
  effective: boolean;
  updatedAt?: string | null;
}

export interface CanonicalServerLabSettingsReadback {
  serverId: string;
  accessEnabled: boolean;
  version: number;
  canManageAccess?: boolean;
  canManageEnrollments?: boolean;
  labs: CanonicalServerLabSettingsLab[];
}

export interface ServerLabSettingsAuthority {
  canSetMasterAccess: boolean;
  canSetEnrollments: boolean;
}

export type ServerLabsMessageId = Extract<MessageId, `settings.labs.${string}`>;

const SERVER_LAB_DESCRIPTION_MESSAGE_IDS: Partial<Record<string, ServerLabsMessageId>> = {};
const RETIRED_SERVER_LAB_KEYS = new Set(["inline_thread_replies_v0"]);

export function getServerLabSettingsAuthority(
  role: ServerRole | null | undefined,
  permissions: Partial<ServerLabSettingsPermissions> | null | undefined,
): ServerLabSettingsAuthority {
  return {
    canSetMasterAccess: permissions?.canSetMasterAccess ?? isOwnerRole(role),
    canSetEnrollments: permissions?.canSetEnrollments ?? isAdminOrOwner(role),
  };
}

export function getServerLabStateMessageId(state: ServerLabLifecycleState): ServerLabsMessageId {
  switch (state) {
    case "draft":
      return "settings.labs.stateDraft";
    case "open":
      return "settings.labs.stateOpen";
    case "paused":
      return "settings.labs.statePaused";
    case "retired":
      return "settings.labs.stateRetired";
  }
}

export function getServerLabDescriptionMessageId(labKey: string): ServerLabsMessageId | undefined {
  return SERVER_LAB_DESCRIPTION_MESSAGE_IDS[labKey];
}

export function normalizeServerLabSettingsReadback(
  payload: ServerLabSettingsReadback | CanonicalServerLabSettingsReadback | { data: ServerLabSettingsReadback | CanonicalServerLabSettingsReadback },
): ServerLabSettingsReadback {
  const body = "data" in payload ? payload.data : payload;
  if ("accessEnabled" in body) {
    return {
      serverId: body.serverId,
      serverLabVersion: body.version,
      masterEnabled: body.accessEnabled,
      permissions: {
        canSetMasterAccess: body.canManageAccess,
        canSetEnrollments: body.canManageEnrollments,
      },
      labs: body.labs.filter((lab) => !RETIRED_SERVER_LAB_KEYS.has(lab.labKey)).map((lab) => ({
        key: lab.labKey,
        name: lab.name,
        description: lab.description,
        state: lab.state,
        enrolled: lab.enrolled,
        effective: lab.effective,
      })),
    };
  }
  return {
    ...body,
    labs: body.labs.filter((lab) => !RETIRED_SERVER_LAB_KEYS.has(lab.key)),
  };
}

export function isServerLabEnrollmentEditable(
  lab: Pick<ServerLabSettingsLab, "state">,
  authority: Pick<ServerLabSettingsAuthority, "canSetEnrollments">,
  masterEnabled = true,
) {
  return masterEnabled && authority.canSetEnrollments && lab.state === "open";
}

export function getServerLabEnrollmentDisabledReasonMessageId(
  lab: Pick<ServerLabSettingsLab, "state">,
  authority: Pick<ServerLabSettingsAuthority, "canSetEnrollments">,
  masterEnabled = true,
) {
  if (!masterEnabled) return "settings.labs.enrollmentMasterDisabled";
  if (!authority.canSetEnrollments) return "settings.labs.enrollmentAdminOnly";
  if (lab.state !== "open") return "settings.labs.enrollmentLifecycleReadOnly";
  return "";
}

export function isServerLabEffectivelyEnabled(
  masterEnabled: boolean,
  lab: Pick<ServerLabSettingsLab, "state" | "enrolled">,
) {
  return masterEnabled && lab.state === "open" && lab.enrolled;
}

export function createServerLabMasterMutation(
  readback: Pick<ServerLabSettingsReadback, "serverLabVersion">,
  enabled: boolean,
) {
  return {
    enabled,
    expectedVersion: readback.serverLabVersion,
  };
}

export function createServerLabEnrollmentMutation(
  readback: Pick<ServerLabSettingsReadback, "serverLabVersion">,
  enabled: boolean,
) {
  return {
    enabled,
    expectedVersion: readback.serverLabVersion,
  };
}
