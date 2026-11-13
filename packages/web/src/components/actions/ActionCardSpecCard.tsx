// A first-party action card described by its spec (`presentation.card`,
// `action-card.v1`): one frame for every type. The frame is the client's and
// reads `actionMetadata`, plus the server's plan for an upgrade card (plan
// state is the client's to show, never the spec's): the header (the spec's icon
// and title), the state (done and by whom, or done because the server left
// Free, frozen, confirm again, view only and why), busy and errors. The spec
// gives the body, the buttons, the forms they open and, once done, the result:
// folded, the header names its first item after an arrow; opened, its rows join
// the body's property list. Buttons run through the /api/actions endpoints; a
// form submits through execute with its values. An `open` runs one of Raft's
// own flows (actionCardIntentFlows.tsx): the feedback dialog, the upgrade
// dialog, a seat request's Add Seats, the sender's feedback ticket, and Create
// Channel, Add Members and Create Agent (prefilled from
// `actionMetadata.action`, with the native dialogs' funnel events and
// mark-executed), and an agent:migrate card's migration dialog (done once the
// move starts). A question card (question:ask) that ended unanswered says why
// under its title (QuestionCardLines): it expired, or its agent withdrew it
// (`withdrawn`, a state only question cards reach). A question card whose form
// is `placement: "inline"` is answered in its body (QuestionInlineForm, spec
// §5.9) rather than in the sheet; either way its answer waits 1.5 s for an Undo
// before it is sent (spec §5.10). A connect card (integration:connect_mcp) has
// no button in its spec, as the picker is projected for each viewer: the frame,
// by the card's type, mounts that picker under the body and draws its Confirm
// Again. An action that grants permissions (an install card) runs from Raft's
// own dialog, by its action key (useActionCardNativeConfirm); once an App is
// installed the frame links its setup page (ActionCardContinueSetup).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ComponentType, ReactElement, SVGProps } from "react";
import { useIntl } from "react-intl";
import { Link } from "react-router-dom";
import { AppWindow, Bot, Check, CreditCard, Hash, KeyRound, Package, Plug, ShieldAlert, Lightbulb, UserPlus } from "lucide-react";
import {
  Button,
  MessageActionCard,
  MessageActionCardActions,
  MessageActionCardActionsNote,
  MessageActionCardCollapseTrigger,
  MessageActionCardContent,
  MessageActionCardHeader,
  MessageActionCardHeaderDescription,
  MessageActionCardHeaderIcon,
  MessageActionCardHeaderTitle,
  MessageActionCardNotice,
  MessageActionCardStatus,
} from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import { useTruncated } from "@botiverse/raft-ui/wip";
import type {
  ActionCardFormSubmission, ActionCardMetadata, ActionCardRenderedCard, ActionCardSpecIcon, ActionCardSpecIntent, UpgradeGate,
} from "@botiverse/raft-shared";
import { buildMessagePermalink } from "../../hooks/useAppNavigate";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { appLinkDomain, appLinkOpenHref } from "../../utils/appLinkAddress";
import { KEEP_END, KeptEnd } from "../message/CardElements";
import Banner from "../ui/Banner";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { useActionCardShown } from "../../analytics/actionCards";
import Tooltip from "../ui/Tooltip";
import {
  actionCardErrorText,
  classifyClientError,
  CommittedByLine,
  executeActionCard,
  isUnknownActionCardState,
  readActionCardFormSubmitFailure,
  reconfirmActionCard,
  useActionCardAccess,
  useActionCardEvents,
  useApplyActionCardMutation,
} from "./actionCardCommon";
import { isActionCardShownExpired, useExpiredCardLine } from "./actionCardExpired";
import { isSecondFactorStepUpCancelled } from "../settings/secondFactorStepUp";
import { useActionCardNavigate } from "./ActionCardEntityRef";
import { ActionCardServerContext, useIsNavigableTarget } from "./actionCardEntities";
import { ActionCardPlainText, ActionCardRichText, ActionCardSpecRenderer, useActionCardMsgText } from "./ActionCardSpecRenderer";
import { ActionCardSpecConfirmDialog } from "./ActionCardSpecConfirmDialog";
import { ActionCardContinueSetup } from "./ActionCardContinueSetup";
import { ActionCardFoldedResult } from "./ActionCardFoldedResult";
import { QuestionCardEndedLine } from "./QuestionCardLines";
import { QuestionInlineForm } from "./QuestionInlineForm";
import { executeActionCardKeepalive } from "./actionCardKeepaliveExecute";
import { inlineQuestionForm, resultHeadline, withoutButtons, withoutElements, withoutInlineQuestions, withResultRows, withTextEntityParamsAsNames } from "./actionCardTreeParts";
import { actionCardFormDraftKey, clearActionCardFormDrafts } from "../../store/actionCardFormDrafts";
import type { ActionCardRenderedButton } from "./ActionCardSpecRenderer";
import {
  isActionCardCreateDialogIntent,
  openUpgradeForCard,
  upgradeCardGate,
  useActionCardCreateDialog,
  useActionCardDialogFunnel,
  installedAppSetupUrl,
  useActionCardNativeConfirm,
  useActionCardRequesterName,
  useFeedbackCardDialog,
  useFeedbackTicketPath,
  useMarkActionCardExecuted,
  useSeatOutcomeText,
  useSeatRequestFlow,
  useUpgradeCardPastFree,
} from "./actionCardIntentFlows";
import { McpConnectCardSlot } from "./McpConnectCardSlot";
import type { ActionCardCreateDialogIntent } from "./actionCardIntentFlows";
import { deferredDialog } from "../../boot/deferredUi";
import { actionCardReload, actionCardUnrunnableOpensInWeb } from "./actionCardSpecRead";
import type { ActionCardFormSheet as ActionCardFormSheetComponent } from "./ActionCardFormSheet";

