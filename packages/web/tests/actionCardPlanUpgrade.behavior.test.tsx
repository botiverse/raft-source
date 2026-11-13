import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createIntl } from "react-intl";
import { buildActionCardPresentation, buildActionCardSpec } from "@botiverse/raft-shared";
import type { ActionCardMetadata, UpgradeGate } from "@botiverse/raft-shared";
import { resetActionCardShownForTest } from "../src/analytics/actionCards";
import * as analytics from "../src/analytics/track";
import api from "../src/api/client";
import LocalizedToastProvider from "../src/components/LocalizedToastProvider";
import { ActionCard } from "../src/components/actions/ActionCard";
import UpgradeDialogHost from "../src/components/billing/UpgradeDialog";
import { upgradeGateCopy } from "../src/components/billing/upgradeGateCopy";
import { en } from "../src/i18n/messages/en";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { resetServerFeatureFlagsForTests, resolveServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { openUpgradeDialog, useUpgradeDialogStore } from "../src/store/upgradeDialogStore";
import { TestIntlProvider } from "./helpers/intl";

// An agent's upgrade card (`plan:upgrade`, task #6), drawn from the spec the
// server built: the fixed title "Upgrade to Pro", the agent's reason as plain
// text, the upgrade dialog's note for the limit hit (none without a gate:
// `general`), and a button (no property table: it executes nothing) that opens
// that dialog for the card's server. Guests and a peer server's copy get no
// button; past Free (plan state is the client frame's, never the spec's) it is
// done: on Pro it reads "Upgraded to Pro", on another paid plan "No longer
// limited by the Free plan".
const channelId = "channel-1";
const messageId = "message-1";
const SERVER_ID = "server-1";

const intl = createIntl({ locale: "en", messages: en });

function member(userId: string, name: string, role: ServerMember["role"]): ServerMember {
  return { userId, name, displayName: name, role, email: null, description: null, avatarUrl: null, joinedAt: "2026-01-01T00:00:00Z" };
}
const OWNER = member("user-owner", "Ava", "owner");
const REASON = "You asked for the launch notes from March, which are older than 30 days.";

function cardMetadata(
  gate: UpgradeGate | null = "history_30d",
  overrides: Partial<ActionCardMetadata> = {},
  reason: string = REASON,
): ActionCardMetadata {
  const action = gate === null ? { type: "plan:upgrade", reason } as const : { type: "plan:upgrade", reason, gate } as const;
  return {
    kind: "action-card",
    sourceServerId: SERVER_ID as ActionCardMetadata["sourceServerId"],
    targetServerName: "Acme",
    state: "prepared",
    confirmationVersion: 1,
    action,
    // As the server sends it: the spec the card renders from.
    presentation: { ...buildActionCardPresentation(action), card: buildActionCardSpec(action, { serverName: "Acme" }) as never },
    ...overrides,
  };
}

function seed(role: ServerMember["role"], { plan = "free", billingPlan }: { plan?: string; billingPlan?: string } = {}) {
  useChannelStore.setState({ channels: [{ id: channelId, name: "general", type: "channel", joined: true, archivedAt: null }], dmChannels: [] } as never);
  useServerStore.setState({
    current: { id: SERVER_ID, slug: "acme", name: "Acme", plan, role, ownerId: OWNER.userId } as Server,
    members: [OWNER],
    billing: billingPlan ? { plan: billingPlan, usage: { humans: 2, agents: 1, universalSeats: 2 } } as never : null,
    loadBilling: async () => {},
    loadMembers: async () => {},
  });
  // Flags already answered, as App has them by the time a card shows: no evaluate request among the posts.
  resolveServerFeatureFlagsForTests(SERVER_ID);
}

function renderCard(metadata: ActionCardMetadata, { withDialog = false } = {}) {
  return render(
    <TestIntlProvider>
      <LocalizedToastProvider>
        <MemoryRouter initialEntries={["/s/acme/c/general"]}>
          <ActionCard messageId={messageId} metadata={metadata} channelId={channelId} />
          {withDialog ? <UpgradeDialogHost /> : null}
        </MemoryRouter>
      </LocalizedToastProvider>
    </TestIntlProvider>,
  );
}

function recordPosts(): string[] {
  const posted: string[] = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string) => {
    posted.push(url);
    return { data: null };
  });
  return posted;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUpgradeDialogStore.setState({ request: null });
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

function notices(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot="message-action-card-notice"]')].map((node) => node.textContent ?? "");
}

test("an unverified AppSumo replacement shows a pending explanation instead of a Stripe offer", async () => {
  seed("owner", { billingPlan: "free" });
  useServerStore.setState({ billing: { plan: "free", source: "server", appsumo: null,
    appsumoBillingReserved: true, usage: { humans: 2, agents: 1, universalSeats: 2 } } as never });
  const posted = recordPosts();
  renderCard(cardMetadata(), { withDialog: true });
  act(() => openUpgradeDialog("history_30d"));
  assert.ok(await screen.findByText(en["billing.appsumoPendingBilling"]));
  assert.equal(screen.queryAllByRole("button", { name: /continue to checkout/i }).length, 0);
  assert.deepEqual(posted, []);
});

