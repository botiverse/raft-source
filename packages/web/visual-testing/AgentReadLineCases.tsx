import { useMemo } from "react";
import { AgentReadProgressContext } from "../src/components/message/agentReadProgressContext";
import type { AgentReadFace, AgentReadProgressModel } from "../src/components/message/agentReadProgressContext";
import {
  AGENT_READ_MAX_FACES_NARROW,
  ownLatestMessageId,
  placeAgentReads,
  projectAgentReadStatus,
  relevantReadAgentIds,
} from "../src/store/agentReadProgressDomain";
import type { Message } from "../src/store/messageStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";
import { VisualMessageRow } from "./VisualMessageRow";
import { requestedContentLang } from "./VisualTestingCases";
import type { VisualMessageRowFixture } from "./VisualTestingCases";

// The agent read line under your latest message (agent read progress, task
// #proj-raft-ui:#212): the real MessageItem rows from your latest message to
// the end of the conversation, with the agents' faces and, only when the
// message will not reach one of them, the line under it. The model is what
// useAgentReadProgress builds, from the same pure projection
// (agentReadProgressDomain), over the fixture below: no server, no flags.
//
// - muted-channel: #design, Niko muted the channel and has not read it
//   ("Muted: Niko · Mention them to reach them"); Cindy's face: she read it.
// - stopped-following-thread: a thread under #design, Niko stopped following
//   ("Stopped following: Niko · …"); Cindy read it.
// - many-narrow: four muted agents at 320 wide: three names and +1. The names
//   take the room left over (an ellipsis in zh); in English not even a name's
//   first letters fit, so the segment shows "Muted: 4 agents" and the hint
//   loses its tail.
// - all-reachable: Niko muted the channel but read it, Cindy replied: faces,
//   and no line.
//
// Each id is one shot (the suite shoots a case's first variant only, in its
// own theme), so light/dark and zh-CN/en are ids of their own: `.dark`, `.en`.

export const AGENT_READ_LINE_CASE_PREFIX = "components.thread.message.agent-read-line";

const VARIANTS = ["muted-channel", "stopped-following-thread", "many-narrow", "all-reachable"] as const;
type AgentReadLineVariant = (typeof VARIANTS)[number];
const SUFFIXES = ["", ".dark", ".en", ".en.dark"] as const;

export const AGENT_READ_LINE_CASE_IDS: readonly string[] = VARIANTS.flatMap((variant) =>
  SUFFIXES.map((suffix) => `${AGENT_READ_LINE_CASE_PREFIX}.${variant}${suffix}`));

const VIEWER = fixtureData.humans.owner;
const CHANNEL_ID = fixtureData.channels.design.id;
const THREAD_CHANNEL_ID = "thread-visual-read-line-parent";
const THREAD_PARENT_MESSAGE_ID = "visual-read-line-parent";

type FixtureAgent = { id: string; name: string; avatarUrl: string };

const CINDY: FixtureAgent = {
  id: fixtureData.agents.cindy.id,
  name: fixtureData.agents.cindy.displayName,
  avatarUrl: fixtureData.agents.cindy.avatar,
};
const PRODUCT_UX: FixtureAgent = {
  id: fixtureData.agents.productUx.id,
  name: fixtureData.agents.productUx.displayName,
  avatarUrl: "pixel:wizard",
};
const NIKO: FixtureAgent = { id: "visual-read-agent-niko", name: "Niko", avatarUrl: "pixel:fox" };
const LAGOON: FixtureAgent = { id: "visual-read-agent-lagoon", name: "Lagoon", avatarUrl: "pixel:penguin" };
const JASPER: FixtureAgent = { id: "visual-read-agent-jasper", name: "Jasper", avatarUrl: "pixel:owl" };
const AGENTS = new Map([CINDY, PRODUCT_UX, NIKO, LAGOON, JASPER].map((agent) => [agent.id, agent]));

