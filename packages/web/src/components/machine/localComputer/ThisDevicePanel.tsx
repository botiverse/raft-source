// /s/:slug/computers/this-device (design §4.1): This device while this
// machine is not one of the current server's computers. The same page as the
// computer's own (the panel header, MachineProfileHead with its status chip,
// then ThisDeviceSections), so nothing jumps when it is added or
// disconnected; the chip says it is not connected to this server. Once it is
// one of them, the route moves to its computer page (and back after it is
// disconnected). Only in Raft Desktop: a browser has no This device and goes
// to Computers.
import { useMemo } from "react";
import { useIntl } from "react-intl";
import { Navigate, useLocation } from "react-router-dom";
import { ScrollArea, Separator } from "@botiverse/raft-ui";
import { useServerStore } from "../../../store/serverStore";
import { getDesktopBridge } from "../../../utils/desktopBridge";
import { computerOsName } from "../../../utils/computerDevice";
import MachinePanelHeader from "../MachinePanelHeader";
import { ComputerDeviceIcon } from "../ComputerDeviceIcon";
import { MachineProfileHead } from "../MachineProfileHead";
import { useLocalComputerHost } from "./useLocalComputerHost";
import { useLocalComputerSnapshot } from "./localComputerStore";
import { ThisDeviceSections } from "./ThisDeviceSections";
import { thisDevicePath, thisDeviceSectionParam } from "./thisDeviceRoute";

const DEVICE = {};

export function ThisDevicePanel() {
  const { formatMessage } = useIntl();
  const host = useLocalComputerHost();
  const { hostname } = useLocalComputerSnapshot();
  const server = useServerStore((s) => s.current);
  const location = useLocation();
  const section = thisDeviceSectionParam(location.search);
  const currentServer = useMemo(() => (server ? { id: server.id, slug: server.slug, name: server.name } : null), [server]);
  const title = formatMessage({ id: host?.self.deviceKind === "mac" ? "computerHost.nameMac" : "computerHost.nameOther" });
  const headMachine = useMemo(() => ({ name: title }), [title]);

  if (!host) return <Navigate to={server?.slug ? `/s/${server.slug}/computers` : "/"} replace />;
  // One of this server's computers: its own page carries This device.
  if (host.ready && host.self.machineId && server?.slug) {
    return <Navigate to={thisDevicePath(server.slug, host.self.machineId, section)} replace />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col font-sans" data-testid="this-device-panel">
      <MachinePanelHeader machine={headMachine} />
      {/* Scrolls in a raft-ui ScrollArea, as the computer's own page does; a region named like the page. */}
      <ScrollArea role="region" aria-label={title} className="min-h-0 flex-1 bg-layer-canvas">
        <MachineProfileHead
          icon={<ComputerDeviceIcon machine={DEVICE} />}
          name={title}
          tone="offline"
          statusLabel={formatMessage({ id: "computerHost.notConnected" }, { server: server?.name ?? "" })}
          hostname={hostname}
          platformLine={computerOsName({ os: getDesktopBridge()?.platform ?? null })}
        />
        <Separator />
        {/* Keyed by server: an add in flight, done or failed belongs to its server. */}
        <ThisDeviceSections key={currentServer?.slug ?? ""} host={host} machine={null} currentServer={currentServer} variant="standalone" initialSection={section} />
      </ScrollArea>
    </div>
  );
}
