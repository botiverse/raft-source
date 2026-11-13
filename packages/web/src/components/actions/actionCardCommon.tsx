// What the action card frame reads from `actionMetadata` alone, beside the
// spec that draws its body (ActionCardSpecCard.tsx): who may operate the card,
// the /api/actions mutations, the product-funnel events and the "Committed by"
// line (also on the view-only card with no spec, ActionCard.tsx).

import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  ACTION_CARD_ALREADY_EXECUTED_ERROR_CODE,
  ACTION_CARD_ALREADY_EXECUTED_STATUS,
  ACTION_CARD_FORM_INVALID_ERROR_CODE,
  ACTION_CARD_FORM_INVALID_STATUS,
  ACTION_CARD_TYPES_WITHOUT_AUTHORITY,
  isActionCardReadOnlyInServer,
} from "@botiverse/raft-shared";
import type {
  ActionCardAlreadyExecutedBody,
  ActionCardFormInvalidBody,
  ActionCardFormIssue,
  ActionCardFormSubmission,
  ActionCardMetadata,
  ActionCardState,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import { markAgentFeedbackSent } from "../../feedback/agentFeedbackSentFlag";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useMessageStore } from "../../store/messageStore";
import { withSecondFactorStepUp } from "../settings/secondFactorStepUp";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { canViewAgentPrivateSurfaces } from "../../utils/agentVisibility";
import { questionAddresseeId, useQuestionAddresseeName } from "./questionCardAddressee";

/**
 * The states this build draws. States are additive: a card in one it doesn't
 * know (the server added it later) has ended as far as this build can tell,
 * so the spec card shows it view-only and folded, with nothing to press (as
 * the view-only card with no spec shows any card).
 */
const KNOWN_CARD_STATES: readonly ActionCardState[] = ["prepared", "executed", "frozen", "reconfirm_required", "expired"];

/** Whether a card is in a state this build doesn't know (a card stored without one is prepared, as the server reads it). */
export function isUnknownActionCardState(state: ActionCardState | undefined): boolean {
  return Boolean(state) && !KNOWN_CARD_STATES.includes(state!);
}

export interface ActionCardMutationResponse {
  messageId: string;
  metadata: ActionCardMetadata;
}

// Product-funnel event types a card is allowed to emit. Mirrors the
// server-side `CLIENT_EVENT_TYPES` whitelist in routes/actions.ts. Server
// rejects anything else; DB check constraint is the second line of defense.
//
// Note: `action_card.execute_success` is intentionally NOT here — server-
// only per Dozy guardrail (#proj-permission:13b42cc0 msg=a1dbc464). Funnel
// "successes" must come from the server-authoritative path (executeActionCard
// or markActionCardExecuted) so a client can't manufacture them.
export type ActionCardClientEventType =
  | "action_card.open"
  | "action_card.dismiss"
  | "action_card.execute_attempt"
  | "action_card.execute_fail";

export type ActionCardErrorClass =
  | "validation"
  | "permission"
  | "not_found"
  | "conflict"
  | "network"
  | "unknown";

export interface ActionCardDismissMetadata {
  dismiss_reason?: "close_button" | "esc" | "backdrop" | "route_change";
}

// `OpenMetadata` and `AttemptMetadata` are intentionally empty: server
// derives `action_type` from the validated card row, so client-side
// hints would be ignored anyway.
export type ActionCardEventMetadata =
  | Record<string, never>
  | ActionCardDismissMetadata
  | ActionCardFailMetadata;

export interface ActionCardFailMetadata {
  error_class?: ActionCardErrorClass;
  error_code?: string;
  http_status?: number;
}

/**
 * Coarse client-side classifier mirroring server `classifyExecuteError`.
 * Used for `execute_fail` events emitted by the dialog-driven path. Only
 * returns categorical buckets — never raw caught text. Matches the
 * server's enum so SQL groups consistently across both emit paths.
 */
