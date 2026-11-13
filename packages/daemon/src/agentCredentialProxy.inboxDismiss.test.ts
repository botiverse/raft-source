import assert from "node:assert/strict";
import http from "node:http";

import { ApiClient } from "../../cli/src/client";
import type { AgentContext } from "../../cli/src/auth/env";
import { inboxDismissCommand } from "../../cli/src/commands/inbox/dismiss";
import { createCommandContext } from "../../cli/src/core/context";
import { CliError } from "../../cli/src/core/errors";
import { formatErrorEnvelope } from "../../cli/src/core/renderer";
import { CLEANER_APP_ID, CLEANER_DISK_NOTIFICATION_CLASS, CLEANER_NOTIFICATION_CLASS } from "../../shared/src/apps/cleaner/configProtocol";
import { agentInboxAppItemDismissTarget, type AgentInboxAppItem } from "@botiverse/raft-shared";

import { createAgentAppInboxStore, type AgentAppInboxStore } from "./agentAppInbox";
import {
  __resetAgentCredentialProxyForTest,
  INBOX_DISMISS_PATH,
  registerAgentCredentialProxy,
  unregisterAgentCredentialProxyForLaunch,
} from "./agentCredentialProxy";
import { createSystemCleanerAppRegistry } from "./apps/cleaner/definition";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./apps/reminder/inboxDefinition";
import { REMINDER_SERVER_ACK_CAPABILITY } from "./reminderServerAck";

// `raft inbox dismiss --target <the target a Computer-local app item's row
// prints>` (the Cleaner's items): the daemon's agent credential proxy removes
// the calling agent's one item with that target and answers as the Server
// answers one dismissed app item. Every other dismiss, a target that names
// no such item or more than one included, is forwarded to the Server as it
// came, and the Server's answer is the agent's.

afterEach(async () => {
  await __resetAgentCredentialProxyForTest();
});

type Forwarded = { method: string; url: string; body: string };