const COPY = {
  en: {
    earlier: "The release branch is cut.",
    own: "Can someone take the release checklist before 18:00?",
    thread: "Picking this back up: the CSV export still drops the last row.",
    reply: "On it. I'll post the checklist here.",
  },
  zh: {
    earlier: "发布分支已经切好了。",
    own: "谁能在 18:00 前接一下发布清单？",
    thread: "接着说：CSV 导出还是会丢最后一行。",
    reply: "我来，清单稍后发在这里。",
  },
} as const;
type Copy = (typeof COPY)[keyof typeof COPY];

const OWN_AT = "2026-06-22T02:30:00.000Z";
const REPLY_AT = "2026-06-22T02:35:00.000Z";
const EARLIER_AT = "2026-06-22T02:10:00.000Z";

function agentMessage(id: string, seq: number, agent: FixtureAgent, content: string, channelId: string, createdAt = EARLIER_AT): Message {
  return { id, seq, channelId, senderType: "agent", senderId: agent.id, senderName: agent.name, content, createdAt };
}

function ownMessage(id: string, seq: number, content: string, channelId: string): Message {
  return { id, seq, channelId, senderType: "user", senderId: VIEWER.id, senderName: VIEWER.displayName, content, createdAt: OWN_AT };
}

type Scenario = {
  channelId: string;
  inThread: boolean;
  /** The conversation's tail, oldest first; rows render from your latest message on. */
  messages: Message[];
  readUpTo: ReadonlyMap<string, number>;
  muted: ReadonlySet<string>;
  stoppedFollowing: ReadonlySet<string>;
  /** The projection must say a line (true) or none (false); a change fails the capture. */
  expectLine: boolean;
  width: number;
};

function scenario(variant: AgentReadLineVariant, copy: Copy): Scenario {
  const base = { inThread: false, channelId: CHANNEL_ID, muted: new Set<string>(), stoppedFollowing: new Set<string>(), expectLine: true, width: 374 };
  switch (variant) {
    case "muted-channel":
      return {
        ...base,
        messages: [
          agentMessage("visual-read-m1", 41, NIKO, copy.earlier, CHANNEL_ID),
          agentMessage("visual-read-m2", 42, CINDY, copy.earlier, CHANNEL_ID),
          ownMessage("visual-read-own", 43, copy.own, CHANNEL_ID),
        ],
        readUpTo: new Map([[NIKO.id, 42], [CINDY.id, 43]]),
        muted: new Set([NIKO.id]),
      };
    case "stopped-following-thread":
      return {
        ...base,
        channelId: THREAD_CHANNEL_ID,
        inThread: true,
        messages: [
          agentMessage("visual-read-t1", 7, NIKO, copy.earlier, THREAD_CHANNEL_ID),
          agentMessage("visual-read-t2", 8, CINDY, copy.earlier, THREAD_CHANNEL_ID),
          ownMessage("visual-read-own", 9, copy.thread, THREAD_CHANNEL_ID),
        ],
        readUpTo: new Map([[NIKO.id, 8], [CINDY.id, 9]]),
        stoppedFollowing: new Set([NIKO.id]),
      };
    case "many-narrow":
      return {
        ...base,
        // The 320 viewport minus the 16px inset on each side.
        width: 288,
        messages: [
          agentMessage("visual-read-n1", 20, CINDY, copy.earlier, CHANNEL_ID),
          agentMessage("visual-read-n2", 21, JASPER, copy.earlier, CHANNEL_ID),
          agentMessage("visual-read-n3", 22, LAGOON, copy.earlier, CHANNEL_ID),
          agentMessage("visual-read-n4", 23, NIKO, copy.earlier, CHANNEL_ID),
          agentMessage("visual-read-n5", 24, PRODUCT_UX, copy.earlier, CHANNEL_ID),
          ownMessage("visual-read-own", 25, copy.own, CHANNEL_ID),
        ],
        readUpTo: new Map([[CINDY.id, 25], [JASPER.id, 21], [LAGOON.id, 22], [NIKO.id, 23], [PRODUCT_UX.id, 24]]),
        muted: new Set([JASPER.id, LAGOON.id, NIKO.id, PRODUCT_UX.id]),
      };
    case "all-reachable":
      return {
        ...base,
        expectLine: false,
        messages: [
          agentMessage("visual-read-r1", 41, NIKO, copy.earlier, CHANNEL_ID),
          ownMessage("visual-read-own", 42, copy.own, CHANNEL_ID),
          agentMessage("visual-read-r3", 43, CINDY, copy.reply, CHANNEL_ID, REPLY_AT),
        ],
        // Niko muted the channel but has read it; Cindy replied.
        readUpTo: new Map([[NIKO.id, 42], [CINDY.id, 43]]),
        muted: new Set([NIKO.id]),
      };
  }
}

