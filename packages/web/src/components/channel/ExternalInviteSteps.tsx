import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  ScrollArea,
  Textarea,
} from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, MAX_JOINT_CHANNEL_SERVERS } from "@botiverse/raft-shared";
import type { PaywallSurface } from "@botiverse/raft-shared";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { ExternalInviteTracker } from "../../analytics/externalInvites";
import type { MessageId } from "../../i18n/messages";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { showToast } from "../toastBridge";
import Banner from "../ui/Banner";
import Tooltip from "../ui/Tooltip";
import FormField from "../ui/FormField";
import AvatarSlot from "../ui/AvatarSlot";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import { inviteeErrorMessage, refusalAsError } from "../externalInvite/externalInviteAccept";
import type { ConnectableServer } from "../externalInvite/externalInviteAccept";
import {
  EXTERNAL_INVITE_MAX_EMAILS,
  externalInviteErrorCode,
  externalInviteErrorMessageId,
  NO_EMAILS_PREVIEW,
  parseEmailEntries,
  previewExternalInvites,
  previewExternalInvitesForNewChannel,
  sendInvitesAndConnectServers,
  useChannelExternalInvites,
} from "./externalInvites";
import type { ExternalInvitePreview, SendExternalInvitesResult } from "./externalInvites";
import { currentExternalSlotContext } from "./externalChannelSlot";

/**
 * The invite steps shared by Invite People Outside <server>
 * (AddExternalMemberDialog) and Create Channel's External choice
 * (CreateChannelDialog): the emails field, the review of what the server
 * makes of them, and the send. Rendered inside the caller's DialogCard.
 */

/** The server's EXTERNAL_INVITE_EXPIRY_DAYS: how long an invite link works. */
const EXTERNAL_INVITE_EXPIRY_DAYS = 14;

const CHANNEL_FULL_ID: MessageId = "channel.externalInvite.error.channelFull";

/**
 * "This channel is full", with "disconnect a server" among the ways to make
 * room only where the inviter (the host's owner/admin) has that action: a
 * joint channel (servers connected), with external_channels_v1 on for the
 * host (#wg-rbac:#52, #55; channel settings' Connected servers).
 */
function useChannelFullMessageId(channelId: string | null): MessageId {
  // No read of its own: the server's flags come in one batch, already asked
  // for by the channel around this dialog (external_channels_v1).
  const flagOn = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, { prefetch: false }).enabled;
  const isJoint = useChannelStore((s) => findStoredChannel(s, channelId)?.type === "joint");
  return flagOn && isJoint ? "channel.externalInvite.error.channelFullOrDisconnect" : CHANNEL_FULL_ID;
}

/** A failed preview or send, as the dialog shows it; `upgrade` offers the upgrade dialog (free_external_limit). */
export type ExternalInviteFailure = { id: MessageId; upgrade: boolean };

export function externalInviteFailure(err: unknown): ExternalInviteFailure {
  return {
    id: externalInviteErrorMessageId(err),
    upgrade: externalInviteErrorCode(err) === "free_external_limit",
  };
}

/** The pasted text as the entries the server counts, and how many over the limit they are. */
export function useExternalInviteEntries(text: string): { entries: string[]; overBy: number } {
  const entries = useMemo(() => parseEmailEntries(text), [text]);
  return { entries, overBy: entries.length - EXTERNAL_INVITE_MAX_EMAILS };
}

/**
 * The channel's slots as a send would take them (design E2: checked servers
 * take one each too), said only once it could reach them: within the 20 at a
 * time. Null when there is nothing to say. Past them nothing can be sent.
 */
