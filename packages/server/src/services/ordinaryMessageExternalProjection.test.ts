import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import {
  classifyOrdinaryMessageExternalProjection,
  ORDINARY_MESSAGE_PRODUCER_CLASSIFICATION,
} from "./ordinaryMessageExternalProjection.js";

const SERVER_SRC = fileURLToPath(new URL("../", import.meta.url));
const MARKER = /slack-bridge-ordinary-message-producer:\s*([a-z0-9._-]+)/g;

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      return [];
    }
    return [absolute];
  });
}

test("ordinary external projection classification is closed over chat/task/action boundaries", () => {
  assert.deepEqual(
    classifyOrdinaryMessageExternalProjection({ senderType: "user", messageType: "chat" }),
    { eligible: true },
  );
  assert.deepEqual(
    classifyOrdinaryMessageExternalProjection({ senderType: "agent", messageType: "chat" }),
    { eligible: true },
  );
  assert.deepEqual(
    classifyOrdinaryMessageExternalProjection({ senderType: "user", messageType: "chat", asTask: true }),
    { eligible: false, reason: "task" },
  );
  assert.deepEqual(
    classifyOrdinaryMessageExternalProjection({
      senderType: "user",
      messageType: "chat",
      actionMetadata: { kind: "forwarded_bundle" },
    }),
    { eligible: false, reason: "action_metadata" },
  );
  assert.deepEqual(
    classifyOrdinaryMessageExternalProjection({ senderType: "system", messageType: "chat" }),
    { eligible: false, reason: "unsupported_sender" },
  );
  assert.deepEqual(
    classifyOrdinaryMessageExternalProjection({ senderType: "agent", messageType: "system" }),
    { eligible: false, reason: "non_chat" },
  );
});
test("every production broadcastAndDeliver producer has one forced classification", () => {
  const markerLocations = new Map<string, string>();
  let callCount = 0;

  for (const filename of productionTypeScriptFiles(SERVER_SRC)) {
    const source = fs.readFileSync(filename, "utf8");
    const relative = path.relative(SERVER_SRC, filename);
    const calls = [...source.matchAll(/(?:messageService\.|deps\.)broadcastAndDeliver\s*\(/g)];
    callCount += calls.length;
    const markers = [...source.matchAll(MARKER)];

    assert.equal(
      markers.length,
      calls.length,
      `${relative}: every production broadcastAndDeliver call needs exactly one adjacent producer marker`,
    );
    for (const marker of markers) {
      const producer = marker[1]!;
      assert.ok(
        producer in ORDINARY_MESSAGE_PRODUCER_CLASSIFICATION,
        `${relative}: producer ${producer} is missing from ORDINARY_MESSAGE_PRODUCER_CLASSIFICATION`,
      );
      assert.equal(
        markerLocations.has(producer),
        false,
        `producer ${producer} is declared at more than one call site`,
      );
      markerLocations.set(producer, relative);
    }
  }

  assert.equal(callCount, Object.keys(ORDINARY_MESSAGE_PRODUCER_CLASSIFICATION).length);
  assert.deepEqual(
    [...markerLocations.keys()].sort(),
    Object.keys(ORDINARY_MESSAGE_PRODUCER_CLASSIFICATION).sort(),
  );
});
