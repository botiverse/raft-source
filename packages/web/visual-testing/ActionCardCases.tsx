import { useState } from "react";
import { asServerId, buildActionCardPresentation, buildActionCardSpec } from "@botiverse/raft-shared";
import type { ActionCardMetadata, StoredActionCardAction } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { ActionCard } from "../src/components/actions/ActionCard";
import type { McpConnectionAuthorizationView } from "../src/components/settings/mcpApps/mcpAppApi";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

// Action cards for Kirby's review, the real ActionCard (`?case=…`).
//
// expired-agent: a card no one completed within its 30 days (#proj-apps:#40),
// as the web reads a card the server serves `expired` with its deadline
// (`expiresAt`). The case opens it (the visual suite clicks its toggle): Expired
// in grey, when it expired and what to do under the title, its facts, and no
// buttons.
//
// mcp-connect: a connect card waiting for a grant (#proj-apps:#41), for a viewer
// who manages the server: its title names the App and the agent, no notice, and
// the picker with its Grant in the ink border, no pink.
//
// agent-create: a card to create an agent (#proj-apps:#41): its title names the
// agent to be, with no @.
//
// agent-migrate: an agent asks to be moved to another computer (agent:migrate,
// xxchan's v3 design): its title names the agent, the suggested computer as a
// plain field, the Reason, and Move agent in the ink border, no pink.

const EXPIRED_CASE = "components.action-card.expired-agent";
const MCP_CONNECT_CASE = "components.action-card.mcp-connect";
const AGENT_CREATE_CASE = "components.action-card.agent-create";
const AGENT_MIGRATE_CASE = "components.action-card.agent-migrate";
export const ACTION_CARD_CASE_IDS = [EXPIRED_CASE, MCP_CONNECT_CASE, AGENT_CREATE_CASE, AGENT_MIGRATE_CASE] as const;

const SERVER_ID = asServerId("0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9");
const CHANNEL_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const VIEWER_ID = "7c8d9e0f-1a2b-4c3d-8e5f-607182930415";
const HUMAN_ID = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const AGENT_ID = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";
const APP_ID = "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f607182";
const MESSAGE_ID = "visual-action-card";
const COMPUTER_ID = "5a6b7c8d-9e0f-4a1b-8c3d-4e5f60718293";

const EXPIRED_ACTION = {
  type: "channel:create", name: "launch-week", description: "Launch week", visibility: "private",
  initialHumans: [HUMAN_ID, VIEWER_ID], initialAgents: [AGENT_ID], draftHint: "You asked for a launch room before the release.",
} as StoredActionCardAction;

const MCP_CONNECT_ACTION = {
  type: "integration:connect_mcp", mcpServerId: APP_ID, agentId: AGENT_ID, reason: "login_required", revision: 1,
  draftHint: "I need Notion for the launch plan.",
} as StoredActionCardAction;

const AGENT_CREATE_ACTION = {
  type: "agent:create", name: "Scribe", description: "Takes meeting notes.", draftHint: "You asked for a note taker.",
} as StoredActionCardAction;

const AGENT_MIGRATE_ACTION = {
  type: "agent:migrate", agentId: AGENT_ID, suggestedComputer: COMPUTER_ID,
  draftHint: "My computer has been offline since 07:40, so I can't run tonight's eval. Mac mini is online.",
} as StoredActionCardAction;

function metadata(action: StoredActionCardAction, state: ActionCardMetadata["state"], names?: { mcpApp?: string; agents: Record<string, string> }): ActionCardMetadata {
  return {
    kind: "action-card",
    state,
    sourceServerId: SERVER_ID,
    confirmationVersion: 1,
    action,
    presentation: { ...buildActionCardPresentation(action), card: buildActionCardSpec(action, names ? { names } : {}) as never },
  };
}

const METADATA: Record<(typeof ACTION_CARD_CASE_IDS)[number], ActionCardMetadata> = {
  [EXPIRED_CASE]: { ...metadata(EXPIRED_ACTION, "expired"), expiresAt: "2026-10-06T09:41:00.000Z" },
  [MCP_CONNECT_CASE]: metadata(MCP_CONNECT_ACTION, "prepared", { mcpApp: "Notion", agents: { [AGENT_ID]: "Scout" } }),
  [AGENT_CREATE_CASE]: metadata(AGENT_CREATE_ACTION, "prepared"),
  [AGENT_MIGRATE_CASE]: metadata(AGENT_MIGRATE_ACTION, "prepared", { agents: { [AGENT_ID]: "Scout" } }),
};

/** What the connect card's picker reads for a viewer who manages the server. */
const MCP_AUTHORIZATION = {
  mcpServerId: APP_ID,
  agentId: AGENT_ID,
  viewerRole: "server_manager",
  app: { name: "Notion", authKind: "oauth" },
  candidates: [
    { connectionId: "5a6b7c8d-9e0f-4a1b-8c3d-4e5f60718293", name: "Team Notion", isServerDefault: true, status: "ready" },
    { connectionId: "6b7c8d9e-0f1a-4b2c-9d4e-5f6071829304", name: "Ava's Notion", isServerDefault: false, status: "ready" },
  ],
  binding: { present: false, visibleToViewer: false, connectionId: null },
  canAuthorizeNew: true,
  canSetServerDefault: true,
  newConnectionPinnable: true,
  pendingGrant: null,
} as McpConnectionAuthorizationView;

function primeStores(metadata: ActionCardMetadata) {
  useAuthStore.setState({ user: { id: VIEWER_ID, name: "ava", displayName: "Ava" } } as never);
  useServerStore.setState({
    current: { id: SERVER_ID, slug: "acme", name: "Acme", role: "owner", plan: "pro" },
    members: [{ userId: HUMAN_ID, name: "wendy", displayName: "Wendy" }, { userId: VIEWER_ID, name: "ava", displayName: "Ava" }],
  } as never);
  useAgentStore.setState({ agents: [{ id: AGENT_ID, name: "scout", displayName: "Scout" }] } as never);
  // The viewer (an owner) lists the server's computers: a card names a computer only from this list.
  useMachineStore.setState({ machines: [{ id: COMPUTER_ID, name: "Mac mini", status: "online", isComputer: true }] } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, serverId: SERVER_ID, name: "general", type: "channel", joined: true, archivedAt: null }],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    currentChannelId: CHANNEL_ID,
    channelMessages: { [CHANNEL_ID]: [{ id: MESSAGE_ID, channelId: CHANNEL_ID, actionMetadata: metadata }] },
    messages: [{ id: MESSAGE_ID, channelId: CHANNEL_ID, actionMetadata: metadata }],
  } as never);
  api.get = (async (url: string) => {
    if (url === `/mcp/servers/${APP_ID}/connection-authorization`) return { data: MCP_AUTHORIZATION };
    throw new Error(`visual case: unexpected GET ${url}`);
  }) as typeof api.get;
}

export function ActionCardCase({ caseId }: { caseId: (typeof ACTION_CARD_CASE_IDS)[number] }) {
  const cardMetadata = METADATA[caseId];
  const [ready] = useState(() => {
    primeStores(cardMetadata);
    return true;
  });
  if (!ready) return null;
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex flex-col gap-4 p-4" style={{ width: 640 }}>
        <div className="flex min-w-0 gap-3">
          <div className="size-9 shrink-0 rounded-full bg-fill-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-sm"><span className="font-semibold">Scout</span><span className="text-xs text-foreground-hint">09:41</span></div>
            <ActionCard messageId={MESSAGE_ID} metadata={cardMetadata} channelId={CHANNEL_ID} />
          </div>
        </div>
      </div>
    </main>
  );
}