function SlotsLine({ slotsLeft, taking, channelFullId }: { slotsLeft: number | undefined; taking: number; channelFullId: MessageId }) {
  const { formatMessage } = useIntl();
  if (slotsLeft === undefined) return null;
  const over = taking - slotsLeft;
  if (slotsLeft === 0) {
    // No room at all: the channel is full, not "room for 0 more".
    return (
      <Banner intent="warning" data-testid="external-invite-over-slots">
        {formatMessage({ id: channelFullId })}
      </Banner>
    );
  }
  if (over > 0) {
    return (
      <Banner intent="warning" data-testid="external-invite-over-slots">
        {formatMessage({ id: "channel.externalInvite.dialog.overSlots" }, { room: slotsLeft, count: over })}
      </Banner>
    );
  }
  if (taking === 0 || slotsLeft > EXTERNAL_INVITE_MAX_EMAILS) return null;
  return (
    <p className="text-callout text-foreground-muted" data-testid="external-invite-slots-left">
      {over === 0
        ? formatMessage({ id: "channel.externalInvite.dialog.fillsChannel" })
        : formatMessage({ id: "channel.externalInvite.dialog.slotsLeft" }, { count: -over })}
    </p>
  );
}

/**
 * Invite by email: the textarea, its hint and the over-the-limit error.
 * `slotsHint`, when given: the channel's slots as typed so far, under the hint (design E2).
 * `historyHint`: an invitee may connect their server, which then sees the
 * channel's earlier messages (a channel that isn't joint yet and has some).
 */
export function ExternalInviteEmailsField({
  value,
  onChange,
  overBy,
  autoFocus = false,
  slotsHint,
  historyHint = false,
}: {
  value: string;
  onChange: (value: string) => void;
  overBy: number;
  autoFocus?: boolean;
  slotsHint?: ReactNode;
  historyHint?: boolean;
}) {
  const { formatMessage } = useIntl();
  const textareaId = useId();
  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value), [onChange]);
  const emailsHint = formatMessage({ id: "channel.externalInvite.dialog.emailsHint" }, { max: EXTERNAL_INVITE_MAX_EMAILS });
  return (
    <FormField
      label={formatMessage({ id: "channel.externalInvite.dialog.emailsLabel" })}
      htmlFor={textareaId}
      hint={slotsHint || historyHint ? (
        <>
          {emailsHint}
          {historyHint ? (
            <span className="block" data-testid="external-invite-emails-history">
              {formatMessage({ id: "channel.externalInvite.dialog.emailsSeeHistory" })}
            </span>
          ) : null}
          {slotsHint ? <span className="block" data-testid="external-invite-slots-left">{slotsHint}</span> : null}
        </>
      ) : emailsHint}
      error={overBy > 0
        ? formatMessage({ id: "channel.externalInvite.dialog.tooMany" }, { max: EXTERNAL_INVITE_MAX_EMAILS, count: overBy })
        : undefined}
    >
      <Textarea
        id={textareaId}
        value={value}
        onChange={handleChange}
        className="w-full"
        rows={4}
        placeholder={formatMessage({ id: "channel.externalInvite.dialog.emailsPlaceholder" })}
        aria-invalid={overBy > 0 || undefined}
        autoFocus={autoFocus}
        data-testid="external-invite-emails"
      />
    </FormField>
  );
}

/**
 * "Your servers": the viewer's other servers they own or administer, as
 * checkboxes (DS ChoiceList, multiple). Each one checked connects when the
 * review is confirmed, with no email and no approval. One at the free plan's
 * external-channel limit is listed, not chosen. Not drawn without any.
 * `historyHint`: say under the list that a server connected sees the
 * channel's earlier messages (a channel that isn't joint yet and has some).
 */
