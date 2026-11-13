import { expect, test } from "@playwright/test";
import type { APIRequestContext, Browser, Page, Request } from "@playwright/test";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { assertApiOk } from "../fixtures/apiResponse";
import { loginViaApi, loginViaApiWithCredentials } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";

type Login = { accessToken: string; refreshToken: string };

// The seeded announcement is pre-dismissed only for the playwright owner.
// extraHuman has not dismissed, so without this call the modal pops up over
// /settings/server and intercepts every UI interaction. announcement-modal
// .spec.ts drives the contract end-to-end, but it lives in a separate spec
// file and Playwright shards by file — when settings-server lands in a
// different shard than announcement-modal (as it does on shard 3 of 4),
// nothing else dismisses the modal for extraHuman first. Doing it ourselves
// makes the test order- and shard-independent.
async function dismissAnnouncementForUser(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  login: Login,
) {
  await request.post(
    `${seedState.urls.api}/api/announcements/${seedState.announcement.id}/dismiss`,
    { headers: { Authorization: `Bearer ${login.accessToken}` } },
  );
}

async function openAsUser(
  browser: Browser,
  seedState: PlaywrightSeedState,
  login: Login,
  path: string,
  beforeGoto?: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();

  await page.addInitScript(
    (data) => {
      localStorage.setItem("slock_access_token", data.accessToken);
      localStorage.setItem("slock_refresh_token", data.refreshToken);
      localStorage.setItem("slock_last_server_slug", data.serverSlug);
    },
    { ...login, serverSlug: seedState.server.slug },
  );
  // Settings member tests do not exercise the account-level announcement
  // contract. Keep this local to the browser context so it cannot consume the
  // extraHuman dismissal that announcement-modal.spec intentionally owns.
  await page.route(/\/api\/announcements\/active(?:\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ announcements: [] }),
    });
  });
  await beforeGoto?.(page);
  await page.goto(path);
  const waitForRoomsJoined = () =>
    page
      .waitForFunction(
        () => (window as Window & { __slockRoomsJoined?: boolean }).__slockRoomsJoined === true,
        undefined,
        { timeout: 15_000 },
      )
      .then(() => {});
  return { context, page, waitForRoomsJoined };
}

