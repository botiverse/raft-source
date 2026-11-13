import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { formatSearchResults } from "./_format";
import { messageSearchCommand } from "./search";
import { buildRaftProgram } from "../../program";

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
  assert.match(output, /Search results for: "review" \(1 result \u00b7 truncated=false\)/);
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
  assert.match(output, /Filtered message results \(1 result \u00b7 truncated=false\)/);
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
        error: "Search query is too broad. Add a channel or sender filter, or use --sort recent (a time range works with recent).",
        errorCode: "QUERY_TOO_BROAD",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageSearchCommand.handler(ctx, { query: "the agent's" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "QUERY_TOO_BROAD");
      assert.match(err.message, /--sort recent/);
      // The next action retries the caller's own query, shell-quoted.
      assert.equal(
        err.suggestedNextAction,
        "Newest first (never rejected as too broad): raft message search --query 'the agent'\\''s' --sort recent\n"
          + "Or narrow to one channel you are in: raft message search --query 'the agent'\\''s' --target '#<channel>'",
      );
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
        error: "Search timed out. Add a channel or sender filter, use --sort recent (a time range works with recent), or retry.",
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

test("message search command says an incomplete recent search is not all the matches and prints the continue command", async () => {
  const { io, stdout } = memoryIo();
  const paths: string[] = [];
  const cursor = "eyJ0IjoiMjAyNi0xMC0wMVQwMDowMDowMC4xMjM0NTZaIiwiaSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCJ9";
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        paths.push(path);
        return {
          ok: true,
          status: 200,
          error: null,
          data: { results: [], hasMore: false, incomplete: true, nextCursor: cursor, searchedThrough: "2026-10-01T00:00:00.123Z", searchedMessages: 10_000 },
        };
      },
    }) as any,
  });

  await messageSearchCommand.handler(ctx, { query: "invoice", sort: "recent", after: "2026-09-16T00:00:00Z" });

  const output = stdout.join("");
  const lines = output.trimEnd().split("\n");
  assert.match(lines[0] ?? "", /^Search incomplete: no matches in the messages searched so far \(stopped after reading 10,000 messages, back to [^)]+\)\. Older messages were not searched, so this does NOT mean no message matches\. \(incomplete=true\)$/);
  assert.equal((output.match(/NOT/g) ?? []).length, 1, "one capitalised NOT");
  assert.match(lines[1] ?? "", new RegExp(`^Next \\(search older messages\\): raft message search --query 'invoice' --after '[^']+' --sort recent --cursor '${cursor}'$`));
  assert.equal(lines[2], "Or narrow the search: add --target '#<channel>' or --sender <handle>.");
  assert.equal(output.split(cursor).length - 1, 1, "the cursor is printed once, in the command");

  // The printed command continues from the cursor.
  await messageSearchCommand.handler(ctx, { query: "invoice", sort: "recent", cursor });
  assert.match(paths.at(-1) ?? "", new RegExp(`[?&]cursor=${cursor}(&|$)`));
});

test("message search command rejects --cursor outside a recent text search and with --offset", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext, createApiClient: () => ({}) as any });
  for (const opts of [
    { query: "invoice", cursor: "c" },
    { sender: "@alice", sort: "recent" as const, cursor: "c" },
    { query: "invoice", sort: "recent" as const, cursor: "c", offset: "20" },
  ]) {
    await assert.rejects(
      async () => { await messageSearchCommand.handler(ctx, opts); },
      (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG",
    );
  }
});

async function runSearchArgv(argv: string[], artifacts: { status: number; data?: unknown; errorCode?: string; hangUntilAborted?: boolean }, search: "ok" | "refused" | "throws" = "ok", env: NodeJS.ProcessEnv = {}) {
  const { io, stdout, stderr } = memoryIo();
  const requests: string[] = [];
  const signals: AbortSignal[] = [];
  const program = buildRaftProgram({
    io,
    env,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, _body?: unknown, options?: { signal?: AbortSignal }): Promise<ApiResponse<unknown>> => {
        requests.push(`${method} ${path}`);
        if (path.startsWith("/internal/agent-api/artifacts")) {
          if (options?.signal) signals.push(options.signal);
          if (artifacts.hangUntilAborted) {
            await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
            return { ok: false, status: 0, data: null, error: "aborted", errorCode: null };
          }
          const ok = artifacts.status < 400;
          return { ok, status: artifacts.status, data: ok ? artifacts.data : null, error: ok ? null : "refused", errorCode: artifacts.errorCode ?? null };
        }
        if (search === "throws") throw new Error("socket hang up");
        if (search === "refused") return { ok: false, status: 503, data: null, error: "search unavailable", errorCode: "SEARCH_UNAVAILABLE" };
        return { ok: true, status: 200, error: null, data: { results: [], hasMore: false } };
      },
    }) as any,
  });
  let error: unknown = null;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (caught) {
    error = caught;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), requests, signals, error };
}

