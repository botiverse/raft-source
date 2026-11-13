import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents } from "../db/schema";
import { createAgent } from "./agentService";
import { AgentOrchestrator, type AgentMessageDeliveryResult } from "./agentOrchestrator";
import { deliverOwnerFactsContext } from "./onboardingService";

const test = createApiTest();

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

test("owner facts context reaches the onboarding agent without a target-channel check", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `onboarding-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));

  const results: AgentMessageDeliveryResult[] = [];
  class RecordingOrchestrator extends AgentOrchestrator {
    override async deliverMessage(...args: Parameters<AgentOrchestrator["deliverMessage"]>) {
      const result = await super.deliverMessage(...args);
      results.push(result);
      return result;
    }
  }
  const orchestrator = new RecordingOrchestrator();

  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let channelReads = 0;
  pg.query = ((...args: unknown[]) => {
    if (typeof args[0] === "string" && /from "channels"/.test(args[0])) channelReads += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  let accepted: boolean;
  try {
    accepted = await deliverOwnerFactsContext(orchestrator, server.id, agent.id);
  } finally {
    pg.query = originalQuery;
    orchestrator.shutdown();
  }

  assert.equal(results.length, 1);
  // "onboarding-context" is not a channel: looking it up as one cast a non-uuid
  // (22P02) and dropped the delivery as target_access_changed on every start.
  assert.notEqual(results[0]!.status, "dropped", JSON.stringify(results[0]));
  assert.equal(accepted, true);
  assert.equal(channelReads, 0, "no channels lookup for a context that belongs to no channel");
});