test("the card reads Upgrade to Pro, then the agent's reason, then the dialog's note for the limit hit", () => {
  seed("owner");
  for (const gate of ["history_30d", "upload_file_size"] as const) {
    const copy = upgradeGateCopy(intl.formatMessage, gate, "Acme");
    const { container, unmount } = renderCard(cardMetadata(gate));
    const card = within(container);
    // The copy keeps "50 MB" together with a no-break space; the DOM query normalizes it.
    const text = (value: string) => value.replace(/\s+/g, " ");
    // Fixed title (not the dialog's per-limit title), and the button says the same.
    assert.equal(card.getAllByText("Upgrade to Pro").length, 2, `${gate}: title and button`);
    assert.ok(card.queryByText(text(copy.title)) === null, `${gate}: not the dialog's title`);
    const reason = card.getByText(REASON);
    const note = card.getByText(text(copy.hint));
    assert.deepEqual(notices(container).map(text), [text(copy.hint)], `${gate}: Raft's one note is the dialog's line for the limit`);
    assert.ok(reason.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING, `${gate}: the reason comes before the note`);
    assert.ok(card.getByRole("button", { name: "Upgrade to Pro" }));
    // Nothing to execute, so no property table (DS: it holds the values a card runs).
    assert.equal(container.querySelectorAll("dl, dt, dd").length, 0, `${gate}: no property rows`);
    assert.ok(card.queryByText("Pro feature") === null, `${gate}: no Pro feature row`);
    unmount();
  }
  // The function returns the dialog's real copy, not an empty shell.
  assert.deepEqual(upgradeGateCopy(intl.formatMessage, "history_30d", "Acme"), {
    title: "See your whole chat history",
    hint: "On Free, you and your agents can only read the last 30 days of messages, while on Pro all of Acme's history can be read and searched.",
  });
});

test("the agent's reason is plain text: markup and links show as typed, never as HTML or a link", () => {
  seed("owner");
  const reason = "Pro lifts <b>x</b> limits, see https://raft.build/pricing for details.";
  const { container } = renderCard(cardMetadata("history_30d", {}, reason));
  assert.ok(within(container).getByText(reason), "the exact characters, tags included");
  assert.ok(container.querySelector("b") === null, "no bold element from the reason");
  assert.ok(container.querySelector("a") === null, "the URL is not a link");
});

test("without a gate the card has no note, and its button opens the general upgrade dialog", async () => {
  seed("owner");
  recordPosts();
  const reason = "Your team keeps running into Free limits this week.";
  const { container } = renderCard(cardMetadata(null, {}, reason), { withDialog: true });
  const card = within(container);
  assert.equal(card.getAllByText("Upgrade to Pro").length, 2, "title and button");
  assert.ok(card.getByText(reason));
  assert.deepEqual(notices(container), [], "no Raft note without a specific limit");

  fireEvent.click(card.getByRole("button", { name: "Upgrade to Pro" }));
  assert.deepEqual(useUpgradeDialogStore.getState().request, {
    gate: "general",
    stage: "choose",
    serverId: SERVER_ID,
    source: "agent_card",
    cardMessageId: messageId,
  });
  await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Upgrade Acme to Pro" })));
  assert.ok(screen.getByText("Pro lifts the Free limits on chat history, file uploads and Joint Channels."));
  assert.ok(screen.getByTestId("upgrade-dialog-checkout"));

  // `general` named outright reads the same as no gate.
  cleanup();
  const { container: named } = renderCard(cardMetadata("general", {}, reason));
  assert.deepEqual(notices(named), []);
  assert.deepEqual(upgradeGateCopy(intl.formatMessage, "general", "Acme"), {
    title: "Upgrade Acme to Pro",
    hint: "Pro lifts the Free limits on chat history, file uploads and Joint Channels.",
  });
});

test("an owner's press opens the upgrade dialog for the card's server, as an agent card, and runs nothing", async () => {
  seed("owner");
  const posted = recordPosts();
  renderCard(cardMetadata(), { withDialog: true });

  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  assert.deepEqual(useUpgradeDialogStore.getState().request, {
    gate: "history_30d",
    stage: "choose",
    serverId: SERVER_ID,
    source: "agent_card",
    cardMessageId: messageId,
  });
  // The existing dialog: an owner pays there.
  await waitFor(() => assert.ok(screen.getByTestId("upgrade-dialog-checkout")));
  assert.ok(screen.getByRole("dialog", { name: "See your whole chat history" }));
  assert.ok(!posted.some((url) => url.includes("/execute") || url.includes("/mark-executed")), posted.join(", "));
  assert.ok(posted.includes(`/actions/${messageId}/event`), "the open is counted in the card funnel");
});

