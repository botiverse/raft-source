import { Badge, Card } from "@botiverse/raft-ui";
import { effectiveAllowedOAuthScopes } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import Tooltip from "../../../components/ui/Tooltip";
import SectionEyebrow from "../../../components/ui/SectionEyebrow";
import {
  OAUTH_SCOPE_PRESENTATION,
  hasAgentInboundOAuthScope,
  isVisibleOAuthScope,
  normalizeVisibleOAuthScopes,
  scopeGroupLabelId,
} from "../../../lib/oauthScopePresentation";
import type {
  OAuthScopeTier,
  RaftOAuthScopeId,
} from "../../../lib/oauthScopePresentation";
import { OAuthScopeNegativeCapabilityBlock } from "./OAuthScopeNegativeCapabilityBlock";

// Exported for settingsSubBatchG.i18n.behavior.test.tsx (removed in the 2026-11 web DOM test prune) — presentational (takes a
// scope array), so the zh tooth renders the real component with no API harness.
export function OAuthScopeList({
  scopes,
  compact = true,
  defaultToDeclared = true,
}: {
  scopes: readonly string[] | null | undefined;
  compact?: boolean;
  defaultToDeclared?: boolean;
}) {
  const { formatMessage } = useIntl();
  // The server's effective set (defaults only when none is declared), and every
  // scope in it: one this build has no copy for shows by its raw name instead
  // of disappearing.
  const shownScopes = [...new Set(defaultToDeclared ? effectiveAllowedOAuthScopes(scopes) : scopes ?? [])];
  const visibleScopes = normalizeVisibleOAuthScopes(shownScopes);
  const unrecognizedScopes = shownScopes.filter((scope) => !isVisibleOAuthScope(scope));
  const unrecognizedCopy = formatMessage({ id: "appPermissionSet.unrecognizedScope" });
  const grouped: Record<OAuthScopeTier, RaftOAuthScopeId[]> = {
    identity: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "identity"),
    agent_directory: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "agent_directory"),
    agent_messaging: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "agent_messaging"),
  };

  return (
    <div className="stack-y-3" data-testid="oauth-scope-list">
      {shownScopes.length === 0 && (
        <Card className="px-3 py-2 text-footnote text-foreground-muted">
          {formatMessage({ id: "settings.connectedApps.noGrantScopes" })}
        </Card>
      )}
      {compact ? (
        <div className="flex flex-wrap gap-1.5">
          {visibleScopes.map((scope) => {
            const detail = OAUTH_SCOPE_PRESENTATION[scope];
            return (
              <Tooltip key={scope} content={formatMessage({ id: detail.copyId })}>
              <span
                className={`inline-flex items-center rounded-chip px-2 py-0.5 font-mono text-mono-meta text-foreground ${detail.requiresResource ? "bg-info-soft" : "bg-fill-muted"}`}
              >
                {scope}
              </span>
              </Tooltip>
            );
          })}
          {unrecognizedScopes.map((scope) => (
            <Tooltip key={scope} content={unrecognizedCopy}>
              <span className="inline-flex items-center rounded-chip bg-fill-muted px-2 py-0.5 font-mono text-mono-meta text-foreground" data-unrecognized-scope={scope}>
                {scope}
              </span>
            </Tooltip>
          ))}
        </div>
      ) : (
        <>
          {(["identity", "agent_directory", "agent_messaging"] as OAuthScopeTier[]).map((tier) => {
            const tierScopes = grouped[tier];
            if (tierScopes.length === 0) return null;
            return (
              <div key={tier} className="stack-y-2">
                <SectionEyebrow as="div">{formatMessage({ id: scopeGroupLabelId(tier) })}</SectionEyebrow>
                <div className="stack-y-2">
                  {tierScopes.map((scope) => {
                    const detail = OAUTH_SCOPE_PRESENTATION[scope];
                    return (
                      <div key={scope} className="rounded-control border border-line-hairline bg-layer-card px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="break-all font-mono text-mono-meta text-foreground">{scope}</code>
                          {detail.requiresResource && <Badge appearance="outline">{formatMessage({ id: "settings.connectedApps.scopeRequiresResource" })}</Badge>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {unrecognizedScopes.map((scope) => (
            <div key={scope} className="rounded-control border border-line-hairline bg-layer-card px-3 py-2" data-unrecognized-scope={scope}>
              <code className="break-all font-mono text-mono-meta text-foreground">{scope}</code>
              <div className="mt-0.5 text-footnote text-foreground-muted">{unrecognizedCopy}</div>
            </div>
          ))}
        </>
      )}
      {!compact && hasAgentInboundOAuthScope(visibleScopes) && <OAuthScopeNegativeCapabilityBlock />}
    </div>
  );
}
