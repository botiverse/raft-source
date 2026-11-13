import assert from "node:assert/strict";
import {
  SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION,
  SYSTEM_MESSAGE_NOTIFICATION_EVENT,
} from "./systemMessageBornReadRegistry";
import {
  classifySystemMessageNotification,
  systemEventRecipients,
  taskStatusPersonalRecipients,
  type SystemEventRecipient,
  type SystemEventRecipientsInput,
  type TaskStatusRecipientTask,
} from "./systemEventNotificationService";

describe("classifySystemMessageNotification (D10)", () => {
  test("task and agent event producers are events", () => {
    assert.deepEqual(classifySystemMessageNotification("task.lifecycle_thread"), { kind: "event", event: "task_status" });
    assert.deepEqual(classifySystemMessageNotification("task.assignment_receipt"), { kind: "event", event: "task_assigned" });
    assert.deepEqual(classifySystemMessageNotification("agent.runtime_action_required"), { kind: "event", event: "agent_action_required" });
  });

  test("a retired producer persisted before its removal (agent.tool_stuck) is silent", () => {
    assert.deepEqual(classifySystemMessageNotification("agent.tool_stuck"), { kind: "silent" });
  });

  test("real-sender producers notify like an ordinary message", () => {
    assert.deepEqual(classifySystemMessageNotification("task.body"), { kind: "message" });
    assert.deepEqual(classifySystemMessageNotification("action_card.carrier"), { kind: "message" });
    assert.deepEqual(classifySystemMessageNotification("external_projection.inbound"), { kind: "message" });
  });

  test("other system messages are silent", () => {
    for (const producer of ["channel.rename", "channel.announcement", "channel.human_membership", "onboarding.member_instruction", "task.created_summary", "app.agent_reminder", "slack_bridge.binding_paused"]) {
      assert.deepEqual(classifySystemMessageNotification(producer), { kind: "silent" }, producer);
    }
  });

  test("no producer and an unknown producer are silent", () => {
    assert.deepEqual(classifySystemMessageNotification(null), { kind: "silent" });
    assert.deepEqual(classifySystemMessageNotification(undefined), { kind: "silent" });
    assert.deepEqual(classifySystemMessageNotification(""), { kind: "silent" });
    assert.deepEqual(classifySystemMessageNotification("test.unknown_producer"), { kind: "silent" });
  });

  test("every registered producer classifies consistently with the registries", () => {
    const born = SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION as Record<string, string | undefined>;
    for (const [producer, event] of Object.entries(SYSTEM_MESSAGE_NOTIFICATION_EVENT)) {
      const expected = event !== "none"
        ? { kind: "event", event }
        : born[producer] === "real-sender" ? { kind: "message" } : { kind: "silent" };
      assert.deepEqual(classifySystemMessageNotification(producer), expected, producer);
    }
  });
});

describe("taskStatusPersonalRecipients", () => {
  const task = (overrides: Partial<TaskStatusRecipientTask>): TaskStatusRecipientTask => ({
    status: "in_review",
    createdByType: "user",
    createdById: "creator",
    claimedByType: "user",
    claimedById: "assignee",
    ...overrides,
  });

  test("review, done and closed reach creator and assignee", () => {
    for (const status of ["in_review", "done", "closed"]) {
      assert.deepEqual(taskStatusPersonalRecipients(task({ status })), ["creator", "assignee"], status);
    }
  });

  test("in_progress reaches only the creator", () => {
    assert.deepEqual(taskStatusPersonalRecipients(task({ status: "in_progress" })), ["creator"]);
    assert.deepEqual(taskStatusPersonalRecipients(task({ status: "in_progress", createdByType: "agent", createdById: "agent-1" })), []);
  });

  test("todo and unknown statuses are follower-only", () => {
    assert.deepEqual(taskStatusPersonalRecipients(task({ status: "todo" })), []);
    assert.deepEqual(taskStatusPersonalRecipients(task({ status: "something_else" })), []);
  });

  test("agents are never personal recipients; creator == assignee is one recipient", () => {
    assert.deepEqual(taskStatusPersonalRecipients(task({ createdByType: "agent", createdById: "agent-1" })), ["assignee"]);
    assert.deepEqual(taskStatusPersonalRecipients(task({ claimedByType: "agent", claimedById: "agent-2" })), ["creator"]);
    assert.deepEqual(taskStatusPersonalRecipients(task({ claimedByType: null, claimedById: null })), ["creator"]);
    assert.deepEqual(taskStatusPersonalRecipients(task({ claimedById: "creator" })), ["creator"]);
  });
});