/** The model useAgentReadProgress builds for this conversation (phone width: two faces before +N). */
function buildModel(caseId: string, value: Scenario): AgentReadProgressModel {
  const relevant = relevantReadAgentIds(value.messages, value.readUpTo, []);
  const statusMessageId = ownLatestMessageId(value.messages, VIEWER.id, false);
  const agentsById = new Map<string, AgentReadFace>();
  for (const agentId of relevant) {
    const agent = AGENTS.get(agentId);
    if (!agent) throw new Error(`${caseId}: no fixture agent ${agentId}`);
    agentsById.set(agentId, {
      agentId,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      working: false,
    });
  }
  const facesByMessageId = new Map<string, AgentReadFace[]>();
  for (const [messageId, agentIds] of placeAgentReads(value.messages, value.readUpTo, relevant)) {
    facesByMessageId.set(messageId, agentIds.map((agentId) => agentsById.get(agentId)!));
  }
  const entries = projectAgentReadStatus(
    value.messages,
    statusMessageId,
    value.readUpTo,
    relevant,
    [],
    [],
    value.stoppedFollowing,
    value.muted,
  );
  if (Boolean(entries) !== value.expectLine) {
    throw new Error(`${caseId}: the projection ${entries ? "flags agents" : "flags no one"}; the case expects ${value.expectLine ? "a line" : "no line"}`);
  }
  return {
    scopeId: value.channelId,
    maxFaces: AGENT_READ_MAX_FACES_NARROW,
    facesByMessageId,
    status: statusMessageId && entries ? { messageId: statusMessageId, entries } : null,
    agentsById,
  };
}

function rowFixtures(value: Scenario, statusMessageId: string): VisualMessageRowFixture[] {
  const start = value.messages.findIndex((message) => message.id === statusMessageId);
  return value.messages.slice(start).map((message) => ({
    message,
    previewSenderAgent: message.senderType === "agent",
    hideThreadActions: value.inThread,
    parentChannelId: value.inThread ? CHANNEL_ID : undefined,
    parentMessageId: value.inThread ? THREAD_PARENT_MESSAGE_ID : undefined,
    showAgentReadStatus: message.id === statusMessageId,
    agentReadFaces: true,
  }));
}

function variantOf(caseId: string): AgentReadLineVariant {
  const rest = caseId.slice(AGENT_READ_LINE_CASE_PREFIX.length + 1);
  const variant = VARIANTS.find((candidate) => rest === candidate || rest.startsWith(`${candidate}.`));
  if (!variant) throw new Error(`${caseId}: not an agent read line case`);
  return variant;
}

export function AgentReadLineCase({ caseId }: { caseId: string }) {
  const view = useMemo(() => {
    const value = scenario(variantOf(caseId), requestedContentLang().startsWith("zh") ? COPY.zh : COPY.en);
    const model = buildModel(caseId, value);
    const statusMessageId = ownLatestMessageId(value.messages, VIEWER.id, false);
    if (!statusMessageId) throw new Error(`${caseId}: the fixture has no message of yours`);
    return { model, rows: rowFixtures(value, statusMessageId), width: value.width };
  }, [caseId]);

  return (
    <main className="min-h-screen bg-layer-canvas p-4 font-display text-foreground">
      <div data-visual-case={caseId} className="flex flex-col" style={{ width: view.width, overflow: "hidden" }}>
        <AgentReadProgressContext.Provider value={view.model}>
          {view.rows.map((fixture) => <VisualMessageRow key={fixture.message.id} fixture={fixture} />)}
        </AgentReadProgressContext.Provider>
      </div>
    </main>
  );
}
