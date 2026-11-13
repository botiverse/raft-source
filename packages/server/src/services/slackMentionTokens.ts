const SLACK_USERGROUP_MENTION =
  /<!subteam\^(S[A-Z0-9]{2,})(?:\|@([A-Za-z0-9._-]{1,80}))?>/gu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const RAFT_AGENT_USERGROUP_MARKER_PREFIX = "raft-agent:";
export const RAFT_HUMAN_USERGROUP_MARKER_PREFIX = "raft-user:";
/**
 * Reported when a principal exhausted every handle/name candidate (occupied
 * in the workspace or refused by Slack as taken/invalid), so the settings
 * banner shows its handle-collision hint.
 */
export const SLACK_USERGROUP_NAMING_EXHAUSTED_ERROR = "name_taken";

export type SlackUsergroupMention = {
  providerUsergroupId: string;
  handle: string | null;
};

export type SlackAgentUsergroupMarker = {
  serverId: string;
  agentId: string;
};

export function slackAgentUsergroupMarker(serverId: string, agentId: string): string {
  if (!UUID_PATTERN.test(serverId) || !UUID_PATTERN.test(agentId)) {
    throw new Error("Slack Agent usergroup marker authority is invalid");
  }
  return `${RAFT_AGENT_USERGROUP_MARKER_PREFIX}${serverId}:${agentId}`;
}

export function parseSlackAgentUsergroupMarker(
  description: string,
): SlackAgentUsergroupMarker | null {
  if (!description.startsWith(RAFT_AGENT_USERGROUP_MARKER_PREFIX)) return null;
  const coordinates = description.slice(RAFT_AGENT_USERGROUP_MARKER_PREFIX.length).split(":");
  if (
    coordinates.length !== 2
    || !UUID_PATTERN.test(coordinates[0]!)
    || !UUID_PATTERN.test(coordinates[1]!)
  ) return null;
  return { serverId: coordinates[0]!, agentId: coordinates[1]! };
}

export type SlackHumanUsergroupMarker = {
  serverId: string;
  userId: string;
};

export function slackHumanUsergroupMarker(serverId: string, userId: string): string {
  if (!UUID_PATTERN.test(serverId) || !UUID_PATTERN.test(userId)) {
    throw new Error("Slack human usergroup marker authority is invalid");
  }
  return `${RAFT_HUMAN_USERGROUP_MARKER_PREFIX}${serverId}:${userId}`;
}

export function parseSlackHumanUsergroupMarker(
  description: string,
): SlackHumanUsergroupMarker | null {
  if (!description.startsWith(RAFT_HUMAN_USERGROUP_MARKER_PREFIX)) return null;
  const coordinates = description.slice(RAFT_HUMAN_USERGROUP_MARKER_PREFIX.length).split(":");
  if (
    coordinates.length !== 2
    || !UUID_PATTERN.test(coordinates[0]!)
    || !UUID_PATTERN.test(coordinates[1]!)
  ) return null;
  return { serverId: coordinates[0]!, userId: coordinates[1]! };
}

export function normalizeSlackMentionHandle(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function normalizeSlackCreatableHandle(value: string): string {
  return normalizeSlackMentionHandle(value)
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function slackHandleWithSuffix(baseValue: string, suffixValue: string): string {
  const base = normalizeSlackCreatableHandle(baseValue);
  const suffix = normalizeSlackCreatableHandle(suffixValue);
  if (!base || !suffix) return "";
  return `${base.slice(0, Math.max(1, 79 - suffix.length))}-${suffix}`;
}

function slackPrincipalHandleCandidates(name: string, serverSlug: string, id: string): string[] {
  return [...new Set([
    normalizeSlackCreatableHandle(name),
    slackHandleWithSuffix(name, serverSlug),
    slackHandleWithSuffix(name, id.slice(0, 8)),
  ].filter(Boolean))];
}

export function slackAgentHandleCandidates(input: {
  name: string;
  serverSlug: string;
  agentId: string;
}): string[] {
  return slackPrincipalHandleCandidates(input.name, input.serverSlug, input.agentId);
}

/** Workspace-wide human candidates do not vary with reservation provenance. */
export function slackHumanHandleCandidates(input: {
  name: string;
  userId: string;
}): string[] {
  return slackPrincipalHandleCandidates(input.name, "raft", input.userId);
}

/**
 * Extracts Slack `<!subteam^S…|@handle>` mentions from inbound content.
 * This parser never rejects: a duplicate id keeps its first label, and mentions
 * beyond `limit` are ignored — an ingress reject here would drop the whole
 * user message, which is a far worse failure than missing an agent wake.
 */
export function extractSlackUsergroupMentions(
  content: string,
  limit = 50,
): SlackUsergroupMention[] {
  const mentions = new Map<string, SlackUsergroupMention>();
  for (const match of content.matchAll(SLACK_USERGROUP_MENTION)) {
    const providerUsergroupId = match[1]!;
    const handle = match[2] ? normalizeSlackMentionHandle(match[2]) : null;
    const existing = mentions.get(providerUsergroupId);
    if (existing) continue;
    mentions.set(providerUsergroupId, { providerUsergroupId, handle });
    if (mentions.size >= limit) break;
  }
  return [...mentions.values()].sort((left, right) => (
    left.providerUsergroupId.localeCompare(right.providerUsergroupId)
  ));
}

/**
 * Renders `<!subteam^S…|@handle>` tokens for Raft display. A token's own label
 * survives when present — an unrecognized usergroup (another server's agent,
 * a plain Slack group) still shows the name the author wrote (`@huarong`)
 * rather than the lossy "@Slack group". Resolution/mention rows stay gated on
 * the marker check upstream; this function only formats text.
 */
export function renderSlackUsergroupMentions(
  content: string,
  labelsByProviderUsergroupId: ReadonlyMap<string, string>,
): string {
  const rendered = content.replace(
    SLACK_USERGROUP_MENTION,
    (token, providerUsergroupId: string, rawLabel: string | undefined) => {
      const known = labelsByProviderUsergroupId.get(providerUsergroupId);
      if (known) return known;
      const label = rawLabel ? normalizeSlackMentionHandle(rawLabel) : "";
      return label ? `@${label}` : "@Slack group";
    },
  );
  if (Buffer.byteLength(rendered, "utf8") <= 40_000) return rendered;
  return content.replace(SLACK_USERGROUP_MENTION, "@group");
}
