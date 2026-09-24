import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { test } from "../../fixtures/scenario";
import { openSidebarRowMenu as openRowMenu } from "../../fixtures/readiness";
import type { ScenarioSeedState } from "../../fixtures/seedState";
import { waitForSeedState } from "../../fixtures/seedState";
import { seedAgentDmMessageToOwner } from "../../fixtures/agentMessage";

function authHeaders(accessToken: string, serverId: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": serverId,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type PinnedRef = { kind: "channel" | "agent" | "human"; id: string };

function includesPinnedRef(pinned: PinnedRef[], expected: PinnedRef): boolean {
  return pinned.some((ref) => ref.kind === expected.kind && ref.id === expected.id);
}

async function getSidebarOrder(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/servers/${seedState.server.id}/sidebar-order`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{
    pinned: PinnedRef[];
    pinnedChannelIds: string[];
    pinnedOrder: string[];
    hiddenDmIds: string[];
  }>;
}

async function markChannelRead(
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  channelId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/read-all`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  expect(response.ok()).toBeTruthy();
}

async function verifyConversationActions(
  page: Page,
  request: APIRequestContext,
  seedState: ScenarioSeedState,
  accessToken: string,
  channelId: string,
  expectedPinnedRef: PinnedRef,
) {
  await openRowMenu(page, channelId, "Mark as Unread");
  const [unreadResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/channels/${channelId}/unread`)
    ),
    page.getByRole("menuitem", { name: "Mark as Unread" }).click(),
  ]);
  expect(unreadResponse.ok()).toBeTruthy();
  expect((await unreadResponse.json() as { unreadCount: number }).unreadCount).toBe(1);

  await openRowMenu(page, channelId, "Pin");
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, accessToken);
    return includesPinnedRef(order.pinned, expectedPinnedRef);
  }).toBe(true);

  await openRowMenu(page, channelId, "Unpin");
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, accessToken);
    return includesPinnedRef(order.pinned, expectedPinnedRef);
  }).toBe(false);

  await openRowMenu(page, channelId, "Close Chat");
  await page.getByRole("menuitem", { name: "Close Chat" }).click();
  await expect.poll(async () => {
    const order = await getSidebarOrder(request, seedState, accessToken);
    return order.hiddenDmIds.includes(channelId);
  }).toBe(true);
}

test("removed human/agent DM context menu actions actually update state", async ({ page, request, scenario }) => {
  const { seed: seedState, login: ownerLogin } = scenario;
  const headers = authHeaders(ownerLogin.accessToken, seedState.server.id);
  const unique = Date.now();
  const agentName = `removed-menu-${unique}`;
  const removedHuman = scenario.peer;
  let humanDmId: string | null = null;
  let agentDmId: string | null = null;
  let humanRowName = removedHuman.name;

  const humanDmResponse = await request.post(`${seedState.urls.api}/api/channels/dm`, {
    headers,
    data: { userId: removedHuman.id },
  });
  expect(humanDmResponse.ok()).toBeTruthy();
  const humanDm = await humanDmResponse.json() as {
    id: string;
    peerDisplayName?: string | null;
    peerName?: string | null;
  };
  humanDmId = humanDm.id;
  humanRowName = humanDm.peerDisplayName || humanDm.peerName || removedHuman.name;
  // The removed human authors the message (not the owner): mark-unread targets
  // the latest non-self message, so the owner can only re-flag a DM that holds
  // a peer-authored message. The message survives the human's later removal.
  const humanSeedResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: authHeaders(removedHuman.accessToken, seedState.server.id),
    data: { channelId: humanDmId, content: `removed human DM action proof ${unique}` },
  });
  expect(
    humanSeedResponse.ok(),
    `removed-human seed post failed: ${humanSeedResponse.status()}`,
  ).toBeTruthy();
  await markChannelRead(request, seedState, ownerLogin.accessToken, humanDmId);

  const agentResponse = await request.post(`${seedState.urls.api}/api/agents`, {
    headers,
    data: { name: agentName, runtime: "codex" },
  });
  expect(agentResponse.ok()).toBeTruthy();
  const agent = await agentResponse.json() as { id: string; name: string };
  const agentDmResponse = await request.post(`${seedState.urls.api}/api/channels/dm`, {
    headers,
    data: { agentId: agent.id },
  });
  expect(agentDmResponse.ok()).toBeTruthy();
  agentDmId = ((await agentDmResponse.json()) as { id: string }).id;
  // The agent authors the message (not the owner), via a real sk_agent_* send,
  // so the owner↔agent DM holds a genuine non-self message for mark-unread.
  // The message survives the agent's later deletion.
  await seedAgentDmMessageToOwner(
    seedState,
    agent.id,
    ownerLogin.accessToken,
    `removed agent DM action proof ${unique}`,
  );
  await markChannelRead(request, seedState, ownerLogin.accessToken, agentDmId);

  await page.goto(`/s/${seedState.server.slug}`);
  await expect(page.getByRole("button", { name: new RegExp(escapeRegExp(humanRowName)) }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(escapeRegExp(agentName)) }).first()).toBeVisible();

  const removeHumanResponse = await request.delete(
    `${seedState.urls.api}/api/servers/${seedState.server.id}/members/${removedHuman.id}`,
    { headers },
  );
  expect(removeHumanResponse.ok()).toBeTruthy();
  const deleteAgentResponse = await request.delete(`${seedState.urls.api}/api/agents/${agent.id}`, { headers });
  expect(deleteAgentResponse.ok()).toBeTruthy();

  await verifyConversationActions(
    page,
    request,
    seedState,
    ownerLogin.accessToken,
    humanDmId,
    { kind: "human", id: removedHuman.id },
  );
  await verifyConversationActions(
    page,
    request,
    seedState,
    ownerLogin.accessToken,
    agentDmId,
    { kind: "agent", id: agent.id },
  );

});

test("scenario owners cannot mutate another attempt and cleanup cannot delete the shared seed", async ({ request, scenario }) => {
  const shared = await waitForSeedState();
  const endpoint = `${shared.urls.api}/__playwright/scenarios`;
  const headers = { Authorization: `Bearer ${shared.scenarioCapability}` };
  const denied = await fetch(endpoint, { method: "POST" });
  expect(denied.status).toBe(403);
  const sharedDelete = await fetch(`${endpoint}/${shared.server.id}`, { method: "DELETE", headers });
  expect(sharedDelete.status).toBe(404);
  const created = await fetch(endpoint, { method: "POST", headers });
  expect(created.status).toBe(200);
  const sibling = await created.json() as ScenarioSeedState & { peer: { email: string; password: string } };
  try {
    expect(sibling.server.id).not.toBe(scenario.seed.server.id);
    expect(sibling.user.email).not.toBe(scenario.seed.user.email);
    expect(scenario.seed.server.id).not.toBe(shared.server.id);
    const crossTenant = await request.patch(`${shared.urls.api}/api/servers/${sibling.server.id}/sidebar-order`, {
      headers: authHeaders(scenario.login.accessToken, sibling.server.id),
      data: { hiddenDmIds: [scenario.seed.channel.id] },
    });
    expect(crossTenant.status()).toBe(403);
  } finally {
    const deleted = await fetch(`${endpoint}/${sibling.server.id}`, { method: "DELETE", headers });
    expect(deleted.status).toBe(204);
  }
  const afterDelete = await request.get(`${shared.urls.api}/api/servers/${sibling.server.id}`, {
    headers: authHeaders(scenario.login.accessToken, sibling.server.id),
  });
  expect(afterDelete.ok()).toBe(false);
  for (const account of [sibling.user, sibling.peer]) {
    const loginAfterCleanup = await fetch(`${shared.urls.api}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    expect(loginAfterCleanup.status).toBe(401);
  }
  // Other tenants survive cleanup; no global reset/truncate is permitted.
  const own = await getSidebarOrder(request, scenario.seed, scenario.login.accessToken);
  expect(own.hiddenDmIds).toEqual([]);
});
