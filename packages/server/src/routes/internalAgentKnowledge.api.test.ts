import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { agentKnowledgeEvents, users } from "../db/schema.js";
import { sanitizeAgentKnowledgeContent } from "../services/agentKnowledgeService.js";
import { MANUAL_CONTEXT_CAPABILITY, RAFT_CLIENT_CAPABILITIES_HEADER } from "@botiverse/raft-shared";
import { createAgent } from "../services/agentService.js";
import { mintAgentCredential, type AgentCapability } from "../services/agentCredentialService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type Fixture = {
  agentId: string;
  serverId: string;
  apiKey: string;
  readOnlyApiKey: string;
};

const DEFAULT_INTENT = "Help the user accomplish their Raft workflow";
const DEFAULT_REASON = "Need the relevant Manual guidance at this point";
const VALID_KNOWLEDGE_CONTEXT = `&intent=${encodeURIComponent(DEFAULT_INTENT)}&reason=${encodeURIComponent(DEFAULT_REASON)}`;

function agentHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Raft-Client": "cli",
    [RAFT_CLIENT_CAPABILITIES_HEADER]: MANUAL_CONTEXT_CAPABILITY,
  };
}

function legacyAgentHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Raft-Client": "cli",
  };
}

async function mintAgentKey(agentId: string, scopes: readonly AgentCapability[]): Promise<string> {
  const minted = await mintAgentCredential({
    agentId,
    scopes,
    name: `knowledge-test-${scopes.join("-")}`,
    createdByUserId: null,
  });
  return minted.apiKey;
}

async function seedFixture(): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-knowledge-${suffix}@slock.test`,
    name: `agent-knowledge-${suffix}`,
    displayName: "Agent Knowledge Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer("Agent Knowledge Test", `agent-knowledge-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "AgentKnowledgeBot", { runtime: "claude", model: "sonnet" });

  return {
    agentId: agent.id,
    serverId: server.id,
    apiKey: await mintAgentKey(agent.id, ["knowledge"]),
    readOnlyApiKey: await mintAgentKey(agent.id, ["read"]),
  };
}

async function latestKnowledgeEvent() {
  const [event] = await getDb()
    .select()
    .from(agentKnowledgeEvents)
    .orderBy(desc(agentKnowledgeEvents.requestedAt))
    .limit(1);
  return event;
}

test("agent-api knowledge get returns a versioned doc and emits metadata-only event", async ({ app }) => {
    const fixture = await seedFixture();
    const intent = "Help the user understand their Raft workspace";
    const reason = "Need workspace home guidance";
    const res = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home&turn_id=turn-1&trace_id=trace-1&operation=search&resolution=language_gate&intent=${encodeURIComponent(intent)}&reason=${encodeURIComponent(reason)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );

    assert.equal(res.status, 200);
    const body = await res.json() as {
      ok?: boolean;
      docId?: string;
      docVersion?: string;
      docState?: string;
      content?: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.docId, "slock-home");
    assert.match(body.docVersion ?? "", /^sha256:[0-9a-f]{16}$/);
    assert.equal(body.docState, "published");
    assert.ok(body.content && body.content.length > 0);

    const event = await latestKnowledgeEvent();
    assert.ok(event);
    assert.equal(event.agentId, fixture.agentId);
    assert.equal(event.serverId, fixture.serverId);
    assert.equal(event.docId, "slock-home");
    assert.equal(event.topicOrPath, "slock-home");
    assert.equal(event.docVersion, body.docVersion);
    assert.equal(event.docState, "published");
    assert.equal(event.source, "cli");
    assert.equal(event.status, "success");
    assert.equal(event.operation, "get", "operation must be route-owned, not caller-selected");
    assert.equal(event.resolution, "exact_id", "resolution must be route-owned, not caller-selected");
    assert.equal(event.turnId, "turn-1");
    assert.equal(event.traceId, "trace-1");
    assert.equal(event.intent, intent);
    assert.equal(event.reason, reason);
    assert.equal(event.contextContractVersion, MANUAL_CONTEXT_CAPABILITY);
    assert.equal(event.responseBytes, Buffer.byteLength(body.content, "utf8"));
    assert.equal(JSON.stringify(event).includes(body.content.slice(0, 20)), false);
});

