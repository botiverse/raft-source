import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SERVER_LABS_UI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../src/api/client";
import SettingsPanel from "../src/components/settings/SettingsPanel";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { DISPLAY_LOCALE_STORAGE_KEY } from "../src/i18n/locale";
import { useAuthStore } from "../src/store/authStore";
import {
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  prefetchServerFeatureFlags,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
  useServerFeatureFlag,
} from "../src/store/serverFeatureFlags";
import { resetServerLabsSettingsForTests, useServerLabsSettingsSnapshot } from "../src/store/serverLabsSettingsStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import type { CanonicalServerLabSettingsReadback } from "../src/utils/serverLabsSettings";

const originalGet = api.get;
const originalPatch = api.patch;
const originalPost = api.post;
const originalPut = api.put;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.patch = originalPatch;
  api.post = originalPost;
  api.put = originalPut;
  resetServerFeatureFlagsForTests();
  resetServerLabsSettingsForTests();
  useAuthStore.setState({ user: null, loading: false, initialized: true } as never);
  useServerStore.setState({
    servers: [],
    current: null,
    members: [],
    membersLoadError: false,
    loading: false,
    usage: null,
    loadingUsage: false,
    billing: null,
    loadingBilling: false,
    serverEpoch: 0,
  } as never);
  try {
    window.localStorage.clear();
  } catch {
    // ignore storageless environments
  }
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createServer(id: string, name: string): Server {
  return {
    id,
    name,
    avatarUrl: null,
    slug: id,
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

function labReadback(serverId: string, version: number, enrolled: boolean): CanonicalServerLabSettingsReadback {
  return {
    serverId,
    accessEnabled: true,
    version,
    canManageAccess: true,
    canManageEnrollments: true,
    labs: [{
      labKey: "composer_lab",
      name: serverId === "server-a" ? "Composer A" : "Composer B",
      description: serverId === "server-a" ? "A server-provided description." : "B server-provided description.",
      state: "open",
      enrolled,
      effective: enrolled,
    }],
  };
}

function registeredLabReadback(
  serverId: string,
  version: number,
  masterEnabled: boolean,
  enrolled: boolean,
): CanonicalServerLabSettingsReadback {
  const effective = masterEnabled && enrolled;
  return {
    serverId,
    accessEnabled: masterEnabled,
    version,
    canManageAccess: true,
    canManageEnrollments: true,
    labs: [{
      labKey: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
      name: "Attachment comments",
      description: "Comment on attachments.",
      state: "open",
      enrolled,
      effective,
    }],
  };
}

function seedSession(current: Server) {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      gravatarHash: "",
      name: "Owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    servers: [current],
    current,
    members: [],
    loading: false,
    serverEpoch: 1,
  } as never);
}

function switchCurrentServer(server: Server) {
  useServerStore.setState((state) => ({
    servers: [server],
    current: server,
    members: [],
    usage: null,
    billing: null,
    serverEpoch: state.serverEpoch + 1,
  }));
}

function renderSettingsPanel(locale: "en" | "zh-cn" = "en") {
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, locale);
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <SettingsPanel tab="labs" />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

function LabsReadbackProbe() {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const serverEpoch = useServerStore((state) => state.serverEpoch);
  const snapshot = useServerLabsSettingsSnapshot(serverId, serverEpoch);
  const lab = snapshot.readback?.labs.find((candidate) => candidate.key === ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY);
  return (
    <div data-testid="labs-readback-probe">
      {snapshot.readback
        ? `v${snapshot.readback.serverLabVersion}:master:${snapshot.readback.masterEnabled ? "on" : "off"}:comments:${lab?.effective ? "on" : "off"}`
        : "empty"}
    </div>
  );
}

function RegisteredLabFlagProbe() {
  return <div data-testid="registered-lab-flag-probe">{useServerFeatureFlag(ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY).enabled ? "flag:on" : "flag:off"}</div>;
}

function renderSettingsPanelWithProbes() {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <SettingsPanel tab="labs" />
          <LabsReadbackProbe />
          <RegisteredLabFlagProbe />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

function renderSettingsPanelWithReadbackProbe(locale: "en" | "zh-cn" = "en") {
  window.localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, locale);
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <SettingsPanel tab="labs" />
          <LabsReadbackProbe />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

function renderServerProfilePanel() {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter>
          <SettingsPanel tab="server" />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

function installFlagMock() {
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/feature-flags/evaluate");
    const request = body as { keys: string[] };
    return {
      data: {
        evaluations: request.keys.map((key) => ({
          key,
          enabled: key === SERVER_LABS_UI_FEATURE_FLAG_KEY,
        })),
      },
    };
  }) as typeof api.post;
}