// The form sheet opens on a click: it stays out of the first download (boot/deferredUi).
const ActionCardFormSheet = deferredDialog<ComponentProps<typeof ActionCardFormSheetComponent>>(() => import("./ActionCardFormSheet").then((module) => ({ default: module.ActionCardFormSheet })));

/**
 * The copy of the notice a connect card stored before #proj-apps:#41 keeps
 * (stored cards keep their spec; the server no longer writes it). It told the
 * person to choose a connection: wrong wherever the picker isn't, and the DS
 * keeps a notice for standing facts about consequences or permissions. Never
 * shown; that notice only, by its copy's key.
 */
const STORED_MCP_INSTRUCTION = "actionCard.mcp.loginRequired";

/** The busy id of the Confirm Again the frame draws itself (a connect card's): no spec element id has a `#`. */
const FRAME_RECONFIRM_ID = "#frame-reconfirm";

const SPEC_ICONS: Readonly<Record<ActionCardSpecIcon, ComponentType<SVGProps<SVGSVGElement>>>> = {
  hash: Hash,
  bot: Bot,
  user_plus: UserPlus,
  key: KeyRound,
  app: AppWindow,
  package: Package,
  plug: Plug,
  message: MessageIcon,
  sparkles: Lightbulb,
  // Restoring the App owner and the approvals; upgrading and seat requests (Plan & Billing's icon).
  shield: ShieldAlert,
  credit_card: CreditCard,
};

interface Props {
  messageId: string;
  metadata: ActionCardMetadata;
  /** Channel of the carrier message (thread carriers resolve authority from their parent). */
  channelId: string;
  /** The channel the carrier conversation hangs off (a thread's or task conversation's parent): whose membership decides. */
  parentChannelId?: string;
  /** The card as readActionCardSpec returned it. */
  card: ActionCardRenderedCard;
}

