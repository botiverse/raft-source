import type { MessageId } from "../i18n/messages";

export type RaftOAuthScopeId =
  | "openid"
  | "profile"
  | "email"
  | "identity"
  | "agent:event:write"
  | "agent:notification:write";

export type OAuthScopeTier = "identity" | "agent_messaging";

export type OAuthScopePresentation = {
  scope: RaftOAuthScopeId;
  tier: OAuthScopeTier;
  /**
   * A MessageId, not text. This table is imported by three surfaces — the OAuth
   * consent screen, Connected Apps in Settings, and ActionCard — so an English
   * string here renders English on all three while every one of them scans
   * clean, because the sentence lives in this module and not at the call site.
   *
   * The old `label` field was DELETED rather than migrated: nothing rendered it
   * on any of the three surfaces, so minting five catalog ids for it would have
   * created translation work for text no user can see. If a surface ever needs
   * a short label, mint it then.
   */
  copyId: MessageId;
  requiresResource: boolean;
};

export const IDENTITY_OAUTH_SCOPES: RaftOAuthScopeId[] = ["openid", "profile", "identity"];
export const OPTIONAL_IDENTITY_OAUTH_SCOPES: RaftOAuthScopeId[] = ["email"];
export const AGENT_INBOUND_OAUTH_SCOPES: RaftOAuthScopeId[] = ["agent:event:write", "agent:notification:write"];
export const DEFAULT_DECLARED_OAUTH_SCOPES: RaftOAuthScopeId[] = [...IDENTITY_OAUTH_SCOPES];

// These two are the NEGATIVE-capability copy: the sentences telling a user what
// an app cannot do. On a consent screen that is the load-bearing text — it is
// what someone reads before granting access — so leaving it English meant a
// zh user approving permissions from a description they could not read.
export const AGENT_INBOUND_NEGATIVE_CAPABILITY_ID: MessageId = "oauth.agentInbound.negativeCapability";
export const AGENT_INBOUND_CANNOT_SUMMARY_ID: MessageId = "oauth.agentInbound.cannotSummary";
export const IDENTITY_SCOPE_GROUP_SUMMARY_ID: MessageId = "oauth.scopeGroup.identitySummary";

export const OAUTH_SCOPE_PRESENTATION: Record<RaftOAuthScopeId, OAuthScopePresentation> = {
  openid: {
    scope: "openid",
    tier: "identity",
    copyId: "oauth.scope.openid.copy",
    requiresResource: false,
  },
  profile: {
    scope: "profile",
    tier: "identity",
    copyId: "oauth.scope.profile.copy",
    requiresResource: false,
  },
  email: {
    scope: "email",
    tier: "identity",
    copyId: "oauth.scope.email.copy",
    requiresResource: false,
  },
  identity: {
    scope: "identity",
    tier: "identity",
    copyId: "oauth.scope.identity.copy",
    requiresResource: false,
  },
  "agent:event:write": {
    scope: "agent:event:write",
    tier: "agent_messaging",
    copyId: "oauth.scope.agentEventWrite.copy",
    requiresResource: true,
  },
  "agent:notification:write": {
    scope: "agent:notification:write",
    tier: "agent_messaging",
    copyId: "oauth.scope.agentNotificationWrite.copy",
    requiresResource: true,
  },
};

const VISIBLE_SCOPE_SET = new Set<string>(Object.keys(OAUTH_SCOPE_PRESENTATION));

export function isVisibleOAuthScope(scope: string): scope is RaftOAuthScopeId {
  return VISIBLE_SCOPE_SET.has(scope);
}

export function normalizeVisibleOAuthScopes(scopes: readonly string[] | null | undefined): RaftOAuthScopeId[] {
  if (!Array.isArray(scopes)) return [];
  const seen = new Set<RaftOAuthScopeId>();
  const result: RaftOAuthScopeId[] = [];
  for (const scope of scopes) {
    if (isVisibleOAuthScope(scope) && !seen.has(scope)) {
      seen.add(scope);
      result.push(scope);
    }
  }
  return result;
}

export function normalizeDeclaredOAuthScopes(scopes: readonly string[] | null | undefined): RaftOAuthScopeId[] {
  const visible = normalizeVisibleOAuthScopes(scopes);
  return visible.length > 0 ? visible : [...DEFAULT_DECLARED_OAUTH_SCOPES];
}

export function hasAgentInboundOAuthScope(scopes: readonly string[]): boolean {
  // Stryker disable next-line MethodExpression: covered by helper tests; generated mutants hang tsx.
  return scopes.some((scope) => AGENT_INBOUND_OAUTH_SCOPES.includes(scope as RaftOAuthScopeId));
}

export function scopeGroupLabelId(tier: OAuthScopeTier): MessageId {
  return tier === "identity" ? "oauth.scopeGroup.identity" : "oauth.scopeGroup.agentMessaging";
}
