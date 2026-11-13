import { useIntl } from "react-intl";
import { SelectItem, SelectItemDescription, SelectItemIndicator, SelectItemText } from "@botiverse/raft-ui";
import type { AgentConnectionConnectorView } from "@botiverse/raft-shared";
import Tooltip from "../ui/Tooltip";
import { describeGithubAccess } from "./agentConnectionApi";
import type { GithubAccess } from "./agentConnectionApi";

// The parts of a GitHub connection that say how it is: what it can do (from
// its OAuth scopes) and why it needs reconnecting. Connected connections stay
// quiet: no "healthy" mark, only what sets them apart.

const ACCESS_SUMMARY_IDS = {
  private: "agent.detail.connections.accessSummaryPrivate",
  public: "agent.detail.connections.accessSummaryPublic",
} as const;

/**
 * What the connection can do, in words ("Can use public and private repos");
 * the raw GitHub scopes only in its tooltip. Nothing when not recorded.
 */
export function AccessLine({ access }: { access: GithubAccess }) {
  const { formatMessage } = useIntl();
  if (!access.access || access.short.length > 0) return null;
  const text = formatMessage({ id: ACCESS_SUMMARY_IDS[access.access] });
  const line = (
    <p className="text-footnote text-foreground-muted" data-testid="agent-connection-github-access" data-access={access.access}>
      {text}
    </p>
  );
  if (!access.granted?.length) return line;
  return (
    <Tooltip content={formatMessage({ id: "agent.detail.connections.scopes" }, { scopes: access.granted.join(", ") })}>
      {line}
    </Tooltip>
  );
}

/** Why a connection needs reconnecting: the sentence, the provider's reason (muted) and when it last checked (hint). */
export function HealthDetail({ message, reason, checked }: { message: string; reason: string | null; checked: string | null }) {
  const { formatMessage } = useIntl();
  return (
    <span className="flex flex-col gap-0.5">
      <span>{message}</span>
      {reason ? <span className="text-foreground-muted" data-testid="agent-connection-github-health-reason">{reason}</span> : null}
      {checked ? (
        <span className="text-foreground-hint" data-testid="agent-connection-github-health-checked">
          {formatMessage({ id: "agent.detail.connections.lastChecked" }, { time: checked })}
        </span>
      ) : null}
    </span>
  );
}

export function ConnectorOption({ connector, created }: { connector: AgentConnectionConnectorView; created: string | null }) {
  const { formatMessage } = useIntl();
  const githubName = formatMessage({ id: "agent.detail.connections.github" });
  const reason = connector.canManage ? undefined : formatMessage({ id: "agent.detail.connections.connectorForbidden" });
  // The option says only what needs attention or what sets it apart: needing reconnecting, or its access in words.
  const access = describeGithubAccess(connector.scopes, connector.requestedScopes);
  const state: string | null = connector.oauthStatus === "error"
    ? formatMessage({ id: "agent.detail.connections.statusNeedsReconnect" })
    : access.access ? formatMessage({ id: ACCESS_SUMMARY_IDS[access.access] }) : null;
  const description = [state, created, reason].filter(Boolean).join(" · ");
  return (
    <SelectItem
      value={connector.id}
      disabled={!connector.canManage}
      title={reason}
      data-testid={`agent-connection-connector-${connector.id}`}
    >
      <SelectItemText>{connector.account ?? githubName}</SelectItemText>
      {description ? <SelectItemDescription>{description}</SelectItemDescription> : null}
      <SelectItemIndicator />
    </SelectItem>
  );
}
