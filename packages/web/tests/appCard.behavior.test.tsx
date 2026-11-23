import assert from "node:assert/strict";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createIntl } from "react-intl";
import { renderWithIntl } from "./helpers/intl";
import { AppCard, AppCardSkeleton } from "../src/features/apps/AppCard";
import type { AppCardAction, AppCardProps } from "../src/features/apps/AppCard";
import { appCardSourceParts } from "../src/features/apps/appCardSource";
import type { AppView } from "../src/features/apps/appView";
import { mergedMessages } from "../src/i18n/messages";

// The redesigned App card (features/apps/AppCard.tsx): what each state and
// variant shows from an AppView, which press calls which callback, and the
// words it must never say (an App type, an address, reviewed or not).

afterEach(cleanup);

function view(overrides: Partial<AppView> = {}): AppView {
  return {
    id: "app-1",
    kind: "raftApp",
    appId: "app-1",
    name: "Notion",
    description: "Search and edit your team's pages.",
    logoUrl: null,
    logoSeed: "notion",
    official: false,
    origin: "marketplace",
    publisherName: "Notion Labs",
    listedByRaft: false,
    createdByUserId: null,
    reach: null,
    added: true,
    state: "normal",
    needsAttention: false,
    ...overrides,
  };
}

function attention(state: AppCardAction, overrides: Partial<AppView> = {}): AppView {
  return view({ state, needsAttention: true, ...overrides });
}

interface Calls {
  opened: AppView[];
  actions: Array<[AppCardAction, AppView]>;
  added: AppView[];
}

/** The card with every callback recorded; `props` can take one away (`onAction: undefined`). */
function renderCard(app: AppView, props: Partial<AppCardProps> = {}) {
  const calls: Calls = { opened: [], actions: [], added: [] };
  renderWithIntl(
    <AppCard
      app={app}
      testId="card"
      onOpen={(opened) => calls.opened.push(opened)}
      onAction={(state, acted) => calls.actions.push([state, acted])}
      onAdd={(added) => calls.added.push(added)}
      {...props}
    />,
  );
  return { calls, card: screen.getByTestId("card") };
}

/** No part with this test id on the card. Never hands a DOM node to assert (it would inspect the whole tree). */
function absent(card: HTMLElement, testId: string) {
  assert.ok(within(card).queryByTestId(testId) === null, `${testId} should not be on the card`);
}

const buttonNames = (card: HTMLElement) => within(card).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

test("a normal card: name, description, source line, and the card as its only button", () => {
  const app = view();
  const { calls, card } = renderCard(app);
  assert.equal(card.getAttribute("data-state"), "normal");
  assert.ok(within(card).getByText("Notion"));
  assert.equal(within(card).getByTestId("app-card-description").textContent, "Search and edit your team's pages.");
  assert.equal(within(card).getByTestId("app-card-source").textContent, "By Notion Labs");
  absent(card, "app-card-official");
  absent(card, "app-card-attention-dot");
  absent(card, "app-card-status");
  // Yours never says Added, and offers no Add.
  absent(card, "app-card-added");
  assert.deepEqual(buttonNames(card), ["Notion"]);

  const open = screen.getByRole("button", { name: "Notion" });
  // A real button: reachable with Tab, and Enter and Space press it.
  assert.equal(open.tagName, "BUTTON");
  assert.equal(open.getAttribute("tabindex"), null);
  fireEvent.click(open);
  assert.deepEqual(calls.opened, [app]);
  assert.deepEqual(calls.actions, []);
});

test("Official shows only for Raft's own App, as the card's one badge", () => {
  const { card } = renderCard(view({ official: true, publisherName: "Raft" }));
  assert.equal(within(card).getByTestId("app-card-official").textContent, "Official");
  cleanup();
  const listed = renderCard(view({ kind: "connectedService", listedByRaft: true, publisherName: null })).card;
  absent(listed, "app-card-official");
  assert.equal(within(listed).getByTestId("app-card-source").textContent, "Listed by Raft");
});

test("a card without a description keeps the description's two lines", () => {
  const { card } = renderCard(view({ description: null }));
  const description = within(card).getByTestId("app-card-description");
  assert.equal(description.textContent, "");
  assert.match(description.className, /h-\[2lh\]/);
});

