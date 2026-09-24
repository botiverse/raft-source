import type { ScenarioSeedState } from "./seedState";

// Seed a genuine agent-authored DM message in an owner↔agent DM, the way a real
// agent would send it: mint a short-lived `sk_agent_*` credential for the agent
// (POST /api/agents/:id/credentials), then POST /internal/agent-api/send AS the
// agent. The send goes through resolveWritableAgentTarget -> broadcastAndDeliver,
// so it produces the real sender/read-cursor + delivery side-effects (closer to
// production than a direct DB insert).
//
// Reusable seeding helper: any e2e scenario that needs a non-self (agent-authored)
// message in an owner↔agent DM can call this — e.g. so the owner can then
// Mark-as-Unread a real non-self message (mark-unread targets the latest non-self
// message; an owner cannot mark-unread their own sole message).
//
// SECURITY: the credential mint + send deliberately use raw Node `fetch`, NOT the
// Playwright `APIRequestContext` fixture, so the minted `sk_agent_*` (mint response
// body + send Authorization header) never flows through Playwright's request trace
// artifacts (`trace: "on-first-retry"`). The key stays in helper-local memory and
// failure messages are status-only.
//
// Requires the Playwright test server env to have device-login enabled (default-on)
// so credential minting works, and (to avoid the send being held) freshness off
// via SLOCK_ATTESTED_SEND_MODE=off.
export async function seedAgentDmMessageToOwner(
  seedState: ScenarioSeedState,
  agentId: string,
  ownerAccessToken: string,
  content: string,
): Promise<void> {
  await seedAgentMessages(seedState, agentId, ownerAccessToken, `dm:@${seedState.user.name}`, [
    content,
  ]);
}

// Seed one or more genuine agent-authored messages into any target the agent
// can write. Minting once per batch keeps mixed-authorship pagination scenarios
// cheap while still exercising the same authenticated send path as a real agent.
export async function seedAgentMessages(
  seedState: ScenarioSeedState,
  agentId: string,
  ownerAccessToken: string,
  target: string,
  contents: readonly string[],
): Promise<void> {
  const credentialResponse = await fetch(
    `${seedState.urls.api}/api/agents/${agentId}/credentials`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scopes: ["send", "read"], name: "e2e-agent-message-seed" }),
    },
  );
  if (!credentialResponse.ok) {
    throw new Error(`mint agent credential failed: ${credentialResponse.status}`);
  }
  const { apiKey } = (await credentialResponse.json()) as { apiKey: string };

  for (const content of contents) {
    const sendResponse = await fetch(`${seedState.urls.api}/internal/agent-api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ target, content }),
    });
    if (!sendResponse.ok) {
      // Status-only — never surface the raw response/header carrying the key.
      throw new Error(`agent-api send failed: ${sendResponse.status}`);
    }
  }
}
