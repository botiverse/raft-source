import { Fragment } from "react";
import { useIntl } from "react-intl";
import { Card, Separator } from "@botiverse/raft-ui";

import {
  IDENTITY_SCOPE_GROUP_SUMMARY_ID,
  OAUTH_SCOPE_PRESENTATION,
  OAUTH_SCOPE_TIERS,
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
  intro = true,
}: {
  scopes: readonly string[];
  className?: string;
  /** The sentence under the heading that says what the list is; a dialog that only has room for the list leaves it out. */
  intro?: boolean;
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
  const grouped = Object.fromEntries(OAUTH_SCOPE_TIERS.map((tier) => [
    tier,
    visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === tier),
  ])) as Record<OAuthScopeTier, typeof visibleScopes>;
  const hasAgentInboundRequest = hasAgentInboundOAuthScope(visibleScopes);
  // Use complete messages; clause order differs between languages.
  const requestedAccessCopy = formatMessage({
    id: unpresentedScopes.length > 0
      ? "oauth.consent.introUnrecognized"
      : visibleScopes.includes("agent:read")
        ? "oauth.consent.introAgentDirectory"
        : visibleScopes.includes("app:read")
          ? "oauth.consent.introAppDirectory"
          : visibleScopes.includes("agent:voice")
            ? "oauth.consent.introAgentVoice"
            : hasAgentInboundRequest
              ? "oauth.consent.introAgentMessaging"
              : "oauth.consent.introIdentityOnly",
  });

  function renderEmptyRecognizedScopes() {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: covered by DOM tests; generated mutants hang tsx.
    if (visibleScopes.length !== 0) return null;
    return (
      <div className="rounded-control bg-fill-muted px-3 py-2 text-footnote font-semibold text-foreground-muted">
        {formatMessage({ id: "oauth.consent.noRecognizedScopes" })}
      </div>
    );
  }

  function renderTierScopes(tier: OAuthScopeTier) {
    const tierScopes = grouped[tier];
    // Stryker disable next-line ConditionalExpression: covered by DOM tests; generated mutants hang tsx.
    if (tierScopes.length === 0) return null;
    return (
      <details key={tier} open={tier !== "identity"} className="rounded-control border border-line-hairline px-3 py-2">
        <summary className="rounded-sticker text-callout font-bold text-foreground outline-none focus-visible:shadow-focus">
          <span>{formatMessage({ id: scopeGroupLabelId(tier) })}</span>
          {tier === "identity" ? (
            <span className="font-normal text-foreground-muted">
              {formatMessage({ id: IDENTITY_SCOPE_GROUP_SUMMARY_ID })}
            </span>
          ) : null}
        </summary>
        <div className="mt-2">
          {tierScopes.map((scope) => {
            const detail = OAUTH_SCOPE_PRESENTATION[scope];
            return (
              <Fragment key={scope}>
              <Separator />
              <div data-oauth-scope-row={scope} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all font-mono text-mono-meta font-bold text-foreground">{scope}</code>
                </div>
                <div className="mt-1 text-footnote text-foreground-muted">{formatMessage({ id: detail.copyId })}</div>
              </div>
              </Fragment>
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
      <div className="text-footnote font-semibold text-foreground-muted">
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
      <div className="text-footnote font-semibold text-foreground-muted">
        <span>{formatMessage({ id: "oauth.consent.unrecognizedScopes" })} </span>
        <span className="inline-flex flex-wrap gap-1.5">
          {unpresentedScopes.map((scope) => (
            <code key={scope} className="break-all rounded-sticker bg-fill-muted px-1 font-mono text-mono-meta font-normal text-foreground">
              {scope}
            </code>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className={className} data-testid="login-with-raft-requested-scopes">
      <div className="text-footnote font-bold text-foreground">
        {formatMessage({ id: "oauth.consent.requestedAccess" })}
      </div>
      {intro ? (
        <div className="mt-1 text-callout text-foreground-muted">
          {requestedAccessCopy}
        </div>
      ) : null}
      <Card className={`${intro ? "mt-3" : "mt-1.5"} stack-y-3 p-3`}>
        {renderEmptyRecognizedScopes()}
        {OAUTH_SCOPE_TIERS.map(renderTierScopes)}
        {renderAgentInboundNotice()}
        {renderUnpresentedScopes()}
      </Card>
    </div>
  );
}
