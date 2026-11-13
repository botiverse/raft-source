// The Raft-native flows an action card's button opens: the feedback dialog,
// the upgrade dialog, a seat request's Add Seats (and the send-back prompt
// after it), the sender's feedback ticket, and the create dialogs (Create
// Channel, Add Members, Create Agent, and the migration dialog of a "move me"
// card), which the spec card's `open` intents run (ActionCardSpecCard.tsx:
// feedback_form, upgrade_dialog, add_seats, feedback_ticket, create_channel,
// add_members, create_agent, migrate_agent). Also the funnel
// of a card whose native dialog runs its own create call, and the
// mark-executed that completes such a card (and the MCP connect grant, from
// the connect card's picker: McpConnectCardSlot). And the dialog of an action
// that grants permissions, which the spec card opens by the card's action key
// instead of the generic confirm (useActionCardNativeConfirm: the install
// dialog).

import { useCallback, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { GENERAL_UPGRADE_GATE, PRO_AGENT_SEAT_BLOCK_SIZE, isActionCardReadOnlyInServer, isSafeOAuthReturnUrl, isUpgradeGate, seatsAddPurposeTenths } from "@botiverse/raft-shared";
import type { ActionCardMetadata, ActionCardResult, ActionCardSpecIntent, SeatRequestOutcome, SeatsAddPurpose, StoredActionCardAction, UpgradeGate } from "@botiverse/raft-shared";
import api from "../../api/client";
import { usePaywallShown } from "../../analytics/paywall";
import { markAgentFeedbackSent } from "../../feedback/agentFeedbackSentFlag";
import { feedbackTicketPath, feedbackTicketRouteId } from "../../feedback/feedbackPaths";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { CreateAgentDialog } from "../agent/DeferredCreateAgentDialog";
import type { AgentMigrationDialog as AgentMigrationDialogComponent, MigrationStartResponse } from "../agentMigration/AgentMigrationDialog";
import { agentMigrationRequiresUpgrade } from "../agentMigration/billing";
import type { AddSeatsNeed } from "../billing/AddSeatsDialog";
import { purposeCopyValues, seatActionCopyValues } from "../billing/seatRequestCopy";
import { CreateChannelDialog } from "../channel/DeferredCreateChannelDialog";
import ConfirmDialog from "../ConfirmDialog";
import { actionCardErrorText, classifyClientError } from "./actionCardCommon";
import type { ActionCardMutationResponse, useActionCardEvents } from "./actionCardCommon";
import { deferredDialog, lazyDialog } from "../../boot/deferredUi";
import type { FeedbackCardDialog as FeedbackCardDialogComponent } from "./FeedbackCardDialog";
import type { InstallAppCardDialog as InstallAppCardDialogComponent } from "./InstallAppCardDialog";

// Dialogs a card opens on a click stay out of the first download (boot/deferredUi).
const AddMembersDialog = deferredDialog(() => import("../channel/AddMembersDialog"));
const AddSeatsDialog = deferredDialog(() => import("../billing/AddSeatsDialog"));
const FeedbackCardDialog = deferredDialog<ComponentProps<typeof FeedbackCardDialogComponent>>(() => import("./FeedbackCardDialog").then((module) => ({ default: module.FeedbackCardDialog })));
const InstallAppCardDialog = deferredDialog<ComponentProps<typeof InstallAppCardDialogComponent>>(() => import("./InstallAppCardDialog").then((module) => ({ default: module.InstallAppCardDialog })));
// The agent page's own migration dialog, for a "move me" card (few people ever open one from a card).
const AgentMigrationDialog = lazyDialog<ComponentProps<typeof AgentMigrationDialogComponent>>(() => import("../agentMigration/AgentMigrationDialog").then((module) => ({ default: module.AgentMigrationDialog })));

type FormatMessage = IntlShape["formatMessage"];
type EmitEvent = ReturnType<typeof useActionCardEvents>;
type ApplyMutation = (mutation: ActionCardMutationResponse) => void;

/** Who asked for a person's card, by name (a seat request's copy); "someone" when not a member here. */
export function useActionCardRequesterName(metadata: ActionCardMetadata): string {
  const { formatMessage } = useIntl();
  const requester = useServerStore((state) => (
    metadata.requesterUserId ? state.members.find((member) => member.userId === metadata.requesterUserId) : undefined
  ));
  return requester ? requester.displayName || requester.name : formatMessage({ id: "actionCard.person.someone" });
}

/** The done line of an upgrade card past Free: Pro only on Pro (founder and partner plans are not Pro, Till). */
export type UpgradeCardPastFreeLineId = "actionCard.upgrade.done" | "actionCard.upgrade.doneNotFree";

/**
 * An upgrade card on a server that is no longer Free: it has nothing left to
 * offer, and the spec card shows it done, with this done line; null otherwise.
 * Read from the current plan, as Plan & Billing reads it (billing first);
 * nothing is stored on the card (plan state is the client frame's, not the
 * spec's), so a server back on Free gets the card's button back.
 */
export function useUpgradeCardPastFree(metadata: ActionCardMetadata): UpgradeCardPastFreeLineId | null {
  const currentPlan = useServerStore((state) => state.billing?.plan || state.current?.plan);
  const currentServerId = useServerStore((state) => state.current?.id);
  const sourceReadOnly = isActionCardReadOnlyInServer(metadata.sourceServerId, currentServerId);
  if (metadata.action.type !== "plan:upgrade" || sourceReadOnly || !currentPlan || currentPlan === "free") return null;
  return currentPlan === "pro" ? "actionCard.upgrade.done" : "actionCard.upgrade.doneNotFree";
}

/** The upgrade card's gate: the card's own, `general` when it names none this build knows. */
export function upgradeCardGate(gate: unknown): UpgradeGate {
  return isUpgradeGate(gate) ? gate : GENERAL_UPGRADE_GATE;
}

/**
 * Nothing runs from the card: it opens the upgrade dialog for its own server,
 * where an owner pays and anyone else messages an owner. A member's request
 * for Pro is its own opener (`member_request`).
 */
export function openUpgradeForCard({ gate, metadata, messageId, currentServerId, emitEvent }: {
  gate: UpgradeGate;
  metadata: ActionCardMetadata;
  messageId: string;
  currentServerId: string | undefined;
  emitEvent: EmitEvent;
}): void {
  emitEvent("action_card.open", {});
  const serverId = metadata.sourceServerId ?? currentServerId;
  openUpgradeDialog(gate, metadata.requesterUserId
    ? { serverId, source: "member_request" }
    : { serverId, source: "agent_card", cardMessageId: messageId });
}

/**
 * The sender's own feedback ticket in Settings › Feedback (S0.3): a ticket is
 * read only by its sender, through the Hands app it was filed into, so only
 * the sender is shown it. `path` is the ticket; for one filed in a mobile App
 * (`source`) it carries `?platform=`, which sends the web to that App's Hands
 * app. No `source` is a card done before S0.3, when web was the single app.
 * When the ticket route cannot open the id, a web ticket links to the list
 * and an App's ticket has no link (the web's list does not hold it). Null
 * path without a server slug (no settings route to link to). Null for anyone
 * else, who reads where it went.
 */
export function useFeedbackTicketPath(result: ActionCardResult | null | undefined, executedByUserId: string | null | undefined): { path: string | null } | null {
  const viewerId = useAuthStore((state) => state.user?.id);
  const serverSlug = useServerStore((state) => state.current?.slug);
  if (result?.kind !== "product-feedback") return null;
  const sender = viewerId !== undefined && viewerId === executedByUserId;
  const source = result.source ?? "web";
  const ticketId = feedbackTicketRouteId(result.ticketId);
  if (!sender || (source !== "web" && ticketId === null)) return null;
  return { path: feedbackTicketPath(serverSlug, ticketId, source) ?? null };
}

/**
 * The feedback dialog a feedback card opens, prefilled with the agent's
 * draft. Its own request completes the card on the server; the returned card
 * is applied so this tab updates even if realtime lags. Closing it unsent is a
 * dismiss; closing on the sent card is not.
 */
export function useFeedbackCardDialog({ messageId, metadata, emitEvent, applyMutation }: {
  messageId: string;
  metadata: ActionCardMetadata;
  emitEvent: EmitEvent;
  applyMutation: ApplyMutation;
}): { open: () => void; dialog: ReactNode } {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => {
    emitEvent("action_card.open", {});
    setIsOpen(true);
  }, [emitEvent]);
  const close = useCallback(() => {
    emitEvent("action_card.dismiss", {});
    setIsOpen(false);
  }, [emitEvent]);
  const sent = useCallback((actionCard: ActionCardMutationResponse | null) => {
    // They sent an agent's draft: the inbox stops suggesting it (FeedbackAgentHint).
    markAgentFeedbackSent(useAuthStore.getState().user?.id);
    if (actionCard) applyMutation(actionCard);
    setIsOpen(false);
  }, [applyMutation]);
  const submitStart = useCallback(() => emitEvent("action_card.execute_attempt", {}), [emitEvent]);
  const submitError = useCallback((err: unknown) => emitEvent("action_card.execute_fail", classifyClientError(err)), [emitEvent]);
  const action = metadata.action;
  const dialog = action.type === "feedback:submit" && isOpen ? (
    <FeedbackCardDialog
      prefilledType={action.feedbackType}
      prefilledMessage={action.message}
      messageId={messageId}
      confirmationVersion={metadata.confirmationVersion}
      onClose={close}
      onSubmitted={sent}
      onSubmitStart={submitStart}
      onSubmitError={submitError}
    />
  ) : null;
  return { open, dialog };
}

