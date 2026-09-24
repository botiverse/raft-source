import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION,
  type ProductionSystemMessageProducer,
  type SystemMessageBornReadClassification,
} from "./systemMessageBornReadRegistry.js";

const VALID_CLASSIFICATIONS: readonly SystemMessageBornReadClassification[] = [
  "born-read",
  "skip",
  "notify-exclude",
  "real-sender",
];

/**
 * The permanent forced-declaration gate.
 *
 * The compile-time `satisfies Record<ProductionSystemMessageProducer, ...>` in
 * the registry already fails `tsc` if a new producer literal is added to
 * `SystemMessageInboxFactProducer` without a classification. This runtime test
 * is the second belt: it re-derives the producer set from the messageService
 * source, and asserts the registry covers every non-test producer. A new
 * producer that skips the registry fails CI here even if someone widens the
 * type without running tsc.
 */

function readMessageServiceSource(): string {
  const path = fileURLToPath(new URL("./messageService.ts", import.meta.url));
  return fs.readFileSync(path, "utf8");
}

function readBuiltInManifestSource(): string {
  const path = fileURLToPath(new URL("./rapBuiltinAppManifests.ts", import.meta.url));
  return fs.readFileSync(path, "utf8");
}

function readSource(relativePath: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * Parse the `SystemMessageInboxFactProducer` union literals straight out of the
 * source of truth so the test cannot drift from a stale hand-copied list.
 */
function extractDeclaredProducers(source: string): string[] {
  const start = source.indexOf("export type SystemMessageInboxFactProducer");
  assert.notEqual(start, -1, "SystemMessageInboxFactProducer type must exist");
  const end = source.indexOf(";", start);
  const block = source.slice(start, end);
  const literals = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(literals.length > 0, "expected at least one string-literal producer");
  return literals;
}

test("registry classifies every non-test system-message producer", () => {
  const declared = extractDeclaredProducers(readMessageServiceSource());
  const production = declared.filter((producer) => !producer.startsWith("test."));

  for (const producer of production) {
    assert.ok(
      producer in SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION,
      `producer "${producer}" is missing a born-read classification. Add it to `
        + `SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION (born-read | skip | notify-exclude | real-sender).`,
    );
  }

  // And the registry must not carry stale keys that no longer exist as producers.
  for (const producer of Object.keys(SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION)) {
    assert.ok(
      production.includes(producer),
      `registry key "${producer}" is not a declared production producer (stale entry?)`,
    );
  }
});

test("app catalog carries no empty system-message producer extension shell", () => {
  const source = readBuiltInManifestSource();
  for (const retired of [
    "BUILT_IN_SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION",
    "BUILT_IN_SYSTEM_MESSAGE_INBOX_FACT_PRODUCERS",
    "BuiltInSystemMessageInboxFactProducer",
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${retired}\\b`));
  }
});

test("Computer-local Reminder cutover leaves no Server execution compatibility shells", () => {
  const manifestSource = readBuiltInManifestSource();
  for (const retired of ["getBuiltInRapAppForHook", "getBuiltInRapAppById"]) {
    assert.doesNotMatch(manifestSource, new RegExp(`\\b${retired}\\b`));
  }
  assert.doesNotMatch(
    readSource("../apps/cleaner/configProjector.ts"),
    /\braiseCleanerThreshold\b/,
  );
  assert.doesNotMatch(
    readSource("../../../shared/src/appConfigTransport.ts"),
    /\bclampToAppConfigBounds\b/,
  );
  assert.doesNotMatch(
    readSource("../../../shared/src/agentInboxApp.ts"),
    /\bAGENT_INBOX_APP_ITEM_KEYS\b/,
  );
  const reminderServiceSource = readSource("../apps/reminder/service.ts");
  assert.doesNotMatch(reminderServiceSource, /expectedVersion\?\s*:/);
  assert.doesNotMatch(reminderServiceSource, /expectedVersion\s*!==\s*undefined/);
  assert.doesNotMatch(readSource("../apps/reminder/definition.ts"), /\bBUILT_IN_DUE_APP\b/);
  assert.doesNotMatch(readSource("../server.ts"), /\breminderScheduler\b/);

  for (const retiredPath of ["./reminderService.ts", "./reminderScheduler.ts"]) {
    assert.equal(
      fs.existsSync(fileURLToPath(new URL(retiredPath, import.meta.url))),
      false,
      `${retiredPath} must not return as a compatibility facade`,
    );
  }

  for (const sourcePath of [
    "../apps/reminder/crud.ts",
    "../routes/internal.ts",
    "../routes/internalAgentApi.ts",
    "../routes/reminders.ts",
    "./agentOrchestrator.ts",
    "./reminderArmWatchdog.ts",
    "./wikiService.ts",
  ]) {
    assert.doesNotMatch(
      readSource(sourcePath),
      /services\/reminderService\.js|\.\/reminderService\.js/,
      `${sourcePath} must import the app-owned Reminder service directly`,
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
    "channel.archive": "born-read",
    "channel.unarchive": "born-read",
    "task.created_summary": "born-read",
    "task.assignment_receipt": "born-read",
    "task.converted_summary": "born-read",
    // #9: task status transitions are a collaboration signal — born-read for the actor.
    "task.lifecycle_thread": "born-read",
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
