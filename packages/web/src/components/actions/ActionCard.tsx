// Action card — rendered inline as the body of a regular agent message
// row when the message's `actionMetadata.kind === "action-card"`. The
// agent prepared the form; the human admin clicks the action verb button
// to commit it under their own identity.
//
// Per stdrc 2026-05-10 #proj-approval msg=cb1aa609 + msg=7d662135: the
// card stays a *summary* — agent-prefilled fields shown as readonly
// labels, plus the action verb button. We deliberately do NOT inline the
// rest of the create-form on the card (overcrowds the message row); the
// dialog is the place to fill remaining fields. v1 simply fires the
// execute endpoint with the agent's prefilled action; v2 will open the
// existing modal dialog in prefilled mode if any required fields are
// still missing.

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { Check } from "lucide-react";
import { Badge } from "raft-ui";
import type {
  ActionCardAction,
  ActionCardMetadata,
  ActionCardResult,
} from "@botiverse/raft-shared";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useChannelStore } from "../../store/channelStore";
import { useThreadStore } from "../../store/threadStore";
import { useMachineStore } from "../../store/machineStore";
import { useMessageStore } from "../../store/messageStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import Banner from "../ui/Banner";
import CreateAgentDialog from "../agent/CreateAgentDialog";
import CreateChannelDialog from "../channel/CreateChannelDialog";
import AddMembersDialog from "../channel/AddMembersDialog";
import api from "../../api/client";
import {
  AGENT_INBOUND_CANNOT_SUMMARY_ID,
  OAUTH_SCOPE_PRESENTATION,
  hasAgentInboundOAuthScope,
  normalizeVisibleOAuthScopes,
} from "../../lib/oauthScopePresentation";

// Product-funnel event types this component is allowed to emit. Mirrors the
// server-side `CLIENT_EVENT_TYPES` whitelist in routes/actions.ts. Server
// rejects anything else; DB check constraint is the second line of defense.
//
// Note: `action_card.execute_success` is intentionally NOT here — server-
// only per Dozy guardrail (#proj-permission:13b42cc0 msg=a1dbc464). Funnel
// "successes" must come from the server-authoritative path (executeActionCard
// or markActionCardExecuted) so a client can't manufacture them.
type ClientEventType =
  | "action_card.open"
  | "action_card.dismiss"
  | "action_card.execute_attempt"
  | "action_card.execute_fail";

type ActionCardErrorClass =
  | "validation"
  | "permission"
  | "not_found"
  | "conflict"
  | "network"
  | "unknown";

interface DismissMetadata {
  dismiss_reason?: "close_button" | "esc" | "backdrop" | "route_change";
}

// `OpenMetadata` and `AttemptMetadata` are intentionally empty: server
// derives `action_type` from the validated card row, so client-side
// hints would be ignored anyway.
type OpenMetadata = Record<string, never>;
type AttemptMetadata = Record<string, never>;