/**
 * The product funnel of a card whose button opens one of Raft's own dialogs,
 * which runs its own create call (Create Channel, Create Agent, Add Members,
 * the install confirm). The dialog may fail before the card is marked
 * executed, which the server can't observe, so the client sends:
 *
 * - `open` as the dialog opens (before, so a stuck dialog keeps the signal);
 * - `execute_attempt` when the dialog starts its call (`onSubmitStart`, after
 *   its own validation passed);
 * - `execute_fail` when that call fails (`onSubmitError`); the dialog stays
 *   open for a retry, whose `execute_success` the server records from
 *   mark-executed;
 * - `dismiss` when the dialog closes without success, never after one.
 *
 * The client never sends `execute_success` (Dozy guardrail msg=a1dbc464). None
 * of these carry metadata but the failure's class: the server derives
 * `action_type` from the card row. A person's card sends nothing
 * (useActionCardEvents).
 */
export interface ActionCardDialogFunnel {
  /** The dialog is opening. */
  open: () => void;
  /**
   * The dialog's call succeeded: its close is not a dismiss. Call it from the
   * success callback (`onCreated` / `onSubmitted`), which dialogs call before
   * `onClose`.
   */
  succeeded: () => void;
  /** The dialog closed (`onClose`): a dismiss unless it succeeded. */
  close: () => void;
  /** The dialog's `onSubmitStart`. */
  submitStart: () => void;
  /** The dialog's `onSubmitError`. */
  submitError: (err: unknown) => void;
}

