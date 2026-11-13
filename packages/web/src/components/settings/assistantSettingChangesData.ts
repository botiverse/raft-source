// What the owner's personal assistant changed for them, as GET
// /api/servers/:id/assistant/setting-changes reports it (the server keeps the
// last 10): the types, and the hook that reads them for this server.

import { useEffect, useState } from "react";
import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";

export type AssistantChangedSetting =
  | "theme" | "themeDecor" | "displayLanguage" | "preferredTimezone"
  // What the assistant did as the owner in this server (#proj-assistant:#19 owner actions).
  | "conversationMute" | "notificationLevel"
  // The owner's sidebar in this server, shown with Appearance.
  | "sidebarMove" | "sidebarPin" | "sidebarArrange"
  // Confirm-tier actions the owner confirmed on a card, shown with the assistant's own settings.
  | "agentMove"
  // A message the assistant saved or unsaved for the owner, shown with the assistant's own settings.
  | "messageSave";

export interface AssistantSettingChange {
  id: string;
  assistantName: string | null;
  setting: AssistantChangedSetting;
  /** The server it was changed in; another one only for an account-wide setting (null once that server is gone). */
  serverId?: string | null;
  serverName?: string | null;
  /** Owner actions: the conversation as the owner names it (`#design`, `dm:@peer`), `"server"`, the agent (`@sage`), or null once it is gone. */
  targetRef?: string | null;
  /** The owner confirmed it on a card. */
  confirmed?: boolean;
  previousValue: string | boolean | null;
  nextValue: string | boolean | null;
  createdAt: string;
}

/** What the assistant did on the owner's say-so (confirmed on a card, or a saved message): shown with its own settings. */
export const ASSISTANT_ACTION_SETTINGS = ["agentMove", "messageSave"] as const satisfies readonly AssistantChangedSetting[];

const SETTINGS = new Set<string>(["theme", "themeDecor", "displayLanguage", "preferredTimezone", "conversationMute", "notificationLevel", "sidebarMove", "sidebarPin", "sidebarArrange", "agentMove", "messageSave"] satisfies AssistantChangedSetting[]);

function readChanges(data: unknown): AssistantSettingChange[] {
  const changes = (data as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter((change): change is AssistantSettingChange => (
    !!change && typeof change === "object"
    && typeof (change as AssistantSettingChange).id === "string"
    && SETTINGS.has((change as AssistantSettingChange).setting)
    && typeof (change as AssistantSettingChange).createdAt === "string"
  ));
}

/** The owner's assistant's recorded changes of these settings in this server, newest first (empty until read, or on failure). */
export function useAssistantSettingChanges(settings: readonly AssistantChangedSetting[]): AssistantSettingChange[] {
  const serverId = useServerStore((state) => state.current?.id);
  const [changes, setChanges] = useState<AssistantSettingChange[]>([]);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    api.get(`/servers/${serverId}/assistant/setting-changes`)
      .then(({ data }) => {
        if (!cancelled) setChanges(readChanges(data));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return changes.filter((change) => settings.includes(change.setting));
}
