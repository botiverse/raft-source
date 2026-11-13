import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION,
  type ProductionSystemMessageProducer,
  type SystemMessageBornReadClassification,
} from "./systemMessageBornReadRegistry";

const VALID_CLASSIFICATIONS: readonly SystemMessageBornReadClassification[] = [
  "born-read",
  "skip",
  "notify-exclude",
  "real-sender",
];

test("Computer-local Reminder cutover leaves no Server execution compatibility facade files", () => {
  for (const retiredPath of ["./reminderService.ts", "./reminderScheduler.ts"]) {
    assert.equal(
      fs.existsSync(fileURLToPath(new URL(retiredPath, import.meta.url))),
      false,
      `${retiredPath} must not return as a compatibility facade`,
    );
  }
});

test("every registry classification is a known value", () => {
  for (const [producer, classification] of Object.entries(SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION)) {
    assert.ok(
      VALID_CLASSIFICATIONS.includes(classification as SystemMessageBornReadClassification),
      `producer "${producer}" has invalid classification "${classification}"`,
    );
  }
});

test("critical producers keep their intended born-read policy", () => {
  const expectations: Record<string, SystemMessageBornReadClassification> = {
    // Self-caused structural notices must be born-read for the actor.
    "agent.join_channel": "born-read",
    "channel.agent_membership": "born-read",
    "channel.rename": "born-read",
    "channel.announcement": "born-read",
    "channel.archive": "born-read",
    "channel.joint_disconnect": "born-read",
    "channel.joint_connect": "born-read",
    "channel.unarchive": "born-read",
    "task.created_summary": "born-read",
    "task.assignment_receipt": "born-read",
    "task.converted_summary": "born-read",
    // #9: task status transitions are a collaboration signal — born-read for the actor.
    "task.lifecycle_thread": "born-read",
    "onboarding.hosted_recap_wake": "born-read",
    // Zero-audience / lifecycle churn records no fact.
    "channel.self_unfollow_thread": "skip",
    "task.deleted_summary": "skip",
    // Onboarding notices must stay unread for the joiner (negative control).
    "onboarding.owner_instruction": "notify-exclude",
    "onboarding.owner_opener_v2_ledger": "notify-exclude",
    "onboarding.member_instruction": "notify-exclude",
    "onboarding.all_channel_unlock": "notify-exclude",
    "onboarding.cross_channel_hint": "notify-exclude",
    // Real-sender carriers never route through the system born-read gate.
    "action_card.carrier": "real-sender",
    "task.body": "real-sender",
    "external_projection.inbound": "real-sender",
  };

  for (const [producer, expected] of Object.entries(expectations)) {
    assert.equal(
      SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION[producer as ProductionSystemMessageProducer],
      expected,
      `producer "${producer}" changed born-read policy; confirm this is intentional and update call sites + tests`,
    );
  }
});
