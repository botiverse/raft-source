import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { inboxReplacesMessageCheck, MESSAGE_CHECK_INBOX_PROBE_TIMEOUT_MS, messageCheckCommand } from "./check";
import { getConsumedExactSeqs, getConsumedSeq } from "./_consumedSeqState";

/** The `message check` probe for inbox items (RFC 081 D10): a server with the flag off answers no `rows`. */
const INBOX_LIST_EMPTY = { view: "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 } };
const INBOX_ITEMS_OFF: ApiResponse<unknown> = { ok: true, status: 200, error: null, data: INBOX_LIST_EMPTY };

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function agentEvents(messages: Array<{ seq: number; content: string; [key: string]: unknown }>, hasMore = false) {
  const last = messages[messages.length - 1];
  return {
    events: messages,
    last_seen_msgId: last ? `msg-${last.seq}` : null,
    last_seen_seq: last?.seq ?? null,
    reply_target: null,
    pending_notice_ids: [],
    wake_reason: null,
    has_more: hasMore,
  };
}

test("message check command drains inbox through injected ApiClient and writes canonical text", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-no-consume-"));
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        if (path.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
        requests.push({ method, path, body });
        if (path === "/internal/agent-api/events?since=latest&ack=cursor") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: agentEvents([{
              seq: 7,
              channel_type: "public",
              channel_name: "proj-runtime",
              message_id: "abcd1234-0000-0000-0000-000000000000",
              timestamp: "2026-05-28T00:00:00.000Z",
              sender_type: "human",
              sender_name: "xxchan",
              content: "review this",
            }]),
          };
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        };
      },
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/events?since=latest&ack=cursor", body: undefined },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /target=#proj-runtime/);
  assert.match(output, /msg=abcd1234/);
  assert.match(output, /@xxchan: review this/);
  assert.equal(
    getConsumedSeq(agentContext.agentId, "#proj-runtime"),
    undefined,
    "message check is a sparse attention/event drain and must not seed a high-water model-seen boundary",
  );
  assert.deepEqual(
    getConsumedExactSeqs(agentContext.agentId, "#proj-runtime"),
    [7],
    "message check must retain exact rendered seqs without claiming the gaps",
  );
});

test("message check is gone where the server lists inbox items: it points to the inbox and drains nothing (RFC 081 D10)", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
        requests.push(requestPath);
        return { ok: true, status: 200, error: null, data: { ...INBOX_LIST_EMPTY, rows: [], preLaunch: null } };
      },
    }) as any,
  });

  await assert.rejects(async () => messageCheckCommand.handler(ctx), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "MESSAGE_CHECK_REMOVED");
    assert.match(String((error as { suggestedNextAction?: string }).suggestedNextAction), /raft inbox check .*raft inbox read --target <item>/);
    return true;
  });
  assert.deepEqual(requests, ["/internal/agent-api/inbox/conversations?items=true"], "nothing is drained");
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, []);
});

test("message check keeps draining for a personal assistant, whose inbox lists app rows only (appRowsOnly)", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-assistant-"));
  const { io } = memoryIo();
  const requests: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
        requests.push(requestPath);
        if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) {
          return { ok: true, status: 200, error: null, data: { ...INBOX_LIST_EMPTY, rows: [], preLaunch: null, appRowsOnly: true } };
        }
        if (requestPath.startsWith("/internal/agent-api/events")) return { ok: true, status: 200, error: null, data: agentEvents([]) };
        return { ok: true, status: 200, error: null, data: { ok: true } };
      },
    }) as any,
  });

  await messageCheckCommand.handler(ctx);
  assert.ok(requests.some((p) => p.startsWith("/internal/agent-api/events")), "the owner DM still drains through /events");
});