export function useActionCardDialogFunnel(emitEvent: EmitEvent): ActionCardDialogFunnel {
  // Suppresses `dismiss` when the dialog closes after a successful submit.
  // Dialogs call `onCreated`/`onSubmitted` then `onClose`; flagging success in
  // the success handler lets the close handler tell the difference between
  // "user closed" and "dialog auto-closed after submit".
  const submitSucceededRef = useRef(false);
  const open = useCallback(() => {
    submitSucceededRef.current = false;
    emitEvent("action_card.open", {});
  }, [emitEvent]);
  const succeeded = useCallback(() => {
    submitSucceededRef.current = true;
  }, []);
  // v1 doesn't distinguish close button / ESC / backdrop: all collapse to a
  // single dismiss without a `dismiss_reason`. Adding that is a follow-up.
  const close = useCallback(() => {
    if (!submitSucceededRef.current) emitEvent("action_card.dismiss", {});
    submitSucceededRef.current = false;
  }, [emitEvent]);
  const submitStart = useCallback(() => {
    emitEvent("action_card.execute_attempt", {});
  }, [emitEvent]);
  const submitError = useCallback((err: unknown) => {
    emitEvent("action_card.execute_fail", classifyClientError(err));
  }, [emitEvent]);
  return useMemo(() => ({ open, succeeded, close, submitStart, submitError }), [close, open, submitError, submitStart, succeeded]);
}

/** Who Add Members really added (AddMembersDialog's `onSubmitted`), not the agent's suggestion. */
export interface AddedChannelMembers {
  channelId: string;
  channelName: string;
  addedHumanIds: string[];
  addedAgentIds: string[];
}

/** Mark-executed, one call per result kind the web completes a card with. */
export interface MarkActionCardExecuted {
  /** Create Channel made it (`onCreated`). */
  channel: (channel: { id: string; name: string }) => Promise<void>;
  /** Create Agent made it (`onCreated`). */
  agent: (agent: { id: string; name: string }) => Promise<void>;
  /** Add Members added them (`onSubmitted`). */
  channelMembers: (added: AddedChannelMembers) => Promise<void>;
  /** The migration dialog started the card's Agent's move (`onStarted`). */
  agentMigration: (started: { agentId: string; targetMachineId: string }) => Promise<void>;
  /**
   * The connect card's inline grant (McpConnectCardBody `onGranted`): the grant
   * is the attempt, so `execute_attempt` first, then mark-executed. Nothing for
   * a card of another type.
   */
  mcpConnectionGranted: () => Promise<void>;
}

/**
 * Marks a card executed once Raft's own API did what it asks: a native
 * dialog's create (stdrc 2026-05-10 #proj-approval: open the regular dialog
 * prefilled, mark the card executed only after the normal API succeeds), or the
 * connect card's grant. Under the card's confirmation version; the response is
 * applied at once (the socket update still reaches other tabs).
 *
 * A failure ends the attempt with `execute_fail` (on success the server sends
 * `execute_success`). The card doesn't show the failure, as the resource exists
 * and the card catches up on refresh, except the two MCP refusals: there
 * nothing was granted.
 */
