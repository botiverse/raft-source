import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

// The Agent panel's Apps tab against the real server: an app wakes the agent
// through the Agent Events API, then the owner revokes, denies, approves,
// grants on the agent's behalf, and pages through the app events.

type Created = { client: { id: string; clientId: string }; clientSecret: string };

/**
 * Switch the Agent panel to a tab and wait until it is the selected one. The
 * tabs are sortable, so a click that lands while the strip re-renders can
 * focus the tab without selecting it (the panel then keeps the old tab);
 * click again until the tab reports selected.
 */
async function openPanelTab(page: Page, id: "integrations" | "profile") {
  const tab = page.getByTestId(`panel-tab-${id}`);
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function createApp(request: APIRequestContext, api: string, token: string, serverId: string, key: string): Promise<Created> {
  const res = await request.post(`${api}/api/integrations/clients`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId },
    data: {
      name: key === "e2e-reminders" ? "Reminder App" : "Notes App",
      clientId: key,
      description: "E2E app",
      homepageUrl: "https://example.test",
      returnUrl: "https://example.test/callback",
      allowedScopes: ["agent:event:write", "agent:notification:write"],
    },
  });
  expect(res.status()).toBe(200);
  return await res.json() as Created;
}

async function requestAgent(request: APIRequestContext, api: string, app: Created, serverSlug: string, agentId: string) {
  const res = await request.post(`${api}/api/oauth/requests/agent`, {
    data: { clientId: app.client.clientId, clientSecret: app.clientSecret, serverSlug, agentId, scopes: ["agent:notification:write"] },
  });
  expect(res.status()).toBe(200);
  return await res.json() as { status: string; requestId: string };
}

// No retry: the test registers fixed client ids and revokes, denies and grants
// against the shared seed agent, so a second attempt starts from the first
// attempt's state and fails at createApp instead of re-testing anything. With
// retries off, a failure reports only the first attempt's real cause, and its
// trace is kept (the config records traces only on a retry).
test.describe.configure({ retries: 0 });
test.use({ trace: "retain-on-failure" });

test("apps tab: events, revoke, deny, approve, grant on the agent's behalf", async ({ page, request }) => {
  test.setTimeout(240_000);
  const seed = await waitForSeedState();
  const owner = await loginViaApi(request, seed);
  await dismissOwnerOnboarding(request, seed, owner.accessToken);
  const api = seed.urls.api;

  const reminders = await createApp(request, api, owner.accessToken, seed.server.id, "e2e-reminders");
  await createApp(request, api, owner.accessToken, seed.server.id, "e2e-notes");

  // The app is granted automatically (its creator is the owner) and sends 55 events.
  const granted = await requestAgent(request, api, reminders, seed.server.slug, seed.agent.id);
  expect(granted.status).toBe("approved");
  const tokenRes = await request.post(`${api}/api/oauth/token`, {
    data: {
      clientId: reminders.client.clientId,
      clientSecret: reminders.clientSecret,
      grantType: "urn:slock:grant-type:agent_request",
      requestId: granted.requestId,
      resource: `urn:raft:server:${seed.server.id}:agent-inbound`,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const accessToken = (await tokenRes.json() as { access_token: string }).access_token;
  for (let i = 1; i <= 55; i += 1) {
    const res = await request.post(`${api}/api/oauth/agent-events`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        agentId: seed.agent.id,
        kind: "notification",
        summary: `Stand-up reminder #${i}`,
        payload: { text: `Post the stand-up summary (${i})`, channel: "general" },
        externalEventId: `fire-${i}`,
      },
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
  }

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/s/${seed.server.slug}/agent/${seed.agent.id}`);
  await openPanelTab(page, "integrations");

  // Grant source and the newest events.
  await expect(page.getByText("Granted automatically to the app")).toBeVisible();
  const events = page.getByTestId("agent-app-events");
  await expect(events.getByText("Stand-up reminder #55")).toBeVisible();
  await expect(events.getByText("Stand-up reminder #5", { exact: true })).toHaveCount(0);
  await events.getByText("Stand-up reminder #55").click();
  await expect(events.locator("pre")).toContainText("Post the stand-up summary (55)");
  await page.screenshot({ path: "test-results/agent-apps-events.png", fullPage: true });

  // Paging: the next page brings the oldest events.
  await events.getByRole("button", { name: "Load more" }).click();
  await expect(events.getByText("Stand-up reminder #1", { exact: true })).toBeVisible();
  await expect(events.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // Revoke sticks: the app's next request waits for a person.
  // Revoking an App grant can't be undone (#12107), so it asks first.
  await page.getByRole("button", { name: "Revoke" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke app access" });
  await expect(confirm).toBeVisible();
  await page.getByTestId("agent-app-revoke-confirm").click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText("Granted automatically to the app")).toHaveCount(0);
  expect((await requestAgent(request, api, reminders, seed.server.slug, seed.agent.id)).status).toBe("pending");
  await openPanelTab(page, "profile");
  await openPanelTab(page, "integrations");
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByTestId("agent-app-pending")).toHaveCount(0);

  // Asked again; this time approve.
  expect((await requestAgent(request, api, reminders, seed.server.slug, seed.agent.id)).status).toBe("pending");
  await openPanelTab(page, "profile");
  await openPanelTab(page, "integrations");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Granted by a person")).toBeVisible();

  // Grant another app on the agent's behalf.
  await page.getByRole("button", { name: "Grant access" }).click();
  const form = page.getByTestId("agent-grant-access-form");
  await form.getByRole("button", { name: /Notes App/ }).click();
  await page.screenshot({ path: "test-results/agent-apps-grant.png", fullPage: true });
  await form.getByRole("button", { name: "Grant access" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText("Granted by a person")).toHaveCount(2);
  await page.screenshot({ path: "test-results/agent-apps-after-grant.png", fullPage: true });
});
