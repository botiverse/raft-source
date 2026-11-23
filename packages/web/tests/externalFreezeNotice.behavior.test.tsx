import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createIntl } from "react-intl";
import api from "../src/api/client";
import UpgradeDialogHost from "../src/components/billing/UpgradeDialog";
import { setToastManager } from "../src/components/toastBridge";
import { ExternalFreezeNotice } from "../src/features/channel/ChannelLimitBanners";
import { en } from "../src/i18n/messages/en";
import { resetServerFeatureFlagsForTests, resolveServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useUpgradeDialogStore } from "../src/store/upgradeDialogStore";
import { TestIntlProvider } from "./helpers/intl";

// The Free plan's external channel freeze, before it starts (Warden): the
// notice above the composer has an Upgrade by role, as the frozen banner's
// after it. It opens the upgrade dialog for `external_channel_frozen` with the
// deadline, so the dialog says from when the server can't post, not "again".
const SERVER_ID = "server-1";
const FREEZE_AT = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
const DEADLINE = createIntl({ locale: "en", messages: en }).formatDate(new Date(FREEZE_AT), { dateStyle: "medium", timeStyle: "short" });
const OWNER: ServerMember = { userId: "user-owner", name: "Ava", displayName: "Ava", role: "owner", email: null, description: null, avatarUrl: null, joinedAt: "2026-01-01T00:00:00Z" };

function seed(role: ServerMember["role"], plan = "free") {
  useServerStore.setState({
    current: { id: SERVER_ID, slug: "acme", name: "Acme", plan, role, ownerId: OWNER.userId } as Server,
    members: [OWNER],
    billing: null,
    loadBilling: async () => {},
    loadMembers: async () => {},
  });
  resolveServerFeatureFlagsForTests(SERVER_ID);
  vi.spyOn(api, "post").mockImplementation(async () => ({ data: null }));
}

function renderNotice() {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/c/launch"]}>
        <ExternalFreezeNotice channel={{ externalFreezeAt: FREEZE_AT }} />
        <UpgradeDialogHost />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUpgradeDialogStore.setState({ request: null });
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("an owner's Upgrade to Pro opens the frozen gate's dialog with the deadline, which says from when", async () => {
  seed("owner");
  renderNotice();
  const notice = screen.getByTestId("external-freeze-notice-banner");
  assert.ok(within(notice).getByText(en["message.chatPanel.externalLimitFreezeNotice"].replace("{deadline}", DEADLINE)));
  const button = within(notice).getByTestId("external-freeze-notice-upgrade");
  assert.equal(button.textContent, "Upgrade to Pro");

  fireEvent.click(button);
  const request = useUpgradeDialogStore.getState().request;
  assert.equal(request?.gate, "external_channel_frozen");
  assert.equal(request?.surface, "channel_banner");
  assert.deepEqual(request?.externalContext, { kind: "freeze_upcoming", deadline: FREEZE_AT }, "the raw deadline, formatted where shown");

  const dialog = await screen.findByTestId("upgrade-dialog");
  assert.ok(within(dialog).getByText("Keep posting in your external channels"));
  assert.ok(within(dialog).getByText(`Free allows 1 external channel. From ${DEADLINE}, Acme can't post in its external channels. Upgrade to keep posting in all of them.`));
  assert.ok(within(dialog).queryByText("Post in your external channels again") === null, "not the after-the-freeze title");
});

for (const role of ["admin", "member"] as const) {
  test(`a${role === "admin" ? "n" : ""} ${role} asks an owner, with a message that names the deadline`, async () => {
    seed(role);
    renderNotice();
    const button = screen.getByTestId("external-freeze-notice-upgrade");
    assert.equal(button.textContent, "Ask an owner to upgrade");

    fireEvent.click(button);
    await waitFor(() => assert.ok(screen.getByTestId("upgrade-dialog-ask-owner")));
    assert.equal(
      (screen.getByTestId("upgrade-dialog-message") as HTMLTextAreaElement).value,
      `Acme can't post in its external channels from ${DEADLINE}. Could we upgrade Acme to Pro so we can keep posting in all of them?`,
    );
  });
}

test("off Free the notice's button reads View billing", () => {
  seed("owner", "pro");
  renderNotice();
  assert.equal(screen.getByTestId("external-freeze-notice-upgrade").textContent, "View billing");
});

test("past the deadline there is no notice", () => {
  seed("owner");
  render(
    <TestIntlProvider>
      <MemoryRouter>
        <ExternalFreezeNotice channel={{ externalFreezeAt: new Date(Date.now() - 60_000).toISOString() }} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  assert.ok(screen.queryByTestId("external-freeze-notice-banner") === null, "no notice");
});

// Kirby (#15653): an owner pays on Stripe and comes back by redirect, so the
// freeze's start rides the return address (upgradeFreezeAt) and the dialog the
// return rebuilds still speaks for before the freeze.
type Toast = { title: string; description?: string };

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderReturn(search: string): { toasts: Toast[] } {
  const toasts: Toast[] = [];
  setToastManager({ add: (toast) => { toasts.push({ title: toast.title, description: toast.description }); } });
  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[`/s/acme/c/launch?${search}`]}>
        <UpgradeDialogHost />
        <LocationProbe />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  return { toasts };
}

const OWNER_BILLING = { plan: "free", source: "server", usage: { humans: 2, agents: 1, universalSeats: 2 }, permissions: { canReadBillingSummary: true, canManageBilling: true } };

test("the owner's checkout from the notice carries the freeze's start in both return addresses", async () => {
  seed("owner");
  useServerStore.setState({ billing: OWNER_BILLING as never });
  const bodies: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    bodies.push({ url, body });
    return { data: url === "/billing/checkout" ? { url: "#stripe-checkout" } : null };
  });
  renderNotice();
  fireEvent.click(screen.getByTestId("external-freeze-notice-upgrade"));
  const checkoutButton = await screen.findByTestId("upgrade-dialog-checkout");
  await waitFor(() => assert.ok(!checkoutButton.hasAttribute("disabled") && checkoutButton.getAttribute("aria-disabled") !== "true", "checkout ready"));
  await act(async () => { fireEvent.click(checkoutButton); });
  await waitFor(() => assert.ok(bodies.some((call) => call.url === "/billing/checkout")));
  const body = bodies.find((call) => call.url === "/billing/checkout")?.body as { successUrl: string; cancelUrl: string };
  for (const address of [body.successUrl, body.cancelUrl]) {
    const url = new URL(address);
    assert.equal(url.searchParams.get("upgrade"), "external_channel_frozen");
    assert.equal(url.searchParams.get("upgradeFreezeAt"), FREEZE_AT);
  }
});