test("the source line: every combination of its parts", () => {
  const intl = createIntl({ locale: "en", messages: mergedMessages("en") });
  const line = (overrides: Partial<AppView>, creatorName?: string | null) => appCardSourceParts(view(overrides), creatorName, intl.formatMessage).join(" · ");
  const none = { publisherName: null, listedByRaft: false, reach: null } as const;

  assert.equal(line({ ...none, publisherName: "Notion Labs" }), "By Notion Labs");
  assert.equal(line({ ...none, listedByRaft: true }), "Listed by Raft");
  // A publisher and Raft's listing together: the publisher alone.
  assert.equal(line({ ...none, publisherName: "Notion Labs", listedByRaft: true }), "By Notion Labs");
  assert.equal(line({ ...none, publisherName: "Google", reach: "10_plus" }), "By Google · 10+ servers");
  assert.equal(line({ ...none, listedByRaft: true, reach: "100_plus" }), "Listed by Raft · 100+ servers");
  assert.equal(line({ ...none, publisherName: "Raft", reach: "1k_plus" }), "By Raft · 1k+ servers");
  // Internal: the creator's name only when the caller has it; never "By".
  assert.equal(line({ ...none, origin: "internal" }), "Internal");
  assert.equal(line({ ...none, origin: "internal" }, null), "Internal");
  assert.equal(line({ ...none, origin: "internal" }, "Alice"), "Internal · made by Alice");
  assert.equal(line({ ...none, origin: "internal", publisherName: "Someone" }, "Alice"), "Internal · made by Alice");
  // Shared with you, then who made it.
  assert.equal(line({ ...none, origin: "shared" }), "Shared with you");
  assert.equal(line({ ...none, origin: "shared", publisherName: "Acme" }), "Shared with you · By Acme");
  // Nothing known: an empty line, not a placeholder.
  assert.equal(line(none), "");
});

test("the creator's name reaches the card's source line", () => {
  const { card } = renderCard(view({ origin: "internal", publisherName: null, createdByUserId: "user-1" }), { creatorName: "Alice" });
  assert.equal(within(card).getByTestId("app-card-source").textContent, "Internal · made by Alice");
});

const STATES: Array<[AppCardAction, string, string]> = [
  ["updateNeedsApproval", "Update needs your approval", "Review"],
  ["signInExpired", "Signed out", "Sign in"],
  ["cannotConnect", "Can’t connect", "View"],
];

for (const [state, statusText, buttonLabel] of STATES) {
  test(`${state}: the status replaces the source line, with the dot and the ${buttonLabel} button`, () => {
    const app = attention(state);
    const { calls, card } = renderCard(app);
    assert.equal(card.getAttribute("data-state"), state);
    assert.equal(within(card).getByTestId("app-card-status").textContent, statusText);
    absent(card, "app-card-source");
    assert.ok(within(card).getByTestId("app-card-attention-dot"));

    // Two tab stops, the card first: each a button with its own name.
    const open = screen.getByRole("button", { name: "Notion" });
    const action = screen.getByRole("button", { name: `${buttonLabel} Notion` });
    const buttons = within(card).getAllByRole("button");
    assert.ok(buttons.length === 2 && buttons[0] === open && buttons[1] === action, "the card's button, then the state's");
    assert.equal(action.textContent, buttonLabel);
    // The card's button is described by the state.
    assert.equal(document.getElementById(open.getAttribute("aria-describedby") ?? "")?.textContent, statusText);

    // The button's press is its own: the card doesn't open as well.
    fireEvent.click(action);
    assert.deepEqual(calls.actions, [[state, app]]);
    assert.deepEqual(calls.opened, []);
    fireEvent.click(open);
    assert.deepEqual(calls.opened, [app]);
    assert.equal(calls.actions.length, 1);
  });
}

test("a viewer who can't act sees the state without a button", () => {
  const { card } = renderCard(attention("signInExpired"), { onAction: undefined });
  assert.equal(within(card).getByTestId("app-card-status").textContent, "Signed out");
  assert.ok(within(card).getByTestId("app-card-attention-dot"));
  assert.deepEqual(buttonNames(card), ["Notion"]);
});

