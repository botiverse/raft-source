import test from "node:test";
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import ServerSwitcherMenu from "../src/components/ui/ServerSwitcherMenu";
import { TestIntlProvider } from "./helpers/intl";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import {
  getServerSwitcherTarget,
  openServerSwitcherAuxClickTarget,
} from "../src/utils/serverSwitcherNavigation";
import { installDesktopServerWindowBinding } from "../src/desktopServerWindow";

const originalOpen = window.open;

const currentServer: Server = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "Alpha",
  avatarUrl: null,
  slug: "alpha",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-06-27T00:00:00.000Z",
};

const targetServer: Server = {
  ...currentServer,
  id: "550e8400-e29b-41d4-a716-446655440001",
  name: "Beta",
  slug: "beta",
};

function resetServerStore() {
  useServerStore.setState({
    current: currentServer,
    servers: [currentServer, targetServer],
    members: [],
    loading: false,
    updateServerOrder: async () => {},
  } as never);
}

function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <>
      <output data-testid="path">{location.pathname}</output>
      <output data-testid="navigation-type">{navigationType}</output>
    </>
  );
}

function renderMenu(options: { muted?: boolean; navigationMode?: "replace-with-home" } = {}) {
  resetServerStore();
  localStorage.setItem("slock:serverSurface:v1:beta", "/s/beta/tasks");
  return render(
    <MemoryRouter initialEntries={["/s/alpha"]}>
      <TestIntlProvider>
        <LocationProbe />
        <ServerSwitcherMenu
          open
          onClose={() => {}}
          navigationMode={options.navigationMode}
          serverUnreadCounts={{
            "550e8400-e29b-41d4-a716-446655440001": {
              unreadCount: 3,
              activityUnreadCount: 5,
              serverPushMuted: options.muted === true,
            },
          }}
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.open = originalOpen;
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (globalThis as Record<string, unknown>).__RAFT_DESKTOP_DOCUMENT__;
  const marker = Object.getOwnPropertyDescriptor(
    globalThis,
    "__RAFT_DESKTOP_NATIVE_EXTENSIONS__",
  );
  if (marker?.configurable !== false) {
    delete (globalThis as Record<string, unknown>).__RAFT_DESKTOP_NATIVE_EXTENSIONS__;
  }
  resetServerStore();
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
});

test("hosted primary switch emits intent before navigation while auxiliary navigation stays Web-owned", () => {
  const calls: Array<{ kind: string; payload: object }> = [];
  Object.defineProperty(window, "RaftHost", {
    configurable: true,
    value: Object.freeze({
      version: "raft-host-v1",
      onboarding: Object.freeze({
        contractVersion: "raft-onboarding-v1",
        generation: "webview:1",
        sourceServerId: currentServer.id,
      }),
      emit(kind: string, payload: object) { calls.push({ kind, payload }); },
    }),
  });
  renderMenu();
  fireEvent.click(screen.getByText("Beta"));
  assert.equal(screen.getByTestId("path").textContent, "/s/alpha");
  assert.deepEqual(calls, [{
    kind: "onboarding:server-switch-request",
    payload: {
      contractVersion: "raft-onboarding-v1",
      generation: "webview:1",
      sourceServerId: currentServer.id,
      targetServerId: targetServer.id,
    },
  }]);

  const openedTargets: string[] = [];
  window.open = ((target: string) => {
    openedTargets.push(target);
    return null;
  }) as typeof window.open;
  const betaLink = screen.getByRole("link", { name: /Beta/ });
  const auxClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  assert.equal(betaLink.dispatchEvent(auxClick), false);
  assert.deepEqual(openedTargets, ["/s/beta/tasks"]);
  assert.equal(calls.length, 1, "auxiliary activation must not emit a Native switch intent");
});