test("back from a payment made before the freeze, the paid toast says the server keeps posting, and the address is clean", async () => {
  seed("owner");
  const { toasts } = renderReturn(`upgrade=external_channel_frozen&upgradeSurface=channel_banner&upgradeFreezeAt=${encodeURIComponent(FREEZE_AT)}`);
  await waitFor(() => assert.equal(useUpgradeDialogStore.getState().request?.stage, "confirming"));
  assert.deepEqual(useUpgradeDialogStore.getState().request?.externalContext, { kind: "freeze_upcoming", deadline: FREEZE_AT });
  assert.equal(screen.getByTestId("location").textContent, "/s/acme/c/launch", "every return parameter dropped");

  act(() => useServerStore.setState({ current: { ...useServerStore.getState().current!, plan: "pro" } }));
  await waitFor(() => assert.equal(toasts.length, 1));
  assert.equal(toasts[0].description, "Acme can keep posting in all its external channels.");
});

test("back from a cancelled checkout before the freeze, the dialog reopens in the words for before it", async () => {
  seed("owner");
  useServerStore.setState({ billing: OWNER_BILLING as never });
  renderReturn(`upgrade=external_channel_frozen&upgradeCanceled=1&upgradeSurface=channel_banner&upgradeFreezeAt=${encodeURIComponent(FREEZE_AT)}`);
  const dialog = await screen.findByTestId("upgrade-dialog");
  assert.ok(within(dialog).getByText("Keep posting in your external channels"));
  assert.ok(within(dialog).getByText(`Free allows 1 external channel. From ${DEADLINE}, Acme can't post in its external channels. Upgrade to keep posting in all of them.`));
  assert.equal(screen.getByTestId("location").textContent, "/s/acme/c/launch");
});

test("a frozen gate's return without the freeze's start (or with a bad one) keeps the gate's own words", async () => {
  for (const extra of ["", "&upgradeFreezeAt=not-a-date"]) {
    seed("owner");
    useServerStore.setState({ billing: OWNER_BILLING as never });
    const { toasts } = renderReturn(`upgrade=external_channel_frozen&upgradeCanceled=1${extra}`);
    const dialog = await screen.findByTestId("upgrade-dialog");
    assert.ok(within(dialog).getByText("Post in your external channels again"), extra || "no param");
    assert.equal(useUpgradeDialogStore.getState().request?.externalContext, undefined);
    assert.equal(screen.getByTestId("location").textContent, "/s/acme/c/launch");

    act(() => useUpgradeDialogStore.setState({ request: { ...useUpgradeDialogStore.getState().request!, stage: "confirming" } }));
    act(() => useServerStore.setState({ current: { ...useServerStore.getState().current!, plan: "pro" } }));
    await waitFor(() => assert.equal(toasts.length, 1));
    assert.equal(toasts[0].description, "Acme can post in all its external channels again.");
    cleanup();
    useUpgradeDialogStore.setState({ request: null });
    vi.restoreAllMocks();
  }
});
