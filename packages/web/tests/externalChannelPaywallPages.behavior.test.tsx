import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import api from "../src/api/client";
import { flushProductEvents, resetProductEventsForTest } from "../src/analytics/track";
import { resetPaywallShownForTest } from "../src/analytics/paywall";
import { setToastManager } from "../src/components/toastBridge";
import { EXTERNAL_INVITE_ROUTE, SERVER_CONNECT_REQUEST_ROUTE } from "../src/components/externalInvite/externalInviteAccept";
import ExternalInvitePage from "../src/pages/ExternalInvitePage";
import ServerConnectRequestPage from "../src/pages/ServerConnectRequestPage";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { useUpgradeDialogStore } from "../src/store/upgradeDialogStore";
import { TestIntlProvider } from "./helpers/intl";

// The page's upgrade dialog is a deferred chunk: loaded once here, so each test's dialog renders without waiting on the import.
await import("../src/components/billing/ServerUpgradeDialog");

// The external channel paywall on the two pages outside the app (design v4
// C, D, E; cindyz approved Warden's v4): the invitee's connect list and the
// approver's page. Acme hosts #launch; Beta is a free server already in
// another external channel; Mei Chen owns Beta, Raj administers it. An owner
// upgrades Beta on the page itself (the upgrade dialog for Beta, not the
// current server), and Stripe brings them back to the page. The server's
// limit fields (Warden's #14528) are stubbed; without them the pages behave
// as before. Absence is `query... === null`.

const originalGet = api.get;
const originalPost = api.post;
const originalLoadServers = useServerStore.getState().loadServers;

type Call = { url: string; body?: unknown; serverHeader?: unknown };
type Answer = { status?: number; data?: unknown } | Error;

function httpError(status: number) {
  return Object.assign(new Error(String(status)), { response: { status, data: { error: "server text" } } });
}

/** The api's answers by URL; every call is recorded with the server it named (`X-Server-Id`). */
function stubApi(handlers: { get: (url: string) => Answer; post?: (url: string, body: unknown) => Answer }): { gets: Call[]; posts: Call[] } {
  const gets: Call[] = [];
  const posts: Call[] = [];
  const answer = (value: Answer) => {
    if (value instanceof Error) throw value;
    return { status: value.status ?? 200, data: value.data };
  };
  api.get = (async (url: string, config?: { headers?: Record<string, unknown> }) => {
    gets.push({ url, serverHeader: config?.headers?.["X-Server-Id"] });
    return answer(handlers.get(url));
  }) as typeof api.get;
  api.post = (async (url: string, body: unknown, config?: { headers?: Record<string, unknown> }) => {
    posts.push({ url, body, serverHeader: config?.headers?.["X-Server-Id"] });
    return answer(handlers.post ? handlers.post(url, body) : httpError(500));
  }) as typeof api.post;
  return { gets, posts };
}

const MEI = { id: "u-mei", email: "mei@beta.dev", name: "mei", displayName: "Mei Chen", emailVerified: true };
const RAJ = { id: "u-raj", email: "raj@beta.dev", name: "raj", displayName: "Raj Patel", emailVerified: true };
const OWNERS = [{ id: "u-mei", name: "Mei Chen", avatarUrl: null }];

function serversFor(role: "owner" | "admin" | "member") {
  return [
    { id: "s-beta", name: "Beta", slug: "beta", avatarUrl: null, plan: "free", role },
    { id: "s-gamma", name: "Gamma", slug: "gamma", avatarUrl: null, plan: "pro", role: "owner" },
  ];
}

/** Beta's billing as GET /billing/subscription answers it for Beta. */
function betaBilling(plan: "free" | "pro") {
  return {
    plan,
    source: plan === "pro" ? "subscription" : "server",
    usage: { humans: 4, agents: 3, universalSeats: 4.3 },
    permissions: { canReadBillingSummary: true, canManageBilling: true },
  };
}

function connectable(beta: Record<string, unknown>) {
  return [
    { id: "s-beta", name: "Beta", slug: "beta", canConnectDirectly: true, needsApproval: false, approvers: [], ...beta },
    { id: "s-gamma", name: "Gamma", slug: "gamma", canConnectDirectly: true, needsApproval: false, approvers: [], atLimit: false, canUpgrade: false },
  ];
}