// The two tests below revoke a member's access to the seeded server. Using the
// shared `seedState.extraHuman` for that meant the server briefly had no such
// member, and the restore only happened afterwards in `finally` — while other
// spec FILES run concurrently (`fullyParallel: false` only serialises within a
// file; CI runs 3 workers). Any concurrently running spec acting as extraHuman
// during that window would be rejected. Registering a throwaway member per run
// removes the shared window entirely; the pattern is the one PR #1629 used for
// `removed-dm-menu-actions.spec.ts`.
async function registerEphemeralMember(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  ownerAccessToken: string,
  label: string,
) {
  const name = `${label}-${Date.now().toString(36)}`;
  const email = `${name}@example.test`;
  const password = "password123";

  const registerResponse = await request.post(`${seedState.urls.api}/api/auth/register`, {
    data: {
      email,
      password,
      name,
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      // Opt into the playwright server's e2e email auto-verify (double-gated by
      // SLOCK_E2E_AUTO_VERIFY_EMAIL) so this member can perform business writes.
      __e2eAutoVerify: true,
    },
  });
  await assertApiOk(registerResponse, "POST /api/auth/register (ephemeral member)");
  const registered = await registerResponse.json() as {
    user: { id: string };
    accessToken: string;
    refreshToken: string;
  };

  // Identity setup is mandatory for every new account before business writes;
  // complete it rather than bypassing the production gate.
  const completeProfileResponse = await request.post(`${seedState.urls.api}/api/auth/me/complete-profile`, {
    headers: { Authorization: `Bearer ${registered.accessToken}` },
    data: { name, displayName: name },
  });
  await assertApiOk(completeProfileResponse, "POST /api/auth/me/complete-profile (ephemeral member)");

  // Join the way a real member does: the owner mints a single-use join link
  // and the new account accepts it.
  const joinLinkResponse = await request.post(`${seedState.urls.api}/api/servers/${seedState.server.id}/join-links`, {
    headers: {
      Authorization: `Bearer ${ownerAccessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { maxUses: 1 },
  });
  await assertApiOk(joinLinkResponse, "POST /api/servers/:id/join-links (ephemeral member)");
  const { token: joinToken } = await joinLinkResponse.json() as { token: string };
  const acceptResponse = await request.post(`${seedState.urls.api}/api/auth/accept-invite`, {
    headers: { Authorization: `Bearer ${registered.accessToken}` },
    data: { token: joinToken },
  });
  await assertApiOk(acceptResponse, "POST /api/auth/accept-invite (ephemeral member)");

  return {
    userId: registered.user.id,
    login: { accessToken: registered.accessToken, refreshToken: registered.refreshToken },
  };
}

test.describe.serial("Settings › Server tab", () => {
  test("owner: profile name Save button gates on dirty state", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);

    try {
      await page.goto(`/s/${seedState.server.slug}/settings/server`);

      const input = page.getByTestId("server-profile-name-input");
      const save = page.getByTestId("server-profile-save-button");

      await expect(input).toHaveValue(seedState.server.name);
      await expect(save).toBeDisabled();
      await expect(save).toHaveAttribute("data-save-state", "pristine");

      await input.fill(`${seedState.server.name} renamed`);
      await expect(save).toBeEnabled();
      await expect(save).toHaveAttribute("data-save-state", "dirty");

      await input.fill(seedState.server.name);
      await expect(save).toBeDisabled();

      await input.fill("   ");
      await expect(save).toBeDisabled();

      const newName = `${seedState.server.name} e2e`;
      await input.fill(newName);
      await expect(save).toBeEnabled();

      // Disabled is not a completion signal: the button is also disabled while
      // the PATCH is in flight. Arm the response observer before clicking, then
      // require both the write response and the UI's post-write saved state.
      const profileUpdateResponsePromise = page.waitForResponse((response) =>
        response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/servers/${seedState.server.id}`,
      );
      await save.click();
      const profileUpdateResponse = await profileUpdateResponsePromise;
      expect(profileUpdateResponse.ok()).toBe(true);
      await expect(save).toHaveAttribute("data-save-state", "saved");
      await expect(save).toBeDisabled();

      // Confirm persisted via an independent API read.
      const res = await request.get(`${seedState.urls.api}/api/servers/${seedState.server.id}`, {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
      });
      await assertApiOk(res, `GET /api/servers/${seedState.server.id}`);
      const body = await res.json();
      expect(body.name).toBe(newName);
    } finally {
      // A failed assertion must not leak the renamed server into Playwright's
      // retry or into another spec sharing the seeded server.
      const restoreResponse = await request.patch(`${seedState.urls.api}/api/servers/${seedState.server.id}`, {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { name: seedState.server.name },
      });
      await assertApiOk(restoreResponse, `PATCH /api/servers/${seedState.server.id} (restore profile name)`);
    }
  });

  test("member: profile is read-only (no input, no Save button)", async ({ browser, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApiWithCredentials(request, seedState, {
      email: seedState.extraHuman.email,
      password: seedState.extraHuman.password,
    });

    const { context, page } = await openAsUser(
      browser,
      seedState,
      login,
      `/s/${seedState.server.slug}/settings/server`,
    );

    try {
      await expect(page.getByTestId("server-profile-name-readonly")).toHaveText(seedState.server.name);
      await expect(page.getByTestId("server-profile-name-input")).toHaveCount(0);
      await expect(page.getByTestId("server-profile-save-button")).toHaveCount(0);
      await expect(page.getByTestId("server-danger-delete-button")).toHaveCount(0);
      await expect(page.getByTestId("server-danger-leave-button")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("member: Connected Apps is visible and read-only", async ({ browser, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    const memberLogin = await loginViaApiWithCredentials(request, seedState, {
      email: seedState.extraHuman.email,
      password: seedState.extraHuman.password,
    });
    const appName = `Member-visible app ${Date.now().toString(36)}`;
    const createRes = await request.post(`${seedState.urls.api}/api/integrations/clients`, {
      headers: {
        Authorization: `Bearer ${ownerLogin.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        name: appName,
        description: "Visible to every active server member.",
        homepageUrl: "https://member-visible.example.test",
        returnUrl: "https://member-visible.example.test/callback",
      },
    });
    await assertApiOk(createRes, "POST /api/integrations/clients");
    const created = await createRes.json() as { client: { id: string } };

    try {
      const { context, page } = await openAsUser(
        browser,
        seedState,
        memberLogin,
        // The old Settings link opens the Apps page (#proj-apps task #22).
        `/s/${seedState.server.slug}/settings/applications`,
      );
      try {
        await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/apps$`));
        await expect(page.getByTestId("connected-apps-v3-section")).toBeVisible();
        await expect(page.getByText("Only server owners and admins can install, edit, or remove apps.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Add app" })).toHaveCount(0);

        await page.getByTestId("connected-apps-tab-installed").click();
        const installedTab = page.getByTestId("connected-apps-installed-tab");
        // Apps v4 D3: a Raft App this server builds and has not installed is under Developer only.
        await expect(installedTab.getByText(appName)).toHaveCount(0);
        await expect(installedTab.getByRole("button", { name: "Edit" })).toHaveCount(0);
        await expect(installedTab.getByRole("button", { name: "Uninstall" })).toHaveCount(0);

        await page.getByTestId("connected-apps-tab-my-apps").click();
        const myAppsTab = page.getByTestId("connected-apps-my-apps-tab");
        const myAppsCollection = myAppsTab.getByTestId("connected-apps-my-apps-collection");
        await expect(myAppsTab.getByText(appName)).toBeVisible();
        // Grid by default (yezizp, #11723): cards show no description; the list shows it.
        await expect(myAppsCollection).toHaveAttribute("data-view", "grid");
        await expect(myAppsTab.getByText("Visible to every active server member.")).toHaveCount(0);
        await page
          .getByTestId("connected-apps-view-toggle")
          .getByRole("radio", { name: "List view" })
          .click();
        await expect(myAppsCollection).toHaveAttribute("data-view", "list");
        await expect(myAppsCollection.getByText("Visible to every active server member.")).toBeVisible();
        await expect(myAppsTab.getByRole("button", { name: "Edit" })).toHaveCount(0);
        await expect(myAppsTab.getByRole("button", { name: "Request offline review" })).toHaveCount(0);
        await expect(myAppsTab.getByRole("button", { name: "Delete" })).toHaveCount(0);
      } finally {
        await context.close();
      }
    } finally {
      const deleteRes = await request.delete(`${seedState.urls.api}/api/integrations/clients/${created.client.id}`, {
        headers: {
          Authorization: `Bearer ${ownerLogin.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
      });
      await assertApiOk(deleteRes, `DELETE /api/integrations/clients/${created.client.id}`);
    }
  });

  test("owner: the Apps toolbar's search, filter buttons and view switch share one row", async ({ page }) => {
    const seedState = await waitForSeedState();

    await page.goto(`/s/${seedState.server.slug}/apps`);
    await expect(page.getByTestId("connected-apps-v3-section")).toBeVisible();

    // Raft DS › Tabs › A tab's own controls: search, then the filter buttons,
    // in one row under the tabs on a desktop, centred on one line.
    const search = page.getByRole("searchbox", { name: "Search connected apps" });
    const category = page.getByRole("combobox", { name: "All categories" });
    const searchBox = await search.boundingBox();
    const categoryBox = await category.boundingBox();
    expect(searchBox).not.toBeNull();
    expect(categoryBox).not.toBeNull();
    const searchMid = searchBox!.y + searchBox!.height / 2;
    const categoryMid = categoryBox!.y + categoryBox!.height / 2;
    expect(Math.abs(searchMid - categoryMid)).toBeLessThanOrEqual(1);
    // The grid/list switch is back at the row's right end (yezizp, #11723).
    const toggle = page.getByTestId("connected-apps-view-toggle");
    await expect(toggle).toBeVisible();
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(Math.abs(toggleBox!.y + toggleBox!.height / 2 - searchMid)).toBeLessThanOrEqual(1);
    expect(toggleBox!.x).toBeGreaterThan(categoryBox!.x + categoryBox!.width);
  });

  test("owner: delete dialog gates submit on exact slug match", async ({ page, request }) => {
    const seedState = await waitForSeedState();

    // Create a throwaway server so we can actually delete without breaking the seed.
    const login = await loginViaApi(request, seedState);
    const throwawaySlug = `e2e-del-${Date.now().toString(36)}`;
    const createRes = await request.post(`${seedState.urls.api}/api/servers`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
      data: { name: "E2E Delete Me", slug: throwawaySlug },
    });
    await assertApiOk(createRes, "POST /api/servers (create)");
    const created = await createRes.json();
    const throwawayId: string = created.id;

    // A new server is subject to the mandatory setup gate. Establish the real
    // terminal state instead of patching legacy dismissal/opt-out preferences,
    // which intentionally cannot bypass setup anymore.
    const agentRes = await request.post(`${seedState.urls.api}/api/agents`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": throwawayId,
      },
      data: { name: `delete-fixture-${Date.now().toString(36)}`, runtime: "codex" },
    });
    await assertApiOk(agentRes, "POST /api/agents");

    const handoffRes = await request.post(
      `${seedState.urls.api}/api/servers/${throwawayId}/setup-handoff`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": throwawayId,
        },
      },
    );
    await assertApiOk(handoffRes, `POST /api/servers/${throwawayId}/setup-handoff`);
    await expect(handoffRes.json()).resolves.toMatchObject({
      surface: "complete",
      phase: "complete",
      blocksChat: false,
      postSetup: { surveyPending: false, handoffPending: false },
    });

    await page.goto(`/s/${throwawaySlug}/settings/server`);

    await page.getByTestId("server-danger-delete-button").click();

    const slugInput = page.getByTestId("server-delete-slug-input");
    const confirm = page.getByTestId("server-delete-confirm-button");
    await expect(slugInput).toBeVisible();
    await expect(confirm).toBeDisabled();

    await slugInput.fill("wrong-slug");
    await expect(confirm).toBeDisabled();

    await slugInput.fill(throwawaySlug);
    await expect(confirm).toBeEnabled();

    await confirm.click();

    await expect(page.getByRole("heading", { name: "Choose Server" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    // Confirm server is no longer listed for this user.
    const listRes = await request.get(`${seedState.urls.api}/api/servers`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    await assertApiOk(listRes, "GET /api/servers (list)");
    const list = await listRes.json();
    expect(list.find((s: { id: string }) => s.id === throwawayId)).toBeUndefined();
  });

  test("member: Leave Server redirects to server selector", async ({ browser, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    const { login } = await registerEphemeralMember(request, seedState, ownerLogin.accessToken, "leaving-member");
    await dismissAnnouncementForUser(request, seedState, login);

    const { context, page } = await openAsUser(
      browser,
      seedState,
      login,
      `/s/${seedState.server.slug}/settings/server`,
    );

    try {
      await page.getByTestId("server-danger-leave-button").click();
      const confirm = page.getByTestId("server-leave-confirm-button");
      await expect(confirm).toBeVisible();
      await confirm.click();

      await expect(page.getByRole("heading", { name: "Name the server where your agents will work." })).toBeVisible();
      await expect(page).toHaveURL(/\/$/);

      // Confirm membership actually removed server-side.
      const res = await request.get(`${seedState.urls.api}/api/servers`, {
        headers: { Authorization: `Bearer ${login.accessToken}` },
      });
      await assertApiOk(res, "GET /api/servers (membership check)");
      const servers = await res.json();
      expect(servers.find((s: { id: string }) => s.id === seedState.server.id)).toBeUndefined();
    } finally {
      await context.close();
      // No restore: the member was registered for this test alone, so leaving
      // mutates nothing another spec depends on.
    }
  });

  test("member: owner removes active member and member sees the first-server selector immediately", async ({
    browser,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    const { userId: memberUserId, login: memberLogin } = await registerEphemeralMember(
      request,
      seedState,
      ownerLogin.accessToken,
      "removed-member",
    );
    await dismissAnnouncementForUser(request, seedState, memberLogin);

    // Before the removal, the member's server list still contains the server.
    // Server-list reads the page starts between "joined" and the DELETE are
    // held and then answered with this list, as a read that raced the removal
    // would be. That removes the incidental rescue, where such a read happened
    // to return the post-removal list and showed the selector (task #674).
    const staleListRes = await request.get(`${seedState.urls.api}/api/servers`, {
      headers: { Authorization: `Bearer ${memberLogin.accessToken}` },
    });
    await assertApiOk(staleListRes, "GET /api/servers (pre-removal member list)");
    const staleServerList: unknown = await staleListRes.json();
    let serverListPhase: "live" | "held" | "removed" = "live";
    const liveServerListReads = new Set<Request>();
    let releaseHeldReads!: () => void;
    const removalCommitted = new Promise<void>((resolve) => {
      releaseHeldReads = resolve;
    });

    const { context, page, waitForRoomsJoined } = await openAsUser(
      browser,
      seedState,
      memberLogin,
      `/s/${seedState.server.slug}`,
      (target) =>
        target.route("**/api/servers", async (route) => {
          const req = route.request();
          if (req.method() !== "GET" || serverListPhase === "removed") return route.fallback();
          if (serverListPhase === "held") {
            await removalCommitted;
            return route.fulfill({ json: staleServerList });
          }
          liveServerListReads.add(req);
          try {
            const response = await route.fetch();
            await route.fulfill({ response });
          } finally {
            liveServerListReads.delete(req);
          }
        }),
    );

    try {
      await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}(/|$)`));
      // Removal revokes socket access before the route emits
      // server:membership-removed, so that event never reaches this page. The
      // redirect comes from the reconnect being rejected as "not a member".
      // Wait for the socket to be fully joined so the DELETE revokes a live
      // connection rather than racing the handshake.
      await waitForRoomsJoined();
      // From here new reads are held; reads already passing through can only
      // finish, so this settles.
      serverListPhase = "held";
      await expect.poll(() => liveServerListReads.size).toBe(0);

      const removeRes = await request.delete(
        `${seedState.urls.api}/api/servers/${seedState.server.id}/members/${memberUserId}`,
        {
          headers: {
            Authorization: `Bearer ${ownerLogin.accessToken}`,
            "X-Server-Id": seedState.server.id,
          },
        },
      );
      await assertApiOk(removeRes, `DELETE /api/servers/${seedState.server.id}/members/${memberUserId}`);
      serverListPhase = "removed";
      releaseHeldReads();

      await expect(page.getByRole("heading", { name: "Name the server where your agents will work." })).toBeVisible();
      await expect(page.getByText("Server not found")).toHaveCount(0);
    } finally {
      await context.close();
      // No restore: the member was registered for this test alone, so removing
      // it mutates nothing another spec depends on.
    }
  });
});
