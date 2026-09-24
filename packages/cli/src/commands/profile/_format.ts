import { axSurface } from "../../core/renderer.js";
import type { AgentProfileView, HumanProfileView, ProfileCreatedAgentSummary, ProfileView } from "@botiverse/raft-shared";
import { getRuntimeDisplayName, isRuntimeDeprecated } from "@botiverse/raft-shared";

/**
 * Runtime label for identity display in CLI output: product name plus lifecycle
 * status. CLI output is English-only, so the suffix is literal here; the web
 * surface renders the same status from the i18n catalog.
 */
function runtimeLabelWithStatus(runtimeId: string): string {
  const name = getRuntimeDisplayName(runtimeId);
  return isRuntimeDeprecated(runtimeId) ? `${name} (deprecated)` : name;
}

function formatCreatedAgents(createdAgents: ProfileCreatedAgentSummary[]): string[] {
  if (createdAgents.length === 0) {
    return ["- Created Agents: none"];
  }

  return [
    `- Created Agents (${createdAgents.length}):`,
    ...createdAgents.map((createdAgent) => (
      `  - @${createdAgent.name} (${runtimeLabelWithStatus(createdAgent.runtime)}, ${createdAgent.status})`
    )),
  ];
}

function formatHumanProfile(profile: HumanProfileView): string {
  const lines = [
    "## Profile",
    "",
    "- Type: human",
    `- Handle: @${profile.name}`,
    `- Display Name: ${profile.displayName ?? "(none)"}`,
    `- Description: ${profile.description ?? "(none)"}`,
    `- Membership: ${profile.membershipStatus}`,
  ];

  if (profile.role) lines.push(`- Role: ${profile.role}`);
  if (profile.joinedAt) lines.push(`- Joined: ${profile.joinedAt}`);
  if (profile.email) lines.push(`- Email: ${profile.email}`);

  return [...lines, ...formatCreatedAgents(profile.createdAgents)].join("\n");
}

function formatCreator(profile: AgentProfileView): string | null {
  if (!profile.creator) return null;
  return profile.creator.displayName
    ? `${profile.creator.displayName} (@${profile.creator.name})`
    : `@${profile.creator.name}`;
}

function formatAgentProfile(profile: AgentProfileView): string {
  const lines = [
    "## Profile",
    "",
    "- Type: agent",
    `- Handle: @${profile.name}`,
    `- Display Name: ${profile.displayName ?? "(none)"}`,
    `- Description: ${profile.description ?? "(none)"}`,
    `- Status: ${profile.status}`,
    `- Role: ${profile.serverRole}`,
    `- Runtime: ${runtimeLabelWithStatus(profile.runtime)}`,
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

  return [...lines, ...formatCreatedAgents(profile.createdAgents)].join("\n");
}

export const formatProfile = axSurface(
  "Agent/human profile card.",
  (profile: ProfileView): string => {
  return (profile.kind === "human"
    ? formatHumanProfile(profile)
    : formatAgentProfile(profile));
},
  {
    examples: [{ args: [{ type: "agent", name: "alice-agent", displayName: "Alice", description: "example role", status: "online", serverRole: "member", runtime: "claude", model: "claude-fable-5", reasoningEffort: "medium", computerName: "example-computer", computerId: "00000000-0000-0000-0000-000000000003", computerHostname: "example-host", daemonVersion: "1.0.23", createdAt: "2026-08-31T08:00:00.000Z", createdAgents: [] } as never] }],
  },
);
