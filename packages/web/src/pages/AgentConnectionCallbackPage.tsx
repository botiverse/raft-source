import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Link, useLocation } from "react-router-dom";
import { Card, ScrollArea, TextLink } from "@botiverse/raft-ui";
import { AGENT_CONNECTION_PENDING_ID_RE, isAgentConnectionProvider } from "@botiverse/raft-shared";
import type { AgentConnectionProvider, AgentConnectionStatusView } from "@botiverse/raft-shared";
import api from "../api/client";
import Banner from "../components/ui/Banner";
import SectionEyebrow from "../components/ui/SectionEyebrow";
import {
  ACCOUNT_MISMATCH_CODE,
  agentConnectionPath,
  CONNECTOR_FORBIDDEN_CODE,
  CONNECTOR_NOT_FOUND_CODE,
  errorCode,
  PENDING_INVALID_CODE,
  providerRefusalReason,
  providerRefusalSentence,
} from "../components/agent/agentConnectionApi";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";

type Target = { provider: AgentConnectionProvider; serverId: string; agentId: string };

export type AgentConnectionCallbackView =
  | { kind: "invalid" }
  /** Someone else started this flow: never confirm it, never show it as a success. */
  | ({ kind: "foreign" } & Target)
  | ({ kind: "pending"; pending: string } & Target)
  | ({ kind: "denied" } & Target)
  | ({ kind: "failed" } & Target);

/**
 * Reads the provider's return (`connection`, `status`, `pending`, `by`,
 * forwarded by the API bounce with `serverId`/`agentId`). `by` must be the
 * signed-in user: the provider binds the flow to the Raft user who started it,
 * and only that user may confirm the pending connection.
 */
export function describeAgentConnectionCallback(search: string, currentUserId: string | null): AgentConnectionCallbackView {
  const params = new URLSearchParams(search);
  const provider = params.get("connection");
  const serverId = params.get("serverId");
  const agentId = params.get("agentId");
  if (!isAgentConnectionProvider(provider) || !serverId || !agentId) return { kind: "invalid" };
  const target = { provider, serverId, agentId };
  const by = params.get("by");
  if (!currentUserId || !by || by !== currentUserId) return { kind: "foreign", ...target };
  const status = params.get("status");
  if (status === "pending") {
    const pending = params.get("pending");
    return pending && AGENT_CONNECTION_PENDING_ID_RE.test(pending) ? { kind: "pending", pending, ...target } : { kind: "failed", ...target };
  }
  return { kind: status === "denied" ? "denied" : "failed", ...target };
}

type NoTarget = { provider: null; serverId: null; agentId: null };
const NO_TARGET: NoTarget = { provider: null, serverId: null, agentId: null };
const NO_PENDING_TARGET: NoTarget & { pending: null } = { ...NO_TARGET, pending: null };

type ConfirmState =
  | { kind: "confirming" }
  | { kind: "connected"; account: string | null }
  /** `agent_connection_pending_invalid`: the link expired, was used, or is someone else's; start again. */
  | { kind: "expired"; reason: string | null }
  /** `agent_connection_connector_not_found`: the connection being reconnected was disconnected meanwhile. */
  | { kind: "connector_gone" }
  /** `agent_connection_account_mismatch`: another GitHub account authorized; the connection was kept. */
  | { kind: "account_mismatch" }
  /** `agent_connection_connector_forbidden`: only its creator or a server owner/admin may reconnect it. */
  | { kind: "forbidden" }
  | { kind: "error"; reason: string | null };

/** What a failed confirm means, by the server's code (REFUSAL_CODES). */
function confirmFailure(err: unknown): ConfirmState {
  switch (errorCode(err)) {
    case PENDING_INVALID_CODE:
      return { kind: "expired", reason: providerRefusalReason(err) };
    case CONNECTOR_NOT_FOUND_CODE:
      return { kind: "connector_gone" };
    case ACCOUNT_MISMATCH_CODE:
      return { kind: "account_mismatch" };
    case CONNECTOR_FORBIDDEN_CODE:
      return { kind: "forbidden" };
    default:
      return { kind: "error", reason: providerRefusalSentence(err) };
  }
}

