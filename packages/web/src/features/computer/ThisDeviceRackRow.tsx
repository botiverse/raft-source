import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { Monitor } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardLeading, CardTitle } from "@botiverse/raft-ui";
import type { ComputersRackView } from "../../store/computersRackViewPreference";
import StatusDot from "../../components/ui/StatusDot";
import { thisDevicePresence, thisDeviceStatusPhrase } from "../../components/machine/localComputer/thisDeviceCopy";
import { thisDevicePath } from "../../components/machine/localComputer/thisDeviceRoute";
import type { ThisDeviceListEntry } from "../../components/machine/localComputer/useThisDeviceListEntry";
import type { ComputersListComputerOpened } from "../../analytics/computersList";
import { RACK_IDENTITY_WIDTH, RACK_LINK_SURFACE } from "./computersRackLayout";
import { CardHeading } from "./CardHeading";

/**
 * This device while it is not one of the server's computers (design §4.1):
 * the same row or card as a computer's, with an empty slot strip, its state
 * in words (never a command). The whole row opens the This device page (a
 * stretched link, as a computer's row opens the computer), whose Add to This
 * Server, naming the server, adds it: the row itself has no button.
 */
export function ThisDeviceRackRow({ entry, view, onOpened }: {
  entry: Extract<ThisDeviceListEntry, { kind: "unattached" }>;
  view: ComputersRackView;
  /** Told when the row opened its page, with whether Raft Computer runs here (product analytics, from the list). */
  onOpened?: (status: ComputersListComputerOpened["status"]) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const navigate = useNavigate();
  const { host, server } = entry;
  const { self } = host;
  const name = formatMessage({ id: self.deviceKind === "mac" ? "computerHost.nameMac" : "computerHost.nameOther" });
  const presence = thisDevicePresence(self.state.kind, self.state.problem, self.state.flags.awaitingListing);
  const running = presence === "online";
  const openPage = useCallback(() => {
    navigate(thisDevicePath(server.slug, null));
    onOpened?.(running ? "online" : "offline");
  }, [navigate, onOpened, running, server.slug]);
  const deviceIcon = (
    <span className="relative flex shrink-0 text-foreground-muted" data-testid="rack-this-device-icon">
      <Monitor size={20} aria-hidden="true" />
      <StatusDot aria-hidden presence={presence} className="absolute -right-1 -bottom-1 z-raised" data-testid="rack-this-device-status-dot" />
    </span>
  );
  const nameButton = (
    <button
      type="button"
      onClick={openPage}
      className={`min-w-0 truncate text-left text-callout font-bold text-foreground outline-none after:absolute after:inset-0 after:content-[''] ${view === "cards"
        ? "after:rounded-container focus-visible:after:inset-ring-2 focus-visible:after:inset-ring-ink"
        : "focus-visible:after:inset-ring-2 focus-visible:after:inset-ring-ink"}`}
      data-testid="rack-this-device-name"
    >
      {name}
    </button>
  );
  const facts = (
    <span data-testid="rack-this-device-state">
      {thisDeviceStatusPhrase(self.state, self.deviceKind, server.name, intl)}
    </span>
  );
  if (view === "cards") {
    return (
      <Card className={`${RACK_LINK_SURFACE} h-full transition-colors`} data-testid="rack-this-device" data-layout="card">
        <CardHeader>
          <CardLeading>{deviceIcon}</CardLeading>
          <CardTitle render={<CardHeading />} className="flex min-w-0 items-center gap-2">{nameButton}</CardTitle>
          <CardDescription className="col-span-2 font-mono text-mono-meta text-foreground-hint">{facts}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          <div className="h-7" aria-hidden />
        </CardContent>
      </Card>
    );
  }
  return (
    <div role="row" className={`${RACK_LINK_SURFACE} flex min-h-12 items-center gap-3 border-b border-line-hairline px-5 py-1 transition-colors`} data-testid="rack-this-device">
      <div role="cell" className={`${RACK_IDENTITY_WIDTH} shrink-0`}>
        <div className="flex min-w-0 items-center gap-2">{deviceIcon}{nameButton}</div>
        <div className="mt-0.5 truncate whitespace-nowrap pl-[28px] font-mono text-mono-meta text-foreground-hint">{facts}</div>
      </div>
      {/* The empty slot: no agents run here for this server yet. */}
      <div role="cell" className="min-w-0 flex-1" />
      <div role="cell" className="size-8 shrink-0" aria-hidden="true" />
    </div>
  );
}
