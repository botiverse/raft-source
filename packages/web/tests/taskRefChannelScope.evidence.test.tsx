import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import MessageItem from "../src/components/message/MessageItem";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useServerStore } from "../src/store/serverStore";
import type { Task } from "../src/store/taskStore";
import { useTaskStore } from "../src/store/taskStore";

// ⚠️ EVIDENCE ONLY — these tests pin CURRENT behaviour for #proj-task task #43.
// They deliberately do not assert what the behaviour *should* be: whether to fix
// this by narrowing the render decision (ⓐ) or by making task numbers
// server-scoped (ⓑ) is @stdrc's and @Noel's call, not this file's.
//
// The defect they document (found reading MessageItem.tsx, reported in
// #proj-message msg 760d16b3, independently re-read by @Noel and @Stone) is a
// SCOPE MISMATCH between two halves that each look correct alone:
//
//   render decision  knownTaskNumbers = channelTasks ∪ serverTasks   → SERVER-wide
//   click resolution taskContextChannelId = parentChannelId
//                                          || message.channelId      → CHANNEL-local
//
// So a number renders as a link because a task with that number exists SOMEWHERE
// in the server, and then opens whatever that number happens to be in the channel
// you are reading. Cases 1 and 2 pin one half each and both pass today; case 3 is
// the conjunction, and is the only one that can change colour when ⓐ or ⓑ lands.

// MUTATION MATRIX (run 2026-08-18, each mutation applied to MessageItem.tsx,
// asserted to have landed, then reverted). This is what the three teeth are FOR:
//
//   mutation applied to the render gate            t1   t2   t3
//   ─────────────────────────────────────────────  ───  ───  ───
//   none (behaviour as it ships today)             ✔    ✔    ✔
//   ⓐ drop `serverTasks` from knownTaskNumbers     ✔    ✖    ✔   ← see below
//   bare #N never links (only explicit `task #N`)  ✔    ✖    ✖
//
// ⭐ The middle row is the finding, and it is not what I expected when I wrote
// these. ⓐ — narrowing the render decision to the current channel — does NOT
// change test 3 at all, because in test 3 the channel being read HAS its own
// card with that number. ⓐ makes the two halves agree, which removes the
// dead-link case (t2), but a bare `#108` written in one channel and meaning
// another channel's #108 still renders, and still resolves locally. That is the
// shape of the #108 report itself, so ⓐ alone would not have prevented it.
// Only the stronger rule — bare `#N` never links — turns test 3 red.
//
// ⚠️ Scope of that claim: these tests observe RENDER only. That the click then
// resolves to the local card is read from source (`taskContextChannelId =
// parentChannelId || message.channelId`), not exercised here. Nothing in this
// file tests the click path.

const READING_CHANNEL_ID = "channel-reading";
const OTHER_CHANNEL_ID = "channel-elsewhere";
const SHARED_TASK_NUMBER = 108;

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

