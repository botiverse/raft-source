import { Plus } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import { useCallback, useMemo, useState } from "react";
import { managedMcpOAuthClientPolicy } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import api from "../../../api/client";
import ConfirmDialog from "../../ConfirmDialog";
import Banner from "../../ui/Banner";
import { showToast } from "../../toastBridge";
import { McpConnectionForm } from "./McpConnectionForm";
import type { McpConnectionFormValues } from "./McpConnectionForm";
import { connectionDisplayName, McpConnectionRow } from "./McpConnectionRow";
import { mcpAppErrorMessage } from "./mcpAppApi";
import type { McpAppView, McpConnectionView, McpDefaultImpact } from "./mcpAppApi";
import { useMcpOAuthSignIn } from "./useMcpOAuthSignIn";
import type { McpOAuthOutcome } from "./useMcpOAuthSignIn";

/** Rethrows a failed request as its explained message, for ConfirmDialog to show. */
function explained(error: unknown, formatMessage: Parameters<typeof mcpAppErrorMessage>[1]): Error {
  return new Error(mcpAppErrorMessage(error, formatMessage));
}

/**
 * An MCP App's Connections: the accounts (OAuth) or keys (API-key headers) Agents call it with.
 * Agents may use the server default or a Connection created by their owner; unpinned Agents
 * follow the default. An auth-less App has no Connections.
 */