test("server switcher link targets navigate normally and preserve modified clicks", () => {
  renderMenu();
  const betaLink = screen.getByRole("link", { name: /Beta/ });

  assert.equal(betaLink.getAttribute("href"), "/s/beta/tasks");
  assert.equal(screen.getByTestId("path").textContent, "/s/alpha");
  const modifiedClick = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
  assert.equal(betaLink.dispatchEvent(modifiedClick), true);
  assert.equal(modifiedClick.defaultPrevented, false);
  modifiedClick.preventDefault();
  assert.equal(screen.getByTestId("path").textContent, "/s/alpha");
  assert.equal(fireEvent.click(betaLink), false);
  assert.equal(screen.getByTestId("path").textContent, "/s/beta/tasks");
});

test("mobile server switch replaces the old server with the selected server home", () => {
  renderMenu({ navigationMode: "replace-with-home" });
  const betaLink = screen.getByRole("link", { name: /Beta/ });
  const openedTargets: string[] = [];
  window.open = ((target: string) => {
    openedTargets.push(target);
    return null;
  }) as typeof window.open;

  assert.equal(
    betaLink.getAttribute("href"),
    "/s/beta",
    "mobile switching must not reopen a remembered channel/detail surface",
  );
  const auxClick = new MouseEvent("auxclick", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  assert.equal(betaLink.dispatchEvent(auxClick), false);
  assert.deepEqual(
    openedTargets,
    ["/s/beta"],
    "the mobile row must keep its Home target for auxiliary activation too",
  );
  fireEvent.click(betaLink);
  assert.equal(screen.getByTestId("path").textContent, "/s/beta");
  assert.equal(
    screen.getByTestId("navigation-type").textContent,
    "REPLACE",
    "the previous server must not remain directly behind the selected server",
  );
});

test("server switcher rows open the remembered target on middle-click", () => {
  renderMenu();
  const betaLink = screen.getByRole("link", { name: /Beta/ });
  const calls: Array<[string, "_blank", "noopener,noreferrer"]> = [];
  window.open = ((...args: Parameters<typeof window.open>) => {
    calls.push(args as [string, "_blank", "noopener,noreferrer"]);
    return null;
  }) as typeof window.open;

  const auxClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  assert.equal(betaLink.dispatchEvent(auxClick), false);
  assert.deepEqual(calls, [["/s/beta/tasks", "_blank", "noopener,noreferrer"]]);
});

test("old native without the advertised open extension keeps the browser fallback", async () => {
  let invokes = 0;
  (globalThis as Record<string, unknown>).__RAFT_DESKTOP_DOCUMENT__ = {
    generation: 13,
    nonce: "document-thirteen",
  };
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => {
      invokes += 1;
      throw new Error("old native must not receive successor command");
    },
  };
  const browserTargets: string[] = [];
  window.open = ((target: string) => {
    browserTargets.push(target);
    return null;
  }) as typeof window.open;
  renderMenu();
  const betaLink = screen.getByRole("link", { name: /Beta/ });
  const auxClick = new MouseEvent("auxclick", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  assert.equal(betaLink.dispatchEvent(auxClick), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(invokes, 0);
  assert.deepEqual(browserTargets, ["/s/beta/tasks"]);
});

test("desktop modified and middle clicks use canonical IPC and never window.open", async () => {
  const invokes: Array<{ command: string; args: unknown }> = [];
  (globalThis as Record<string, unknown>).__RAFT_DESKTOP_DOCUMENT__ = {
    generation: 13,
    nonce: "document-thirteen",
  };
  Object.defineProperty(globalThis, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
    value: Object.freeze({ "window.openServer": 1 }),
    writable: false,
    configurable: false,
  });
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args: unknown) => {
      invokes.push({ command, args });
      return {
        method: "window.openServer",
        status: "ok",
        result: {
          serverId: "550e8400-e29b-41d4-a716-446655440001",
          disposition: invokes.length === 1 ? "opened" : "focusedExisting",
        },
      };
    },
  };
  installDesktopServerWindowBinding(
    Promise.resolve({ mode: "desktop" } as const),
    globalThis,
    { currentServerId: () => null, subscribe: () => () => {} },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  let browserOpens = 0;
  window.open = (() => {
    browserOpens += 1;
    return null;
  }) as typeof window.open;
  renderMenu();
  const betaLink = screen.getByRole("link", { name: /Beta/ });

  const modifiedClick = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  assert.equal(betaLink.dispatchEvent(modifiedClick), false);
  const auxClick = new MouseEvent("auxclick", {
    bubbles: true,
    cancelable: true,
    button: 1,
  });
  assert.equal(betaLink.dispatchEvent(auxClick), false);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(browserOpens, 0);
  assert.deepEqual(invokes, [1, 2].map(() => ({
    command: "window_open_server",
    args: { params: {
      serverId: "550e8400-e29b-41d4-a716-446655440001",
      documentGeneration: 13,
      documentNonce: "document-thirteen",
    } },
  })));
});