function recordBodies(): Array<{ url: string; body: unknown }> {
  const sent: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(api, "post").mockImplementation(async (url: string, body?: unknown) => {
    sent.push({ url, body });
    return { data: null };
  });
  return sent;
}

const cardEvents = (sent: Array<{ url: string; body: unknown }>) =>
  sent.filter((entry) => entry.url === `/actions/${messageId}/event`).map((entry) => (entry.body as { eventType: string }).eventType);

test("closing the card's dialog while choosing is the card's dismiss; a paywall's dialog sends no card event", async () => {
  seed("owner");
  const sent = recordBodies();
  renderCard(cardMetadata(), { withDialog: true });

  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => assert.equal(useUpgradeDialogStore.getState().request, null));
  assert.deepEqual(cardEvents(sent), ["action_card.open", "action_card.dismiss"]);

  // A paywall's own dialog (no card) closes without any card event.
  sent.length = 0;
  act(() => openUpgradeDialog("history_30d"));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => assert.equal(useUpgradeDialogStore.getState().request, null));
  assert.ok(!sent.some((entry) => entry.url.startsWith("/actions/")), sent.map((entry) => entry.url).join(", "));
});

test("a member's press opens the same dialog, where they message an owner", async () => {
  seed("member");
  recordPosts();
  renderCard(cardMetadata(), { withDialog: true });

  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
  assert.equal(useUpgradeDialogStore.getState().request?.serverId, SERVER_ID);
  assert.equal(useUpgradeDialogStore.getState().request?.source, "agent_card");
  await waitFor(() => assert.ok(screen.getByTestId("upgrade-dialog-ask-owner")));
  assert.ok(screen.queryByTestId("upgrade-dialog-checkout") === null, "only an owner pays");
});

test("a member who messages an owner from the card's dialog records no dismiss", async () => {
  seed("member");
  const sent = recordBodies();
  const { openUserDM } = useChannelStore.getState();
  const { sendMessage } = useMessageStore.getState();
  useChannelStore.setState({ openUserDM: async (userId: string) => ({ id: `dm-${userId}` }) as never });
  useMessageStore.setState({
    sendMessage: async () => ({ messageId: "m-1", pendingMentionActions: [], unresolvedMentionHandles: [], deliveryWarnings: [] }) as never,
  });
  try {
    renderCard(cardMetadata(), { withDialog: true });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to Ava" }));
    await waitFor(() => assert.equal(useUpgradeDialogStore.getState().request, null));
    assert.deepEqual(cardEvents(sent), ["action_card.open"], "sending to an owner is not a decline");
  } finally {
    useChannelStore.setState({ openUserDM });
    useMessageStore.setState({ sendMessage });
  }
});

test("a guest sees the card, without a button", () => {
  seed("guest");
  renderCard(cardMetadata());

  assert.ok(screen.getByText("Upgrade to Pro"));
  assert.ok(screen.getByText("View only"));
  assert.ok(screen.getByText("Guests can't run channel actions."));
  fireEvent.click(screen.getByRole("button", { name: "Show or hide details" }));
  assert.ok(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, "no button, folded or open");
});

test("a peer server's copy (a card from before shared channels refused it) shows no button, and isn't judged by the viewer's plan", () => {
  // The viewer's server is on Pro: a peer's card still reads View only, never Done / Upgraded to Pro.
  seed("owner", { plan: "pro" });
  renderCard(cardMetadata("history_30d", { sourceServerId: "server-peer" as ActionCardMetadata["sourceServerId"], targetServerName: "Peer Co" }));
  assert.ok(screen.getByText("View only"));
  assert.ok(screen.queryByText("Done") === null && screen.queryByText("Upgraded to Pro") === null);
  fireEvent.click(screen.getByRole("button", { name: "Show or hide details" }));
  assert.ok(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, "no path to the other server's upgrade dialog");
});

// Past Free the card is still drawn from its spec: the frame takes the plan
// state from the client (nothing is stored on the card).
const isSpecCard = (container: HTMLElement) => container.querySelector("[data-action-card-spec='action-card.v1']") !== null;
const statusLine = (container: HTMLElement) => container.querySelector("[data-action-card-status-line]")?.textContent ?? null;
const collapseTrigger = () => screen.getByRole("button", { name: "Show or hide details" });

