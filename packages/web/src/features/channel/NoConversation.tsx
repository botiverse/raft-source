import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import AppEmptyState from "../../components/ui/EmptyState";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerStore } from "../../store/serverStore";
import { ChannelAccessLost } from "./ChannelAccessLost";
import { ChatPanel } from "./ChatPanel";

/**
 * A channel or DM URL that can't be opened (MainLayout's ChannelById and
 * DmById). When the server refused it (`unavailable`: missing, deleted or not
 * readable, one answer for all) a member is told so, with the way back to the
 * server's channels; otherwise (it only failed to load) they pick another
 * from the sidebar beside "Select a channel".
 * A Guest has no sidebar and reads only its own channel, so a bookmark, a
 * draft or a path remembered from before goes to the server's root, which
 * opens that channel (or, with none, GuestNoChannel).
 */
export function NoConversation({ unavailable = false }: { unavailable?: boolean }) {
  const guest = useServerPermissions().role === "guest";
  const slug = useServerStore((s) => s.current?.slug);
  if (guest && slug) return <Navigate to={`/s/${slug}`} replace />;
  if (unavailable) return <ChannelAccessLost unavailable />;
  return <ChatPanel channel={null} />;
}

/**
 * A Guest's server root when it has no channel it can read (its channel was
 * archived, or it was taken out of it): a Guest has no channel list, so
 * "Select a channel" would offer nothing to select. Says so, with the way to
 * Settings (its account and Sign out); the rail or the phone's server tab
 * keeps the other servers in reach. Raft DS › EmptyState: the area's only
 * content, so the title is a heading, and one button.
 */
export function GuestNoChannel() {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const server = useServerStore((s) => s.current);
  const slug = server?.slug;
  const openSettings = useCallback(() => {
    if (slug) navigate(`/s/${slug}/settings`);
  }, [navigate, slug]);
  const name = server?.name ?? "";

  return (
    <AppEmptyState
      className="flex h-full flex-1 flex-col items-center justify-center p-6"
      data-testid="guest-no-channel"
      titleHeading="h2"
      icon={<MessageIcon />}
      title={formatMessage({ id: "layout.main.guestNoChannel" }, { server: name })}
      action={(
        <Button variant="default" size="md" onClick={openSettings} data-testid="guest-no-channel-settings">
          {formatMessage({ id: "layout.main.guestNoChannelSettings" })}
        </Button>
      )}
    />
  );
}
