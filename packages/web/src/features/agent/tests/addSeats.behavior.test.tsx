import "../../../../tests/helpers/domSetup";

import assert from "node:assert/strict";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PRO_SEAT_ADD_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY, getCreatableRuntimeOptions } from "@botiverse/raft-shared";
import api from "../../../api/client";
import AddSeatsDialog from "../../../components/billing/AddSeatsDialog";
import type { AddSeatsNeed } from "../../../components/billing/AddSeatsDialog";
import { CreateAgentDialog } from "../CreateAgentDialog";
import InviteHumanDialog from "../../../components/member/InviteHumanDialog";
import HumanDetailPanel from "../../../components/member/HumanDetailPanel";
import type { HumanProfile } from "../../../components/member/HumanDetailPanel";
import { resetPaywallShownForTest } from "../../../analytics/paywall";
import { useAgentStore } from "../../../store/agentStore";
import { useAuthStore } from "../../../store/authStore";
import { useChannelStore } from "../../../store/channelStore";
import { useMachineStore } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import type { BillingInfo } from "../../../store/serverStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../../../store/serverFeatureFlags";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { registerShortcutHandler } from "../../shortcuts/dispatcher";
import { minimalRuntimeFormV2Response, RUNTIME_FORM_V2_MARKER } from "../../../../tests/helpers/runtimeFormV2";

/**
 * Adding Pro seats in place (task #10, #proj-commercial; design
 * pro-seat-limit-states v15). When Create Agent, Invite or Guest → member runs
 * out of seats, an owner adds them in the upgrade dialog's frame and the action
 * carries on once Stripe's change lands in billing. Behind `pro_seat_add`.
 */

// The dialog asks Stripe for a price 300 ms after the count settles, then
// renders; on a loaded CI runner that takes longer than waitFor's 1 s default.
configure({ asyncUtilTimeout: 5_000 });

const originalGet = api.get;
const originalPost = api.post;
const originalServerState = useServerStore.getState();
const originalOpen = window.open;

/** A Pro server with 4 seats: 3 people and 10 agents take all of them. */
function proBilling(seats = 4, humans = 3, agents = 10): BillingInfo {
  return {
    plan: "pro", displayName: "Pro", serverPlan: "pro", source: "subscription",
    capacity: { maxHumans: -1, maxAgents: -1, maxUniversalSeats: seats },
    usage: { humans, agents, universalSeats: humans + agents / 10 },
    provisioned: { humans: 0, agents: 0, proPackQuantity: seats, trialFreePackQuantity: 0 },
    price: null,
    subscription: { status: "active", billingInterval: "monthly", currentPeriodEnd: "2026-11-20T00:00:00.000Z" },
    stripeConfigured: true,
    permissions: { canReadBillingSummary: true, canManageBilling: true },
  } as never;
}

function seedServer(role: "owner" | "admin", billing: BillingInfo | null = proBilling()) {
  useServerStore.setState({
    current: { id: "server-1", name: "Lumen Studio", slug: "lumen", avatarUrl: null, ownerId: "owner-1", onboardingAgentId: null, hideHumansFromMembers: false, plan: "pro", planDowngradedAt: null, role, createdAt: "2026-07-14T00:00:00.000Z" },
    members: [],
    billing,
    loadBilling: async () => undefined,
  } as never);
}

/** Stripe adds the seats: the webhook reloads billing with the new count. */
function seatsLand(seats: number) {
  act(() => {
    const billing = useServerStore.getState().billing!;
    useServerStore.setState({ billing: { ...billing, capacity: { ...billing.capacity, maxUniversalSeats: seats } } });
  });
}

/** The same reload outside act: from a request's own promise, as the app's socket does. */
function seatsLandQuietly(seats: number) {
  const billing = useServerStore.getState().billing!;
  useServerStore.setState({ billing: { ...billing, capacity: { ...billing.capacity, maxUniversalSeats: seats } } });
}

type Post = { url: string; body?: Record<string, unknown> };

