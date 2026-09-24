import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import type { messages } from "../db/schema.js";
import type * as messageService from "./messageService.js";
import {
  projectMessageSocketPayload,
  projectRichMessageSocketPayload,
} from "./messageRealtimeEvents.js";
import { emitTaskMessageNew } from "./taskRealtimeEvents.js";
import {
  MESSAGE_REALTIME_PRODUCER_REGISTRY,
  type ProducerRegistryEntry,
} from "./messageRealtimeProducerRegistry.js";

const srcRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  }));
  return files.flat();
}

function createIoRecorder() {
  const emissions: Array<{ rooms: string[]; event: string; payload: Record<string, unknown> }> = [];
  const io = {
    rooms: [] as string[],
    to(room: string) {
      this.rooms.push(room);
      return this;
    },
    emit(event: string, payload: Record<string, unknown>) {
      emissions.push({ rooms: [...this.rooms], event, payload });
      this.rooms = [];
      return true;
    },
  };
  return { io: io as never, emissions };
}

test("message socket projection excludes storage-only message columns", () => {
  const createdAt = new Date("2026-07-12T00:00:00.000Z");
  const updatedAt = new Date("2026-07-12T00:01:00.000Z");
  const source = {
    id: "message-1",
    seq: 10,
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    agentSendKey: "must-not-leak",
    randomId: null,
    messageType: "chat",
    content: "hello",
    actionMetadata: { kind: "action-card" },
    searchText: "must-not-leak",
    searchVector: "must-not-leak",
    threadId: null,
    taskStatus: "todo",
    taskNumber: 5,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt,
    updatedAt,
    futureInternalColumn: "must-not-leak",
  };
  const payload = projectMessageSocketPayload(source as never, "Agent One");

  assert.deepEqual(payload, {
    id: "message-1",
    seq: 10,
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    randomId: null,
    messageType: "chat",
    content: "hello",
    actionMetadata: { kind: "action-card" },
    threadId: null,
    taskStatus: "todo",
    taskNumber: 5,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt,
    updatedAt,
    senderName: "Agent One",
  });
  assert.equal("agentSendKey" in payload, false);
  assert.equal("searchText" in payload, false);
  assert.equal("searchVector" in payload, false);
  assert.equal("futureInternalColumn" in payload, false);
});

test("rich message socket projection excludes storage-only message columns", () => {
  const payload = {
    id: "message-1",
    seq: 10,
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    agentSendKey: "must-not-leak",
    randomId: null,
    messageType: "chat",
    content: "hello",
    actionMetadata: null,
    searchText: "must-not-leak",
    searchVector: "must-not-leak",
    threadId: null,
    taskStatus: null,
    taskNumber: null,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt: new Date("2026-07-12T00:00:00.000Z"),
    updatedAt: new Date("2026-07-12T00:00:00.000Z"),
    senderName: "Agent One",
    senderDescription: "agent",
    senderMembershipStatus: "active",
    attachments: [],
    reactions: [],
    mentions: [],
    commentRef: null,
    conversationContext: { channelType: "channel" },
  };

  const projectedNew = projectRichMessageSocketPayload(payload);
  assert.equal("agentSendKey" in projectedNew, false);
  assert.equal("searchText" in projectedNew, false);
  assert.equal("searchVector" in projectedNew, false);
  assert.equal(projectedNew.id, payload.id);
  assert.equal(projectedNew.senderName, payload.senderName);
  assert.deepEqual(projectedNew.attachments, []);
  assert.deepEqual(projectedNew.conversationContext, { channelType: "channel" });

  const projectedUpdated = projectRichMessageSocketPayload({ ...payload, commentRef: null });
  assert.equal("agentSendKey" in projectedUpdated, false);
  assert.equal("searchText" in projectedUpdated, false);
  assert.equal("searchVector" in projectedUpdated, false);
  assert.equal(projectedUpdated.commentRef, null);
});

