export const RAFT_OAUTH_SCOPE_CATALOG = {
  openid: {
    phase: "identity",
    defaultAllowed: true,
    publicDiscovery: true,
    requiresResource: false,
    label: "OpenID identity",
  },
  profile: {
    phase: "identity",
    defaultAllowed: true,
    publicDiscovery: true,
    requiresResource: false,
    label: "Basic profile",
  },
  email: {
    phase: "identity",
    defaultAllowed: false,
    publicDiscovery: true,
    requiresResource: false,
    label: "Email address",
  },
  identity: {
    phase: "identity",
    defaultAllowed: true,
    publicDiscovery: true,
    requiresResource: false,
    label: "Raft identity card",
  },
  "agent:event:write": {
    phase: "agent_inbound",
    defaultAllowed: false,
    publicDiscovery: true,
    requiresResource: true,
    label: "Send structured events to an agent",
  },
  "agent:notification:write": {
    phase: "agent_inbound",
    defaultAllowed: false,
    publicDiscovery: true,
    requiresResource: true,
    label: "Send notifications to an agent",
  },
  "agent:action_request:write": {
    phase: "agent_inbound",
    defaultAllowed: false,
    publicDiscovery: false,
    requiresResource: true,
    label: "Request agent action",
  },
} as const;

export type RaftOAuthScope = keyof typeof RAFT_OAUTH_SCOPE_CATALOG;

export const RAFT_OAUTH_SCOPES_SUPPORTED = Object.keys(RAFT_OAUTH_SCOPE_CATALOG) as RaftOAuthScope[];

export const RAFT_OAUTH_DEFAULT_ALLOWED_SCOPES = RAFT_OAUTH_SCOPES_SUPPORTED
  .filter((scope) => RAFT_OAUTH_SCOPE_CATALOG[scope].defaultAllowed);

export const RAFT_OAUTH_PUBLIC_DISCOVERY_SCOPES = RAFT_OAUTH_SCOPES_SUPPORTED
  .filter((scope) => RAFT_OAUTH_SCOPE_CATALOG[scope].publicDiscovery);

export function isRaftOAuthScope(scope: string): scope is RaftOAuthScope {
  return Object.prototype.hasOwnProperty.call(RAFT_OAUTH_SCOPE_CATALOG, scope);
}

export function raftOAuthScopeRequiresResource(scope: string): boolean {
  return isRaftOAuthScope(scope) && RAFT_OAUTH_SCOPE_CATALOG[scope].requiresResource === true;
}