test("agent-api knowledge get emits actionable not_found guidance without doc version", async ({ app }) => {
    const fixture = await seedFixture();
    const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=missing-topic${VALID_KNOWLEDGE_CONTEXT}`, {
      headers: agentHeaders(fixture.apiKey),
    });

    assert.equal(res.status, 404);
    const body = await res.json() as {
      code?: string;
      error?: string;
      indexTopic?: string;
      suggestedTopicIds?: string[];
      suggested_next_action?: string;
    };
    assert.equal(body.code, "knowledge_not_found");
    assert.equal(body.indexTopic, "index");
    assert.match(body.error ?? "", /raft manual get index --intent/);
    assert.match(body.suggested_next_action ?? "", /--intent "Learn available Raft workflows"/);
    assert.match(body.suggested_next_action ?? "", /--reason "Browse the topic catalog after a missing topic"/);
    assert.doesNotMatch(body.suggested_next_action ?? "", /['$`;]/);
    assert.ok(Array.isArray(body.suggestedTopicIds));
    assert.ok(body.suggestedTopicIds.length > 0);
    assert.ok(body.suggestedTopicIds.length <= 5);
    assert.ok(body.suggestedTopicIds.includes("server"));
    for (const topicId of body.suggestedTopicIds) {
      assert.doesNotMatch(topicId, /\//);
      assert.doesNotMatch(topicId, /^docs-/);
    }

    const event = await latestKnowledgeEvent();
    assert.ok(event);
    assert.equal(event.agentId, fixture.agentId);
    assert.equal(event.topicOrPath, "missing-topic");
    assert.equal(event.status, "not_found");
    assert.equal(event.operation, "get");
    assert.equal(event.resolution, null);
    assert.equal(event.docId, null);
    assert.equal(event.docVersion, null);
    assert.equal(event.docState, null);
});

test("agent-api knowledge get resolves imported agent knowledge docs by doc id and path alias", async ({ app }) => {
    const fixture = await seedFixture();
    for (const topic of ["server", "agent-knowledge/server", "manual/agent-knowledge/server", "docs/agent-knowledge/server"]) {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=${encodeURIComponent(topic)}${VALID_KNOWLEDGE_CONTEXT}`, {
        headers: agentHeaders(fixture.apiKey),
      });

      assert.equal(res.status, 200);
      const body = await res.json() as {
        ok?: boolean;
        docId?: string;
        docVersion?: string;
        docState?: string;
        contentType?: string;
        content?: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.docId, "server");
      assert.match(body.docVersion ?? "", /^sha256:[0-9a-f]{16}$/);
      assert.equal(body.docState, "published");
      assert.equal(body.contentType, "text/markdown");
      assert.match(body.content ?? "", /doc_id: server/);
      assert.doesNotMatch(body.content ?? "", /Verified against/);
    }
});

test("agent-api knowledge get resolves evidence-driven extra aliases", async ({ app }) => {
    const fixture = await seedFixture();
    const cases = [
      ["list", "index"],
      ["topics", "index"],
      ["channels", "channel"],
      ["agents", "agent"],
      ["threads", "thread"],
      ["runtimes", "runtime"],
      ["role", "server-role"],
      ["daemon", "computer"],
      ["onboarding", "computer"],
      ["setup", "computer"],
      ["agent-browser", "agent-access-boundaries"],
      ["agent not replying", "agent-status"],
      ["agent permissions", "agent-access-boundaries"],
      ["pricing", "pricing-safe-answer"],
      ["slock-cli-overview", "raft-cli-overview"],
      ["legacy slock references", "rename-slock-to-raft"],
      // 2026-06-17 readout batch — recurring not_found aliases
      ["overview", "index"],
      ["tasks", "task"],
      ["action", "action-cards"],
      ["action-card", "action-cards"],
      ["agent-create", "agent"],
      ["agent-creation", "agent"],
      ["messages", "message"],
      ["messaging", "message"],
      ["runtime-profile", "runtime"],
      ["machine", "computer"],
      ["machines", "computer"],
      // 2026-06-19 readout batch-2 — obvious synonym variants of existing docs
      ["agent:create", "agent"],
      ["creating agents", "agent"],
      ["agent-runtime", "runtime"],
      ["action_prepare", "action-cards"],
      ["action-prepare", "action-cards"],
      ["action prepare", "action-cards"],
      // 2026-06-21 readout — recurring `computers` plural miss (no plural normalization)
      ["computers", "computer"],
      // 2026-06-23 new topics (gap review) — canonical topics + their aliases resolve
      ["external-agent", "external-agent"],
      ["external-agents", "external-agent"],
      ["hermes", "external-agent"],
      ["device-code-login", "external-agent"],
      ["joint-channel", "joint-channel"],
      ["joint-channels", "joint-channel"],
      ["integration", "integration"],
      ["connected-apps", "integration"],
      ["login-with-raft", "integration"],
      // 2026-06-23 fold-in (session / CLAUDE.md / delivery / thread) — new query-term aliases
      ["agent-session", "agent-status"],
      ["session", "agent-status"],
      ["channel-delivery", "mention"],
      ["thread-visibility", "thread"],
      ["claude-md", "runtime"],
      ["project-instructions", "runtime"],
      ["runtime-config", "runtime"],
    ] as const;

    for (const [topic, expectedDocId] of cases) {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=${encodeURIComponent(topic)}${VALID_KNOWLEDGE_CONTEXT}`, {
        headers: agentHeaders(fixture.apiKey),
      });

      assert.equal(res.status, 200);
      const body = await res.json() as {
        ok?: boolean;
        docId?: string;
        docState?: string;
        contentType?: string;
        content?: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.docId, expectedDocId);
      assert.equal(body.docState, "published");
      assert.equal(body.contentType, "text/markdown");
      assert.match(body.content ?? "", new RegExp(`doc_id: ${expectedDocId}`));
    }
});

