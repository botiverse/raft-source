import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import {
  formatKnowledgeSearchResults,
  knowledgeSearchCommand,
  registerKnowledgeSearchCommand,
} from "./search.js";

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

test("formatKnowledgeSearchResults renders slug title and first screen", () => {
  assert.equal(
    formatKnowledgeSearchResults([
      {
        slug: "recipes/technique/preview-env",
        title: "Spin up a preview environment",
        firstScreen: "# Spin up a preview environment\nUse this before merge.",
      },
    ]),
    "1. recipes/technique/preview-env — Spin up a preview environment\n"
      + "   # Spin up a preview environment\n"
      + "   Use this before merge.\n",
  );
});

test("manual search help documents recipes scope", () => {
  const program = new Command();
  const manual = program.command("manual");
  registerKnowledgeSearchCommand(manual);
  const search = manual.commands.find((candidate) => candidate.name() === "search");

  assert.ok(search);
  let help = "";
  search.configureOutput({ writeOut: (chunk) => { help += chunk; }, writeErr: (chunk) => { help += chunk; } });
  search.outputHelp();
  assert.match(help, /raft manual search "preview before merge" --scope recipes/);
  assert.match(help, /Currently supports: recipes/);
  assert.match(help, /--intent <text>/);
  assert.match(help, /--reason <text>/);
});

test("knowledge search command uses injected ApiClient and preserves top-3 result order", async () => {
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
            query: "preview before merge",
            scope: "recipes",
            results: [
              {
                slug: "recipes/technique/preview-env",
                title: "Spin up a preview environment",
                firstScreen: "# Spin up a preview environment",
              },
              {
                slug: "recipes/decision/stake-strictness",
                title: "Choose strictness for high-stakes work",
                firstScreen: "# Choose strictness",
              },
            ],
          },
        };
      },
    }) as any,
  });

  await knowledgeSearchCommand.handler(ctx, "preview before merge", {
    scope: "recipes",
    intent: "Safely preview the user's change before merge.",
    reason: "Looking up recipe candidates for an owner question.",
    turnId: "turn-1",
    traceId: "trace-1",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path:
        "/internal/agent-api/knowledge/search?query=preview+before+merge&scope=recipes&intent=Safely+preview+the+user%27s+change+before+merge.&reason=Looking+up+recipe+candidates+for+an+owner+question.&turn_id=turn-1&trace_id=trace-1",
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /1\. recipes\/technique\/preview-env/);
  assert.match(stdout.join(""), /2\. recipes\/decision\/stake-strictness/);
});

test("knowledge search command builds a fixed cross-shell-safe not-found fallback", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        error: "Manual search found no matching topics in recipes.",
        errorCode: "knowledge_not_found",
        data: null,
      }),
    }) as any,
  });

  await assert.rejects(
    async () => {
      await knowledgeSearchCommand.handler(ctx, "totally absent", {
        scope: "recipes",
        intent: "Safely preview the user's change before merge.",
        reason: "Need the recommended preview workflow now.",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "knowledge_not_found");
      assert.match(err.message, /no matching topics/);
      assert.match(err.suggestedNextAction ?? "", /--intent "Learn available Raft workflows"/);
      assert.match(err.suggestedNextAction ?? "", /--reason "Browse the topic catalog after a missing topic"/);
      assert.doesNotMatch(err.suggestedNextAction ?? "", /['$`;]/);
      return true;
    },
  );
});

test("knowledge search preserves the language-unsupported code instead of collapsing it", async () => {
  // @Koda's CHANGES on PR #7215: the server gained a distinct
  // `knowledge_language_unsupported` code so an agent can tell "ask in English"
  // apart from an ordinary miss. Without the CLI mapping it fell through to the
  // generic KNOWLEDGE_SEARCH_FAILED default, which defeats the point of adding a
  // machine-readable code at all — the human-readable text survived and hid it.
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        error: "The Manual is written in English and is not translated. Search in English.",
        errorCode: "knowledge_language_unsupported",
        data: null,
      }),
    }) as any,
  });

  await assert.rejects(
    async () => {
      await knowledgeSearchCommand.handler(ctx, "\u9891\u9053\u6743\u9650", {
        intent: "Safely preview the user's change before merge.",
        reason: "Need the recommended preview workflow now.",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "knowledge_language_unsupported");
      assert.notEqual(err.code, "KNOWLEDGE_SEARCH_FAILED");
      assert.match(err.message, /English/);
      return true;
    },
  );
});

test("knowledge search rejects missing reason before loading credentials or calling the API", async () => {
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
    async () => {
      await knowledgeSearchCommand.handler(ctx, "preview", {
        intent: "Safely preview the user's change before merge.",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "knowledge_reason_invalid");
      assert.match(err.suggestedNextAction ?? "", /--reason/);
      assert.match(err.suggestedNextAction ?? "", /muted channel still delivers @mentions/);
      return true;
    },
  );
  assert.equal(contextLoads, 0);
});

test("knowledge search reports both invalid context fields in one recovery", async () => {
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
    async () => {
      await knowledgeSearchCommand.handler(ctx, "preview", {
        intent: "short",
        reason: "short",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "KNOWLEDGE_CONTEXT_INVALID");
      assert.equal(
        err.message,
        "Both Manual context fields are invalid: intent must be at least 12 characters; reason must be at least 12 characters",
      );
      assert.match(err.suggestedNextAction ?? "", /--intent/);
      assert.match(err.suggestedNextAction ?? "", /--reason/);
      return true;
    },
  );
  assert.equal(contextLoads, 0);
});

test("formatKnowledgeSearchResults states typo corrections and concept expansions", () => {
  // Delivery-surface tooth. The service computing a match reason is not the
  // same as an agent seeing one: an earlier version of this feature was
  // asserted only at the service boundary while the route and this formatter
  // both dropped the fields, so the reasons reached nobody. Assert at the
  // surface the agent actually reads.
  const rendered = formatKnowledgeSearchResults([
    {
      slug: "channel",
      title: "Channels",
      firstScreen: "About channels.",
      matchedTerms: ["chanel"],
      correctedTerms: [{ term: "chanel", matched: "channel" }],
      expandedTerms: [],
    },
    {
      slug: "attachment",
      title: "Attachments",
      firstScreen: "About attachments.",
      matchedTerms: ["attachment"],
      correctedTerms: [],
      expandedTerms: [{ from: "附件", to: "attachment" }],
    },
  ]);
  assert.match(rendered, /matched: chanel → channel \(typo\)/);
  assert.match(rendered, /matched: 附件 → attachment \(concept\)/);
});

test("formatKnowledgeSearchResults stays quiet for plain matches and old servers", () => {
  // No reason line when there is nothing worth stating, and no crash when an
  // older server omits the fields entirely (they are optional by contract).
  const plain = formatKnowledgeSearchResults([
    {
      slug: "reminder",
      title: "Reminders",
      firstScreen: "About reminders.",
      matchedTerms: ["reminder"],
      correctedTerms: [],
      expandedTerms: [],
    },
  ]);
  assert.doesNotMatch(plain, /matched:/);

  const legacy = formatKnowledgeSearchResults([
    { slug: "reminder", title: "Reminders", firstScreen: "About reminders." },
  ]);
  assert.doesNotMatch(legacy, /matched:/);
  assert.match(legacy, /reminder — Reminders/);
});