export function ActionCardSpecCard({ messageId, metadata, channelId, parentChannelId, card }: Props) {
  const { formatMessage } = useIntl();
  const {
    carrierChannel, canOperateCard, blockedReasonText, blockedReasonId, runsOnTargetServer, targetServerName, currentServerId, currentServerName, sourceReadOnly,
  } = useActionCardAccess({ messageId, metadata, channelId, parentChannelId });
  const emitEvent = useActionCardEvents(messageId, metadata);
  const applyMutation = useApplyActionCardMutation(channelId);
  // What a press started and is still running (null: nothing): the button it
  // came from shows the raft-ui loading state saying what is happening (DS
  // Button: "Creating…"); the card's other changing buttons wait, disabled.
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const busy = busyAction !== null;
  // The seat flow runs its own requests (the pre-pay check, completing the
  // request after Add Seats): busy as the press that started it says, else working.
  const setSeatFlowBusy = useCallback((on: boolean) => {
    setBusyAction((current) => (on ? current ?? { buttonId: null, label: "actionCard.busy.working" } : null));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [formId, setFormId] = useState<string | null>(null);
  // Closing the confirm dialog after it executed is not a dismiss.
  const confirmSucceededRef = useRef(false);
  // Focus after the send-back prompt: Add Seats is gone with the done card, so the card's own toggle.
  const collapseRef = useRef<HTMLButtonElement>(null);
  const requesterName = useActionCardRequesterName(metadata);
  // The server the card is about: the viewer's own unless it is a peer's copy.
  const cardServerName = (sourceReadOnly ? null : currentServerName) ?? targetServerName ?? "";
  const seatFlow = useSeatRequestFlow({
    messageId, metadata, canOperateCard, cardServerName, requesterName, applyMutation, setBusy: setSeatFlowBusy, setError, finalFocus: collapseRef,
  });
  const startAddSeats = seatFlow.start;
  const feedbackDialog = useFeedbackCardDialog({ messageId, metadata, emitEvent, applyMutation });
  const openFeedbackDialog = feedbackDialog.open;
  const feedbackTicket = useFeedbackTicketPath(metadata.result, metadata.executedByUserId);
  const outcomeText = useSeatOutcomeText(metadata, requesterName);
  // Create Channel, Add Members or Create Agent: Raft's own dialog, its funnel and mark-executed.
  // The connect picker's grant marks the card executed too; its two MCP refusals show on this card.
  const dialogFunnel = useActionCardDialogFunnel(emitEvent);
  const markExecuted = useMarkActionCardExecuted({ messageId, metadata, emitEvent, applyMutation, setError });
  // A move needs Pro on this server: the upgrade dialog, as an upgrade card opens it.
  const openUpgradeForMigration = useCallback((gate: UpgradeGate) => {
    openUpgradeForCard({ gate, metadata, messageId, currentServerId, emitEvent });
  }, [currentServerId, emitEvent, messageId, metadata]);
  const createDialog = useActionCardCreateDialog({ messageId, metadata, dialogFunnel, markExecuted, onUpgradeRequired: openUpgradeForMigration });
  const { intent: createIntent, open: openCreateDialog } = createDialog;
  // An action that grants permissions: its own dialog, by the card's action key (the rule: useActionCardNativeConfirm).
  const nativeConfirm = useActionCardNativeConfirm({ messageId, metadata, dialogFunnel, applyMutation, setError });

  // Render from the `metadata` prop: `message:updated` and every mutation
  // response merge into the message store and flow back down here.
  const isExecuted = metadata.state === "executed";
  const isFrozen = metadata.state === "frozen";
  const needsReconfirmation = metadata.state === "reconfirm_required";
  // Ended without running: a person's request no owner answered in time, a
  // card no one completed within its 30 days (or past the deadline the server
  // served, on render: isActionCardShownExpired), or a state this build
  // doesn't know (view-only).
  const isExpired = isActionCardShownExpired(metadata);
  const expiredLine = useExpiredCardLine(metadata);
  const isQuestion = metadata.action.type === "question:ask";
  // A form draft is the signed-in person's own (store/actionCardFormDrafts.ts).
  const viewerId = useAuthStore((state) => state.user?.id);
  // A question card its agent took back: ended, as an unknown state is, but named.
  const isWithdrawn = isQuestion && metadata.state === "withdrawn";
  const unknownState = isUnknownActionCardState(metadata.state);
  const ended = isExpired || isWithdrawn || unknownState;
  // An upgrade card on a server no longer on Free is done: nothing left to
  // offer, so no button, and a done line from the plan (Pro only on Pro).
  // Nothing is stored: back on Free, the button returns.
  const pastFreeLineId = useUpgradeCardPastFree(metadata);
  const done = isExecuted || pastFreeLineId !== null;
  const cardRef = useRef<HTMLDivElement>(null);
  useActionCardShown(cardRef, {
    messageId,
    actionType: metadata.action.type,
    actionable: canOperateCard && !done && !isFrozen && !ended,
    personCard: Boolean(metadata.requesterUserId),
    serverId: currentServerId,
  });

  // The state in the header: a word led by the raft-ui status pixel. Done,
  // ended and view-only cards fold to their header by default; frozen and
  // reconfirm cards stay open because they wait on the reader.
  const status = done
    ? { variant: "success" as const, label: formatMessage({ id: "actionCard.done" }) }
    : isExpired
      ? { variant: "muted" as const, label: formatMessage({ id: "actionCard.person.status.expired" }) }
      : isWithdrawn
        ? { variant: "muted" as const, label: formatMessage({ id: "actionCard.question.status.withdrawn" }) }
      : unknownState
        ? { variant: "muted" as const, label: formatMessage({ id: "actionCard.status.viewOnly" }) }
        : isFrozen
          ? { variant: "muted" as const, label: formatMessage({ id: "actionCard.frozen" }) }
          : needsReconfirmation
            ? { variant: "accent" as const, label: formatMessage({ id: "actionCard.status.reconfirm" }) }
            : blockedReasonText
              ? { variant: "muted" as const, label: formatMessage({ id: "actionCard.status.viewOnly" }) }
              : null;
  // A done install card whose App has a setup page stays open: its next step, Continue setup, shows unfolded.
  const [initialFold] = useState((done && installedAppSetupUrl(metadata) === null) || ended || (Boolean(blockedReasonText) && !isFrozen && !needsReconfirmation));
  const [readerOpen, setReaderOpen] = useState<boolean | null>(null);
  const open = status === null ? true : (readerOpen ?? !initialFold);
  // A connect card (integration:connect_mcp) is the frame's to finish: its picker, its buttons, its result's Agent.
  const mcpAction = metadata.action.type === "integration:connect_mcp" ? metadata.action : null;
  // The connect card's result line names the Agent it granted access to by its
  // display name, as the DS names people and agents in prose, not as an
  // @handle mention; this line only. From the viewer's own store, as the
  // picker names it: this card's one Agent (the server checks the result's is
  // the card's), and only once the line shows. Not on another server's copy,
  // whose agents the viewer's store doesn't hold. Without it, the reference's
  // fallback is the name the server had; a card prepared before it named the
  // Agent (#proj-apps:#41) has only the id's start there, so the line says the
  // generic "Agent" rather than an id.
  const mcpResultAgent = useAgentStore((state) => (mcpAction && isExecuted && !sourceReadOnly
    ? state.agents.find((agent) => agent.id === mcpAction.agentId) ?? null
    : null));
  const shownResult = useMemo(() => {
    const result = card.result && withoutButtons(card.result, (button) => button.action.kind === "open"
      && button.action.intent === "feedback_ticket" && !feedbackTicket?.path);
    if (!result || !mcpAction) return result;
    return withTextEntityParamsAsNames(result, "agent", (ref) => {
      const known = mcpResultAgent && ref.id === mcpResultAgent.id.toLowerCase() ? mcpResultAgent.displayName || mcpResultAgent.name : "";
      if (known) return known;
      return ref.fallback === ref.id.slice(0, 8) ? formatMessage({ id: "message.author.agentFallback" }) : ref.fallback;
    });
  }, [card.result, feedbackTicket, formatMessage, mcpAction, mcpResultAgent]);
  // The done header's target, for every type with a result, except a question
  // card's: its result starts with a question, and its header has lines of its
  // own. Not when the title says it already (it would only repeat a name:
  // ActionCardFoldedResult). From the result as shown (a connect card's Agent
  // by name, never a bare id).
  const resultFirst = useMemo(() => (isExecuted && !isQuestion && shownResult ? resultHeadline(shownResult) : null), [isExecuted, isQuestion, shownResult]);
  // Under the title: who ran it and when (or that the server left Free), why it ended, or why this viewer can't run it.
  const headerLine = pastFreeLineId !== null ? (
    <>
      <Check aria-hidden="true" className="mr-1.5 inline-block size-4 shrink-0 align-[-3px] text-foreground" />
      {formatMessage({ id: pastFreeLineId })}
    </>
  ) : isExecuted
    ? metadata.executedByUserName || outcomeText ? (
      <>
        <Check aria-hidden="true" className="mr-1.5 inline-block size-4 shrink-0 align-[-3px] text-foreground" />
        <CommittedByLine metadata={metadata} />
        {/* Folded, what came of it after an arrow: the result section's first item (handoffs-and-approvals.md, Done).
            The line may wrap before the arrow; the arrow keeps its first word. */}
        {!open && resultFirst ? <ActionCardFoldedResult item={resultFirst} title={card.title} /> : null}
        {/* A seat request's outcome, on its own line (the owner sees it as well as the requester). */}
        {outcomeText ? <span className="block" data-testid="action-card-outcome">{outcomeText}</span> : null}
      </>
    ) : null
    : isQuestion && (isExpired || isWithdrawn)
      ? <QuestionCardEndedLine metadata={metadata} card={card} />
    : isExpired
      ? expiredLine
      : unknownState ? null : blockedReasonText;

  const execute = useCallback(async (buttonId: string) => {
    setError(null);
    setBusyAction({ buttonId, label: "actionCard.busy.working" });
    try {
      applyMutation(await executeActionCard(messageId, metadata.confirmationVersion));
    } catch (err) {
      // "Verify it's you" closed: the card stays as it was.
      if (isSecondFactorStepUpCancelled(err)) return;
      setError(actionCardErrorText(err, formatMessage({ id: "actionCard.executeFailed" })));
    } finally {
      setBusyAction(null);
    }
  }, [applyMutation, formatMessage, messageId, metadata.confirmationVersion]);

  const reconfirm = useCallback(async (buttonId: string) => {
    setError(null);
    setBusyAction({ buttonId, label: "actionCard.busy.reconfirming" });
    try {
      applyMutation(await reconfirmActionCard(messageId));
    } catch (err) {
      setError(actionCardErrorText(err, formatMessage({ id: "actionCard.reconfirmationFailed" })));
    } finally {
      setBusyAction(null);
    }
  }, [applyMutation, formatMessage, messageId]);

  const openConfirm = useCallback((id: string) => {
    setError(null);
    confirmSucceededRef.current = false;
    emitEvent("action_card.open", {});
    setConfirmId(id);
  }, [emitEvent]);
  const closeConfirm = useCallback(() => {
    if (!confirmSucceededRef.current) emitEvent("action_card.dismiss", {});
    confirmSucceededRef.current = false;
    setConfirmId(null);
  }, [emitEvent]);
  // The dialog shows a failure itself and stays open for another try. The
  // funnel events are the native dialogs' (onSubmitStart /
  // onSubmitError): the attempt when the request starts, a failure with its
  // coarse class; `execute_success` only ever comes from the server.
  const confirmExecute = useCallback(async () => {
    emitEvent("action_card.execute_attempt", {});
    let out;
    try {
      out = await executeActionCard(messageId, metadata.confirmationVersion);
    } catch (err) {
      // "Verify it's you" closed: not a failure; ConfirmDialog stays open as it was.
      if (!isSecondFactorStepUpCancelled(err)) emitEvent("action_card.execute_fail", classifyClientError(err));
      throw err;
    }
    applyMutation(out);
    confirmSucceededRef.current = true;
  }, [applyMutation, emitEvent, messageId, metadata.confirmationVersion]);

  const openForm = useCallback((id: string) => {
    setError(null);
    emitEvent("action_card.open", {});
    setFormId(id);
  }, [emitEvent]);
  const closeForm = useCallback((submitted: boolean) => {
    if (!submitted) emitEvent("action_card.dismiss", {});
    setFormId(null);
  }, [emitEvent]);
  // The sheet shows a failure itself and keeps the values. The server records
  // the attempt, the success and a validation failure; a 409 brings the card
  // as someone else completed it, which the card shows at once.
  // A question card's answer may be sent after its Undo wait (questionSubmitUndo.ts): by then the
  // card may have ended (withdrawn, expired, answered by someone else) or frozen, and the answer is
  // dropped unsent. `leaving`: the page is going away, so a request that outlives it.
  const latestStateRef = useRef(metadata.state);
  latestStateRef.current = metadata.state;
  const submitForm = useCallback(async (submission: ActionCardFormSubmission, options?: { leaving?: boolean }) => {
    if (latestStateRef.current !== "prepared") return { kind: "card_changed" } as const;
    try {
      applyMutation(await (options?.leaving
        ? executeActionCardKeepalive(messageId, metadata.confirmationVersion, submission)
        : executeActionCard(messageId, metadata.confirmationVersion, submission)));
      return null;
    } catch (err) {
      if (isSecondFactorStepUpCancelled(err)) return { kind: "cancelled" } as const;
      const failure = readActionCardFormSubmitFailure(err, formatMessage({ id: "actionCard.executeFailed" }));
      if (failure.kind === "already_executed") applyMutation({ messageId, metadata: failure.metadata });
      return failure;
    }
  }, [applyMutation, formatMessage, messageId, metadata.confirmationVersion]);

  // Raft's own flow for an `open` (feedback_ticket is a link: ActionCardSpecButton).
  const openIntent = useCallback((intent: ActionCardSpecIntent, gate: string | undefined, buttonId: string) => {
    setError(null);
    switch (intent) {
      case "feedback_form":
        openFeedbackDialog();
        return;
      case "upgrade_dialog":
        openUpgradeForCard({ gate: upgradeCardGate(gate), metadata, messageId, currentServerId, emitEvent });
        return;
      case "add_seats":
        // The owner's flow, outside the agent-card funnel: it first asks the server how many seats are short.
        setBusyAction({ buttonId, label: "actionCard.busy.checking" });
        void startAddSeats();
        return;
      case "create_channel":
      case "add_members":
      case "create_agent":
      case "migrate_agent":
        // The dialog of the card's own type, prefilled from its action (on any other type the button is off).
        if (intent === createIntent) openCreateDialog();
        return;
      default:
        // Undeclared intents never reach here: strip made them Open in web.
        return;
    }
  }, [createIntent, currentServerId, emitEvent, messageId, metadata, openCreateDialog, openFeedbackDialog, startAddSeats]);

  // Execute, confirm, forms and the native dialogs change the card; navigating and opening the web never do.
  const canMutate = canOperateCard && !isFrozen && !ended && !busy;
  const describedBy = blockedReasonText ? blockedReasonId : undefined;
  // A connect card's spec has no button: who may grant, and which Connections,
  // is projected for each viewer. So, by its type, the frame mounts the
  // connection picker under the body while the card waits for a grant
  // (prepared: not frozen, not to confirm again, not done or ended) and this
  // viewer may operate it, and draws the card's buttons itself for a viewer who
  // may: Confirm Again when it is due, and on a frozen card the action,
  // disabled, as the other cards keep theirs. A viewer who can't operate it
  // gets none (DS: no buttons without the permission to act).
  const mcpPicker = metadata.state === "prepared" && !isExpired && canOperateCard;
  const reconfirmClick = useCallback(() => { void reconfirm(FRAME_RECONFIRM_ID); }, [reconfirm]);
  // While it runs, the frame's Confirm Again says so, as a spec button does (DS Button, Loading).
  const frameReconfirmBusy = busyAction !== null && (busyAction.buttonId === null || busyAction.buttonId === FRAME_RECONFIRM_ID);
  const openNativeConfirm = nativeConfirm.open;
  const buttonContext = useMemo<ButtonContext>(() => ({
    canMutate, needsReconfirmation, busyAction, describedBy, execute, reconfirm, openConfirm, openForm, openIntent, createIntent, openNativeConfirm, feedbackTicketPath: feedbackTicket?.path ?? null, messageId, channelId,
  }), [busyAction, canMutate, channelId, createIntent, describedBy, execute, feedbackTicket, messageId, needsReconfirmation, openConfirm, openForm, openIntent, openNativeConfirm, reconfirm]);
  // DS: someone who can't act gets no button (the upgrade card and a seat
  // request); the sender's ticket is theirs alone (anyone else reads the
  // result's line on where it went). A question card is answered by the
  // person asked: anyone else reads it with no Answer button (spec §3.1).
  const shownSpec = useMemo(() => withoutButtons(card.spec, (button) => !canOperateCard && (isQuestion
    ? button.action.kind === "open_form" || button.action.kind === "execute"
    : button.action.kind === "open" && (button.action.intent === "upgrade_dialog" || button.action.intent === "add_seats"))), [canOperateCard, card.spec, isQuestion]);
  const renderButton = useCallback(
    (id: string, button: ActionCardRenderedButton) => <ActionCardSpecButton key={id} id={id} button={button} context={buttonContext} />,
    [buttonContext],
  );
  const confirm = confirmId !== null && card.confirms && Object.hasOwn(card.confirms, confirmId) ? card.confirms[confirmId] : null;
  const confirmIsDestructive = confirmId !== null && Object.values(card.spec.elements).some((node) =>
    node.type === "Button" && node.props.emphasis === "destructive" && node.props.action.kind === "execute" && node.props.action.confirm === confirmId);
  const form = formId !== null && card.forms && Object.hasOwn(card.forms, formId) ? card.forms[formId] : null;
  // A paged form and a question card's keep a local draft (question-card spec
  // §5.3, D10) until it is submitted or the card ends: answered, expired,
  // withdrawn, or a state this build doesn't know. Frozen and reconfirm can
  // come back to prepared, so their drafts stay.
  const draftKey = formId !== null && form && (form.steps !== undefined || isQuestion) ? actionCardFormDraftKey(viewerId, messageId, formId) : null;
  const cardEnded = isExecuted || ended || isWithdrawn;
  // Answered on the card (spec §5.9) while it waits for an answer; frozen, it shows them disabled. Confirm Again stays a button.
  const inline = useMemo(() => (isQuestion && !isExecuted && !ended && !needsReconfirmation ? inlineQuestionForm(card) : null),
    [card, ended, isExecuted, isQuestion, needsReconfirmation]);
  const bodySpec = useMemo(() => {
    const body = inline ? withoutInlineQuestions(shownSpec, inline) : shownSpec;
    return mcpAction ? withoutElements(body, (_id, node) => node.type === "Notice" && typeof node.props.text !== "string" && node.props.text.key === STORED_MCP_INSTRUCTION) : body;
  }, [inline, mcpAction, shownSpec]);
  // Done: the result's rows join the body's property list, before the reason,
  // so one list lines up its labels (a question card keeps its answers as its
  // spec lays them out); the rest of the result follows the body.
  const executedTrees = useMemo(() => (isExecuted && shownResult
    ? (isQuestion ? { body: bodySpec, result: shownResult } : withResultRows(bodySpec, shownResult))
    : null), [bodySpec, isExecuted, isQuestion, shownResult]);
  const canAnswer = canOperateCard && metadata.state === "prepared" && !isExpired;
  const Icon = card.icon ? SPEC_ICONS[card.icon] : null;
  const mcpPickerSlot = mcpAction && mcpPicker
    ? <McpConnectCardSlot messageId={messageId} action={mcpAction} onGranted={markExecuted.mcpConnectionGranted} />
    : null;
  // A done card (the frame's `done`, as its status, fold and buttons) shows what came of it, not a failure met
  // before it was done: a refused grant, then a connection authorized elsewhere.
  const errorBanner = error && !done ? <Banner intent="warning" density="sm" className="mt-3">{error}</Banner> : null;

  return (
    <ActionCardServerContext.Provider value={metadata.sourceServerId}>
      <MessageActionCard
        ref={cardRef}
        className="action-card text-left"
        open={open}
        onOpenChange={setReaderOpen}
        data-state={metadata.state}
        data-action-card-spec={card.catalog}
        data-select-screenshot-action-card="true"
      >
        <MessageActionCardHeader>
          {Icon ? <MessageActionCardHeaderIcon data-action-card-icon={card.icon}><Icon /></MessageActionCardHeaderIcon> : null}
          <MessageActionCardHeaderTitle>
            {/* The title is the server's; two lines at most. */}
            <span className="line-clamp-2 break-words" data-action-card-title="">
              <ActionCardRichText value={card.title} />
            </span>
            {headerLine ? (
              <MessageActionCardHeaderDescription id={blockedReasonText && !done && !ended ? blockedReasonId : undefined} data-action-card-status-line="">
                {headerLine}
              </MessageActionCardHeaderDescription>
            ) : null}
          </MessageActionCardHeaderTitle>
          {status ? (
            <MessageActionCardStatus variant={status.variant} data-select-screenshot-action-control="true">
              {status.label}
            </MessageActionCardStatus>
          ) : null}
          {status ? (
            <MessageActionCardCollapseTrigger
              ref={collapseRef}
              aria-label={formatMessage({ id: "actionCard.toggleDetails" })}
              data-select-screenshot-action-control="true"
            />
          ) : null}
        </MessageActionCardHeader>
        <MessageActionCardContent data-select-screenshot-action-detail="true">
          {runsOnTargetServer ? (
            <MessageActionCardNotice>
              {formatMessage({ id: "actionCard.targetServer" }, { server: targetServerName ?? "" })}
            </MessageActionCardNotice>
          ) : null}
          {/* A done or ended card keeps its body as the record, without its buttons; an executed one then shows the result. */}
          <ActionCardSpecRenderer tree={executedTrees?.body ?? bodySpec} renderButton={done || ended ? null : renderButton} fitLabels={inline !== null} />
          {inline ? (
            <QuestionInlineForm
              key={inline.formId}
              inline={inline}
              canSubmit={canAnswer}
              showSubmit={canOperateCard}
              submit={submitForm}
              draftKey={canOperateCard ? actionCardFormDraftKey(viewerId, messageId, inline.formId) : null}
            />
          ) : null}
          {/* A refused grant shows above the picker, where the picker shows its own failures. */}
          {mcpPickerSlot ? errorBanner : null}
          {mcpPickerSlot}
          {mcpAction && canOperateCard && (needsReconfirmation || isFrozen) ? (
            <MessageActionCardActions data-action-card-stack="actions">
              {needsReconfirmation ? (
                <Button
                  type="button"
                  size="md"
                  variant="outline"
                  className="max-w-full"
                  disabled={!canMutate}
                  loading={frameReconfirmBusy}
                  onClick={reconfirmClick}
                  data-action-card-frame-button="reconfirm"
                  data-action-card-busy={frameReconfirmBusy ? "" : undefined}
                >
                  {frameReconfirmBusy && busyAction ? formatMessage({ id: busyAction.label }) : formatMessage({ id: "actionCard.reconfirm" })}
                </Button>
              ) : (
                <Button type="button" size="md" variant="outline" className="max-w-full" disabled data-action-card-frame-button="frozen">
                  {formatMessage({ id: "actionCard.verb.connectMcp" })}
                </Button>
              )}
            </MessageActionCardActions>
          ) : null}
          {executedTrees ? <ActionCardSpecRenderer tree={executedTrees.result} renderButton={renderButton} /> : null}
          <ActionCardContinueSetup metadata={metadata} />
          {mcpPickerSlot ? null : errorBanner}
        </MessageActionCardContent>
      </MessageActionCard>
      {confirm ? (
        <ActionCardSpecConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          destructive={confirmIsDestructive}
          onConfirm={confirmExecute}
          onClose={closeConfirm}
        >
          <div className="flex min-w-0 flex-col gap-2" data-action-card-confirm="">
            <ActionCardSpecRenderer tree={confirm.spec} renderButton={null} />
          </div>
        </ActionCardSpecConfirmDialog>
      ) : null}
      {formId !== null && form ? (
        <ActionCardFormSheet
          key={formId}
          formId={formId}
          form={form}
          // A thread carrier's card belongs to its parent's channel.
          channelId={carrierChannel?.id ?? channelId}
          canSubmit={canAnswer}
          submit={submitForm}
          onClose={closeForm}
          draftKey={draftKey}
          question={isQuestion}
        />
      ) : null}
      {feedbackDialog.dialog}
      {createDialog.dialog}
      {nativeConfirm.dialog}
      {seatFlow.dialogs}
      {cardEnded ? <EndedCardFormDrafts messageId={messageId} /> : null}
    </ActionCardServerContext.Provider>
  );
}

/**
 * An ended card's local form drafts go (store/actionCardFormDrafts.ts): drawn while
 * the card is ended, it clears them once. A card ends without any handler of
 * this viewer's running (someone else answered, it expired, its agent
 * withdrew it), so this follows the state rather than an event.
 */
function EndedCardFormDrafts({ messageId }: { messageId: string }) {
  useEffect(() => clearActionCardFormDrafts(messageId), [messageId]);
  return null;
}

/**
 * What a press started and is still running, and what its button says
 * meanwhile. `buttonId` null: a request the seat flow runs on its own (every
 * changing button shows it).
 */
interface BusyAction {
  buttonId: string | null;
  label: "actionCard.busy.working" | "actionCard.busy.checking" | "actionCard.busy.reconfirming";
}

interface ButtonContext {
  canMutate: boolean;
  needsReconfirmation: boolean;
  busyAction: BusyAction | null;
  describedBy: string | undefined;
  execute: (buttonId: string) => Promise<void>;
  reconfirm: (buttonId: string) => Promise<void>;
  openConfirm: (confirmId: string) => void;
  openForm: (formId: string) => void;
  openIntent: (intent: ActionCardSpecIntent, gate: string | undefined, buttonId: string) => void;
  /** The create dialog this card's type opens (useActionCardCreateDialog); null: none. */
  createIntent: ActionCardCreateDialogIntent | null;
  /** The dialog of the card's permission-granting action (useActionCardNativeConfirm); null: none. */
  openNativeConfirm: (() => void) | null;
  /** The sender's own feedback ticket (feedback_ticket); null: no link. */
  feedbackTicketPath: string | null;
  messageId: string;
  channelId: string;
}

// Primary is the ink-edged default style: the screen's one pink button stays
// the composer's Send.
const BUTTON_VARIANT = { primary: "outline", secondary: "outline", destructive: "danger" } as const;

/**
 * One spec Button: raft-ui Button at the card's `md` size, its label on one
 * line (the full label in a tooltip when it is cut). What it does follows its
 * action; a button that would change the card is disabled while the viewer
 * cannot operate it, while the card is frozen or busy. With the web's
 * capabilities (card.v1, confirm.v1, form.v1, every field and the intents in
 * WEB_ACTION_CARD_SPEC_CAPABILITIES) strip leaves execute, open_form,
 * navigate, open_web and an `open` of one of those intents.
 */
function ActionCardSpecButton({ id, button, context }: { id: string; button: ActionCardRenderedButton; context: ButtonContext }) {
  const { formatMessage } = useIntl();
  const labelRef = useRef<HTMLSpanElement>(null);
  const truncated = useTruncated(labelRef);
  const navigate = useActionCardNavigate();
  const { action } = button;
  const target = action.kind === "navigate" && "target" in action ? action.target : null;
  const targetNavigable = useIsNavigableTarget(target);
  const webHref = useMessageWebHref(context.messageId, context.channelId);
  // The sender's ticket is a link; every other open runs a flow that changes the card.
  const ticket = action.kind === "open" && action.intent === "feedback_ticket";
  const mutating = action.kind === "execute" || action.kind === "open_form" || (action.kind === "open" && !ticket);
  // A card that needs confirming again turns its action into Confirm Again.
  const reconfirms = mutating && context.needsReconfirmation;
  // A button this build can't run, on the web: Reload, never a link to this same message (Q8: actionCardUnrunnableOpensInWeb).
  const reloads = action.kind === "open_web" && !actionCardUnrunnableOpensInWeb();
  const specLabel = useActionCardMsgText(button.label);
  // The pressed button says what it is doing while it waits (DS Button, Loading).
  const busyAction = context.busyAction;
  const pressedBusy = mutating && busyAction !== null && (busyAction.buttonId === null || busyAction.buttonId === id);
  const label = pressedBusy
    ? formatMessage({ id: busyAction.label })
    : reloads ? formatMessage({ id: "actionCard.reloadToRun.button" }) : reconfirms ? formatMessage({ id: "actionCard.reconfirm" }) : specLabel;
  const reasonId = button.disabledReason ? `${context.describedBy ?? `action-card-${context.messageId}`}-${id}-reason` : undefined;
  const reloadNoteId = reloads && !button.disabledReason ? `action-card-${context.messageId}-${id}-reload` : undefined;
  const describedBy = [mutating ? context.describedBy : undefined, reasonId, reloadNoteId].filter(Boolean).join(" ") || undefined;
  const common = {
    type: "button" as const,
    size: "md" as const,
    variant: BUTTON_VARIANT[button.emphasis],
    className: "max-w-full",
    "aria-describedby": describedBy,
    "data-action-card-button": action.kind,
    "data-action-card-emphasis": button.emphasis,
  };
  const labelSpan = <span ref={labelRef} className="min-w-0 truncate" data-action-card-button-label="">{label}</span>;

  let control: ReactElement;
  let controlDisabled: boolean;
  // Links: a public URL outside Raft, or on desktop "Open in web": strip's button this build cannot run.
  const url = action.kind === "navigate" && "url" in action ? action.url : null;
  if (ticket) {
    // The sender's ticket in Settings, through the app (shown only with a path: the frame hides it otherwise).
    const path = context.feedbackTicketPath;
    controlDisabled = Boolean(button.disabledReason) || path === null;
    control = controlDisabled || path === null
      ? <Button {...common} disabled>{labelSpan}</Button>
      : <Button {...common} nativeButton={false} role="link" render={<Link to={path} />}>{labelSpan}</Button>;
  } else if (reloads) {
    controlDisabled = Boolean(button.disabledReason);
    control = <Button {...common} disabled={controlDisabled} onClick={actionCardReload.page} data-action-card-reload="">{labelSpan}</Button>;
  } else if (url !== null || action.kind === "open_web") {
    const href = url !== null ? appLinkOpenHref(url) : webHref;
    const domain = url !== null ? appLinkDomain(url) : null;
    controlDisabled = Boolean(button.disabledReason) || href === null;
    control = controlDisabled || href === null ? (
      <Button {...common} disabled>{labelSpan}</Button>
    ) : (
      <Button {...common} nativeButton={false} role="link" render={<a href={href} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, domain ? `${label} ${domain}` : label)} />}>
        {labelSpan}
        {/* Where it goes, after the label, as link previews show it: the end of the host is never cut. */}
        {domain ? <span className={`max-w-32 shrink font-sans text-footnote font-normal text-foreground-muted ${KEEP_END}`} data-action-card-button-domain=""><KeptEnd text={domain} /></span> : null}
        <LeavingRaftMark data-icon="inline-end" />
      </Button>
    );
  } else {
    let onClick: (() => void) | undefined;
    let disabled = Boolean(button.disabledReason);
    switch (action.kind) {
      // Dispatch: on a card whose action grants permissions, every press that would run it opens that
      // action's own dialog, by the card's action key, never the generic confirm or a bare execute (the
      // rule, for this and every future such action: useActionCardNativeConfirm).
      case "execute": {
        const confirmId = action.confirm;
        disabled ||= !context.canMutate;
        onClick = reconfirms
          ? () => void context.reconfirm(id)
          : context.openNativeConfirm ?? (confirmId !== undefined ? () => context.openConfirm(confirmId) : () => void context.execute(id));
        break;
      }
      case "open_form": {
        const formId = action.form;
        disabled ||= !context.canMutate;
        onClick = reconfirms ? () => void context.reconfirm(id) : context.openNativeConfirm ?? (() => context.openForm(formId));
        break;
      }
      case "navigate":
        disabled ||= !target || !targetNavigable;
        onClick = target ? () => navigate.toTarget(target) : undefined;
        break;
      case "open": {
        const { intent, gate } = action;
        // A create dialog prefills from the card's action: a card of another type has nothing to open it with.
        disabled ||= !context.canMutate || (isActionCardCreateDialogIntent(intent) && intent !== context.createIntent);
        onClick = reconfirms ? () => void context.reconfirm(id) : () => context.openIntent(intent, gate, id);
        break;
      }
      default:
        disabled = true;
    }
    controlDisabled = disabled;
    control = (
      <Button {...common} disabled={disabled} loading={pressedBusy} data-action-card-busy={pressedBusy ? "" : undefined} onClick={onClick}>
        {labelSpan}
      </Button>
    );
  }

  return (
    <>
      {button.disabledReason ? (
        <MessageActionCardActionsNote id={reasonId}><ActionCardPlainText value={button.disabledReason} /></MessageActionCardActionsNote>
      ) : null}
      {reloadNoteId ? <MessageActionCardActionsNote id={reloadNoteId}>{formatMessage({ id: "actionCard.reloadToRun.note" })}</MessageActionCardActionsNote> : null}
      {/* A disabled native button gets no pointer events, so its tooltip hangs on a wrapper. */}
      <Tooltip content={label} disabled={!truncated}>
        {controlDisabled ? <span className="inline-flex max-w-full" data-action-card-button-tooltip="">{control}</span> : control}
      </Tooltip>
    </>
  );
}

/** This message on the web, for "Open in web": its permalink, in its thread when it is a reply there. */
function useMessageWebHref(messageId: string, channelId: string): string | null {
  const serverSlug = useServerStore((state) => state.current?.slug);
  const inOpenThread = useThreadStore((state) => state.openThreadChannelId === channelId);
  const parentChannelId = useThreadStore((state) => state.openParentChannelId);
  const parentMessageId = useThreadStore((state) => state.openParentMessageId);
  const linkChannelId = inOpenThread && parentChannelId ? parentChannelId : channelId;
  const isDm = useChannelStore((state) => state.dmChannels.some((channel) => channel.id === linkChannelId));
  if (!serverSlug) return null;
  return buildMessagePermalink(serverSlug, linkChannelId, messageId, {
    routeKind: isDm ? "dm" : "channel",
    threadParentMessageId: inOpenThread ? parentMessageId : null,
  });
}