/** Billing posts: a price per count, and the update answers `update`. */
function stubBilling(update: Record<string, unknown> = { status: "pending_webhook" }, other?: (post: Post) => unknown, onUpdate?: () => void): Post[] {
  const posts: Post[] = [];
  api.post = (async (url: string, body?: Record<string, unknown>) => {
    posts.push({ url, body });
    if (url === "/billing/seat-pack-quantity/preview") {
      const added = Number(body?.seatQuantity) - 4;
      return { data: { status: "preview", currency: "usd", prorationAmount: 645 * added, recurringAmount: 2000 * (4 + added), previewToken: `token-${String(body?.seatQuantity)}` } };
    }
    if (url === "/billing/seat-pack-quantity") {
      onUpdate?.();
      return { data: update };
    }
    return other ? { data: other({ url, body }) } : { data: {} };
  }) as never;
  return posts;
}

const AGENT_NEED: AddSeatsNeed = {
  tenths: 1,
  label: "Scout × 0.1",
  title: "Creating Scout needs 1 more seat",
  hint: "All 4 seats on Lumen Studio are taken.",
  resume: "Then Scout is created.",
  gate: "seat_limit_agent_create",
};

function renderDialog(need = AGENT_NEED) {
  let added = 0;
  render(
    <TestIntlProvider locale="en">
      <AddSeatsDialog need={need} onClose={() => undefined} onAdded={() => { added += 1; }} />
    </TestIntlProvider>,
  );
  return { added: () => added };
}

const commitButton = () => screen.getByTestId("add-seats-dialog-commit");

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  window.open = originalOpen;
  useServerStore.setState(originalServerState, true);
  useAuthStore.setState({ user: null } as never);
  resetServerFeatureFlagsForTests();
  resetPaywallShownForTest();
});

test("the dialog shows why the seats ran out and adds just enough by default, priced by Stripe", async () => {
  seedServer("owner");
  const posts = stubBilling();
  renderDialog();

  const sum = screen.getByTestId("add-seats-dialog-sum").textContent ?? "";
  assert.match(sum, /4 seats/);
  assert.match(sum, /3 people × 1/);
  assert.match(sum, /10 agents × 0\.1/);
  assert.match(sum, /4\/4/);
  assert.match(screen.getByTestId("add-seats-dialog-overflow").textContent ?? "", /Scout × 0\.1.*4\.1 > 4/);
  assert.equal(screen.getByTestId("add-seats-dialog-seats").textContent, "1");
  assert.equal((screen.getByTestId("add-seats-dialog-seat-remove") as HTMLButtonElement).disabled, true, "never fewer than this action needs");

  await waitFor(() => assert.equal(commitButton().textContent, "Add 1 seat · $6.45"));
  assert.deepEqual(posts.map((post) => post.body?.seatQuantity), [5]);

  fireEvent.click(screen.getByTestId("add-seats-dialog-seat-add"));
  assert.equal(screen.getByTestId("add-seats-dialog-seats").textContent, "2");
  await waitFor(() => assert.equal(commitButton().textContent, "Add 2 seats · $12.90"));
  assert.deepEqual(posts.map((post) => post.body?.seatQuantity), [5, 6]);
});

test("paid: it waits for Stripe's change, then the caller carries on once", async () => {
  seedServer("owner");
  const posts = stubBilling({ status: "pending_webhook" });
  const dialog = renderDialog();
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());

  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog-waiting")));
  const update = posts.find((post) => post.url === "/billing/seat-pack-quantity");
  assert.deepEqual(update?.body, { seatQuantity: 5, previewToken: "token-5", entry: "seat_limit_agent_create" });
  assert.equal(screen.queryByTestId("add-seats-dialog-commit") === null, true, "no button while Stripe has the payment");
  assert.equal(dialog.added(), 0);

  seatsLand(5);
  await waitFor(() => assert.equal(dialog.added(), 1));
  seatsLand(6);
  assert.equal(dialog.added(), 1, "carries on once");
});

test("seats that land before the dialog starts listening still count: it carries on once", async () => {
  seedServer("owner");
  // Billing reloads with the new count while the update is answered, before
  // the waiting dialog subscribes to the store.
  stubBilling({ status: "pending_webhook" }, undefined, () => seatsLandQuietly(5));
  const dialog = renderDialog();
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());

  await waitFor(() => assert.equal(dialog.added(), 1));
  seatsLand(6);
  assert.equal(dialog.added(), 1, "carries on once");
});

