import { useCallback } from "react";
import { useIntl } from "react-intl";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  PickerTriggerButton,
} from "@botiverse/raft-ui";

import AvatarSlot from "../ui/AvatarSlot";

/** A server of the reader's, as the switch names it. */
export interface ForwardServerOption {
  id: string;
  name: string;
  slug: string;
  /** Its uploaded avatar; null: the tile with its initial. */
  avatarUrl: string | null;
}

/**
 * A server's avatar as the workspace switcher draws it (AvatarSlot `type="server"`: its image, else the
 * ink tile with its initial), where an icon goes (`place`); hidden from assistive technology, the name says it.
 */
function ServerAvatar({ server, place }: { server: ForwardServerOption; place: "picker-trigger" | "menu-item" }) {
  return (
    <span aria-hidden="true" className="flex shrink-0" data-testid="forward-server-avatar">
      <AvatarSlot context={place} type="server" serverAvatarUrl={server.avatarUrl} serverInitial={server.name} />
    </span>
  );
}

/**
 * Which of the reader's servers the Forward dialog lists conversations from,
 * at the top of its destinations (the public Artifact page's "Send to
 * conversation", #proj-workspace:#128, for a reader in several): a picker
 * trigger with the server's avatar and name, its menu the servers as radio
 * items (raft-ui DropdownMenu, as the Artifacts page's home filter), each with
 * its avatar as the workspace switcher shows it (#proj-workspace:#140). Only
 * drawn for more than one server.
 */
export function ForwardServerSwitch({ servers, currentId, onChange, disabled = false }: {
  servers: readonly ForwardServerOption[];
  currentId: string;
  onChange: (serverId: string) => void;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const current = servers.find((server) => server.id === currentId);
  // The radio group hands back its value untyped: only a listed server goes on.
  const choose = useCallback((value: unknown) => {
    const next = servers.find((server) => server.id === value);
    if (next && next.id !== currentId) onChange(next.id);
  }, [servers, currentId, onChange]);
  if (!current) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<PickerTriggerButton type="button" data-has-value="" disabled={disabled} className="max-w-full" data-testid="forward-server-switch" />}
        aria-label={formatMessage({ id: "message.forwardComposer.serverSwitch" }, { server: current.name })}
      >
        <ServerAvatar server={current} place="picker-trigger" />
        <span className="min-w-0 truncate" data-testid="forward-server-switch-name">{current.name}</span>
        <span data-picker-trigger-indicator="" aria-hidden="true">
          <ChevronDown />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} data-testid="forward-server-menu">
        <DropdownMenuLabel>{formatMessage({ id: "message.forwardComposer.serverTitle" })}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current.id} onValueChange={choose}>
          {servers.map((server) => (
            <DropdownMenuRadioItem key={server.id} value={server.id} data-testid={`forward-server-${server.slug}`}>
              <ServerAvatar server={server} place="menu-item" />
              <span className="min-w-0 truncate" data-testid="forward-server-name">{server.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