function invite(beta: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return {
    channelName: "launch",
    serverName: "Acme",
    inviterName: "Dana",
    expiresAt: "2026-11-20T12:00:00.000Z",
    status: "pending",
    addressedToYou: true,
    options: { guest: true, newServer: true, connect: { servers: connectable(beta) }, ...options },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

type Toast = { title: string; description?: string };

function renderAt(path: string, user: typeof MEI, role: "owner" | "admin" | "member"): { toasts: Toast[] } {
  useAuthStore.setState({ user, loading: false, initialized: true } as never);
  useServerStore.setState({ servers: serversFor(role), current: null, loadServers: async () => {} } as never);
  const toasts: Toast[] = [];
  setToastManager({ add: (toast) => { toasts.push({ title: toast.title, description: toast.description }); } });
  // The checkout's return is this page (shareableWebUrl reads the window's address).
  window.history.replaceState(null, "", path);
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={EXTERNAL_INVITE_ROUTE} element={<ExternalInvitePage pollMs={5} />} />
          <Route path={SERVER_CONNECT_REQUEST_ROUTE} element={<ServerConnectRequestPage />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { toasts };
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function isDisabled(element: HTMLElement): boolean {
  return element.getAttribute("aria-disabled") === "true" || element.hasAttribute("data-disabled") || (element as HTMLButtonElement).disabled === true;
}

/** Back to this window (the page reads Beta's plan again). */
async function returnToWindow() {
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
  });
}

type SentEvent = { event: string; properties: Record<string, unknown> };

function captureProductEvents(): SentEvent[] {
  const sent: SentEvent[] = [];
  window.localStorage.setItem("slock_access_token", "token-1");
  resetProductEventsForTest(async (url, init) => {
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: true }), { status: 200 });
    for (const { event, properties } of (JSON.parse(String(init?.body)) as { events: SentEvent[] }).events) sent.push({ event, properties });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });
  return sent;
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  setToastManager(null);
  resetPaywallShownForTest();
  resetProductEventsForTest();
  window.localStorage.removeItem("slock_access_token");
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  useUpgradeDialogStore.setState({ request: null });
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState({ servers: [], current: null, loadServers: originalLoadServers } as never);
});

// ── C: the invitee owns the free server at its limit ──

test("C: the owner's Upgrade on Beta's row opens the upgrade dialog on this page for Beta, titled for connecting it to #launch, and checkout comes back here", async () => {
  const sent = captureProductEvents();
  const { gets, posts } = stubApi({
    get: (url) => (url === "/external-invites/tok-1" ? { data: invite({ atLimit: true, canUpgrade: true, owners: OWNERS }) }
      : url === "/billing/subscription" ? { data: betaBilling("free") } : httpError(404)),
    post: (url) => (url === "/billing/checkout" ? { data: { url: "#stripe-checkout" } } : httpError(500)),
  });
  renderAt("/external-invite/tok-1", MEI, "owner");
  await click(await screen.findByTestId("external-invite-option-connect"));

  assert.ok(isDisabled(screen.getByRole("checkbox", { name: /Beta/ })), "Beta can't be chosen");
  assert.ok(!isDisabled(screen.getByRole("checkbox", { name: /Gamma/ })));
  assert.equal(
    screen.getByTestId("external-invite-connect-limit").textContent,
    "Beta's Free plan allows 1 external channel. Upgrade to connect it here.",
  );

  await click(screen.getByRole("button", { name: "Upgrade Beta" }));
  const request = useUpgradeDialogStore.getState().request;
  assert.equal(request?.serverId, "s-beta");
  assert.equal(request?.gate, "external_channel_free_limit");
  assert.equal(request?.surface, "external_invite_page");
  assert.deepEqual(request?.externalContext, { kind: "connect", channel: "#launch" });
  assert.equal(request?.onPage, true, "this page's dialog, not the app's");
  assert.equal(screen.getByTestId("location").textContent, "/external-invite/tok-1", "the page stays");
  assert.equal(useServerStore.getState().current, null, "no server is entered");

  const dialog = await screen.findByTestId("upgrade-dialog");
  assert.ok(within(dialog).getByRole("heading", { name: "Connect Beta to #launch" }));
  assert.ok(within(dialog).getByText("Beta's Free plan allows 1 external channel. Pro has no limit."));
  // Beta's billing, read for Beta: its seats start at its people and agents.
  await waitFor(() => assert.equal(screen.getByTestId("upgrade-dialog-seats").textContent, "5"));
  assert.ok(gets.some((call) => call.url === "/billing/subscription" && call.serverHeader === "s-beta"));
  assert.ok(!gets.some((call) => call.url === "/billing/subscription" && call.serverHeader !== "s-beta"), "no other server's billing");

  await click(screen.getByTestId("upgrade-dialog-checkout"));
  await waitFor(() => assert.ok(window.location.href.endsWith("#stripe-checkout")));
  const checkout = posts.find((call) => call.url === "/billing/checkout");
  assert.equal(checkout?.serverHeader, "s-beta", "Beta is the server paid for");
  const body = checkout?.body as { successUrl: string; cancelUrl: string; entry: string; surface: string };
  assert.equal(body.entry, "external_channel_free_limit");
  assert.equal(body.surface, "external_invite_page");
  const success = new URL(body.successUrl);
  assert.equal(success.pathname, "/external-invite/tok-1", "Stripe brings them back to the invite");
  assert.equal(success.searchParams.get("upgrade"), "external_channel_free_limit");
  assert.equal(success.searchParams.get("upgradeServer"), "s-beta");
  assert.equal(success.searchParams.get("upgradeSurface"), "external_invite_page");
  assert.equal(success.searchParams.get("upgradeCanceled"), null);
  const cancel = new URL(body.cancelUrl);
  assert.equal(cancel.searchParams.get("upgradeCanceled"), "1");
  assert.equal(cancel.searchParams.get("upgradeServer"), "s-beta");

  // Counted on Beta, where the owner met it: the line shown, then the Upgrade pressed.
  await flushProductEvents();
  const shown = sent.find((event) => event.event === "paywall_shown");
  assert.deepEqual(shown?.properties, { gate: "external_channel_free_limit", viewer_role: "owner", plan: "free", surface: "external_invite_page" });
  const action = sent.find((event) => event.event === "paywall_action");
  assert.deepEqual(action?.properties, { gate: "external_channel_free_limit", viewer_role: "owner", action: "upgrade", surface: "external_invite_page" });
});