test("task message:new keeps the existing channel-only audience", () => {
  const { io, emissions } = createIoRecorder();
  const now = new Date("2026-07-12T00:00:00.000Z");

  emitTaskMessageNew(io, {
    channelId: "channel-1",
    channelType: "channel",
    serverId: "server-1",
  }, {
    id: "message-2",
    seq: 11,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    randomId: "optimistic-1",
    messageType: "chat",
    content: "task body",
    actionMetadata: null,
    threadId: null,
    taskStatus: "todo",
    taskNumber: 6,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt: now,
    updatedAt: now,
  }, "Human One");

  assert.equal(emissions.length, 1);
  assert.deepEqual(emissions[0]?.rooms, ["channel:channel-1"]);
  assert.equal(emissions[0]?.event, "message:new");
  assert.equal(emissions[0]?.payload.senderName, "Human One");
});

function isInComment(source: string, index: number): boolean {
  const before = source.slice(0, index);
  const lastBlockOpen = before.lastIndexOf("/*");
  const lastBlockClose = before.lastIndexOf("*/");
  if (lastBlockOpen > lastBlockClose) return true;
  const lineStart = before.lastIndexOf("\n") + 1;
  return before.slice(lineStart).includes("//");
}

function producerMarker(source: string, index: number, rel: string): string {
  const markerWindow = source.slice(Math.max(0, index - 240), index);
  const matches = [...markerWindow.matchAll(/message-realtime-producer:\s*([A-Za-z0-9._:-]+)/g)];
  const marker = matches.at(-1)?.[1];
  assert.ok(marker, `${rel} producer must have an adjacent message-realtime-producer marker`);
  return marker;
}