test("the bank wants a confirmation: its page opens and the dialog waits with a link back to it", async () => {
  seedServer("owner");
  const opened: string[] = [];
  window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
  stubBilling({ status: "pending_payment", heldPayment: { url: "https://invoice.stripe.com/i/1", action: "authenticate" } });
  const dialog = renderDialog();
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());

  const link = await waitFor(() => screen.getByTestId("add-seats-dialog-bank"));
  assert.deepEqual(opened, ["https://invoice.stripe.com/i/1"]);
  fireEvent.click(link);
  assert.deepEqual(opened, ["https://invoice.stripe.com/i/1", "https://invoice.stripe.com/i/1"], "the link opens the same page again");
  seatsLand(5);
  await waitFor(() => assert.equal(dialog.added(), 1));
});

test("a declined card: the owner pays the held invoice with another card on Stripe's page", async () => {
  seedServer("owner");
  const opened: string[] = [];
  window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
  stubBilling({ status: "pending_payment", heldPayment: { url: "https://invoice.stripe.com/i/2", action: "update_payment_method" } });
  renderDialog();
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());

  const link = await waitFor(() => screen.getByTestId("add-seats-dialog-declined"));
  assert.deepEqual(opened, [], "nothing opens by itself for a declined card");
  fireEvent.click(link);
  assert.deepEqual(opened, ["https://invoice.stripe.com/i/2"]);
  assert.match(screen.getByTestId("add-seats-dialog-waiting").textContent ?? "", /declined/);
});

// --- Create Agent -----------------------------------------------------------