export function ExternalInviteServersField({
  servers,
  value,
  onChange,
  disabled = false,
  historyHint = false,
}: {
  servers: readonly ConnectableServer[];
  value: readonly string[];
  onChange: (serverIds: string[]) => void;
  disabled?: boolean;
  historyHint?: boolean;
}) {
  const { formatMessage } = useIntl();
  const labelId = useId();
  const items = useMemo<ChoiceListItem[]>(() => servers.map((server) => ({
    value: server.id,
    label: server.name,
    searchText: `${server.name} ${server.slug ?? ""}`,
    description: server.atLimit ? formatMessage({ id: "externalInvite.connect.atLimit" }) : undefined,
    disabled: server.atLimit === true,
    media: <AvatarSlot context="list-row" type="server" serverAvatarUrl={server.avatarUrl ?? null} serverInitial={server.name.slice(0, 1)} />,
  })), [servers, formatMessage]);
  if (servers.length === 0) return null;
  return (
    <Field data-testid="external-invite-servers">
      <FieldLabel id={labelId}>{formatMessage({ id: "channel.externalInvite.dialog.serversLabel" })}</FieldLabel>
      <ChoiceList
        multiple
        aria-labelledby={labelId}
        items={items}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        searchLabel={formatMessage({ id: "channel.externalInvite.dialog.serversSearch" })}
        searchPlaceholder={formatMessage({ id: "channel.externalInvite.dialog.serversSearch" })}
        clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
        noMatchLabel={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
      />
      {historyHint ? (
        <FieldDescription data-testid="external-invite-servers-history">
          {formatMessage({ id: "channel.externalInvite.dialog.serversSeeHistory" })}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

/**
 * After the confirm: a toast for what the chosen servers came to (connected,
 * being connected while the channel is converted) and one per server refused,
 * saying why. When the whole connect failed, one toast says so, not one per
 * server.
 */
function toastServerOutcomes(
  result: SendExternalInvitesResult,
  servers: readonly ConnectableServer[],
  formatMessage: ReturnType<typeof useIntl>["formatMessage"],
  names: { server: string; channel: string },
): void {
  const outcomes = result.servers ?? [];
  if (result.serversFailed) {
    showToast({ title: formatMessage({ id: "channel.externalInvite.serversNotConnected" }), type: "error" });
    return;
  }
  const connected = outcomes.filter((outcome) => outcome.state === "connected").length;
  const connecting = outcomes.filter((outcome) => outcome.state === "connecting").length;
  if (connected > 0) showToast({ title: formatMessage({ id: "channel.externalInvite.serversConnected" }, { count: connected }), type: "success" });
  if (connecting > 0) showToast({ title: formatMessage({ id: "channel.externalInvite.serversConnecting" }, { count: connecting }), type: "success" });
  for (const outcome of outcomes) {
    if (outcome.state !== "refused") continue;
    const name = servers.find((server) => server.id === outcome.serverId)?.name ?? "";
    // The host's own limit is the plan's sentence of this dialog; the rest are the connecting server's.
    const hostLimit = outcome.limitSide === "host" || outcome.code === "joint_channel_free_limit_reached" || outcome.code === "joint_channel_plan_limit_reached";
    // Too many Guests for the joint's party cap (P3): the inviter is the host's
    // owner or admin, so the next step is theirs (remove some guests).
    const reason = hostLimit
      ? formatMessage({ id: "channel.externalInvite.error.freeLimit" })
      : outcome.code === "joint_party_limit"
        ? formatMessage({ id: "channel.edit.convertJointPartyLimit" }, { channel: names.channel, max: MAX_JOINT_CHANNEL_SERVERS })
        : formatMessage({ id: inviteeErrorMessage(refusalAsError(outcome), "connect", { id: outcome.serverId }).id }, { target: name, channel: names.channel, server: names.server, inviter: "" });
    showToast({ title: formatMessage({ id: "channel.externalInvite.serverRefused" }, { server: name }), description: reason, type: "error" });
  }
}

/** `hint`: why the row can't be invited, as its status's tooltip. */
type ReviewRow = { key: string; email: string; status: MessageId; values?: Record<string, string>; hint?: MessageId; invites: boolean };

/**
 * One row per address in the order people read the result: who gets an
 * invite, who is added (members of the Server, design A2), then who doesn't
 * and why.
 */
function reviewRows(preview: ExternalInvitePreview): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const seenDuplicates = new Set<string>();
  for (const email of preview.valid) {
    rows.push({ key: `valid:${email}`, email, status: "channel.externalInvite.dialog.status.willInvite", invites: true });
  }
  for (const email of preview.alreadyMembers) {
    rows.push({ key: `member:${email}`, email, status: "channel.externalInvite.dialog.status.willAdd", invites: true });
  }
  for (const email of preview.duplicates) {
    // Three copies of one address read as one note, not two.
    if (seenDuplicates.has(email)) continue;
    seenDuplicates.add(email);
    rows.push({ key: `duplicate:${email}`, email, status: "channel.externalInvite.dialog.status.duplicate", invites: false });
  }
  for (const email of preview.alreadyPending) {
    rows.push({ key: `pending:${email}`, email, status: "channel.externalInvite.dialog.status.alreadyInvited", invites: false });
  }
  for (const email of preview.alreadyInChannel ?? []) {
    rows.push({ key: `in-channel:${email}`, email, status: "channel.externalInvite.dialog.status.alreadyInChannel", invites: false });
  }
  // A Guest belongs to one channel: blocked, naming it only when the server did (the inviter can see it).
  for (const { email, channelName } of preview.guestsElsewhere ?? []) {
    rows.push(channelName
      ? { key: `guest:${email}`, email, status: "channel.externalInvite.dialog.status.guestElsewhere", values: { channel: `#${channelName}` }, hint: "channel.externalInvite.dialog.status.guestElsewhereHint", invites: false }
      : { key: `guest:${email}`, email, status: "channel.externalInvite.dialog.status.guestElsewhereUnnamed", hint: "channel.externalInvite.dialog.status.guestElsewhereUnnamedHint", invites: false });
  }
  preview.invalid.forEach((entry, index) => {
    rows.push({ key: `invalid:${index}:${entry}`, email: entry, status: "channel.externalInvite.dialog.status.invalid", invites: false });
  });
  return rows;
}

/**
 * The emails, then the review, then the send. `channelId` null: a channel
 * not created yet (Create Channel's External, design E1), which `commit`
 * creates before it sends. `initialText` / `initialPreview` / `initialError`
 * let Create Channel open it where its own step left off; `notice` is a
 * banner above both stages. `dismissLabel` names the button beside Next and
 * `onDismiss` is what it and the upgrade do; `onBackFromReview`, when given,
 * is where the review's Back goes instead of the emails. `commitLabel`
 * names the review's button. `serversHistoryHint`: both fields say a
 * server connected sees the channel's earlier messages (the emails' line
 * conditional: those invited may join as a guest instead). `tracker`: the
 * caller's product events for this opening (analytics/externalInvites).
 */
const NO_SERVERS: readonly ConnectableServer[] = [];
const NO_SERVER_IDS: string[] = [];

export function ExternalInviteSteps({
  channelId,
  serverName,
  willBecomePrivate,
  dismissLabel,
  onDismiss,
  onSent,
  initialText = "",
  initialPreview = null,
  initialError = null,
  notice,
  commit,
  commitLabel = "channel.externalInvite.dialog.commit",
  onBackFromReview,
  servers = NO_SERVERS,
  initialServerIds = NO_SERVER_IDS,
  channelName = "",
  serversHistoryHint = false,
  upgradeSurface = "external_invite_dialog",
  tracker,
}: {
  channelId: string | null;
  serverName: string;
  willBecomePrivate: boolean;
  dismissLabel: string;
  onDismiss: () => void;
  onSent: () => void;
  initialText?: string;
  initialPreview?: ExternalInvitePreview | null;
  initialError?: ExternalInviteFailure | null;
  notice?: ReactNode;
  /** What the review's button does with the addresses; default: send them to `channelId`. */
  commit?: (addresses: string[], serverIds: string[]) => Promise<SendExternalInvitesResult>;
  commitLabel?: MessageId;
  onBackFromReview?: () => void;
  /** "Your servers" offered beside the emails (useOwnConnectableServers); none: the section isn't drawn. */
  servers?: readonly ConnectableServer[];
  /** The servers already checked where Create Channel's own step left off. */
  initialServerIds?: string[];
  /** The channel's name, for a refused server's reason. */
  channelName?: string;
  serversHistoryHint?: boolean;
  /** Where its Upgrade (the Free plan's one external channel) is met: the invite dialog, or Create Channel's own review. */
  upgradeSurface?: Extract<PaywallSurface, "external_invite_dialog" | "create_channel">;
  tracker: ExternalInviteTracker;
}) {
  const { formatMessage } = useIntl();
  const [text, setText] = useState(initialText);
  const [preview, setPreview] = useState<ExternalInvitePreview | null>(initialPreview);
  const [serverIds, setServerIds] = useState<string[]>(initialServerIds);
  // The checked servers still offered, in the list's order: what the confirm connects.
  const chosenServers = useMemo(() => servers.filter((server) => serverIds.includes(server.id)), [servers, serverIds]);
  const [busy, setBusy] = useState(false);
  const sendInFlightRef = useRef(false);
  const [error, setError] = useState<ExternalInviteFailure | null>(initialError);
  const { entries, overBy } = useExternalInviteEntries(text);
  const rows = useMemo(() => (preview ? reviewRows(preview) : []), [preview]);
  const inviteCount = preview?.valid.length ?? 0;
  // Invited, added to the channel as members of the Server, or servers connected: what the button does.
  const actionCount = inviteCount + (preview?.alreadyMembers.length ?? 0) + chosenServers.length;
  const reviewsEmails = rows.length > 0;
  // The channel's 30 slots, open invites counted (an older server sends no
  // slotsLeft); each invite and each server checked takes one, members added
  // none. Before the review, as the channel's invites read them (none for a
  // channel not created yet, far from its slots).
  const { slotsLeft: channelSlotsLeft } = useChannelExternalInvites(channelId ?? "", channelId !== null);
  const channelFullId = useChannelFullMessageId(channelId);
  const slotsLeft = preview?.slotsLeft;
  const overSlots = slotsLeft === undefined ? 0 : inviteCount + chosenServers.length - slotsLeft;
  // While typing: every entry counted as an invite until the review sorts
  // them (duplicates, members), servers checked too; past the slots, the
  // review's own words (design E2 e2_invite_over). Next stays open: the
  // review counts what is really sent, and refuses past them.
  const typedLeft = (channelSlotsLeft ?? 0) - entries.length - chosenServers.length;
  const typedSlotsHint = channelSlotsLeft === undefined || channelSlotsLeft > EXTERNAL_INVITE_MAX_EMAILS || entries.length === 0
    ? undefined
    : channelSlotsLeft === 0
      ? formatMessage({ id: channelFullId })
      : typedLeft < 0
        ? formatMessage({ id: "channel.externalInvite.dialog.overSlots" }, { room: channelSlotsLeft, count: -typedLeft })
        : formatMessage({ id: typedLeft === 0 ? "channel.externalInvite.dialog.fillsChannel" : "channel.externalInvite.dialog.slotsLeft" }, { count: typedLeft });

  const handleTextChange = useCallback((value: string) => {
    setText(value);
    setError(null);
  }, []);

  const handleNext = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (entries.length === 0 && chosenServers.length === 0) || overBy > 0) return;
    const review = (checked: ExternalInvitePreview) => {
      setPreview(checked);
      tracker.reviewed({
        emails: checked.valid.length + checked.alreadyMembers.length,
        servers: chosenServers.length,
        historyWarningShown: serversHistoryHint,
        becomesPrivate: willBecomePrivate,
      });
    };
    // Only servers: nothing for the server to classify.
    if (entries.length === 0) {
      setError(null);
      review(NO_EMAILS_PREVIEW);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      review(await (channelId === null ? previewExternalInvitesForNewChannel(entries) : previewExternalInvites(channelId, entries)));
    } catch (err) {
      setError(externalInviteFailure(err));
    } finally {
      setBusy(false);
    }
  }, [busy, channelId, entries, overBy, chosenServers, serversHistoryHint, tracker, willBecomePrivate]);

  const handleSend = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    // A channel not created yet has no send of its own: its caller's `commit` creates it first.
    // The ref, not `busy`: two submits in one tick both see busy false (one create, one send).
    if (sendInFlightRef.current || busy || !preview || actionCount === 0 || overSlots > 0 || (!commit && channelId === null)) return;
    sendInFlightRef.current = true;
    setBusy(true);
    setError(null);
    // The send answered: a throw after that (a toast, the caller's close) is not a failed send.
    let answered = false;
    try {
      // The previewed addresses, so what is sent is what was reviewed: the
      // invites, and the Server's members the server adds to the channel.
      const addresses = [...preview.valid, ...preview.alreadyMembers];
      const chosenIds = chosenServers.map((server) => server.id);
      const result = commit
        ? await commit(addresses, chosenIds)
        : await sendInvitesAndConnectServers(channelId as string, addresses, chosenIds, willBecomePrivate);
      answered = true;
      tracker.sendSucceeded(result);
      if (result.sent.length > 0) {
        showToast({
          title: formatMessage({ id: "channel.externalInvite.sent" }, { count: result.sent.length }),
          type: "success",
        });
      }
      const added = result.added?.length ?? 0;
      if (added > 0) {
        showToast({ title: formatMessage({ id: "channel.externalInvite.added" }, { count: added }), type: "success" });
      }
      toastServerOutcomes(result, servers, formatMessage, { server: serverName, channel: `#${channelName}` });
      sendInFlightRef.current = false;
      onSent();
    } catch (err) {
      sendInFlightRef.current = false;
      const failure = externalInviteFailure(err);
      if (!answered) tracker.sendFailed(externalInviteErrorCode(err), failure.upgrade);
      setError(failure);
      setBusy(false);
    }
  }, [actionCount, busy, channelId, channelName, chosenServers, commit, formatMessage, onSent, overSlots, preview, servers, serverName, tracker, willBecomePrivate]);

  const handleBack = useCallback(() => {
    if (onBackFromReview) {
      onBackFromReview();
      return;
    }
    setPreview(null);
    setError(null);
    tracker.backToInput();
  }, [onBackFromReview, tracker]);

  const handleUpgrade = useCallback(() => {
    onDismiss();
    // The channel holding the server's one Free external channel is another one.
    openUpgradeDialog("external_channel_free_limit", { surface: upgradeSurface, externalContext: currentExternalSlotContext(channelId) });
  }, [channelId, onDismiss, upgradeSurface]);

  const errorBanner = error && (
    <Banner
      intent="warning"
      data-testid="external-invite-error"
      actions={error.upgrade ? (
        <Button size="md" variant="outline" type="button" onClick={handleUpgrade}>
          {formatMessage({ id: "channel.externalInvite.upgrade" })}
        </Button>
      ) : undefined}
    >
      {formatMessage({ id: error.id === CHANNEL_FULL_ID ? channelFullId : error.id }, { max: EXTERNAL_INVITE_MAX_EMAILS })}
    </Banner>
  );

  const privateWarning = willBecomePrivate && (
    <Banner intent="warning" data-testid="external-invite-private-warning">
      {formatMessage({ id: "channel.externalInvite.dialog.becomesPrivate" })}
    </Banner>
  );

  if (preview) {
    return (
      <form onSubmit={handleSend} className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="external-invite-review">
        {notice}
        {privateWarning}
        {errorBanner}
        {reviewsEmails ? (
          <p className="text-callout text-foreground-muted">
            {formatMessage({ id: "channel.externalInvite.dialog.reviewIntro" }, { days: EXTERNAL_INVITE_EXPIRY_DAYS })}
          </p>
        ) : null}
        {reviewsEmails ? (
        <ListRowGroup className="max-h-72">
          {/* The group is the frame (max height, border); the rows scroll in
              a raft-ui ScrollArea that fills it. Siblings still, so the
              hairlines between them stay. The rows don't take focus, so the
              area is a named region (a tab stop once it overflows), and it
              sits in the dialog's scroller: a scroll at its end carries on. */}
          <ScrollArea
            role="region"
            aria-label={formatMessage({ id: "channel.externalInvite.dialog.reviewListLabel" })}
            overscroll="auto"
            className="min-h-0 flex-1"
            contentClassName="flex flex-col"
          >
          {rows.map((row) => (
            <ListRow
              key={row.key}
              interactive={false}
              data-testid="external-invite-review-row"
              data-invites={row.invites ? "true" : "false"}
            >
              <ListRowBody>
                <ListRowTitle className="break-all">{row.email}</ListRowTitle>
                <ListRowDescription wrap>
                  {row.hint ? (
                    <Tooltip content={formatMessage({ id: row.hint }, { server: serverName, ...row.values })}>
                      <span data-testid="external-invite-review-row-hint">
                        {formatMessage({ id: row.status }, { server: serverName, ...row.values })}
                      </span>
                    </Tooltip>
                  ) : formatMessage({ id: row.status }, { server: serverName, ...row.values })}
                </ListRowDescription>
              </ListRowBody>
            </ListRow>
          ))}
          </ScrollArea>
        </ListRowGroup>
        ) : null}
        {chosenServers.length > 0 ? (
          <ListRowGroup aria-label={formatMessage({ id: "channel.externalInvite.dialog.serversLabel" })} data-testid="external-invite-review-servers">
            {chosenServers.map((server) => (
              <ListRow key={server.id} interactive={false} data-testid="external-invite-review-server">
                <span className="shrink-0" aria-hidden="true">
                  <AvatarSlot context="list-row" type="server" serverAvatarUrl={server.avatarUrl ?? null} serverInitial={server.name.slice(0, 1)} />
                </span>
                <ListRowBody>
                  <ListRowTitle>{server.name}</ListRowTitle>
                  <ListRowDescription wrap>{formatMessage({ id: "channel.externalInvite.dialog.status.willConnect" }, { server: server.name })}</ListRowDescription>
                </ListRowBody>
              </ListRow>
            ))}
          </ListRowGroup>
        ) : null}
        {actionCount === 0 && (
          <p className="text-callout text-foreground-muted" data-testid="external-invite-nothing-to-send">
            {formatMessage({ id: "channel.externalInvite.dialog.nothingToSend" })}
          </p>
        )}
        {/* The slots, said only when this send could reach them (design E2):
            over them nothing is sent, as with the 20 at a time. */}
        <SlotsLine slotsLeft={slotsLeft} taking={inviteCount + chosenServers.length} channelFullId={channelFullId} />
        <DialogCardFooter>
          <Button size="lg" variant="ghost" type="button" onClick={handleBack} disabled={busy}>
            {formatMessage({ id: "channel.externalInvite.dialog.back" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button
                size={inHead ? "md" : "lg"}
                variant="primary"
                type="submit"
                disabled={actionCount === 0 || overSlots > 0}
                loading={busy}
                loadingLabel={formatMessage({ id: "channel.externalInvite.dialog.sending" })}
                data-testid="external-invite-send"
              >
                {formatMessage({ id: commitLabel })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    );
  }

  return (
    <form onSubmit={handleNext} className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="external-invite-input">
      {notice}
      {privateWarning}
      {errorBanner}
      <ExternalInviteEmailsField value={text} onChange={handleTextChange} overBy={overBy} autoFocus slotsHint={typedSlotsHint} historyHint={serversHistoryHint} />
      <ExternalInviteServersField servers={servers} value={serverIds} onChange={setServerIds} disabled={busy} historyHint={serversHistoryHint} />
      <DialogCardFooter>
        <Button size="lg" variant="ghost" type="button" onClick={onDismiss} disabled={busy} data-testid="external-invite-dismiss">
          {dismissLabel}
        </Button>
        <DialogCommit>
          {(inHead) => (
            <Button
              size={inHead ? "md" : "lg"}
              variant="primary"
              type="submit"
              disabled={(entries.length === 0 && chosenServers.length === 0) || overBy > 0}
              loading={busy}
              loadingLabel={formatMessage({ id: "channel.externalInvite.dialog.checking" })}
              data-testid="external-invite-next"
            >
              {formatMessage({ id: "channel.externalInvite.dialog.next" })}
            </Button>
          )}
        </DialogCommit>
      </DialogCardFooter>
    </form>
  );
}
