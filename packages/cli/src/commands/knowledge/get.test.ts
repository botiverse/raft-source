import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  formatKnowledgeStdout,
  knowledgeGetCommand,
  registerKnowledgeGetCommand,
} from "./get.js";

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
  activeCapabilities: ["knowledge"],
};

test("formatKnowledgeStdout: byte-preserves content that already ends with newline", () => {
  const input = "# Hello\n\nbody\n";
  assert.equal(formatKnowledgeStdout(input), input);
});

test("formatKnowledgeStdout: appends a trailing newline when missing", () => {
  assert.equal(formatKnowledgeStdout("# Hello\n\nbody"), "# Hello\n\nbody\n");
});

test("formatKnowledgeStdout: does not parse, strip, or render component-shaped tokens", () => {
  // Regression guard per #engineering:30f5f012 agreement (msg=cbbf5cc1 +
  // msg=22d1eea3): CLI byte-preserves whatever the server returns. Future
  // structured rendering must be an explicit opt-in. If the server returns content
  // with a `<UnknownComponent>` literal or an unstripped `{/* */}` comment,
  // the CLI must surface them verbatim and let the operator notice the
  // server-side sanitation regression.
  const sourceCommentLeak = "# Doc\n\n<UnknownComponent>literal</UnknownComponent>\n\n{/* server-side comment */}\n";
  assert.equal(formatKnowledgeStdout(sourceCommentLeak), sourceCommentLeak);
});

test("manual get help points agents to the index topic catalog", () => {
  const program = new Command();
  const manual = program.command("manual");
  registerKnowledgeGetCommand(manual);
  const get = manual.commands.find((candidate) => candidate.name() === "get");

  assert.ok(get);
  let help = "";
  get.configureOutput({ writeOut: (chunk) => { help += chunk; }, writeErr: (chunk) => { help += chunk; } });
  get.outputHelp();
  assert.match(help, /raft manual get index/);
  assert.match(help, /list available manual topics/);
  assert.match(help, /--intent <text>/);
  assert.match(help, /--reason <text>/);
  assert.doesNotMatch(help, /Common topic/);
});

test("knowledge get command uses injected ApiClient and byte-preserves server content", async () => {
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
            ok: true,
            docId: "server",
            topicOrPath: "server",
            docVersion: "sha256:abc",
            docState: "available",
            contentType: "text/markdown",
            content: "# Server\n\nBody\n",
          },
        };
      },
    }) as any,
  });

  await knowledgeGetCommand.handler(ctx, "server", {
    intent: "Help the user understand their Raft server.",
    reason: "Looking up the server contract for a user answer.",
    turnId: "turn-1",
    traceId: "trace-1",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path:
        "/internal/agent-api/knowledge?topic=server&intent=Help+the+user+understand+their+Raft+server.&reason=Looking+up+the+server+contract+for+a+user+answer.&turn_id=turn-1&trace_id=trace-1",
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "# Server\n\nBody\n");
});

test("knowledge get command fails closed on malformed success", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { ok: false },
      }),
    }) as any,
  });

  await assert.rejects(
    async () => {
      await knowledgeGetCommand.handler(ctx, "server", {
        intent: "Help the user understand their Raft server.",
        reason: "Need the server contract to answer accurately.",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_JSON_RESPONSE");
      return true;
    },
  );
});

test("knowledge get command builds a fixed cross-shell-safe not-found fallback", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        error: "Manual topic not found.",
        errorCode: "knowledge_not_found",
        data: null,
      }),
    }) as any,
  });

  await assert.rejects(
    async () => {
      await knowledgeGetCommand.handler(ctx, "bad-topic", {
        intent: "Help the user understand their Raft server.",
        reason: "Need the server contract to answer accurately.",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "knowledge_not_found");
      assert.match(err.message, /Manual topic not found/);
      assert.match(err.suggestedNextAction ?? "", /--intent "Learn available Raft workflows"/);
      assert.match(err.suggestedNextAction ?? "", /--reason "Browse the topic catalog after a missing topic"/);
      assert.doesNotMatch(err.suggestedNextAction ?? "", /['$`;]/);
      return true;
    },
  );
});

test("knowledge get reports both missing context fields before loading credentials or calling the API", async () => {
  const { io } = memoryIo();
  let contextLoads = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      contextLoads += 1;
      return agentContext;
    },
  });

  await assert.rejects(
    async () => { await knowledgeGetCommand.handler(ctx, "server", {}); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "KNOWLEDGE_CONTEXT_INVALID");
      assert.equal(err.message, "Both Manual context fields are invalid: intent is required; reason is required");
      assert.match(err.suggestedNextAction ?? "", /--intent/);
      assert.match(err.suggestedNextAction ?? "", /--reason/);
      assert.match(err.suggestedNextAction ?? "", /multi-agent review pipeline/);
      assert.match(err.suggestedNextAction ?? "", /muted channel still delivers @mentions/);
      assert.match(err.suggestedNextAction ?? "", /both required fields:\n  Retry with --intent/);
      return true;
    },
  );
  assert.equal(contextLoads, 0);
});
