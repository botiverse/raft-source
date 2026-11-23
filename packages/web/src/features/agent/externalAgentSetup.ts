// What an external agent is told to connect with (#wg-external-agent-ux:#2): the prompt for an existing agent's
// CLI login, and the SDK's install command and first lines. One agent credential serves both.
import type { useIntl } from "react-intl";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { getServerUrl } from "../../utils/server";

export type ExternalSetupMethod = "existing_agent" | "sdk";

/** The SDK's published docs (its README on npm). */
export const RAFT_SDK_DOCS_URL = "https://www.npmjs.com/package/@botiverse/raft-sdk";
/** How often step 2 asks whether the agent has signed in yet. */
export const STATUS_POLL_MS = 3000;
/** The credential this dialog makes: the agent page replaces only its own (`Create new credential`). */
export const PAGE_CREDENTIAL_NAME = "Created on this page";

export type Created = { id: string; name: string };

export function externalProfileSlug(agent: Created): string {
  return agent.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || agent.id.slice(0, 8);
}

/**
 * The person pasting the prompt, as the agent names them in `dm:@…`: the viewer's handle, `~human` when an
 * agent here has the same name. Null while unknown (the prompt then leaves out "tell me you are connected").
 */
export function usePromptRecipientHandle(): string | null {
  const name = useAuthStore((s) => s.user?.name ?? null);
  const agentHasName = useAgentStore((s) => name !== null && s.agents.some((agent) => agent.name === name));
  if (!name) return null;
  return agentHasName ? `${name}~human` : name;
}

/**
 * The prompt an existing agent is given: what Raft is, install the CLI, sign in as this agent, ask for the
 * credential, then use its profile, read the manual the login names, say it is connected, and check its inbox
 * (Sage, #wg-ax:2438df62: Raft does not start an external agent when a message arrives).
 */
export function existingAgentPrompt(agent: Created, formatMessage: ReturnType<typeof useIntl>["formatMessage"], me: string | null): string {
  const slug = externalProfileSlug(agent);
  return [
    formatMessage({ id: "agent.createExternal.promptIntro" }, { name: agent.name }),
    "",
    formatMessage({ id: "agent.createExternal.promptInstall" }),
    "npm i -g @botiverse/raft@latest",
    "",
    formatMessage({ id: "agent.createExternal.promptLogin" }),
    `raft agent login --server ${getServerUrl()} --agent ${agent.id} --profile-slug ${slug}`,
    formatMessage({ id: "agent.createExternal.promptCredential" }),
    "",
    me
      ? formatMessage({ id: "agent.createExternal.promptAfter" }, { slug, me })
      : formatMessage({ id: "agent.createExternal.promptAfterNoRecipient" }, { slug }),
  ].join("\n");
}

export const SDK_INSTALL_COMMAND = "npm install @botiverse/raft-sdk";

export function sdkStarterCode(): string {
  return [
    'import { createRaftClient } from "@botiverse/raft-sdk";',
    "",
    "const raft = createRaftClient({",
    `  serverUrl: "${getServerUrl()}",`,
    "  credential: process.env.RAFT_AGENT_CREDENTIAL!,",
    "});",
    "await raft.agent.context(); // now connected",
  ].join("\n");
}


/**
 * What the agent page says about an external agent (raft-design status.md, Jasper e7fe29d7): four states.
 * Not signed in yet covers every server state without a sign-in (no credential, one never used, an expired
 * CLI login token); once connected, presence says Online or Offline; disconnected means it was connected
 * and has no working credential left.
 */
export type ExternalConnectionState = "not_signed_in" | "online" | "offline" | "disconnected";

export function externalConnectionState(setupState: string | undefined, isOnline: boolean): ExternalConnectionState {
  if (setupState === "connected") return isOnline ? "online" : "offline";
  if (setupState === "disconnected") return "disconnected";
  return "not_signed_in";
}

/** One of the agent's credentials, as GET /api/agents/:id/credentials lists it. */
export type AgentCredentialRow = {
  id: string;
  maskedToken?: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
