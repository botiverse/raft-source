import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { TASK_ASSIGNMENT_NOTICE_KIND } from "@botiverse/raft-shared";

import { buildSystemMessageRenderStates } from "../src/components/message/systemMessageGrouping";
import { readTaskHandoffNotice, taskHandoffReturns } from "../src/components/task/taskHandoffNotice";
import { mergedMessages } from "../src/i18n/messages";
import type { Message } from "../src/store/messageStore";

const enIntl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });

const OTTER = { type: "agent" as const, id: "agent-otter", name: "otter", displayName: "Otter" };
const XX = { type: "user" as const, id: "user-xx", name: "xxchan", displayName: "xxchan" };
const BOB = { type: "user" as const, id: "user-bob", name: "bob", displayName: "Bob" };

let nextId = 0;

function assignment(
  actor: typeof OTTER | typeof XX | typeof BOB,
  assignee: typeof OTTER | typeof XX | typeof BOB | null,
  reason?: string,
  createdAt = "2026-11-10T08:00:00.000Z",
): Message {
  return {
    id: `system-${nextId += 1}`,
    channelId: "task-conversation",
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content: `📌 ${actor.displayName} assigned #51 "Ship it"${assignee ? ` to @${assignee.name}` : ""}${reason ? `: ${reason}` : ""}`,
    createdAt,
    actionMetadata: { kind: TASK_ASSIGNMENT_NOTICE_KIND, taskNumber: 51, actor, assignee, ...(reason ? { reason } : {}) },
  };
}

function statusLine(): Message {
  return {
    id: `system-${nextId += 1}`,
    channelId: "task-conversation",
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content: '🔄 Otter moved #51 "Ship it" to In Progress',
    createdAt: "2026-11-10T08:00:00.000Z",
  };
}

test("only a hand-off to someone else with a reason reads as a hand-off card", () => {
  assert.equal(readTaskHandoffNotice(assignment(OTTER, XX, "Your call: Friday or Monday?"))?.reason, "Your call: Friday or Monday?");
  assert.equal(readTaskHandoffNotice(assignment(OTTER, XX)), null, "no reason: the one-line notice");
  assert.equal(readTaskHandoffNotice(assignment(OTTER, OTTER)), null, "taking it yourself");
  assert.equal(readTaskHandoffNotice(assignment(OTTER, null)), null, "clearing the assignee");
  assert.equal(readTaskHandoffNotice(statusLine()), null);
});

test("a hand-off card is never folded into a run of system lines", () => {
  const states = buildSystemMessageRenderStates(
    [statusLine(), assignment(OTTER, XX, "Your call"), statusLine()],
    enIntl.formatMessage,
  );
  assert.deepEqual(states, [null, null, null]);
});

test("a hand-off comes back when the task is assigned back to its actor, or its actor takes it", () => {
  const handoff = assignment(OTTER, XX, "Your call", "2026-11-10T08:00:00.000Z");
  const back = assignment(XX, OTTER, undefined, "2026-11-10T09:30:00.000Z");
  assert.deepEqual([...taskHandoffReturns([handoff, statusLine(), back])], [[handoff.id, { at: "2026-11-10T09:30:00.000Z", by: XX }]], "xxchan handed it back");

  const second = assignment(OTTER, XX, "Review the copy", "2026-11-10T10:00:00.000Z");
  const took = assignment(OTTER, OTTER, undefined, "2026-11-10T11:00:00.000Z");
  assert.deepEqual(taskHandoffReturns([second, took]).get(second.id), { at: "2026-11-10T11:00:00.000Z", by: OTTER }, "Otter took it back");
});

test("a hand-off passed on to someone else is still waiting until it reaches its actor", () => {
  const handoff = assignment(OTTER, XX, "Your call");
  const passedOn = assignment(XX, BOB, "Bob knows the numbers");
  const returns = taskHandoffReturns([handoff, passedOn]);
  assert.equal(returns.size, 0);

  const backToXx = assignment(BOB, XX, "Done, numbers attached", "2026-11-10T12:00:00.000Z");
  const all = taskHandoffReturns([handoff, passedOn, backToXx]);
  assert.equal(all.get(passedOn.id)?.at, "2026-11-10T12:00:00.000Z", "Bob gave it back to xxchan");
  assert.equal(all.has(handoff.id), false, "Otter's hand-off is still waiting");
});