test("C: back from Stripe the page opens on the connect list, waits for Beta's plan, and once Beta is Pro it can be chosen", async () => {
  let betaPlan: "free" | "pro" = "free";
  let reads = 0;
  stubApi({
    get: (url) => {
      if (url === "/external-invites/tok-1") {
        reads += 1;
        return { data: invite(betaPlan === "pro" ? { atLimit: false, canUpgrade: false } : { atLimit: true, canUpgrade: true, owners: OWNERS }) };
      }
      return url === "/billing/subscription" ? { data: betaBilling(betaPlan) } : httpError(404);
    },
  });
  const { toasts } = renderAt("/external-invite/tok-1?upgrade=external_channel_free_limit&upgradeSurface=external_invite_page&upgradeServer=s-beta", MEI, "owner");

  await screen.findByTestId("external-invite-connect");
  const dialog = await screen.findByTestId("upgrade-dialog");
  assert.ok(within(dialog).getByRole("heading", { name: "Connect Beta to #launch" }));
  assert.ok(within(dialog).getByTestId("upgrade-dialog-waiting"), "it waits for the plan");
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/external-invite/tok-1", "Stripe's parameters dropped"));
  assert.equal(useUpgradeDialogStore.getState().request?.surface, "external_invite_page");

  // The payment lands: the next read finds Beta on Pro.
  betaPlan = "pro";
  await returnToWindow();
  await waitFor(() => assert.ok(screen.queryByTestId("upgrade-dialog") === null, "the dialog closed"));
  assert.deepEqual(toasts, [{ title: "Beta is on Pro", description: "Beta can share as many channels outside it as it needs." }]);
  await waitFor(() => assert.equal(reads, 2, "the invite read again"));
  await waitFor(() => assert.ok(!isDisabled(screen.getByRole("checkbox", { name: /Beta/ }))));
  assert.ok(screen.getByTestId("external-invite-connect"), "still on the connect list");
  assert.ok(screen.queryByTestId("external-invite-connect-limit") === null);
  await click(screen.getByRole("checkbox", { name: /Beta/ }));
  assert.equal(screen.getByTestId("external-invite-connect-commit").textContent, "Connect Beta");
});

test("C: back from a cancelled payment, the dialog offers Beta's upgrade again over the connect list", async () => {
  stubApi({
    get: (url) => (url === "/external-invites/tok-1" ? { data: invite({ atLimit: true, canUpgrade: true, owners: OWNERS }) }
      : url === "/billing/subscription" ? { data: betaBilling("free") } : httpError(404)),
  });
  renderAt("/external-invite/tok-1?upgrade=external_channel_free_limit&upgradeCanceled=1&upgradeSurface=external_invite_page&upgradeServer=s-beta", MEI, "owner");
  await screen.findByTestId("external-invite-connect");
  const dialog = await screen.findByTestId("upgrade-dialog");
  assert.ok(within(dialog).getByRole("heading", { name: "Connect Beta to #launch" }));
  assert.ok(within(dialog).getByTestId("upgrade-dialog-checkout"), "the choices again");
  assert.equal(useUpgradeDialogStore.getState().request?.stage, "choose");
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/external-invite/tok-1"));
});