/** Every observed card is fully on screen at once (jsdom has no layout), and `action_card_shown` is recorded, not sent. */
function recordShownCards(): { shown: () => unknown[]; restore: () => void } {
  class OnScreenObserver {
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = OnScreenObserver as unknown as typeof IntersectionObserver;
  resetActionCardShownForTest();
  const track = vi.spyOn(analytics, "trackEvent").mockImplementation(() => {});
  return {
    shown: () => track.mock.calls.filter(([event]) => event === "action_card_shown").map(([, props]) => props),
    restore: () => {
      globalThis.IntersectionObserver = original;
      resetActionCardShownForTest();
    },
  };
}

test("a card past Free renders from its spec: Done, the plan's done line, folded, no button", () => {
  const cases = [
    { paid: { plan: "pro" }, line: "Upgraded to Pro" },
    // Billing first, as the paywalls read it.
    { paid: { plan: "free", billingPlan: "pro" }, line: "Upgraded to Pro" },
    // A paid plan that is not Pro: Free no longer limits it, not "Pro".
    { paid: { plan: "founder" }, line: "No longer limited by the Free plan" },
    { paid: { plan: "free", billingPlan: "partner" }, line: "No longer limited by the Free plan" },
  ];
  for (const { paid, line } of cases) {
    const label = JSON.stringify(paid);
    seed("owner", paid);
    const { container, unmount } = renderCard(cardMetadata());
    assert.equal(isSpecCard(container), true, `${label}: the spec frame`);
    assert.ok(screen.getByText("Done"), `${label}: status`);
    assert.equal(statusLine(container), line, `${label}: done line`);
    assert.equal(collapseTrigger().getAttribute("aria-expanded"), "false", `${label}: folded`);
    // Opened, the body is the record (the agent's reason, Raft's note), without its button.
    fireEvent.click(collapseTrigger());
    assert.equal(collapseTrigger().getAttribute("aria-expanded"), "true", `${label}: opens`);
    assert.ok(within(container).getByText(REASON), `${label}: the reason stays`);
    assert.equal(within(container).getAllByText("Upgrade to Pro").length, 1, `${label}: the title only`);
    assert.ok(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, `${label}: no button`);
    assert.ok(container.querySelector('[data-slot="message-action-card-actions"]') === null, `${label}: no actions row`);
    unmount();
    resetServerFeatureFlagsForTests();
  }
});

test("a spec card past Free is not counted as actionable; back on Free it gets its button back and is", async () => {
  seed("owner", { plan: "pro" });
  const sent = recordBodies();
  const shownCards = recordShownCards();
  try {
    const { container } = renderCard(cardMetadata(), { withDialog: true });
    assert.equal(isSpecCard(container), true);
    assert.equal(statusLine(container), "Upgraded to Pro");
    assert.deepEqual(shownCards.shown(), [], "past Free: not in the funnel");

    // The server goes back to Free (the plan is read live; nothing was stored on the card).
    act(() => {
      useServerStore.setState({ current: { ...useServerStore.getState().current!, plan: "free" } });
    });
    assert.equal(isSpecCard(container), true, "still the spec frame");
    assert.ok(screen.queryByText("Done") === null, "no status: waiting again");
    assert.equal(statusLine(container), null, "no done line");
    assert.deepEqual(shownCards.shown(), [{ action_type: "plan:upgrade" }], "on Free: counted as actionable");
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    assert.deepEqual(useUpgradeDialogStore.getState().request, {
      gate: "history_30d", stage: "choose", serverId: SERVER_ID, source: "agent_card", cardMessageId: messageId,
    });
    await waitFor(() => assert.ok(screen.getByTestId("upgrade-dialog-checkout")));
    assert.deepEqual(cardEvents(sent), ["action_card.open"]);
  } finally {
    shownCards.restore();
  }
});

test("a spec card: the plan leaving Free while the card is on screen takes its button away", () => {
  seed("owner");
  const { container } = renderCard(cardMetadata());
  assert.equal(isSpecCard(container), true);
  assert.ok(screen.getByRole("button", { name: "Upgrade to Pro" }));
  act(() => {
    useServerStore.setState({ current: { ...useServerStore.getState().current!, plan: "pro" } });
  });
  assert.equal(isSpecCard(container), true, "still the spec frame");
  assert.ok(screen.getByText("Done"));
  assert.equal(statusLine(container), "Upgraded to Pro");
  assert.ok(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null);
});

test("a card with no spec that reads shows its neutral envelope, view-only, without crashing", () => {
  seed("owner");
  // A type this web does not know, with only the server's presentation (no spec it can read).
  const metadata = cardMetadata("history_30d");
  renderCard({
    ...metadata,
    action: { type: "plan:upgrade_from_the_future", reason: REASON, gate: "history_30d" } as unknown as ActionCardMetadata["action"],
    presentation: { ...metadata.presentation!, card: undefined },
  });
  assert.ok(screen.getByText("Upgrade to Pro"));
  assert.ok(screen.getByText("View only"));
  assert.ok(screen.getByText("Reload the page to see this request."));
  const buttons = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
  assert.deepEqual(buttons, ["Show or hide details"]);
});
