import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const serverSourceRoot = resolve(import.meta.dirname, "..");

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

function source(relativePath: string): string {
  return readFileSync(resolve(serverSourceRoot, relativePath), "utf8");
}

test("external projection source ratchet keeps one canonical writer and no Raft authority writes", () => {
  const externalSenderWriters = productionTypeScriptFiles(serverSourceRoot)
    .filter((path) => /senderType\s*:\s*["']external_projection["']/.test(readFileSync(path, "utf8")))
    .map((path) => relative(serverSourceRoot, path));

  assert.deepEqual(externalSenderWriters, ["services/externalProjectionService.ts"]);

  const writer = source("services/externalProjectionService.ts");
  assert.match(writer, /\.insert\(messages\)[\s\S]*?senderType:\s*"external_projection"/);
  for (const forbiddenAuthorityWrite of [
    "messageMentions",
    "inboxNotificationFacts",
    "tasks",
    "threadFollows",
    "actionCards",
  ]) {
    assert.doesNotMatch(
      writer,
      new RegExp(`\\.insert\\(${forbiddenAuthorityWrite}\\)`),
      `canonical external writer must not create ${forbiddenAuthorityWrite} authority`,
    );
  }

  assert.match(
    source("services/taskService.ts"),
    /senderType === "external_projection"[\s\S]*?cannot be claimed as tasks/,
  );
});

test("external projection reader ratchet keeps immutable author and Agent de-escalation guards", () => {
  const requiredReaderMarkers: Record<string, RegExp[]> = {
    "services/messageService.ts": [
      /loadExternalMessageAuthors/,
      /missing immutable author fact/i,
      /senderType === "external_projection"[\s\S]*?mentioned: false/,
      /senderType !== "external_projection"[\s\S]*?taskStatus/,
      /isAgentApiExternalMessageForbiddenAuthorityField[\s\S]*?projectAgentVisibleHttpMessageResponse/,
      /projectAgentVisibleHttpMessageResponse[\s\S]*?Object\.keys\(envelope\)[\s\S]*?isAgentApiExternalMessageForbiddenAuthorityField/,
    ],
    "services/searchService.ts": [
      /external_message_author_facts/,
      /search row is missing immutable author fact/i,
    ],
    "services/savedService.ts": [
      /externalMessageAuthorFacts/,
      /saved row is missing immutable author fact/i,
    ],
    "services/channelService.ts": [
      /externalMessageAuthorFacts/,
      /thread reply is missing immutable author fact/i,
      /followed-thread row is missing immutable author fact/i,
    ],
    "routes/internal.ts": [
      /third_party_app/,
      /externalAuthor: _externalAuthor/,
      /!external &&/,
      /reaction-add\.updated[\s\S]*?projectAgentVisibleHttpMessageResponse\(enriched\)/,
      /reaction-remove\.updated[\s\S]*?projectAgentVisibleHttpMessageResponse\(enriched\)/,
    ],
    "routes/internalAgentApi.ts": [
      /third_party_app/,
      /toAgentApiMessageEnvelope\(enriched, enriched\.content\)/,
      /registerAgentApiRoute\("messageReactionAdd"[\s\S]*?handleReaction\(req, res, "add"\)/,
      /registerAgentApiRoute\("messageReactionRemove"[\s\S]*?handleReaction\(req, res, "remove"\)/,
    ],
  };

  for (const [relativePath, markers] of Object.entries(requiredReaderMarkers)) {
    const text = source(relativePath);
    for (const marker of markers) {
      assert.match(text, marker, `${relativePath} lost external projection reader guard ${marker}`);
    }
  }
});

test("provider-neutral inbound ratchet keeps one sealed worker and one atomic canonical commit path", () => {
  const worker = source("services/externalInboundWorkerService.ts");
  for (const required of [
    /externalInboundEvents/,
    /decryptNormalizedPayload/,
    /resolveCurrentRuntime/,
    /insertCanonicalExternalMessage/,
    /externalMessageLinks/,
    /recordInboxFactsForPersistedMessages/,
    /payloadTombstoneDigest/,
    /inboundEventRowLockHookForTests[\s\S]*?dependencies\.now/,
  ]) {
    assert.match(worker, required, `provider-neutral inbound worker lost ${required}`);
  }
  assert.doesNotMatch(worker, /chat\.postMessage|slack\.com|xox[baprs]-/i);

  const schema = source("db/schema.ts");
  assert.match(schema, /externalInboundEvents = pgTable\("external_inbound_events"/);
  assert.match(schema, /external_inbound_event_custody_shape/);
  assert.match(schema, /external_inbound_event_terminal_shape/);
});