test("agent-api knowledge get exposes raft CLI overview and separate rename guidance", async ({ app }) => {
    const fixture = await seedFixture();
    const cases = [
      {
        topic: "raft-cli-overview",
        docId: "raft-cli-overview",
        required: /Raft \(former Slock\) communication CLI/,
        forbidden: /## Product Rename - Slock to Raft/,
      },
      {
        topic: "rename-slock-to-raft",
        docId: "rename-slock-to-raft",
        required: /Executable commands must match the CLI that is actually available/,
        forbidden: /doc_id: raft-cli-overview/,
      },
    ] as const;

    for (const { topic, docId, required, forbidden } of cases) {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=${encodeURIComponent(topic)}${VALID_KNOWLEDGE_CONTEXT}`, {
        headers: agentHeaders(fixture.apiKey),
      });

      assert.equal(res.status, 200);
      const body = await res.json() as {
        ok?: boolean;
        docId?: string;
        content?: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.docId, docId);
      assert.match(body.content ?? "", required);
      assert.doesNotMatch(body.content ?? "", forbidden);
    }
});

test("agent-api knowledge get resolves legacy nested doc links after flat topic migration", async ({ app }) => {
    const fixture = await seedFixture();
    const cases = [
      { topic: "agent-knowledge/workspace/server", docId: "server" },
      { topic: "/agent-knowledge/participants/agent", docId: "agent" },
      { topic: "agent-knowledge/conversations/message#react-to-a-message", docId: "message" },
    ];

    for (const { topic, docId } of cases) {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=${encodeURIComponent(topic)}${VALID_KNOWLEDGE_CONTEXT}`, {
        headers: agentHeaders(fixture.apiKey),
      });

      assert.equal(res.status, 200);
      const body = await res.json() as { ok?: boolean; docId?: string };
      assert.equal(body.ok, true);
      assert.equal(body.docId, docId);
    }
});

