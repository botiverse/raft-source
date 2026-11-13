import { useIntl } from "react-intl";
import { isRaftThemeId } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import { isSupportedLocale, LOCALE_LABELS } from "../../i18n/locale";
import { useServerStore } from "../../store/serverStore";
import { RAFT_THEME_NAME_ID } from "./raftThemeNames";
import { useAssistantSettingChanges } from "./assistantSettingChangesData";
import type { AssistantChangedSetting, AssistantSettingChange } from "./assistantSettingChangesData";

export type { AssistantChangedSetting, AssistantSettingChange } from "./assistantSettingChangesData";

type ChangedSettingValue = Exclude<AssistantChangedSetting, "conversationMute" | "notificationLevel" | "sidebarMove" | "sidebarPin" | "sidebarArrange" | "agentMove" | "messageSave">;

const SETTING_NAME_ID: Record<ChangedSettingValue, MessageId> = {
  theme: "settings.assistantChanges.setting.theme",
  themeDecor: "settings.assistantChanges.setting.themeDecor",
  displayLanguage: "settings.assistantChanges.setting.displayLanguage",
  preferredTimezone: "settings.assistantChanges.setting.preferredTimezone",
};

const LEVEL_NAME_ID: Record<string, MessageId> = {
  all: "notifications.level.all",
  mentions: "notifications.level.mentions",
  none: "notifications.level.none",
  default: "settings.assistantChanges.level.default",
};

/**
 * "Changed by your assistant": what the owner's personal assistant changed of
 * these settings, newest first, from the audit (GET
 * /api/servers/:id/assistant/setting-changes; the server keeps the last 10).
 * The theme is this server's; the UI language and time zone are the account's,
 * so a change made from another server shows here too, labelled with it.
 * Under Notifications: what it did as the owner in this server (muted a
 * conversation, set a notification level), the target named as they see it.
 * Nothing shows when it changed none of them.
 */
export default function AssistantSettingChanges({ settings }: { settings: readonly AssistantChangedSetting[] }) {
  const { formatMessage } = useIntl();
  const shown = useAssistantSettingChanges(settings);
  if (shown.length === 0) return null;
  return (
    <section className="mb-6" data-testid="assistant-setting-changes">
      <h3 className="mb-2 text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.assistantChanges.title" })}</h3>
      <AssistantSettingChangesList changes={shown} />
    </section>
  );
}

/** The lines of AssistantSettingChanges, one per change. */
export function AssistantSettingChangesList({ changes: shown }: { changes: readonly AssistantSettingChange[] }) {
  const { formatMessage, formatDate } = useIntl();
  const serverId = useServerStore((state) => state.current?.id);

  const targetOf = (change: AssistantSettingChange): string => {
    if (change.targetRef === "server") return formatMessage({ id: "settings.assistantChanges.target.server" });
    return change.targetRef || formatMessage({ id: "settings.assistantChanges.target.gone" });
  };
  const levelOf = (value: string | boolean | null): string => (
    typeof value === "string" && LEVEL_NAME_ID[value] ? formatMessage({ id: LEVEL_NAME_ID[value] }) : String(value ?? "")
  );
  const lineOf = (change: AssistantSettingChange) => {
    const assistant = change.assistantName || formatMessage({ id: "settings.assistantChanges.assistantFallback" });
    const time = (
      <time key="time" dateTime={change.createdAt}>
        {formatDate(change.createdAt, { dateStyle: "medium", timeStyle: "short" })}
      </time>
    );
    if (change.setting === "conversationMute") {
      return formatMessage({ id: change.nextValue === true ? "settings.assistantChanges.action.muted" : "settings.assistantChanges.action.unmuted" }, {
        assistant, target: targetOf(change), time,
      });
    }
    if (change.setting === "sidebarMove") {
      // Where it went: "top", or "after #general" (named as they saw it then).
      const next = typeof change.nextValue === "string" ? change.nextValue : "";
      const where = next.startsWith("after ")
        ? formatMessage({ id: "settings.assistantChanges.where.after" }, { ref: next.slice("after ".length) })
        : formatMessage({ id: "settings.assistantChanges.where.top" });
      return formatMessage({ id: "settings.assistantChanges.action.moved" }, { assistant, target: targetOf(change), where, time });
    }
    if (change.setting === "sidebarArrange") {
      return formatMessage({ id: "settings.assistantChanges.action.arranged" }, { assistant, time });
    }
    if (change.setting === "agentMove") {
      return formatMessage({ id: "settings.assistantChanges.action.agentMoved" }, {
        assistant,
        agent: change.targetRef || formatMessage({ id: "settings.assistantChanges.target.goneAgent" }),
        to: typeof change.nextValue === "string" ? change.nextValue : "",
        time,
      });
    }
    if (change.setting === "messageSave") {
      return formatMessage({ id: change.nextValue === true ? "settings.assistantChanges.action.messageSaved" : "settings.assistantChanges.action.messageUnsaved" }, {
        assistant, target: change.targetRef || formatMessage({ id: "settings.assistantChanges.target.goneMessage" }), time,
      });
    }
    if (change.setting === "sidebarPin") {
      return formatMessage({ id: change.nextValue === true ? "settings.assistantChanges.action.pinned" : "settings.assistantChanges.action.unpinned" }, {
        assistant, target: targetOf(change), time,
      });
    }
    if (change.setting === "notificationLevel") {
      return formatMessage({ id: "settings.assistantChanges.action.level" }, {
        assistant, target: targetOf(change), from: levelOf(change.previousValue), to: levelOf(change.nextValue), time,
      });
    }
    return formatMessage({ id: "settings.assistantChanges.line" }, {
      assistant,
      setting: formatMessage({ id: SETTING_NAME_ID[change.setting] }),
      from: valueOf(change.setting, change.previousValue),
      to: valueOf(change.setting, change.nextValue),
      time,
    });
  };

  const valueOf = (setting: ChangedSettingValue, value: string | boolean | null): string => {
    if (value === null || value === "") return formatMessage({ id: "settings.assistantChanges.notSet" });
    if (typeof value === "boolean") return formatMessage({ id: value ? "settings.assistantChanges.on" : "settings.assistantChanges.off" });
    if (setting === "theme" && isRaftThemeId(value)) return formatMessage({ id: RAFT_THEME_NAME_ID[value] });
    if (setting === "displayLanguage" && isSupportedLocale(value)) return LOCALE_LABELS[value];
    return value;
  };

  return (
    <ul className="stack-y-1">
      {shown.map((change) => (
        <li key={change.id} className="text-footnote text-foreground-muted" data-testid="assistant-setting-change">
          {lineOf(change)}
          {change.serverId !== undefined && change.serverId !== serverId ? (
            <span className="ms-1" data-testid="assistant-setting-change-server">
              {change.serverName
                ? formatMessage({ id: "settings.assistantChanges.inServer" }, { server: change.serverName })
                : formatMessage({ id: "settings.assistantChanges.anotherServer" })}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