test("server switcher renders the known Activity count, not the broader legacy count", () => {
  renderMenu();
  const unreadCount = screen.getByText("5");

  assert.equal(unreadCount.getAttribute("data-slot"), "badge");
  assert.equal(unreadCount.getAttribute("data-variant"), "accent");
  assert.equal(unreadCount.classList.contains("bg-accent-400"), true);
  assert.equal(unreadCount.classList.contains("rounded"), true);
  assert.equal(unreadCount.classList.contains("h-auto"), true);
  assert.equal(unreadCount.classList.contains("min-w-0"), true);
  assert.equal(unreadCount.classList.contains("px-1.5"), true);
  assert.equal(unreadCount.classList.contains("py-0.5"), true);
  assert.equal(unreadCount.classList.contains("text-white"), true);
  assert.equal(unreadCount.classList.contains("text-black/50"), false);
  assert.equal(unreadCount.classList.contains("ml-auto"), true);
  assert.equal(unreadCount.classList.contains("justify-center"), true);
  const reorder = screen.getByRole("button", { name: "Reorder Beta" });
  assert.equal(reorder.classList.contains("w-6"), true);
});

test("server switcher renders muted Activity counts as quiet right-aligned numbers", () => {
  renderMenu({ muted: true });
  const unreadCount = screen.getByText("5");

  assert.equal(unreadCount.classList.contains("bg-brutal-pink"), false);
  assert.equal(unreadCount.classList.contains("font-mono"), true);
  assert.equal(unreadCount.classList.contains("text-black/50"), true);
  assert.equal(unreadCount.classList.contains("ml-auto"), true);
  assert.equal(unreadCount.getAttribute("title"), "Notifications muted");
});

test("server switcher target helpers preserve remembered surfaces and ignore left clicks", () => {
  assert.equal(
    getServerSwitcherTarget("alpha", (slug) => `/s/${slug}/saved`),
    "/s/alpha/saved",
  );
  assert.equal(getServerSwitcherTarget("alpha", () => null), "/s/alpha");

  const calls: Array<[string, "_blank", "noopener,noreferrer"]> = [];
  let prevented = 0;
  let stopped = 0;
  const handled = openServerSwitcherAuxClickTarget(
    {
      button: 1,
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => {
        stopped += 1;
      },
    },
    "550e8400-e29b-41d4-a716-446655440000",
    "alpha",
    {
      readSurface: (slug) => `/s/${slug}/settings`,
      openNewTab: (...args) => {
        calls.push(args);
      },
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, [["/s/alpha/settings", "_blank", "noopener,noreferrer"]]);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);

  const ignored = openServerSwitcherAuxClickTarget(
    {
      button: 0,
      preventDefault: () => {
        throw new Error("left click should not be intercepted by aux handler");
      },
      stopPropagation: () => {
        throw new Error("left click should not stop propagation");
      },
    },
    "550e8400-e29b-41d4-a716-446655440000",
    "alpha",
    {
      readSurface: () => "/s/alpha/saved",
      openNewTab: () => {
        throw new Error("left click should not open a tab");
      },
    },
  );

  assert.equal(ignored, false);
});
