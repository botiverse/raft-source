import { Badge, Button, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { Server } from "../../store/serverStore";
import AvatarSlot from "../ui/AvatarSlot";

/** How a row's state reads at a glance (raft-ui Badge variants). */
export type ServerProgressTone = "success" | "information" | "warning" | "danger" | "muted";

/** One server's line in the progress list, its words already formatted. */
export interface ServerProgressRow {
  serverId: string;
  name: string;
  /** Its state, in a word or two: Connected, Connecting…, Waiting for approval, Not connected. */
  badge: string;
  tone: ServerProgressTone;
  /** Under the name: whom they asked, or why it was refused. */
  detail?: string;
  /** Waiting for its approver: the request the invitee may withdraw. */
  cancel?: { requestId: string; approverName: string };
}

/**
 * The invitee's chosen servers and where each stands with the invite (DS
 * ListRow › inset list, display-only): its tile, its name, its state as a
 * Badge (so refused and waiting look apart) and, under the name, whom they
 * asked or why it was refused. A server waiting for its approver ends with
 * Cancel Request, named for that server.
 */
export function ServerProgressList({
  rows,
  myServer,
  cancelLabel,
  cancelAriaLabel,
  onCancel,
  disabled,
}: {
  rows: readonly ServerProgressRow[];
  myServer: (id: string) => Server | null;
  cancelLabel: string;
  /** The Cancel Request button's accessible name for one server ("Cancel the request for Contoso"). */
  cancelAriaLabel: (server: string) => string;
  onCancel: (cancel: { requestId: string; approverName: string }) => void;
  disabled: boolean;
}) {
  return (
    <ListRowGroup className="mb-6" data-testid="external-invite-progress">
      {rows.map((row) => (
        <ListRow key={row.serverId} interactive={false} data-testid="external-invite-progress-row" data-server-id={row.serverId}>
          <span className="shrink-0" aria-hidden="true">
            <AvatarSlot
              context="list-row"
              type="server"
              serverAvatarUrl={myServer(row.serverId)?.avatarUrl ?? null}
              serverInitial={row.name.slice(0, 1)}
            />
          </span>
          <ListRowBody>
            <ListRowTitle>{row.name}</ListRowTitle>
            {row.detail ? <ListRowDescription wrap>{row.detail}</ListRowDescription> : null}
          </ListRowBody>
          <Badge appearance="soft" variant={row.tone} data-testid="external-invite-progress-state" data-tone={row.tone}>
            {row.badge}
          </Badge>
          {row.cancel ? (
            <CancelButton cancel={row.cancel} label={cancelLabel} ariaLabel={cancelAriaLabel(row.name)} onCancel={onCancel} disabled={disabled} />
          ) : null}
        </ListRow>
      ))}
    </ListRowGroup>
  );
}

function CancelButton({ cancel, label, ariaLabel, onCancel, disabled }: {
  cancel: { requestId: string; approverName: string };
  label: string;
  ariaLabel: string;
  onCancel: (cancel: { requestId: string; approverName: string }) => void;
  disabled: boolean;
}) {
  const handleClick = useCallback(() => onCancel(cancel), [onCancel, cancel]);
  return (
    <Button size="sm" variant="outline" type="button" onClick={handleClick} disabled={disabled} aria-label={ariaLabel} data-testid="external-invite-progress-cancel">
      {label}
    </Button>
  );
}
