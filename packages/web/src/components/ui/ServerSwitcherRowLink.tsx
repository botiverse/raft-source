import { memo } from "react";
import { Check } from "lucide-react";
import type { Server } from "../../store/serverStore";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";
import AvatarSlot from "./AvatarSlot";
import ServerRowUnread from "./ServerRowUnread";

/**
 * A server row's link in the switcher (ServerSwitcherMenu's sortable row): the avatar, the name and slug, the current
 * check and the unread. Memoized: the sortable row renders on every pointer move while it is dragged and on every
 * change of the row under the pointer; this renders only when the server or its unread does.
 */
export const ServerSwitcherRowLink = memo(function ServerSwitcherRowLink({ server, isCurrent, unreadSummary, targetHref, onSelect }: {
  server: Server;
  isCurrent: boolean;
  unreadSummary?: ServerUnreadSummary;
  targetHref: string;
  onSelect: (server: Server, targetHref: string) => void;
}) {
  const initial = (server.name || "S").trim().charAt(0).toUpperCase() || "S";
  // Activity's server summary is the cross-surface authority. An absent field
  // is unknown, so do not substitute the broader legacy sidebar count.
  return (
    <a
      href={targetHref}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onSelect(server, targetHref);
      }}
      className={`flex min-w-0 flex-1 items-center gap-2.5 md:pointer-fine:gap-2 rounded-chip py-0 pl-2.5 pr-1 text-left outline-none ${
        isCurrent ? "font-bold" : ""
      }`}
    >
      {/* With a mouse the trigger's 27px avatar, in a 40px row (48 with 35 by touch; stdrc, 2026-11-04). */}
      <AvatarSlot context="switcher-row" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={initial} />
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate">{server.name}</div>
        <div className="truncate font-mono text-mono-meta font-normal text-foreground-hint">/{server.slug}</div>
      </div>
      {isCurrent ? <Check size={16} className="shrink-0 text-foreground" aria-hidden="true" /> : null}
      <ServerRowUnread summary={unreadSummary} isCurrent={isCurrent} />
    </a>
  );
});
