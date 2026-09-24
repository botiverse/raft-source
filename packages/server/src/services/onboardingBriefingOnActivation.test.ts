import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer, updateServerOnboardingAgent } from "./serverService.js";
import { createAgent } from "./agentService.js";
import { startOnboardingBriefingOnActivation } from "./onboardingBriefingOnActivation.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * The hole this closes, in the user's words: click "Let's Go" while the computer is asleep,
 * then turn the computer on the next morning.
 *
 * The briefing is a transient delivery, correctly not sent to an agent whose machine is dark.
 * The retry was wired to four HTTP routes, and a waking computer touches none of them.
 *
 * TWO EARLIER VERSIONS OF THIS FILE WERE GREEN AND WRONG. They fired on a fabricated
 * `agent:lifecycle` event — first demanding an inactive→active edge, then any transition into
 * active. Neither exists: switching a computer off does not set its agents inactive, so the
 * row reads `active` throughout and the server emits nothing about the agent at all. Both
 * tests passed because both hand-built the event they were testing.
 *
 * `machine:online` is what the system really emits, confirmed with a probe on a live daemon
 * reconnect BEFORE this was written.
 */

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "test-hash",
    emailVerified: true,
  }).returning();
  return user;
}

const machineOnline = (serverId: string) => ({ machineId: "machine-1", serverId });

test("a computer coming back briefs the onboarding agent — no HTTP route, no wake-up event", async ({ app }) => {

  const orchestrator = new EventEmitter() as unknown as AgentOrchestrator;
  try {
    const owner = await seedUser("brief-owner");
    const server = await createServer("Brief", `brief-${randomUUID()}`, owner.id);
    const cindy = await createAgent(server.id, "cindy", { runtime: "claude" });
    await updateServerOnboardingAgent(server.id, cindy.id);

    const trigger = vi.fn(async () => true);
    const stop = startOnboardingBriefingOnActivation({
      io: {} as never,
      orchestrator,
      trigger: trigger as never,
      deliverOwnerFacts: (async () => true) as never,
    });

    // The computer comes back. The daemon reconnects and the machine goes online. That is the
    // ONLY signal — no request, no click, and no agent event, because the agent never left.
    (orchestrator as unknown as EventEmitter).emit("machine:online", machineOnline(server.id));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(trigger.mock.calls.length, 1, "she is briefed when her computer comes back");
    const [, , serverIdArg, agentIdArg] = trigger.mock.calls[0] as unknown as [unknown, unknown, string, string];
    assert.equal(serverIdArg, server.id);
    assert.equal(agentIdArg, cindy.id, "the server's onboarding agent, read fresh from the row");

    stop();
  } finally {
    await app.close();
  }
});

test("a server with no onboarding agent is left alone", async ({ app }) => {

  const orchestrator = new EventEmitter() as unknown as AgentOrchestrator;
  try {
    const owner = await seedUser("brief-none");
    const server = await createServer("No Cindy", `nocindy-${randomUUID()}`, owner.id);

    const trigger = vi.fn(async () => true);
    const stop = startOnboardingBriefingOnActivation({
      io: {} as never,
      orchestrator,
      trigger: trigger as never,
      deliverOwnerFacts: (async () => true) as never,
    });

    // Machines reconnect all day on servers that finished onboarding long ago, or never began
    // it. Nothing is owed there, and this listener runs on every one of them.
    (orchestrator as unknown as EventEmitter).emit("machine:online", machineOnline(server.id));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(trigger.mock.calls.length, 0);

    stop();
  } finally {
    await app.close();
  }
});

test("a failing briefing does not take the reconnect down with it", async ({ app }) => {

  const orchestrator = new EventEmitter() as unknown as AgentOrchestrator;
  try {
    const owner = await seedUser("brief-throw");
    const server = await createServer("Throw", `throw-${randomUUID()}`, owner.id);
    const cindy = await createAgent(server.id, "cindy", { runtime: "claude" });
    await updateServerOnboardingAgent(server.id, cindy.id);

    const errors: string[] = [];
    const stop = startOnboardingBriefingOnActivation({
      io: {} as never,
      orchestrator,
      trigger: (async () => {
        throw new Error("cindy's runtime is on fire");
      }) as never,
      onError: (_error, serverId) => errors.push(serverId),
    });

    // This runs on every machine reconnect in the system. It must never be the reason somebody
    // else's computer fails to come back.
    (orchestrator as unknown as EventEmitter).emit("machine:online", machineOnline(server.id));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(errors, [server.id], "reported, not swallowed and not thrown");

    stop();
  } finally {
    await app.close();
  }
});

test("the owner facts go over on EVERY wake — even long after onboarding finished", async ({ app }) => {

  const orchestrator = new EventEmitter() as unknown as AgentOrchestrator;
  try {
    const owner = await seedUser("brief-facts");
    const server = await createServer("Facts", `facts-${randomUUID()}`, owner.id);
    const cindy = await createAgent(server.id, "cindy", { runtime: "claude" });
    await updateServerOnboardingAgent(server.id, cindy.id);

    const facts = vi.fn(async () => true);
    const stop = startOnboardingBriefingOnActivation({
      io: {} as never,
      orchestrator,
      // The opener says "already sent, nothing to do" — the state of every server that
      // finished onboarding weeks ago.
      trigger: (async () => false) as never,
      deliverOwnerFacts: facts as never,
    });

    // Two wakes, two deliveries. The opener is a MESSAGE (once); the owner facts are CONTEXT
    // (every session, or the session does not have them). Cindy told us as much herself: asked
    // what the survey said, a fully-onboarded Cindy answered "you never told me".
    const e = new EventEmitter() as unknown as { emit: (n: string, p: unknown) => void };
    (orchestrator as unknown as EventEmitter).emit("machine:online", machineOnline(server.id));
    await new Promise((resolve) => setImmediate(resolve));
    (orchestrator as unknown as EventEmitter).emit("machine:online", machineOnline(server.id));
    await new Promise((resolve) => setImmediate(resolve));
    void e;

    assert.equal(facts.mock.calls.length, 2, "context is re-established on every wake, not stamped once");

    stop();
  } finally {
    await app.close();
  }
});
