// What an external agent is told to connect with (#wg-external-agent-ux:#2): the prompt for an existing agent's
// CLI login, and the SDK's install command and first lines. One agent credential serves both.
import type { useIntl } from "react-intl";
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

/** The prompt an existing agent is given: install the CLI, sign in as this agent, ask for the credential. */
export function existingAgentPrompt(agent: Created, formatMessage: ReturnType<typeof useIntl>["formatMessage"]): string {
  return [
    formatMessage({ id: "agent.createExternal.promptIntro" }, { name: agent.name }),
    "",
    formatMessage({ id: "agent.createExternal.promptInstall" }),
    "npm i -g @botiverse/raft@latest",
    "",
    formatMessage({ id: "agent.createExternal.promptLogin" }),
    `raft agent login --server ${getServerUrl()} --agent ${agent.id} --profile-slug ${externalProfileSlug(agent)}`,
    "",
    formatMessage({ id: "agent.createExternal.promptCredential" }),
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
