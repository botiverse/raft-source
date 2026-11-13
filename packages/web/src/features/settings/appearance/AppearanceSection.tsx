import HowLinksOpenSetting from "../../../components/deeplinks/HowLinksOpenSetting";
import { HowWebLinksOpenSetting } from "../../webPreview/HowWebLinksOpenSetting";
import { Card, Switch, ListRowGroup, ListRow, ListRowBody, ListRowTitle } from "@botiverse/raft-ui";
import { useMemo } from "react";
import { Type } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useIntl } from "react-intl";
import SectionEyebrow from "../../../components/ui/SectionEyebrow";
import SectionHeader from "../../../components/ui/SectionHeader";
import MessageItem from "../../../components/message/MessageItem";
import type { MentionEntry } from "../../../components/message/MessageItem";
import type { Message } from "../../../store/messageStore";
import type { Agent } from "../../../store/agentStore";
import type { Channel } from "../../../store/channelStore";
import { useAppearanceStore } from "../../../store/appearanceStore";
import { MessageBodyFontSizeSegmentedControl } from "../../../components/settings/SettingsSegmentedControls";
import { AppearanceThemeSettingsControl } from "../../../components/settings/AppearanceThemePicker";
import { ServerThemeLink } from "./ServerThemeLink";
import { AssistantOtterSettingsSection } from "../../../assistant/AssistantOtterSettings";
import { ComposerSendKeySetting } from "./ComposerSendKeySetting";

const APPEARANCE_PREVIEW_AGENT: Agent = {
  id: "appearance-preview-agent",
  name: "cindy-preview",
  displayName: "Cindy",
  avatarUrl: "pixel:random:cindy-preview",
  description: null,
  status: "active",
  model: "preview",
  runtime: "preview",
  serverRole: null,
  reasoningEffort: null,
  executionMode: "cloud",
  envVars: null,
  machineId: null,
  runtimeProfile: null,
  creatorType: null,
  creatorId: null,
  creator: null,
  createdAgents: [],
  deletedAt: null,
  createdAt: "2026-05-19T00:00:00.000Z",
};

const APPEARANCE_PREVIEW_CHANNEL: Channel = {
  id: "appearance-preview-channel",
  name: "proj-uiux",
  description: null,
  type: "channel",
  createdAt: "2026-05-19T00:00:00.000Z",
};

const APPEARANCE_PREVIEW_CHANNELS: Channel[] = [APPEARANCE_PREVIEW_CHANNEL];

const APPEARANCE_PREVIEW_MENTION_MAP = new Map<string, MentionEntry>([
  ["joy", { displayName: "Joy", type: "user", id: "appearance-preview-joy" }],
]);

/**
 * `publicSurface`: the public server page (anonymous or nonmember reader). It has
 * no live agent activity bar, carries no agent model on messages and has no
 * Pinned / Joint / DM sidebar groups, so those three device toggles would do
 * nothing visible there (cindyz, #wg-rbac:22e4889c). Anonymous visitors only
 * need the browser-local theme picker on this surface (cindyz,
 * #wg-rbac:a88cfff6), so every other appearance control stays member-only.
 */