export function useMarkActionCardExecuted({ messageId, metadata, emitEvent, applyMutation, setError }: {
  messageId: string;
  metadata: ActionCardMetadata;
  emitEvent: EmitEvent;
  applyMutation: ApplyMutation;
  setError: (error: string | null) => void;
}): MarkActionCardExecuted {
  const { formatMessage } = useIntl();
  const confirmationVersion = metadata.confirmationVersion;
  const action = metadata.action;
  const markExecuted = useCallback(async (result: ActionCardResult) => {
    try {
      const { data } = await api.post<ActionCardMutationResponse>(
        `/actions/${messageId}/mark-executed`,
        { result, expectedConfirmationVersion: confirmationVersion },
      );
      // The socket update is still useful for other tabs/clients; the local
      // response closes the stale-button window on this tab immediately.
      applyMutation(data);
    } catch (err) {
      // ⚠️ One class of failure is NOT bookkeeping and must not be swallowed. For
      // `integration:connect_mcp` the server refuses mark-executed when the Agent is still not
      // authorized, and in that case nothing was created: the operator closed the dialog believing
      // the Agent can now use the MCP server, while the runtime keeps refusing it. Everything else
      // keeps the old behaviour -- the resource really does exist and the card catches up on refresh.
      const refusal = err as { response?: { status?: number; data?: { error?: string; code?: string } } } | null;
      const refusalCode = refusal?.response?.data?.code;
      if (refusalCode === "MCP_CONNECTION_NOT_AUTHORIZED" || refusalCode === "MCP_CONNECTION_RESULT_MISMATCH") {
        setError(
          refusal?.response?.data?.error
            ?? formatMessage({ id: "actionCard.executeFailed" }),
        );
      }
      // Don't surface other mark-executed failures — the resource is already
      // created. Worst case the card stays "prepared" until refresh.
      console.error("Failed to mark action card executed:", err);
      // Funnel: the dialog-driven `execute_fail` for the mark-executed leg.
      // The create dialog already sent `execute_attempt` (the funnel's
      // `submitStart`); if mark-executed fails, the submit's funnel outcome
      // would otherwise stop at `execute_attempt` with no terminal event. Per
      // Leiysky/Dozy/meichen review 2026-05-13 (msg=5cb29566 / msg=e2d25035 /
      // DM e270834b): send `execute_fail` here too, with the same client
      // classifier. `execute_success` stays server-only: when mark-executed
      // succeeds the server sends it from the canonical
      // `markActionCardExecuted` path, so the client needs only this leg.
      emitEvent("action_card.execute_fail", classifyClientError(err));
    }
  }, [applyMutation, confirmationVersion, emitEvent, formatMessage, messageId, setError]);

  const channel = useCallback((created: { id: string; name: string }) => (
    markExecuted({ kind: "channel", id: created.id, name: created.name })
  ), [markExecuted]);
  const agent = useCallback((created: { id: string; name: string }) => (
    markExecuted({ kind: "agent", id: created.id, name: created.name })
  ), [markExecuted]);
  const channelMembers = useCallback((added: AddedChannelMembers) => markExecuted({
    kind: "channel-members",
    channelId: added.channelId,
    channelName: added.channelName,
    addedHumanIds: added.addedHumanIds,
    addedAgentIds: added.addedAgentIds,
  }), [markExecuted]);
  const agentMigration = useCallback((started: { agentId: string; targetMachineId: string }) => (
    markExecuted({ kind: "agent-migration", agentId: started.agentId, targetMachineId: started.targetMachineId })
  ), [markExecuted]);
  const mcpConnectionGranted = useCallback(async () => {
    if (action.type !== "integration:connect_mcp") return;
    emitEvent("action_card.execute_attempt", {});
    // Only the two ids already on the card -- never the Connection id, which is withheld even from
    // some managers and would otherwise leak through a message body.
    await markExecuted({ kind: "mcp-connection", mcpServerId: action.mcpServerId, agentId: action.agentId });
  }, [action, emitEvent, markExecuted]);
  return useMemo(() => ({ channel, agent, channelMembers, agentMigration, mcpConnectionGranted }), [agent, agentMigration, channel, channelMembers, mcpConnectionGranted]);
}

/** The `open` intents of Raft's create dialogs, with the card type each one prefills from (`metadata.action`). */
const CREATE_DIALOG_ACTION_TYPES = {
  create_channel: "channel:create",
  add_members: "channel:add_member",
  create_agent: "agent:create",
  migrate_agent: "agent:migrate",
} as const satisfies Partial<Record<ActionCardSpecIntent, StoredActionCardAction["type"]>>;
export type ActionCardCreateDialogIntent = keyof typeof CREATE_DIALOG_ACTION_TYPES;

export function isActionCardCreateDialogIntent(intent: ActionCardSpecIntent): intent is ActionCardCreateDialogIntent {
  return Object.hasOwn(CREATE_DIALOG_ACTION_TYPES, intent);
}

/**
 * The create dialog of a channel:create, channel:add_member or agent:create
 * card: Create Channel, Add Members or Create Agent, prefilled from
 * `metadata.action` and bound to the card (its message id and confirmation
 * version, which the dialog's own create call sends). Opening it is the
 * funnel's `open`, closing it the funnel's close; its success marks the card
 * executed with what it made: the spec's create_channel, add_members and
 * create_agent intents. An agent:migrate card's migrate_agent opens the agent
 * page's migration dialog for the card's Agent the same way, the suggested
 * computer preselected, and is marked executed once the move started; on a
 * Free server (migration is Pro) it opens the upgrade dialog instead, as the
 * agent page's Move does (`onUpgradeRequired`, gate agent_migration), also
 * when the migration route says Pro is required.
 *
 * `intent`: the one this card's type opens, null for any other type (`open`
 * then does nothing: there is nothing to prefill from).
 */