test("agent-api knowledge get resolves registered recipe topics with slash slugs", async ({ app }) => {
    const fixture = await seedFixture();
    const cases = [
      { topic: "recipes/index", docId: "recipes/index", required: /Recipe index/ },
      { topic: "recipes/seeded", docId: "recipes/seeded", required: /Seeded recipes/ },
      { topic: "recipes/archetype/analyst", docId: "recipes/archetype/analyst", required: /doc_id:/ },
      { topic: "recipes/archetype/designer", docId: "recipes/archetype/designer", required: /doc_id:/ },
      { topic: "recipes/archetype/operator", docId: "recipes/archetype/operator", required: /doc_id:/ },
      { topic: "recipes/archetype/pa-coordinator", docId: "recipes/archetype/pa-coordinator", required: /doc_id:/ },
      { topic: "recipes/archetype/patrol", docId: "recipes/archetype/patrol", required: /message-id <anchor>/ },
      { topic: "recipes/archetype/verify-gate", docId: "recipes/archetype/verify-gate", required: /doc_id:/ },
      { topic: "recipes/archetype/writer", docId: "recipes/archetype/writer", required: /doc_id:/ },
      { topic: "recipes/decision/lane-design", docId: "recipes/decision/lane-design", required: /doc_id:/ },
      { topic: "recipes/decision/one-or-many", docId: "recipes/decision/one-or-many", required: /doc_id:/ },
      { topic: "recipes/decision/stake-strictness", docId: "recipes/decision/stake-strictness", required: /doc_id:/ },
      { topic: "recipes/decision/when-to-ask-human", docId: "recipes/decision/when-to-ask-human", required: /doc_id:/ },
      { topic: "recipes/pattern/coordinator-synthesis", docId: "recipes/pattern/coordinator-synthesis", required: /doc_id:/ },
      { topic: "recipes/pattern/discuss-then-assign", docId: "recipes/pattern/discuss-then-assign", required: /doc_id:/ },
      { topic: "recipes/pattern/evidence-handoff", docId: "recipes/pattern/evidence-handoff", required: /doc_id:/ },
      { topic: "recipes/pattern/gate-chain", docId: "recipes/pattern/gate-chain", required: /doc_id:/ },
      { topic: "recipes/pattern/interview-fanout", docId: "recipes/pattern/interview-fanout", required: /doc_id:/ },
      { topic: "recipes/pattern/recurring-recovery", docId: "recipes/pattern/recurring-recovery", required: /doc_id:/ },
      { topic: "recipes/pattern/shard-and-merge", docId: "recipes/pattern/shard-and-merge", required: /doc_id:/ },
      { topic: "recipes/pattern/video-review-loop", docId: "recipes/pattern/video-review-loop", required: /doc_id:/ },
      { topic: "recipes/playbook/billing-strictness", docId: "recipes/playbook/billing-strictness", required: /doc_id:/ },
      { topic: "recipes/playbook/content-pipeline", docId: "recipes/playbook/content-pipeline", required: /doc_id:/ },
      { topic: "recipes/technique/acceptance-surface", docId: "recipes/technique/acceptance-surface", required: /doc_id:/ },
      { topic: "recipes/technique/attachment-comments", docId: "recipes/technique/attachment-comments", required: /doc_id:/ },
      { topic: "recipes/technique/group-chat-debug", docId: "recipes/technique/group-chat-debug", required: /doc_id:/ },
      { topic: "recipes/technique/html-artifact-discussion", docId: "recipes/technique/html-artifact-discussion", required: /tier: seeded/ },
      { topic: "recipes/technique/login-with-raft", docId: "recipes/technique/login-with-raft", required: /doc_id:/ },
      { topic: "recipes/technique/memory-hygiene", docId: "recipes/technique/memory-hygiene", required: /doc_id:/ },
      { topic: "recipes/technique/preview-env", docId: "recipes/technique/preview-env", required: /preview URL is actually reachable/ },
      { topic: "recipes/technique/proof-of-work-receipts", docId: "recipes/technique/proof-of-work-receipts", required: /doc_id:/ },
      { topic: "recipes/technique/reminder-cron", docId: "recipes/technique/reminder-cron", required: /doc_id:/ },
      { topic: "recipes/technique/sent-zero", docId: "recipes/technique/sent-zero", required: /doc_id:/ },
      { topic: "recipes/technique/task-claim-lock", docId: "recipes/technique/task-claim-lock", required: /Create-instead-of-claim/ },
      { topic: "recipes/technique/video-review", docId: "recipes/technique/video-review", required: /tier: seeded/ },
      {
        topic: "manual/recipes/technique/sent-zero",
        docId: "recipes/technique/sent-zero",
        required: /stage external actions/,
      },
    ] as const;

    for (const { topic, docId, required } of cases) {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=${encodeURIComponent(topic)}${VALID_KNOWLEDGE_CONTEXT}`, {
        headers: agentHeaders(fixture.apiKey),
      });

      assert.equal(res.status, 200);
      const body = await res.json() as {
        ok?: boolean;
        docId?: string;
        contentType?: string;
        content?: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.docId, docId);
      assert.equal(body.contentType, "text/markdown");
      const escapedDocId = docId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(body.content ?? "", new RegExp(`doc_id: ${escapedDocId}`));
      assert.match(body.content ?? "", required);
    }
});

test("agent-api knowledge search returns scoped top-three recipe candidates and emits telemetry", async ({ app }) => {
    const fixture = await seedFixture();
    const intent = "Help the user safely preview a change before merge";
    const reason = "Need recipe candidates for preview review.";
    const res = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=${encodeURIComponent("preview before merge")}&scope=recipes&turn_id=turn-1&trace_id=trace-1&intent=${encodeURIComponent(intent)}&reason=${encodeURIComponent(reason)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );

    assert.equal(res.status, 200);
    const body = await res.json() as {
      ok?: boolean;
      query?: string;
      scope?: string | null;
      results?: Array<{ slug?: string; title?: string; firstScreen?: string }>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.query, "preview before merge");
    assert.equal(body.scope, "recipes");
    assert.ok(Array.isArray(body.results));
    assert.ok(body.results.length > 0);
    assert.ok(body.results.length <= 3);
    assert.equal(body.results[0]?.slug, "recipes/technique/preview-env");
    assert.match(body.results[0]?.title ?? "", /preview/i);
    assert.match(body.results[0]?.firstScreen ?? "", /Spin up a preview environment/);
    for (const result of body.results) {
      assert.match(result.slug ?? "", /^recipes\//);
      assert.ok((result.firstScreen ?? "").length > 0);
    }

    const event = await latestKnowledgeEvent();
    assert.ok(event);
    assert.equal(event.agentId, fixture.agentId);
    assert.equal(event.topicOrPath, "preview before merge");
    assert.equal(event.docId, "recipes/technique/preview-env");
    assert.equal(event.source, "cli");
    assert.equal(event.status, "success");
    assert.equal(event.operation, "search");
    assert.equal(event.resolution, "lexical");
    assert.equal(event.turnId, "turn-1");
    assert.equal(event.traceId, "trace-1");
    assert.equal(event.intent, intent);
    assert.equal(event.reason, reason);
    assert.ok((event.responseBytes ?? 0) > 0);
});

test("agent-api knowledge search handles blind-test phrasing without common-word ranking pollution", async ({ app }) => {
    const fixture = await seedFixture();
    const cases = [
      ["wake me up tomorrow morning", "recipes/technique/reminder-cron"],
      ["follow up next week when the PR lands", "recipes/technique/reminder-cron"],
      ["demo before merge", "recipes/technique/preview-env"],
      ["should I claim this before starting", "recipes/technique/task-claim-lock"],
      ["need approval before sending", "recipes/technique/sent-zero"],
    ] as const;

    for (const [query, expectedSlug] of cases) {
      const res = await fetch(
        `${app.baseUrl}/internal/agent-api/knowledge/search?query=${encodeURIComponent(query)}&scope=recipes${VALID_KNOWLEDGE_CONTEXT}`,
        { headers: agentHeaders(fixture.apiKey) },
      );
      assert.equal(res.status, 200, `${query} should hit`);
      const body = await res.json() as { results?: Array<{ slug?: string }> };
      assert.equal(body.results?.[0]?.slug, expectedSlug, `${query} should rank ${expectedSlug} first`);
    }
});

test("agent-api knowledge search miss returns clean not_found and emits metadata-only telemetry", async ({ app }) => {
    const fixture = await seedFixture();
    const res = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=${encodeURIComponent("qzxv jjjq zzzqq")}&scope=recipes${VALID_KNOWLEDGE_CONTEXT}`,
      { headers: agentHeaders(fixture.apiKey) },
    );

    assert.equal(res.status, 404);
    const body = await res.json() as { code?: string; error?: string; suggested_next_action?: string };
    assert.equal(body.code, "knowledge_not_found");
    assert.match(body.error ?? "", /no matching topics/);
    assert.match(body.suggested_next_action ?? "", /manual get index --intent/);
    assert.match(body.suggested_next_action ?? "", /--intent "Learn available Raft workflows"/);
    assert.match(body.suggested_next_action ?? "", /--reason "Browse the topic catalog after a missing topic"/);
    assert.doesNotMatch(body.suggested_next_action ?? "", /['$`;]/);

    const event = await latestKnowledgeEvent();
    assert.ok(event);
    assert.equal(event.agentId, fixture.agentId);
    assert.equal(event.topicOrPath, "qzxv jjjq zzzqq");
    assert.equal(event.status, "not_found");
    assert.equal(event.operation, "search");
    assert.equal(event.resolution, null);
    assert.equal(event.docId, null);
    assert.equal(event.docVersion, null);
    assert.equal(event.docState, null);
    assert.equal(JSON.stringify(event).includes("results"), false);
});

test("agent-api knowledge search answers a non-English query by asking for English", async ({ app }) => {
  // @cindyz, 2026-09-02: the Manual is English-only for now. A Chinese query
  // must not be silently translated, and must not come back as a generic
  // "try different keywords" miss — the caller cannot act on that, because the
  // problem is the language, not the wording.

    const fixture = await seedFixture();
    const res = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=${encodeURIComponent("频道权限")}${VALID_KNOWLEDGE_CONTEXT}`,
      { headers: agentHeaders(fixture.apiKey) },
    );

    assert.equal(res.status, 404);
    const body = await res.json() as { code?: string; error?: string; suggested_next_action?: string };
    assert.equal(body.code, "knowledge_language_unsupported");
    assert.match(body.error ?? "", /English/);
    assert.match(body.suggested_next_action ?? "", /English keywords/);
    assert.doesNotMatch(body.suggested_next_action ?? "", /['$`;]/);

    // Telemetry still records the miss, and still carries no query results.
    const event = await latestKnowledgeEvent();
    assert.ok(event);
    assert.equal(event.status, "not_found");
    assert.equal(event.topicOrPath, "频道权限");
    assert.equal(event.docId, null);
    assert.equal(event.operation, "search");
    assert.equal(event.resolution, "language_gate");
});