// Exported for publicSettingsAppearance.behavior.test.tsx (removed in the 2026-11 web DOM test prune) (rendered directly,
// same precedent as AboutSection).
export function AppearanceSection({ publicSurface = false }: { publicSurface?: boolean }) {
  const { formatMessage } = useIntl();
  // The Theme page is in the sidebar whenever there is a current server.
  const hasServer = useServerStore((st) => Boolean(st.current));
  const themePageShown = !publicSurface && hasServer;
  const messageBodyFontSize = useAppearanceStore((s) => s.messageBodyFontSize);
  const setMessageBodyFontSize = useAppearanceStore((s) => s.setMessageBodyFontSize);
  const showLiveAgentActivityBar = useAppearanceStore((s) => s.showLiveAgentActivityBar);
  const setShowLiveAgentActivityBar = useAppearanceStore((s) => s.setShowLiveAgentActivityBar);
  const showAgentModelName = useAppearanceStore((s) => s.showAgentModelName);
  const setShowAgentModelName = useAppearanceStore((s) => s.setShowAgentModelName);
  const showSenderDescription = useAppearanceStore((s) => s.showSenderDescription);
  const setShowSenderDescription = useAppearanceStore((s) => s.setShowSenderDescription);
  const hideEmptySidebarSections = useAppearanceStore((s) => s.hideEmptySidebarSections);
  const setHideEmptySidebarSections = useAppearanceStore((s) => s.setHideEmptySidebarSections);
  const previewMessage = useMemo<Message>(() => ({
    id: "appearance-preview-message",
    channelId: APPEARANCE_PREVIEW_CHANNEL.id,
    senderType: "agent",
    senderId: APPEARANCE_PREVIEW_AGENT.id,
    senderName: APPEARANCE_PREVIEW_AGENT.displayName ?? APPEARANCE_PREVIEW_AGENT.name,
    messageType: "chat",
    content: formatMessage({ id: "settings.appearance.fontPreviewSample" }),
    createdAt: new Date().toISOString(),
    attachments: [],
    reactions: [],
  }), [formatMessage]);

  return (
    <div className="mb-6">
      {/* Light or dark lives in Settings › Theme, by the themes (xxchan,
          #triage:56baf365). Only where there is no Theme page (the public
          server page, or no server yet) is it here. */}
      {themePageShown ? null : (
        <Card id="theme" className="mb-6 p-4" data-testid="appearance-mode-card">
          <div className="mb-3 text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.appearance.themeTitle" })}</div>
          <AppearanceThemeSettingsControl />
        </Card>
      )}
      {!publicSurface && (
        <>
      <ServerThemeLink />
      <SectionHeader
        className="mb-3"
        icon={<Type size={16} />}
        label={formatMessage({ id: "settings.appearance.sectionLabel" })}
      />

      {/* Settings rows (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220), each named by its
          title alone, in two groups by topic, 12px apart (cindyz, 2026-11-10,
          #proj-raft-ui:4ae1a74e): the message font size and the preview it changes, then the
          switches for what the app shows. The preview belongs to the font size (ListRow ›
          attached: no hairline between them). Where they are stored is said once, under the
          groups, not on each row. */}
      <div className="stack-y-3" data-testid="appearance-settings">
        <ListRowGroup className="@container" data-testid="appearance-font-size-group">
          <ListRow id="message-font-size" variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <ListRowTitle id="message-font-size-setting-label">{formatMessage({ id: "settings.appearance.messageFontSizeTitle" })}</ListRowTitle>
            </ListRowBody>
            {/* Where the row is narrow (under 32rem of its own width) the control would squeeze the text into a sliver: it goes under it. */}
            <div className="shrink-0 @max-lg:basis-full">
              <MessageBodyFontSizeSegmentedControl
                value={messageBodyFontSize}
                onValueChange={setMessageBodyFontSize}
              />
            </div>
          </ListRow>
          <ListRow
            variant="plain"
            interactive={false}
            attached
            role="group"
            aria-labelledby="message-font-size-setting-label"
            data-testid="message-font-size-preview"
          >
            <div className="min-w-0 flex-1 stack-y-2">
              <SectionEyebrow as="div">
                {formatMessage({ id: "settings.appearance.preview" })}
              </SectionEyebrow>
              <div role="group" className="pointer-events-none -mx-2 rounded-control bg-layer-canvas" aria-label={formatMessage({ id: "settings.appearance.fontSizePreviewAria" })}>
                <MessageItem
                  message={previewMessage}
                  mentionMap={APPEARANCE_PREVIEW_MENTION_MAP}
                  channels={APPEARANCE_PREVIEW_CHANNELS}
                  previewSenderAgent={APPEARANCE_PREVIEW_AGENT}
                  hideThreadActions
                />
              </div>
            </div>
          </ListRow>
        </ListRowGroup>
        <ListRowGroup className="@container" data-testid="appearance-display-group">
          <ListRow id="live-agent-activity" variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="live-agent-activity-setting-label">
                {formatMessage({ id: "settings.appearance.liveAgentActivityTitle" })}
              </ListRowTitle>
            </ListRowBody>
            <Switch
              checked={showLiveAgentActivityBar}
              onCheckedChange={setShowLiveAgentActivityBar}
              aria-labelledby="live-agent-activity-setting-label"
            />
          </ListRow>
          <ListRow id="show-agent-model" variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="agent-model-name-setting-label">
                {formatMessage({ id: "settings.appearance.showAgentModelNameTitle" })}
              </ListRowTitle>
            </ListRowBody>
            <Switch
              checked={showAgentModelName}
              onCheckedChange={setShowAgentModelName}
              aria-labelledby="agent-model-name-setting-label"
            />
          </ListRow>
          <ListRow id="show-sender-description" variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="sender-description-setting-label">
                {formatMessage({ id: "settings.appearance.showSenderDescriptionTitle" })}
              </ListRowTitle>
            </ListRowBody>
            <Switch
              checked={showSenderDescription}
              onCheckedChange={setShowSenderDescription}
              aria-labelledby="sender-description-setting-label"
            />
          </ListRow>
          <ListRow id="hide-empty-sidebar-sections" variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="hide-empty-sidebar-sections-setting-label">
                {formatMessage({ id: "settings.appearance.hideEmptySidebarSectionsTitle" })}
              </ListRowTitle>
            </ListRowBody>
            <Switch
              checked={hideEmptySidebarSections}
              onCheckedChange={setHideEmptySidebarSections}
              aria-labelledby="hide-empty-sidebar-sections-setting-label"
            />
          </ListRow>
          <HowLinksOpenSetting />
          <HowWebLinksOpenSetting />
        </ListRowGroup>
        <p className="px-4 text-footnote text-foreground-hint" data-testid="appearance-saved-on-device">
          {formatMessage({ id: "settings.appearance.savedOnDevice" })}
        </p>
      </div>
        <ComposerSendKeySetting />
        <AssistantOtterSettingsSection />
        </>
      )}
    </div>
  );
}
