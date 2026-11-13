import { Button } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";
import { useCallback, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import type { MessageId } from "../../i18n/messages";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { showToast } from "../toastBridge";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";
import DialogCard from "../ui/DialogCard";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import type { ServerConnectOutcome } from "../externalInvite/externalInviteAccept";
import {
  connectMyServers,
  markConnectedByYou,
  memberConnectRefusalMessageId,
  memberConnectRefusalRowState,
  memberConnectRequestError,
  useMemberConnectLimits,
} from "./memberConnect";
import type { MemberConnectRow, MemberConnectRowState } from "./memberConnect";

type Refused = Extract<ServerConnectOutcome, { state: "refused" }>;

const ROW_REASON_IDS: Record<Exclude<MemberConnectRowState, "eligible">, MessageId> = {
  connected: "channel.memberConnect.row.alreadyConnected",
  notAdmin: "channel.memberConnect.row.notAdmin",
};

/**
 * Connect your servers (#wg-rbac:#36, design §2): the viewer's servers, the
 * ones they own or administer and that aren't in the channel chosen with a
 * checkbox; the rest listed with why not. The confirmation is this dialog
 * (no second one): the line under the title says they connect now with no
 * host approval, the line under the list what people in those servers see.
 *
 * Every server is answered on its own. All of them connected (or being
 * connected while a private channel is shared): the dialog closes with one
 * toast. All already connected: closes with an info toast. Otherwise it
 * stays open with a warning banner; a server that did connect reads
 * "Connected just now" and Cancel becomes Close.
 *
 * A free server already in an external channel (design v4 F, the server's
 * list: useMemberConnectLimits) is listed but can't be chosen. Its owner sees
 * Upgrade, an admin asks an owner; either goes to that server and opens its
 * upgrade dialog there (the row's server, not this one).
 */
export function ConnectYourServersDialog({
  channelId,
  channelName,
  channelType,
  hostName,
  guest,
  rows,
  onClose,
}: {
  channelId: string;
  /** Without its #. */
  channelName: string;
  channelType: "joint" | "private";
  hostName: string;
  /** The viewer is a Guest of the host bound to this channel: connecting ends that seat. */
  guest: boolean;
  rows: readonly MemberConnectRow[];
  onClose: () => void;
}) {
  const { formatMessage, formatList } = useIntl();
  const labelId = useId();
  const channel = `#${channelName}`;
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** Servers this dialog connected (or started connecting). */
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  /** A row's state after a refusal changed it (no longer an admin, already connected). */
  const [rowStates, setRowStates] = useState<ReadonlyMap<string, MemberConnectRowState>>(() => new Map());
  const [lines, setLines] = useState<string[]>([]);
  const [closed, setClosed] = useState(false);

  const nameOf = useCallback((serverId: string) => rows.find((row) => row.server.id === serverId)?.server.name ?? "", [rows]);
  const selectedNames = selected.map(nameOf);
  const limits = useMemberConnectLimits(channelId);

  // A row's Upgrade or Ask an owner: into that server, its upgrade dialog open there (the app's dialog is the current server's).
  const navigate = useNavigate();
  const upgradeOn = useCallback((serverId: string) => {
    const server = useServerStore.getState().servers.find((candidate) => candidate.id === serverId);
    if (!server) return;
    onClose();
    useServerStore.getState().setCurrent(server);
    navigate(`/s/${server.slug}`);
    openUpgradeDialog("external_channel_free_limit", { serverId: server.id });
  }, [navigate, onClose]);

  const items = useMemo<ChoiceListItem[]>(() => rows.map(({ server, state: initial }) => {
    const state = rowStates.get(server.id) ?? initial;
    const limit = state === "eligible" && !done.has(server.id) ? limits.get(server.id) : undefined;
    const atLimit = limit?.atLimit === true;
    const reason = done.has(server.id)
      ? formatMessage({ id: "channel.memberConnect.row.connectedNow" })
      : atLimit
        ? formatMessage({ id: "channel.memberConnect.row.atLimit" })
        : state === "eligible"
          ? formatMessage({ id: server.role === "owner" ? "channel.memberConnect.row.owner" : "channel.memberConnect.row.admin" })
          : formatMessage({ id: ROW_REASON_IDS[state] });
    return {
      value: server.id,
      label: server.name,
      searchText: `${server.name} ${server.slug}`,
      description: (
        <span>
          <span className="font-mono text-mono-meta">{server.slug}</span>
          <span aria-hidden="true"> · </span>
          {reason}
        </span>
      ),
      disabled: closed || state !== "eligible" || done.has(server.id) || atLimit,
      action: atLimit ? <LimitAction serverId={server.id} serverName={server.name} owner={limit.canUpgrade} onUpgrade={upgradeOn} /> : undefined,
      media: <AvatarSlot context="list-row" type="server" serverAvatarUrl={server.avatarUrl ?? null} serverInitial={server.name.slice(0, 1)} />,
    };
  }), [rows, rowStates, done, closed, limits, upgradeOn, formatMessage]);

  const finish = useCallback((connectedIds: string[], connectingIds: string[]) => {
    markConnectedByYou(channelId, [...connectedIds, ...connectingIds]);
    // The new rows come with the channel read again (and the channel:updated the server sends).
    void useChannelStore.getState().ensureChannel(channelId, { refresh: true }).catch(() => null);
  }, [channelId]);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setLines([]);
    let outcomes: ServerConnectOutcome[];
    try {
      outcomes = await connectMyServers(channelId, selected);
    } catch (err) {
      const failure = memberConnectRequestError(err);
      setLines([formatMessage({ id: failure.id }, { channel, host: hostName })]);
      if (failure.closed) setClosed(true);
      setBusy(false);
      return;
    }
    setBusy(false);
    const connected = outcomes.filter((outcome) => outcome.state === "connected").map((outcome) => outcome.serverId);
    const connecting = outcomes.filter((outcome) => outcome.state === "connecting").map((outcome) => outcome.serverId);
    const refused = outcomes.filter((outcome): outcome is Refused => outcome.state === "refused");
    const names = (ids: string[]) => formatList(ids.map(nameOf), { type: "conjunction" });
    if (connected.length + connecting.length > 0) finish(connected, connecting);

    if (refused.length === 0) {
      if (connected.length > 0) showToast({ title: formatMessage({ id: "channel.memberConnect.toast.connected" }, { servers: names(connected) }), type: "success" });
      if (connecting.length > 0) showToast({ title: formatMessage({ id: "channel.memberConnect.toast.connecting" }, { servers: names(connecting), count: connecting.length }), type: "success" });
      onClose();
      return;
    }
    if (connected.length + connecting.length === 0 && refused.every((outcome) => outcome.code === "already_connected")) {
      showToast({ title: formatMessage({ id: "channel.memberConnect.toast.alreadyConnected" }, { servers: names(refused.map((outcome) => outcome.serverId)), count: refused.length }), type: "info" });
      onClose();
      return;
    }

    // Some or none went through: say which, and why each other one didn't.
    const nextLines: string[] = [];
    if (connected.length + connecting.length > 0) {
      nextLines.push(formatMessage({ id: "channel.memberConnect.partial.connected" }, { servers: names([...connected, ...connecting]), count: connected.length + connecting.length }));
    }
    for (const outcome of refused) {
      nextLines.push(formatMessage({ id: memberConnectRefusalMessageId(outcome) }, { target: nameOf(outcome.serverId), channel, host: hostName, max: MAX_JOINT_CHANNEL_SERVERS }));
    }
    setLines(nextLines);
    setDone((prev) => new Set([...prev, ...connected, ...connecting]));
    setRowStates((prev) => {
      const next = new Map(prev);
      for (const outcome of refused) {
        const state = memberConnectRefusalRowState(outcome);
        if (state) next.set(outcome.serverId, state);
      }
      return next;
    });
    // Only what can still be tried stays chosen.
    setSelected((prev) => prev.filter((id) => refused.some((outcome) => outcome.serverId === id && !memberConnectRefusalRowState(outcome))));
  }, [selected, busy, channelId, formatMessage, formatList, channel, hostName, nameOf, finish, onClose]);

  const commitLabel = formatMessage({ id: "channel.memberConnect.dialog.commit" }, { count: Math.max(1, selected.length) });
  const servers = formatList(selectedNames, { type: "conjunction" });

  return (
    <DialogCard
      title={formatMessage({ id: "channel.memberConnect.dialog.title" })}
      description={formatMessage({ id: "channel.memberConnect.dialog.description" }, { host: hostName })}
      onClose={onClose}
      narrow="sheet"
      layer={1}
      maxWidthClass="max-w-lg"
      testId="member-connect-dialog"
    >
      <form onSubmit={submit} className="stack-y-4 md:pointer-fine:stack-y-3">
        {lines.length > 0 && (
          <Banner intent="warning" data-testid="member-connect-error">
            {lines.map((line, index) => <p key={index}>{line}</p>)}
          </Banner>
        )}
        <h3 id={labelId} className="sr-only">{formatMessage({ id: "channel.memberConnect.dialog.listLabel" })}</h3>
        <ChoiceList
          multiple
          aria-labelledby={labelId}
          items={items}
          value={selected}
          onValueChange={setSelected}
          disabled={busy}
          searchLabel={formatMessage({ id: "channel.externalInvite.dialog.serversSearch" })}
          searchPlaceholder={formatMessage({ id: "channel.externalInvite.dialog.serversSearch" })}
          clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
          noMatchLabel={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
        />
        {selected.length > 0 && (
          <div className="stack-y-2 text-callout text-foreground-muted" data-testid="member-connect-consequence">
            <p>{formatMessage({ id: "channel.memberConnect.dialog.visibility" }, { servers })}</p>
            {channelType === "private" && (
              <p>{formatMessage({ id: "channel.memberConnect.dialog.becomesShared" }, { channel })}</p>
            )}
            {guest && (
              <p className="font-semibold text-foreground" data-testid="member-connect-guest">
                {formatMessage({ id: "channel.memberConnect.dialog.guest" }, { channel, server: selectedNames[0] ?? "" })}
              </p>
            )}
          </div>
        )}
        <DialogCardFooter>
          <Button size="lg" variant="ghost" type="button" onClick={onClose} disabled={busy}>
            {formatMessage({ id: done.size > 0 ? "settings.common.close" : "settings.common.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button
                size={inHead ? "md" : "lg"}
                variant="primary"
                type="submit"
                disabled={selected.length === 0 || closed}
                loading={busy}
                loadingLabel={formatMessage({ id: "channel.memberConnect.dialog.connecting" })}
                data-testid="member-connect-submit"
              >
                {commitLabel}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </DialogCard>
  );
}

/** A row at the free plan's limit: Upgrade for its owner, Ask an owner for an admin; both open that server's upgrade dialog. */
function LimitAction({ serverId, serverName, owner, onUpgrade }: { serverId: string; serverName: string; owner: boolean; onUpgrade: (serverId: string) => void }) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onUpgrade(serverId), [onUpgrade, serverId]);
  return (
    <Button
      size="sm"
      variant="outline"
      type="button"
      onClick={handleClick}
      aria-label={formatMessage({ id: owner ? "externalInvite.connect.upgradeServer" : "channel.memberConnect.row.askOwnerServer" }, { server: serverName })}
      data-testid={owner ? "member-connect-upgrade" : "member-connect-ask-owner"}
    >
      {formatMessage({ id: owner ? "externalInvite.upgrade" : "channel.memberConnect.row.askOwner" })}
    </Button>
  );
}
