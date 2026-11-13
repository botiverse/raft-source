import { Badge, Button, Input, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import { EllipsisVertical, KeyRound, LogIn, Pencil, Settings, Star, Trash2, Unplug } from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import AppTooltip from "../../ui/Tooltip";
import SurfaceListItem from "../../ui/SurfaceListItem";
import { MCP_AUTH_KIND_MESSAGE_ID } from "./McpAuthKindLabel";
import type { McpConnectionStatus, McpConnectionView } from "./mcpAppApi";
import type { MessageId } from "../../../i18n/messages";

const STATUS_MESSAGE_ID: Record<McpConnectionStatus, MessageId> = {
  ready: "settings.mcpApp.connections.status.ready",
  pending: "settings.mcpApp.connections.status.pending",
  needs_auth: "settings.mcpApp.connections.status.needsAuth",
  expired: "settings.mcpApp.connections.status.expired",
  error: "settings.mcpApp.connections.status.error",
};

export function connectionDisplayName(connection: McpConnectionView, fallback: string): string {
  return connection.name?.trim() || fallback;
}

/**
 * A Connection owns its summary, contextual actions and any open editor. Recovery stays visible;
 * less frequent actions live in its menu so they never crowd the account name.
 */
export function McpConnectionRow({
  connection,
  canManage,
  busy,
  onMakeDefault,
  onRename,
  onRenew,
  onSignOut,
  onDelete,
  onConfigureClient,
  children,
}: {
  connection: McpConnectionView;
  canManage: boolean;
  busy: boolean;
  onMakeDefault: (connection: McpConnectionView) => void;
  onRename: (connection: McpConnectionView, name: string) => Promise<boolean>;
  /** Reauthorize an OAuth Connection, or replace an API-key Connection's key. */
  onRenew: (connection: McpConnectionView) => void;
  onSignOut: (connection: McpConnectionView) => void;
  onDelete: (connection: McpConnectionView) => void;
  onConfigureClient: (connection: McpConnectionView) => void;
  children?: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const [renaming, setRenaming] = useState<string | null>(null);
  const displayName = connectionDisplayName(connection, formatMessage({ id: "settings.mcpApp.connections.unnamed" }));
  const handleMakeDefault = useCallback(() => onMakeDefault(connection), [connection, onMakeDefault]);
  const handleRenew = useCallback(() => onRenew(connection), [connection, onRenew]);
  const handleSignOut = useCallback(() => onSignOut(connection), [connection, onSignOut]);
  const handleDelete = useCallback(() => onDelete(connection), [connection, onDelete]);
  const handleConfigureClient = useCallback(() => onConfigureClient(connection), [connection, onConfigureClient]);
  const needsSignIn = connection.authKind === "oauth" && (connection.status === "needs_auth" || connection.status === "expired");
  const actionsLabel = formatMessage({ id: "settings.mcpApp.connections.actionsName" }, { name: displayName });
  const signedIn = connection.authKind === "oauth" && connection.status !== "needs_auth";
  const handleStartRename = useCallback(() => setRenaming(connection.name ?? ""), [connection.name]);
  const handleCancelRename = useCallback(() => setRenaming(null), []);
  const handleRenameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setRenaming(event.target.value), []);
  const handleSaveRename = useCallback(async () => {
    if (renaming === null || !renaming.trim()) return;
    if (await onRename(connection, renaming.trim())) setRenaming(null);
  }, [connection, onRename, renaming]);
  const statusVariant = connection.status === "ready" ? "success" : connection.status === "pending" ? "warning" : "danger";

  return (
    <SurfaceListItem interactive={false} data-testid="mcp-connection-row" data-connection-id={connection.id} className="flex w-full flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {renaming === null ? (
            <div className="break-words font-bold text-foreground">{displayName}</div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="text"
                autoFocus
                value={renaming}
                onChange={handleRenameChange}
                className="min-w-0 flex-1"
                aria-label={formatMessage({ id: "settings.mcpApp.connections.renameLabel" }, { name: displayName })}
              />
              <Button type="button" size="md" variant="primary" onClick={handleSaveRename} disabled={busy || !renaming.trim()}>
                {formatMessage({ id: "settings.common.save" })}
              </Button>
              <Button type="button" size="md" variant="outline" onClick={handleCancelRename} disabled={busy}>
                {formatMessage({ id: "settings.mcpApp.cancel" })}
              </Button>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {connection.isServerDefault ? (
              <Badge variant="success" data-testid="mcp-connection-default-badge" title={formatMessage({ id: "settings.mcpApp.connections.defaultBadgeHint" })}>{formatMessage({ id: "settings.mcpApp.connections.defaultBadge" })}</Badge>
            ) : null}
            <Badge appearance="outline">{formatMessage({ id: MCP_AUTH_KIND_MESSAGE_ID[connection.authKind] })}</Badge>
            <Badge variant={statusVariant} data-testid="mcp-connection-status">{formatMessage({ id: STATUS_MESSAGE_ID[connection.status] })}</Badge>
            {connection.accountLabel ? <span className="text-caption text-foreground-muted">{connection.accountLabel}</span> : null}
            {connection.authKind === "headers" && connection.headerNames.length > 0 ? (
              <span className="font-mono text-mono-meta text-foreground-muted">{connection.headerNames.join(", ")}</span>
            ) : null}
          </div>
          {connection.lastError ? <div className="mt-1 text-caption text-danger">{connection.lastError}</div> : null}
        </div>
        {canManage && renaming === null && !children ? (
          <div className="flex shrink-0 items-center gap-2">
            {needsSignIn ? (
              <Button type="button" size="md" variant="outline" onClick={handleRenew} disabled={busy}>
                {formatMessage({ id: "settings.mcpApp.connections.signIn" })}
              </Button>
            ) : null}
            <DropdownMenu>
              <AppTooltip content={actionsLabel}>
                <DropdownMenuTrigger render={<Button type="button" size="icon-md" variant="ghost" disabled={busy} aria-label={actionsLabel} data-testid={`mcp-connection-actions-${connection.id}`} />}>
                  <EllipsisVertical aria-hidden="true" />
                </DropdownMenuTrigger>
              </AppTooltip>
              <DropdownMenuContent align="end" aria-label={actionsLabel}>
                {!needsSignIn ? (
                  <DropdownMenuItem onClick={handleRenew} disabled={busy}>
                    {connection.authKind === "oauth" ? <LogIn /> : <KeyRound />}
                    {formatMessage({ id: connection.authKind === "oauth" ? "settings.mcpApp.connections.reauthorize" : "settings.mcpApp.connections.replaceKey" })}
                  </DropdownMenuItem>
                ) : null}
                {connection.authKind === "oauth" ? (
                  <DropdownMenuItem onClick={handleConfigureClient} disabled={busy} data-testid={`mcp-connection-client-${connection.id}`}>
                    <Settings />{formatMessage({ id: "settings.mcpApp.oauthClient.label" })}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleStartRename} disabled={busy} aria-label={formatMessage({ id: "settings.mcpApp.connections.renameName" }, { name: displayName })}>
                  <Pencil />{formatMessage({ id: "settings.mcpApp.connections.rename" })}
                </DropdownMenuItem>
                {!connection.isServerDefault ? (
                  <DropdownMenuItem onClick={handleMakeDefault} disabled={busy} aria-label={formatMessage({ id: "settings.mcpApp.connections.makeDefaultName" }, { name: displayName })}>
                    <Star />{formatMessage({ id: "settings.mcpApp.connections.makeDefault" })}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                {signedIn ? (
                  <DropdownMenuItem onClick={handleSignOut} disabled={busy} aria-label={formatMessage({ id: "settings.mcpApp.connections.signOutName" }, { name: displayName })}>
                    <Unplug />{formatMessage({ id: "settings.mcpApp.connections.signOut" })}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onClick={handleDelete} disabled={busy} aria-label={formatMessage({ id: "settings.mcpApp.connections.deleteName" }, { name: displayName })}>
                  <Trash2 />{formatMessage({ id: "settings.mcpApp.connections.delete" })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-1 border-t border-line-hairline pt-3">{children}</div> : null}
    </SurfaceListItem>
  );
}
