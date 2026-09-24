import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { buildSystemMessageRenderStates } from "../src/components/message/systemMessageGrouping";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import type { Message } from "../src/store/messageStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

function system(content: string, id: string): Message {
  return {
    id,
    channelId: "channel-1",
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content,
    createdAt: "2026-05-01T00:00:00.000Z",
  };
}

test("catalog pins system-message summary MessageIds with ICU plurals", () => {
  assert.match(en["message.system.summary.taskUpdateCount"], /\{count, plural,/);
  assert.match(en["message.system.summary.singlePart"], /\{totalCount, plural,/);
  assert.match(en["message.system.summary.multiParts"], /\{parts\}/);
  assert.match(zh["message.system.summary.taskUpdateCount"], /\p{Script=Han}/u);
  assert.match(zh["message.system.summary.multiParts"], /\p{Script=Han}/u);
  assert.notEqual(zh["message.system.summary.multiParts"], en["message.system.summary.multiParts"]);
});

test("buildSystemMessageRenderStates formats zh-cn summaries via formatMessage", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const states = buildSystemMessageRenderStates(
    [
      system('📌 Akko claimed #61 "Task title"', "s1"),
      system('👀 Akko moved #61 "Task title" to In Review', "s2"),
      system("Reminder (recurring): #users:a545a4d3 — check mail", "s3"),
    ],
    zhIntl.formatMessage,
  );
  assert.equal(states[0]?.kind, "summary");
  const content = states[0]?.kind === "summary" ? states[0].content : "";
  assert.equal(content, "有 2 条任务更新, 1 条提醒更新");
  assert.match(content, /\p{Script=Han}/u);
  assert.doesNotMatch(content, /There are/);
  assert.doesNotMatch(content, /task update/);
});
