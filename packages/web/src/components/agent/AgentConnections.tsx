import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { EllipsisVertical, Plug, Unplug } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectIcon,
  SelectList,
  SelectTrigger,
  SelectValue,
  Separator,
  Status,
  toast,
} from "@botiverse/raft-ui";
import type {
  AgentConnectionConnectorView,
  AgentConnectionRemovedView,
  AgentConnectionStartRequest,
  AgentConnectionStartView,
  AgentConnectionStatusView,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import { GitHubLogo } from "../icons/ProviderLogos";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import {
  AGENT_MISSING_AT_PROVIDER_CODE,
  agentConnectionPath,
  agentConnectorPath,
  CONNECTOR_DISCONNECT_PARTIAL_CODE,
  CONNECTOR_FORBIDDEN_CODE,
  OWNER_REQUIRED_CODE,
  CONNECTOR_NOT_FOUND_CODE,
  describeGithubAccess,
  DISCONNECT_NOT_CLEARED_CODE,
  errorCode,
  PROVIDER_REFUSED_CODE,
  providerRefusalSentence,
  refusalDetails,
  saysRevokeOnGithub,
  wantsPrivate,
} from "./agentConnectionApi";
import type { GithubAccess } from "./agentConnectionApi";
import { formatRelativeTime } from "../../utils/relativeTime";
import { ConnectAccountDialog } from "./GithubConnectAccountDialog";
import { AccessLine, ConnectorOption, HealthDetail } from "./GithubConnectionDetails";
import { GithubRevokeHint } from "./GithubRevokeHint";

type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "agent_missing" }
  | { kind: "ready"; status: Extract<AgentConnectionStatusView, { supported: true }> };

/**
 * Account connections of a provider-backed (hosted runtime) agent. The
 * provider runs the OAuth flow and keeps the token; this only starts it,
 * shows status and switches or disconnects. Connections are tenant-level
 * connectors shared by the server's agents: the agent uses one of them, only a
 * connector's creator or a server owner/admin may assign or disconnect it
 * (`canManage`, decided by the server). Hidden when the provider does not support
 * connections or the caller may not manage them; shown with a warning when the
 * provider no longer knows the agent (stale provisioning).
 */
