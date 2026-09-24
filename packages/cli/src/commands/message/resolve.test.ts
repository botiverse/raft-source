import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { buildResolvePath, messageResolveCommand } from "./resolve.js";

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
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("buildResolvePath: encodes message id on the id-less surface", () => {
  assert.equal(
    buildResolvePath("msg/with spaces"),
    "/internal/agent-api/messages/msg%2Fwith%20spaces/resolve",
  );
});

test("message resolve command prints a canonical citation row", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            message: {
              message_id: "abcd1234-0000-0000-0000-000000000000",
              channel_type: "channel",
              channel_name: "proj-runtime",
              timestamp: "2026-05-28T00:00:00.000Z",
              sender_type: "human",
              sender_name: "xxchan",
              sender_description: "我是谁",
              content: "review this",
            },
          },
        };
      },
    }) as any,
  });

  await messageResolveCommand.handler(ctx, " abcd1234 ");

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/messages/abcd1234/resolve",
    },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /\[target=#proj-runtime msg=abcd1234 time=.* type=human\]/);
  assert.match(output, /@xxchan — 我是谁: review this/);
});

test("message resolve prints the server-projected forwarded snapshot verbatim", async () => {
  const { io, stdout, stderr } = memoryIo();
  const projectedContent = [
    "Forwarded 1 message",
    "",
    "Forwarded content snapshot:",
    "",
    "Forwarded message 1:",
    "From: @alice",
    "Source: Private source",
    "",
    "decision context survives durable resolve",
  ].join("\n");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          message: {
            message_id: "facefeed-0000-0000-0000-000000000000",
            channel_type: "channel",
            channel_name: "proj-dx",
            timestamp: "2026-05-28T00:00:02.000Z",
            sender_type: "human",
            sender_name: "cindyz",
            content: projectedContent,
          },
        },
      }),
    }) as any,
  });

  await messageResolveCommand.handler(ctx, "facefeed");

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /@cindyz: Forwarded 1 message\n\nForwarded content snapshot:/);
  assert.match(output, /From: @alice\nSource: Private source/);
  assert.match(output, /decision context survives durable resolve/);
});

test("message resolve command fails closed for unknown ids", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        data: null,
        error: "Message not found",
        errorCode: "NOT_FOUND",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageResolveCommand.handler(ctx, "4f9c2210"); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.message, "Message not found");
      assert.match(err.suggestedNextAction ?? "", /read --around only when you want nearby context/);
      return true;
    },
  );
});

test("message resolve command does not pick an ambiguous short id", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 400,
        data: null,
        error: "Message short id is ambiguous",
        errorCode: "AMBIGUOUS_ID",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageResolveCommand.handler(ctx, "aaaaaaaa"); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "AMBIGUOUS_ID");
      assert.equal(err.message, "Message short id is ambiguous");
      assert.match(err.suggestedNextAction ?? "", /full message UUID/);
      return true;
    },
  );
});