/** An upstream Server that records what reached it and answers with `answer`. */
async function withServer(
  answer: (request: Forwarded) => { status: number; body: Record<string, unknown> },
  run: (serverUrl: string, forwarded: Forwarded[]) => Promise<void>,
): Promise<void> {
  const forwarded: Forwarded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = { method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") };
      forwarded.push(request);
      const { status, body } = answer(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, forwarded);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const neverForwarded = () => ({ status: 500, body: { error: "a local dismiss must not reach the Server" } });

type Trace = { name: string; attrs: Record<string, unknown> };

/** A store with the production registry of the two built-in apps (the Cleaner's and the reminder's). */
function inboxStore(agentId: string, options?: { idFactory?: () => string; nowMs?: () => number; traces?: Trace[] }): AgentAppInboxStore {
  const store = createAgentAppInboxStore({
    registry: {
      ...REMINDER_AGENT_INBOX_REGISTRY,
      ...createSystemCleanerAppRegistry(() => ({ thresholdBytes: 1_024, maximumThresholdBytes: 4_096 })),
    },
    ownerAgentId: agentId,
    idFactory: options?.idFactory,
    nowMs: options?.nowMs,
    trace: (name, attrs) => { options?.traces?.push({ name, attrs }); },
    beforeAck: () => true,
  });
  // The reminder backfill has its own tests: here the store is past it.
  store.markServerAckBackfillDone(REMINDER_SERVER_ACK_CAPABILITY);
  return store;
}

function mintBackupIgnoreReminder(store: AgentAppInboxStore, agentId: string): AgentInboxAppItem {
  const minted = store.mint({
    appId: CLEANER_APP_ID,
    notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
    sourceRef: { kind: "backup_ignore_hint", agentId },
    title: "Review .raftbackupignore",
  });
  if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
  return minted.item;
}

function mintMemoryHint(store: AgentAppInboxStore, agentId: string): AgentInboxAppItem {
  const minted = store.mint({
    appId: CLEANER_APP_ID,
    notificationClass: CLEANER_NOTIFICATION_CLASS,
    sourceRef: { kind: "memory_hint", agentId },
    title: "MEMORY.md is large",
  });
  if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
  return minted.item;
}

function mintReminder(store: AgentAppInboxStore, reminderId: string): AgentInboxAppItem {
  const minted = store.mint({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: reminderId, revision: "1" },
    title: "check the deploy",
  });
  if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
  return minted.item;
}

let launches = 0;

async function withProxy(
  agentId: string,
  serverUrl: string,
  store: AgentAppInboxStore,
  run: (proxy: {
    dismiss: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
    /** Any method and any raw body on the dismiss route. */
    send: (method: string, rawBody: string) => Promise<{ status: number; body: Record<string, unknown> }>;
    /** `raft inbox dismiss --target <target>` through the proxy: what it printed, or the error it threw. */
    cli: (target: string) => Promise<{ stdout: string; error: unknown }>;
  }) => Promise<void>,
): Promise<void> {
  launches += 1;
  const launchId = `launch-inbox-dismiss-${launches}`;
  const handle = await registerAgentCredentialProxy({
    agentId,
    launchId,
    serverUrl,
    apiKey: "sk_agent_server_side",
    activeCapabilities: "read",
    appInbox: store,
  });
  await handle.serverAckBackfill;
  const agentContext: AgentContext = {
    agentId,
    serverId: "server-1",
    serverUrl: handle.proxyUrl,
    token: handle.proxyToken,
    clientMode: "managed-runner",
    secretSource: "agent-proxy-token-env",
    activeCapabilities: null,
  };
  const send = async (method: string, rawBody: string) => {
    const response = await fetch(`${handle.proxyUrl}${INBOX_DISMISS_PATH}`, {
      method,
      headers: { Authorization: `Bearer ${handle.proxyToken}`, "content-type": "application/json" },
      body: rawBody,
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    await run({
      dismiss: (body) => send("POST", JSON.stringify(body)),
      send,
      cli: async (target) => {
        const stdout: string[] = [];
        const ctx = createCommandContext({
          io: { stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } }, stderr: { write: () => true } },
          loadAgentContext: () => agentContext,
          createApiClient: () => new ApiClient(agentContext),
        });
        let error: unknown = null;
        await Promise.resolve(inboxDismissCommand.handler(ctx, { target })).catch((err: unknown) => { error = err; });
        return { stdout: stdout.join(""), error };
      },
    });
  } finally {
    unregisterAgentCredentialProxyForLaunch({ agentId, launchId });
  }
}

// What the Server answers for an item that is not the agent's or does not
// exist (refuseInboxItemNotFound, packages/server/src/routes/agentInboxItemsRoutes.ts).
const SERVER_NOT_FOUND = { error: "Not found, or you don't have access.", code: "NOT_FOUND", errorCode: "NOT_FOUND" };
const serverNotFound = () => ({ status: 404, body: SERVER_NOT_FOUND });

test("a dismiss with the target a Computer-local app item's row prints removes that item and answers in the Server's shape, without reaching the Server", async () => {
  const traces: Trace[] = [];
  const mintedAtMs = Date.parse("2026-11-12T08:00:00.000Z");
  const store = inboxStore("agent-a", { traces, nowMs: () => mintedAtMs });
  const reminder = mintBackupIgnoreReminder(store, "agent-a");
  const memory = mintMemoryHint(store, "agent-a");
  const target = agentInboxAppItemDismissTarget(reminder);
  assert.equal(target, `app:system.cleaner/${reminder.itemId.slice(0, 8)}`, "the app and the item id as the row prints it");

  await withServer(neverForwarded, async (serverUrl, forwarded) => {
    await withProxy("agent-a", serverUrl, store, async ({ dismiss }) => {
      const answer = await dismiss({ target });
      assert.equal(answer.status, 200);
      // handleInboxDismiss's `deps.answer` for one dismissed app item.
      assert.deepEqual(answer.body, {
        dismissed: 1,
        conversations: 0,
        appItems: 1,
        skippedNeedsAck: 0,
        earliestActivityAt: "2026-11-12T08:00:00.000Z",
        remaining: 0,
      });
      assert.deepEqual(store.list().map((item) => item.itemId), [memory.itemId], "only the named item is gone");
    });
    assert.deepEqual(forwarded, [], "nothing reached the Server");
  });

  assert.deepEqual(
    traces.filter((trace) => trace.name === "daemon.app_inbox.ack").map((trace) => [trace.attrs.outcome, trace.attrs.retention]),
    [["dismissed", "transient"]],
    "traced as a dismissal, not as an ack",
  );
  assert.deepEqual(store.listAcknowledgedSources(), [], "nothing is recorded as acknowledged");
});

test("the CLI command through the proxy: a local item is dismissed; the same command again is the Server's NOT_FOUND", async () => {
  const store = inboxStore("agent-a");
  const reminder = mintBackupIgnoreReminder(store, "agent-a");
  const target = agentInboxAppItemDismissTarget(reminder)!;
  await withServer(serverNotFound, async (serverUrl, forwarded) => {
    await withProxy("agent-a", serverUrl, store, async ({ cli }) => {
      const dismissed = await cli(target);
      assert.equal(dismissed.error, null);
      assert.equal(dismissed.stdout, "Dismissed 1 item; not read.\nNext: raft inbox check\n");
      assert.deepEqual(store.list(), []);
      assert.equal(forwarded.length, 0, "the dismissal did not reach the Server");

      // Gone: the target names no local item any more, so the Server answers.
      const again = await cli(target);
      assert.ok(again.error instanceof CliError, String(again.error));
      assert.equal(formatErrorEnvelope(again.error), [
        `Error: No inbox item ${target} that you can dismiss.`,
        "Code: NOT_FOUND",
        "Next action: raft inbox check lists your items.",
        "",
      ].join("\n"));
      assert.deepEqual(forwarded.map((request) => request.body), [JSON.stringify({ target })]);
    });
  });
});

test("only the calling agent's own item with exactly that target: another agent's, an unknown one, a full id and an ambiguous one go to the Server and remove nothing", async () => {
  const storeA = inboxStore("agent-a");
  const storeB = inboxStore("agent-b");
  const own = mintBackupIgnoreReminder(storeA, "agent-a");
  const others = mintBackupIgnoreReminder(storeB, "agent-b");
  assert.notEqual(own.itemId, others.itemId);

  // Two items whose printed (shortened) ids, and so their targets, are the same.
  let next = 0;
  const twins = inboxStore("agent-c", { idFactory: () => `1a2b3c4d-000${next += 1}` });
  const first = mintBackupIgnoreReminder(twins, "agent-c");
  const second = mintMemoryHint(twins, "agent-c");
  assert.equal(agentInboxAppItemDismissTarget(first), "app:system.cleaner/1a2b3c4d");
  assert.equal(agentInboxAppItemDismissTarget(second), "app:system.cleaner/1a2b3c4d");

  await withServer(serverNotFound, async (serverUrl, forwarded) => {
    await withProxy("agent-a", serverUrl, storeA, async ({ dismiss }) => {
      const targets = [
        agentInboxAppItemDismissTarget(others)!,
        "app:system.cleaner/00000000",
        // No row prints the full id: it is not a local target.
        `app:system.cleaner/${own.itemId}`,
      ];
      for (const target of targets) {
        const answer = await dismiss({ target });
        assert.equal(answer.status, 404, target);
        assert.deepEqual(answer.body, SERVER_NOT_FOUND, target);
      }
      assert.deepEqual(forwarded.map((request) => request.body), targets.map((target) => JSON.stringify({ target })), "each reached the Server as it was sent");
      assert.deepEqual(storeA.list().map((item) => item.itemId), [own.itemId]);
      assert.deepEqual(storeB.list().map((item) => item.itemId), [others.itemId], "the other agent's item is untouched");
    });
    forwarded.length = 0;
    await withProxy("agent-c", serverUrl, twins, async ({ dismiss }) => {
      const ambiguous = await dismiss({ target: "app:system.cleaner/1a2b3c4d" });
      assert.equal(ambiguous.status, 404);
      assert.deepEqual(ambiguous.body, SERVER_NOT_FOUND);
      assert.equal(forwarded.length, 1, "the Server answered");
      assert.deepEqual(twins.list().map((item) => item.itemId).sort(), [first.itemId, second.itemId].sort(), "neither is removed");
    });
  });
});

test("every other dismiss is the Server's: --before, a conversation, a Server app item, a malformed body and another method are forwarded unchanged", async () => {
  const store = inboxStore("agent-a");
  const local = mintBackupIgnoreReminder(store, "agent-a");
  const localTarget = agentInboxAppItemDismissTarget(local)!;
  const serverAnswer = { dismissed: 3, conversations: 2, appItems: 1, skippedNeedsAck: 1, earliestActivityAt: "2026-06-01T08:00:00.000Z", remaining: 0 };
  await withServer(() => ({ status: 200, body: serverAnswer }), async (serverUrl, forwarded) => {
    await withProxy("agent-a", serverUrl, store, async ({ send }) => {
      const requests: Array<[method: string, rawBody: string]> = [
        ["POST", JSON.stringify({ before: "2026-06-01" })],
        ["POST", JSON.stringify({ target: "#general" })],
        ["POST", JSON.stringify({ target: "dm:@richard" })],
        ["POST", JSON.stringify({ target: "app:stamp/pr-13754" })],
        ["POST", JSON.stringify({ target: "app:stamp" })],
        // Not this item's app, though its ref is the local item's printed id.
        ["POST", JSON.stringify({ target: `app:stamp/${local.itemId.slice(0, 8)}` })],
        // Both given is the Server's INVALID_ARG to answer.
        ["POST", JSON.stringify({ target: localTarget, before: "2026-06-01" })],
        // A body that is not JSON, or not a request object, is the Server's to refuse.
        ["POST", `{"target": "${localTarget}"`],
        ["POST", JSON.stringify([{ target: localTarget }])],
        ["POST", JSON.stringify({ target: 7 })],
        // Only a POST is a dismiss: another method on the route is forwarded, even with a local target.
        ["PUT", JSON.stringify({ target: localTarget })],
      ];
      for (const [method, rawBody] of requests) {
        const answer = await send(method, rawBody);
        assert.equal(answer.status, 200, `${method} ${rawBody}`);
        assert.deepEqual(answer.body, serverAnswer, `${method} ${rawBody}`);
      }
      assert.deepEqual(
        forwarded.map((request) => [request.method, request.url, request.body]),
        requests.map(([method, rawBody]) => [method, INBOX_DISMISS_PATH, rawBody]),
        "each reached the Server as it was sent",
      );
      assert.deepEqual(store.list().map((item) => item.itemId), [local.itemId], "and no local item was touched");
    });
  });
});

test("a reminder is never dismissed here: its targets go to the Server, which refuses as before, and the local item stays", async () => {
  const reminderId = "cccccccc-0000-4000-8000-000000000003";
  const store = inboxStore("agent-a");
  const reminder = mintReminder(store, reminderId);
  assert.equal(agentInboxAppItemDismissTarget(reminder), null, "its row prints no dismiss command");
  const needsAck = {
    error: "A reminder can't be dismissed: it stays in the inbox until each fired revision is acked.",
    code: "NEEDS_ACK",
    errorCode: "NEEDS_ACK",
    suggestedNextAction: `raft reminder ack --id ${reminderId} --revision 1`,
  };
  await withServer(
    (request) => (request.body.includes('"target":"reminder:') ? { status: 409, body: needsAck } : serverNotFound()),
    async (serverUrl, forwarded) => {
      await withProxy("agent-a", serverUrl, store, async ({ dismiss, cli }) => {
        const byReminderTarget = await dismiss({ target: `reminder:${reminderId}` });
        assert.equal(byReminderTarget.status, 409);
        assert.deepEqual(byReminderTarget.body, needsAck);
        // Named the way a local app item is, by its full or its printed item id: still the Server's to refuse.
        for (const ref of [reminder.itemId, reminder.itemId.slice(0, 8)]) {
          const byAppTarget = await dismiss({ target: `app:system.reminder/${ref}` });
          assert.equal(byAppTarget.status, 404, ref);
          assert.deepEqual(byAppTarget.body, SERVER_NOT_FOUND, ref);
        }
        assert.equal(forwarded.length, 3, "all three reached the Server");
        assert.deepEqual(store.list().map((item) => item.itemId), [reminder.itemId], "the reminder is still in the Inbox");

        const viaCli = await cli(`reminder:${reminderId}`);
        assert.ok(viaCli.error instanceof CliError, String(viaCli.error));
        assert.equal(viaCli.error.code, "NEEDS_ACK");
        assert.equal(store.list().length, 1);
      });
    },
  );
});

test("a sealed local item has no dismiss target, so naming it goes to the Server and removes nothing", async () => {
  // Only a durable item can be sealed; the Cleaner's are transient, so a fixture class stands in.
  const store = createAgentAppInboxStore({
    registry: {
      "test.fixture": {
        notice: {
          retention: "until_source_read",
          primaryAction: { kind: "run_command", commandId: "fixture.review" },
          normalizeSourceRef: (raw) => {
            const ref = raw as { kind?: unknown; id?: unknown };
            return ref?.kind === "fixture" && typeof ref.id === "string"
              ? { ok: true, ref: { kind: "fixture", id: ref.id } }
              : { ok: false, message: "invalid fixture ref" };
          },
          materializeActionCli: () => "raft fixture review",
        },
      },
    },
    idFactory: () => "f1x7ur3e-0001",
  });
  const minted = store.mint({ appId: "test.fixture", notificationClass: "notice", sourceRef: { kind: "fixture", id: "one" } });
  if (!minted.ok) throw new Error(`mint failed: ${minted.message}`);
  assert.equal(agentInboxAppItemDismissTarget(minted.item), "app:test.fixture/f1x7ur3e");
  const source = { appId: "test.fixture", notificationClass: "notice", sourceRef: minted.item.sourceRef };
  assert.ok(store.sealSources({ sources: [source], owner: "@Stone", until: "the review is over" }));
  assert.equal(agentInboxAppItemDismissTarget(store.list()[0]!), null, "a sealed row prints no dismiss command");
  await withServer(serverNotFound, async (serverUrl, forwarded) => {
    await withProxy("agent-a", serverUrl, store, async ({ dismiss }) => {
      const sealed = await dismiss({ target: "app:test.fixture/f1x7ur3e" });
      assert.equal(sealed.status, 404);
      assert.equal(forwarded.length, 1, "the Server answered");
      assert.equal(store.list().length, 1);

      assert.ok(store.unsealSources({ sources: [source] }));
      assert.equal((await dismiss({ target: "app:test.fixture/f1x7ur3e" })).status, 200);
      assert.deepEqual(store.list(), []);
      assert.equal(forwarded.length, 1);
    });
  });
});
