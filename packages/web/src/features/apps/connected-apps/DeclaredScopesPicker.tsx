import { Card } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import Tooltip from "../../../components/ui/Tooltip";
import { DeclaredScopeToggle } from "../../../components/settings/DeclaredScopeToggle";
import {
  AGENT_DIRECTORY_OAUTH_SCOPES,
  AGENT_INBOUND_OAUTH_SCOPES,
  IDENTITY_OAUTH_SCOPES,
  OPTIONAL_IDENTITY_OAUTH_SCOPES,
  OAUTH_SCOPE_PRESENTATION,
  hasAgentInboundOAuthScope,
} from "../../../lib/oauthScopePresentation";
import type { RaftOAuthScopeId } from "../../../lib/oauthScopePresentation";

// Exported for settingsSubBatchD.i18n.behavior.test.tsx (removed in the 2026-11 web DOM test prune) — pure presentational,
// so the zh teeth render the real component with no API/data harness.
export function DeclaredScopesPicker({
  value,
  onChange,
}: {
  value: readonly RaftOAuthScopeId[];
  onChange: (next: RaftOAuthScopeId[]) => void;
}) {
  const { formatMessage } = useIntl();
  const selected = new Set<RaftOAuthScopeId>([...IDENTITY_OAUTH_SCOPES, ...value]);
  const updateScope = useCallback((scope: RaftOAuthScopeId, checked: boolean) => {
    if (IDENTITY_OAUTH_SCOPES.includes(scope)) return;
    const next = new Set<RaftOAuthScopeId>([...IDENTITY_OAUTH_SCOPES, ...value]);
    if (checked) next.add(scope);
    else next.delete(scope);
    onChange([
      ...IDENTITY_OAUTH_SCOPES,
      ...OPTIONAL_IDENTITY_OAUTH_SCOPES.filter((item) => next.has(item)),
      ...AGENT_DIRECTORY_OAUTH_SCOPES.filter((item) => next.has(item)),
      ...AGENT_INBOUND_OAUTH_SCOPES.filter((item) => next.has(item)),
    ]);
  }, [onChange, value]);

  return (
    <Card className="p-3" data-testid="connected-app-declared-scopes">
      {value.includes("agent:read") ? <p className="mt-2 text-footnote text-foreground-muted" data-testid="legacy-agent-login-scope">{formatMessage({ id: "settings.connectedApps.appPermissions.legacyLoginScope" })}</p> : null}
      <div className="mt-3 stack-y-2">
        <div className="rounded-control bg-fill-muted p-3">
          <div className="text-footnote font-semibold text-foreground">
            {formatMessage({ id: "settings.connectedApps.identitySection" })}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {IDENTITY_OAUTH_SCOPES.map((scope) => {
              const detail = OAUTH_SCOPE_PRESENTATION[scope];
              return (
                <Tooltip key={scope} content={formatMessage({ id: detail.copyId })}>
                <span className="inline-flex min-h-8 items-center rounded-control border border-line-hairline bg-layer-card px-2.5 py-1 font-mono text-mono-meta text-foreground">
                  {scope}
                </span>
                </Tooltip>
              );
            })}
            {OPTIONAL_IDENTITY_OAUTH_SCOPES.map((scope) => (
              <DeclaredScopeToggle
                key={scope}
                scope={scope}
                checked={selected.has(scope)}
                className="inline-flex min-h-8 items-center gap-2 rounded-control border border-line-hairline bg-layer-card px-2.5 py-1 font-mono text-mono-meta text-foreground"
                onScopeChange={updateScope}
              />
            ))}
          </div>
        </div>

        <div className="rounded-control bg-fill-muted p-3">
          <div className="text-footnote font-semibold text-foreground">
            {formatMessage({ id: "settings.connectedApps.agentMessagingSection" })}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {AGENT_INBOUND_OAUTH_SCOPES.map((scope) => (
              <DeclaredScopeToggle
                key={scope}
                scope={scope}
                checked={selected.has(scope)}
                className="inline-flex min-h-8 items-center gap-2 rounded-control border border-line-hairline bg-layer-card px-2.5 py-1 font-mono text-mono-meta text-foreground"
                onScopeChange={updateScope}
              />
            ))}
          </div>
          {hasAgentInboundOAuthScope(value) && (
            <div className="mt-2 text-footnote text-foreground-muted">
              {formatMessage({ id: "settings.connectedApps.scopeRequiresResourceDetail" })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
