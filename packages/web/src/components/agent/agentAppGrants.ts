import type { MessageId } from "../../i18n/messages";

/** One row of `GET /integrations/agents/:agentId`: a pending request or an active grant. */
export interface AgentIntegrationItem {
  /** The request's id, or for an active grant its grant id. */
  id: string;
  type: "pending" | "active";
  clientId: string;
  clientName: string;
  clientDescription: string | null;
  clientHomepageUrl: string | null;
  clientAgentManifestUrl: string | null;
  /** Absent from an older server. */
  clientLogoUrl?: string | null;
  scopes: string[];
  createdAt: string;
  grantSource: "person" | "agent_login" | "app_request" | "legacy_import" | null;
}

export type AgentAppGrantSource = AgentIntegrationItem["grantSource"];

/** One App the Agent has, with every active grant it holds (an App can hold several). */
export interface AgentAppGrantGroup {
  clientId: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  agentManifestUrl: string | null;
  logoUrl: string | null;
  /** The earliest grant: when the App first got access. */
  since: string;
  grants: AgentIntegrationItem[];
}

/** Active grants grouped by App (`clientId`), in the order the server lists them. */
export function groupGrantsByApp(items: readonly AgentIntegrationItem[]): AgentAppGrantGroup[] {
  const groups = new Map<string, AgentAppGrantGroup>();
  for (const item of items) {
    if (item.type !== "active") continue;
    const group = groups.get(item.clientId);
    if (group) {
      group.grants.push(item);
      if (item.createdAt < group.since) group.since = item.createdAt;
      continue;
    }
    groups.set(item.clientId, {
      clientId: item.clientId,
      name: item.clientName,
      description: item.clientDescription,
      homepageUrl: item.clientHomepageUrl,
      agentManifestUrl: item.clientAgentManifestUrl,
      logoUrl: item.clientLogoUrl ?? null,
      since: item.createdAt,
      grants: [item],
    });
  }
  return [...groups.values()];
}

/**
 * What an App can do for an Agent, in plain words. Every scope the platform grants an App
 * (`RAFT_OAUTH_SCOPE_CATALOG` in @botiverse/raft-shared, the only scopes `oauthService` accepts)
 * belongs to one; the identity scopes together are one ability, signing in as the Agent.
 * `short` reads after "Can …" in the row's one line; `long` names it on its own (details, confirm).
 */
const ABILITIES = [
  { key: "signIn", scopes: ["identity", "openid", "profile"], short: "agent.apps.scope.signIn.short", long: "agent.apps.scope.signIn.long" },
  { key: "email", scopes: ["email"], short: "agent.apps.scope.email.short", long: "agent.apps.scope.email.long" },
  { key: "agentDirectory", scopes: ["agent:read"], short: "agent.apps.scope.agentDirectory.short", long: "agent.apps.scope.agentDirectory.long" },
  { key: "events", scopes: ["agent:event:write"], short: "agent.apps.scope.events.short", long: "agent.apps.scope.events.long" },
  { key: "notifications", scopes: ["agent:notification:write"], short: "agent.apps.scope.notifications.short", long: "agent.apps.scope.notifications.long" },
  { key: "actionRequests", scopes: ["agent:action_request:write"], short: "agent.apps.scope.actionRequests.short", long: "agent.apps.scope.actionRequests.long" },
] as const satisfies ReadonlyArray<{ key: string; scopes: readonly string[]; short: MessageId; long: MessageId }>;

/** Every scope with a plain-language label (the rest are shown as the raw scope). */
export const LABELLED_APP_SCOPES: readonly string[] = ABILITIES.flatMap((ability) => ability.scopes);

/**
 * One thing a grant lets the App do: a known ability (its message ids) and the raw scopes behind
 * it, or an unknown scope, which has no words of its own and is shown as itself.
 */
export type AppAbility =
  | { key: string; short: MessageId; long: MessageId; scopes: string[] }
  | { key: string; short: null; long: null; scopes: [string] };

/** The abilities behind some scopes: known ones in a fixed order, then unknown scopes as given. */
export function appAbilities(scopes: readonly string[]): AppAbility[] {
  const unique = [...new Set(scopes)];
  const known: AppAbility[] = [];
  for (const ability of ABILITIES) {
    const held = ability.scopes.filter((scope) => unique.includes(scope));
    if (held.length > 0) known.push({ key: ability.key, short: ability.short, long: ability.long, scopes: held });
  }
  const unknown: AppAbility[] = unique
    .filter((scope) => !LABELLED_APP_SCOPES.includes(scope))
    .map((scope) => ({ key: `scope:${scope}`, short: null, long: null, scopes: [scope] }));
  return [...known, ...unknown];
}

/** Grants grouped by how access was granted, sources in first-seen order. */
export function grantsBySource(grants: readonly AgentIntegrationItem[]): Array<{ source: AgentAppGrantSource; grants: AgentIntegrationItem[] }> {
  const bySource = new Map<AgentAppGrantSource, AgentIntegrationItem[]>();
  for (const grant of grants) {
    const list = bySource.get(grant.grantSource);
    if (list) list.push(grant);
    else bySource.set(grant.grantSource, [grant]);
  }
  return [...bySource.entries()].map(([source, list]) => ({ source, grants: list }));
}

export const GRANT_SOURCE_LABEL: Record<NonNullable<AgentAppGrantSource>, MessageId> = {
  person: "agent.apps.grantSource.person",
  agent_login: "agent.apps.grantSource.agentLogin",
  app_request: "agent.apps.grantSource.appRequest",
  legacy_import: "agent.apps.grantSource.legacyImport",
};

/** A grant source's words; a grant older than the field has none recorded. */
export function grantSourceLabelId(source: AgentAppGrantSource): MessageId {
  return source ? GRANT_SOURCE_LABEL[source] : "agent.apps.grantSource.unknown";
}

/**
 * Why one grant's revoke failed. `refused`: the server said no (403), so trying again won't help.
 * `error`: the server answered with a failure, its reason when it gave one. `unknown`: no answer,
 * so the write may or may not have landed (the reload tells).
 */
export type RevokeGrantFailure =
  | { kind: "refused"; reason: string | null }
  | { kind: "error"; reason: string | null }
  | { kind: "unknown" };

/** A failed revoke, read from the request's error. */
export function revokeGrantFailure(err: unknown): RevokeGrantFailure {
  const response = (err as { response?: { status?: number; data?: { error?: unknown } } } | null)?.response;
  if (!response) return { kind: "unknown" };
  const reason = typeof response.data?.error === "string" && response.data.error ? response.data.error : null;
  return response.status === 403 ? { kind: "refused", reason } : { kind: "error", reason };
}

/**
 * After a revoke took the control that opened it, the Apps whose Revoke access may take focus, in
 * order: the same App when only one of its grants went and it keeps others, then the Apps after it,
 * then those before it (nearest first). Only Apps that still have a grant are named.
 */
export function appsToFocusAfterRevoke(
  before: readonly AgentIntegrationItem[],
  after: readonly AgentIntegrationItem[],
  target: { clientId: string; whole: boolean },
): string[] {
  const order = groupGrantsByApp(before).map((app) => app.clientId);
  const at = order.indexOf(target.clientId);
  const remaining = new Set(groupGrantsByApp(after).map((app) => app.clientId));
  return [
    ...(target.whole ? [] : [target.clientId]),
    ...order.slice(at + 1),
    ...order.slice(0, Math.max(at, 0)).reverse(),
  ].filter((clientId) => remaining.has(clientId));
}