export function classifyClientError(err: unknown): ActionCardFailMetadata {
  const e = err as
    | { response?: { status?: number; data?: { error?: string; code?: string } }; code?: string; message?: string }
    | null;
  if (!e || typeof e !== "object") return { error_class: "unknown" };

  const status = e.response?.status;
  const code = e.response?.data?.code ?? (typeof e.code === "string" ? e.code : undefined);
  const out: ActionCardFailMetadata = { error_class: "unknown" };
  if (typeof status === "number") out.http_status = status;
  if (typeof code === "string" && code.length > 0 && code.length <= 64) out.error_code = code;

  if (status === 400) out.error_class = "validation";
  else if (status === 401 || status === 403) out.error_class = "permission";
  else if (status === 404) out.error_class = "not_found";
  else if (status === 409) out.error_class = "conflict";
  else if (status === undefined && (e.code === "ERR_NETWORK" || /network/i.test(String(e.message ?? "")))) {
    out.error_class = "network";
  }
  return out;
}

/**
 * Best-effort: emit a product-funnel event for a card (by its message).
 * Failures are swallowed here just like on the server side — a wobbly funnel
 * must never block the underlying user action. The server validates the card
 * + access and re-derives `action_type` from the canonical card row, so the
 * metadata passed here is intentionally minimal.
 */
export function emitActionCardEvent(messageId: string, eventType: ActionCardClientEventType, payload?: ActionCardEventMetadata): void {
  api
    .post(`/actions/${messageId}/event`, { eventType, metadata: payload ?? {} })
    .catch((err) => {
      // Silent: the funnel is best-effort.
      console.debug("[actionCard] event emit failed:", eventType, err);
    });
}

/**
 * `emitActionCardEvent` bound to one card. The funnel is the cards agents
 * prepare: a person's card (`requesterUserId`) sends nothing (the server
 * records nothing for one either).
 */
export function useActionCardEvents(messageId: string, metadata: Pick<ActionCardMetadata, "requesterUserId">) {
  const personCard = Boolean(metadata.requesterUserId);
  return useCallback(
    (eventType: ActionCardClientEventType, payload?: ActionCardEventMetadata): void => {
      if (!personCard) emitActionCardEvent(messageId, eventType, payload);
    },
    [messageId, personCard],
  );
}

/**
 * Applies a mutation response to the message store. The server also emits
 * `message:updated`, but applying the response keeps the clicked card in sync
 * even if realtime delivery lags or is missed.
 */
export function useApplyActionCardMutation(channelId: string) {
  return useCallback(
    (out: ActionCardMutationResponse): void => {
      useMessageStore.getState().updateMessage({ id: out.messageId, channelId, actionMetadata: out.metadata });
    },
    [channelId],
  );
}

/**
 * Executes the prepared action, under the card's optimistic version; a form
 * card sends its form's values with it (form.v1). A card whose kind needs a
 * second factor (approver or step_up) is refused with 403
 * `second_factor_step_up_required` before anything happens: "Verify it's you"
 * opens and the execute goes once more. Closing it rejects with
 * SecondFactorStepUpCancelled, which callers treat as nothing happened.
 */
export async function executeActionCard(
  messageId: string,
  confirmationVersion: number | undefined,
  form?: ActionCardFormSubmission,
): Promise<ActionCardMutationResponse> {
  const { data } = await withSecondFactorStepUp(
    () => api.post<ActionCardMutationResponse>(
      `/actions/${messageId}/execute`,
      { expectedState: "prepared", expectedConfirmationVersion: confirmationVersion, ...(form ? { form } : {}) },
    ),
    "actionCard",
  );
  // A feedback card sent through its form sheet: the inbox stops suggesting
  // an agent's draft (FeedbackAgentHint). Its native dialog marks it too.
  if (data.metadata?.state === "executed" && data.metadata.action?.type === "feedback:submit") {
    markAgentFeedbackSent(useAuthStore.getState().user?.id);
  }
  return data;
}

/**
 * Why a form submission failed, from execute's error body (form.v1): 422
 * FORM_INVALID with its issues, 409 ALREADY_EXECUTED with the card as it is
 * now, or anything else (a refusal, the network) as a sentence.
 */
export type ActionCardFormSubmitFailure =
  | { kind: "invalid"; issues: ActionCardFormIssue[] }
  // "Verify it's you" closed: nothing was sent through, the sheet stays as it was.
  | { kind: "cancelled" }
  // A question card's answer that waited for an Undo while the card changed (ended, froze): not sent.
  | { kind: "card_changed" }
  | { kind: "already_executed"; metadata: ActionCardMetadata }
  | { kind: "failed"; message: string };