export function useActionCardCreateDialog({ messageId, metadata, dialogFunnel, markExecuted, onUpgradeRequired }: {
  messageId: string;
  metadata: ActionCardMetadata;
  dialogFunnel: ActionCardDialogFunnel;
  markExecuted: MarkActionCardExecuted;
  /** A migration needs Pro here: open the upgrade dialog (agent_migration). */
  onUpgradeRequired: (gate: UpgradeGate) => void;
}): { intent: ActionCardCreateDialogIntent | null; open: () => void; dialog: ReactNode } {
  const [isOpen, setIsOpen] = useState(false);
  const action = metadata.action;
  const intent = (Object.keys(CREATE_DIALOG_ACTION_TYPES) as ActionCardCreateDialogIntent[])
    .find((candidate) => CREATE_DIALOG_ACTION_TYPES[candidate] === action.type) ?? null;
  // A migrate card's Agent and where it could go, as the agent page reads them (AgentMigrationSection).
  const migrateAgentId = action.type === "agent:migrate" ? action.agentId ?? null : null;
  const migrateAgent = useAgentStore((state) => (migrateAgentId
    ? state.agents.find((candidate) => candidate.id.toLowerCase() === migrateAgentId.toLowerCase() && !candidate.deletedAt) ?? null
    : null));
  const machines = useMachineStore((state) => state.machines);
  const billingPlan = useServerStore((state) => state.billing?.plan);
  // An agent on no Computer (or on one whose access was revoked) is placed on the target: not a Pro migration.
  const placesWithoutSource = migrateAgent !== null && migrateAgent.executionMode === "byoc"
    && (!migrateAgent.machineId || migrateAgent.blockedReason === "computer_access_revoked");
  const migrationNeedsUpgrade = migrateAgent !== null && !placesWithoutSource && agentMigrationRequiresUpgrade(billingPlan);
  const open = useCallback(() => {
    if (intent === null) return;
    if (intent === "migrate_agent") {
      if (migrateAgent === null) return;
      if (migrationNeedsUpgrade) {
        onUpgradeRequired("agent_migration");
        return;
      }
    }
    // Funnel: sent before the dialog opens, so a stuck dialog doesn't lose the signal.
    dialogFunnel.open();
    setIsOpen(true);
  }, [dialogFunnel, intent, migrateAgent, migrationNeedsUpgrade, onUpgradeRequired]);
  // Closing goes through the funnel: a dismiss unless it succeeded.
  const close = useCallback(() => {
    dialogFunnel.close();
    setIsOpen(false);
  }, [dialogFunnel]);
  // A dialog that succeeded says so before it closes; then the card is marked executed.
  const agentCreated = useCallback((agent: { id: string; name: string }) => {
    dialogFunnel.succeeded();
    void markExecuted.agent(agent);
  }, [dialogFunnel, markExecuted]);
  const channelCreated = useCallback((channel: { id: string; name: string }) => {
    dialogFunnel.succeeded();
    void markExecuted.channel(channel);
  }, [dialogFunnel, markExecuted]);
  const membersAdded = useCallback((added: AddedChannelMembers) => {
    dialogFunnel.succeeded();
    void markExecuted.channelMembers(added);
  }, [dialogFunnel, markExecuted]);
  // The move started: the card is done (its progress is on the Agent's page). The
  // dialog has no submit-start callback, so the attempt is sent here, before mark-executed.
  const migrationStarted = useCallback(async (started: MigrationStartResponse) => {
    dialogFunnel.succeeded();
    setIsOpen(false);
    dialogFunnel.close();
    if (!migrateAgentId || !started.targetMachineId) return;
    dialogFunnel.submitStart();
    await markExecuted.agentMigration({ agentId: migrateAgentId, targetMachineId: started.targetMachineId });
  }, [dialogFunnel, markExecuted, migrateAgentId]);
  const migrationNeedsPro = useCallback(() => {
    close();
    onUpgradeRequired("agent_migration");
  }, [close, onUpgradeRequired]);

  let dialog: ReactNode = null;
  if (isOpen && action.type === "agent:create") {
    dialog = (
      <CreateAgentDialog
        onClose={close}
        prefilledName={action.name}
        prefilledDescription={action.description}
        prefilledMachineId={action.requiredComputer ?? action.suggestedComputer}
        prefilledMachineMode={action.requiredComputer ? "required" : action.suggestedComputer ? "preferred" : undefined}
        prefilledHosting={action.hosting}
        prefilledHostedModel={action.model}
        actionCardMessageId={messageId}
        actionCardConfirmationVersion={metadata.confirmationVersion}
        onCreated={agentCreated}
        onSubmitStart={dialogFunnel.submitStart}
        onSubmitError={dialogFunnel.submitError}
        fromActionCard
      />
    );
  } else if (isOpen && action.type === "channel:create") {
    dialog = (
      <CreateChannelDialog
        onClose={close}
        prefilledName={action.name}
        prefilledDescription={action.description}
        prefilledVisibility={action.visibility}
        prefilledHumanIds={action.initialHumans}
        prefilledAgentIds={action.initialAgents}
        onCreated={channelCreated}
        actionCardMessageId={messageId}
        actionCardConfirmationVersion={metadata.confirmationVersion}
        onSubmitStart={dialogFunnel.submitStart}
        onSubmitError={dialogFunnel.submitError}
      />
    );
  } else if (isOpen && action.type === "agent:migrate" && migrateAgent) {
    dialog = (
      <AgentMigrationDialog
        agent={migrateAgent}
        machines={machines}
        sourceMachineId={migrateAgent.machineId ?? null}
        placesWithoutSource={placesWithoutSource}
        initialTarget={action.suggestedComputer ?? null}
        onClose={close}
        onProRequired={migrationNeedsPro}
        onStarted={migrationStarted}
      />
    );
  } else if (isOpen && action.type === "channel:add_member") {
    dialog = (
      <AddMembersDialog
        channelId={action.channel}
        prefilledHumanIds={action.humans}
        prefilledAgentIds={action.agents}
        draftHint={action.draftHint}
        onClose={close}
        onSubmitted={membersAdded}
        actionCardMessageId={messageId}
        actionCardConfirmationVersion={metadata.confirmationVersion}
        onSubmitStart={dialogFunnel.submitStart}
        onSubmitError={dialogFunnel.submitError}
      />
    );
  }
  return { intent, open, dialog };
}