test("message check reads as before whenever the inbox probe isn't a positive answer: 400, 403, 404, 500, 503 INBOX_UNAVAILABLE", async () => {
  for (const status of [400, 403, 404, 500, 503]) {
    process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-probe-"));
    const { io } = memoryIo();
    const requests: string[] = [];
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
          requests.push(requestPath);
          if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) {
            return { ok: false, status, error: "Inbox is temporarily unavailable", errorCode: status === 503 ? "INBOX_UNAVAILABLE" : undefined, data: null } as ApiResponse<unknown>;
          }
          if (requestPath.startsWith("/internal/agent-api/events")) return { ok: true, status: 200, error: null, data: agentEvents([]) };
          return { ok: true, status: 200, error: null, data: { ok: true } };
        },
      }) as any,
    });
    await messageCheckCommand.handler(ctx);
    assert.ok(requests.some((p) => p.startsWith("/internal/agent-api/events")), `status ${status} still drains`);
  }
});

test("a probe with no answer within the timeout reads as before; a thrown request does too", async () => {
  const never = { request: () => new Promise<ApiResponse<unknown>>(() => {}) };
  const started = Date.now();
  assert.equal(await inboxReplacesMessageCheck(never as any, 30), false);
  assert.ok(Date.now() - started < 1_000, "the timeout ends the probe");
  const throws = { request: async () => { throw new Error("socket hang up"); } };
  assert.equal(await inboxReplacesMessageCheck(throws as any, 30), false);
  assert.ok(MESSAGE_CHECK_INBOX_PROBE_TIMEOUT_MS >= 1_000, "long enough for the proxy's one retry (400 ms) to finish");
});

test("message check command prints the server's inbox hint after the messages", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-inbox-hint-"));
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => requestPath.startsWith("/internal/agent-api/inbox/conversations") ? INBOX_ITEMS_OFF : ({
        ok: true,
        status: 200,
        error: null,
        data: {
          ...agentEvents([{ seq: 9, channel_type: "channel", channel_name: "general", content: "recovered" }]),
          inbox_hint: { unread_conversations: 4, command: "raft inbox check" },
        },
      }),
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  const output = stdout.join("");
  assert.match(output, /recovered/);
  assert.ok(
    output.endsWith("No more new inbox messages.\nStill unread: 4 conversations. Run `raft inbox check` to list them.\n"),
    output,
  );
});

test("message check command renders an actionable hint when more messages may remain", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_test",
    }),
    createApiClient: () => {
      let calls = 0;
      return {
        request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
          if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
          calls += 1;
          if (calls === 1) {
            return {
              ok: true,
              status: 200,
              error: null,
              data: agentEvents([{ seq: 8, content: "visible before retry failure" }], true),
            };
          }
          return {
            ok: false,
            status: 503,
            error: "events temporarily unavailable",
            data: null,
          };
        },
      } as any;
    },
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /visible before retry failure/);
  assert.match(output, /More messages are pending\. Run `raft message check` again\./);
});

test("message check command renders a final-drain hint when one explicit batch is complete", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_test",
    }),
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => requestPath.startsWith("/internal/agent-api/inbox/conversations") ? INBOX_ITEMS_OFF : ({
        ok: true,
        status: 200,
        error: null,
        data: agentEvents([{ seq: 8, content: "complete batch" }], false),
      }),
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /complete batch/);
  assert.match(output, /No more new inbox messages\./);
  assert.doesNotMatch(output, /More messages are pending/);
});

test("message check command renders a final-drain hint when has_more batches were fully drained", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_test",
    }),
    createApiClient: () => {
      let calls = 0;
      return {
        request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
          if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
          calls += 1;
          return {
            ok: true,
            status: 200,
            error: null,
            data: agentEvents([{ seq: calls, content: `batch ${calls}` }], calls === 1),
          };
        },
      } as any;
    },
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /batch 1/);
  assert.match(output, /batch 2/);
  assert.match(output, /No more new inbox messages\./);
  assert.doesNotMatch(output, /More messages are pending/);
  assert.doesNotMatch(output, /Additional pending message batches/);
});