export function readActionCardFormSubmitFailure(err: unknown, fallback: string): ActionCardFormSubmitFailure {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  // The error body, untrusted: each branch checks the fields it reads.
  const data = response?.data as Partial<Omit<ActionCardFormInvalidBody, "errorCode"> & Omit<ActionCardAlreadyExecutedBody, "errorCode"> & { errorCode: string }> | undefined;
  if (response?.status === ACTION_CARD_FORM_INVALID_STATUS && data?.errorCode === ACTION_CARD_FORM_INVALID_ERROR_CODE && Array.isArray(data.issues)) {
    return { kind: "invalid", issues: data.issues };
  }
  if (response?.status === ACTION_CARD_ALREADY_EXECUTED_STATUS && data?.errorCode === ACTION_CARD_ALREADY_EXECUTED_ERROR_CODE && data.metadata) {
    return { kind: "already_executed", metadata: data.metadata };
  }
  return { kind: "failed", message: actionCardErrorText(err, fallback) };
}

/** Confirms a `reconfirm_required` card again. */
export async function reconfirmActionCard(messageId: string): Promise<ActionCardMutationResponse> {
  const { data } = await api.post<ActionCardMutationResponse>(`/actions/${messageId}/reconfirm`);
  return data;
}

/** The server's error sentence for a failed mutation, else `fallback`. */
export function actionCardErrorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | null;
  return e?.response?.data?.error ?? e?.message ?? fallback;
}

/**
 * Whether this viewer may operate the card, and why not. Read-only when the
 * card belongs to another server (a joint projection), else blocked in an
 * archived channel, for a guest outside its own channel, outside the channel, or without the
 * capability the action's type needs, whoever asked for it (an agent or a
 * person): agent:create takes Create Agents, agent:migrate its Agent's
 * creator or Migrate Agents (a personal assistant: its owner), as the
 * migration route does, a seat request (seats:add) an owner who manages billing; a question card asked of one person
 * (`question:ask`, addressee `user`) is theirs alone to answer, everyone else
 * waits for them (question-card spec §3.1; the server answers anyone else 403
 * NOT_ADDRESSEE); and whoever sent the card doesn't answer it. Display only:
 * the server checks again on every mutation, visibility first.
 */