/**
 * A done install card's next step: the installed App's setup page, from
 * `metadata.result.setupUrl` (the spec shows it as text only, as no card
 * carries an App's URL as a link: actionCardSpecBuilder), and only an https
 * (or loopback http) URL with no credentials or fragment
 * (isSafeOAuthReturnUrl). Null for any other card.
 * The spec frame draws it as Continue setup (ActionCardContinueSetup) and
 * keeps such a card open, so the link shows without unfolding it.
 */
export function installedAppSetupUrl(metadata: ActionCardMetadata): string | null {
  const result = metadata.result;
  if (metadata.state !== "executed" || metadata.action.type !== "integration:install_marketplace_app") return null;
  if (result?.kind !== "marketplace-app-installation" || !result.setupUrl || !isSafeOAuthReturnUrl(result.setupUrl)) return null;
  return result.setupUrl;
}

/** What a permission-granting action's own dialog is given: the card's action of that key, and its call's callbacks. */
interface NativeConfirmDialogProps<A> {
  action: A;
  messageId: string;
  confirmationVersion?: number;
  onClose: () => void;
  onExecuted: (out: ActionCardMutationResponse) => void;
  onSubmitStart: () => void;
  onSubmitError: (err: unknown) => void;
}

/**
 * The actions that grant permissions, by action key (`metadata.action.type`),
 * each with Raft's own dialog that confirms and runs it: the one table
 * useActionCardNativeConfirm reads, both whether a card has such a dialog and
 * which one it draws.
 */
const NATIVE_CONFIRM_DIALOGS: {
  readonly [T in "integration:install_marketplace_app"]: (props: NativeConfirmDialogProps<Extract<StoredActionCardAction, { type: T }>>) => ReactNode;
} = {
  "integration:install_marketplace_app": (props) => <InstallAppCardDialog {...props} />,
};
type NativeConfirmActionType = keyof typeof NATIVE_CONFIRM_DIALOGS;

/**
 * The dialog that confirms and runs an action granting permissions, chosen
 * here by the card's action key (`metadata.action.type`) from
 * NATIVE_CONFIRM_DIALOGS, never by anything in its spec. The spec card
 * dispatches to it: on such a card every press that would run the action (an
 * `execute`, with or without a `confirm`, or an `open_form`) opens this dialog
 * instead of the generic confirm, and only the dialog executes the card.
 *
 * The rule for each of these dialogs (Q1, Tenny 6cad605e), for the install
 * dialog and for every permission-granting action added here later: what the
 * person consents to (the consent text, the permissions, the App's name) comes
 * from the server by the App's id (its Marketplace record), never from a card
 * field an agent or a builder can fill (InstallAppCardDialog). There is no
 * per-card switch: a card can neither opt out of its dialog nor opt another
 * action into one. A new permission-granting action joins
 * NATIVE_CONFIRM_DIALOGS with a dialog that follows the rule, never with a
 * flag on the card; the server builds such a card's button as a plain execute,
 * with no confirm tree from the card's fields (actionCardSpecBuilder).
 *
 * The funnel is the native dialogs' (useActionCardDialogFunnel): `open` as
 * the dialog opens, `dismiss` when it closes without having run,
 * `execute_attempt` and `execute_fail` from its own call; `execute_success`
 * only ever comes from the server. Its execute response is the completed
 * card, applied at once. `open` is null on a card whose action has no such
 * dialog.
 */