test("server Labs ignores stale mutation completion after switching servers and preserves B authority for the next write", async () => {
  const serverA = createServer("server-a", "Server A");
  const serverB = createServer("server-b", "Server B");
  seedSession(serverA);
  installFlagMock();

  const aGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
  const bGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
  const aPatch = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
  const putCalls: Array<{ url: string; body: { enabled: boolean; expectedVersion: number } }> = [];
  let patchCalls = 0;

  api.get = ((url: string) => {
    if (url === "/servers/server-a/labs") return aGet.promise;
    if (url === "/servers/server-b/labs") return bGet.promise;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.patch = ((url: string, body?: unknown) => {
    patchCalls += 1;
    assert.equal(url, "/servers/server-a/labs/access");
    assert.deepEqual(body, { enabled: false, expectedVersion: 10 });
    return aPatch.promise;
  }) as typeof api.patch;
  api.put = (async (url: string, body?: unknown) => {
    putCalls.push({ url, body: body as { enabled: boolean; expectedVersion: number } });
    return { data: labReadback("server-b", 21, true) };
  }) as typeof api.put;

  renderSettingsPanelWithReadbackProbe();

  await act(async () => {
    aGet.resolve({ data: labReadback("server-a", 10, true) });
    await aGet.promise;
  });
  assert.equal((await screen.findByTestId("labs-readback-probe")).textContent, "v10:master:on:comments:off");

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Server Labs access" }));
  });
  assert.equal(patchCalls, 1, "server A master toggle should start the stale mutation");

  await act(async () => {
    switchCurrentServer(serverB);
  });

  await act(async () => {
    bGet.resolve({ data: labReadback("server-b", 20, false) });
    await bGet.promise;
  });
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v20:master:on:comments:off");
  assert.ok(screen.getByText("Composer B"));

  await act(async () => {
    aPatch.resolve({ data: labReadback("server-a", 11, false) });
    await aPatch.promise;
  });
  assert.equal(
    screen.getByTestId("labs-readback-probe").textContent,
    "v20:master:on:comments:off",
    "stale server A mutation completion must not overwrite server B",
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Composer B enrollment" }));
  });

  assert.deepEqual(putCalls, [{
    url: "/servers/server-b/labs/composer_lab",
    body: { enabled: true, expectedVersion: 20 },
  }]);
});

test("server profile tab no longer embeds Labs settings", async () => {
  const server = createServer("server-profile", "Server Profile Only");
  seedSession(server);
  installFlagMock();
  let labsLoads = 0;
  api.get = (async (url: string) => {
    if (url === "/servers/server-profile/labs") {
      labsLoads += 1;
      return { data: labReadback("server-profile", 1, false) };
    }
    return { data: [] };
  }) as typeof api.get;

  renderServerProfilePanel();
  await flushMicrotasks();

  assert.ok(screen.getByText("Profile"));
  assert.equal(screen.queryByText("Server Labs access"), null);
  assert.equal(labsLoads, 0);
});

test("server Labs UI gate skips Labs API when disabled and mounts Labs when enabled", async () => {
  const server = createServer("server-labs-gate", "Labs Gate");
  seedSession(server);
  const labsGets: string[] = [];

  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/feature-flags/evaluate");
    const request = body as { keys: string[] };
    return {
      data: {
        evaluations: request.keys.map((key) => ({ key, enabled: false })),
      },
    };
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (String(url).includes("/labs")) labsGets.push(url);
    return { data: labReadback("server-labs-gate", 1, true) };
  }) as typeof api.get;

  renderSettingsPanel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    screen.queryByRole("switch", { name: "Server Labs access" }),
    null,
    "gate-off must not mount Labs controls",
  );
  assert.deepEqual(labsGets, [], "gate-off must not load Labs settings");

  cleanup();
  installFlagMock();
  setServerFeatureFlagForTests("server-labs-gate", SERVER_LABS_UI_FEATURE_FLAG_KEY, true);
  api.get = (async (url: string) => {
    if (String(url).includes("/labs")) labsGets.push(url);
    return { data: labReadback("server-labs-gate", 3, true) };
  }) as typeof api.get;
  renderSettingsPanel();
  assert.ok(await screen.findByRole("switch", { name: "Server Labs access" }));
  assert.ok(labsGets.some((url) => url === "/servers/server-labs-gate/labs"));
});

