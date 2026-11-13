import { Card, CardDescription, CardHeader, CardTitle } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import type { McpAppView } from "./mcpAppApi";

function SummaryCell({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <Card variant="option" data-testid={testId}>
      <CardHeader>
        <CardTitle className="font-mono text-headline font-black tabular-nums" data-testid={`${testId}-count`}>{value}</CardTitle>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
    </Card>
  );
}

/**
 * Which Agents use this App and how: following the server default, pinned to a Connection, or
 * switched off. A pin whose Connection was deleted or can't be used is "no connection selected", not pinned. Read-only here; an Agent's own choice is changed on that Agent.
 */
export function McpAppAgentsSection({ view }: { view: McpAppView }) {
  const { formatMessage } = useIntl();
  const summary = view.agentsSummary;
  return (
    <div className="stack-y-3" data-testid="mcp-app-agents-summary">
      <div className="grid gap-2 sm:grid-cols-3">
        <SummaryCell testId="mcp-agents-default" value={summary.usingDefault} label={formatMessage({ id: "settings.mcpApp.agents.usingDefault" }, { count: summary.usingDefault })} />
        <SummaryCell testId="mcp-agents-pinned" value={summary.pinned} label={formatMessage({ id: "settings.mcpApp.agents.pinned" }, { count: summary.pinned })} />
        <SummaryCell testId="mcp-agents-off" value={summary.off} label={formatMessage({ id: "settings.mcpApp.agents.off" }, { count: summary.off })} />
      </div>
      {view.server.authKind !== "none" ? (
        <p className="text-caption text-foreground-muted" data-testid="mcp-agents-default-explanation">
          {formatMessage({ id: "settings.mcpApp.agents.defaultHint" })}
        </p>
      ) : null}
      {(summary.noConnection ?? 0) > 0 ? (
        <div className="text-caption font-bold text-warning" data-testid="mcp-agents-no-connection">
          {formatMessage({ id: "settings.mcpApp.agents.noConnection" }, { count: summary.noConnection ?? 0 })}
        </div>
      ) : null}
      {summary.actionNeeded > 0 ? (
        <div className="text-caption font-bold text-warning" data-testid="mcp-agents-action-needed">
          {formatMessage({ id: "settings.mcpApp.agents.actionNeeded" }, { count: summary.actionNeeded })}
        </div>
      ) : null}
      {/* The block is read-only: where these are changed (Kirby). */}
      <p className="text-caption text-foreground-muted" data-testid="mcp-agents-change-on-agent">
        {formatMessage({ id: "settings.mcpApp.agents.changeOnAgent" })}
      </p>
    </div>
  );
}
