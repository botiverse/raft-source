import { Button, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { ManagedMcpAgentConnectionView, ManagedMcpAgentGrant, ManagedMcpServerView } from "@botiverse/raft-shared";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { MessageId } from "../../i18n/messages";
import { AgentAppRow } from "./AgentAppRow";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";

/** The states an MCP App row can be in for one Agent that has it. */
export type AgentMcpAppRowState = "default" | "pinned" | "no_connection" | "login_required" | "authorization_expired" | "disabled" | "off";

/** What an older server (no `agentConnection`) is read as: the long-standing "every Agent follows the default". */
const LEGACY_CONNECTION: ManagedMcpAgentConnectionView = { mode: "default", status: "ready", connectionName: null };

export function agentMcpConnection(server: ManagedMcpServerView): ManagedMcpAgentConnectionView {
  if (server.agentConnection) return server.agentConnection;
  return server.assignment && !server.assignment.enabled ? { ...LEGACY_CONNECTION, mode: "off" } : LEGACY_CONNECTION;
}

/**
 * How this Agent holds the App, with an ordinary App's grant states. An older server sends no
 * `grant`; it granted every App automatically and "off" was a revocation.
 */
export function agentMcpGrant(server: ManagedMcpServerView): ManagedMcpAgentGrant {
  const connection = agentMcpConnection(server);
  return connection.grant ?? (connection.mode === "off" ? "revoked" : "automatic");
}

/** The Agent has the App (an ordinary App's active grant): shown in the Apps list, not offered by Grant access. */
export function agentHasMcpApp(server: ManagedMcpServerView): boolean {
  const grant = agentMcpGrant(server);
  return grant === "automatic" || grant === "person";
}

export function agentMcpRowState(connection: ManagedMcpAgentConnectionView): AgentMcpAppRowState {
  if (connection.mode === "off") return "off";
  if (connection.status === "disabled") return "disabled";
  if (connection.connectionMissing) return "no_connection";
  if (connection.status !== "ready") return connection.status;
  return connection.mode;
}

// An Agent that has the App is "Active", as with an ordinary App, unless its Connection needs attention.
const STATUS_MESSAGE_ID: Record<AgentMcpAppRowState, MessageId> = {
  default: "agent.detail.active",
  pinned: "agent.detail.active",
  no_connection: "agent.mcpApps.status.noConnection",
  login_required: "agent.mcpApps.status.loginRequired",
  authorization_expired: "agent.mcpApps.status.authorizationExpired",
  disabled: "agent.mcpApps.status.disabled",
  off: "agent.mcpApps.status.off",
};

const STATUS_VARIANT: Record<AgentMcpAppRowState, "success" | "warning" | "muted"> = {
  default: "success",
  pinned: "success",
  no_connection: "warning",
  login_required: "warning",
  authorization_expired: "warning",
  // The App is switched off for the whole server: nothing about this Agent can fix it here.
  disabled: "muted",
  off: "muted",
};

const GRANT_SOURCE_ID: Partial<Record<ManagedMcpAgentGrant, MessageId>> = {
  automatic: "agent.apps.grantSource.appRequest",
  person: "agent.apps.grantSource.person",
};

/**
 * One MCP App this Agent has, on its Apps tab: the same row as an ordinary App's grant (logo, how
 * access was granted, status, Revoke, View service), plus what only an MCP App has -- which
 * Connection this Agent uses (the server default or a pinned one), its tools and last use, and
 * Change connection. The actions are there only for someone who may grant this Agent Apps; the
 * Connection's name only reaches them too (the server sends `null` to everyone else).
 */
export function AgentMcpAppRow({
  server,
  canChange,
  onChange,
  onRevoke,
}: {
  server: ManagedMcpServerView;
  canChange: boolean;
  onChange: (server: ManagedMcpServerView) => void;
  onRevoke: (server: ManagedMcpServerView) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const connection = agentMcpConnection(server);
  const state = agentMcpRowState(connection);
  const sourceId = GRANT_SOURCE_ID[agentMcpGrant(server)];
  const name = connection.connectionName;
  const connectionLine = server.authMode === "none"
    ? formatMessage({ id: "agent.mcpApps.row.noConnectionNeeded" })
    : connection.connectionMissing
      ? formatMessage({ id: "agent.mcpApps.row.noConnection" })
      : connection.mode === "pinned"
      ? name ? formatMessage({ id: "agent.mcpApps.row.pinnedNamed" }, { name }) : formatMessage({ id: "agent.mcpApps.row.pinned" })
      : name ? formatMessage({ id: "agent.mcpApps.row.usesDefaultNamed" }, { name }) : formatMessage({ id: "agent.mcpApps.row.usesDefault" });
  const handleChange = useCallback(() => onChange(server), [onChange, server]);
  const handleRevoke = useCallback(() => onRevoke(server), [onRevoke, server]);

  return (
    <AgentAppRow
      testId={`agent-mcp-app-row-${server.id}`}
      state={state}
      name={server.name}
      logoUrl={server.logoUrl ?? null}
      logoSeed={server.id}
      source={sourceId ? formatMessage({ id: sourceId }) : null}
      statusLabel={formatMessage({ id: STATUS_MESSAGE_ID[state] })}
      statusVariant={STATUS_VARIANT[state]}
      statusTestId="agent-mcp-app-status"
      description={server.description}
      actions={canChange || server.homepageUrl ? (
        <>
          {canChange ? (
            <Button variant="outline" size="md" onClick={handleRevoke} data-testid={`agent-mcp-app-revoke-${server.id}`}>
              {formatMessage({ id: "agent.detail.revoke" })}
            </Button>
          ) : null}
          {canChange && server.authMode !== "none" ? (
            <Button
              variant="outline"
              size="md"
              onClick={handleChange}
              aria-label={formatMessage({ id: "agent.mcpApps.row.changeLabel" }, { name: server.name })}
              data-testid={`agent-mcp-app-change-${server.id}`}
            >
              {formatMessage({ id: "agent.mcpApps.row.change" })}
            </Button>
          ) : null}
          {server.homepageUrl ? (
            <TextLink render={<a href={server.homepageUrl} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "agent.detail.viewService" }))} />} className="text-footnote">
              {formatMessage({ id: "agent.detail.viewService" })}
              <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
            </TextLink>
          ) : null}
        </>
      ) : null}
    >
      <div className="flex flex-wrap items-center gap-2 text-caption text-foreground-hint">
        <span data-testid="agent-mcp-app-subtitle">{connectionLine}</span>
        <span>{formatMessage({ id: "agent.mcpApps.row.tools" }, { count: server.toolCatalog.length })}</span>
        {server.usage ? (
          <span>{formatMessage({ id: "agent.mcpApps.row.lastUsed" }, { time: formatShortDateTime(server.usage.lastInvokedAt) })}</span>
        ) : null}
      </div>
      {server.authMode !== "none" && connection.mode !== "off" ? (
        <p className="text-caption text-foreground-muted" data-testid="agent-mcp-connection-behavior">
          {formatMessage({ id: connection.connectionMissing
            ? "agent.mcpApps.connection.noConnectionHint"
            : connection.mode === "pinned" ? "agent.mcpApps.connection.pinnedHint" : "agent.mcpApps.connection.followsDefaultHint" })}
        </p>
      ) : null}
    </AgentAppRow>
  );
}
