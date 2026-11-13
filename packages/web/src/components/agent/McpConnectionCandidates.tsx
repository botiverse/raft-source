import { Badge, RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { McpConnectionAuthorizationView } from "../settings/mcpApps/mcpAppApi";
import { CONNECTION_STATUS_MESSAGE_ID } from "./mcpConnectionStatusMessages";

export type McpConnectionCandidate = McpConnectionAuthorizationView["candidates"][number];

/**
 * The Connection a grant starts on: the server default when it is signed in, else the first one that
 * is. Shared by the Connect card (D1) and Grant access on the Agent's Apps tab, so both offer the same
 * thing first.
 */
export function initialMcpCandidate(candidates: McpConnectionCandidate[]): string | null {
  const defaultCandidate = candidates.find((candidate) => candidate.isServerDefault && candidate.status === "ready");
  return (defaultCandidate ?? candidates.find((candidate) => candidate.status === "ready"))?.connectionId ?? null;
}

/**
 * What a grant writes for the chosen Connection: the server default is followed (`null`), so the
 * Agent moves with it later, as the drawer's "Use the server default" does; any other is pinned.
 */
export function mcpGrantConnectionId(candidates: McpConnectionCandidate[], connectionId: string): string | null {
  return candidates.some((candidate) => candidate.connectionId === connectionId && candidate.isServerDefault) ? null : connectionId;
}

/** An App's Connections as radios; one that is not signed in is shown but cannot be chosen. */
export function McpConnectionCandidates({
  candidates,
  value,
  onChange,
  disabled = false,
  testIdPrefix,
}: {
  candidates: McpConnectionCandidate[];
  value: string | null;
  onChange: (connectionId: string) => void;
  disabled?: boolean;
  testIdPrefix: string;
}) {
  const { formatMessage } = useIntl();
  const unnamed = formatMessage({ id: "settings.mcpApp.connections.unnamed" });
  const handleChange = useCallback((next: unknown) => onChange(next as string), [onChange]);
  return (
    <RadioGroup
      value={value ?? ""}
      onValueChange={handleChange}
      disabled={disabled}
      aria-label={formatMessage({ id: "actionCard.mcp.chooseConnection" })}
      className="gap-2"
      data-testid={`${testIdPrefix}-candidates`}
    >
      {candidates.map((candidate) => {
        const unusable = candidate.status !== "ready";
        return (
          <label key={candidate.connectionId} className={`flex items-start gap-2 ${unusable ? "opacity-60" : ""}`}>
            <RadioGroupItem
              value={candidate.connectionId}
              disabled={unusable}
              className="mt-0.5 shrink-0"
              data-testid={`${testIdPrefix}-candidate-${candidate.connectionId}`}
            />
            <span className="min-w-0">
              <span className="block text-subhead font-bold text-foreground">{candidate.name?.trim() || unnamed}</span>
              <span className="mt-0.5 inline-flex flex-wrap items-center gap-1.5 text-caption text-foreground-muted">
                {candidate.isServerDefault ? <Badge variant="success">{formatMessage({ id: "settings.mcpApp.connections.defaultBadge" })}</Badge> : null}
                <span>{formatMessage({ id: CONNECTION_STATUS_MESSAGE_ID[candidate.status] })}</span>
              </span>
              <span className="mt-1 block text-caption text-foreground-muted" data-testid={`${testIdPrefix}-connection-behavior`}>
                {formatMessage({ id: candidate.isServerDefault ? "agent.mcpApps.connection.followsDefaultHint" : "agent.mcpApps.connection.pinnedHint" })}
              </span>
            </span>
          </label>
        );
      })}
    </RadioGroup>
  );
}
