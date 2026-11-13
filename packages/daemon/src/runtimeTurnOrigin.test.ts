import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import type { AgentMessage } from "@botiverse/raft-shared";
import { deriveForegroundTurnOrigin } from "./foregroundTurnOrigin";
import { confirmRuntimeTurnOrigin, RuntimeTurnOriginHolder } from "./runtimeTurnOrigin";

// Task #21 (@peng msg 3bc1a766): the per-process turn origin that managed MCP calls carry so the
// server can put a Connect card back into the conversation the turn came from.

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: randomUUID(),
    channel_name: "general",
    channel_type: "channel",
    sender_id: randomUUID(),
    sender_name: "human",
    sender_type: "human",
    content: "hello",
    timestamp: "2026-09-17T00:00:00.000Z",
    message_id: randomUUID(),
    ...overrides,
  };
}

test("derive: a single concrete message envelope with a server-valid UUID is the only input that names an origin", () => {
  const one = message();
  assert.deepEqual(deriveForegroundTurnOrigin([one]), { sourceMessageId: one.message_id });

  assert.equal(deriveForegroundTurnOrigin([]), null, "no message: background/control input");
  assert.equal(deriveForegroundTurnOrigin([message(), message()]), null, "a batch answers no single message");
  assert.equal(deriveForegroundTurnOrigin([message({ message_id: undefined })]), null, "no stable id");
  // The server validates with z.string().uuid() and rejects the WHOLE call on failure, so a
  // non-UUID id must never be forwarded -- it would turn a card miss into a failed tool call.
  assert.equal(deriveForegroundTurnOrigin([message({ message_id: "seq-42" })]), null);
  assert.equal(
    deriveForegroundTurnOrigin([message({ message_id: "runtime-profile-daemon-release-v1.0.36" })]),
    null,
    "a runtime-profile control message has a daemon-local key, not a Raft message id",
  );
});

test("holder: a turn's origin is readable from begin until turn_end, and never after", () => {
  const holder = new RuntimeTurnOriginHolder("process-1");
  assert.equal(holder.read(), null, "nothing before the first prompt");

  holder.beginTurn({ sourceMessageId: "m-1" });
  assert.deepEqual(holder.read(), { processInstanceId: "process-1", turnEpoch: 1, sourceMessageId: "m-1" });

  holder.endTurn();
  assert.equal(holder.read(), null, "after turn_end a call belongs to no turn");

  holder.beginTurn({ sourceMessageId: "m-2" });
  assert.deepEqual(holder.read(), { processInstanceId: "process-1", turnEpoch: 2, sourceMessageId: "m-2" });

  holder.beginTurn(null);
  assert.equal(holder.read(), null, "an open turn stays open, but it no longer names either message");
});

test("holder: a new origin while the previous turn is still open fails closed -- no last-writer-wins", () => {
  const holder = new RuntimeTurnOriginHolder("process-1");
  holder.beginTurn({ sourceMessageId: "m-1" });
  holder.beginTurn({ sourceMessageId: "m-2" });
  assert.equal(holder.read(), null, "⭐ must not become m-2, and must not stay m-1");
  // e.g. a runtime error that never reported turn_end: later messages keep arriving.
  for (const later of ["m-3", "m-4", "m-5"]) {
    holder.beginTurn({ sourceMessageId: later });
    assert.equal(holder.read(), null, `⭐ ${later} must not recover the holder -- only a real boundary does`);
  }

  holder.endTurn();
  holder.beginTurn({ sourceMessageId: "m-6" });
  assert.equal(holder.read()?.sourceMessageId, "m-6", "a clean boundary restores origins");
});

test("holder: close is terminal, and a holder with no process identity never yields an origin", () => {
  const holder = new RuntimeTurnOriginHolder("process-1");
  holder.beginTurn({ sourceMessageId: "m-1" });
  holder.close();
  assert.equal(holder.read(), null);
  holder.beginTurn({ sourceMessageId: "m-2" });
  assert.equal(holder.read(), null, "a closed process cannot open another turn");

  const anonymous = new RuntimeTurnOriginHolder(null);
  anonymous.beginTurn({ sourceMessageId: "m-1" });
  assert.equal(anonymous.read(), null);
});

test("confirm: same process, same epoch, same message -- anything else sends no origin", () => {
  const holder = new RuntimeTurnOriginHolder("process-1");
  holder.beginTurn({ sourceMessageId: "m-1" });
  const captured = holder.read();

  assert.deepEqual(
    confirmRuntimeTurnOrigin({ read: holder.read, captured, expectedProcessInstanceId: "process-1" }),
    { sourceMessageId: "m-1" },
  );
  assert.equal(
    confirmRuntimeTurnOrigin({ read: holder.read, captured, expectedProcessInstanceId: "process-2" }),
    null,
    "a getter from another process instance is not this call surface's turn",
  );
  assert.equal(confirmRuntimeTurnOrigin({ read: undefined, captured, expectedProcessInstanceId: "process-1" }), null);

  // The turn ends and the next one begins with a DIFFERENT message while the call was in flight.
  holder.endTurn();
  holder.beginTurn({ sourceMessageId: "m-2" });
  assert.equal(
    confirmRuntimeTurnOrigin({ read: holder.read, captured, expectedProcessInstanceId: "process-1" }),
    null,
    "⭐ a call started in turn 1 must not be sent with turn 2's origin",
  );

  // Same message id in a later epoch is still a different turn.
  holder.endTurn();
  holder.beginTurn({ sourceMessageId: "m-1" });
  assert.equal(
    confirmRuntimeTurnOrigin({ read: holder.read, captured, expectedProcessInstanceId: "process-1" }),
    null,
  );
});

test("⭐ wiring: every driver that builds a managed MCP call surface hands it this process's getter", () => {
  // There are two call surfaces and ten places that build them. Fixing some and not others leaves
  // those runtimes silently card-less in production, and no behavioural test drives the real
  // drivers (they spawn vendor CLIs). So every construction site is pinned to pass BOTH the
  // getter and the process it belongs to, straight from the spawn context the session provided.
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const driversDir = path.join(srcDir, "drivers");
  const sites: string[] = [];
  const unwired: string[] = [];
  // The OAR host's launches (#oar-raft:#8) build theirs in one place.
  const files = [
    ...readdirSync(driversDir).filter((name) => name.endsWith(".ts") && !name.includes(".test.")).map((name) => path.join(driversDir, name)),
    path.join(srcDir, "agentHost", "oarManagedMcp.ts"),
  ];
  for (const filePath of files) {
    const file = path.basename(filePath);
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/(?:prepareManagedMcpRuntimeProxy|createManagedMcpPiTools)\(\{[\s\S]*?\n\s*\}\)/g)) {
      const site = `${file}:${source.slice(0, match.index).split("\n").length}`;
      sites.push(site);
      if (!/processInstanceId: ctx\.processInstanceId,/.test(match[0]) || !/readTurnOrigin: ctx\.readTurnOrigin,/.test(match[0])) {
        unwired.push(site);
      }
    }
  }
  assert.deepEqual(unwired, []);
  // Guard the scan itself: an empty or shrunken match set would make the check above pass vacuously.
  assert.deepEqual(
    sites.map((site) => site.split(":")[0]).sort(),
    [
      "antigravity.deprecated.ts",
      "claude.ts",
      "codex.ts",
      "copilot.ts",
      "cursor.ts",
      "gemini.ts",
      "kimi-sdk.ts",
      "kimi.ts",
      "oarManagedMcp.ts",
      "opencode.ts",
      "pi.ts",
    ],
  );
});
