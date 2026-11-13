import { Button } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import type { Server } from "../../store/serverStore";
import AvatarSlot from "../ui/AvatarSlot";
import type { ConnectableServer } from "./externalInviteAccept";

/** The row's words, already formatted. */
export interface ConnectServerItemLabels {
  needsApproval: string;
  /** A server at the free plan's one external channel: the row's one-line reason. */
  atLimit: string;
  upgrade: string;
  /** The Upgrade button's accessible name, naming the server ("Upgrade Contoso"). */
  upgradeServer: (server: string) => string;
}

/**
 * A server row in the invite page's connect list: its tile, the name, and
 * the slug (and whether it needs approval) in machine type. A server at its
 * limit (`atLimit`, the server's answer) is listed but can't be chosen, its
 * reason in place of the slug; Upgrade sits at its end only where the
 * invitee owns it (`canUpgrade`; an older server also set it for an admin).
 */
export function connectServerItem(
  server: ConnectableServer,
  mine: Server | null,
  labels: ConnectServerItemLabels,
  onUpgrade: (serverId: string) => void,
): ChoiceListItem {
  const slugText = server.slug ?? mine?.slug ?? null;
  const slug = slugText ? `/${slugText}` : null;
  const detail = [slug, server.needsApproval ? labels.needsApproval : null].filter(Boolean).join(" · ");
  return {
    value: server.id,
    label: server.name,
    searchText: `${server.name} ${slugText ?? ""}`,
    description: server.atLimit
      ? labels.atLimit
      : detail ? <span className="font-mono">{detail}</span> : undefined,
    disabled: server.atLimit === true,
    action: server.atLimit && server.canUpgrade ? (
      <UpgradeButton serverId={server.id} label={labels.upgrade} ariaLabel={labels.upgradeServer(server.name)} onUpgrade={onUpgrade} />
    ) : undefined,
    media: (
      <AvatarSlot
        context="list-row"
        type="server"
        serverAvatarUrl={server.avatarUrl ?? mine?.avatarUrl ?? null}
        serverInitial={server.name.slice(0, 1)}
      />
    ),
  };
}

function UpgradeButton({ serverId, label, ariaLabel, onUpgrade }: { serverId: string; label: string; ariaLabel: string; onUpgrade: (serverId: string) => void }) {
  const handleClick = useCallback(() => onUpgrade(serverId), [onUpgrade, serverId]);
  return (
    <Button size="sm" variant="outline" type="button" onClick={handleClick} aria-label={ariaLabel} data-testid="external-invite-server-upgrade">
      {label}
    </Button>
  );
}
