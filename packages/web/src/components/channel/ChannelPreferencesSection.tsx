import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { UserRound } from "lucide-react";
import { ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Switch } from "@botiverse/raft-ui";
import SectionHeader from "../ui/SectionHeader";
import { useServerStore } from "../../store/serverStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { NotificationLevelSelect } from "../notifications/NotificationLevelMenu";
import { ChannelSectionSelect } from "./ChannelSectionSelect";
import { useConversationSidebarSection } from "./useConversationSidebarSection";
import type { NotificationLevelTarget } from "../notifications/NotificationLevelMenu";

/**
 * The per-user conversation preferences — sidebar placement (the Move to
 * section select, Pinned included), (panel-only) Activity mute,
 * and the collapse-long-messages switch. Extracted from EditChannelDialog
 * (task #703) so the DM settings sheet renders the SAME preferences block as
 * the channel one: a DM has no name/description form, but section and display
 * prefs apply to it unchanged (only a DM with an App bot can be muted, so the
 * mute row only ever appears when the caller passes `activityMute`). Each row is
 * its title and its control; only Mute keeps a line (who isn't notified).
 *
 * In the channel details (raft-design channel.md, stdrc 2026-11-10) it is the
 * "Your preferences" group: settings rows in a ListRowGroup under a
 * SectionHeader, the same rows the Settings pages draw.
 */
export interface ChannelPreferencesSectionProps {
  channelId: string;
  /**
   * Whose settings these are. An Agent Lounge has no section select (a Lounge
   * sits only in Direct Messages or Pinned; its sidebar row's menu pins it) and
   * a plain Mute switch, as a DM.
   */
  conversationKind: "channel" | "dm" | "lounge";
  /** Mute is a panel-only surface; callers without the capability omit it. */
  isPanel?: boolean;
  activityMute?: {
    muted: boolean;
    busy: boolean;
    onToggle: () => void;
  };
  collapseLongMessages?: {
    enabled: boolean;
    busy: boolean;
    onToggle: () => void;
  };
}

export function ChannelPreferencesSection({
  channelId,
  conversationKind,
  isPanel = false,
  activityMute,
  collapseLongMessages,
}: ChannelPreferencesSectionProps) {
  const { formatMessage } = useIntl();
  const isDm = conversationKind === "dm";
  const isLounge = conversationKind === "lounge";
  // The sidebar's model of this conversation: a DM is placed by its channel
  // id but pinned by its peer, at home in Direct Messages.
  const sidebarSection = useConversationSidebarSection(channelId, isLounge ? "channel" : conversationKind);
  // The Switch passes the next checked state; the toggles take no argument.
  const toggleMute = activityMute?.onToggle;
  const handleToggleMute = useCallback(() => toggleMute?.(), [toggleMute]);
  const toggleCollapse = collapseLongMessages?.onToggle;
  const handleToggleCollapse = useCallback(() => toggleCollapse?.(), [toggleCollapse]);
  // The conversation's notification level sits beside its mute (design §4.3).
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const storeMuted = useChannelStore((s) => {
    const channel = findStoredChannel(s, channelId);
    return channel?.activityMuted === true;
  });
  const muted = activityMute?.muted ?? storeMuted;
  // A channel's level and its mute are one choice (All / Only what involves
  // me / Mute), as in Slack; a DM has only Mute.
  const levelTarget = useMemo<NotificationLevelTarget | null>(() => (serverId && !isDm && !isLounge
    ? {
      scope: "channel",
      serverId,
      channelId,
      mute: toggleMute ? { muted, setMuted: (next: boolean) => (next === muted ? undefined : toggleMute()) } : undefined,
    }
    : null), [channelId, isDm, isLounge, muted, serverId, toggleMute]);

  return (
    <section className="stack-y-3" data-testid="channel-settings-preferences" aria-labelledby="channel-settings-preferences-heading">
      {/* "Your preferences": only for this person. Its name says so, so the heading carries no hint
          (stdrc 2026-11-10, raft-design writing.md). */}
      <SectionHeader
        icon={<UserRound size={16} aria-hidden="true" />}
        label={<span id="channel-settings-preferences-heading">{formatMessage({ id: "channel.details.yourPreferences" })}</span>}
      />
      {/* Settings rows like the Settings pages' (DS Forms, "A setting's row"): a select of phrases sits under
          the row's text, a switch ends its row. */}
      <ListRowGroup>
        {isPanel && levelTarget && (
          <ListRow variant="plain" interactive={false} data-testid="channel-settings-notification-level">
            <ListRowBody>
              <ListRowTitle id="channel-settings-notification-level-label">
                {formatMessage({ id: "notifications.level.menuLabel" })}
              </ListRowTitle>
              <div className="pt-2">
                <NotificationLevelSelect
                  target={levelTarget}
                  disabled={activityMute?.busy === true}
                  aria-labelledby="channel-settings-notification-level-label"
                  testId="channel-settings-notification-level-select"
                />
              </div>
            </ListRowBody>
          </ListRow>
        )}
        {isPanel && activityMute && !levelTarget && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="channel-settings-mute-label">
                {formatMessage({ id: "message.channelSettings.muteActivityTitle" })}
              </ListRowTitle>
              <ListRowDescription id="channel-settings-mute-description" wrap>
                {formatMessage({ id: "message.channelSettings.muteActivityDescription" })}
              </ListRowDescription>
            </ListRowBody>
            <Switch
              checked={activityMute.muted}
              disabled={activityMute.busy}
              onCheckedChange={handleToggleMute}
              aria-labelledby="channel-settings-mute-label"
              aria-describedby="channel-settings-mute-description"
              data-testid="channel-overflow-mute-switch"
            />
          </ListRow>
        )}
        {!isLounge && (
          <ListRow variant="plain" interactive={false} data-testid="channel-settings-section">
            <ListRowBody>
              <ListRowTitle id="channel-settings-section-label">
                {formatMessage({ id: "channel.details.sidebarSection" })}
              </ListRowTitle>
              <div className="pt-2">
                <ChannelSectionSelect section={sidebarSection} aria-labelledby="channel-settings-section-label" />
              </div>
            </ListRowBody>
          </ListRow>
        )}
        {collapseLongMessages && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="channel-settings-collapse-label">
                {formatMessage({ id: "message.channelSettings.collapseLongMessagesTitle" })}
              </ListRowTitle>
            </ListRowBody>
            <Switch
              checked={collapseLongMessages.enabled}
              disabled={collapseLongMessages.busy}
              onCheckedChange={handleToggleCollapse}
              aria-labelledby="channel-settings-collapse-label"
              data-testid="channel-settings-collapse-switch"
            />
          </ListRow>
        )}
      </ListRowGroup>
    </section>
  );
}