test("server Labs ignores stale same-server write completion after a fresh generation loads", async () => {
  const serverA = createServer("server-a", "Server A");
  const serverB = createServer("server-b", "Server B");
  seedSession(serverA);
  installFlagMock();

  const aInitialGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
  const bGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
  const aFreshGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
  const staleAPatch = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
  let patchCalls = 0;

  const aGets = [aInitialGet, aFreshGet];
  api.get = ((url: string) => {
    if (url === "/servers/server-a/labs") {
      const next = aGets.shift();
      if (!next) throw new Error(`unexpected extra GET ${url}`);
      return next.promise;
    }
    if (url === "/servers/server-b/labs") return bGet.promise;
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.patch = ((url: string, body?: unknown) => {
    patchCalls += 1;
    assert.equal(url, "/servers/server-a/labs/access");
    assert.deepEqual(body, { enabled: false, expectedVersion: 10 });
    return staleAPatch.promise;
  }) as typeof api.patch;
  api.put = (async (url: string) => {
    throw new Error(`unexpected PUT ${url}`);
  }) as typeof api.put;

  await prefetchServerFeatureFlags("server-a");
  await prefetchServerFeatureFlags("server-b");

  renderSettingsPanelWithReadbackProbe();

  await act(async () => {
    aInitialGet.resolve({ data: labReadback("server-a", 10, true) });
    await aInitialGet.promise;
  });
  assert.equal((await screen.findByTestId("labs-readback-probe")).textContent, "v10:master:on:comments:off");

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Server Labs access" }));
  });
  assert.equal(patchCalls, 1, "server A master toggle should start the stale mutation");

  await act(async () => {
    switchCurrentServer(serverB);
  });
  await act(async () => {
    bGet.resolve({ data: labReadback("server-b", 20, false) });
    await bGet.promise;
  });
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v20:master:on:comments:off");

  await act(async () => {
    switchCurrentServer(serverA);
  });
  await act(async () => {
    aFreshGet.resolve({ data: labReadback("server-a", 30, false) });
    await aFreshGet.promise;
  });
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v30:master:on:comments:off");
  assert.ok(screen.getByText("Composer A"));

  await act(async () => {
    staleAPatch.resolve({ data: labReadback("server-a", 11, false) });
    await staleAPatch.promise;
    await flushMicrotasks();
  });

  assert.equal(
    screen.getByTestId("labs-readback-probe").textContent,
    "v30:master:on:comments:off",
    "stale epoch1 write must not overwrite fresh epoch3 readback before a new write",
  );
  assert.equal(
    screen.queryByText("Failed to update Labs settings."),
    null,
    "stale epoch1 completion must not surface an update error in epoch3",
  );
  assert.notEqual(
    screen.getByRole("switch", { name: "Composer A enrollment" }).getAttribute("aria-disabled"),
    "true",
    "stale epoch1 saving state must not disable fresh epoch3 controls",
  );
  assert.equal(screen.queryByText("Saving Composer A"), null);
});