export function useActionCardAccess({ messageId, metadata, channelId, parentChannelId }: {
  messageId: string;
  metadata: ActionCardMetadata;
  channelId: string;
  /** The channel the carrier conversation hangs off, as the surface drawing it knows it (a thread's or a task
   *  conversation's parent channel; a channel's own id). */
  parentChannelId?: string;
}) {
  const { formatMessage } = useIntl();
  // Whose membership decides, as the server's channelService.getChannelMembershipAuthorityChannelId: a thread's or a
  // task conversation's parent channel (a task conversation is its own channel, never in the store), else the
  // carrier's own channel. Unknown to the store: blocked, below.
  const authorityChannelId = useThreadStore((state) =>
    parentChannelId && parentChannelId !== channelId
      ? parentChannelId
      : state.openThreadChannelId === channelId ? state.openParentChannelId : channelId
  );
  const carrierChannel = useChannelStore((state) =>
    findStoredChannel(state, authorityChannelId)
  );
  const currentServerId = useServerStore((state) => state.current?.id);
  const currentServerName = useServerStore((state) => state.current?.name);
  const currentServerRole = useServerStore((state) => state.current?.role);
  const { capabilities, role } = useServerPermissions();
  const viewerId = useAuthStore((state) => state.user?.id);
  const addresseeId = questionAddresseeId(metadata);
  const addresseeName = useQuestionAddresseeName(metadata);
  const sourceReadOnly = isActionCardReadOnlyInServer(metadata.sourceServerId, currentServerId);
  // A migrate card's Agent, as this viewer's store has it (the migration route's rule: actionCardAuthority's `agent`).
  const migrateAgentId = metadata.action.type === "agent:migrate" ? metadata.action.agentId ?? null : null;
  const migrateAgent = useAgentStore((state) => (migrateAgentId
    ? state.agents.find((agent) => agent.id.toLowerCase() === migrateAgentId.toLowerCase() && !agent.deletedAt) ?? null
    : null));
  const canMigrateAgent = migrateAgent !== null && (migrateAgent.assistantOwnerUserId
    ? migrateAgent.assistantOwnerUserId === viewerId
    : canViewAgentPrivateSurfaces(migrateAgent, viewerId, capabilities.migrateAgents));
  // Joint carriers are shared with peer servers; the action always runs on
  // the card's target server (fixed at prepare time), never the viewer's.
  const targetServerName = metadata.targetServerName ?? null;
  const blockedReason = sourceReadOnly
    ? targetServerName
      ? { id: "actionCard.blocked.targetServer" as const }
      : { id: "actionCard.blocked.sourceWorkspace" as const }
    : carrierChannel?.archivedAt
    ? { id: "actionCard.blocked.archived" as const }
    // A Guest runs cards in its own channel by its own permissions (matrix
    // §1): only the types the shared authority table marks `none`, as a Guest
    // holds no server capability; it never joins another channel.
    : currentServerRole === "guest"
        && (carrierChannel?.joined !== true || !ACTION_CARD_TYPES_WITHOUT_AUTHORITY.has(metadata.action.type))
      ? { id: "actionCard.blocked.guest" as const }
      : !carrierChannel || (
          currentServerRole !== "owner"
          && currentServerRole !== "admin"
          && carrierChannel.type !== "dm"
          && carrierChannel.joined !== true
        )
        ? { id: "actionCard.blocked.notMember" as const }
        : metadata.action.type === "agent:create" && !capabilities.createAgents
          ? { id: "actionCard.blocked.needCreateAgents" as const }
          : metadata.action.type === "agent:migrate" && !canMigrateAgent
            ? { id: "actionCard.blocked.needMigrateAgents" as const }
          : metadata.action.type === "seats:add" && !(role === "owner" && capabilities.manageBilling)
            ? { id: "actionCard.blocked.ownerOnly" as const }
            // Asked of someone else: the person asked answers, by their id (never the handle the agent wrote).
            : addresseeId && addresseeId !== viewerId?.toLowerCase()
              ? { id: "actionCard.question.waiting" as const }
            // Whoever sent a card doesn't answer it (an agent never runs its own).
            : metadata.requesterUserId && metadata.requesterUserId === viewerId
              ? { id: "actionCard.blocked.ownRequest" as const }
              : null;
  const blockedReasonText = blockedReason?.id === "actionCard.blocked.targetServer"
    ? formatMessage({ id: blockedReason.id }, { server: targetServerName ?? "" })
    : blockedReason?.id === "actionCard.blocked.notMember"
    ? formatMessage(
        { id: blockedReason.id },
        { channel: carrierChannel?.name ?? formatMessage({ id: "actionCard.title.channelFallback" }) },
      )
    : blockedReason?.id === "actionCard.question.waiting"
    ? formatMessage({ id: blockedReason.id }, { person: addresseeName ?? "" })
    : blockedReason?.id === "actionCard.blocked.needMigrateAgents"
    ? formatMessage(
        { id: blockedReason.id },
        { agent: migrateAgent ? migrateAgent.displayName || migrateAgent.name : formatMessage({ id: "message.author.agentFallback" }) },
      )
    : blockedReason
      ? formatMessage({ id: blockedReason.id })
      : null;
  return {
    carrierChannel,
    currentServerId,
    currentServerName,
    sourceReadOnly,
    targetServerName,
    canOperateCard: blockedReason === null,
    blockedReasonText,
    blockedReasonId: `action-card-blocked-${messageId}`,
    runsOnTargetServer: Boolean(targetServerName && carrierChannel?.type === "joint"),
  };
}

/**
 * "Committed by <user> · <time>" on a done card, with a spec or not (DS
 * `.rf-action__done`): the name in ink, the time in Space Mono. A question
 * card says "Answered by <user>" (question-card spec §8).
 */
export function CommittedByLine({ metadata }: { metadata: ActionCardMetadata }) {
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  if (!metadata.executedByUserName) return null;
  const executedTime = metadata.executedAt ? formatMessageTime(metadata.executedAt) : "";
  return (
    <>
      {formatMessage(
        { id: metadata.action.type === "question:ask" ? "actionCard.question.answeredBy" : "actionCard.committedBy" },
        {
          user: metadata.executedByUserName,
          n: (c: ReactNode) => <span key="n" className="font-semibold text-foreground">{c}</span>,
        },
      )}
      {executedTime ? (
        <time
          dateTime={metadata.executedAt ?? undefined}
          className="font-mono text-mono-meta before:mx-1 before:content-['·']"
        >
          {executedTime}
        </time>
      ) : null}
    </>
  );
}