function seedCreateAgent() {
  useMachineStore.setState({
    machines: [{ id: "machine-1", name: "Mac", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null, runtimes: ["cursor"], hostname: "mac.local", os: "darwin", daemonVersion: "0.72.6", lastHeartbeat: "2026-07-14T00:00:00.000Z", createdAt: "2026-07-14T00:00:00.000Z" }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  api.get = (async (url: string) => url.endsWith("/runtime-options")
    ? { data: { context: "new_agent", machineId: "machine-1", options: getCreatableRuntimeOptions().filter((r) => r.id !== "grok").map((r) => ({ runtimeId: r.id, capabilityStatus: r.id === "cursor" ? "available" : "not_installed", admissionStatus: "available_for_new", admissionReason: null, current: false, availableForNew: true, manageableForCurrentAgent: false, canSelectInThisContext: r.id === "cursor", ...RUNTIME_FORM_V2_MARKER })) } }
    : minimalRuntimeFormV2Response(url) ?? { data: { models: [{ id: "auto", label: "Auto" }] } }) as never;
}

function renderCreateAgent() {
  render(
    <MemoryRouter initialEntries={["/s/lumen"]}>
      <TestIntlProvider locale="en">
        <CreateAgentDialog prefilledName="scout" onClose={() => undefined} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

/** Create Agent is a heavy dialog: on a cold, loaded CI runner one step can take several seconds. */
const SLOW = { timeout: 15_000 };

const createButton = () => screen.getAllByRole("button").find((el) => (el.textContent ?? "").trim() === "Create");

test("Create Agent on a full Pro server: an owner adds a seat, then the agent is created", async () => {
  seedServer("owner");
  seedCreateAgent();
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  const posts = stubBilling({ status: "pending_webhook" }, () => ({ id: "agent-1", name: "scout" }));
  renderCreateAgent();

  await waitFor(() => assert.ok(screen.getByText("4/4 seats used; creating needs 1 more seat.")), SLOW);
  assert.equal([...document.querySelectorAll('[data-slot="banner"]')].some((el) => /limit reached/i.test(el.textContent ?? "")), false, "no at-limit notice for an owner");
  const create = await waitFor(() => {
    const button = createButton();
    assert.ok(button && !(button as HTMLButtonElement).disabled, "Create stays enabled");
    return button;
  }, SLOW);
  fireEvent.click(create);

  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog")), SLOW);
  assert.equal(posts.some((post) => post.url === "/agents"), false, "nothing is created before the seat counts");
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false), SLOW);
  fireEvent.click(commitButton());
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog-waiting")), SLOW);

  seatsLand(5);
  await waitFor(() => assert.ok(posts.some((post) => post.url === "/agents")), SLOW);
  assert.equal(screen.queryByTestId("add-seats-dialog") === null, true);
});

test("Create Agent with the flag off keeps the at-limit notice and a disabled Create", async () => {
  seedServer("owner");
  seedCreateAgent();
  renderCreateAgent();
  await waitFor(() => assert.ok([...document.querySelectorAll('[data-slot="banner"]')].some((el) => /limit reached/i.test(el.textContent ?? ""))));
  assert.equal(screen.queryByText(/seats used/) === null, true);
  assert.equal((createButton() as HTMLButtonElement | undefined)?.disabled, true);
});

// --- Invite -----------------------------------------------------------------

function renderInvite() {
  api.get = (async () => ({ data: [{ id: "link-1", token: "join-token" }] })) as typeof api.get;
  render(
    <MemoryRouter initialEntries={["/s/lumen"]}>
      <TestIntlProvider locale="en">
        <InviteHumanDialog onClose={() => undefined} surface="sidebar" />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("Invite: the seats are counted by the people filled in, and the invites go out once they're added", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  const posts = stubBilling({ status: "pending_webhook" }, () => ({ id: "invite-1" }));
  renderInvite();

  assert.ok(screen.getByText("4/4 seats used; each person takes 1 seat."));
  fireEvent.change(screen.getAllByRole("textbox", { name: "Email address" })[0]!, { target: { value: "grace@lumen.studio" } });
  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  fireEvent.change(screen.getAllByRole("textbox", { name: "Email address" })[1]!, { target: { value: "alan@lumen.studio" } });
  assert.ok(screen.getByText("4/4 seats used; inviting these 2 people needs 2 more seats."));

  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog")));
  assert.equal(screen.getByTestId("add-seats-dialog-seats").textContent, "2");
  assert.equal(posts.some((post) => post.url.includes("/invites")), false);
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog-waiting")));

  seatsLand(6);
  await waitFor(() => assert.deepEqual(
    posts.filter((post) => post.url.includes("/invites")).map((post) => post.body?.email),
    ["grace@lumen.studio", "alan@lumen.studio"],
  ));
});

test("Invite link with the seats full: the notice says no one gets in yet, and an owner can add a seat", async () => {
  seedServer("owner");
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  stubBilling();
  renderInvite();
  fireEvent.click(screen.getByTestId("invite-tab-link"));

  const notice = screen.getByTestId("invite-link-seats-full");
  assert.match(notice.textContent ?? "", /Lumen Studio has no free seats/);
  fireEvent.click(screen.getByTestId("invite-link-add-seats"));
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog")));
  assert.equal(screen.getByTestId("add-seats-dialog-seats").textContent, "1");
});

test("Invite as an admin on full seats: Invite asks an owner for the seats instead of sending", async () => {
  seedServer("admin");
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  const posts = stubBilling();
  renderInvite();
  fireEvent.change(screen.getAllByRole("textbox", { name: "Email address" })[0]!, { target: { value: "grace@lumen.test" } });
  const invite = screen.getByRole("button", { name: "Invite" }) as HTMLButtonElement;
  assert.equal(invite.disabled, false);
  fireEvent.click(invite);
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog-ask-owner")));
  assert.equal(posts.some((post) => post.url.includes("/invites")), false, "nothing sent before the seats are added");
});

// --- Guest → member ---------------------------------------------------------

function guest(): HumanProfile {
  return {
    userId: "user-grace", serverId: "server-1", serverName: "Lumen Studio", serverSlug: "lumen",
    email: "grace@lumen.studio", name: "grace", displayName: "Grace Hopper",
    description: null, avatarUrl: null, role: "guest", joinedAt: "2026-07-14T00:00:00.000Z",
    membershipStatus: "active", createdAgents: [],
  };
}

test("Guest → member with the seats full: an owner adds the seat, then the picked role is saved", async () => {
  seedServer("owner", null);
  useAuthStore.setState({ user: { id: "owner-1", name: "ada" }, loading: false, initialized: true } as never);
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  stubBilling();
  const saves: string[] = [];
  useServerStore.setState({
    loadBilling: async () => { useServerStore.setState({ billing: proBilling() }); },
    updateMemberRole: async (_userId: string, role: string) => {
      saves.push(role);
      if (saves.length === 1) {
        throw { response: { status: 409, data: { error: "Seat limit reached (4/4 on Pro plan).", code: "human_seat_limit_reached", capacityLimit: { limitType: "universal", limit: 4, usage: 4, nextUsage: 5, humans: 3, agents: 10 } } } };
      }
    },
  } as never);
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <HumanDetailPanel human={guest()} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  // Editing opens the role picker; the picked role applies at once.
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  fireEvent.click(await screen.findByText("Member"));

  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog")));
  assert.match(screen.getByTestId("add-seats-dialog-overflow").textContent ?? "", /Grace Hopper × 1.*5 > 4/);
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog-waiting")));

  seatsLand(5);
  await waitFor(() => assert.deepEqual(saves, ["member", "member"]));
});

// --- Review cases -----------------------------------------------------------

test("a refused commit prices the count again, and the next try sends the fresh token", async () => {
  seedServer("owner");
  const posts: Post[] = [];
  let previews = 0;
  let commits = 0;
  api.post = (async (url: string, body?: Record<string, unknown>) => {
    posts.push({ url, body });
    if (url === "/billing/seat-pack-quantity/preview") {
      previews += 1;
      return { data: { currency: "usd", prorationAmount: 645, recurringAmount: 10000, previewToken: `token-${previews}` } };
    }
    commits += 1;
    if (commits === 1) throw { response: { data: { error: "Seat update preview expired" } } };
    return { data: { status: "pending_webhook" } };
  }) as never;
  renderDialog();
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());

  await waitFor(() => assert.ok(screen.getByText("Seat update preview expired")));
  await waitFor(() => assert.equal(previews, 2));
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog-waiting")));
  assert.deepEqual(posts.filter((post) => post.url === "/billing/seat-pack-quantity").map((post) => post.body?.previewToken), ["token-1", "token-2"]);
});

test("a failed price can be asked for again", async () => {
  seedServer("owner");
  let previews = 0;
  api.post = (async () => {
    previews += 1;
    if (previews === 1) throw { response: { status: 429, data: { error: "Too many requests" } } };
    return { data: { currency: "usd", prorationAmount: 645, recurringAmount: 10000, previewToken: "token-2" } };
  }) as never;
  renderDialog();
  fireEvent.click(await screen.findByTestId("add-seats-dialog-preview-retry"));
  await waitFor(() => assert.equal(commitButton().textContent, "Add 1 seat · $6.45"));
  assert.equal(previews, 2);
});

test("the dialog can't be closed while the update is on its way to Stripe", async () => {
  seedServer("owner");
  let release: (value: unknown) => void = () => undefined;
  api.post = ((url: string) => url === "/billing/seat-pack-quantity/preview"
    ? Promise.resolve({ data: { currency: "usd", prorationAmount: 645, recurringAmount: 10000, previewToken: "token-5" } })
    : new Promise((resolve) => { release = resolve; })) as never;
  let closed = 0;
  render(
    <TestIntlProvider locale="en">
      <AddSeatsDialog need={AGENT_NEED} onClose={() => { closed += 1; }} onAdded={() => undefined} />
    </TestIntlProvider>,
  );
  await waitFor(() => assert.equal((commitButton() as HTMLButtonElement).disabled, false));
  fireEvent.click(commitButton());
  await waitFor(() => assert.equal((screen.getByTestId("add-seats-dialog-close") as HTMLButtonElement).disabled, true));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  assert.equal(closed, 0);
  await act(async () => release({ data: { status: "pending_webhook" } }));
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog-waiting")));
});

test("Create Agent's onboarding shell keeps its notice: the add-seats dialog isn't there", async () => {
  seedServer("owner");
  seedCreateAgent();
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  render(
    <MemoryRouter initialEntries={["/s/lumen"]}>
      <TestIntlProvider locale="en">
        <CreateAgentDialog onboarding onboardingShell="step" onClose={() => undefined} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  await waitFor(() => assert.ok([...document.querySelectorAll('[data-slot="banner"]')].some((el) => /limit reached/i.test(el.textContent ?? ""))), SLOW);
  assert.equal(screen.queryByText(/seats used/) === null, true);
  // Once the runtime's form is in, nothing else holds Create back: only the seats do.
  await screen.findByTestId("runtime-form-v2-model", undefined, SLOW);
  const submit = screen.getAllByRole("button").find((el) => /^create( cindy)?$/i.test((el.textContent ?? "").trim()));
  assert.equal((submit as HTMLButtonElement | undefined)?.disabled, true, "its Create stays disabled: there is no add-seats dialog in this shell");
});

test("Invite counts each person once, and every invite takes a seat (no Guest invites, #wg-rbac:#15)", async () => {
  // 3.6 seats used of 2: over, after the seats were reduced.
  seedServer("owner", proBilling(2, 3, 6));
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  const posts = stubBilling({ status: "pending_webhook" }, () => ({ id: "invite-1" }));
  renderInvite();

  const boxes = () => screen.getAllByRole("textbox", { name: "Email address" });
  fireEvent.change(boxes()[0]!, { target: { value: "grace@lumen.studio" } });
  fireEvent.click(screen.getByRole("button", { name: "Add another" }));
  fireEvent.change(boxes()[1]!, { target: { value: "Grace@lumen.studio" } });
  assert.ok(screen.getByText("3.6/2 seats used; inviting this person needs 3 more seats."));

  // No row can be made a Guest to dodge the seat: there is no role control.
  assert.equal(screen.queryAllByRole("combobox", { name: "Role" }).length === 0, true);
  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog")));
  assert.equal(posts.filter((post) => post.url.includes("/invites")).length, 0, "nothing is sent before the seats are added");
});

test("Guest → member with room left but not a whole seat says what's left", async () => {
  seedServer("owner", null);
  useAuthStore.setState({ user: { id: "owner-1", name: "ada" }, loading: false, initialized: true } as never);
  setServerFeatureFlagForTests("server-1", PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  setServerFeatureFlagForTests("server-1", SERVER_GUEST_FEATURE_FLAG_KEY, true);
  stubBilling();
  useServerStore.setState({
    loadBilling: async () => { useServerStore.setState({ billing: proBilling(4, 3, 6) }); },
    updateMemberRole: async () => {
      throw { response: { status: 409, data: { code: "human_seat_limit_reached", capacityLimit: { limitType: "universal", limit: 4, usage: 3.6, nextUsage: 4.6, humans: 3, agents: 6 } } } };
    },
  } as never);
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <HumanDetailPanel human={guest()} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
  fireEvent.click(await screen.findByText("Member"));

  await waitFor(() => assert.ok(screen.getByTestId("add-seats-dialog")));
  assert.ok(screen.getByText("Making Grace Hopper a member needs 1 more seat"));
  assert.ok(screen.getByText(/Lumen Studio has 0\.4 seats left, not enough for Grace Hopper/));
});

test("the dialog is a raft-ui dialog over the page: Esc closes it, a scrim press doesn't, and ⌘K doesn't fire under it", async () => {
  seedServer("owner");
  stubBilling();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  const searches: string[] = [];
  const stop = registerShortcutHandler("search", () => () => { searches.push("search"); });
  let closed = 0;
  try {
    render(
      <TestIntlProvider locale="en">
        <AddSeatsDialog need={AGENT_NEED} onClose={() => { closed += 1; }} onAdded={() => undefined} />
      </TestIntlProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: AGENT_NEED.title });
    assert.match(dialog.className, /\bz-dialog-layer\b/, "layer 1, as before");
    fireEvent.keyDown(dialog, { key: "k", code: "KeyK", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "k", code: "KeyK", ctrlKey: true });
    assert.deepEqual(searches, [], "global search is hidden under the dialog");
    const scrim = document.querySelector("[data-slot=dialog-overlay]") as HTMLElement;
    act(() => {
      fireEvent.pointerDown(scrim);
      fireEvent.mouseDown(scrim);
      fireEvent.pointerUp(scrim);
      fireEvent.mouseUp(scrim);
      fireEvent.click(scrim);
    });
    assert.equal(closed, 0, "a stray click doesn't close it");
    act(() => { fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" }); });
    await waitFor(() => assert.equal(closed, 1));
  } finally {
    stop();
    delete (navigator as { platform?: string }).platform;
  }
});
