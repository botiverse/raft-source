// The machine the host app runs on, while it is not one of this server's
// computers (useLocalComputerHost.ts): the first row of the Computers list
// (design §4.1), under the "This device" group label. The row opens the This
// device page (/s/:slug/computers/this-device), whose Add to this server
// (naming the server) is the one way to add it: the row itself has no button.
//
// The same Raft Design System sidebar row as its siblings (`rf-srow--two`,
// ComputerRow's anatomy): the monitor glyph with its presence pixel, the name
// in row type, and the state in Space Mono (thisDeviceStatePhrase: never a
// command; "Setting up…" while it is being added). A problem
// (thisDeviceLogic: a failed move, an update required, …) turns the pixel orange (DS:
// a problem is orange).
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import { Monitor } from "lucide-react";
import { SidebarItem, SidebarItemIcon, SidebarItemMeta } from "@botiverse/raft-ui";
import StatusDot from "../../ui/StatusDot";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { thisDevicePresence, thisDeviceStatusPhrase } from "./thisDeviceCopy";
import { THIS_DEVICE_SEGMENT, thisDevicePath } from "./thisDeviceRoute";

export default function ThisComputerSidebarRow({ host, server }: { host: LocalComputerHost; server: { slug: string; name: string } }) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { slug } = server;
  const openPage = useCallback(() => navigate(thisDevicePath(slug, null)), [navigate, slug]);

  const { self } = host;
  const name = formatMessage({ id: self.deviceKind === "mac" ? "computerHost.nameMac" : "computerHost.nameOther" });
  const state = thisDeviceStatusPhrase(self.state, self.deviceKind, server.name, intl);
  const presence = thisDevicePresence(self.state.kind, self.state.problem, self.state.flags.awaitingListing);
  const selected = pathname.endsWith(`/computers/${THIS_DEVICE_SEGMENT}`);

  return (
    <SidebarItem wrap active={selected} onClick={openPage} data-testid="this-computer-card" data-this-device="true" className="text-left">
      <SidebarItemIcon className="relative overflow-visible">
        <Monitor />
        <StatusDot
          aria-hidden
          presence={presence}
          className="absolute -right-1 -bottom-1"
          data-testid="this-computer-status-dot"
        />
      </SidebarItemIcon>
      <div className="min-w-0 flex-1">
        <div className="flex items-center">
          <span className="min-w-0 truncate">{name}</span>
        </div>
        <SidebarItemMeta className="mt-0.5 block break-words" data-testid="this-computer-state">{state}</SidebarItemMeta>
      </div>
    </SidebarItem>
  );
}