export function useActionCardNativeConfirm({ messageId, metadata, dialogFunnel, applyMutation, setError }: {
  messageId: string;
  metadata: ActionCardMetadata;
  dialogFunnel: ActionCardDialogFunnel;
  applyMutation: ApplyMutation;
  setError: (error: string | null) => void;
}): { open: (() => void) | null; dialog: ReactNode } {
  const [isOpen, setIsOpen] = useState(false);
  const action = metadata.action;
  const open = useCallback(() => {
    setError(null);
    dialogFunnel.open();
    setIsOpen(true);
  }, [dialogFunnel, setError]);
  const close = useCallback(() => {
    dialogFunnel.close();
    setIsOpen(false);
  }, [dialogFunnel]);
  // The execute response closes the dialog: no dismiss.
  const executed = useCallback((out: ActionCardMutationResponse) => {
    dialogFunnel.succeeded();
    applyMutation(out);
    setIsOpen(false);
  }, [applyMutation, dialogFunnel]);
  // The table's key is the action's type, so the action is that key's action.
  const draw = Object.hasOwn(NATIVE_CONFIRM_DIALOGS, action.type)
    ? NATIVE_CONFIRM_DIALOGS[action.type as NativeConfirmActionType] as (props: NativeConfirmDialogProps<typeof action>) => ReactNode
    : null;
  const dialog = isOpen && draw ? draw({
    action,
    messageId,
    confirmationVersion: metadata.confirmationVersion,
    onClose: close,
    onExecuted: executed,
    onSubmitStart: dialogFunnel.submitStart,
    onSubmitError: dialogFunnel.submitError,
  }) : null;
  return { open: draw ? open : null, dialog };
}

/** What the server answers before an owner pays for a seat request (GET /actions/:id/seat-request). */
interface SeatRequestCheck {
  requesterAllowed: boolean;
  seatsShort: number;
}

/** The add-seats dialog's sum row for what a seat request is for, in the owner's words. */
function seatRequestSumRow(formatMessage: FormatMessage, seats: number, purpose: SeatsAddPurpose, requesterName: string): Pick<AddSeatsNeed, "tenths" | "label"> {
  const row = (label: string) => ({ tenths: seatsAddPurposeTenths(purpose), label });
  switch (purpose.kind) {
    case "agent:create":
      return row(formatMessage({ id: "addSeats.createAgent.label" }, { name: purpose.name }));
    case "assistant:create":
      return row(formatMessage({ id: "addSeats.request.assistantLabel" }, { requester: requesterName }));
    case "invite":
      return row(formatMessage({ id: "addSeats.invite.label" }, { count: seatsAddPurposeTenths(purpose) / PRO_AGENT_SEAT_BLOCK_SIZE }));
    case "member:promote":
      return row(formatMessage({ id: "addSeats.promote.label" }, { name: purpose.name }));
    case "join":
      return row(formatMessage({ id: "addSeats.join.label" }, { name: purpose.name }));
    default:
      return { tenths: seats * PRO_AGENT_SEAT_BLOCK_SIZE, label: formatMessage({ id: "actionCard.title.addSeats" }, { count: seats }) };
  }
}

/**
 * A seat request's Add Seats, the owner's flow (outside the agent-card
 * funnel): asked before anyone pays whether the requester can still do it and
 * how many seats are short now. None short completes it at once; a requester
 * who no longer can ends it at once too, with nothing to pay (the server ends
 * it `requester_cannot`, and the card says so), and so does a join for
 * someone no longer waiting to join (`not_needed`). Otherwise the add-seats
 * dialog; once the seats count, an agent's request waits on the requester, so
 * its owner may send them the card to create it. The request is also the
 * owner's seat-limit paywall, shown to whoever can add the seats.
 */