test("message check command exposes pending App Inbox work after an empty managed drain without rendering actions", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
    }),
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
        requests.push({ method, path: requestPath, body });
        if (requestPath === "/internal/agent-api/events?since=latest") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: agentEvents([]),
          };
        }
        if (requestPath === "/internal/agent-api/inbox") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              rows: [],
              pending_app_items: 1,
              items: [{
                source: "app",
                itemId: "reminder:synthetic:1",
                appId: "reminder",
                notificationClass: "fire",
                sourceRef: { kind: "reminder", id: "synthetic", revision: "1" },
                primaryAction: { kind: "run_command", commandId: "reminder.ack" },
                actionCli: "raft reminder ack --id synthetic --revision 1",
                retention: "until_explicit_ack",
                title: "Synthetic pending reminder",
              }],
            },
          };
        }
        throw new Error(`Unexpected request: ${method} ${requestPath}`);
      },
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/events?since=latest", body: undefined },
    { method: "GET", path: "/internal/agent-api/inbox", body: undefined },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /App items pending: 1\. Run `raft inbox check` to inspect them\./);
  assert.doesNotMatch(output, /reminder ack/);
  assert.doesNotMatch(output, /synthetic/);
});

test("message check command leaves an empty managed drain unchanged when App Inbox is empty", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
    }),
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
        if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
        requests.push(requestPath);
        if (requestPath === "/internal/agent-api/events?since=latest") {
          return { ok: true, status: 200, error: null, data: agentEvents([]) };
        }
        if (requestPath === "/internal/agent-api/inbox") {
          return { ok: true, status: 200, error: null, data: { rows: [], items: [], pending_app_items: 0 } };
        }
        throw new Error(`Unexpected request: ${requestPath}`);
      },
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(requests, [
    "/internal/agent-api/events?since=latest",
    "/internal/agent-api/inbox",
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "No new inbox messages.\n");
});

test("message check command does not query App Inbox when a managed drain returns messages", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "managed-runner",
      secretSource: "agent-proxy-token-env",
    }),
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
        if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
        requests.push(requestPath);
        return {
          ok: true,
          status: 200,
          error: null,
          data: agentEvents([{ seq: 9, content: "ordinary message" }]),
        };
      },
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(requests, ["/internal/agent-api/events?since=latest"]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /ordinary message/);
});

test("message check command maps events failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => requestPath.startsWith("/internal/agent-api/inbox/conversations") ? INBOX_ITEMS_OFF : ({
        ok: false,
        status: 409,
        data: null,
        error: "events conflict",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageCheckCommand.handler(ctx); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CHECK_FAILED");
      assert.equal(err.message, "events conflict");
      return true;
    },
  );
});

test("message check command fails loud when the inbox events surface returns 5xx", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => requestPath.startsWith("/internal/agent-api/inbox/conversations") ? INBOX_ITEMS_OFF : ({
        ok: false,
        status: 503,
        data: null,
        error: "events temporarily unavailable",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageCheckCommand.handler(ctx); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "SERVER_5XX");
      assert.equal(err.message, "events temporarily unavailable");
      return true;
    },
  );
  assert.deepEqual(stdout, [], "an unavailable inbox surface must never print an empty-inbox claim");
});

test("message check command says app items are unavailable after an empty external drain", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
        if (requestPath.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
        requests.push(requestPath);
        if (requestPath === "/internal/agent-api/events?since=latest&ack=cursor") {
          return { ok: true, status: 200, error: null, data: agentEvents([]) };
        }
        throw new Error(`Unexpected request: ${requestPath}`);
      },
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(requests, ["/internal/agent-api/events?since=latest&ack=cursor"]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "No new inbox messages.\n\nApp items: not available for external agents.\n");
});

// Task #178 — managed runners ack leased third-party events on the daemon only
// after the rendered bodies reached stdout.
const managedAgentContext: AgentContext = { ...agentContext, clientMode: "managed-runner" };
const LEASE_EVENT_ID = "0f3b6c2e-8d41-4a7b-9c55-1e2f3a4b5c6d";