for (const staleOutcome of ["success", "reject"] as const) {
  test(`server Labs ignores stale ${staleOutcome} completion after returning to the same server in a new generation`, async () => {
    const serverA = createServer("server-a", "Server A");
    const serverB = createServer("server-b", "Server B");
    seedSession(serverA);
    installFlagMock();

    const aInitialGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
    const bGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
    const aFreshGet = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
    const staleAPatch = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
    const freshAPut = createDeferred<{ data: CanonicalServerLabSettingsReadback }>();
    const putCalls: Array<{ url: string; body: { enabled: boolean; expectedVersion: number } }> = [];
    let patchCalls = 0;

    const aGets = [aInitialGet, aFreshGet];
    api.get = ((url: string) => {
      if (url === "/servers/server-a/labs") {
        const next = aGets.shift();
        if (!next) throw new Error(`unexpected extra GET ${url}`);
        return next.promise;
      }
      if (url === "/servers/server-b/labs") return bGet.promise;
      throw new Error(`unexpected GET ${url}`);
    }) as typeof api.get;
    api.patch = ((url: string, body?: unknown) => {
      patchCalls += 1;
      assert.equal(url, "/servers/server-a/labs/access");
      assert.deepEqual(body, { enabled: false, expectedVersion: 10 });
      return staleAPatch.promise;
    }) as typeof api.patch;
    api.put = (async (url: string, body?: unknown) => {
      putCalls.push({ url, body: body as { enabled: boolean; expectedVersion: number } });
      return freshAPut.promise;
    }) as typeof api.put;

    await prefetchServerFeatureFlags("server-a");
    await prefetchServerFeatureFlags("server-b");

    renderSettingsPanelWithReadbackProbe();

    await act(async () => {
      aInitialGet.resolve({ data: labReadback("server-a", 10, true) });
      await aInitialGet.promise;
    });
    assert.equal((await screen.findByTestId("labs-readback-probe")).textContent, "v10:master:on:comments:off");

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Server Labs access" }));
    });
    assert.equal(patchCalls, 1, "server A master toggle should start the stale mutation");

    await act(async () => {
      switchCurrentServer(serverB);
    });
    await act(async () => {
      bGet.resolve({ data: labReadback("server-b", 20, false) });
      await bGet.promise;
    });
    assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v20:master:on:comments:off");

    await act(async () => {
      switchCurrentServer(serverA);
    });
    await act(async () => {
      aFreshGet.resolve({ data: labReadback("server-a", 30, false) });
      await aFreshGet.promise;
    });
    assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v30:master:on:comments:off");
    assert.ok(screen.getByText("Composer A"));

    const freshEnrollmentSwitch = screen.getByRole("switch", { name: "Composer A enrollment" });
    assert.notEqual(freshEnrollmentSwitch.getAttribute("aria-disabled"), "true", "old server A saving state must not disable fresh server A controls");
    assert.equal(freshEnrollmentSwitch.hasAttribute("data-disabled"), false, "old server A saving state must not mark fresh server A controls disabled");

    await act(async () => {
      fireEvent.click(freshEnrollmentSwitch);
    });

    assert.deepEqual(putCalls, [{
      url: "/servers/server-a/labs/composer_lab",
      body: { enabled: true, expectedVersion: 30 },
    }]);
    assert.equal(screen.getByRole("switch", { name: "Composer A enrollment" }).getAttribute("aria-disabled"), "true", "fresh server A save should disable controls while pending");
    assert.ok(screen.getByText("Saving Composer A"));

    await act(async () => {
      if (staleOutcome === "success") {
        staleAPatch.resolve({ data: labReadback("server-a", 11, false) });
      } else {
        staleAPatch.reject(new Error("stale update failed"));
      }
      try {
        await staleAPatch.promise;
      } catch {
        // Expected for the stale rejection case.
      }
      await flushMicrotasks();
    });

    assert.equal(
      screen.getByTestId("labs-readback-probe").textContent,
      "v30:master:on:comments:off",
      "stale epoch1 success must not overwrite fresh epoch3 readback",
    );
    assert.equal(screen.queryByText("Failed to update Labs settings."), null, "stale epoch1 rejection must not show an update error");
    assert.equal(screen.getByRole("switch", { name: "Composer A enrollment" }).getAttribute("aria-disabled"), "true", "stale epoch1 finally must not clear fresh server A saving state");
    assert.ok(screen.getByText("Saving Composer A"));

    await act(async () => {
      freshAPut.resolve({ data: labReadback("server-a", 31, true) });
      await freshAPut.promise;
      await flushMicrotasks();
    });

    assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v31:master:on:comments:off");
    assert.notEqual(screen.getByRole("switch", { name: "Composer A enrollment" }).getAttribute("aria-disabled"), "true", "fresh server A completion should clear its own saving state");
    assert.equal(screen.queryByText("Saving Composer A"), null);
  });
}

test("server Labs renders zh-cn catalog copy while keeping server-provided Lab text unchanged", async () => {
  const server = createServer("server-zh", "中文服务器");
  seedSession(server);
  installFlagMock();
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-zh/labs");
    return {
      data: {
        ...labReadback("server-zh", 7, true),
        canManageAccess: false,
        labs: [{
          labKey: "composer_lab",
          name: "Composer Lab",
          description: "Server-owned lab description.",
          state: "paused",
          enrolled: true,
          effective: false,
        }],
      },
    };
  }) as typeof api.get;

  renderSettingsPanel("zh-cn");

  assert.ok(await screen.findByText("服务器 Labs 访问"));
  assert.equal(screen.queryByText("版本 7") === null, true);
  assert.ok(screen.getByText("只有服务器所有者可以更改总开关。"));
  assert.ok(screen.getByText("Composer Lab"), "server-provided Lab name is not translated");
  assert.ok(screen.getByText("Server-owned lab description."), "server-provided Lab description is not translated");
  assert.ok(screen.getByText("已暂停、草稿和已下线的 Labs 在此处只读。"));

  const labsSection = screen.getByText("服务器 Labs 访问").closest(".mb-6");
  assert.ok(labsSection);
  assert.equal(within(labsSection as HTMLElement).queryByText("Server Labs access"), null);
  assert.equal(within(labsSection as HTMLElement).queryByText("Only server owners can change the master gate."), null);
  assert.equal(within(labsSection as HTMLElement).queryByText("已暂停"), null);
});

