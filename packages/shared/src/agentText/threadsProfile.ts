// Canonical thread-list and profile text for agent-facing output (moved
// verbatim from the CLI's commands/thread/_format.ts and
// commands/profile/_format.ts; the CLI wraps these in its axSurface
// registrations and pins the bytes with its snapshot tests).

import type { AgentApiThreadListItem } from "../agentApiContract";
import type { AgentProfileView, HumanProfileView, ProfileCreatedAgentSummary, ProfileView } from "../index";
import { getRuntimeDisplayName, isRuntimeDeprecated } from "../runtimeCatalog";
import { foldAgentOneLineText, indentAgentBodyContinuationLines } from "../agentMessageText";

/** Renders a runtime id for display; defaults to the product name plus a deprecation suffix. */
export type AgentRuntimeLabel = (runtimeId: string) => string;

/**
 * Runtime label for identity display in agent-facing output: product name plus
 * lifecycle status. Agent-facing text is English-only, so the suffix is literal
 * here; the web surface renders the same status from the i18n catalog.
 */
export function agentRuntimeLabelWithStatus(runtimeId: string): string {
  const name = getRuntimeDisplayName(runtimeId);
  return isRuntimeDeprecated(runtimeId) ? `${name} (deprecated)` : name;
}

export interface AgentProfileTextOptions {
  runtimeLabel?: AgentRuntimeLabel;
}

function formatDoneSuffix(thread: AgentApiThreadListItem): string {
  return thread.doneAt ? `, doneAt=${thread.doneAt}` : "";
}

/** Followed thread list for the bound agent, including exact thread targets. */
export function formatAgentThreadList(threads: AgentApiThreadListItem[]): string {
  if (threads.length === 0) return "No followed threads.";
  return [
    `Followed threads (${threads.length}):`,
    ...threads.map((thread) =>
      `- ${thread.target} (${thread.threadChannelId}, parent=${thread.parentChannelRef}, followedAt=${thread.followedAt}, reason=${thread.reason}${formatDoneSuffix(thread)})`,
    ),
  ].join("\n");
}

function formatCreatedAgents(createdAgents: ProfileCreatedAgentSummary[], runtimeLabel: AgentRuntimeLabel): string[] {
  if (createdAgents.length === 0) {
    return ["- Created Agents: none"];
  }

  return [
    `- Created Agents (${createdAgents.length}):`,
    ...createdAgents.map((createdAgent) => (
      `  - @${createdAgent.name} (${runtimeLabel(createdAgent.runtime)}, ${createdAgent.status})`
    )),
  ];
}

function formatHumanProfile(profile: HumanProfileView, runtimeLabel: AgentRuntimeLabel): string {
  const lines = [
    "## Profile",
    "",
    "- Type: human",
    `- Handle: @${profile.name}`,
    `- Display Name: ${profile.displayName ? foldAgentOneLineText(profile.displayName) : "(none)"}`,
    `- Description: ${profile.description ? indentAgentBodyContinuationLines(profile.description) : "(none)"}`,
    `- Membership: ${profile.membershipStatus}`,
  ];

  if (profile.role) lines.push(`- Role: ${profile.role}`);
  if (profile.joinedAt) lines.push(`- Joined: ${profile.joinedAt}`);
  if (profile.email) lines.push(`- Email: ${profile.email}`);

  return [...lines, ...formatCreatedAgents(profile.createdAgents, runtimeLabel)].join("\n");
}

function formatCreator(profile: AgentProfileView): string | null {
  if (!profile.creator) return null;
  return profile.creator.displayName
    ? `${foldAgentOneLineText(profile.creator.displayName)} (@${profile.creator.name})`
    : `@${profile.creator.name}`;
}

function formatAgentProfileCard(profile: AgentProfileView, runtimeLabel: AgentRuntimeLabel): string {
  const lines = [
    "## Profile",
    "",
    "- Type: agent",
    `- Handle: @${profile.name}`,
    `- Display Name: ${profile.displayName ? foldAgentOneLineText(profile.displayName) : "(none)"}`,
    `- Description: ${profile.description ? indentAgentBodyContinuationLines(profile.description) : "(none)"}`,
    `- Status: ${profile.status}`,
    `- Role: ${profile.serverRole}`,
    `- Runtime: ${runtimeLabel(profile.runtime)}`,
    `- Model: ${profile.model}`,
    `- Reasoning: ${profile.reasoningEffort ?? "medium"}`,
  ];

  if (profile.executionMode) lines.push(`- Execution: ${profile.executionMode}`);
  if (profile.computerName || profile.computerId) {
    const label = profile.computerName && profile.computerId
      ? `${profile.computerName} (${profile.computerId})`
      : profile.computerName ?? profile.computerId;
    lines.push(`- Computer: ${label}`);
  }
  if (profile.computerHostname) lines.push(`- Hostname: ${profile.computerHostname}`);
  if (profile.daemonVersion) lines.push(`- Daemon: v${profile.daemonVersion}`);
  lines.push(`- Created: ${profile.createdAt}`);
  if (profile.deletedAt) lines.push(`- Deleted At: ${profile.deletedAt}`);
  const creator = formatCreator(profile);
  if (creator) lines.push(`- Creator: ${creator}`);

  return [...lines, ...formatCreatedAgents(profile.createdAgents, runtimeLabel)].join("\n");
}

/** Agent/human profile card. */
export function formatAgentProfile(profile: ProfileView, options: AgentProfileTextOptions = {}): string {
  const runtimeLabel = options.runtimeLabel ?? agentRuntimeLabelWithStatus;
  return (profile.kind === "human"
    ? formatHumanProfile(profile, runtimeLabel)
    : formatAgentProfileCard(profile, runtimeLabel));
}