// ── D: the invitee can't pay for that server ──

test("D: an admin of Beta sees the row at its limit and a line naming who can upgrade it, with no Upgrade", async () => {
  const sent = captureProductEvents();
  stubApi({ get: (url) => (url === "/external-invites/tok-1" ? { data: invite({ atLimit: true, canUpgrade: false, owners: [...OWNERS, { id: "u-raj", name: "Raj Patel" }] }) } : httpError(404)) });
  renderAt("/external-invite/tok-1", RAJ, "admin");
  await click(await screen.findByTestId("external-invite-option-connect"));

  assert.ok(isDisabled(screen.getByRole("checkbox", { name: /Beta/ })));
  assert.ok(screen.getByText("At external channel limit"), "the row as before");
  assert.ok(screen.queryByTestId("external-invite-server-upgrade") === null, "no Upgrade");
  assert.ok(screen.queryByRole("button", { name: /Upgrade/ }) === null);
  // The viewer isn't named among the owners to ask.
  assert.equal(
    screen.getByTestId("external-invite-connect-limit").textContent,
    "Beta's Free plan allows 1 external channel. Ask an owner of Beta (Mei Chen) to upgrade, or go Back and join as a guest.",
  );
  await flushProductEvents();
  assert.deepEqual(sent.find((event) => event.event === "paywall_shown")?.properties, {
    gate: "external_channel_free_limit", viewer_role: "admin", plan: "free", surface: "external_invite_page",
  });
});

test("D: without owners from the server it says \"an owner of Beta\"; where the invite takes no guest it doesn't offer joining as one", async () => {
  stubApi({ get: (url) => (url === "/external-invites/tok-1" ? { data: invite({ atLimit: true, canUpgrade: false }) } : httpError(404)) });
  renderAt("/external-invite/tok-1", RAJ, "member");
  await click(await screen.findByTestId("external-invite-option-connect"));
  assert.equal(
    screen.getByTestId("external-invite-connect-limit").textContent,
    "Beta's Free plan allows 1 external channel. Ask an owner of Beta to upgrade, or go Back and join as a guest.",
  );
  cleanup();

  stubApi({ get: (url) => (url === "/external-invites/tok-1" ? { data: invite({ atLimit: true, canUpgrade: false, owners: OWNERS }, { guest: false }) } : httpError(404)) });
  renderAt("/external-invite/tok-1", RAJ, "member");
  await click(await screen.findByTestId("external-invite-option-connect"));
  assert.equal(
    screen.getByTestId("external-invite-connect-limit").textContent,
    "Beta's Free plan allows 1 external channel. Ask an owner of Beta (Mei Chen) to upgrade.",
  );
});

test("an older server (no owners; Upgrade for admins too): an admin's Upgrade goes into Beta in the app as before, with no line; an owner's opens here", async () => {
  stubApi({ get: (url) => (url === "/external-invites/tok-1" ? { data: invite({ atLimit: true, canUpgrade: true }) } : httpError(404)) });
  renderAt("/external-invite/tok-1", RAJ, "admin");
  await click(await screen.findByTestId("external-invite-option-connect"));
  assert.ok(screen.queryByTestId("external-invite-connect-limit") === null, "no line");
  await click(screen.getByRole("button", { name: "Upgrade Beta" }));
  assert.equal(useUpgradeDialogStore.getState().request?.serverId, "s-beta");
  assert.equal(useUpgradeDialogStore.getState().request?.onPage, undefined, "the app's dialog");
  assert.equal(useServerStore.getState().current?.id, "s-beta", "on Beta");
  assert.equal(screen.getByTestId("location").textContent, "/s/beta");
  cleanup();
  useUpgradeDialogStore.setState({ request: null });

  stubApi({
    get: (url) => (url === "/external-invites/tok-1" ? { data: invite({ atLimit: true, canUpgrade: true }) }
      : url === "/billing/subscription" ? { data: betaBilling("free") } : httpError(404)),
  });
  renderAt("/external-invite/tok-1", MEI, "owner");
  await click(await screen.findByTestId("external-invite-option-connect"));
  assert.equal(screen.getByTestId("external-invite-connect-limit").textContent, "Beta's Free plan allows 1 external channel. Upgrade to connect it here.");
  await click(screen.getByRole("button", { name: "Upgrade Beta" }));
  assert.ok(await screen.findByRole("heading", { name: "Connect Beta to #launch" }));
  assert.equal(screen.getByTestId("location").textContent, "/external-invite/tok-1");
});

