// This device › Servers (design §4.3 ③): the servers this machine's Computer
// is attached to, one ListRow each, in a ListRowGroup. The current server
// first: when this machine is not one of its computers, a row says so with
// "Add to this server". Each attachment's ⋮ menu opens that server's
// computer page, or disconnects this device from it (B4 `detach`: its key
// there is revoked and its local attachment removed; the data stays).
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { EllipsisVertical } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  Text,
} from "@botiverse/raft-ui";
import type { Machine } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import { localComputerErrorMessage } from "./localComputerCopy";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { useLocalComputerSnapshot } from "./localComputerStore";
import { ThisDeviceConfirm } from "./thisDeviceParts";

interface ServerRow {
  serverId: string;
  slug: string | null;
  name: string;
  /** This machine's row on the current server (the current server only). */
  machine: Machine | null;
  current: boolean;
}

function ServerRowMenu({ row, canDisconnect, onOpen, onDisconnect }: {
  row: ServerRow;
  canDisconnect: boolean;
  onOpen: (row: ServerRow) => void;
  onDisconnect: (row: ServerRow) => void;
}) {
  const { formatMessage } = useIntl();
  const open = useCallback(() => onOpen(row), [onOpen, row]);
  const disconnect = useCallback(() => onDisconnect(row), [onDisconnect, row]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-md"
            aria-label={formatMessage({ id: "computerHost.thisDevice.servers.actions" }, { server: row.name })}
            data-testid={`this-device-server-menu-${row.serverId}`}
          />
        )}
      >
        <EllipsisVertical aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {row.slug ? (
          <DropdownMenuItem onClick={open}>{formatMessage({ id: "computerHost.thisDevice.servers.open" })}</DropdownMenuItem>
        ) : null}
        {canDisconnect ? (
          <DropdownMenuItem onClick={disconnect} data-testid={`this-device-server-disconnect-${row.serverId}`}>
            {formatMessage({ id: "computerHost.thisDevice.servers.disconnect" })}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThisDeviceServers({ host, machine, currentServer, onAdd }: {
  host: LocalComputerHost;
  /** This machine's row on the current server, when it is one of its computers. */
  machine: Machine | null;
  currentServer: { id: string; slug: string; name: string } | null;
  /** Add Computer's flow (the "Setting up this Mac" dialog). */
  onAdd: (() => void) | null;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const navigate = useNavigate();
  const servers = useServerStore((s) => s.servers);
  const { hostname } = useLocalComputerSnapshot();
  const [confirming, setConfirming] = useState<ServerRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  // The host's answer (useLocalComputerHost): an attachment another Raft
  // account made here is "not added" for this account, and is not listed.
  const attachedHere = !host.self.state.flags.notAttachedHere;
  const isCurrent = (attachment: { serverId: string; serverSlug: string | null }) => currentServer !== null
    && (attachment.serverId === currentServer.id || attachment.serverSlug === currentServer.slug);
  const rows: ServerRow[] = host.self.servers.filter((attachment) => attachedHere || !isCurrent(attachment)).map((attachment) => {
    const known = servers.find((s) => s.id === attachment.serverId || (attachment.serverSlug !== null && s.slug === attachment.serverSlug));
    const current = isCurrent(attachment);
    return {
      serverId: attachment.serverId,
      slug: known?.slug ?? attachment.serverSlug ?? null,
      name: known?.name ?? (attachment.serverSlug ? `/${attachment.serverSlug}` : attachment.serverId),
      machine: current ? machine : null,
      current,
    };
  }).sort((a, b) => Number(b.current) - Number(a.current));

  const openRow = useCallback((row: ServerRow) => {
    if (!row.slug) return;
    navigate(row.current && row.machine ? `/s/${row.slug}/computer/${row.machine.id}` : `/s/${row.slug}/computers`);
  }, [navigate]);
  const askDisconnect = useCallback((row: ServerRow) => setConfirming(row), []);
  const closeConfirm = useCallback(() => setConfirming(null), []);
  const disconnect = useCallback(() => {
    const row = confirming;
    setConfirming(null);
    if (!row || !host.detach) return;
    setBusy(row.serverId);
    setError(null);
    void host.detach(row.serverId)
      .catch((e: unknown) => setError(e ?? new Error("unknown")))
      .finally(() => setBusy(null));
  }, [confirming, host]);

  const canDisconnect = host.detach !== null && host.self.state.controllable;
  // Each row says what is true now, never "Connected" when it isn't: not
  // running here (stopped, failed to start) is offline everywhere; the current
  // server's view of its row (online, or still connecting) and "waiting to be
  // listed" are known; another server's view is not, so it is only "Added".
  const rowState = (row: ServerRow): string => {
    // Always "Added as <name>", the name this device has there (this server's
    // row; elsewhere the same device's name), plus its state when this page
    // knows it. Another server's live view is not known here: no state then,
    // unless Raft Computer is not running at all (offline everywhere).
    const name = row.machine?.name ?? machine?.name ?? hostname ?? formatMessage({ id: host.self.deviceKind === "mac" ? "computerHost.nameMac" : "computerHost.nameOther" });
    const added = formatMessage({ id: "computerHost.thisDevice.servers.addedAs" }, { name });
    const state = !host.self.running
      ? formatMessage({ id: "computerHost.thisDevice.servers.stateOffline" })
      : row.current && host.self.state.flags.awaitingListing
        ? formatMessage({ id: host.self.deviceKind === "mac" ? "computerHost.thisDevice.awaitingListingMac" : "computerHost.thisDevice.awaitingListingOther" }, { server: row.name })
        : row.current && row.machine
          ? formatMessage({ id: row.machine.status === "online" ? "computerHost.thisDevice.servers.stateConnected" : "computerHost.thisDevice.servers.stateConnecting" })
          : null;
    return state ? formatMessage({ id: "computerHost.thisDevice.servers.withState" }, { added, state }) : added;
  };

  return (
    <div data-testid="this-device-servers">
      {rows.length === 0 && attachedHere ? null : (
        <ListRowGroup>
          {currentServer && !attachedHere ? (
            <ListRow variant="plain" render={<div />} data-testid="this-device-server-not-attached">
              <ListRowBody>
                <ListRowTitle>{currentServer.name}</ListRowTitle>
                <ListRowDescription>{formatMessage({ id: "computerHost.thisDevice.servers.notAdded" })}</ListRowDescription>
              </ListRowBody>
              {onAdd ? (
                <Button
                  variant="outline"
                  size="md"
                  onClick={onAdd}
                  data-computer-op="enable"
                  data-testid="this-device-add"
                >
                  {formatMessage({ id: "computerHost.thisDevice.addToServer" })}
                </Button>
              ) : null}
            </ListRow>
          ) : null}
          {rows.map((row) => {
            return (
              <ListRow key={row.serverId} variant="plain" render={<div />} data-testid={`this-device-server-${row.serverId}`}>
                <ListRowBody>
                  <ListRowTitle>{row.name}</ListRowTitle>
                  <ListRowDescription>
                    {busy === row.serverId ? formatMessage({ id: "computerHost.thisDevice.servers.disconnecting" }) : rowState(row)}
                  </ListRowDescription>
                </ListRowBody>
                {row.slug || canDisconnect ? (
                  <ServerRowMenu row={row} canDisconnect={canDisconnect && busy === null} onOpen={openRow} onDisconnect={askDisconnect} />
                ) : null}
              </ListRow>
            );
          })}
        </ListRowGroup>
      )}
      {error ? (
        <Text.Sans size="caption" variant="muted" role="alert" className="mt-2 block">{localComputerErrorMessage(error, intl)}</Text.Sans>
      ) : null}
      {confirming ? (
        <ThisDeviceConfirm
          testId="this-device-disconnect-confirm"
          title={formatMessage({ id: "computerHost.thisDevice.disconnect.title" }, { server: confirming.name })}
          body={formatMessage({ id: "computerHost.thisDevice.disconnect.body" }, { server: confirming.name })}
          confirmLabel={formatMessage({ id: "computerHost.thisDevice.disconnect.confirm" })}
          onConfirm={disconnect}
          onClose={closeConfirm}
        />
      ) : null}
    </div>
  );
}