test("a card that opens nothing for this viewer is not a button, and shows no press states", () => {
  const { card } = renderCard(view(), { onOpen: undefined });
  assert.equal(within(card).queryAllByRole("button").length, 0);
  assert.ok(card.querySelector("[data-app-card-open]") === null);
  assert.ok(!card.className.includes("data-app-card-open"), card.className);
  // What it says is unchanged.
  assert.equal(within(card).getByTestId("app-card-source").textContent, "By Notion Labs");
});

test("Discover: Add for a listing this Server doesn't have, pressed without opening the card", () => {
  const app = view({ added: false, reach: "100_plus" });
  const { calls, card } = renderCard(app, { variant: "discover" });
  assert.equal(within(card).getByTestId("app-card-source").textContent, "By Notion Labs · 100+ servers");
  absent(card, "app-card-added");
  const add = screen.getByRole("button", { name: "Add Notion" });
  assert.equal(add.textContent, "Add");
  fireEvent.click(add);
  assert.deepEqual(calls.added, [app]);
  assert.deepEqual(calls.opened, []);
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  assert.deepEqual(calls.opened, [app]);
});

test("Discover: Added is text, not a button, once this Server has it", () => {
  const { card } = renderCard(view({ added: true }), { variant: "discover" });
  const added = within(card).getByTestId("app-card-added");
  assert.equal(added.textContent, "Added");
  assert.ok(added.closest("button") === null, "Added is not in a button");
  absent(card, "app-card-add");
  assert.deepEqual(buttonNames(card), ["Notion"]);
});

test("Discover: a member gets no Add, and a listing shows no state", () => {
  const member = renderCard(view({ added: false }), { variant: "discover", onAdd: undefined }).card;
  assert.deepEqual(buttonNames(member), ["Notion"]);
  cleanup();
  const { card } = renderCard(attention("updateNeedsApproval", { added: true }), { variant: "discover" });
  assert.equal(card.getAttribute("data-state"), "normal");
  absent(card, "app-card-status");
  absent(card, "app-card-attention-dot");
  absent(card, "app-card-action");
  assert.ok(within(card).getByTestId("app-card-added"));
});

test("no card names an App type, an address or a review verdict", () => {
  const apps: Array<[AppView, Partial<AppCardProps>]> = [
    [view(), {}],
    [view({ kind: "connectedService", listedByRaft: true, publisherName: null }), {}],
    [view({ kind: "connectedService", origin: "internal", publisherName: null }), {}],
    [view({ official: true }), {}],
    [view({ origin: "shared" }), {}],
    [attention("updateNeedsApproval"), {}],
    [attention("signInExpired", { kind: "connectedService" }), {}],
    [attention("cannotConnect", { kind: "connectedService" }), {}],
    [view({ added: false, kind: "connectedService" }), { variant: "discover" }],
    [view({ added: true }), { variant: "discover" }],
  ];
  for (const [app, props] of apps) {
    const { card } = renderCard(app, props);
    const text = `${card.textContent} ${[...card.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label")).join(" ")}`;
    assert.doesNotMatch(text, /\bMCP\b|Raft App|connected service|reviewed|https?:|\.com\b/i, text);
    assert.ok(card.querySelector("a") === null, "no link on the card");
    // One badge at most.
    assert.ok(card.querySelectorAll("[data-testid='app-card-official']").length <= 1);
    cleanup();
  }
});

test("the skeleton draws the card's box, with a button's place only when asked", () => {
  renderWithIntl(<AppCardSkeleton />);
  const skeleton = screen.getByTestId("app-card-skeleton");
  assert.equal(skeleton.getAttribute("aria-hidden"), "true");
  assert.equal(skeleton.querySelectorAll("button").length, 0);
  const plain = skeleton.querySelectorAll("[data-slot='skeleton']").length;
  cleanup();
  renderWithIntl(<AppCardSkeleton button />);
  const withButton = screen.getByTestId("app-card-skeleton").querySelectorAll("[data-slot='skeleton']").length;
  assert.ok(plain > 0);
  assert.equal(withButton, plain + 1);
});