// ── E: the approver's page ──

function request(targetServer: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    status: "pending",
    channelName: "launch",
    hostServerName: "Acme",
    targetServer: { id: "s-beta", name: "Beta", ...targetServer },
    requester: { id: "u-dana", name: "Dana" },
    expiresAt: "2026-11-20T12:00:00.000Z",
    canApprove: true,
    ...overrides,
  };
}

test("E: the owner sees the limit as the page opens, and Upgrade Beta and approve opens Beta's upgrade dialog here; paid, the page approves by itself", async () => {
  let betaPlan: "free" | "pro" = "free";
  const { posts } = stubApi({
    get: (url) => (url === "/server-connect-requests/r-1" ? { data: request({ atLimit: true, canUpgrade: true, owners: OWNERS }) }
      : url === "/billing/subscription" ? { data: betaBilling(betaPlan) } : httpError(404)),
    post: (url) => (url === "/server-connect-requests/r-1/approve" ? { status: 200, data: { state: "connected", serverId: "s-beta", channelId: "c-beta-launch" } } : httpError(500)),
  });
  const { toasts } = renderAt("/server-connect-requests/r-1", MEI, "owner");

  await screen.findByTestId("connect-request-pending");
  assert.equal(screen.getByTestId("connect-request-limit").textContent, "Beta's Free plan allows 1 external channel. Upgrade to approve.");
  assert.ok(screen.queryByRole("button", { name: "Approve" }) === null, "no plain Approve");
  assert.ok(screen.getByRole("button", { name: "Decline" }));
  await click(screen.getByRole("button", { name: "Upgrade Beta and approve" }));
  assert.deepEqual(posts.filter((call) => call.url.startsWith("/server-connect-requests")), [], "nothing approved yet");
  const request0 = useUpgradeDialogStore.getState().request;
  assert.equal(request0?.serverId, "s-beta");
  assert.equal(request0?.surface, "connect_request_page");
  assert.deepEqual(request0?.externalContext, { kind: "connect", channel: "#launch" });
  assert.ok(await screen.findByRole("heading", { name: "Connect Beta to #launch" }));

  // Paying in another window (Raft Desktop's browser): the page reads Beta's plan while it waits.
  act(() => useUpgradeDialogStore.getState().setStage("paying"));
  betaPlan = "pro";
  await returnToWindow();
  await screen.findByTestId("connect-request-connected");
  assert.deepEqual(posts.map((call) => call.url).filter((url) => url.startsWith("/server-connect-requests")), ["/server-connect-requests/r-1/approve"], "approved once");
  assert.equal(toasts[0]?.title, "Beta is on Pro");
  assert.ok(screen.queryByTestId("upgrade-dialog") === null);
});

test("E: back from Stripe the page approves once Beta is Pro, landing in the existing connecting state", async () => {
  let betaPlan: "free" | "pro" = "free";
  const { posts } = stubApi({
    get: (url) => (url === "/server-connect-requests/r-1" ? { data: request({ atLimit: true, canUpgrade: true, owners: OWNERS }) }
      : url === "/billing/subscription" ? { data: betaBilling(betaPlan) } : httpError(404)),
    post: (url) => (url === "/server-connect-requests/r-1/approve" ? { status: 202, data: { state: "connecting" } } : httpError(500)),
  });
  // Pressed "Upgrade Beta and approve" in this tab before going to Stripe.
  window.sessionStorage.setItem("raft.upgradeAndApprove.r-1", "s-beta");
  renderAt("/server-connect-requests/r-1?upgrade=external_channel_free_limit&upgradeSurface=connect_request_page&upgradeServer=s-beta", MEI, "owner");
  const dialog = await screen.findByTestId("upgrade-dialog");
  assert.ok(within(dialog).getByTestId("upgrade-dialog-waiting"));
  assert.ok(within(dialog).getByRole("heading", { name: "Connect Beta to #launch" }));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/server-connect-requests/r-1"));
  assert.deepEqual(posts.map((call) => call.url), [], "not before Beta is Pro");

  betaPlan = "pro";
  await returnToWindow();
  await screen.findByTestId("connect-request-connecting");
  assert.deepEqual(posts.map((call) => call.url).filter((url) => url.startsWith("/server-connect-requests")), ["/server-connect-requests/r-1/approve"]);
  assert.equal(window.sessionStorage.getItem("raft.upgradeAndApprove.r-1"), null, "the marker is used once");
});

