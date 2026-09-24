// Regression for #7415: joint channels are addable again. Before that fix the
// shared predicate excluded joint, so the Add Member entry never rendered.
import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

test.describe("Joint channel member management", () => {
  test("joint channel shows a working Add Member entry", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const runId = Date.now().toString(36);
    const auth = (serverId?: string) => ({
      Authorization: `Bearer ${login.accessToken}`,
      ...(serverId ? { "X-Server-Id": serverId } : {}),
    });

    // Real peer server + joint channel + accepted invite (same shape as
    // joint-permalink-preview.spec.ts).
    const targetServerResponse = await request.post(`${seedState.urls.api}/api/servers`, {
      headers: auth(),
      data: { name: `ZZ Joint Target ${runId}`, slug: `zz-joint-target-${runId}` },
    });
    expect(targetServerResponse.ok(), await targetServerResponse.text()).toBeTruthy();
    const targetServer = await targetServerResponse.json() as { id: string; slug: string };

    const createJointResponse = await request.post(`${seedState.urls.api}/api/channels`, {
      headers: auth(seedState.server.id),
      data: {
        name: `zz-joint-add-${runId}`,
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [seedState.user.email],
      },
    });
    expect(createJointResponse.ok(), await createJointResponse.text()).toBeTruthy();
    const hostProjection = await createJointResponse.json() as {
      id: string; name: string; type?: string; jointInvite: { id: string };
    };
    const acceptResponse = await request.post(
      `${seedState.urls.api}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`,
      { headers: auth(targetServer.id) },
    );
    expect(acceptResponse.ok(), await acceptResponse.text()).toBeTruthy();

    // Guard against a vacuous pass: this must really be a joint channel.
    expect(hostProjection.type).toBe("joint");

    // Open the joint channel and use the real member-management entry.
    await page.goto(`/s/${seedState.server.slug}/channel/${hostProjection.id}`);
    await expect(page.getByPlaceholder(`Message #${hostProjection.name}`)).toBeVisible();

    await page.getByTitle("View participants").click();
    const addMember = page.getByRole("button", { name: "Add Member" });
    await expect(addMember, "joint channel must offer the Add Member entry").toBeVisible();

    await addMember.click();
    await page.getByPlaceholder("Name").fill(seedState.agent.name);
    await page.getByRole("button", { name: new RegExp(seedState.agent.name) }).click();
    await expect(page.locator('button[title="View participants"]')).toContainText("2");
  });
});