export default function AgentConnectionCallbackPage() {
  const { formatMessage } = useIntl();
  const location = useLocation();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const servers = useServerStore((s) => s.servers);
  const view = describeAgentConnectionCallback(location.search, currentUserId);
  const server = view.kind === "invalid" ? null : servers.find((candidate) => candidate.id === view.serverId) ?? null;
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "confirming" });
  const [status, setStatus] = useState<AgentConnectionStatusView | null>(null);
  const confirmedKey = useRef<string | null>(null);

  // The effects below are keyed by the flow's own fields (strings), not by `view`, which is
  // rebuilt every render.
  const {
    serverId: pendingServerId,
    agentId: pendingAgentId,
    provider: pendingProvider,
    pending: pendingId,
  } = view.kind === "pending" ? view : NO_PENDING_TARGET;
  useEffect(() => {
    if (!pendingServerId || !pendingAgentId || !pendingProvider || !pendingId) return;
    // The pending id is single-use: confirm exactly once per id.
    const pendingKey = `${pendingServerId}/${pendingAgentId}/${pendingId}`;
    if (confirmedKey.current === pendingKey) return;
    confirmedKey.current = pendingKey;
    api.post<AgentConnectionStatusView>(
      `${agentConnectionPath(pendingAgentId, pendingProvider)}/confirm`,
      { pending: pendingId },
      { headers: { "X-Server-Id": pendingServerId } },
    )
      .then(({ data }) => setConfirm({ kind: "connected", account: data.supported ? data.account : null }))
      .catch((err: unknown) => setConfirm(confirmFailure(err)));
  }, [pendingAgentId, pendingId, pendingProvider, pendingServerId]);

  // A flow someone else started: re-read status so an unexpected connection can be flagged.
  const {
    serverId: foreignServerId,
    agentId: foreignAgentId,
    provider: foreignProvider,
  } = view.kind === "foreign" ? view : NO_TARGET;
  useEffect(() => {
    if (!foreignServerId || !foreignAgentId || !foreignProvider) return;
    let canceled = false;
    api.get<AgentConnectionStatusView>(agentConnectionPath(foreignAgentId, foreignProvider), { headers: { "X-Server-Id": foreignServerId } })
      .then(({ data }) => { if (!canceled) setStatus(data); })
      .catch(() => undefined);
    return () => { canceled = true; };
  }, [foreignAgentId, foreignProvider, foreignServerId]);


  const agentId = view.kind === "invalid" ? null : view.agentId;
  const agentHref = server && agentId ? `/s/${encodeURIComponent(server.slug)}/agent/${encodeURIComponent(agentId)}` : null;
  const foreignConnected = view.kind === "foreign" && status?.supported === true && status.connected;

  let intent: "success" | "warning" | "info" | "destructive" = "destructive";
  let message: string;
  let reason: string | null = null;
  switch (view.kind) {
    case "invalid":
      message = formatMessage({ id: "pages.agentConnectionCallback.invalid" });
      break;
    case "foreign":
      message = formatMessage({ id: "pages.agentConnectionCallback.foreign" });
      break;
    case "denied":
      intent = "warning";
      message = formatMessage({ id: "pages.agentConnectionCallback.denied" });
      break;
    case "failed":
      message = formatMessage({ id: "pages.agentConnectionCallback.failed" });
      break;
    case "pending":
      if (confirm.kind === "connected") {
        intent = "success";
        message = confirm.account
          ? formatMessage({ id: "pages.agentConnectionCallback.connectedAs" }, { account: confirm.account })
          : formatMessage({ id: "pages.agentConnectionCallback.connected" });
      } else if (confirm.kind === "expired") {
        message = formatMessage({ id: "pages.agentConnectionCallback.expired" });
        reason = confirm.reason;
      } else if (confirm.kind === "connector_gone") {
        intent = "warning";
        message = formatMessage({ id: "pages.agentConnectionCallback.connectorGone" });
      } else if (confirm.kind === "account_mismatch") {
        intent = "warning";
        message = formatMessage({ id: "pages.agentConnectionCallback.accountMismatch" });
      } else if (confirm.kind === "forbidden") {
        intent = "warning";
        message = formatMessage({ id: "pages.agentConnectionCallback.forbidden" });
      } else if (confirm.kind === "error") {
        message = confirm.reason
          ? formatMessage({ id: "pages.agentConnectionCallback.providerRefused" }, { reason: confirm.reason })
          : formatMessage({ id: "pages.agentConnectionCallback.failed" });
      } else {
        intent = "info";
        message = formatMessage({ id: "pages.agentConnectionCallback.confirming" });
      }
      break;
  }

  return (
    // raft-ui ScrollArea: the page's scroller. The safe areas pad its
    // full-height content; the card's column fills what they leave (flex-1).
    <ScrollArea
      className="h-full min-h-0 bg-layer-sidebar font-display text-foreground"
      contentClassName="flex min-h-full flex-col safe-top safe-bottom"
      data-testid="agent-connection-callback-page"
      data-kind={view.kind}
      data-confirm={confirm.kind}
    >
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-8">
        <Card className="block stack-y-4 p-5">
          <div>
            <SectionEyebrow as="div">{formatMessage({ id: "pages.agentConnectionCallback.eyebrow" })}</SectionEyebrow>
            <h1 className="mt-1 text-title">{formatMessage({ id: "pages.agentConnectionCallback.title" })}</h1>
          </div>
          <Banner intent={intent} withIcon>
            <span data-testid="agent-connection-callback-message">{message}</span>
          </Banner>
          {reason && (
            <p className="text-callout text-foreground-muted" data-testid="agent-connection-callback-reason">
              {formatMessage({ id: "pages.agentConnectionCallback.providerReason" }, { reason })}
            </p>
          )}
          {foreignConnected && (
            <p className="text-callout text-foreground-muted" data-testid="agent-connection-callback-disconnect-advice">
              {formatMessage({ id: "pages.agentConnectionCallback.foreignConnected" })}
            </p>
          )}
          {agentHref && (
            <TextLink render={<Link to={agentHref} />} className="inline-block text-footnote">
              {formatMessage({ id: "pages.agentConnectionCallback.backToAgent" })}
            </TextLink>
          )}
        </Card>
      </div>
    </ScrollArea>
  );
}
