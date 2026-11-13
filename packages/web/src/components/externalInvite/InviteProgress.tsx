import { Button, Field, FieldLabel } from "@botiverse/raft-ui";
import { MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { useCallback, useId, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { Server } from "../../store/serverStore";
import ConfirmDialog from "../ConfirmDialog";
import AvatarSlot from "../ui/AvatarSlot";
import { inviteeErrorMessage, refusalAsError } from "./externalInviteAccept";
import type { ConnectableServer, ExternalInviteForInvitee, ServerConnectOutcome } from "./externalInviteAccept";
import { ServerProgressList } from "./ServerProgressList";
import type { ServerProgressRow } from "./ServerProgressList";

/**
 * The invite page's pieces for several servers at once (#wg-rbac:#16
 * multi-connect): where each chosen server stands, the approver picked for
 * each that needs one, and the Cancel Request confirm both waiting views use.
 */

/** A chosen server as connect-servers answered it, with its name then (the connect list is gone once it isn't pending). */
export type ChosenOutcome = ServerConnectOutcome & { name: string };

/** One chosen server's row in the progress list: its live state, or what connect-servers answered. */
type ProgressRowState = {
  serverId: string;
  name: string;
  state: "connected" | "connecting" | "awaiting_approval" | "refused" | "notConnected";
  approverName?: string;
  requestId?: string;
  /** Connected by connect-servers: its channel there, to open. */
  channelId?: string;
  refusal?: Extract<ServerConnectOutcome, { state: "refused" }>;
};

/**
 * The chosen servers in the order chosen, each as the invite says it stands
 * now (GET `servers`) or else as connect-servers answered: a refusal and why;
 * one no longer under way and not in (declined, withdrawn, or refused when
 * its turn came) is not connected. Then the invitee's other servers under way.
 */
function progressRows(chosen: readonly ChosenOutcome[], invite: ExternalInviteForInvitee): ProgressRowState[] {
  const live = new Map((invite.servers ?? []).map((server) => [server.serverId, server]));
  const rows: ProgressRowState[] = chosen.map((outcome) => {
    const now = live.get(outcome.serverId);
    const channelId = outcome.state === "connected" ? outcome.channelId : undefined;
    if (now) {
      return { serverId: now.serverId, name: now.serverName || outcome.name, state: now.state, approverName: now.approverName, requestId: now.requestId, channelId };
    }
    if (outcome.state === "refused") return { serverId: outcome.serverId, name: outcome.name, state: "refused", refusal: outcome };
    // An older server (or a failed read) says nothing: as answered.
    if (!invite.servers) {
      return { serverId: outcome.serverId, name: outcome.name, state: outcome.state, channelId, requestId: outcome.state === "awaiting_approval" ? outcome.requestId : undefined };
    }
    return { serverId: outcome.serverId, name: outcome.name, state: "notConnected" };
  });
  for (const server of invite.servers ?? []) {
    if (!chosen.some((outcome) => outcome.serverId === server.serverId)) {
      rows.push({ serverId: server.serverId, name: server.serverName, state: server.state, approverName: server.approverName, requestId: server.requestId });
    }
  }
  return rows;
}

/**
 * The progress list (ServerProgressList) and, under it, Open for the first
 * server in (or being connected) that is theirs: its channel when
 * connect-servers named it, else the server. `values` are the page's
 * {channel}, {server}, {inviter} for a refusal's reason.
 */
export function InviteProgress({
  invite,
  chosen,
  values,
  myServer,
  busy,
  error,
  onCancel,
  onOpen,
}: {
  invite: ExternalInviteForInvitee;
  chosen: readonly ChosenOutcome[];
  values: Record<string, string>;
  myServer: (id: string) => Server | null;
  busy: boolean;
  /** The page's refusal banner, between the list and Open. */
  error: ReactNode;
  onCancel: (cancel: { requestId: string; approverName: string }) => void;
  /** Without it (the ways in below, the invite pending again), no Open. */
  onOpen?: (serverId: string, channelId: string | undefined) => void;
}) {
  const { formatMessage } = useIntl();
  const { listed, opening } = useMemo(() => {
    const rows = progressRows(chosen, invite);
    const describe = (row: ProgressRowState): Pick<ServerProgressRow, "badge" | "tone" | "detail"> => {
      if (row.state === "connected") return { badge: formatMessage({ id: "externalInvite.progress.connected" }), tone: "success" };
      if (row.state === "connecting") return { badge: formatMessage({ id: "externalInvite.connect.connecting" }), tone: "information" };
      if (row.state === "awaiting_approval") {
        return {
          badge: formatMessage({ id: "externalInvite.progress.waitingBadge" }),
          tone: "warning",
          detail: row.approverName ? formatMessage({ id: "externalInvite.progress.waiting" }, { approver: row.approverName }) : undefined,
        };
      }
      const notConnected = formatMessage({ id: "externalInvite.progress.notConnected" });
      if (row.state === "notConnected" || !row.refusal) return { badge: notConnected, tone: "muted" };
      // Why it was refused, as a refusal of it alone would have said.
      const refusal = inviteeErrorMessage(refusalAsError(row.refusal), "connect", myServer(row.serverId));
      return { badge: notConnected, tone: "danger", detail: formatMessage({ id: refusal.id }, { ...values, max: MAX_JOINT_CHANNEL_SERVERS, target: row.name }) };
    };
    const shown: ServerProgressRow[] = rows.map((row) => ({
      serverId: row.serverId,
      name: row.name,
      ...describe(row),
      ...(row.state === "awaiting_approval" && row.requestId ? { cancel: { requestId: row.requestId, approverName: row.approverName ?? "" } } : {}),
    }));
    return { listed: shown, opening: rows.find((row) => (row.state === "connected" || row.state === "connecting") && myServer(row.serverId)) ?? null };
  }, [chosen, invite, myServer, formatMessage, values]);
  const cancelAriaLabel = useCallback((server: string) => formatMessage({ id: "externalInvite.progress.cancelServer" }, { server }), [formatMessage]);
  const handleOpen = useCallback(() => {
    if (opening) onOpen?.(opening.serverId, opening.channelId);
  }, [opening, onOpen]);
  return (
    <>
      <ServerProgressList
        rows={listed}
        myServer={myServer}
        cancelLabel={formatMessage({ id: "externalInvite.waiting.cancel" })}
        cancelAriaLabel={cancelAriaLabel}
        onCancel={onCancel}
        disabled={busy}
      />
      {error}
      {opening && onOpen ? (
        <Button size="xl" variant="accent" className="w-full" onClick={handleOpen} data-testid="external-invite-open-server">
          {formatMessage({ id: "externalInvite.openServer" }, { target: myServer(opening.serverId)?.name ?? opening.name })}
        </Button>
      ) : null}
    </>
  );
}

/** Confirmed (DS feedback › Confirming): cancelling makes the approver's emailed link stop working. */
export function CancelRequestConfirm({ approverName, onConfirm, onClose }: {
  approverName: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ConfirmDialog
      title={formatMessage({ id: "externalInvite.cancelConfirm.title" })}
      message={formatMessage({ id: "externalInvite.cancelConfirm.message" }, { approver: approverName })}
      confirmLabel={formatMessage({ id: "externalInvite.waiting.cancel" })}
      cancelLabel={formatMessage({ id: "externalInvite.cancelConfirm.keep" })}
      loadingLabel={formatMessage({ id: "externalInvite.waiting.canceling" })}
      confirmTestId="external-invite-cancel-request-confirm"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

/** The owners and admins of one server that needs approval, to pick whom to ask. */
export function ApproverPicker({ server, value, onPick, disabled }: {
  server: ConnectableServer;
  value: string | null;
  onPick: (serverId: string, approverId: string) => void;
  disabled: boolean;
}) {
  const { formatMessage } = useIntl();
  const labelId = useId();
  const items = useMemo<ChoiceListItem[]>(
    () => server.approvers.map((person) => ({
      value: person.id,
      label: person.name,
      media: person.avatarUrl
        ? <AvatarSlot context="list-row" type="human" humanAvatarUrl={person.avatarUrl} />
        : <AvatarSlot context="list-row" type="human" humanPlaceholder />,
    })),
    [server],
  );
  const handleChange = useCallback((approverId: string) => onPick(server.id, approverId), [onPick, server.id]);
  return (
    <Field className="mb-6">
      <FieldLabel id={labelId}>
        {formatMessage({ id: "externalInvite.approval.pickerLabel" }, { target: server.name })}
      </FieldLabel>
      <ChoiceList
        aria-labelledby={labelId}
        items={items}
        value={value}
        onValueChange={handleChange}
        disabled={disabled}
        searchLabel={formatMessage({ id: "externalInvite.approval.search" })}
        searchPlaceholder={formatMessage({ id: "externalInvite.approval.search" })}
        clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
        noMatchLabel={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
      />
    </Field>
  );
}