function makeUser(): User {
  return {
    id: "user-current", email: "current@example.com", gravatarHash: "", name: "current-user",
    displayName: "Current User", description: null, avatarUrl: null, emailVerified: true,
    preferredLanguage: null, preferredTimezone: null, autoTranslationEnabled: false,
    preferredTimeFormat: null, preferredMessageBodyFontSize: null, referralSource: null,
    referralSourceOther: null, referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1", name: "Server", avatarUrl: null, slug: "server", ownerId: "user-current",
    onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null,
    role: "owner", createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function makeAgent(): Agent {
  return {
    id: "agent-1", name: "agent-handle", displayName: "Agent Display", avatarUrl: null,
    description: null, status: "idle", model: "gpt-5", runtime: "codex", serverRole: "member",
    runtimeConfig: null, lastRuntimeError: null, reasoningEffort: null, executionMode: "cloud",
    envVars: null, machineId: null, runtimeProfile: null, creatorType: null, creatorId: null,
    creator: null, createdAgents: [], deletedAt: null, createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function makeHuman(): ServerMember {
  return {
    userId: "human-1", email: "human@example.com", gravatarHash: "", name: "human-handle",
    displayName: "Human Display", description: null, avatarUrl: null, role: "member",
    joinedAt: "2026-07-09T00:00:00.000Z",
  };
}

function makeMessage(content: string): Message {
  return {
    id: "message-1", channelId: READING_CHANNEL_ID, senderType: "agent", senderId: "agent-1",
    senderName: "Agent Display", messageType: "chat", content,
    createdAt: "2026-07-09T00:00:00.000Z",
  } as Message;
}

/** A task carried by a message in `channelId`, numbered `taskNumber`. */
function makeTask(channelId: string, taskNumber: number, title: string): Task {
  return {
    id: `task-${channelId}-${taskNumber}`,
    messageId: `carrier-${channelId}-${taskNumber}`,
    channelId,
    taskNumber,
    title,
    status: "todo",
  } as Task;
}

function setupStores({ channelTasks, serverTasks }: { channelTasks: Task[]; serverTasks: Task[] }) {
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true } as never);
  useServerStore.setState({ current: makeServer(), members: [makeHuman()] } as never);
  useAgentStore.setState({ agents: [makeAgent()], agentActivities: {} } as never);
  useChannelStore.setState({
    channels: [{
      id: READING_CHANNEL_ID, serverId: "server-1", name: "reading", type: "regular",
      description: null, archived: false, archivedAt: null, archivedBy: null, isDefault: false,
      createdAt: "2026-07-09T00:00:00.000Z",
    }],
    dmChannels: [] as Channel[],
  } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false } as never);
  useMessageStore.setState({
    drafts: {}, channelMessages: { [READING_CHANNEL_ID]: [] },
    currentChannelId: READING_CHANNEL_ID, messages: [],
  } as never);
  useTaskStore.setState({ tasks: channelTasks, serverTasks } as never);
}

function renderWith(content: string, tasks: { channelTasks: Task[]; serverTasks: Task[] }) {
  setupStores(tasks);
  return render(
    <MemoryRouter>
      <MessageItem message={makeMessage(content)} mentionMap={new Map()} channels={[]} hideThreadActions />
    </MemoryRouter>,
  );
}

/** The rendered task chip, if the renderer decided this bare number is a task ref.
 *  NOTE: `data-task-ref` is consumed by the rehype pass and does NOT survive into
 *  the DOM, so it cannot be used to detect this — an earlier version of this file
 *  queried it and every "no link" assertion passed vacuously. The observable
 *  difference is that a claimed number becomes an <a>; an unclaimed one stays text. */
function taskRefLink(taskNumber: number): HTMLElement | null {
  const anchors = Array.from(document.querySelectorAll("a"));
  return anchors.find((a) => a.textContent?.trim() === `#${taskNumber}`) ?? null;
}

afterEach(() => {
  cleanup();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useSavedStore.setState(useSavedStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
});

// ── Half 1: the render DECISION ────────────────────────────────────────────────

test("bare #N stays plain text when no task anywhere in the server carries that number", () => {
  renderWith(`see #${SHARED_TASK_NUMBER} for context`, { channelTasks: [], serverTasks: [] });

  assert.equal(
    taskRefLink(SHARED_TASK_NUMBER),
    null,
    "bare #N must not become a task ref when the number is unknown — this is why bare PR numbers " +
      "like #6564 are NOT currently claimed as task refs",
  );
  // Positive control: the text really did render, so the assertion above is not
  // being satisfied by an empty surface.
  assert.ok(screen.getByText(/see .* for context/), "message body rendered");
  // ...and specifically that the NUMBER rendered. @Noel's catch: the regex above
  // has a `.*` in the middle, so it still matches when `#108` is dropped
  // entirely — it proves "a body rendered", not "the thing under test rendered
  // in the expected form". Without this line the null-link assertion could be
  // satisfied by a message that never contained the ref at all.
  // Verified by mutation: removing the ref from the rendered body reddens this
  // test, while the regex control above stays green.
  assert.ok(
    document.body.textContent?.includes(`#${SHARED_TASK_NUMBER}`),
    `the bare ref #${SHARED_TASK_NUMBER} must be present as TEXT — otherwise `
      + '"it is not a link" would be true for the wrong reason',
  );
});

test("bare #N becomes a task ref once ANY task in the server carries that number", () => {
  renderWith(`see #${SHARED_TASK_NUMBER} for context`, {
    channelTasks: [],
    serverTasks: [makeTask(OTHER_CHANNEL_ID, SHARED_TASK_NUMBER, "a task in a different channel")],
  });

  assert.ok(
    taskRefLink(SHARED_TASK_NUMBER),
    "the render decision consults channelTasks ∪ serverTasks, so a task in ANOTHER channel is " +
      "enough to turn this number into a link here",
  );
});

// ── Half 2 + the conjunction: DECISION is server-wide, RESOLUTION is channel-local ──

test("THE DEFECT: a number owned by another channel still renders as a link in this one", () => {
  // The reading channel has its own #108 — a different card that happens to share
  // the number. This is the real shape: #proj-sre #108 (the freeze card) and
  // #proj-raft-computer #108 (a done card) both existed.
  const cardTheReaderMeant = makeTask(OTHER_CHANNEL_ID, SHARED_TASK_NUMBER, "the card the author meant");
  const cardTheReaderGets = makeTask(READING_CHANNEL_ID, SHARED_TASK_NUMBER, "an unrelated same-numbered card");

  renderWith(`blocked until #${SHARED_TASK_NUMBER} is done`, {
    channelTasks: [cardTheReaderGets],
    serverTasks: [cardTheReaderMeant, cardTheReaderGets],
  });

  const link = taskRefLink(SHARED_TASK_NUMBER);
  assert.ok(link, "renders as a link");

  // ⭐ The whole defect, and why it is silent: the rendered chip carries the NUMBER
  // and nothing else. Neither channel id appears anywhere on it, so which of the two
  // same-numbered cards it will open is not expressible in what was rendered —
  // resolution therefore falls back to the reading channel
  // (MessageItem.tsx: parentChannelId || message.channelId) and returns
  // `cardTheReaderGets`, with no error and no visible cue.
  const markup = link!.outerHTML;
  assert.ok(
    !markup.includes(OTHER_CHANNEL_ID) && !markup.includes(READING_CHANNEL_ID),
    "the chip carries no channel identity at all — this is what makes the mis-jump silent, and " +
      "it is what a fix (ⓐ narrowing the decision, or ⓑ server-scoped numbers) has to change",
  );

  // And it is byte-identical to the chip rendered when the number belongs ONLY to
  // the channel being read — so the reader has no way to tell the two cases apart.
  cleanup();
  renderWith(`blocked until #${SHARED_TASK_NUMBER} is done`, {
    channelTasks: [cardTheReaderGets],
    serverTasks: [cardTheReaderGets],
  });
  assert.equal(
    taskRefLink(SHARED_TASK_NUMBER)?.outerHTML,
    markup,
    "same markup whether the number is owned by this channel or another one — indistinguishable",
  );
});