// Warden, #14553 review: the requester knows the request id and could send a
// link with Stripe's return parameters naming any server the approver already
// pays for; opening it must approve nothing.
test("E: a crafted return link never approves on load: not without this tab's Upgrade and approve, not for another server, not after a cancel", async () => {
  const { posts } = stubApi({
    get: (url) => (url === "/server-connect-requests/r-1" ? { data: request({ atLimit: true, canUpgrade: true, owners: OWNERS }) }
      : url === "/billing/subscription" ? { data: betaBilling("pro") } : httpError(404)),
    post: () => ({ status: 200, data: { state: "connected", serverId: "s-beta", channelId: "c-beta-launch" } }),
  });
  const approvals = () => posts.filter((call) => call.url.startsWith("/server-connect-requests"));
  for (const query of [
    "upgrade=external_channel_free_limit&upgradeServer=s-beta",
    "upgrade=external_channel_free_limit&upgradeCanceled=1&upgradeServer=s-beta",
    "upgrade=external_channel_free_limit&upgradeServer=s-gamma",
  ]) {
    renderAt(`/server-connect-requests/r-1?${query}`, MEI, "owner");
    await screen.findByTestId("connect-request-pending");
    await returnToWindow();
    assert.deepEqual(approvals(), [], `${query}: nothing approved`);
    cleanup();
    useUpgradeDialogStore.setState({ request: null });
  }
  // A marker for another server doesn't count either.
  window.sessionStorage.setItem("raft.upgradeAndApprove.r-1", "s-gamma");
  renderAt("/server-connect-requests/r-1?upgrade=external_channel_free_limit&upgradeServer=s-beta", MEI, "owner");
  await screen.findByTestId("connect-request-pending");
  await returnToWindow();
  assert.deepEqual(approvals(), [], "a marker for another server: nothing approved");
});

test("E: an admin can't approve until an owner upgrades (named when the server says who); Decline still works", async () => {
  const { posts } = stubApi({
    get: (url) => (url === "/server-connect-requests/r-1" ? { data: request({ atLimit: true, canUpgrade: false, owners: OWNERS }) } : httpError(404)),
    post: (url) => (url === "/server-connect-requests/r-1/reject" ? { data: { status: "rejected" } } : httpError(500)),
  });
  renderAt("/server-connect-requests/r-1", RAJ, "admin");
  await screen.findByTestId("connect-request-pending");
  assert.equal(
    screen.getByTestId("connect-request-limit").textContent,
    "Beta's Free plan allows 1 external channel. An owner of Beta (Mei Chen) needs to upgrade first.",
  );
  const approve = screen.getByRole("button", { name: "Approve" });
  assert.ok(isDisabled(approve), "Approve can't be pressed");
  assert.ok(screen.queryByRole("button", { name: /Upgrade/ }) === null);
  await click(approve);
  assert.deepEqual(posts, []);
  await click(screen.getByRole("button", { name: "Decline" }));
  assert.deepEqual(posts.map((call) => call.url), ["/server-connect-requests/r-1/reject"]);
  cleanup();

  stubApi({ get: (url) => (url === "/server-connect-requests/r-1" ? { data: request({ atLimit: true, canUpgrade: false }) } : httpError(404)) });
  renderAt("/server-connect-requests/r-1", RAJ, "admin");
  await screen.findByTestId("connect-request-pending");
  assert.equal(screen.getByTestId("connect-request-limit").textContent, "Beta's Free plan allows 1 external channel. An owner of Beta needs to upgrade first.");
});

test("E: an older server (no limit fields) shows Approve as before, with no line", async () => {
  stubApi({ get: (url) => (url === "/server-connect-requests/r-1" ? { data: request({}, { canApprove: undefined }) } : httpError(404)) });
  renderAt("/server-connect-requests/r-1", MEI, "owner");
  await screen.findByTestId("connect-request-pending");
  assert.ok(screen.queryByTestId("connect-request-limit") === null);
  assert.ok(!isDisabled(screen.getByRole("button", { name: "Approve" })));
  assert.ok(screen.queryByRole("button", { name: /Upgrade/ }) === null);
});
