import { useIntl } from "react-intl";

import {
  IDENTITY_SCOPE_GROUP_SUMMARY_ID,
  OAUTH_SCOPE_PRESENTATION,
  hasAgentInboundOAuthScope,
  normalizeVisibleOAuthScopes,
  scopeGroupLabelId,
} from "../../lib/oauthScopePresentation";
import type {
  OAuthScopeTier,
} from "../../lib/oauthScopePresentation";

export default function RequestedScopeConsent({
  scopes,
  className = "mt-5",
}: {
  scopes: readonly string[];
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const visibleScopes = normalizeVisibleOAuthScopes(scopes);
  const visibleScopeSet = new Set<string>(visibleScopes);
  const unpresentedScopes = Array<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed && !visibleScopeSet.has(trimmed) && !unpresentedScopes.includes(trimmed)) {
      unpresentedScopes.push(trimmed);
    }
  }
  const grouped: Record<OAuthScopeTier, typeof visibleScopes> = {
    identity: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "identity"),
    agent_messaging: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "agent_messaging"),
  };
  const hasAgentInboundRequest = hasAgentInboundOAuthScope(visibleScopes);
  // Three mutually exclusive states, so three ids rather than one sentence with
  // conditional fragments — the clause order differs between languages.
  const requestedAccessCopy = formatMessage({
    id: unpresentedScopes.length > 0
      ? "oauth.consent.introUnrecognized"
      : hasAgentInboundRequest
        ? "oauth.consent.introAgentMessaging"
        : "oauth.consent.introIdentityOnly",
  });

  function renderEmptyRecognizedScopes() {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: covered by DOM tests; generated mutants hang tsx.
    if (visibleScopes.length !== 0) return null;
    return (
      <div className="border-2 border-black/15 bg-white p-2 text-xs font-bold text-black/55">
        {formatMessage({ id: "oauth.consent.noRecognizedScopes" })}
      </div>
    );
  }

  function renderTierScopes(tier: OAuthScopeTier) {
    const tierScopes = grouped[tier];
    // Stryker disable next-line ConditionalExpression: covered by DOM tests; generated mutants hang tsx.
    if (tierScopes.length === 0) return null;
    return (
      <details key={tier} open={tier === "agent_messaging"} className="border-2 border-black/15 bg-brutal-cream p-2">
        <summary className="text-xs font-black text-black">
          <span>{formatMessage({ id: scopeGroupLabelId(tier) })}</span>
          {tier === "identity" ? (
            <span className="font-medium text-black/55">
              {formatMessage({ id: IDENTITY_SCOPE_GROUP_SUMMARY_ID })}
            </span>
          ) : null}
        </summary>
        <div className="mt-2 divide-y divide-black/15 border-t border-black/15">
          {tierScopes.map((scope) => {
            const detail = OAUTH_SCOPE_PRESENTATION[scope];
            return (
              <div key={scope} data-oauth-scope-row={scope} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-[11px] font-bold text-black/55">{scope}</code>
                </div>
                <div className="mt-1 text-xs leading-relaxed text-black/65">{formatMessage({ id: detail.copyId })}</div>
              </div>
            );
          })}
        </div>
      </details>
    );
  }

  function renderAgentInboundNotice() {
    // Stryker disable next-line BooleanLiteral,ConditionalExpression: covered by DOM tests; generated mutants hang tsx.
    if (!hasAgentInboundRequest) return null;
    return (
      <div className="text-xs font-bold leading-relaxed text-black/65">
        {/* ONE message. This was two English sentences concatenated in JSX, so a
            translation could not reorder them or merge them into the single
            sentence Chinese wants. */}
        {formatMessage({ id: "oauth.consent.agentLoginRequiredNotice" })}
      </div>
    );
  }

  function renderUnpresentedScopes() {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: covered by DOM tests; generated mutants hang tsx.
    if (unpresentedScopes.length === 0) return null;
    return (
      <div className="text-xs font-bold leading-relaxed text-black/65">
        <span>{formatMessage({ id: "oauth.consent.unrecognizedScopes" })} </span>
        <span className="inline-flex flex-wrap gap-1.5">
          {unpresentedScopes.map((scope) => (
            <code key={scope} className="break-all border border-black/20 bg-white px-1.5 py-0.5 text-[11px] text-black/60">
              {scope}
            </code>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className={className} data-testid="login-with-raft-requested-scopes">
      <div className="text-xs font-black uppercase tracking-widest">
        {formatMessage({ id: "oauth.consent.requestedAccess" })}
      </div>
      <div className="mt-1 text-xs leading-5 text-black/60">
        {requestedAccessCopy}
      </div>
      <div className="mt-3 space-y-3 border-2 border-black bg-white p-3 shadow-brutal-sm">
        {renderEmptyRecognizedScopes()}
        {(["identity", "agent_messaging"] as OAuthScopeTier[]).map(renderTierScopes)}
        {renderAgentInboundNotice()}
        {renderUnpresentedScopes()}
      </div>
    </div>
  );
}