test("agent-api knowledge search applies a relevance floor instead of fabricating nearest neighbors", async ({ app }) => {
    const fixture = await seedFixture();
    const cases = [
      "how do I deploy to production",
      "linux kernel module signing guide",
      "ci cache failed on the release branch",
      "sales lead qualification script",
      "employee payroll tax withholding form",
      "onboard a new human employee",
      "database migration rollback checklist",
    ];

    for (const query of cases) {
      const res = await fetch(
        `${app.baseUrl}/internal/agent-api/knowledge/search?query=${encodeURIComponent(query)}&scope=recipes${VALID_KNOWLEDGE_CONTEXT}`,
        { headers: agentHeaders(fixture.apiKey) },
      );
      assert.equal(res.status, 404, `${query} should be a clean miss`);
      const body = await res.json() as { code?: string; error?: string };
      assert.equal(body.code, "knowledge_not_found");
      assert.match(body.error ?? "", /no matching topics/);
    }
});

test("agent-api knowledge search rejects unsupported scope and get stays exact-only", async ({ app }) => {
    const fixture = await seedFixture();
    const badScope = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=preview&scope=agents${VALID_KNOWLEDGE_CONTEXT}`,
      { headers: agentHeaders(fixture.apiKey) },
    );
    assert.equal(badScope.status, 400);
    assert.equal((await badScope.json() as { code?: string }).code, "knowledge_scope_invalid");

    const fuzzyGet = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge?topic=${encodeURIComponent("preview before merge")}${VALID_KNOWLEDGE_CONTEXT}`,
      { headers: agentHeaders(fixture.apiKey) },
    );
    assert.equal(fuzzyGet.status, 404);
    assert.equal((await fuzzyGet.json() as { code?: string }).code, "knowledge_not_found");
});