export function AgentConnections({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<AgentConnectionStatusView>(agentConnectionPath(agentId, "github"));
      setState(data.supported ? { kind: "ready", status: data } : { kind: "hidden" });
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      // The provider no longer knows the agent: say so instead of hiding the section.
      if (errorCode(err) === AGENT_MISSING_AT_PROVIDER_CODE) {
        setState({ kind: "agent_missing" });
        return;
      }
      // 403/404/409 (not allowed, not provider-backed, not provisioned yet, disabled) hide the section.
      setState(status && status < 500 && status !== 429 ? { kind: "hidden" } : { kind: "error" });
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAgentMissing = useCallback(() => {
    setState({ kind: "agent_missing" });
  }, []);

  if (state.kind === "hidden" || state.kind === "loading") return null;
  return (
    <>
    <Separator />
    <div className="px-(--surface-inset) py-4" data-testid="agent-connections">
      <SectionEyebrow as="div" className="mb-2">
        {formatMessage({ id: "agent.detail.connections.title" })}
      </SectionEyebrow>
      {state.kind === "error" ? (
        <p className="text-footnote font-semibold text-warning-strong">
          {formatMessage({ id: "agent.detail.connections.loadFailed" })}
        </p>
      ) : state.kind === "agent_missing" ? (
        <p className="text-footnote font-semibold text-warning-strong" data-testid="agent-connections-agent-missing">
          {formatMessage({ id: "agent.detail.connections.agentMissingAtProvider" })}
        </p>
      ) : (
        <GithubConnectionRow
          agentId={agentId}
          agentName={agentName}
          status={state.status}
          onChanged={load}
          onAgentMissing={handleAgentMissing}
        />
      )}
    </div>
    </>
  );
}

type ReadyStatus = Extract<AgentConnectionStatusView, { supported: true }>;

/**
 * A failed action, kept as UI state until the next action starts. `sentence`
 * is the generic provider refusal's sentence (shown as sent, see
 * `providerRefusalSentence`); the provider's code and status are only copied
 * (`details`). `account` and `creator` name the connection the action was
 * about, when known; `retry` repeats it.
 */
type ActionError = {
  kind: "start" | "switch" | "detach" | "disconnect";
  /** The server's error code, when it sent one. */
  code: string | null;
  sentence: string | null;
  account: string | null;
  creator: string | null;
  details: string | null;
  retry: () => void;
};

type ConnectionState = "connected" | "not_connected" | "needs_reconnect";

function creatorLabel(connector: AgentConnectionConnectorView): string | null {
  return connector.creator?.displayName ?? connector.creator?.name ?? null;
}

function ConnectionStateChip({ state }: { state: ConnectionState }) {
  const { formatMessage } = useIntl();
  if (state === "needs_reconnect") {
    return (
      <Badge appearance="soft" variant="warning" data-testid="agent-connection-github-state" data-state={state}>
        <Status presence="error" aria-hidden />
        {formatMessage({ id: "agent.detail.connections.statusNeedsReconnect" })}
      </Badge>
    );
  }
  if (state === "connected") {
    return (
      <Badge appearance="soft" variant="success" data-testid="agent-connection-github-state" data-state={state}>
        <Status presence="online" aria-hidden />
        {formatMessage({ id: "agent.detail.connections.statusConnected" })}
      </Badge>
    );
  }
  return (
    <Badge appearance="soft" variant="muted" data-testid="agent-connection-github-state" data-state={state}>
      <Status presence="offline" aria-hidden />
      {formatMessage({ id: "agent.detail.connections.statusNotConnected" })}
    </Badge>
  );
}

function GithubConnectionRow({
  agentId,
  agentName,
  status,
  onChanged,
  onAgentMissing,
}: {
  agentId: string;
  agentName: string;
  status: ReadyStatus;
  onChanged: () => Promise<void>;
  onAgentMissing: () => void;
}) {
  const { formatMessage, locale } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  // Where a connection has no account name, it is just "GitHub".
  const githubName = formatMessage({ id: "agent.detail.connections.github" });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [dialog, setDialog] = useState<"connect" | "detach" | "disconnect" | null>(null);
  // Reconnect opens the connect dialog for this connection: its access is preselected, and a refusal names it.
  const [reconnectTarget, setReconnectTarget] = useState<AgentConnectionConnectorView | null>(null);
  const [partialDisconnect, setPartialDisconnect] = useState<string | null>(null);
  // A removal that took left a copy of the credential the provider can't reach: tell the person to revoke on GitHub.
  const [revokeOnGithub, setRevokeOnGithub] = useState(false);
  // The connector whose partial disconnect said so: its retry no longer meets that copy, so the hint waits for it.
  const revokeAfterRetryRef = useRef<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  // The connector the agent uses now, read by an Undo toast that outlives this render.
  const connectorIdRef = useRef(status.connectorId);
  connectorIdRef.current = status.connectorId;

  const connectors = useMemo(() => status.connectors ?? [], [status.connectors]);
  const current = status.connected
    ? connectors.find((connector) => connector.id === status.connectorId) ?? connectors.find((connector) => connector.current) ?? null
    : null;
  const currentAccount = status.account ?? current?.account ?? null;
  // The connection this agent points at, also while it needs reconnecting (`connected` is false then).
  const attached = current ?? connectors.find((connector) => connector.current) ?? null;
  // "Needs reconnecting" is the provider's `oauthStatus`, never a refusal code.
  const needsReconnect = status.oauthStatus === "error" || attached?.oauthStatus === "error";
  const connectionState: ConnectionState = needsReconnect
    ? "needs_reconnect"
    : status.connected ? "connected" : "not_connected";

  /**
   * A failed action, by the server's code (REFUSAL_CODES): `connectorId` is the
   * connection it was about, when there is one.
   */
  const failed = useCallback((err: unknown, kind: ActionError["kind"], account: string | null, retry: () => void, connectorId: string | null = null) => {
    const code = errorCode(err);
    if (code === AGENT_MISSING_AT_PROVIDER_CODE) {
      onAgentMissing();
      return;
    }
    const connector = connectorId ? connectors.find((item) => item.id === connectorId) ?? null : null;
    setError({
      kind,
      code,
      sentence: providerRefusalSentence(err),
      account: account ?? connector?.account ?? null,
      creator: connector ? creatorLabel(connector) : null,
      details: refusalDetails(err),
      retry,
    });
    // The connection is gone: reload, and it leaves the list. Not the creator or an admin: reload,
    // so `canManage` hides Reconnect, Switch and Disconnect for it.
    if (code === CONNECTOR_FORBIDDEN_CODE || code === CONNECTOR_NOT_FOUND_CODE || code === OWNER_REQUIRED_CODE) void onChanged();
  }, [connectors, onAgentMissing, onChanged]);

  /** "Created by alice · Oct 21, 15:31": what is known today about who made a connection and when. */
  const createdLine = useCallback((connector: AgentConnectionConnectorView): string | null => {
    const creator = creatorLabel(connector);
    const date = connector.createdAt ? formatShortDateTime(connector.createdAt) : null;
    if (creator && date) return formatMessage({ id: "agent.detail.connections.createdByAt" }, { creator, date });
    if (creator) return formatMessage({ id: "agent.detail.connections.createdBy" }, { creator });
    if (date) return formatMessage({ id: "agent.detail.connections.createdAt" }, { date });
    return null;
  }, [formatMessage, formatShortDateTime]);

  /** The connection named in the disconnect confirmation: account, creator and date as far as known. */
  const disconnectSubject = useCallback((connector: AgentConnectionConnectorView): string => {
    const account = connector.account ?? githubName;
    const creator = creatorLabel(connector);
    const date = connector.createdAt ? formatShortDateTime(connector.createdAt) : null;
    if (creator && date) return formatMessage({ id: "agent.detail.connections.connectionCreatedByAt" }, { account, creator, date });
    if (creator) return formatMessage({ id: "agent.detail.connections.connectionCreatedBy" }, { account, creator });
    return account;
  }, [formatMessage, formatShortDateTime, githubName]);

  /**
   * Starts the provider's OAuth flow and leaves for it (true: navigating away);
   * a failure closes the dialog and shows why.
   */
  const start = useCallback(async (access: "public" | "private", target: AgentConnectionConnectorView | null = null): Promise<boolean> => {
    setError(null);
    setRevokeOnGithub(false);
    try {
      // Reconnect names the connection, so confirm replaces its tokens in place (same id); Connect New names none.
      const body: AgentConnectionStartRequest = {
        ...(access === "private" ? { access: "private" as const } : {}),
        ...(target ? { connectorId: target.id } : {}),
      };
      const { data } = await api.post<AgentConnectionStartView>(agentConnectionPath(agentId, "github"), body);
      window.location.assign(data.url);
      return true;
    } catch (err: unknown) {
      setDialog(null);
      setReconnectTarget(null);
      // Every failure, a 404 included, goes through the connection error classifier, about the connection reconnected.
      failed(err, "start", target?.account ?? null, () => {
        void start(access, target);
      }, target?.id ?? null);
      return false;
    }
  }, [agentId, failed]);

  const handleStartContinue = useCallback((access: "public" | "private") => start(access, reconnectTarget), [start, reconnectTarget]);

  const assign = useCallback(async (connectorId: string) => {
    const connector = connectors.find((item) => item.id === connectorId);
    // Raft re-checks on the server; the UI only never offers what would be refused.
    if (!connector || !connector.canManage || connector.assignable === false || connectorId === (status.connectorId ?? attached?.id ?? null)) return;
    setSwitching(true);
    setError(null);
    setPartialDisconnect(null);
    setRevokeOnGithub(false);
    try {
      await api.put(agentConnectionPath(agentId, "github"), { connectorId });
      await onChanged();
    } catch (err: unknown) {
      failed(err, "switch", connector.account, () => {
        void assign(connectorId);
      }, connectorId);
    } finally {
      setSwitching(false);
    }
  }, [agentId, connectors, status.connectorId, attached, onChanged, failed]);

  /**
   * Undo of "Remove from agent": points the agent at the same connector again,
   * unless another connection was picked meanwhile. The toast outlives the
   * panel, so its outcome is reported as a toast too.
   */
  const reattach = useCallback(async (connectorId: string) => {
    if (connectorIdRef.current !== null) {
      toast.error(formatMessage({ id: "agent.detail.connections.undoSkipped" }, { agent: agentName }));
      return;
    }
    try {
      await api.put(agentConnectionPath(agentId, "github"), { connectorId });
      await onChanged();
    } catch {
      toast.error(formatMessage({ id: "agent.detail.connections.reattachFailed" }));
    }
  }, [agentId, agentName, formatMessage, onChanged]);

  /**
   * `retry`: the Retry of a removal that did not take. Its warning stays up
   * (Retry disabled) until this one answers, instead of blinking away.
   */
  const detach = useCallback(async (retry = false) => {
    if (removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    if (!retry) setError(null);
    setPartialDisconnect(null);
    setRevokeOnGithub(false);
    const removed = current;
    let removal: AgentConnectionRemovedView | null = null;
    try {
      ({ data: removal } = await api.delete<AgentConnectionRemovedView | null>(agentConnectionPath(agentId, "github")));
    } catch (err: unknown) {
      removingRef.current = false;
      setRemoving(false);
      failed(err, "detach", currentAccount, () => {
        void detach(true);
      }, removed?.id ?? null);
      return;
    }
    setError(null);
    setRevokeOnGithub(saysRevokeOnGithub(removal));
    await onChanged();
    removingRef.current = false;
    setRemoving(false);
    const account = removed?.account ?? currentAccount ?? githubName;
    const message = formatMessage({ id: "agent.detail.connections.detached" }, { account, agent: agentName });
    // Re-attaching needs the same right as assigning: offer Undo only when the caller has it.
    if (removed?.canManage && removed.assignable !== false) {
      toast.success(message, {
        action: {
          label: formatMessage({ id: "agent.detail.connections.undo" }),
          onClick: () => {
            void reattach(removed.id);
          },
        },
      });
    } else {
      toast.success(message);
    }
  }, [agentId, agentName, current, currentAccount, githubName, onChanged, failed, formatMessage, reattach]);

  // The provider may disconnect a connector only partially (some agents not
  // detached, 502 `…_disconnect_partial`): not a success; the same call again completes it.
  const disconnectConnector = useCallback(async (connectorId: string) => {
    setError(null);
    setRevokeOnGithub(false);
    let removal: AgentConnectionRemovedView | null = null;
    try {
      ({ data: removal } = await api.delete<AgentConnectionRemovedView | null>(agentConnectorPath(agentId, "github", connectorId)));
    } catch (err: unknown) {
      if (errorCode(err) !== CONNECTOR_DISCONNECT_PARTIAL_CODE) throw err;
      // Said once, by the call that met the copy; shown when the disconnect completes.
      if (saysRevokeOnGithub((err as { response?: { data?: unknown } }).response?.data)) revokeAfterRetryRef.current = connectorId;
      setPartialDisconnect(connectorId);
      return;
    }
    setPartialDisconnect(null);
    const metEarlier = revokeAfterRetryRef.current === connectorId;
    revokeAfterRetryRef.current = null;
    setRevokeOnGithub(saysRevokeOnGithub(removal) || metEarlier);
    await onChanged();
  }, [agentId, onChanged]);

  const runDisconnect = useCallback(async (connectorId: string, account: string | null) => {
    try {
      await disconnectConnector(connectorId);
    } catch (err: unknown) {
      setPartialDisconnect(null);
      failed(err, "disconnect", account, () => {
        void runDisconnect(connectorId, account);
      }, connectorId);
    }
  }, [disconnectConnector, failed]);

  const retryDisconnect = useCallback(async (connectorId: string) => {
    setRetrying(true);
    try {
      await runDisconnect(connectorId, current?.account ?? null);
    } finally {
      setRetrying(false);
    }
  }, [runDisconnect, current]);

  const selectItems = useMemo(
    () => connectors.map((connector) => ({ value: connector.id, label: connector.account ?? githubName })),
    [connectors, githubName],
  );

  const handleValueChange = useCallback((value: unknown) => {
    if (typeof value === "string") void assign(value);
  }, [assign]);

  const handleConnectClick = useCallback(() => {
    setReconnectTarget(null);
    setDialog("connect");
  }, []);

  const handleReconnectClick = useCallback(() => {
    setReconnectTarget(attached);
    setDialog("connect");
  }, [attached]);

  const handleDetachClick = useCallback(() => {
    // Without the right to assign it again there is no Undo: confirm first instead.
    if (current?.canManage && current.assignable !== false) void detach();
    else setDialog("detach");
  }, [current, detach]);

  const handleDetachConfirm = useCallback(async () => {
    await detach();
  }, [detach]);

  const handleRevokeHintClose = useCallback(() => {
    setRevokeOnGithub(false);
  }, []);

  const handleDisconnectClick = useCallback(() => {
    setDialog("disconnect");
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialog(null);
    setReconnectTarget(null);
  }, []);

  const handleRetryPartial = useCallback(() => {
    if (partialDisconnect) void retryDisconnect(partialDisconnect);
  }, [retryDisconnect, partialDisconnect]);

  const handleDisconnectConfirm = useCallback(async () => {
    if (current) await runDisconnect(current.id, current.account);
  }, [runDisconnect, current]);

  const purpose = formatMessage({ id: "agent.detail.connections.purpose" }, { agent: agentName });
  const currentCreated = current ? createdLine(current) : null;
  const errorAccount = error?.account ?? githubName;
  const errorMessage = !error
    ? null
    : error.code === CONNECTOR_NOT_FOUND_CODE
      ? formatMessage({ id: "agent.detail.connections.connectorGone" }, { account: errorAccount })
      : error.code === CONNECTOR_FORBIDDEN_CODE
        ? error.creator
          ? formatMessage({ id: "agent.detail.connections.connectorForbiddenBy" }, { account: errorAccount, creator: error.creator })
          : formatMessage({ id: "agent.detail.connections.connectorForbiddenNoCreator" }, { account: errorAccount })
        : error.code === PROVIDER_REFUSED_CODE
          // The provider's sentence, as sent (Raft's own when the provider's did not read as one).
          ? error.sentence ?? formatMessage({ id: "agent.detail.connections.providerRefusedOther" })
          : error.kind === "detach"
            // A removal that did not take carries its own Retry button: no "try again" in the text.
            ? formatMessage({ id: error.code === DISCONNECT_NOT_CLEARED_CODE ? "agent.detail.connections.detachNotCleared" : "agent.detail.connections.detachFailed" }, { agent: agentName })
            : formatMessage({
              id: error.kind === "switch"
                ? "agent.detail.connections.switchFailed"
                : error.kind === "disconnect"
                  ? "agent.detail.connections.disconnectFailed"
                  : "agent.detail.connections.startFailed",
            });

  const handleRetryError = useCallback(() => {
    error?.retry();
  }, [error]);

  const handleCopyDetails = useCallback(() => {
    if (!error?.details) return;
    copyTextToClipboard(error.details, formatMessage).then(
      () => toast.success(formatMessage({ id: "agent.detail.connections.detailsCopied" })),
      () => toast.error(formatMessage({ id: "agent.detail.connections.copyDetailsFailed" })),
    );
  }, [error, formatMessage]);

  const currentCreator = current ? creatorLabel(current) : null;
  // Reconnect is the existing connect flow; only the connection's creator or a server owner/admin may use it.
  const canReconnect = needsReconnect && (attached ? attached.canManage : true);
  // What the agent's connection can do: its connector's lists, or (an older provider, no connectors) the status's own.
  const access: GithubAccess = attached
    ? describeGithubAccess(attached.scopes, attached.requestedScopes)
    : describeGithubAccess(status.connected && status.scopes.length > 0 ? status.scopes : null, status.requestedScopes);
  const reconnectAccess = reconnectTarget && wantsPrivate(reconnectTarget) ? "private" : "public";

  return (
    <Card className="stack-y-3 p-3" data-testid="agent-connection-github" data-connected={status.connected ? "true" : "false"}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <GitHubLogo className="size-4.5" />
          <p className="text-subhead font-semibold text-foreground">{formatMessage({ id: "agent.detail.connections.github" })}</p>
          <ConnectionStateChip state={connectionState} />
        </div>
        <p className="mt-1 text-callout text-foreground-muted">{purpose}</p>
      </div>

      {connectors.length > 0 ? (
        <Field data-testid="agent-connection-github-connectors">
          <FieldLabel>{formatMessage({ id: "agent.detail.connections.useConnection" })}</FieldLabel>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <Select
                value={status.connectorId ?? attached?.id ?? null}
                disabled={switching}
                onValueChange={handleValueChange}
                items={selectItems}
              >
                <SelectTrigger className="w-full min-w-0" aria-label={formatMessage({ id: "agent.detail.connections.useConnection" })}>
                  <SelectValue placeholder={formatMessage({ id: "agent.detail.connections.choosePlaceholder" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {connectors.map((connector) => (
                      <ConnectorOption key={connector.id} connector={connector} created={createdLine(connector)} />
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
            {status.connected && (
              <ConnectionActionsMenu
                agentName={agentName}
                canDisconnect={Boolean(current?.canManage)}
                onConnectNew={status.canConnectNew !== false ? handleConnectClick : undefined}
                removing={removing}
                onDetach={handleDetachClick}
                onDisconnect={handleDisconnectClick}
              />
            )}
          </div>
          {currentCreated ? (
            // Who created it and when: the connection's data, not helper text, so no longer
            // the Select's description (HelperText step 1).
            <p className="text-footnote text-foreground-muted" data-testid="agent-connection-github-status">{currentCreated}</p>
          ) : null}
          {status.connected && !needsReconnect ? <AccessLine access={access} /> : null}
        </Field>
      ) : status.connected ? (
        // A connection without a tenant connector list (older provider): name the account.
        <>
        <div className="flex items-center gap-1">
          <p className="min-w-0 flex-1 text-callout text-foreground-muted" data-testid="agent-connection-github-status">
            {formatMessage({ id: "agent.detail.connections.connectedAs" }, { account: currentAccount ?? githubName })}
          </p>
          <ConnectionActionsMenu
            agentName={agentName}
            canDisconnect={false}
            onConnectNew={status.canConnectNew !== false ? handleConnectClick : undefined}
            removing={removing}
            onDetach={handleDetachClick}
            onDisconnect={handleDisconnectClick}
          />
        </div>
        <AccessLine access={access} />
        </>
      ) : null}

      {needsReconnect && (
        <Banner
          intent="warning"
          density="sm"
          withIcon
          live={false}
          data-testid="agent-connection-github-health"
          actions={canReconnect ? (
            <Button variant="default" size="md" type="button" onClick={handleReconnectClick}>
              {formatMessage({ id: "agent.detail.connections.reconnect" })}
            </Button>
          ) : undefined}
        >
          <HealthDetail
            message={formatMessage(
              { id: canReconnect ? "agent.detail.connections.needsReconnectBody" : "agent.detail.connections.needsReconnectNotYours" },
              { account: attached?.account ?? status.account ?? githubName, agent: agentName },
            )}
            reason={attached?.lastCheckError ?? status.lastCheckError ?? null}
            checked={formatRelativeTime(attached?.lastCheckedAt ?? status.lastCheckedAt ?? null, locale)}
          />
        </Banner>
      )}

      {status.connected && !needsReconnect && access.short.length > 0 && (
        <Banner
          intent="warning"
          density="sm"
          withIcon
          live={false}
          data-testid="agent-connection-github-scopes-short"
          actions={!attached || attached.canManage ? (
            <Button variant="default" size="md" type="button" onClick={handleReconnectClick}>
              {formatMessage({ id: "agent.detail.connections.reconnect" })}
            </Button>
          ) : undefined}
        >
          {formatMessage({ id: "agent.detail.connections.scopesShort" })}
        </Banner>
      )}

      {errorMessage && (
        <Banner
          intent={error?.code === CONNECTOR_NOT_FOUND_CODE ? "info" : "warning"}
          density="sm"
          withIcon
          data-testid="agent-connection-github-error"
          data-code={error?.code ?? "none"}
          actions={error?.kind === "detach" && error.code === DISCONNECT_NOT_CLEARED_CODE ? (
            // The removal did not take and the connection was kept: the same removal again completes it.
            <Button variant="default" size="md" type="button" disabled={removing} onClick={handleRetryError}>
              {formatMessage({ id: "agent.detail.connections.retry" })}
            </Button>
          ) : error?.code === PROVIDER_REFUSED_CODE ? (
            // The attempt stops here: no automatic retry, only the person's own Retry.
            <>
              <Button variant="default" size="md" type="button" onClick={handleRetryError}>
                {formatMessage({ id: "agent.detail.connections.retry" })}
              </Button>
              {error.details && (
                <Button variant="ghost" size="md" type="button" onClick={handleCopyDetails}>
                  {formatMessage({ id: "agent.detail.connections.copyDetails" })}
                </Button>
              )}
            </>
          ) : undefined}
        >
          {errorMessage}
        </Banner>
      )}

      {partialDisconnect && (
        <Banner
          intent="warning"
          density="sm"
          withIcon
          data-testid="agent-connection-disconnect-partial"
          actions={(
            <Button variant="default" size="md" type="button" disabled={retrying} onClick={handleRetryPartial}>
              {formatMessage({ id: "agent.detail.connections.retry" })}
            </Button>
          )}
        >
          {formatMessage({ id: "agent.detail.connections.disconnectPartial" })}
        </Banner>
      )}

      {revokeOnGithub && <GithubRevokeHint onClose={handleRevokeHintClose} />}

      {!status.connected && !canReconnect && status.canConnectNew === false && (
        <p className="text-callout text-foreground-muted" data-testid="agent-connection-github-owner-only">
          {formatMessage({ id: "agent.detail.connections.ownerOnly" })}
        </p>
      )}

      {!status.connected && !canReconnect && status.canConnectNew !== false && (
        <div>
          <Button variant="default" size="md" type="button" onClick={handleConnectClick}>
            {formatMessage({ id: "agent.detail.connections.connectNew" })}
          </Button>
        </div>
      )}

      {dialog === "connect" && (
        <ConnectAccountDialog
          agentName={agentName}
          title={reconnectTarget
            ? formatMessage({ id: "agent.detail.connections.reconnectTitle" }, { account: reconnectTarget.account ?? githubName })
            : formatMessage({ id: "agent.detail.connections.connectTitle" })}
          initialAccess={reconnectAccess}
          onContinue={handleStartContinue}
          onClose={handleDialogClose}
        />
      )}
      {dialog === "detach" && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.connections.detachTitle" }, { agent: agentName })}
          message={currentCreator
            ? formatMessage({ id: "agent.detail.connections.detachMessage" }, { agent: agentName, account: currentAccount ?? githubName, creator: currentCreator })
            : formatMessage({ id: "agent.detail.connections.detachMessageNoCreator" }, { agent: agentName, account: currentAccount ?? githubName })}
          confirmLabel={formatMessage({ id: "agent.detail.connections.detachConfirm" })}
          confirmVariant="warning"
          confirmTestId="agent-connection-detach-confirm"
          onConfirm={handleDetachConfirm}
          onClose={handleDialogClose}
        />
      )}
      {dialog === "disconnect" && current && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.connections.disconnectConnector" })}
          message={formatMessage(
            { id: "agent.detail.connections.disconnectConnectorMessage" },
            { connection: disconnectSubject(current), agent: agentName },
          )}
          cancelLabel={formatMessage({ id: "common.confirm.cancel" })}
          confirmLabel={formatMessage({ id: "agent.detail.connections.disconnectConnector" })}
          confirmVariant="danger"
          confirmTestId="agent-connection-disconnect-connector-confirm"
          onConfirm={handleDisconnectConfirm}
          onClose={handleDialogClose}
        />
      )}
    </Card>
  );
}

function ConnectionActionsMenu({
  agentName,
  canDisconnect,
  removing,
  onConnectNew,
  onDetach,
  onDisconnect,
}: {
  agentName: string;
  canDisconnect: boolean;
  /** A Remove is in flight: no second one. */
  removing: boolean;
  /** Absent when the caller isn't this agent's owner. */
  onConnectNew?: () => void;
  onDetach: () => void;
  onDisconnect: () => void;
}) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "agent.detail.connections.moreActions" });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-lg" aria-label={label} data-testid="agent-connection-github-menu" />}
      >
        <EllipsisVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onConnectNew && (
          <>
            <DropdownMenuItem onClick={onConnectNew}>
              <Plug />
              {formatMessage({ id: "agent.detail.connections.connectNew" })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={onDetach} disabled={removing}>
          <Unplug />
          {formatMessage({ id: "agent.detail.connections.detach" }, { agent: agentName })}
        </DropdownMenuItem>
        {canDisconnect && (
          <DropdownMenuItem onClick={onDisconnect}>
            <Unplug />
            {formatMessage({ id: "agent.detail.connections.disconnectConnector" })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