test("server Labs hides the retired inline replies gate", async () => {
  const server = createServer("server-inline-replies-copy", "Inline Replies Copy");
  seedSession(server);
  installFlagMock();
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-inline-replies-copy/labs");
    return {
      data: {
        ...labReadback("server-inline-replies-copy", 4, false),
        labs: [{
          labKey: "inline_thread_replies_v0",
          name: "Replies",
          description: "在频道消息下直接预览和展开回复",
          state: "open",
          enrolled: false,
          effective: false,
        }],
      },
    };
  }) as typeof api.get;

  renderSettingsPanel("en");

  assert.ok(await screen.findByText("Server Labs access"));
  assert.equal(screen.queryByText("Replies"), null);
  assert.equal(screen.queryByText("在频道消息下直接预览和展开回复"), null);
  assert.equal(screen.queryByRole("switch", { name: "Replies enrollment" }), null);
});

test("server Labs disables every enrollment switch with the master-off reason while access is off", async () => {
  const server = createServer("server-master-off", "Server Master Off");
  seedSession(server);
  installFlagMock();
  const putCalls: Array<{ url: string; body: unknown }> = [];
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-master-off/labs");
    return {
      data: {
        ...labReadback("server-master-off", 12, false),
        accessEnabled: false,
        labs: [
          {
            labKey: "composer_lab",
            name: "Composer Lab",
            description: "Open lab.",
            state: "open",
            enrolled: false,
            effective: false,
          },
          {
            labKey: "paused_lab",
            name: "Paused Lab",
            description: "Paused lab.",
            state: "paused",
            enrolled: true,
            effective: false,
          },
        ],
      },
    };
  }) as typeof api.get;
  api.put = (async (url: string, body?: unknown) => {
    putCalls.push({ url, body });
    return { data: labReadback("server-master-off", 13, true) };
  }) as typeof api.put;

  renderSettingsPanel("zh-cn");

  assert.ok(await screen.findByText("服务器 Labs 访问"));
  assert.equal(screen.getAllByText("需先开启 Server Labs 访问权限").length, 2);
  const composerSwitch = screen.getByRole("switch", { name: "Composer Lab 加入状态" });
  const pausedSwitch = screen.getByRole("switch", { name: "Paused Lab 加入状态" });
  assert.equal(composerSwitch.getAttribute("aria-disabled"), "true");
  assert.equal(pausedSwitch.getAttribute("aria-disabled"), "true");
  assert.equal(composerSwitch.getAttribute("aria-checked"), "false");
  assert.equal(pausedSwitch.getAttribute("aria-checked"), "false");
  assert.equal(composerSwitch.getAttribute("title"), "需先开启 Server Labs 访问权限");
  const labRows = screen.getAllByTestId("server-lab-row");
  assert.equal(labRows.length, 2);
  for (const row of labRows) {
    assert.doesNotMatch(row.className, /border/);
    assert.match(row.className, /grid-cols-\[minmax\(0,1fr\)_44px\]/);
    const rowSwitch = within(row).getByRole("switch");
    assert.match(rowSwitch.className, /justify-self-end/);
  }

  await act(async () => {
    fireEvent.click(composerSwitch);
  });

  assert.deepEqual(putCalls, []);
});

