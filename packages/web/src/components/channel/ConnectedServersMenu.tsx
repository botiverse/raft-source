import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@botiverse/raft-ui";
import { EllipsisVertical, Plug } from "lucide-react";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { ConnectYourServersDialog } from "./ConnectYourServersDialog";
import type { MemberConnectRow } from "./memberConnect";

/**
 * The ⋯ at the end of Connected servers' heading (#wg-rbac:#36, design entry
 * C, cindyz): one item, Connect your servers, opening the dialog. The caller
 * draws it only where the viewer can connect a server (useMemberConnectRows).
 */
export function ConnectedServersMenu(props: {
  channelId: string;
  /** Without its #. */
  channelName: string;
  channelType: "joint" | "private";
  hostName: string;
  guest: boolean;
  rows: readonly MemberConnectRow[];
}) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);
  const label = formatMessage({ id: "channel.memberConnect.menuLabel" });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(
            <Button
              type="button"
              size="icon-md"
              variant="ghost"
              // Pulled into the eyebrow's line, as the ⓘ beside it is.
              className="-my-1 ml-auto text-foreground-muted hover:text-foreground"
              aria-label={label}
              data-testid="channel-settings-joint-servers-menu"
            />
          )}
        >
          <EllipsisVertical aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={label}>
          <DropdownMenuItem onClick={openDialog} data-testid="channel-settings-connect-your-servers">
            <Plug aria-hidden="true" />
            {formatMessage({ id: "channel.memberConnect.menuItem" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && <ConnectYourServersDialog {...props} onClose={closeDialog} />}
    </>
  );
}