export function McpAppConnectionsSection({
  view,
  canManage,
  onReload,
}: {
  view: McpAppView;
  canManage: boolean;
  /** Re-read the App (connections, default, catalogue) after a change. */
  onReload: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<McpConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [defaultTarget, setDefaultTarget] = useState<{ connection: McpConnectionView; impact: McpDefaultImpact } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpConnectionView | null>(null);
  const [signOutTarget, setSignOutTarget] = useState<McpConnectionView | null>(null);
  const authKind = view.server.authKind;
  const oauthClientPolicy = useMemo(() => managedMcpOAuthClientPolicy(view.server.endpointUrl), [view.server.endpointUrl]);
  const unnamed = formatMessage({ id: "settings.mcpApp.connections.unnamed" });
  // The header names every Connection must supply: the App's, or for an App older than recorded
  // names, its default Connection's (the server holds new Connections to the same set).
  const headerNames = useMemo(() => {
    if (view.server.requiredHeaderNames.length > 0) return view.server.requiredHeaderNames;
    return view.connections.find((connection) => connection.isServerDefault)?.headerNames ?? [];
  }, [view.connections, view.server.requiredHeaderNames]);

  const handleOAuthOutcome = useCallback((outcome: McpOAuthOutcome) => {
    if (outcome.kind === "connected") {
      setAdding(false);
      setRenewing(null);
      setError("");
      showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: "settings.mcpApp.connections.signedIn" }) });
    } else {
      setError(formatMessage({
        id: outcome.kind === "expired"
          ? "settings.mcpApp.connections.signInExpired"
          : outcome.kind === "closed"
            ? "settings.mcpApp.connections.signInWindowClosed"
            : "settings.mcpApp.connections.signInFailed",
      }));
    }
    void onReload();
  }, [formatMessage, onReload]);
  const handleOAuthStartError = useCallback((startError: unknown) => {
    setError(mcpAppErrorMessage(startError, formatMessage));
    void onReload();
  }, [formatMessage, onReload]);
  const handleOAuthLateResult = useCallback(() => {
    void onReload();
  }, [onReload]);
  const {
    start: startOAuth,
    cancel: cancelOAuth,
    openSignInPage,
    blockedUrl: oauthBlockedUrl,
    waiting: oauthWaiting,
    starting: oauthStarting,
  } = useMcpOAuthSignIn({ appId: view.id, onOutcome: handleOAuthOutcome, onStartError: handleOAuthStartError, onLateResult: handleOAuthLateResult });

  const handleStartAdd = useCallback(() => {
    setAdding(true);
    setRenewing(null);
    setError("");
  }, []);
  const handleCancelForm = useCallback(() => {
    setAdding(false);
    setRenewing(null);
    cancelOAuth();
  }, [cancelOAuth]);

  const handleAdd = useCallback(async (values: McpConnectionFormValues) => {
    setError("");
    if (authKind === "oauth") {
      await startOAuth({ name: values.name, makeDefault: values.makeDefault, oauthClient: values.oauthClient });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/mcp/apps/${view.id}/connections`, { name: values.name, headers: values.headers, makeDefault: values.makeDefault });
      setAdding(false);
      showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: "settings.mcpApp.connections.added" }) });
      await onReload();
    } catch (addError) {
      setError(mcpAppErrorMessage(addError, formatMessage));
    } finally {
      setBusy(false);
    }
  }, [authKind, formatMessage, onReload, startOAuth, view.id]);

  const handleRenew = useCallback((connection: McpConnectionView) => {
    setError("");
    setAdding(false);
    if (connection.authKind === "oauth") {
      void startOAuth({ connectionId: connection.id });
      return;
    }
    setRenewing(connection);
  }, [startOAuth]);

  const handleConfigureClient = useCallback((connection: McpConnectionView) => {
    setAdding(false);
    setRenewing(connection);
    setError("");
  }, []);

  const handleReplaceKey = useCallback(async (values: McpConnectionFormValues) => {
    if (!renewing) return;
    if (renewing.authKind === "oauth") {
      await startOAuth({ connectionId: renewing.id, oauthClient: values.oauthClient });
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.patch(`/mcp/apps/${view.id}/connections/${renewing.id}`, { headers: values.headers });
      setRenewing(null);
      showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: "settings.mcpApp.connections.keyReplaced" }) });
      await onReload();
    } catch (replaceError) {
      setError(mcpAppErrorMessage(replaceError, formatMessage));
    } finally {
      setBusy(false);
    }
  }, [formatMessage, onReload, renewing, startOAuth, view.id]);

  const handleRename = useCallback(async (connection: McpConnectionView, name: string) => {
    setBusy(true);
    setError("");
    try {
      await api.patch(`/mcp/apps/${view.id}/connections/${connection.id}`, { name });
      await onReload();
      return true;
    } catch (renameError) {
      setError(mcpAppErrorMessage(renameError, formatMessage));
      return false;
    } finally {
      setBusy(false);
    }
  }, [formatMessage, onReload, view.id]);

  const handleMakeDefault = useCallback(async (connection: McpConnectionView) => {
    setBusy(true);
    setError("");
    try {
      const { data } = await api.get<McpDefaultImpact>(`/mcp/apps/${view.id}/default/impact`, { params: { connectionId: connection.id } });
      setDefaultTarget({ connection, impact: data });
    } catch (impactError) {
      setError(mcpAppErrorMessage(impactError, formatMessage));
    } finally {
      setBusy(false);
    }
  }, [formatMessage, view.id]);
  const handleConfirmDefault = useCallback(async () => {
    if (!defaultTarget) return;
    try {
      await api.put(`/mcp/apps/${view.id}/default`, { connectionId: defaultTarget.connection.id });
    } catch (defaultError) {
      throw explained(defaultError, formatMessage);
    }
    showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: "settings.mcpApp.connections.defaultChanged" }, { name: connectionDisplayName(defaultTarget.connection, unnamed) }) });
    await onReload();
  }, [defaultTarget, formatMessage, onReload, unnamed, view.id]);
  const handleCloseDefault = useCallback(() => setDefaultTarget(null), []);

  const handleRequestDelete = useCallback((connection: McpConnectionView) => {
    setError("");
    setDeleteTarget(connection);
  }, []);
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/mcp/apps/${view.id}/connections/${deleteTarget.id}`);
    } catch (deleteError) {
      throw explained(deleteError, formatMessage);
    }
    showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: "settings.mcpApp.connections.deleted" }, { name: connectionDisplayName(deleteTarget, unnamed) }) });
    await onReload();
  }, [deleteTarget, formatMessage, onReload, unnamed, view.id]);
  const handleCloseDelete = useCallback(() => setDeleteTarget(null), []);

  const handleRequestSignOut = useCallback((connection: McpConnectionView) => {
    setError("");
    setSignOutTarget(connection);
  }, []);
  const handleConfirmSignOut = useCallback(async () => {
    if (!signOutTarget) return;
    try {
      await api.delete(`/mcp/apps/${view.id}/connections/${signOutTarget.id}/oauth`);
    } catch (signOutError) {
      throw explained(signOutError, formatMessage);
    }
    showToast({ type: "success", data: { hasIcon: false }, title: formatMessage({ id: "settings.mcpApp.connections.signedOut" }, { name: connectionDisplayName(signOutTarget, unnamed) }) });
    await onReload();
  }, [formatMessage, onReload, signOutTarget, unnamed, view.id]);
  const handleCloseSignOut = useCallback(() => setSignOutTarget(null), []);

  if (authKind === "none") {
    return <div className="text-caption text-foreground-muted" data-testid="mcp-connections-not-needed">{formatMessage({ id: "settings.mcpApp.connections.notNeeded" })}</div>;
  }
  if (!canManage) {
    return <div className="text-caption text-foreground-muted">{formatMessage({ id: "settings.mcpApp.connections.managersOnly" })}</div>;
  }

  const defaultConnection = view.connections.find((connection) => connection.isServerDefault);
  const hasDefault = defaultConnection !== undefined;
  return (
    <div className="stack-y-3" data-testid="mcp-connections">
      {error ? <Banner intent="warning" density="sm" data-testid="mcp-connections-error">{error}</Banner> : null}
      {defaultConnection ? (
        <div className="stack-y-1" data-testid="mcp-default-explanation">
          <p className="text-footnote font-bold text-foreground">{formatMessage({ id: "settings.mcpApp.connections.currentDefault" }, { name: connectionDisplayName(defaultConnection, unnamed) })}</p>
          <p className="text-caption text-foreground-muted">{formatMessage({ id: "settings.mcpApp.connections.defaultUsage" })}</p>
        </div>
      ) : null}
      {view.connections.length > 0 && !hasDefault ? (
        <Banner intent="warning" density="sm">{formatMessage({ id: "settings.mcpApp.connections.noDefault" })}</Banner>
      ) : null}
      {view.connections.length === 0 && !adding ? (
        <div className="text-caption text-foreground-muted">{formatMessage({ id: "settings.mcpApp.connections.empty" })}</div>
      ) : null}
      {view.connections.map((connection) => (
          <McpConnectionRow
            key={connection.id}
            connection={connection}
            canManage={canManage}
            busy={busy || oauthStarting || oauthWaiting}
            onMakeDefault={handleMakeDefault}
            onRename={handleRename}
            onRenew={handleRenew}
            onSignOut={handleRequestSignOut}
            onDelete={handleRequestDelete}
            onConfigureClient={handleConfigureClient}
          >
          {renewing?.id === connection.id ? (
            <McpConnectionForm
              mode="replace"
              title={formatMessage({ id: connection.authKind === "oauth" ? "settings.mcpApp.oauthClient.label" : "settings.mcpApp.connections.replaceKey" })}
              authKind={connection.authKind}
              hasConfiguredOAuthClient={connection.hasConfiguredOAuthClient}
              oauthClientPolicy={oauthClientPolicy}
              raftOAuthClient={view.server.raftOAuthClient === true}
              oauthClientMode={view.server.oauthClientMode === undefined ? "either" : view.server.oauthClientMode}
              headerNames={connection.headerNames.length > 0 ? connection.headerNames : headerNames}
              defaultMakeDefault={false}
              busy={busy}
              waiting={oauthStarting || oauthWaiting}
              submitLabel={formatMessage({ id: connection.authKind === "oauth" ? "settings.mcpApp.connections.signIn" : "settings.mcpApp.connections.replaceKey" })}
              onSubmit={handleReplaceKey}
              onCancel={handleCancelForm}
            />
          ) : null}
          </McpConnectionRow>
      ))}
      {oauthWaiting ? (
        <Banner
          intent="info"
          density="sm"
          data-testid="mcp-connections-oauth-waiting"
          actions={(
            <>
              {oauthBlockedUrl ? (
                <Button type="button" size="md" variant="primary" onClick={openSignInPage} data-testid="mcp-connections-open-sign-in">
                  {formatMessage({ id: "settings.mcpApp.connections.openSignInPage" })}
                </Button>
              ) : null}
              <Button type="button" size="md" variant="outline" onClick={cancelOAuth} data-testid="mcp-connections-cancel-sign-in">
                {formatMessage({ id: "settings.mcpApp.connections.cancelSignIn" })}
              </Button>
            </>
          )}
        >
          {formatMessage({ id: oauthBlockedUrl ? "settings.mcpApp.connections.popupBlocked" : "settings.mcpApp.connections.waitingForSignIn" })}
        </Banner>
      ) : null}
      {adding ? (
        <McpConnectionForm
          mode="add"
          authKind={authKind}
          oauthClientPolicy={oauthClientPolicy}
          raftOAuthClient={view.server.raftOAuthClient === true}
          oauthClientMode={view.server.oauthClientMode === undefined ? "either" : view.server.oauthClientMode}
          headerNames={headerNames}
          defaultMakeDefault={!hasDefault}
          busy={busy}
          waiting={oauthStarting || oauthWaiting}
          submitLabel={formatMessage({ id: authKind === "oauth" ? "settings.mcpApp.connections.signIn" : "settings.mcpApp.connections.add" })}
          onSubmit={handleAdd}
          onCancel={handleCancelForm}
        />
      ) : (
        <Button type="button" size="md" variant="outline" onClick={handleStartAdd} disabled={oauthWaiting} data-testid="mcp-connection-add">
          <Plus size={13} />
          {formatMessage({ id: "settings.mcpApp.connections.addConnection" })}
        </Button>
      )}

      {defaultTarget ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.mcpApp.connections.defaultConfirmTitle" }, { name: connectionDisplayName(defaultTarget.connection, unnamed) })}
          message={(
            <div className="stack-y-2" data-testid="mcp-default-impact">
              <p>{formatMessage({ id: "settings.mcpApp.connections.defaultImpactFollowing" }, { count: defaultTarget.impact.agentsChangingNow, name: connectionDisplayName(defaultTarget.connection, unnamed) })}</p>
              <p>{formatMessage({ id: "settings.mcpApp.connections.defaultImpactUnchanged" }, { pinned: defaultTarget.impact.pinnedUnchanged, off: defaultTarget.impact.offUnchanged })}</p>
            </div>
          )}
          confirmLabel={formatMessage({ id: "settings.mcpApp.connections.makeDefault" })}
          confirmVariant="primary"
          confirmTestId="mcp-default-confirm"
          onConfirm={handleConfirmDefault}
          onClose={handleCloseDefault}
          maxWidthClass="max-w-md"
          layer={1}
        />
      ) : null}
      {signOutTarget ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.mcpApp.connections.signOutConfirmTitle" }, { name: connectionDisplayName(signOutTarget, unnamed) })}
          message={(
            <div className="stack-y-2" data-testid="mcp-sign-out-connection-message">
              <p>{formatMessage({ id: "settings.mcpApp.connections.signOutKeeps" })}</p>
              {signOutTarget.isServerDefault ? <p>{formatMessage({ id: "settings.mcpApp.connections.signOutDefault" })}</p> : null}
            </div>
          )}
          confirmLabel={formatMessage({ id: "settings.mcpApp.connections.signOut" })}
          confirmTestId="mcp-sign-out-connection-confirm"
          onConfirm={handleConfirmSignOut}
          onClose={handleCloseSignOut}
          maxWidthClass="max-w-md"
          layer={1}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.mcpApp.connections.deleteConfirmTitle" }, { name: connectionDisplayName(deleteTarget, unnamed) })}
          message={(
            <div className="stack-y-2" data-testid="mcp-delete-connection-message">
              <p>{formatMessage({ id: "settings.mcpApp.connections.deletePinned" })}</p>
              {deleteTarget.isServerDefault ? <p>{formatMessage({ id: "settings.mcpApp.connections.deleteDefault" })}</p> : null}
            </div>
          )}
          confirmLabel={formatMessage({ id: "settings.mcpApp.connections.deleteConfirm" })}
          confirmTestId="mcp-delete-connection-confirm"
          onConfirm={handleConfirmDelete}
          onClose={handleCloseDelete}
          maxWidthClass="max-w-md"
          layer={1}
        />
      ) : null}
    </div>
  );
}
