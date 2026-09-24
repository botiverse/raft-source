import { test as base } from "@playwright/test";
import type { TestInfo } from "@playwright/test";
import { evidenceConfig, observeLogin } from "../../../../../scripts/e2e/transportEvidence.js";
import { waitForSeedState } from "./seedState";
import type { ScenarioSeedState } from "./seedState";

type Scenario = {
  seed: ScenarioSeedState;
  login: { accessToken: string; refreshToken: string };
  peer: { id: string; name: string; accessToken: string };
};

async function loginAccount(apiUrl: string, account: { email: string; password: string }, info: TestInfo) {
  return observeLogin(evidenceConfig(), {
    retry: info.retry, workerIndex: info.workerIndex, parallelIndex: info.parallelIndex,
  }, async (evidenceHeaders) => {
    const response = await fetch(`${apiUrl}/api/auth/login`, {
      signal: AbortSignal.timeout(10_000),
      method: "POST", headers: { "Content-Type": "application/json", ...evidenceHeaders },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    if (!response.ok) throw new Error(`Scenario login failed: HTTP ${response.status}`);
    return await response.json() as Scenario["login"];
  });
}

/** Large history is setup; browser search still reads it through the real API. */
export async function seedThreadWindow(seed: ScenarioSeedState): Promise<{
  parentId: string; threadChannelId: string; olderNeedle: string;
  newerReplyId: string; totalMessageRows: number;
}> {
  const shared = await waitForSeedState();
  const response = await fetch(`${seed.urls.api}/__playwright/scenarios/${seed.server.id}/thread-window`, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${shared.scenarioCapability}` },
  });
  if (!response.ok) throw new Error(`Thread scenario seed failed: HTTP ${response.status}`);
  return response.json();
}

/** Test-scoped, including retry/repeat: browser and API always use the same owner. */
export const test = base.extend<{ scenario: Scenario }>({
  scenario: async ({}, use, testInfo) => {
    const shared = await waitForSeedState();
    if (!shared.scenarioCapability) throw new Error("Restart the Playwright server: scenario support is missing");
    const url = `${shared.urls.api}/__playwright/scenarios`;
    const headers = { Authorization: `Bearer ${shared.scenarioCapability}` };
    // Node fetch keeps fixture passwords/capabilities out of Playwright traces.
    const created = await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(10_000) });
    if (!created.ok) throw new Error(`Scenario creation failed: HTTP ${created.status}`);
    const provisioned = await created.json() as Omit<ScenarioSeedState, "urls"> & {
      peer: { id: string; name: string; email: string; password: string };
    };
    const seed: ScenarioSeedState = { ...provisioned, urls: shared.urls };
    try {
      const login = await loginAccount(seed.urls.api, seed.user, testInfo);
      const peerLogin = await loginAccount(seed.urls.api, provisioned.peer, testInfo);
      await use({ seed, login, peer: {
        id: provisioned.peer.id, name: provisioned.peer.name, accessToken: peerLogin.accessToken,
      } });
    } finally {
      // Playwright tears down the dependent browser context before this fixture.
      // Even a failed assertion gets cleanup; a killed worker cannot reuse this
      // tenant on retry because the next POST always allocates a fresh one.
      const deleted = await fetch(`${url}/${seed.server.id}`, {
        method: "DELETE", headers, signal: AbortSignal.timeout(10_000),
      });
      await testInfo.attach("scenario-lifecycle", {
        contentType: "application/json",
        body: JSON.stringify({
          serverId: seed.server.id, channelId: seed.channel.id,
          worker: testInfo.workerIndex, retry: testInfo.retry,
          repeat: testInfo.repeatEachIndex, cleanupStatus: deleted.status,
        }),
      });
      if (!deleted.ok) throw new Error(`Scenario cleanup failed: HTTP ${deleted.status}`);
    }
  },
  storageState: async ({ scenario }, use) => {
    await use({ cookies: [], origins: [{
      origin: new URL(scenario.seed.urls.web).origin,
      localStorage: [
        { name: "slock_access_token", value: scenario.login.accessToken },
        { name: "slock_refresh_token", value: scenario.login.refreshToken },
        { name: "slock_last_server_slug", value: scenario.seed.server.slug },
      ],
    }] });
  },
});
