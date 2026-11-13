import { useState } from "react";
import { useIntl } from "react-intl";
import { PanelHeader, PanelHeaderContent, PanelHeading, PanelStatus, PanelTitle } from "@botiverse/raft-ui";
import api from "../src/api/client";
import { AgentContextViewBody, AgentContextViewPage } from "../src/components/agentContextView/AgentContextViewPanel";
import { openAgentContextViewFor } from "../src/components/agentContextView/agentContextViewState";
import { AgentContextViewVerifiedMark } from "../src/components/agentContextView/AgentContextViewVerifiedMark";
import { useMachineStore } from "../src/store/machineStore";
import type { OpenAgentContextView } from "../src/store/agentContextViewStore";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

// View Context's messages (#wg-ax, Kirby for qizhi-wang; the timeline, B,
// 2026-11-06): the panel as a desktop side column (light, dark) and as the
// phone page (390), on a context like the one in qizhi-wang's screenshot: a
// system update written in Markdown with long paths, a user message Raft
// delivered (a message header, an inbox and a task notice: one card), an
// agent turn with hidden thinking and an Agent call with its result, a
// failed Bash step, a nested Edit call, and the send step. The fixture only uses the panel's public
// entry points, so the same cases render before and after a redesign of the
// rows (compare the two commits' shots).
//
// How far a restore was checked (#13297, #wg-ax:#9): `verified` (the
// Verified tag on the head's title, as ChannelSideCard's PanelStatus places
// it), `count_matched` (a Kimi restore: the neutral note above the context)
// and one refusal retrying can't change, `newer_session_format`, with its
// Open computer for a viewer who can open that Computer.

export const AGENT_CONTEXT_VIEW_CASE_IDS = [
  "components.agent-context-view.messages",
  "components.agent-context-view.messages.dark",
  "components.agent-context-view.messages.phone",
  "components.agent-context-view.verified",
  "components.agent-context-view.count-matched",
  "components.agent-context-view.newer-session-format",
] as const;

const AGENT_ID = "visual-kirby";
const SERVER_ID = "visual-server";
const PATH = "/home/ubuntu/.raft/agents/06608b1a-f73a-4ccf-95ee-ae63da57b496";

const VIEW: OpenAgentContextView = {
  agentId: AGENT_ID,
  messageId: "visual-message",
  agentName: "Kirby",
  agentAvatarUrl: null,
  content: "Started the new-version page; I'll post screenshots when it's up.",
  createdAt: "2026-11-05T10:44:00.000Z",
  conversationId: "visual-channel",
  hostChannelId: "visual-channel",
};

/** What Raft delivered to the agent: the envelope, a message header, an inbox notice and a task notice (the daemon's formats). */
const DELIVERY = [
  "New messages received:",
  "",
  "[target=#proj-web msg=3f2a91c0 time=2026-11-05 10:41:00Z type=human] @qizhi-wang: can you make the **View Context** panel easier to read?",
  "  │ Docs: https://raft-design.botiverse.build/components/code-block",
  "",
  "[Raft inbox notice:",
  "Inbox update: 2 messages pending your read across all conversations; 1 changed target",
  "#proj-web  pending: 2 messages · latest sender @mira · latest msg=5b1c22d0",
  "  latest @mira: \"+1, the tool calls are the hardest part to scan\" (preview; still unread, full text: raft message read --target \"#proj-web\" --unread)",
  "]",
  "These messages have not been read. Choose when to read them: `raft message read --target <target> --unread` reads one conversation's unread messages; `raft message check` reads all of them.",
  "",
  "[Raft task notice: 1 task is waiting on you.",
  "#proj-web:#42 [todo] View Context timeline — newly yours (assigned by @qizhi-wang)",
  "No change → no reply needed.]",
  "",
  "Respond as appropriate. Complete all your work before stopping.",
].join("\n");