function inventoriedProducerEntries(source: string, rel: string): string[] {
  const entries: string[] = [];
  const push = (input: { marker: string; event: string }) => entries.push(`${rel}#${input.marker}#${input.event}`);

  for (const match of source.matchAll(/emit\(\s*["'](message:(?:new|updated))["']/g)) {
    if (match.index == null || isInComment(source, match.index)) continue;
    const event = match[1];
    push({
      marker: producerMarker(source, match.index, rel),
      event,
    });
  }
  if (rel !== "services/taskRealtimeEvents.ts") {
    for (const match of source.matchAll(/\bemitTaskMessageNew\(/g)) {
      if (match.index == null || isInComment(source, match.index)) continue;
      push({
        marker: producerMarker(source, match.index, rel),
        event: "message:new",
      });
    }
  }
  return entries;
}

function sourceProducerMarkers(source: string): string[] {
  return [...source.matchAll(/message-realtime-producer:\s*([A-Za-z0-9._:-]+)/g)]
    .map((match) => match[1])
    .filter((marker): marker is string => Boolean(marker));
}

function producerInventoryFromSources(sources: Array<{ rel: string; source: string }>): string[] {
  const inventory: string[] = [];
  for (const { rel, source } of sources) {
    const entries = inventoriedProducerEntries(source, rel);
    const usedMarkerIds = entries.map((entry) => entry.split("#").slice(0, 2).join("#")).sort();
    const declaredMarkerIds = sourceProducerMarkers(source).map((marker) => `${rel}#${marker}`).sort();
    assert.deepEqual(
      usedMarkerIds,
      declaredMarkerIds,
      `${rel} producer markers must have a one-to-one matching producer callsite`,
    );
    inventory.push(...entries);
    assert.doesNotMatch(
      source,
      /emit\(\s*["']message:(?:new|updated)["']\s*,\s*\{\s*\.\.\./s,
      `${rel} must not spread raw rows into message:new/message:updated`,
    );
  }
  const sorted = inventory.sort();
  assert.equal(new Set(sorted).size, sorted.length, "producer markers must be unique per scanned producer event");
  const markerIds = sorted.map((entry) => entry.split("#").slice(0, 2).join("#"));
  assert.equal(new Set(markerIds).size, markerIds.length, "producer markers must not be reused across events");
  return sorted;
}

test("message:new and message:updated emitters stay on inventoried projection surfaces", async () => {
  const expectedInventory: ProducerRegistryEntry[] = MESSAGE_REALTIME_PRODUCER_REGISTRY;


  const sources: Array<{ rel: string; source: string }> = [];
  for (const file of await sourceFiles(srcRoot)) {
    const source = await readFile(file, "utf8");
    const rel = relative(srcRoot, file);
    sources.push({ rel, source });
  }

  assert.deepEqual(
    producerInventoryFromSources(sources),
    expectedInventory.map((entry) => entry.id).sort(),
  );
  for (const entry of expectedInventory) {
    assert.ok(entry.audience, `${entry.id} must document audience`);
    assert.ok(entry.authority, `${entry.id} must document authority`);
    assert.ok(entry.applyTarget, `${entry.id} must document applyTarget`);
    assert.ok(entry.presence, `${entry.id} must document presence`);
    assert.ok(entry.payloadKeys.length > 0, `${entry.id} must document payloadKeys`);
    assert.notEqual(entry.payloadKeys.length, 1, `${entry.id} must use an expanded payload key set, not an opaque label`);
  }

  const taskRoutes = [
    new URL("../routes/tasks.ts", import.meta.url),
    new URL("../routes/internal.ts", import.meta.url),
    new URL("../routes/internalAgentApi.ts", import.meta.url),
  ];
  for (const url of taskRoutes) {
    const source = await readFile(url, "utf8");
    assert.doesNotMatch(
      source,
      /emit\(\s*["']message:new["']/,
      `${url.pathname} must use emitTaskMessageNew instead of direct message:new`,
    );
  }
});

test("producer marker comments are a bijection with producer callsites", () => {
  assert.throws(
    () => producerInventoryFromSources([{
      rel: "routes/orphanMarker.ts",
      source: `
        export function noProducer() {
          // message-realtime-producer: orphan.marker
          return true;
        }
      `,
    }]),
    /one-to-one matching producer callsite/,
  );
  assert.throws(
    () => producerInventoryFromSources([{
      rel: "routes/reusedMarker.ts",
      source: `
        export function doubleProducer(io, newPayload, updatedPayload) {
          // message-realtime-producer: reused.marker
          io.to("channel:1").emit("message:new", newPayload);
          io.to("channel:1").emit("message:updated", updatedPayload);
        }
      `,
    }]),
    /producer markers must have a one-to-one matching producer callsite/,
  );
});

test("producer helper callsites are part of the closed-set inventory", () => {
  assert.deepEqual(
    inventoriedProducerEntries(`
      // message-realtime-producer: synthetic.task-new
      emitTaskMessageNew(io, target, row, senderName);
      // message-realtime-producer: synthetic.updated
      io.to(room).emit("message:updated", payload);
    `, "routes/synthetic.ts").sort(),
    [
      "routes/synthetic.ts#synthetic.task-new#message:new",
      "routes/synthetic.ts#synthetic.updated#message:updated",
    ].sort(),
  );
});

test("unregistered helper producer callsites would fail the closed-set shape", () => {
  assert.throws(
    () => assert.deepEqual(
      producerInventoryFromSources([{
        rel: "routes/newProducer.ts",
        source: `
          export function newProducer(io, target, row) {
            // message-realtime-producer: new-producer.task-new
            emitTaskMessageNew(io, target, row, "Sender");
          }
        `,
      }]),
      [],
    ),
    /routes\/newProducer\.ts/,
  );
});

test("same-file producer replacement changes marker identity", () => {
  const replacementInventory = producerInventoryFromSources([{
    rel: "routes/tasks.ts",
    source: `
      export function createOtherTask(io, target, row) {
        // message-realtime-producer: task-route.new.unregistered-replacement
        emitTaskMessageNew(io, target, row, "Sender");
      }
    `,
  }]);

  assert.notDeepEqual(replacementInventory, [
    "routes/tasks.ts#task-route.new.user#message:new",
  ]);
});