test("sanitizeAgentKnowledgeContent strips source-only comments outside fenced code blocks only", () => {
  const source = [
    "---",
    "doc_id: source-comments",
    "---",
    "{/* source-only verification metadata */}",
    "Visible before fence.",
    "```md",
    "{/* this stays as an example */}",
    "```",
    "{/* another source-only comment */}",
    "Visible after fence.",
    "",
  ].join("\n");

  const sanitized = sanitizeAgentKnowledgeContent(source);
  assert.doesNotMatch(sanitized, /source-only verification metadata/);
  assert.doesNotMatch(sanitized, /another source-only comment/);
  assert.match(sanitized, /\{\/\* this stays as an example \*\/\}/);
  assert.match(sanitized, /Visible before fence/);
  assert.match(sanitized, /Visible after fence/);
});

test("agent-api knowledge get accepts turn and trace ids from headers", async ({ app }) => {
    const fixture = await seedFixture();
    const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home${VALID_KNOWLEDGE_CONTEXT}`, {
      headers: {
        ...agentHeaders(fixture.apiKey),
        "X-Slock-Turn-Id": "turn-header",
        "X-Slock-Trace-Id": "trace-header",
      },
    });

    assert.equal(res.status, 200);
    const event = await latestKnowledgeEvent();
    assert.ok(event);
    assert.equal(event.turnId, "turn-header");
    assert.equal(event.traceId, "trace-header");
});

test("agent-api knowledge get rejects conflicting query and header correlation ids", async ({ app }) => {
    const fixture = await seedFixture();
    const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home&turn_id=query-turn${VALID_KNOWLEDGE_CONTEXT}`, {
      headers: {
        ...agentHeaders(fixture.apiKey),
        "X-Slock-Turn-Id": "header-turn",
      },
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string; error?: string };
    assert.equal(body.code, "knowledge_turn_id_invalid");
    assert.match(body.error ?? "", /disagree/);
});

