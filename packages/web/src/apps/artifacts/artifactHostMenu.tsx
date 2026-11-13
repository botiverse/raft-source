import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Globe, Monitor } from "lucide-react";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from "@botiverse/raft-ui";

import { HOST_STATE_EVENT, hostMenuItems, isChromeless, readHostDesktop } from "../../embed";
import type { HostMenuItem } from "../../embed";
import { requestArtifactHostAction } from "./artifactPageOpening";

/**
 * The App's Desktop mode as the App last said (`hostDesktop=on|off` in the address, read again on its
 * `raft:host-state` event): the page never sets it, it asks (`#host=desktop-mode`) and follows what the App says.
 */
function useHostDesktop(): boolean {
  const [on, setOn] = useState(() => readHostDesktop(window.location.search) === true);
  useEffect(() => {
    const follow = () => setOn(readHostDesktop(window.location.search) === true);
    window.addEventListener(HOST_STATE_EVENT, follow);
    return () => window.removeEventListener(HOST_STATE_EVENT, follow);
  }, []);
  return on;
}

/**
 * The first group of the Artifact page's ⋯ in the App, where the App declared its own items (`hostMenu`, embed.ts;
 * Lagoon, artin: one top bar, mobile #4635): Desktop mode, checked as the App says, and Open in browser. Each asks
 * the App (`#host=<item>`, artifactPageOpening): the App does it, from this Artifact's id and the version in the page
 * path, never from anything the page sends. Nothing where the App declared none, or draws the toolbar itself.
 */
export function ArtifactHostMenuItems() {
  if (isChromeless()) return null;
  const items = hostMenuItems();
  if (items.length === 0) return null;
  return <HostMenuGroup items={items} />;
}

const askDesktopMode = () => requestArtifactHostAction("desktop-mode");
const askOpenInBrowser = () => requestArtifactHostAction("open-in-browser");

function HostMenuGroup({ items }: { items: readonly HostMenuItem[] }) {
  const { formatMessage } = useIntl();
  const desktop = useHostDesktop();
  return (
    <>
      {items.includes("desktop-mode") ? (
        <DropdownMenuCheckboxItem
          checked={desktop}
          onCheckedChange={askDesktopMode}
          closeOnClick
          data-testid="artifact-page-menu-host-desktop-mode"
        >
          <Monitor />
          {formatMessage({ id: "artifacts.page.hostDesktopMode" })}
        </DropdownMenuCheckboxItem>
      ) : null}
      {items.includes("open-in-browser") ? (
        <DropdownMenuItem onClick={askOpenInBrowser} data-testid="artifact-page-menu-host-open-in-browser">
          <Globe />
          {formatMessage({ id: "artifacts.page.hostOpenInBrowser" })}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
    </>
  );
}