test("server Labs successful writes propagate through the shared readback source and registered gate consumers", async () => {
  const server = createServer("server-reactive", "Reactive Server");
  seedSession(server);

  let evaluatedRegisteredLab = false;
  const postCalls: Array<{ keys: string[] }> = [];
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/feature-flags/evaluate");
    const request = body as { keys: string[] };
    postCalls.push({ keys: request.keys });
    return {
      data: {
        evaluations: request.keys.map((key) => ({
          key,
          enabled: key === SERVER_LABS_UI_FEATURE_FLAG_KEY || (key === ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY && evaluatedRegisteredLab),
        })),
      },
    };
  }) as typeof api.post;

  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-reactive/labs");
    return { data: registeredLabReadback("server-reactive", 1, false, false) };
  }) as typeof api.get;

  const putCalls: Array<{ url: string; body: { enabled: boolean; expectedVersion: number } }> = [];
  api.patch = (async (url: string, body?: unknown) => {
    assert.equal(url, "/servers/server-reactive/labs/access");
    assert.deepEqual(body, { enabled: true, expectedVersion: 1 });
    return { data: registeredLabReadback("server-reactive", 2, true, false) };
  }) as typeof api.patch;
  api.put = (async (url: string, body?: unknown) => {
    putCalls.push({ url, body: body as { enabled: boolean; expectedVersion: number } });
    evaluatedRegisteredLab = true;
    return { data: registeredLabReadback("server-reactive", 3, true, true) };
  }) as typeof api.put;

  renderSettingsPanelWithProbes();

  assert.equal(await screen.findByText("Server Labs access") != null, true);
  assert.equal(screen.queryByText("Version 1") === null, true);
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v1:master:off:comments:off");
  assert.equal(screen.getByTestId("registered-lab-flag-probe").textContent, "flag:off");

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Server Labs access" }));
    await flushMicrotasks();
  });
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v2:master:on:comments:off");

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Attachment comments enrollment" }));
    await flushMicrotasks();
  });

  assert.deepEqual(putCalls, [{
    url: `/servers/server-reactive/labs/${ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY}`,
    body: { enabled: true, expectedVersion: 2 },
  }]);
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v3:master:on:comments:on");
  assert.equal(screen.queryByText("Effective") === null, true);
  assert.equal(screen.getByTestId("registered-lab-flag-probe").textContent, "flag:on");

  api.patch = (async (url: string, body?: unknown) => {
    assert.equal(url, "/servers/server-reactive/labs/access");
    assert.deepEqual(body, { enabled: false, expectedVersion: 3 });
    evaluatedRegisteredLab = false;
    return { data: registeredLabReadback("server-reactive", 4, false, true) };
  }) as typeof api.patch;

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Server Labs access" }));
    await flushMicrotasks();
  });

  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v4:master:off:comments:off");
  assert.equal(screen.getByTestId("registered-lab-flag-probe").textContent, "flag:off");
  assert.ok(postCalls.length >= 3, "mutation success should refresh the registered gate cache without a reload");
});

test("server Labs failed writes retain the authoritative readback and do not publish gate changes", async () => {
  const server = createServer("server-failed-write", "Failed Write Server");
  seedSession(server);
  installFlagMock();
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-failed-write/labs");
    return { data: registeredLabReadback("server-failed-write", 9, true, true) };
  }) as typeof api.get;
  let putCalls = 0;
  let postCalls = 0;
  api.post = (async (url: string, body?: unknown) => {
    postCalls += 1;
    assert.equal(url, "/feature-flags/evaluate");
    const request = body as { keys: string[] };
    return {
      data: {
        evaluations: request.keys.map((key) => ({
          key,
          enabled: key === SERVER_LABS_UI_FEATURE_FLAG_KEY || key === ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
        })),
      },
    };
  }) as typeof api.post;
  api.put = (async (url: string, body?: unknown) => {
    putCalls += 1;
    assert.equal(url, `/servers/server-failed-write/labs/${ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY}`);
    assert.deepEqual(body, { enabled: false, expectedVersion: 9 });
    throw new Error("CAS conflict");
  }) as typeof api.put;

  renderSettingsPanelWithProbes();

  assert.equal(await screen.findByText("Server Labs access") != null, true);
  assert.equal(screen.queryByText("Version 9") === null, true);
  assert.equal(screen.queryByText("Effective") === null, true);
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v9:master:on:comments:on");
  assert.equal(screen.getByTestId("registered-lab-flag-probe").textContent, "flag:on");

  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Attachment comments enrollment" }));
    await flushMicrotasks();
  });

  assert.equal(putCalls, 1);
  assert.ok(screen.getByText("Failed to update Labs settings."));
  assert.equal(screen.getByTestId("labs-readback-probe").textContent, "v9:master:on:comments:on");
  assert.equal(screen.getByTestId("registered-lab-flag-probe").textContent, "flag:on");
  assert.equal(postCalls, 1, "failed mutations must not refresh or overwrite the registered gate cache");
});