interface FailMetadata {
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
function classifyClientError(err: unknown): FailMetadata {
  const e = err as
    | { response?: { status?: number; data?: { error?: string; code?: string } }; code?: string; message?: string }
    | null;
  if (!e || typeof e !== "object") return { error_class: "unknown" };

  const status = e.response?.status;
  const code = e.response?.data?.code ?? (typeof e.code === "string" ? e.code : undefined);
  const out: FailMetadata = { error_class: "unknown" };
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

function ActionScopeList({ scopes, agentName }: { scopes: readonly string[]; agentName?: string }) {
  const { formatMessage } = useIntl();
  const visibleScopes = normalizeVisibleOAuthScopes(scopes);
  if (visibleScopes.length === 0) {
    return <span className="text-black/75">{scopes.length > 0 ? scopes.join(", ") : "-"}</span>;
  }
  return (
    <div className="mt-1 space-y-1.5">
      {visibleScopes.map((scope) => {
        const detail = OAUTH_SCOPE_PRESENTATION[scope];
        return (
          <div key={scope} className="border border-black/15 bg-white p-1.5">
            <div className="break-all font-mono text-[11px] font-bold text-black/55">{scope}</div>
            <div className="text-black/60">{formatMessage({ id: detail.copyId })}</div>
          </div>
        );
      })}
      {agentName && hasAgentInboundOAuthScope(visibleScopes) ? (
        <div className="font-bold text-black/70">
          {formatMessage({ id: "actionCard.willSendTo" }, { agent: agentName })}
        </div>
      ) : null}
      {hasAgentInboundOAuthScope(visibleScopes) ? (
        <div className="border border-black/15 bg-soft-signal/15 p-1.5 font-bold text-black/65">
          {formatMessage({ id: AGENT_INBOUND_CANNOT_SUMMARY_ID })}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  messageId: string;
  metadata: ActionCardMetadata;
  /** Channel of the carrier message. Thread carriers resolve authority from
   *  their parent channel, matching the server writer. */
  channelId: string;
}

interface ActionCardMutationResponse {
  messageId: string;
  metadata: ActionCardMetadata;
}

export function ActionCard({ messageId, metadata, channelId }: Props) {
  const { formatMessage } = useIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [addMembersDialogOpen, setAddMembersDialogOpen] = useState(false);
  // Suppress `dismiss` emit when the dialog closes after a successful
  // submit. Dialogs call `onCreated`/`onSubmitted` then `onClose`; flagging
  // success in the success handler lets the close handler tell the
  // difference between "user closed" and "dialog auto-closed after submit".
  const submitSucceededRef = useRef(false);
  const authorityChannelId = useThreadStore((state) =>
    state.openThreadChannelId === channelId ? state.openParentChannelId : channelId
  );
  const carrierChannel = useChannelStore((state) =>
    state.channels.find((channel) => channel.id === authorityChannelId)
      ?? state.dmChannels.find((channel) => channel.id === authorityChannelId)
  );
  const currentServerRole = useServerStore((state) => state.current?.role);
  const { capabilities } = useServerPermissions();
  const action = metadata.action;
  const blockedReason = carrierChannel?.archivedAt
    ? { id: "actionCard.blocked.archived" as const }
    : currentServerRole === "guest"
      ? { id: "actionCard.blocked.guest" as const }
      : !carrierChannel || (
          currentServerRole !== "owner"
          && currentServerRole !== "admin"
          && carrierChannel.type !== "dm"
          && carrierChannel.joined !== true
        )
        ? { id: "actionCard.blocked.notMember" as const }
        : action.type === "agent:create" && !capabilities.createAgents
          ? { id: "actionCard.blocked.needCreateAgents" as const }
          : null;
  const canOperateCard = blockedReason === null;
  const blockedReasonId = `action-card-blocked-${messageId}`;
  const blockedReasonText = blockedReason?.id === "actionCard.blocked.notMember"
    ? formatMessage(
        { id: blockedReason.id },
        { channel: carrierChannel?.name ?? formatMessage({ id: "actionCard.title.channelFallback" }) },
      )
    : blockedReason
      ? formatMessage({ id: blockedReason.id })
      : null;

  // Render directly from the `metadata` prop. The server emits
  // `message:updated` from `markActionCardExecuted` (actionCardsService.ts),
  // MainLayout's socket handler dispatches `messageStore.updateMessage`, and
  // the merged `actionMetadata` flows back down here. A local
  // `useState(metadata)` mirror would freeze on first mount and then ignore
  // every subsequent prop change — the classic derived-state anti-pattern.
  const isExecuted = metadata.state === "executed";

  // Best-effort: emit a product-funnel event for this card. Failures are
  // swallowed here just like on the server side — a wobbly funnel must
  // never block the underlying user action. The server validates the card
  // + access and re-derives `action_type` from the canonical card row, so
  // the metadata we pass here is intentionally minimal.
  function emitEvent(
    eventType: ClientEventType,
    payload?: OpenMetadata | DismissMetadata | AttemptMetadata | FailMetadata,
  ): void {
    api
      .post(`/actions/${messageId}/event`, {
        eventType,
        metadata: payload ?? {},
      })
      .catch((err) => {
        // Silent: the funnel is best-effort.
        console.debug("[actionCard] event emit failed:", eventType, err);
      });
  }

  function applyActionCardMutation(out: ActionCardMutationResponse): void {
    useMessageStore.getState().updateMessage({
      id: out.messageId,
      channelId,
      actionMetadata: out.metadata,
    });
  }

  // Dialog-backed cards keep the stdrc 2026-05-10 #proj-approval contract:
  // open the regular user-facing dialog with editable prefilled values, then
  // mark the card executed only after the normal API succeeds. Owner-commit
  // cards below execute server-side because the commit itself is the action.
  function handleClick() {
    setError(null);
    submitSucceededRef.current = false;
    if (
      action.type === "integration:approve_agent_login"
      || action.type === "integration:install_marketplace_app"
      || action.type === "integration:register_app"
      || action.type === "integration:update_app_registration"
      || action.type === "integration:recover_app_owner"
    ) {
      void executeInlineAction();
      return;
    }
    // Funnel hook: human opened the dialog. Emit before opening so a stuck
    // dialog doesn't lose the signal. Best-effort; swallowed on failure.
    // No metadata — server derives `action_type` from the card row.
    emitEvent("action_card.open", {});
    switch (action.type) {
      case "channel:create":
        setChannelDialogOpen(true);
        return;
      case "agent:create":
        setAgentDialogOpen(true);
        return;
      case "channel:add_member":
        setAddMembersDialogOpen(true);
        return;
    }
  }

  async function executeInlineAction() {
    setBusy(true);
    try {
      const { data } = await api.post<ActionCardMutationResponse>(
        `/actions/${messageId}/execute`,
        { expectedState: "prepared" },
      );
      // Server also emits message:updated, but applying the response keeps
      // the clicked card in sync even if realtime delivery lags or is missed.
      applyActionCardMutation(data);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } }; message?: string } | null;
      setError(e?.response?.data?.error ?? e?.message ?? formatMessage({ id: "actionCard.executeFailed" }));
    } finally {
      setBusy(false);
    }
  }

  // Funnel hook: dialog closed without a successful submit. The
  // `submitSucceededRef` flag is set in onCreated/onSubmitted handlers
  // before the dialog calls onClose, so we can distinguish "user dismissed"
  // from "dialog auto-closed after success". v1 doesn't distinguish
  // close-button / ESC / backdrop on the FE — all collapse to a single
  // dismiss without a `dismiss_reason`. Adding that resolution is a
  // follow-up.
  function handleDialogClose(closeFn: () => void) {
    return () => {
      if (!submitSucceededRef.current) {
        // No metadata — server derives `action_type` from the card row.
        // dismiss_reason omitted in v1 (FE doesn't distinguish X / ESC /
        // backdrop yet). Adding that resolution is a follow-up.
        emitEvent("action_card.dismiss", {});
      }
      submitSucceededRef.current = false;
      closeFn();
    };
  }

  // Funnel hooks for the dialog-driven submit lifecycle. The dialogs run
  // their own create API and may fail before mark-executed is reached,
  // which the server can't observe. We emit:
  //   - `execute_attempt` when the dialog actually starts the create call
  //     (after client-side validation passed).
  //   - `execute_fail` when the dialog's create API throws. The dialog
  //     stays open for retry; on a successful retry, the corresponding
  //     `execute_success` will arrive server-side via mark-executed.
  // Per Dozy guardrail msg=a1dbc464: client may NOT emit `execute_success`.
  function handleSubmitStart() {
    emitEvent("action_card.execute_attempt", {});
  }

  function handleSubmitError(err: unknown) {
    emitEvent("action_card.execute_fail", classifyClientError(err));
  }

  async function markExecuted(result: ActionCardResult) {
    try {
      const { data } = await api.post<ActionCardMutationResponse>(
        `/actions/${messageId}/mark-executed`,
        { result },
      );
      // The socket update is still useful for other tabs/clients; the local
      // response closes the stale-button window on this tab immediately.
      applyActionCardMutation(data);
    } catch (err) {
      // Don't surface mark-executed failure — the resource is already
      // created. Worst case the card stays "prepared" until refresh.
      console.error("Failed to mark action card executed:", err);
      // Funnel hook: dialog-driven `execute_fail` for the mark-executed leg.
      // The create dialog already emitted `execute_attempt` via
      // `handleSubmitStart`; if mark-executed sync fails the submit's funnel
      // outcome would otherwise stop at `execute_attempt` with no terminal
      // event. Per Leiysky/Dozy/meichen review 2026-05-13 (msg=5cb29566 /
      // msg=e2d25035 / DM e270834b): emit `execute_fail` here too, reusing
      // the same client classifier. `execute_success` stays server-only —
      // when mark-executed succeeds the server emits it via the canonical
      // `markActionCardExecuted` path, so this client branch only needs the
      // failure leg.
      handleSubmitError(err);
    }
  }

  function handleAgentCreated(agent: { id: string; name: string }) {
    submitSucceededRef.current = true;
    void markExecuted({ kind: "agent", id: agent.id, name: agent.name });
  }

  function handleChannelCreated(channel: { id: string; name: string }) {
    submitSucceededRef.current = true;
    void markExecuted({ kind: "channel", id: channel.id, name: channel.name });
  }

  function handleMembersAdded(result: {
    channelId: string;
    channelName: string;
    addedHumanIds: string[];
    addedAgentIds: string[];
  }) {
    submitSucceededRef.current = true;
    void markExecuted({
      kind: "channel-members",
      channelId: result.channelId,
      channelName: result.channelName,
      addedHumanIds: result.addedHumanIds,
      addedAgentIds: result.addedAgentIds,
    });
  }

  return (
    <div className="action-card relative mt-1 flex w-full items-start gap-3 border-2 border-black/30 bg-white p-3 text-left">
      <div className="min-w-0 flex-1">
        {/* Bold action title with optional Done pill on the right. */}
        <div className="flex flex-wrap items-center gap-2 text-sm font-bold leading-snug">
          <ActionTitleLine action={action} />
          {isExecuted ? (
            <Badge variant="success" uppercase className="ml-auto">
              <Check size={10} className="shrink-0" />
              <span className="shrink-0">{formatMessage({ id: "actionCard.done" })}</span>
            </Badge>
          ) : null}
        </div>

        {/* Compact readonly summary of agent-prefilled fields. */}
        <div className="mt-1 text-xs text-black/55">
          <ActionDetail action={action} />
        </div>

        {action.draftHint ? (
          <div className="mt-1 border-l-2 border-black/20 pl-2 text-xs italic text-black/55">
            {action.draftHint}
          </div>
        ) : null}

        {isExecuted && metadata.executedByUserName ? (
          <div className="mt-1 text-xs text-black/55">
            {formatMessage(
              { id: "actionCard.committedBy" },
              {
                user: metadata.executedByUserName,
                n: (c: ReactNode) => <span key="n" className="font-bold text-black/70">{c}</span>,
              },
            )}
            {metadata.result ? (
              <>
                {" "}
                <ResultLink result={metadata.result} />
              </>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <Banner intent="warning" density="sm" className="mt-1">{error}</Banner>
        ) : null}

        {!isExecuted ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs"
              disabled={busy || !canOperateCard}
              aria-describedby={blockedReasonText ? blockedReasonId : undefined}
              onClick={handleClick}
            >
              {busy ? "…" : formatMessage({ id: actionVerb(action) })}
            </button>
            {blockedReasonText ? (
              <span id={blockedReasonId} className="text-xs text-black/70">
                {blockedReasonText}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {action.type === "agent:create" && agentDialogOpen ? (
        <CreateAgentDialog
          onClose={handleDialogClose(() => setAgentDialogOpen(false))}
          prefilledName={action.name}
          prefilledDescription={action.description}
          prefilledMachineId={action.requiredComputer ?? action.suggestedComputer}
          prefilledMachineMode={action.requiredComputer ? "required" : action.suggestedComputer ? "preferred" : undefined}
          onCreated={handleAgentCreated}
          onSubmitStart={handleSubmitStart}
          onSubmitError={handleSubmitError}
          fromActionCard
        />
      ) : null}

      {action.type === "channel:create" && channelDialogOpen ? (
        <CreateChannelDialog
          onClose={handleDialogClose(() => setChannelDialogOpen(false))}
          prefilledName={action.name}
          prefilledDescription={action.description}
          prefilledVisibility={action.visibility}
          prefilledHumanIds={action.initialHumans}
          prefilledAgentIds={action.initialAgents}
          onCreated={handleChannelCreated}
          onSubmitStart={handleSubmitStart}
          onSubmitError={handleSubmitError}
        />
      ) : null}

      {action.type === "channel:add_member" && addMembersDialogOpen ? (
        <AddMembersDialog
          channelId={action.channel}
          prefilledHumanIds={action.humans}
          prefilledAgentIds={action.agents}
          draftHint={action.draftHint}
          onClose={handleDialogClose(() => setAddMembersDialogOpen(false))}
          onSubmitted={handleMembersAdded}
          onSubmitStart={handleSubmitStart}
          onSubmitError={handleSubmitError}
        />
      ) : null}
    </div>
  );
}

/**
 * The button label id for an action. Returns a `MessageId`, NOT text — the
 * caller formats it. Typing the return as MessageId makes a bad id a compile
 * error rather than a button that renders "actionCard.verb.createChannel".
 */
function actionVerb(action: ActionCardAction): MessageId {
  switch (action.type) {
    case "channel:create":
      return "actionCard.verb.createChannel";
    case "agent:create":
      return "actionCard.verb.createAgent";
    case "channel:add_member":
      return "actionCard.verb.addMembers";
    case "integration:approve_agent_login":
      return "actionCard.verb.approveLogin";
    case "integration:install_marketplace_app":
      return "actionCard.verb.installApp";
    case "integration:register_app":
      return "actionCard.verb.registerApp";
    case "integration:update_app_registration":
      return "actionCard.verb.updateApp";
    case "integration:recover_app_owner":
      return "actionCard.verb.recoverOwner";
  }
}

function ActionTitleLine({ action }: { action: ActionCardAction }) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const members = useServerStore((s) => s.members);
  const agents = useAgentStore((s) => s.agents);

  // Rich-text chunk. The `key` is REQUIRED: react-intl renders chunks as an
  // array, so an unkeyed element triggers React's list-key warning — silent in
  // the UI, which is why this class has landed three times in this codebase.
  const chunks = { n: (c: ReactNode) => <span key="n">{c}</span> };
  const title = (id: MessageId, values: Record<string, unknown> = {}) => (
    <>{formatMessage({ id }, { ...values, ...chunks })}</>
  );

  void dmChannels;
  void members;

  switch (action.type) {
    case "channel:create":
      // `visibility` is a union VALUE, previously interpolated as the English
      // adjective "private"/"public". An id per arm keeps the adjective
      // translatable and lets zh reorder it.
      return title(
        action.visibility === "private"
          ? "actionCard.title.createPrivateChannel"
          : "actionCard.title.createPublicChannel",
        { name: action.name },
      );
    case "agent:create":
      return title("actionCard.title.createAgent", { name: action.name });
    case "channel:add_member": {
      const channel = channels.find((c) => c.id === action.channel);
      const targetLabel = channel?.name
        ? `#${channel.name}`
        : formatMessage({ id: "actionCard.title.channelFallback" });
      const count = (action.humans?.length ?? 0) + (action.agents?.length ?? 0);
      // Was `member{count === 1 ? "" : "s"}` — hand-rolled English plurals.
      return title("actionCard.title.addMembers", { count, target: targetLabel });
    }
    case "integration:approve_agent_login":
      return title("actionCard.title.approveLogin", {
        client: action.clientName,
        agent: action.agentName,
      });
    case "integration:install_marketplace_app":
      return title("actionCard.title.installApp", {
        client: action.clientName,
        agent: action.agentName,
      });
    case "integration:register_app":
      return title("actionCard.title.registerApp", { name: action.name });
    case "integration:update_app_registration":
      return title("actionCard.title.updateApp", { clientKey: action.clientKey });
    case "integration:recover_app_owner": {
      const target = agents.find((agent) => agent.id === action.targetAgent);
      return title("actionCard.title.recoverOwner", {
        clientKey: action.clientKey,
        agent: target?.name ?? action.targetAgent.slice(0, 8),
      });
    }
  }
}

function ActionDetail({ action }: { action: ActionCardAction }) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const members = useServerStore((s) => s.members);
  const agents = useAgentStore((s) => s.agents);
  const machines = useMachineStore((s) => s.machines);

  switch (action.type) {
    case "channel:create": {
      const humans = (action.initialHumans ?? [])
        .map((id) => members.find((m) => m.userId === id)?.displayName ?? members.find((m) => m.userId === id)?.name ?? id.slice(0, 8))
        .filter(Boolean);
      const initialAgents = (action.initialAgents ?? [])
        .map((id) => agents.find((a) => a.id === id)?.displayName ?? agents.find((a) => a.id === id)?.name ?? id.slice(0, 8));
      return (
        <div className="space-y-0.5">
          {action.description ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.description" })}</span>{" "}
              <span className="text-black/75">{action.description}</span>
            </div>
          ) : null}
          {humans.length > 0 ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.humans" })}</span>{" "}
              <span className="text-black/75">{humans.join(", ")}</span>
            </div>
          ) : null}
          {initialAgents.length > 0 ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.agents" })}</span>{" "}
              <span className="text-black/75">{initialAgents.join(", ")}</span>
            </div>
          ) : null}
        </div>
      );
    }
    case "agent:create": {
      const targetComputer = action.requiredComputer ?? action.suggestedComputer;
      const targetMachine = targetComputer
        ? machines.find((machine) => machine.id === targetComputer)
        : undefined;
      return (
        <div className="space-y-0.5">
          {action.description ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.description" })}</span>{" "}
              <span className="text-black/75">{action.description}</span>
            </div>
          ) : (
            <div className="text-black/45">{formatMessage({ id: "actionCard.noDescription" })}</div>
          )}
          {targetComputer ? (
            <div>
              <span className="text-black/45">
                {formatMessage({ id: action.requiredComputer
                  ? "actionCard.field.requiredComputer"
                  : "actionCard.field.suggestedComputer" })}
              </span>{" "}
              <span className="text-black/75">
                {targetMachine?.name ?? targetComputer.slice(0, 8)}
              </span>
            </div>
          ) : null}
        </div>
      );
    }
    case "channel:add_member": {
      const channel = channels.find((c) => c.id === action.channel);
      const humans = (action.humans ?? [])
        .map((id) => members.find((m) => m.userId === id)?.displayName ?? members.find((m) => m.userId === id)?.name ?? id.slice(0, 8))
        .filter(Boolean);
      const addAgents = (action.agents ?? [])
        .map((id) => agents.find((a) => a.id === id)?.displayName ?? agents.find((a) => a.id === id)?.name ?? id.slice(0, 8));
      return (
        <div className="space-y-0.5">
          {channel?.name ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.channel" })}</span>{" "}
              <span className="text-black/75">#{channel.name}</span>
            </div>
          ) : null}
          {humans.length > 0 ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.humans" })}</span>{" "}
              <span className="text-black/75">{humans.join(", ")}</span>
            </div>
          ) : null}
          {addAgents.length > 0 ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.agents" })}</span>{" "}
              <span className="text-black/75">{addAgents.join(", ")}</span>
            </div>
          ) : null}
        </div>
      );
    }
    case "integration:approve_agent_login": {
      return (
        <div className="space-y-0.5">
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.service" })}</span>{" "}
            <span className="text-black/75">{action.clientName}</span>
          </div>
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.agent" })}</span>{" "}
            <span className="text-black/75">@{action.agentName}</span>
          </div>
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.scopes" })}</span>{" "}
            <ActionScopeList scopes={action.scopes} agentName={action.agentName} />
          </div>
        </div>
      );
    }
    case "integration:install_marketplace_app": {
      return (
        <div className="space-y-0.5">
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.service" })}</span>{" "}
            <span className="text-black/75">{action.clientName}</span>
          </div>
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.agent" })}</span>{" "}
            <span className="text-black/75">
              {formatMessage({ id: "actionCard.agentHandle" }, { agent: action.agentName })}
            </span>
          </div>
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.scopes" })}</span>{" "}
            <ActionScopeList scopes={action.scopes} agentName={action.agentName} />
          </div>
          <div className="font-bold text-brutal-orange">
            {formatMessage({ id: "actionCard.installMarketplaceOwnerOnly" })}
          </div>
        </div>
      );
    }
    case "integration:register_app": {
      return (
        <div className="space-y-0.5">
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.clientKey" })}</span>{" "}
            <span className="text-black/75">{action.clientKey ?? formatMessage({ id: "actionCard.autoGeneratedOnCommit" })}</span>
          </div>
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.redirectUrl" })}</span>{" "}
            <span className="text-black/75 break-all">{action.returnUrl}</span>
          </div>
          {action.homepageUrl ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.appUrl" })}</span>{" "}
              <span className="text-black/75 break-all">{action.homepageUrl}</span>
            </div>
          ) : null}
          {action.agentManifestUrl ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.agentManifest" })}</span>{" "}
              <span className="text-black/75 break-all">{action.agentManifestUrl}</span>
            </div>
          ) : null}
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.scopes" })}</span>{" "}
            <ActionScopeList scopes={action.scopes} />
          </div>
          <div className="font-bold text-black/75">
            {formatMessage({ id: "actionCard.registerOwnerNote" })}
          </div>
          {action.unsafeDemoUrlOverride ? (
            <div className="font-bold text-amber-700">{formatMessage({ id: "actionCard.unsafeDemoUrlOverride" })}</div>
          ) : null}
        </div>
      );
    }
    case "integration:update_app_registration": {
      return (
        <div className="space-y-0.5">
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.clientKey" })}</span>{" "}
            <span className="text-black/75">{action.clientKey}</span>
          </div>
          {action.name ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.name" })}</span>{" "}
              <span className="text-black/75">{action.name}</span>
            </div>
          ) : null}
          {action.returnUrl ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.redirectUrl" })}</span>{" "}
              <span className="text-black/75 break-all">{action.returnUrl}</span>
            </div>
          ) : null}
          {action.homepageUrl ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.appUrl" })}</span>{" "}
              <span className="text-black/75 break-all">{action.homepageUrl}</span>
            </div>
          ) : null}
          {action.agentManifestUrl ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.agentManifest" })}</span>{" "}
              <span className="text-black/75 break-all">{action.agentManifestUrl}</span>
            </div>
          ) : null}
          {action.scopes ? (
            <div>
              <span className="text-black/45">{formatMessage({ id: "actionCard.field.scopes" })}</span>{" "}
              <ActionScopeList scopes={action.scopes} />
            </div>
          ) : null}
          {action.unsafeDemoUrlOverride ? (
            <div className="font-bold text-amber-700">{formatMessage({ id: "actionCard.unsafeDemoUrlOverride" })}</div>
          ) : null}
        </div>
      );
    }
    case "integration:recover_app_owner": {
      const target = agents.find((agent) => agent.id === action.targetAgent);
      return (
        <div className="space-y-0.5">
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.clientKey" })}</span>{" "}
            <span className="text-black/75">{action.clientKey}</span>
          </div>
          <div>
            <span className="text-black/45">{formatMessage({ id: "actionCard.field.recoveryOwner" })}</span>{" "}
            <span className="text-black/75">@{target?.name ?? action.targetAgent.slice(0, 8)}</span>
          </div>
          <div className="font-bold text-amber-700">
            {formatMessage({ id: "actionCard.adminRecoveryOnly" })}
          </div>
        </div>
      );
    }
  }
}

