import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, useLocation } from "react-router-dom";
import { useJoinCommunityFlow } from "../src/hooks/useJoinCommunityFlow";
import { useServerStore } from "../src/store/serverStore";
import type { CommunityServerSlug, Server } from "../src/store/serverStore";

const originalOpen = window.open;

const joinedServer: Server = {
  id: "server-community",
  name: "Raft Community",
  avatarUrl: null,
  slug: "community",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "member",
  createdAt: "2026-06-29T00:00:00.000Z",
};

type OpenCall = [string | URL | undefined, string | undefined, string | undefined];

function resetServerStore(joinCommunityServer: (options?: { agreementId?: string | null; slug?: CommunityServerSlug }) => Promise<Server>) {
  useServerStore.setState({
    current: null,
    servers: [],
    members: [],
    loading: false,
    joinCommunityServer,
  } as never);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

function Harness({
  navigation,
  onError,
  onJoined,
}: {
  navigation?: "same-tab" | "new-tab";
  onError?: (error: unknown, slug: CommunityServerSlug, message: string) => void;
  onJoined?: (server: Server, slug: CommunityServerSlug) => void;
}) {
  const flow = useJoinCommunityFlow({
    joinedServerNavigation: navigation,
    onError,
    onJoined,
  });
  return (
    <>
      <LocationProbe />
      <button onClick={() => void flow.joinCommunity("community")}>Join community</button>
      {flow.agreementDialog}
    </>
  );
}

function renderHarness(options: ComponentProps<typeof Harness> = {}) {
  return render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <Harness {...options} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.open = originalOpen;
  resetServerStore(async () => joinedServer);
});

test("default community join navigates in the same tab", async () => {
  const calls: OpenCall[] = [];
  window.open = ((...args: Parameters<typeof window.open>) => {
    calls.push(args as OpenCall);
    return null;
  }) as typeof window.open;
  resetServerStore(async () => joinedServer);

  renderHarness();
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() => assert.equal(screen.getByTestId("path").textContent, "/s/community"));
  assert.deepEqual(calls, []);
});

test("new-tab community join reserves a blank tab and reuses it after joining", async () => {
  const reservedTab = {
    closed: false,
    opener: {} as unknown,
    location: { href: "" },
    close: () => {
      throw new Error("successful new-tab join should not close the reserved tab");
    },
  } as unknown as Window;
  const calls: OpenCall[] = [];
  window.open = ((...args: Parameters<typeof window.open>) => {
    calls.push(args as OpenCall);
    return reservedTab;
  }) as typeof window.open;
  const joined: Array<[Server, CommunityServerSlug]> = [];
  resetServerStore(async () => joinedServer);

  renderHarness({
    navigation: "new-tab",
    onJoined: (server, slug) => joined.push([server, slug]),
  });
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() => assert.equal(reservedTab.location.href, "/s/community"));
  assert.equal(screen.getByTestId("path").textContent, "/s/dev");
  assert.deepEqual(calls, [["about:blank", "_blank"]]);
  assert.equal(reservedTab.opener, null);
  assert.deepEqual(joined, [[joinedServer, "community"]]);
});

test("new-tab community join falls back to opening the joined server when the reserved tab is closed", async () => {
  const reservedTab = {
    closed: true,
    opener: {} as unknown,
    location: { href: "" },
    close: () => {},
  } as unknown as Window;
  const calls: OpenCall[] = [];
  window.open = ((...args: Parameters<typeof window.open>) => {
    calls.push(args as OpenCall);
    return calls.length === 1 ? reservedTab : null;
  }) as typeof window.open;
  resetServerStore(async () => joinedServer);

  renderHarness({ navigation: "new-tab" });
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() =>
    assert.deepEqual(calls, [
      ["about:blank", "_blank"],
      ["/s/community", "_blank", "noopener,noreferrer"],
    ]),
  );
  assert.equal(reservedTab.location.href, "");
  assert.equal(screen.getByTestId("path").textContent, "/s/dev");
});

test("new-tab community join tolerates a blocked reserved tab and still opens the joined server", async () => {
  const calls: OpenCall[] = [];
  window.open = ((...args: Parameters<typeof window.open>) => {
    calls.push(args as OpenCall);
    return null;
  }) as typeof window.open;
  resetServerStore(async () => joinedServer);

  renderHarness({ navigation: "new-tab" });
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() =>
    assert.deepEqual(calls, [
      ["about:blank", "_blank"],
      ["/s/community", "_blank", "noopener,noreferrer"],
    ]),
  );
  assert.equal(screen.getByTestId("path").textContent, "/s/dev");
});

