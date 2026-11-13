// The DM with an App Bot that was removed from its App (#11295). The server
// keeps the Bot's agent row and its DMs but revokes its keys, so it can't
// answer, and marks it `inMemberLists: false` (read through
// isAgentInMemberLists). ChatPanel (the DM) and ThreadPanel (its threads) keep
// the history and show the read-only composer (ReadOnlyComposer) under this
// notice, which says why and where an admin adds it back.
//
// Raft DS › Banner: `warning`, the intent for "something to watch that can be
// recovered from" (orange interrupts, Color › Meanings of color). The Bot no
// longer answers and the composer is off, and an admin can undo it by adding
// the Bot back, like the archived-channel notice in the same place. The way
// there is an inline TextLink variant="strong" inside BannerDescription
// (Banner › Anatomy), only for people who can manage Apps; everyone else reads
// the same words as plain text.

import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Banner, BannerDescription, TextLink } from "@botiverse/raft-ui";
import { TriangleAlert } from "lucide-react";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";

export default function RemovedAppBotDmNotice({ handle }: { handle: string }) {
  const { formatMessage } = useIntl();
  const { capabilities } = useServerPermissions();
  const nav = useAppNavigate();
  // There is no deep link to one installed App's detail, so the link opens the
  // Apps page (the Rail's Apps).
  const openApps = useCallback(() => nav.toApps(), [nav]);
  const settingsApps = formatMessage({ id: "message.chatPanel.appBotRemovedSettingsApps" });
  return (
    <Banner status="warning" data-testid="removed-app-bot-dm-notice">
      <TriangleAlert aria-hidden="true" />
      <BannerDescription>
        {formatMessage(
          { id: "message.chatPanel.appBotRemoved" },
          {
            handle,
            settingsApps: capabilities.manageIntegrations ? (
              <TextLink key="settings-apps" onClick={openApps} variant="strong" data-testid="removed-app-bot-dm-settings-link">
                {settingsApps}
              </TextLink>
            ) : settingsApps,
          },
        )}
      </BannerDescription>
    </Banner>
  );
}
