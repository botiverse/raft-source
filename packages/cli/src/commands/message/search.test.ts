import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { formatSearchResults } from "./_format.js";
import { messageSearchCommand } from "./search.js";

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

test("message search command uses injected ApiClient and writes canonical results", async () => {
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
            results: [
              {
                id: "abcd1234-0000-0000-0000-000000000000",
                seq: 7,
                channelId: "channel-1",
                threadId: null,
                parentMessageId: null,
                parentMessageContent: null,
                parentChannelId: "channel-1",
                parentChannelName: "proj-runtime",
                parentChannelType: "channel",
                parentChannelArchivedAt: null,
                senderId: "user-1",
                createdAt: "2026-05-28T00:00:00.000Z",
                channelType: "public",
                channelArchivedAt: null,
                channelName: "proj-runtime",
                senderName: "xxchan",
                senderType: "human",
                content: "review this",
                snippet: "review <mark>this</mark>",
              },
            ],
            hasMore: false,
          },
        };
      },
    }) as any,
  });

  await messageSearchCommand.handler(ctx, {
    query: " review ",
    target: "#proj-runtime",
    sender: "@xxchan",
    sort: "recent",
    limit: "20",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/search?q=review&channel=%23proj-runtime&sender=xxchan&sort=recent&limit=20",
    },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /Search results for: "review" \(1 result\)/);
  assert.match(output, /<result ref="msg:abcd1234-0000-0000-0000-000000000000">/);
  assert.match(output, /Source: channel:proj-runtime/);
  assert.match(output, /Sender: xxchan \(human\)/);
  assert.match(output, /<match>review<\/match> this/);
  assert.doesNotMatch(output, /\btarget:/);
  assert.doesNotMatch(output, /\bnext:/);
});

test("message search command accepts legacy --channel alias during target transition", async () => {
  const { io } = memoryIo();
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
          data: { results: [], hasMore: false },
        };
      },
    }) as any,
  });

  await messageSearchCommand.handler(ctx, {
    channel: "#proj-runtime",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/search?channel=%23proj-runtime&sort=recent",
    },
  ]);
});

test("message search command supports sender-only recent timeline", async () => {
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
            results: [
              {
                id: "feed1234-0000-0000-0000-000000000000",
                seq: 17,
                channelId: "channel-1",
                threadId: null,
                parentMessageId: null,
                parentMessageContent: null,
                parentChannelId: "channel-1",
                parentChannelName: "wg-raft-cli",
                parentChannelType: "channel",
                parentChannelArchivedAt: null,
                senderId: "user-1",
                createdAt: "2026-07-01T00:00:00.000Z",
                channelType: "public",
                channelArchivedAt: null,
                channelName: "wg-raft-cli",
                senderName: "xxchan",
                senderType: "human",
                content: "timeline entry without keyword match",
                snippet: "timeline entry without keyword match",
              },
            ],
            hasMore: false,
          },
        };
      },
    }) as any,
  });

  await messageSearchCommand.handler(ctx, {
    sender: "@xxchan",
    limit: "20",
    offset: "40",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/search?sender=xxchan&sort=recent&limit=20&offset=40",
    },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /Filtered message results \(1 result\)/);
  assert.match(output, /timeline entry without keyword match/);
  assert.doesNotMatch(output, /<match>/);
});

test("message search command normalizes naive filters in the CLI display timezone", async () => {
  const { io } = memoryIo();
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
          data: { results: [], hasMore: false },
        };
      },
    }) as any,
  });

  await messageSearchCommand.handler(ctx, {
    after: "2026-08-06T04:38:36",
    before: "2026-08-06T04:38:38",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/search?sort=recent&before=2026-08-06T04%3A38%3A38.000%2B08%3A00&after=2026-08-06T04%3A38%3A36.000%2B08%3A00",
    },
  ]);
});

test("message search command round-trips rendered and truncated Time output as local instants", async () => {
  const { io } = memoryIo();
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
          data: { results: [], hasMore: false },
        };
      },
    }) as any,
  });
  const searchOutput = formatSearchResults("", {
    results: [
      {
        id: "time-source",
        seq: 1,
        createdAt: "2026-08-05T20:38:36.000Z",
        channelType: "channel",
        channelName: "proj-search",
        senderName: "hipp",
        senderType: "agent",
        content: "timezone probe",
        snippet: "timezone probe",
      },
    ],
  });
  const renderedTime = searchOutput.match(/^Time: (.+)$/m)?.[1];
  assert.equal(renderedTime, "2026-08-06 04:38:36 +08:00");
  const truncatedTime = renderedTime.replace(/ [+-]\d{2}:\d{2}$/, "");
  assert.equal(truncatedTime, "2026-08-06 04:38:36");

  await messageSearchCommand.handler(ctx, {
    after: renderedTime,
    before: renderedTime,
  });
  await messageSearchCommand.handler(ctx, {
    after: truncatedTime,
    before: truncatedTime,
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/search?sort=recent&before=2026-08-06T04%3A38%3A36.000%2B08%3A00&after=2026-08-06T04%3A38%3A36.000%2B08%3A00",
    },
    {
      method: "GET",
      path: "/internal/agent-api/search?sort=recent&before=2026-08-06T04%3A38%3A36.000%2B08%3A00&after=2026-08-06T04%3A38%3A36.000%2B08%3A00",
    },
  ]);
});

test("message search command rejects empty searches without query or filters", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => {
      await messageSearchCommand.handler(ctx, {
        limit: "20",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--query is required unless --sender, --target, --before, or --after is provided");
      return true;
    },
  );
});

test("message search command rejects relevance sort for filter-only search", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => {
      await messageSearchCommand.handler(ctx, {
        sender: "@xxchan",
        sort: "relevance",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--sort relevance requires --query; filter-only search is sorted by recent");
      return true;
    },
  );
});

test("message search command rejects UUID sender refs", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => {
      await messageSearchCommand.handler(ctx, {
        query: "review",
        sender: "11111111-2222-3333-4444-555555555555",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--sender expects a member handle like @alice, not a UUID");
      return true;
    },
  );
});

test("message search command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 403,
        data: null,
        error: "scope denied",
        errorCode: "SCOPE_DENIED",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageSearchCommand.handler(ctx, { query: "review" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "SCOPE_DENIED");
      assert.equal(err.message, "scope denied");
      return true;
    },
  );
});

test("message search command maps HTTP 5xx into SERVER_5XX", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        data: null,
        error: "search backend unavailable",
        errorCode: null,
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageSearchCommand.handler(ctx, { query: "review" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "SERVER_5XX");
      assert.equal(err.message, "search backend unavailable");
      return true;
    },
  );
});

test("message search command preserves QUERY_TOO_BROAD as a machine-readable rejection", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 422,
        data: null,
        error: "Search query is too broad. Add a channel, sender, or time filter, or use --sort recent.",
        errorCode: "QUERY_TOO_BROAD",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageSearchCommand.handler(ctx, { query: "the" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "QUERY_TOO_BROAD");
      assert.match(err.message, /--sort recent/);
      return true;
    },
  );
});

test("message search command preserves SEARCH_TIMEOUT after an admitted query reaches statement timeout", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        data: null,
        error: "Search timed out. Add a channel, sender, or time filter, use --sort recent, or retry.",
        errorCode: "SEARCH_TIMEOUT",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageSearchCommand.handler(ctx, { query: "underestimated" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "SEARCH_TIMEOUT");
      assert.match(err.message, /--sort recent/);
      return true;
    },
  );
});
