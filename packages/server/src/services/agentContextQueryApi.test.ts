// #wg-ax:#15: an agent's context search, in Warden's order. Every check on
// whether the caller may see anything answers the same 404; the rate limit
// comes only after them; then the Computer's answer.

import assert from "node:assert/strict";
import { beforeEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { AgentContextQuery } from "@botiverse/raft-shared";
import { getAgent } from "./agentService";
import { findUsableAgentContextViewGrant } from "./agentContextViewGrantService";
import { evaluateFeatureFlag } from "./featureFlagService";
import * as messageService from "./messageService";
import type { AgentContextQueryResult } from "./agentContextViewRelay";
import { AgentContextQueryRateLimiter, agentContextNotViewableSentence, handleAgentContextQuery } from "./agentContextQueryApi";

vi.mock("./featureFlagService", () => ({ evaluateFeatureFlag: vi.fn() }));
vi.mock("./agentService", () => ({ getAgent: vi.fn() }));
vi.mock("./messageService", () => ({ resolveMessageIdVisibleToAgent: vi.fn() }));
vi.mock("./agentContextViewGrantService", () => ({ findUsableAgentContextViewGrant: vi.fn() }));

const flag = vi.mocked(evaluateFeatureFlag);
const agent = vi.mocked(getAgent);
const resolve = vi.mocked(messageService.resolveMessageIdVisibleToAgent);
const usableGrant = vi.mocked(findUsableAgentContextViewGrant);
const AGENTS: Record<string, unknown> = {
  "agent-1": { id: "agent-1", serverId: "server-1", runtime: "claude", machineId: "machine-1" },
  "agent-2": { id: "agent-2", serverId: "server-1", runtime: "claude", machineId: "machine-2", assistantOwnerUserId: null },
};
const byId = async (id: string) => (AGENTS[id] ?? null) as never;

const QUERY: AgentContextQuery = { kind: "search", query: "deploy", limit: 20, offset: 0 };
const ANSWER = { ok: true, runtime: "claude", model: null, entryCount: 3, answer: { kind: "search", total: 0, matches: [] } };

let openQuery: ReturnType<typeof vi.fn<(input: unknown) => Promise<AgentContextQueryResult>>>;

beforeEach(() => {
  flag.mockReset().mockResolvedValue({ key: "agent_context_view_v0", enabled: true, reason: "server_rule" } as never);
  resolve.mockReset().mockResolvedValue({ ok: true, message: { id: "message-1", senderType: "agent", senderId: "agent-1" } } as never);
  agent.mockReset().mockImplementation(byId);
  usableGrant.mockReset().mockResolvedValue(null);
  openQuery = vi.fn(async () => ({ kind: "answer", body: ANSWER }) as AgentContextQueryResult);
});

async function ask(limiter = new AgentContextQueryRateLimiter()) {
  const app = express();
  app.set("agentContextViewRelay", { openQuery });
  app.set("agentOrchestrator", {});
  app.post("/q", (req, res, next) => {
    handleAgentContextQuery(req, res, { agentId: "agent-1", serverId: "server-1", messageId: "message-1", query: QUERY, limiter }).catch(next);
  });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/q`, { method: "POST" });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
  } finally {
    server.close();
  }
}

function assertNotViewable(r: { status: number; body: Record<string, unknown> }) {
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "context_not_viewable");
  assert.equal(r.body.error, agentContextNotViewableSentence("message-1"));
}

test("the agent's own message: the daemon's answer, uncached, for the caller as viewer", async () => {
  const r = await ask();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, ANSWER);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const input = openQuery.mock.calls[0]?.[0] as Record<string, unknown>;
  assert.deepEqual([input.viewerAgentId, input.messageId, input.query], ["agent-1", "message-1", QUERY]);
});

test("every way of not being allowed is the same 404, and asks nothing of the Computer", async () => {
  const cases: Array<() => void> = [
    () => flag.mockResolvedValue({ key: "agent_context_view_v0", enabled: false, reason: "default" } as never),
    () => resolve.mockResolvedValue({ ok: false } as never),
    () => resolve.mockResolvedValue({ ok: true, message: { id: "message-1", senderType: "user", senderId: "agent-1" } } as never),
    () => resolve.mockResolvedValue({ ok: true, message: { id: "message-1", senderType: "agent", senderId: "agent-2" } } as never),
    () => agent.mockResolvedValue(null as never),
    () => agent.mockResolvedValue({ id: "agent-1", serverId: "server-2", runtime: "claude", machineId: "machine-1" } as never),
  ];
  const bodies = [];
  for (const arrange of cases) {
    arrange();
    const r = await ask();
    assertNotViewable(r);
    bodies.push(JSON.stringify(r.body));
    flag.mockResolvedValue({ key: "agent_context_view_v0", enabled: true, reason: "server_rule" } as never);
    resolve.mockResolvedValue({ ok: true, message: { id: "message-1", senderType: "agent", senderId: "agent-1" } } as never);
    agent.mockImplementation(byId);
  }
  assert.equal(new Set(bodies).size, 1, "nothing tells the causes apart");
  assert.equal(openQuery.mock.calls.length, 0);
});

test("another agent's message: only with a usable grant, which the relay records; its own needs none", async () => {
  resolve.mockResolvedValue({ ok: true, message: { id: "message-1", senderType: "agent", senderId: "agent-2" } } as never);
  assertNotViewable(await ask());
  assert.deepEqual(usableGrant.mock.calls[0]?.[0], { serverId: "server-1", viewerAgentId: "agent-1", target: AGENTS["agent-2"] });
  assert.equal(openQuery.mock.calls.length, 0);
  usableGrant.mockResolvedValue({ id: "grant-1", granterUserId: "user-1" } as never);
  assert.equal((await ask()).status, 200);
  const input = openQuery.mock.calls[0]?.[0] as Record<string, unknown>;
  assert.deepEqual([input.viewerAgentId, (input.agent as { id: string }).id, input.grant], ["agent-1", "agent-2", { id: "grant-1", granterUserId: "user-1" }]);
  resolve.mockResolvedValue({ ok: true, message: { id: "message-1", senderType: "agent", senderId: "agent-1" } } as never);
  usableGrant.mockClear();
  assert.equal((await ask()).status, 200);
  assert.equal(usableGrant.mock.calls.length, 0, "no grant looked up for its own context");
  assert.equal((openQuery.mock.calls[1]?.[0] as Record<string, unknown>).grant, null);
});

test("the rate limit counts only allowed calls, so a refusal never turns into a 429", async () => {
  const limiter = new AgentContextQueryRateLimiter(1, 60_000);
  resolve.mockResolvedValue({ ok: false } as never);
  for (let i = 0; i < 3; i++) assertNotViewable(await ask(limiter));
  resolve.mockResolvedValue({ ok: true, message: { id: "message-1", senderType: "agent", senderId: "agent-1" } } as never);
  assert.equal((await ask(limiter)).status, 200);
  const limited = await ask(limiter);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.doesNotMatch(String(limited.body.error), /a minute/, "each replica counts on its own, so the refusal promises no rate");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  resolve.mockResolvedValue({ ok: false } as never);
  assertNotViewable(await ask(limiter));
});

test("the relay's refusal is the same 404; its failures say what went wrong", async () => {
  openQuery.mockResolvedValueOnce({ kind: "refused" } as AgentContextQueryResult);
  assertNotViewable(await ask());
  openQuery.mockResolvedValueOnce({ kind: "failure", reason: "old_daemon" } as AgentContextQueryResult);
  const old = await ask();
  assert.deepEqual([old.status, old.body.code], [409, "context_old_daemon"]);
  assert.match(String(old.body.error), /1\.0\.66/);
  openQuery.mockResolvedValueOnce({ kind: "failure", reason: "too_large", tooLargeCause: "request" } as AgentContextQueryResult);
  const large = await ask();
  assert.deepEqual([large.status, large.body.code], [413, "context_too_large"]);
  assert.match(String(large.body.suggestedNextAction), /--limit/);
  openQuery.mockResolvedValueOnce({ kind: "failure", reason: "read_failed" } as AgentContextQueryResult);
  const failed = await ask();
  assert.deepEqual([failed.status, failed.body.code], [422, "context_read_failed"]);
});
