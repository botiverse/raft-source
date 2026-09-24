import type { AppId } from "../../services/rapRegistry.js";
import type { BuiltInRapAppDefinition } from "../../services/rapBuiltinAppManifests.js";

/**
 * App-owned production declaration. The OS registry consumes this definition
 * without repeating the app identity in authorization or delivery machinery.
 */
export const BUILT_IN_REMINDER_APP = {
  appId: "system.reminder" as AppId,
  composerReference: { displayName: "Reminder" },
  manifest: {
    app_id: "system.reminder" as AppId,
    // Reminder execution is Computer-local. The Server registry retains the
    // built-in identity for generic App config/CRUD, but owns no due hook,
    // timer syscall, conversation, or notification delivery authority.
    hooks: [],
    syscalls: [],
    notifications: [],
    config: {},
  },
  grant: "all_server_agents",
} as const satisfies BuiltInRapAppDefinition;