const artifactHit = {
  artifacts: [{ id: "pt_abc", url: "https://app.raft.build/artifacts/pt_abc", name: "plan", title: "Plan", description: null, kind: "html", home: { kind: "server" }, currentVersion: 1, author: { type: "agent", name: "Remy" }, createdAt: "2026-10-22T14:02:00.000Z", updatedAt: "2026-10-22T14:02:00.000Z", matches: [] }],
  nextCursor: null,
  target: null,
};

test("argv: a text search ends with the Artifacts line when artifacts match; not when they don't, are off, or a filter can't apply", async () => {
  const hit = await runSearchArgv(["message", "search", "--query", "rollout plan", "--target", "#ops"], { status: 200, data: artifactHit });
  assert.deepEqual(hit.requests, [
    "GET /internal/agent-api/search?q=rollout+plan&channel=%23ops",
    "GET /internal/agent-api/artifacts?target=%23ops&query=rollout+plan&limit=1",
  ]);
  assert.equal(hit.stdout, `No search results. (truncated=false)\nArtifacts also match "rollout plan": raft artifact list --query 'rollout plan' --target "#ops"\n`);

  const none = await runSearchArgv(["message", "search", "--query", "rollout plan"], { status: 200, data: { ...artifactHit, artifacts: [] } });
  assert.equal(none.stdout, "No search results. (truncated=false)\n");
  const off = await runSearchArgv(["message", "search", "--query", "rollout plan"], { status: 403, errorCode: "ARTIFACTS_NOT_ENABLED" });
  assert.equal(off.stdout, "No search results. (truncated=false)\n");
  assert.equal(off.stderr, "");

  const bySender = await runSearchArgv(["message", "search", "--query", "rollout plan", "--sender", "@alice"], { status: 200, data: artifactHit });
  assert.deepEqual(bySender.requests, ["GET /internal/agent-api/search?q=rollout+plan&sender=alice"]);
  const byTime = await runSearchArgv(["message", "search", "--query", "rollout plan", "--before", "2026-10-01T00:00:00Z"], { status: 200, data: artifactHit });
  assert.ok(byTime.requests.every((r) => !r.includes("/artifacts")), byTime.requests.join(", "));
});

test("argv: when the daemon says Artifacts are off for this Server, no artifacts request is made; on, or not said, it asks", async () => {
  const offPerDaemon = await runSearchArgv(["message", "search", "--query", "rollout plan"], { status: 200, data: artifactHit }, "ok", { RAFT_ENABLED_APPS: "" });
  assert.deepEqual(offPerDaemon.requests, ["GET /internal/agent-api/search?q=rollout+plan"]);
  assert.equal(offPerDaemon.stdout, "No search results. (truncated=false)\n");
  const onPerDaemon = await runSearchArgv(["message", "search", "--query", "rollout plan"], { status: 200, data: artifactHit }, "ok", { RAFT_ENABLED_APPS: "artifacts" });
  assert.ok(onPerDaemon.requests.some((r) => r.startsWith("GET /internal/agent-api/artifacts")), onPerDaemon.requests.join(", "));
  const unsaid = await runSearchArgv(["message", "search", "--query", "rollout plan"], { status: 200, data: artifactHit });
  assert.ok(unsaid.requests.some((r) => r.startsWith("GET /internal/agent-api/artifacts")), "an older daemon or a self-hosted runner still asks");
});

test("argv: a probe still running after the search's grace is aborted, and the search prints without the line", async () => {
  const started = Date.now();
  const slow = await runSearchArgv(["message", "search", "--query", "rollout plan"], { status: 200, hangUntilAborted: true });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(slow.stdout, "No search results. (truncated=false)\n");
  assert.equal(slow.signals.length, 1);
  assert.equal(slow.signals[0]!.aborted, true);
});

test("argv: a search that is refused or throws ends the probe at once", async () => {
  for (const search of ["refused", "throws"] as const) {
    const started = Date.now();
    const run = await runSearchArgv(["message", "search", "--query", "rollout plan"], { status: 200, hangUntilAborted: true }, search);
    assert.ok(Date.now() - started < 2_000, search);
    assert.equal(run.signals.length, 1, search);
    assert.equal(run.signals[0]!.aborted, true, search);
    assert.equal(run.stdout, "", search);
  }
});