function ResultLink({ result }: { result: ActionCardResult }) {
  const { formatMessage } = useIntl();
  const cls = "font-bold text-black/70";
  // The leading arrow is punctuation shared by every arm, so it stays in JSX
  // rather than being duplicated into seven translations.
  const arrow = (body: ReactNode) => <span className={cls}>→ {body}</span>;

  switch (result.kind) {
    case "channel":
      return arrow(`#${result.name}`);
    case "agent":
      return arrow(`@${result.name}`);
    case "channel-members": {
      const total = result.addedHumanIds.length + result.addedAgentIds.length;
      return arrow(formatMessage(
        { id: "actionCard.result.channelMembers" },
        { count: total, channel: result.channelName },
      ));
    }
    case "agent-integration-login":
      return arrow(formatMessage(
        { id: "actionCard.result.integrationLogin" },
        { client: result.clientName, agent: result.agentName },
      ));
    case "marketplace-app-installation":
      return arrow(formatMessage(
        { id: "actionCard.result.marketplaceInstalled" },
        { client: result.clientName },
      ));
    case "integration-app-registration":
      // `mode` was interpolated raw as the words "registered"/"updated". A union
      // value is not copy — each arm gets its own message.
      return arrow(formatMessage(
        { id: result.mode === "register"
            ? "actionCard.result.appRegistered"
            : "actionCard.result.appUpdated" },
        { client: result.clientName, clientKey: result.clientKey },
      ));
    case "integration-app-owner-recovery":
      return arrow(formatMessage(
        { id: "actionCard.result.ownerRecovered" },
        { client: result.clientName, owner: result.ownerAgentName },
      ));
  }
}