export function useSeatRequestFlow({ messageId, metadata, canOperateCard, cardServerName, requesterName, applyMutation, setBusy, setError, finalFocus }: {
  messageId: string;
  metadata: ActionCardMetadata;
  canOperateCard: boolean;
  /** The server the card is about, for the dialog's copy. */
  cardServerName: string;
  requesterName: string;
  applyMutation: ApplyMutation;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  /** Where focus goes after the send-back prompt (Add Seats is gone with the done card). */
  finalFocus?: RefObject<HTMLElement | null>;
}): { start: () => Promise<void>; dialogs: ReactNode } {
  const { formatMessage } = useIntl();
  const loadBilling = useServerStore((state) => state.loadBilling);
  const [seatsShortNow, setSeatsShortNow] = useState<number | null>(null);
  const [sendBackName, setSendBackName] = useState<string | null>(null);
  const seatRequest = metadata.action.type === "seats:add" ? metadata.action : null;
  const seatPurpose = seatRequest?.purpose ?? null;
  const seatGate = seatPurpose?.kind === "invite" || seatPurpose?.kind === "member:promote" || seatPurpose?.kind === "join" ? "seat_limit_invite" as const : "seat_limit_agent_create" as const;
  usePaywallShown(seatRequest !== null && canOperateCard && metadata.state === "prepared" && seatGate);

  const completeSeatRequest = useCallback(async () => {
    const { data } = await api.post<ActionCardMutationResponse & { outcome?: SeatRequestOutcome }>(`/actions/${messageId}/seats-added`, {});
    applyMutation({ messageId: data.messageId, metadata: data.metadata });
    if (data.outcome?.kind === "ready" && data.outcome.purpose === "agent:create") setSendBackName(data.outcome.name);
  }, [applyMutation, messageId]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const [{ data: check }] = await Promise.all([
        api.get<SeatRequestCheck>(`/actions/${messageId}/seat-request`),
        useServerStore.getState().billing ? null : loadBilling(),
      ]);
      if (!check.requesterAllowed || check.seatsShort === 0) {
        await completeSeatRequest();
        return;
      }
      setSeatsShortNow(check.seatsShort);
    } catch (err) {
      setError(actionCardErrorText(err, formatMessage({ id: "actionCard.executeFailed" })));
    } finally {
      setBusy(false);
    }
  }, [completeSeatRequest, formatMessage, loadBilling, messageId, setBusy, setError]);

  const closeAddSeats = useCallback(() => setSeatsShortNow(null), []);
  const handleSeatsAdded = useCallback(() => {
    setSeatsShortNow(null);
    setBusy(true);
    completeSeatRequest()
      .catch((err) => setError(actionCardErrorText(err, formatMessage({ id: "actionCard.executeFailed" }))))
      .finally(() => setBusy(false));
  }, [completeSeatRequest, formatMessage, setBusy, setError]);
  const closeSendBack = useCallback(() => setSendBackName(null), []);
  const sendCreateAgentCard = useCallback(async () => {
    await api.post(`/actions/${messageId}/send-create-agent-card`, {});
  }, [messageId]);

  // The add-seats dialog, in the owner's words for what it's for.
  const seatNeed: AddSeatsNeed | null = useMemo(() => (seatsShortNow === null || !seatRequest?.purpose ? null : {
    ...seatRequestSumRow(formatMessage, seatRequest.seats, seatRequest.purpose, requesterName),
    title: formatMessage({ id: "addSeats.request.title" }, { count: seatsShortNow, requester: requesterName }),
    hint: formatMessage({ id: "addSeats.request.hint" }, { requester: requesterName, server: cardServerName, ...purposeCopyValues(seatRequest.purpose) }),
    resume: formatMessage({ id: "addSeats.request.resume" }, { requester: requesterName, ...purposeCopyValues(seatRequest.purpose) }),
    gate: seatGate,
  }), [cardServerName, formatMessage, requesterName, seatGate, seatRequest, seatsShortNow]);

  const dialogs = (
    <>
      {seatNeed ? <AddSeatsDialog need={seatNeed} onClose={closeAddSeats} onAdded={handleSeatsAdded} /> : null}
      {sendBackName !== null ? (
        <ConfirmDialog
          title={formatMessage({ id: "actionCard.person.sendBack.title" }, { requester: requesterName, name: sendBackName })}
          message={formatMessage({ id: "actionCard.person.sendBack.description" }, { requester: requesterName, name: sendBackName })}
          confirmLabel={formatMessage({ id: "actionCard.person.sendBack.send" })}
          confirmVariant="primary"
          confirmTestId="action-card-send-back"
          onConfirm={sendCreateAgentCard}
          onClose={closeSendBack}
          finalFocus={finalFocus}
        />
      ) : null}
    </>
  );
  return { start, dialogs };
}

/**
 * What came of a seat request, on its own line under who did it: the
 * requester reads their own next step as "You can …". Null without one, or for
 * an outcome from a server newer than this build.
 */
export function useSeatOutcomeText(metadata: ActionCardMetadata, requesterName: string): string | null {
  const { formatMessage } = useIntl();
  const viewerId = useAuthStore((state) => state.user?.id);
  const seatOutcome = metadata.seatOutcome ?? null;
  if (!seatOutcome) return null;
  const outcomeWho = viewerId !== undefined && viewerId === metadata.requesterUserId ? "me" : "other";
  switch (seatOutcome.kind) {
    case "invites":
      return formatMessage({ id: "actionCard.person.outcome.invites" }, { sent: seatOutcome.sent, failed: seatOutcome.failed });
    case "promoted":
      return formatMessage({ id: "actionCard.person.outcome.promoted" }, { name: seatOutcome.name, role: seatOutcome.role });
    case "ready": {
      // Someone a full link turned away goes ahead themselves (not named: the card no longer holds them).
      if (seatOutcome.purpose === "join") return formatMessage({ id: "actionCard.person.outcome.join" });
      const values = seatActionCopyValues(seatOutcome);
      return values ? formatMessage({ id: "actionCard.person.outcome.ready" }, { requester: requesterName, who: outcomeWho, ...values }) : null;
    }
    case "requester_cannot":
      return formatMessage({ id: "actionCard.person.outcome.requesterCannot" }, { requester: requesterName, who: outcomeWho });
    case "not_needed":
      return formatMessage({ id: "actionCard.person.outcome.notNeeded" });
    default:
      return null;
  }
}
