import assert from "node:assert/strict";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readOrchestratorSource(): string {
  return readFileSync(join(__dirname, "agentOrchestrator.ts"), "utf8");
}

test("agent:runtime_profile recorded path does not call deliverPendingRuntimeProfileMigration", () => {
  const src = readOrchestratorSource();
  const label = `case "agent:runtime_profile":`;
  const caseIdx = src.indexOf(label);
  assert.ok(caseIdx > -1, "case `agent:runtime_profile` not found in orchestrator");
  const nextCaseIdx = src.indexOf("case \"", caseIdx + label.length);
  assert.ok(nextCaseIdx > caseIdx, "next case after `agent:runtime_profile` not found");
  const block = src.slice(caseIdx, nextCaseIdx);
  assert.ok(
    !block.includes("deliverPendingRuntimeProfileMigration"),
    "deliverPendingRuntimeProfileMigration must NOT be called from agent:runtime_profile recorded path " +
      "(it triggers a `select ... where pending_kind='migration'` on every report, saturating primary pool). " +
      "Legacy cleanup belongs only on the runtime_profile:migration:ack path.",
  );
});

test("agent:session persist-active-session does not call deliverPendingRuntimeProfileMigration", () => {
  const src = readOrchestratorSource();
  const label = `case "agent:session":`;
  const caseIdx = src.indexOf(label);
  assert.ok(caseIdx > -1, "case `agent:session` not found in orchestrator");
  const nextCaseIdx = src.indexOf("case \"", caseIdx + label.length);
  assert.ok(nextCaseIdx > caseIdx, "next case after `agent:session` not found");
  const block = src.slice(caseIdx, nextCaseIdx);
  assert.ok(
    !block.includes("deliverPendingRuntimeProfileMigration"),
    "deliverPendingRuntimeProfileMigration must NOT be called from agent:session persist-active-session path.",
  );
});

test("agent:runtime_profile:migration_done still calls deliverPendingRuntimeProfileMigration", () => {
  const src = readOrchestratorSource();
  const label = `case "agent:runtime_profile:migration_done":`;
  const caseIdx = src.indexOf(label);
  assert.ok(caseIdx > -1, "case `agent:runtime_profile:migration_done` not found in orchestrator");
  const nextCaseIdx = src.indexOf("case \"", caseIdx + label.length);
  assert.ok(nextCaseIdx > caseIdx, "next case after migration_done not found");
  const block = src.slice(caseIdx, nextCaseIdx);
  assert.ok(
    block.includes("deliverPendingRuntimeProfileMigration"),
    "deliverPendingRuntimeProfileMigration MUST remain on the migration_done path " +
      "(that is the legitimate one-shot legacy cleanup trigger when daemon completes migration).",
  );
});

test("getPendingRuntimeProfileControl no longer triggers leading clearRuntimeProfileMigrationForReset", () => {
  const servicePath = join(__dirname, "agentRuntimeProfileService.ts");
  const src = readFileSync(servicePath, "utf8");
  const fnIdx = src.indexOf("export async function getPendingRuntimeProfileControl");
  assert.ok(fnIdx > -1, "getPendingRuntimeProfileControl not found");
  const fnEnd = src.indexOf("\n}\n", fnIdx);
  assert.ok(fnEnd > fnIdx, "closing brace of getPendingRuntimeProfileControl not found");
  const body = src.slice(fnIdx, fnEnd);
  assert.ok(
    !body.includes("clearRuntimeProfileMigrationForReset"),
    "getPendingRuntimeProfileControl must NOT call clearRuntimeProfileMigrationForReset " +
      "(it runs on every agent:start config build; the SELECT saturated primary pool).",
  );
});
