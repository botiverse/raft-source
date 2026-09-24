import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";
import {
  buildSystemMessageRenderStates,
} from "../src/components/message/systemMessageGrouping";
import { mergedMessages } from "../src/i18n/messages";
import type { Message } from "../src/store/messageStore";

let nextId = 0;

const enIntl = createIntl({
  locale: "en",
  defaultLocale: "en",
  messages: mergedMessages("en"),
});

function system(content: string): Message {
  return {
    id: `system-${nextId += 1}`,
    channelId: "channel-1",
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content,
    createdAt: "2026-05-01T00:00:00.000Z",
  };
}

function chat(content: string): Message {
  return {
    id: `chat-${nextId += 1}`,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    messageType: "chat",
    content,
    createdAt: "2026-05-01T00:00:00.000Z",
  };
}

test("collapses adjacent system messages into a summary row", () => {
  const states = buildSystemMessageRenderStates(
    [
      system('✅ Peng moved #61 "有 slock cli 之后，hermes 是不是可以支持了" to Done'),
      system('📌 Akko claimed #86 "Other task"'),
      system('🔔 @Dozy scheduled a reminder: "Check PR #1244" — fires <span data-reminder-fire-at="2026-05-01T08:51:09.444Z">2026-05-01 08:51 UTC</span>'),
    ],
    enIntl.formatMessage,
  );

  assert.equal(states[0]?.kind, "summary");
  assert.equal(states[0]?.kind === "summary" ? states[0].content : "", "There are 2 task updates, 1 reminder update");
  assert.deepEqual(states[0]?.kind === "summary" ? states[0].messageIndexes : [], [0, 1, 2]);
  assert.equal(states[1]?.kind, "hide");
  assert.equal(states[2]?.kind, "hide");
});

test("does not collapse across chat messages", () => {
  const states = buildSystemMessageRenderStates(
    [
      system('📌 Akko claimed #61 "Task title"'),
      chat("human context"),
      system('👀 Akko moved #61 "Task title" to In Review'),
    ],
    enIntl.formatMessage,
  );

  assert.deepEqual(states, [null, null, null]);
});

test("collapses non-ASCII task actors and recurring reminder notices", () => {
  const states = buildSystemMessageRenderStates(
    [
      system('📌 哭哭 claimed #334 "agent dm 的view还是有问题"'),
      system('👀 哭哭 moved #334 "agent dm 的view还是有问题" to In Review'),
      system("Reminder (recurring): #users:a545a4d3 — Check tong07@163.com reply re: outbound DM test result, relay to Kai"),
    ],
    enIntl.formatMessage,
  );

  assert.equal(states[0]?.kind, "summary");
  assert.equal(states[0]?.kind === "summary" ? states[0].content : "", "There are 2 task updates, 1 reminder update");
  assert.equal(states[1]?.kind, "hide");
  assert.equal(states[2]?.kind, "hide");
});

test("classifies reminder fire notices as reminder updates", () => {
  const states = buildSystemMessageRenderStates(
    [
      system('📌 Akko claimed #61 "Task title"'),
      system('🔔 Reminder #7ddfdf1d (one-time) — #proj-uiux:141a05fd — "Check PR #1306 CI for task #103"'),
    ],
    enIntl.formatMessage,
  );

  assert.equal(states[0]?.kind, "summary");
  assert.equal(states[0]?.kind === "summary" ? states[0].content : "", "There are 1 task update, 1 reminder update");
  assert.equal(states[1]?.kind, "hide");
});

test("collapses generic adjacent system messages without specialized counts", () => {
  const states = buildSystemMessageRenderStates(
    [
      system("Channel archived"),
      system("Channel unarchived"),
    ],
    enIntl.formatMessage,
  );

  assert.equal(states[0]?.kind, "summary");
  assert.equal(states[0]?.kind === "summary" ? states[0].content : "", "There are 2 system messages");
  assert.equal(states[1]?.kind, "hide");
});
