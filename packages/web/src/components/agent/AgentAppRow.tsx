import { Badge, ListRow } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import StatusDot from "../ui/StatusDot";
import { ConnectedAppLogo } from "../settings/ConnectedAppLogo";

/**
 * One App on an Agent's Apps tab, whatever backs it (an ordinary App's grant or an MCP App). Every
 * row has the same parts in the same places: logo, name, how the Agent got access ("Granted
 * automatically to the app", ...), a status badge, then details and actions. What differs between
 * kinds is only what they put in `children` (an ordinary App's scopes, an MCP App's Connection).
 * Composed from raft-ui's ListRow, as the tab's other rows.
 */
export function AgentAppRow({
  testId,
  name,
  logoUrl,
  logoSeed,
  meta,
  source,
  statusLabel,
  statusVariant,
  statusTestId = "agent-app-status",
  badges,
  description,
  children,
  actions,
  state,
}: {
  testId?: string;
  name: string;
  logoUrl: string | null;
  logoSeed: string;
  /** A line under the name, e.g. when access was granted. */
  meta?: ReactNode;
  /** How the Agent got access. */
  source: string | null;
  statusLabel: string;
  statusVariant: "success" | "warning" | "muted";
  statusTestId?: string;
  badges?: ReactNode;
  description?: string | null;
  children?: ReactNode;
  actions?: ReactNode;
  state?: string;
}) {
  return (
    <ListRow interactive={false} className="items-start" data-testid={testId} data-state={state}>
      <ConnectedAppLogo name={name} logoUrl={logoUrl} seed={logoSeed} size="sm" />
      <div className="min-w-0 flex-1 stack-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="break-words text-subhead font-semibold text-foreground">{name}</span>
              {badges}
            </div>
            {meta ? <div className="font-mono text-mono-meta text-foreground-hint">{meta}</div> : null}
            {source ? <div className="text-caption text-foreground-hint" data-testid="agent-app-source">{source}</div> : null}
          </div>
          <Badge appearance="soft" variant={statusVariant} className="shrink-0" data-testid={statusTestId}>
            {statusVariant === "success" ? <StatusDot presence="online" /> : null}
            {statusLabel}
          </Badge>
        </div>
        {description ? <div className="text-callout text-foreground-muted">{description}</div> : null}
        {children}
        {actions ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{actions}</div> : null}
      </div>
    </ListRow>
  );
}