const CONTEXT = {
  runtime: "claude",
  model: "claude-opus-4-5",
  sessionId: "visual-session",
  requestAt: "2026-11-05T10:43:58.000Z",
  messageId: VIEW.messageId,
  tokens: { input: 2118, cacheRead: 182184, total: 184302 },
  system: [{ text: "You are Kirby, the web and design owner of this server.\n\n## Rules\n- Compose from raft-ui first.\n- Use design tokens only." }],
  tools: [
    { name: "Agent", description: "Launch a sub-agent for a task.", inputSchema: { type: "object" } },
    { name: "Bash", description: "Run a command.", inputSchema: { type: "object" } },
    { name: "Edit", description: "Edit a file.", inputSchema: { type: "object" } },
  ],
  messages: [
    {
      role: "system",
      parts: [{ kind: "text", text: `# Environment update\n - Primary working directory: ${PATH}/slock-ro (was ${PATH})\n - See \`packages/web/src/components/agentContextView\` and **AGENTS.md**.` }],
    },
    {
      role: "user",
      parts: [{ kind: "text", text: DELIVERY }],
    },
    {
      role: "assistant",
      parts: [
        { kind: "thinking", text: null },
        { kind: "text", text: "Starting a sub-agent for the new-version page." },
        {
          kind: "tool_use",
          toolName: "Agent",
          toolUseId: "toolu_01GsMS2UzGf1Di3BBrd1YHdm",
          input: {
            description: "Slock web new-version page",
            subagent_type: "general-purpose",
            run_in_background: true,
            prompt: `Build the new-version page in ${PATH}/wt-new-version.\nRead packages/web/CLAUDE.md first.\nCompose from raft-ui.\nKeep to design tokens.\nAdd visual cases.\nRun the targeted tests.\nCommit; do not push.\nReport the files changed.\nList open questions.`,
          },
        },
      ],
    },
    {
      role: "user",
      parts: [{ kind: "tool_result", toolName: null, toolUseId: "toolu_01GsMS2UzGf1Di3BBrd1YHdm", output: "Async agent launched successfully.\nagentId: a1b2c3d4 (use SendMessage to continue it)", isError: false }],
    },
    {
      role: "assistant",
      parts: [{ kind: "tool_use", toolName: "Bash", toolUseId: "toolu_01Test", input: { command: "pnpm --filter @botiverse/raft-web exec vitest run tests/agentContextView.behavior.test.tsx", description: "Run the View Context tests" } }],
    },
    {
      role: "user",
      parts: [{ kind: "tool_result", toolName: "Bash", toolUseId: "toolu_01Test", output: Array.from({ length: 40 }, (_, line) => (line === 39 ? "Tests  1 failed | 72 passed (73)" : `✓ case ${line}`)).join("\n"), isError: true }],
    },
    {
      role: "assistant",
      parts: [{
        kind: "tool_use",
        toolName: "Edit",
        toolUseId: "toolu_01Edit",
        input: { file_path: `${PATH}/wt-ctx-look/packages/web/src/components/agentContextView/AgentContextViewText.tsx`, edits: [{ old_string: "variant=\"ghost\"", new_string: "className=\"text-caption\"" }] },
      }],
    },
    {
      role: "user",
      parts: [{ kind: "tool_result", toolName: "Edit", toolUseId: "toolu_01Edit", output: "The file has been updated.", isError: false }],
    },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "Posting the update." },
        { kind: "tool_use", toolName: "Bash", toolUseId: "toolu_01Send", input: { command: "raft message send --channel '#proj-web' \"Started the new-version page; I'll post screenshots when it's up.\"" } },
      ],
    },
  ],
  compaction: { happened: false },
  trigger: { messageIndex: 8, partIndex: 1, toolUseId: "toolu_01Send" },
  redactions: {},
  source: { kind: "native", format: "claude-jsonl", version: "2.1.304" },
};

const STATUS = {
  runtime: "claude",
  computer: { id: "visual-computer", name: "kirby-mbp" },
  computerOwner: { id: "visual-user", name: "Owner" },
  retainedSince: "2026-10-06T00:00:00.000Z",
  retentionDays: 30,
  state: "available",
};

/** What the view answers in each case: the context, checked as the case says, or a refusal. */
function viewBody(caseId: string) {
  if (caseId.endsWith(".newer-session-format")) {
    return { ok: false, reason: "newer_session_format", computer: STATUS.computer, computerOwner: STATUS.computerOwner };
  }
  if (caseId.endsWith(".verified")) return { ok: true, context: { ...CONTEXT, verification: "verified" } };
  if (caseId.endsWith(".count-matched")) {
    return { ok: true, context: { ...CONTEXT, runtime: "kimi-sdk", model: "kimi-k2", source: { kind: "native", format: "kimi-wire", version: "1.3" }, verification: "count_matched" } };
  }
  return { ok: true, context: CONTEXT };
}

function prime(caseId: string) {
  useMachineStore.setState({ machines: [{ id: STATUS.computer.id, name: STATUS.computer.name }] } as never);
  useAuthStore.setState({ user: { id: "visual-user", name: "owner", displayName: "Owner" } } as never);
  useServerStore.setState({ current: { id: SERVER_ID, name: "Raft", slug: "raft", ownerId: "visual-user", role: "owner", plan: "pro" }, members: [] } as never);
  api.get = (async (url: string) => {
    if (url.endsWith("/context-view/status")) return { data: STATUS };
    if (url.endsWith(`/messages/${VIEW.messageId}/context`)) return { data: JSON.stringify(viewBody(caseId)) };
    if (url.endsWith("/context-views")) return { data: { views: [] } };
    return { data: {} };
  }) as typeof api.get;
  openAgentContextViewFor(VIEW);
}

function Column({ caseId }: { caseId: string }) {
  const { formatMessage } = useIntl();
  return (
    <main className="flex h-screen justify-end bg-layer-sidebar">
      <section data-visual-case={caseId} className="flex h-full w-[440px] min-w-0 flex-col border-s border-line-seam bg-layer-canvas">
        <PanelHeader>
          <PanelHeaderContent>
            <PanelHeading>
              <PanelTitle render={<h2>{formatMessage({ id: "agentContextView.title" })}</h2>} />
              {caseId.endsWith(".verified") ? <PanelStatus><AgentContextViewVerifiedMark source="native" /></PanelStatus> : null}
            </PanelHeading>
          </PanelHeaderContent>
        </PanelHeader>
        <AgentContextViewBody view={VIEW} />
      </section>
    </main>
  );
}

export function AgentContextViewCase({ caseId }: { caseId: string }) {
  const [ready] = useState(() => {
    prime(caseId);
    return true;
  });
  if (!ready) return null;
  if (caseId.endsWith(".phone")) {
    return (
      <main data-visual-case={caseId} className="min-h-screen bg-layer-canvas">
        <AgentContextViewPage />
      </main>
    );
  }
  return <Column caseId={caseId} />;
}