test("agent-api knowledge get requires knowledge capability", async ({ app }) => {
    const fixture = await seedFixture();
    const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home${VALID_KNOWLEDGE_CONTEXT}`, {
      headers: agentHeaders(fixture.readOnlyApiKey),
    });

    assert.equal(res.status, 403);
    const body = await res.json() as { code?: string; requiredCapability?: string };
    assert.equal(body.code, "capability_not_authorized");
    assert.equal(body.requiredCapability, "knowledge");

    const events = await getDb().select().from(agentKnowledgeEvents).where(eq(agentKnowledgeEvents.agentId, fixture.agentId));
    assert.equal(events.length, 0);
});

test("agent-api knowledge get rejects raw payload rationale", async ({ app }) => {
    const fixture = await seedFixture();
    const rawReason = "[target=#secret msg=abcdef12] @human: raw quoted message";
    const res = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home&intent=${encodeURIComponent(DEFAULT_INTENT)}&reason=${encodeURIComponent(rawReason)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );

    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string; error?: string };
    assert.equal(body.code, "knowledge_reason_invalid");
    assert.match(body.error ?? "", /raw Slock message headers/);
});

test("agent-api knowledge get requires intent and reason independently", async ({ app }) => {
    const fixture = await seedFixture();
    const missingIntent = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home&reason=${encodeURIComponent(DEFAULT_REASON)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );
    assert.equal(missingIntent.status, 400);
    assert.equal((await missingIntent.json() as { code?: string }).code, "knowledge_intent_invalid");

    const missingReason = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home&intent=${encodeURIComponent(DEFAULT_INTENT)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );
    assert.equal(missingReason.status, 400);
    assert.equal((await missingReason.json() as { code?: string }).code, "knowledge_reason_invalid");
});

test("agent-api Manual search requires both fields for capability-bearing clients", async ({ app }) => {
    const fixture = await seedFixture();
    const missingIntent = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=preview&reason=${encodeURIComponent(DEFAULT_REASON)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );
    assert.equal(missingIntent.status, 400);
    assert.equal((await missingIntent.json() as { code?: string }).code, "knowledge_intent_invalid");

    const missingReason = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=preview&intent=${encodeURIComponent(DEFAULT_INTENT)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );
    assert.equal(missingReason.status, 400);
    assert.equal((await missingReason.json() as { code?: string }).code, "knowledge_reason_invalid");
});

test("agent-api Manual keeps published legacy clients compatible and records rollout eligibility", async ({ app }) => {
    const fixture = await seedFixture();
    const getRes = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home`,
      { headers: legacyAgentHeaders(fixture.apiKey) },
    );
    assert.equal(getRes.status, 200);

    const searchRes = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=preview&scope=recipes`,
      { headers: legacyAgentHeaders(fixture.apiKey) },
    );
    assert.equal(searchRes.status, 200);

    const missingGetRes = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge?topic=legacy-missing-topic`,
      { headers: legacyAgentHeaders(fixture.apiKey) },
    );
    assert.equal(missingGetRes.status, 404);
    const missingGetBody = await missingGetRes.json() as { suggested_next_action?: string };
    assert.match(missingGetBody.suggested_next_action ?? "", /raft manual get index/);
    assert.doesNotMatch(missingGetBody.suggested_next_action ?? "", /--intent|--reason/);

    const missingSearchRes = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=legacyzzzznomatch&scope=recipes`,
      { headers: legacyAgentHeaders(fixture.apiKey) },
    );
    assert.equal(missingSearchRes.status, 404);
    const missingSearchBody = await missingSearchRes.json() as { suggested_next_action?: string };
    assert.match(missingSearchBody.suggested_next_action ?? "", /raft manual get index/);
    assert.doesNotMatch(missingSearchBody.suggested_next_action ?? "", /--intent|--reason/);

    const events = await getDb()
      .select()
      .from(agentKnowledgeEvents)
      .where(eq(agentKnowledgeEvents.agentId, fixture.agentId));
    assert.equal(events.length, 4);
    for (const event of events) {
      assert.equal(event.intent, null);
      assert.equal(event.reason, null);
      assert.equal(event.contextContractVersion, null);
    }
});

test("agent-api knowledge search rejects raw payload intent", async ({ app }) => {
    const fixture = await seedFixture();
    const rawIntent = "[target=#secret msg=abcdef12] @human: raw quoted message";
    const res = await fetch(
      `${app.baseUrl}/internal/agent-api/knowledge/search?query=preview&intent=${encodeURIComponent(rawIntent)}&reason=${encodeURIComponent(DEFAULT_REASON)}`,
      { headers: agentHeaders(fixture.apiKey) },
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string; error?: string };
    assert.equal(body.code, "knowledge_intent_invalid");
    assert.match(body.error ?? "", /raw Slock message headers/);
});

test("agent-api knowledge get rejects non-CLI source", async ({ app }) => {
    const fixture = await seedFixture();
    const headers = agentHeaders(fixture.apiKey);
    delete headers["X-Raft-Client"];
    const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home${VALID_KNOWLEDGE_CONTEXT}`, { headers });

    assert.equal(res.status, 400);
    const body = await res.json() as { code?: string };
    assert.equal(body.code, "knowledge_source_invalid");
});

test("agent-api knowledge get still honors the legacy X-Slock-Client header", async ({ app }) => {
    const fixture = await seedFixture();
    const headers = agentHeaders(fixture.apiKey);
    delete headers["X-Raft-Client"];
    headers["X-Slock-Client"] = "cli";
    const res = await fetch(`${app.baseUrl}/internal/agent-api/knowledge?topic=slock-home${VALID_KNOWLEDGE_CONTEXT}`, { headers });

    assert.equal(res.status, 200);
});
