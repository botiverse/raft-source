import { useEffect, useState } from "react";
import api from "../src/api/client";
import { ExternalAgentConnectionCard } from "../src/features/agent/ExternalAgentConnectionCard";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent, ExternalAgentStatus } from "../src/store/agentStore";
import { useServerStore } from "../src/store/serverStore";

// #wg-external-agent-ux:#2 step 3 for Jasper: an external agent's "External setup" and Credentials on its page,
// in each state (`?case=…`), as wide as the window: the agent page on a desktop, or a phone. The API is mocked.

export const EXTERNAL_AGENT_PAGE_CASE_IDS = [
  "components.agent.external-page.no-credential",
  "components.agent.external-page.existing-waiting",
  "components.agent.external-page.sdk-waiting",
  "components.agent.external-page.online",
  "components.agent.external-page.online-expanded",
  "components.agent.external-page.offline",
  "components.agent.external-page.disconnected",
  "components.agent.external-page.not-creator",
  "components.agent.external-page.replace-confirm",
  "components.agent.external-page.revoke-confirm",
  "components.agent.external-page.just-created",
] as const;

const AGENT_ID = "6f2c9e41-8b3d-4a57-9c1e-2d7f0a8b5e13";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const CLI = { id: "cred-cli", maskedToken: "sk_agent_7338e***", name: "MacBook-Pro", createdAt: ago(60 * 20), lastUsedAt: ago(3), revokedAt: null };
const PAGE = { id: "cred-page", maskedToken: "sk_agent_91aa0***", name: "Created on this page", createdAt: ago(60 * 19), lastUsedAt: null, revokedAt: null };

type Setup = { status: ExternalAgentStatus; credentials: unknown[]; seenMinutesAgo: number | null; canIssue: boolean; press: string[] };

function setupFor(caseId: string): Setup {
  const name = caseId.split(".").pop();
  const base: Setup = {
    status: { setupState: "credential_minted", credentialLastUsedAt: null, lastActivityAt: null, externalSetupMethod: "existing_agent" },
    credentials: [PAGE],
    seenMinutesAgo: null,
    canIssue: true,
    press: [],
  };
  switch (name) {
    case "no-credential": return { ...base, status: { ...base.status, setupState: "waiting_for_login" }, credentials: [] };
    case "sdk-waiting": return { ...base, status: { ...base.status, externalSetupMethod: "sdk" } };
    case "online": return { ...base, status: { ...base.status, setupState: "connected", credentialLastUsedAt: ago(3), lastActivityAt: ago(3) }, credentials: [CLI, PAGE], seenMinutesAgo: 0 };
    case "online-expanded": return { ...base, status: { ...base.status, setupState: "connected", credentialLastUsedAt: ago(3), lastActivityAt: ago(3), externalSetupMethod: "sdk" }, credentials: [CLI, PAGE], seenMinutesAgo: 0, press: ["external-agent-how-it-connects"] };
    case "offline": return { ...base, status: { ...base.status, setupState: "connected", credentialLastUsedAt: ago(95), lastActivityAt: ago(95) }, credentials: [CLI, PAGE], seenMinutesAgo: 95 };
    case "disconnected": return { ...base, status: { ...base.status, setupState: "disconnected" }, credentials: [] };
    case "not-creator": return { ...base, canIssue: false };
    case "replace-confirm": return { ...base, press: ["external-agent-create-credential"] };
    case "just-created": return { ...base, status: { ...base.status, setupState: "waiting_for_login" }, credentials: [CLI], press: ["external-agent-create-credential"] };
    case "revoke-confirm": return { ...base, status: { ...base.status, setupState: "connected", credentialLastUsedAt: ago(3), lastActivityAt: ago(3) }, credentials: [CLI, PAGE], seenMinutesAgo: 0, press: ["external-agent-credential-menu", "external-agent-credential-revoke"] };
    default: return base;
  }
}

function prime(setup: Setup): Agent {
  const agent = {
    id: AGENT_ID,
    name: "Nathan",
    displayName: "Nathan",
    runtime: "external",
    external: true,
    status: "active",
    lastSeenAt: setup.seenMinutesAgo === null ? null : ago(setup.seenMinutesAgo),
    creatorType: "user",
    creatorId: "visual-olive",
    creator: { id: "visual-olive", type: "human", name: "olive", displayName: "Olive", avatarUrl: null },
  } as unknown as Agent;
  useServerStore.setState({ current: { id: "visual-server", name: "Raft", slug: "raft", ownerId: "visual-user", role: "owner", plan: "pro" }, members: [] } as never);
  let created = false;
  // Once a credential is made, the server answers "credential minted" (it waits for its first use).
  useAgentStore.setState({ agents: [agent], fetchExternalAgentStatus: async () => (created && setup.status.setupState === "waiting_for_login" ? { ...setup.status, setupState: "credential_minted" } : setup.status) } as never);
  api.get = (async () => ({ data: { agentId: AGENT_ID, credentials: created ? [...setup.credentials, { ...PAGE, id: "visual-cred", createdAt: ago(0) }] : setup.credentials } })) as unknown as typeof api.get;
  api.post = (async () => {
    created = true;
    return { data: { agentId: AGENT_ID, credentialId: "visual-cred", apiKey: "sk_agent_visual-example-not-a-key" } };
  }) as unknown as typeof api.post;
  api.put = (async (_url: string, body?: unknown) => ({ data: body })) as unknown as typeof api.put;
  api.delete = (async () => ({ data: {} })) as unknown as typeof api.delete;
  return agent;
}

function press(testId: string) {
  (document.querySelector(`[data-testid='${testId}']`) as HTMLElement | null)?.click();
}

export function ExternalAgentPageCase({ caseId }: { caseId: string }) {
  const [setup] = useState(() => setupFor(caseId));
  const [agent] = useState(() => prime(setup));
  const [status, setStatus] = useState(setup.status);
  useEffect(() => {
    const timers = setup.press.map((testId, index) => window.setTimeout(() => press(testId), 300 * (index + 1)));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [setup]);
  return (
    <div className="min-h-screen bg-layer-canvas p-3 md:p-6">
      <div className="w-full max-w-[1280px] rounded-container border border-line bg-layer-surface px-4 py-4">
        <ExternalAgentConnectionCard agent={agent} status={status} canIssueCredentials={setup.canIssue} onStatus={setStatus} />
      </div>
    </div>
  );
}
