import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { Button } from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import AppEmptyState from "../../components/ui/EmptyState";
import { useIsDesktopShell } from "../../components/layout/ShellFrame";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { tabHomeFor, useMobileNavStore } from "../../store/mobileNavStore";
import { useServerStore } from "../../store/serverStore";

/**
 * The open channel this person was removed from (store/channelAccessLoss):
 * one line saying so, and the way back to the server's channels, in place of
 * the conversation (or the empty "Select a channel" it used to fall to).
 * Raft DS › EmptyState: the area's only content, so the title is a heading,
 * and one ink-bordered button. A Guest has no channel list to go back to (the
 * server's root shows GuestNoChannel), so its button opens Settings instead:
 * its account and Sign out.
 *
 * `unavailable`: a link or URL to a conversation the server won't show (it
 * doesn't exist, was deleted, or this person can't read it: one answer for
 * all, so one sentence that tells none of them apart). On a phone its button
 * says and goes to the conversation list (Home's root, as Home left it).
 */
export function ChannelAccessLost({ unavailable = false }: { unavailable?: boolean }) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const slug = useServerStore((s) => s.current?.slug);
  const guest = useServerPermissions().role === "guest";
  // A phone's server root is the Home tab's conversation list, so the
  // unavailable link's button is named for it there; desktop keeps "Back to
  // channels" (its root opens the first channel beside the sidebar).
  const desktop = useIsDesktopShell();
  const phoneList = unavailable && !desktop;
  const goBack = useCallback(() => {
    if (!slug) return;
    if (guest) navigate(`/s/${slug}/settings`);
    else if (phoneList) navigate(useMobileNavStore.getState().roots.chat ?? tabHomeFor("chat", `/s/${slug}`), { replace: true });
    else navigate(`/s/${slug}`, { replace: true });
  }, [guest, navigate, phoneList, slug]);
  const backLabel = guest
    ? "layout.main.guestNoChannelSettings"
    : phoneList ? "layout.main.conversationUnavailableBackPhone" : "layout.main.channelAccessLostBack";
  return (
    <AppEmptyState
      className="flex h-full flex-1 flex-col items-center justify-center p-6"
      data-testid={unavailable ? "conversation-unavailable" : "channel-access-lost"}
      titleHeading="h2"
      icon={<MessageIcon />}
      title={formatMessage({ id: unavailable ? "layout.main.conversationUnavailable" : "layout.main.channelAccessLost" })}
      action={(
        <Button variant="default" size="md" onClick={goBack} data-testid="channel-access-lost-back">
          {formatMessage({ id: backLabel })}
        </Button>
      )}
    />
  );
}