describe("systemEventRecipients", () => {
  const base = (overrides: Partial<SystemEventRecipientsInput>): SystemEventRecipientsInput => ({
    event: "task_status",
    factReceiverIds: [],
    personalAttentionUserIds: [],
    ...overrides,
  });
  const byUser = (recipients: SystemEventRecipient[]) => Object.fromEntries(recipients.map((recipient) => [recipient.userId, recipient]));

  test("task_status: followers as non-personal plus personal recipients; personal wins", () => {
    const recipients = systemEventRecipients(base({
      factReceiverIds: ["follower", "creator"],
      taskPersonalUserIds: ["creator", "assignee"],
    }));
    assert.deepEqual(byUser(recipients), {
      follower: { userId: "follower", category: "task_status", personal: false, hasInboxFact: true },
      creator: { userId: "creator", category: "task_status", personal: true, hasInboxFact: true },
      assignee: { userId: "assignee", category: "task_status", personal: true, hasInboxFact: false },
    });
    assert.equal(recipients.length, 3);
  });

  test("task_status: personal before follower in the input still yields personal", () => {
    const recipients = systemEventRecipients(base({
      factReceiverIds: ["creator", "creator"],
      taskPersonalUserIds: ["creator"],
    }));
    assert.deepEqual(recipients, [{ userId: "creator", category: "task_status", personal: true, hasInboxFact: true }]);
  });

  test("task_status: a user actor is excluded, an agent actor id is not a user", () => {
    const userActor = systemEventRecipients(base({
      factReceiverIds: ["follower", "creator"],
      taskPersonalUserIds: ["creator", "assignee"],
      actor: { type: "user", id: "creator" },
    }));
    assert.deepEqual(userActor.map((recipient) => recipient.userId).sort(), ["assignee", "follower"]);

    const agentActor = systemEventRecipients(base({
      factReceiverIds: ["follower"],
      taskPersonalUserIds: ["creator"],
      actor: { type: "agent", id: "creator" },
    }));
    assert.deepEqual(agentActor.map((recipient) => recipient.userId).sort(), ["creator", "follower"]);
  });

  test("task_status ignores personal-attention targets", () => {
    assert.deepEqual(systemEventRecipients(base({ personalAttentionUserIds: ["assignee"] })), []);
  });

  test("task_assigned: only the personal-attention users", () => {
    const recipients = systemEventRecipients(base({
      event: "task_assigned",
      factReceiverIds: ["assignee", "bystander"],
      personalAttentionUserIds: ["assignee", "newcomer"],
      taskPersonalUserIds: ["creator"],
    }));
    assert.deepEqual(recipients, [
      { userId: "assignee", category: "task_assigned", personal: true, hasInboxFact: true },
      { userId: "newcomer", category: "task_assigned", personal: true, hasInboxFact: false },
    ]);
  });

  test("task_assigned: the user actor (self-assignment) is excluded", () => {
    assert.deepEqual(systemEventRecipients(base({
      event: "task_assigned",
      personalAttentionUserIds: ["me"],
      actor: { type: "user", id: "me" },
    })), []);
  });

  test("agent_action_required: the DM's humans as agent_attention, only in the agent's DM", () => {
    const event = "agent_action_required" as const;
    assert.deepEqual(systemEventRecipients(base({ event, factReceiverIds: ["owner"], agentDm: true, actor: { type: "agent", id: "agent-1" } })), [
      { userId: "owner", category: "agent_attention", personal: true, hasInboxFact: true },
    ]);
    assert.deepEqual(systemEventRecipients(base({ event, factReceiverIds: ["owner"], agentDm: false })), []);
    assert.deepEqual(systemEventRecipients(base({ event, factReceiverIds: ["owner"] })), []);
    assert.deepEqual(systemEventRecipients(base({ event, personalAttentionUserIds: ["owner"], agentDm: true })), []);
  });
});
