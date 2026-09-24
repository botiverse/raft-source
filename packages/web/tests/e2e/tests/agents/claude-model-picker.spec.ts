import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { getStaticRuntimeModelSourceSet } from "@botiverse/raft-shared";
import { loginViaApi } from "../../fixtures/auth";
import { withPageRoutes } from "../../fixtures/routeLifecycle";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

async function routeClaudeOnlyMachine(
  page: Page,
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  beforeRuntimeOptionsFulfill?: () => Promise<void>,
) {
  const claudeModelSource = getStaticRuntimeModelSourceSet("claude");
  if (!claudeModelSource) {
    throw new Error("Claude must remain a declared static model source");
  }

  await page.route(`**/api/servers/${seedState.server.id}/machines`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as {
      machines: Array<Record<string, unknown> & { id: string }>;
      latestDaemonVersion?: string | null;
    };
    await route.fulfill({
      response,
      json: {
        ...payload,
        machines: payload.machines.map((machine) => machine.id === seedState.machine.id
          ? {
              ...machine,
              status: "online",
              statusVersion: 1,
              runtimes: ["claude"],
              daemonVersion: "test-browser-e2e",
            }
          : machine),
      },
    });
  });
  await page.route(
    `**/api/servers/${seedState.server.id}/machines/${seedState.machine.id}/runtime-models/claude`,
    async (route) => {
      await route.fulfill({
        json: {
          kind: "live",
          value: claudeModelSource,
        },
      });
    },
  );
  await page.route(
    `**/api/servers/${seedState.server.id}/machines/${seedState.machine.id}/runtime-options`,
    async (route) => {
      const response = await route.fetch();
      const payload = await response.json() as {
        options: Array<Record<string, unknown> & { runtimeId: string }>;
      };
      await beforeRuntimeOptionsFulfill?.();
      await route.fulfill({
        response,
        json: {
          ...payload,
          options: payload.options.map((option) => option.runtimeId === "claude"
            ? {
                ...option,
                capabilityStatus: "installed",
                canSelectInThisContext: true,
              }
            : option),
        },
      });
    },
  );
}

test("keeps a Claude model selected before async runtime admission", async ({ page, request }, testInfo) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  let releaseRuntimeOptions: (() => void) | undefined;
  const runtimeOptionsHeld = new Promise<void>((resolve) => {
    releaseRuntimeOptions = resolve;
  });
  await withPageRoutes(page, async () => {
    await routeClaudeOnlyMachine(page, seedState, () => runtimeOptionsHeld);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/s/${seedState.server.slug}/machine/${seedState.machine.id}`);
    await expect(page.getByTestId("machine-mobile-back")).toBeAttached();
    await expect(page.getByText("Connected")).toBeVisible();

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: "Create Agent" })).toBeVisible();

    const trigger = page
      .getByRole("combobox")
      .filter({ hasText: /Claude Opus|Claude Sonnet|Claude Haiku|Claude Fable/ })
      .first();
    await trigger.click();
    await page.getByRole("option", { name: "Claude Fable", exact: true }).click();
    await expect(trigger).toHaveText("Claude Fable");

    const agentName = `ClaudeRaceW${testInfo.workerIndex}R${testInfo.retry}P${testInfo.repeatEachIndex}`;
    await page.locator("#create-agent-name").fill(agentName);

    const admissionResponse = page.waitForResponse((response) =>
      response.url().endsWith(
        `/api/servers/${seedState.server.id}/machines/${seedState.machine.id}/runtime-options`,
      ),
    );
    expect(releaseRuntimeOptions).toBeDefined();
    releaseRuntimeOptions?.();
    await admissionResponse;

    await expect(trigger).toHaveText("Claude Fable");
    const createButton = page.getByRole("button", { name: "Create Agent" });
    await expect(createButton).toBeEnabled();
    const [agentRequest, response] = await Promise.all([
      page.waitForRequest((req) =>
        req.url().endsWith("/api/agents") &&
        req.method() === "POST" &&
        (req.postDataJSON() as { name?: string } | null)?.name === agentName,
      ),
      page.waitForResponse((res) =>
        res.url().endsWith("/api/agents") &&
        res.request().method() === "POST" &&
        (res.request().postDataJSON() as { name?: string } | null)?.name === agentName,
      ),
      createButton.click(),
    ]);

    const submitted = agentRequest.postDataJSON() as {
      runtime: string;
      model: string;
      runtimeConfig: { model: { kind: string; id?: string; name?: string } };
    };
    expect(submitted.runtime).toBe("claude");
    expect(submitted.model).toBe("fable");
    expect(submitted.runtimeConfig.model).toEqual({ kind: "preset", id: "fable" });
    expect(response.ok()).toBe(true);
  }, releaseRuntimeOptions);
});