test("new-tab community join closes the reserved tab and reports non-agreement errors", async () => {
  let closed = 0;
  const reservedTab = {
    closed: false,
    opener: {} as unknown,
    location: { href: "" },
    close: () => {
      closed += 1;
      reservedTab.closed = true;
    },
  } as unknown as Window & { closed: boolean };
  const error = new Error("network down");
  const errors: Array<[unknown, CommunityServerSlug, string]> = [];
  window.open = (() => reservedTab) as typeof window.open;
  resetServerStore(async () => {
    throw error;
  });

  renderHarness({
    navigation: "new-tab",
    onError: (...args) => errors.push(args),
  });
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() => assert.equal(closed, 1));
  assert.deepEqual(errors, [[error, "community", "Failed to join community server"]]);
  assert.equal(reservedTab.location.href, "");
  assert.equal(screen.getByTestId("path").textContent, "/s/dev");
});

test("new-tab community join does not close an already-closed reserved tab after an error", async () => {
  let closed = 0;
  const reservedTab = {
    closed: true,
    opener: {} as unknown,
    location: { href: "" },
    close: () => {
      closed += 1;
    },
  } as unknown as Window;
  const error = new Error("network down");
  const errors: Array<[unknown, CommunityServerSlug, string]> = [];
  window.open = (() => reservedTab) as typeof window.open;
  resetServerStore(async () => {
    throw error;
  });

  renderHarness({
    navigation: "new-tab",
    onError: (...args) => errors.push(args),
  });
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() => assert.equal(errors.length, 1));
  assert.equal(closed, 0);
  assert.deepEqual(errors, [[error, "community", "Failed to join community server"]]);
});

test("new-tab community join closes the reserved tab and shows agreement prompts", async () => {
  let closed = 0;
  const reservedTab = {
    closed: false,
    opener: {} as unknown,
    location: { href: "" },
    close: () => {
      closed += 1;
      reservedTab.closed = true;
    },
  } as unknown as Window & { closed: boolean };
  const agreementError = {
    response: {
      data: {
        error: "agreement_required",
        agreement: {
          id: "agreement-1",
          title: "Community rules",
          bodyMarkdown: "Be excellent to each other.",
          version: 1,
        },
      },
    },
  };
  window.open = (() => reservedTab) as typeof window.open;
  resetServerStore(async () => {
    throw agreementError;
  });

  renderHarness({ navigation: "new-tab" });
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() => assert.equal(closed, 1));
  assert.ok(screen.getByRole("heading", { name: "Community rules" }));
  assert.match(screen.getByText("Be excellent to each other.").textContent ?? "", /excellent/);
  assert.equal(reservedTab.location.href, "");
  assert.equal(screen.getByTestId("path").textContent, "/s/dev");
});

test("community join uses updated navigation and join callback options after rerender", async () => {
  const reservedTab = {
    closed: false,
    opener: {} as unknown,
    location: { href: "" },
    close: () => {},
  } as unknown as Window;
  const calls: OpenCall[] = [];
  window.open = ((...args: Parameters<typeof window.open>) => {
    calls.push(args as OpenCall);
    return reservedTab;
  }) as typeof window.open;
  const joined: Array<[Server, CommunityServerSlug]> = [];
  resetServerStore(async () => joinedServer);

  const view = renderHarness({
    navigation: "same-tab",
    onJoined: () => {
      throw new Error("stale onJoined callback should not run");
    },
  });
  view.rerender(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <Harness
        navigation="new-tab"
        onJoined={(server, slug) => {
          joined.push([server, slug]);
        }}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() => assert.equal(reservedTab.location.href, "/s/community"));
  assert.deepEqual(calls, [["about:blank", "_blank"]]);
  assert.equal(screen.getByTestId("path").textContent, "/s/dev");
  assert.deepEqual(joined, [[joinedServer, "community"]]);
});

test("community join reports errors through the latest callback after rerender", async () => {
  const error = new Error("network down");
  const staleErrors: Array<[unknown, CommunityServerSlug, string]> = [];
  const freshErrors: Array<[unknown, CommunityServerSlug, string]> = [];
  resetServerStore(async () => {
    throw error;
  });

  const view = renderHarness({
    onError: (...args) => staleErrors.push(args),
  });
  view.rerender(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <Harness onError={(...args) => freshErrors.push(args)} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Join community" }));

  await waitFor(() => assert.equal(freshErrors.length, 1));
  assert.deepEqual(staleErrors, []);
  assert.deepEqual(freshErrors, [[error, "community", "Failed to join community server"]]);
});