function leasedThirdPartyEvents() {
  return {
    ...agentEvents([{
      seq: 0,
      channel_type: "dm",
      channel_name: "third-party-agent-events:agent-1",
      message_id: LEASE_EVENT_ID,
      timestamp: "2026-09-28T00:00:00.000Z",
      sender_type: "third_party_app",
      sender_name: "stamp",
      content: "Third-party event: pr approved",
      third_party_event: { id: LEASE_EVENT_ID, kind: "pr_approved" },
    }]),
    third_party_lease: { batch_id: "batch-1", event_ids: [LEASE_EVENT_ID], expires_at: "2026-09-28T00:01:00.000Z" },
  };
}

function managedClient(
  requests: Array<{ method: string; path: string; body: unknown; headers?: Record<string, string> }>,
  ackStatus = 200,
) {
  return {
    request: async (method: string, path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<ApiResponse<unknown>> => {
      if (path.startsWith("/internal/agent-api/inbox/conversations")) return INBOX_ITEMS_OFF;
      requests.push({ method, path, body, headers: options?.headers });
      if (path === "/internal/agent-api/events?since=latest") {
        return { ok: true, status: 200, error: null, data: leasedThirdPartyEvents() };
      }
      if (path === "/internal/agent-api/third-party-events/ack") {
        return ackStatus === 200
          ? { ok: true, status: 200, error: null, data: { ok: true, batchId: "batch-1", acked: [LEASE_EVENT_ID] } }
          : { ok: false, status: ackStatus, error: "Not found", data: null };
      }
      return { ok: true, status: 200, error: null, data: { ok: true } };
    },
  } as any;
}

test("task #178: message check declares the lease on /events and acks the batch after the output was written", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-lease-"));
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown; headers?: Record<string, string> }> = [];
  let outputAtAck = -1;
  const client = managedClient(requests);
  const inner = client.request;
  client.request = async (method: string, path: string, body?: unknown, options?: { headers?: Record<string, string> }) => {
    if (path === "/internal/agent-api/third-party-events/ack") outputAtAck = stdout.join("").length;
    return inner(method, path, body, options);
  };
  const ctx = createCommandContext({ io, loadAgentContext: () => managedAgentContext, createApiClient: () => client });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /Third-party event: pr approved/);
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [
    ["GET", "/internal/agent-api/events?since=latest"],
    ["POST", "/internal/agent-api/third-party-events/ack"],
  ]);
  assert.deepEqual(requests[0]?.headers, { "x-raft-events-ack": "lease" }, "the lease is declared on the same path that acks");
  assert.deepEqual(requests[1]?.body, { batchId: "batch-1", eventIds: [LEASE_EVENT_ID] });
  assert.ok(outputAtAck > 0 && outputAtAck === output.length, "the ack is sent only after the whole rendered body reached stdout");
});

test("task #178: message check does not ack when stdout cannot be written", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-lease-epipe-"));
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const io: CliIo = {
    stdout: {
      write: (_chunk: string | Uint8Array): boolean => {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
    },
    stderr: { write: (_chunk: string | Uint8Array) => true },
  };
  const ctx = createCommandContext({ io, loadAgentContext: () => managedAgentContext, createApiClient: () => managedClient(requests) });

  await assert.rejects(async () => { await messageCheckCommand.handler(ctx); }, /EPIPE/);
  assert.deepEqual(requests.map((request) => request.path), ["/internal/agent-api/events?since=latest"], "no ack without a successful write");
});

test("task #178: a daemon without the ack route (older daemon) does not fail message check", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-lease-old-"));
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({ io, loadAgentContext: () => managedAgentContext, createApiClient: () => managedClient(requests, 404) });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Third-party event: pr approved/);
  assert.deepEqual(requests.map((request) => request.path), [
    "/internal/agent-api/events?since=latest",
    "/internal/agent-api/third-party-events/ack",
  ]);
});
