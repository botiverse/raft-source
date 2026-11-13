import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ServerSelector from "../src/components/auth/ServerSelector";
import { ONBOARDING_CREATE_SHELL_CLASS } from "../src/components/auth/OnboardingCreateShell";
import { assertScrollAreaRailsOn } from "./helpers/scrollAreaRails";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

const user: User = {
  id: "user-1",
  email: "cindy@example.com",
  name: "Cindy",
  displayName: null,
  description: null,
  avatarUrl: null,
  emailVerified: true,
  preferredLanguage: null,
  preferredTimezone: null,
  autoTranslationEnabled: false,
  preferredTranslationMode: "manual",
  preferredTranslationDisplay: "translated",
  preferredTimeFormat: null,
  preferredMessageBodyFontSize: null,
  referralSource: null,
  referralSourceOther: null,
  referralSourceSkippedAt: null,
};

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: "server-1",
    name: "Launch Lab",
    avatarUrl: null,
    slug: "launch-lab",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "starter",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function resetStores(options: { servers?: Server[] } = {}) {
  const createServer = async (name: string, slug: string) => server({ name, slug });
  useServerStore.setState({
    servers: options.servers ?? [],
    current: null,
    members: [],
    loading: false,
    createServer,
  } as never);
  useAuthStore.setState({
    user,
    logout: () => {},
  } as never);
}

function renderSelector() {
  const selected: Server[] = [];
  // ServerSelector reads its copy through react-intl now, so it needs an intl
  // ancestor. Using the REAL providers rather than a stub catalog keeps these
  // assertions honest about the English users actually see.
  const view = render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <ServerSelector onSelect={(next) => selected.push(next)} />
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
  return { ...view, selected };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetStores();
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
});

test("hosted server selection emits the frozen switch intent, then times out to a retryable error", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = server();
  const second = server({ id: "server-2", name: "Second", slug: "second" });
  resetStores({ servers: [first, second] });
  const calls: Array<{ kind: string; payload: object }> = [];
  Object.defineProperty(window, "RaftHost", {
    configurable: true,
    value: Object.freeze({
      version: "raft-host-v1",
      onboarding: Object.freeze({
        contractVersion: "raft-onboarding-v1",
        generation: "webview:1",
        sourceServerId: "server-1",
      }),
      emit(kind: string, payload: object) { calls.push({ kind, payload }); },
    }),
  });

  const { selected } = renderSelector();
  fireEvent.click(screen.getByRole("button", { name: /Second/ }));
  assert.deepEqual(selected, []);
  assert.deepEqual(calls, [{
    kind: "onboarding:server-switch-request",
    payload: {
      contractVersion: "raft-onboarding-v1",
      generation: "webview:1",
      sourceServerId: "server-1",
      targetServerId: "server-2",
    },
  }]);
  assert.equal(screen.getByRole("button", { name: /Second/ }).hasAttribute("disabled"), true);
  act(() => vi.advanceTimersByTime(5000));
  assert.ok(screen.getByText("Could not switch servers. Please try again."));
  assert.equal(screen.getByRole("button", { name: /Second/ }).hasAttribute("disabled"), false);
  assert.deepEqual(selected, [], "timeout must never fall back to a local Web selection");
});

test("first-server flow always renders Screen A", () => {
  resetStores();
  renderSelector();

  const preview = screen.getByTestId("server-create-preview");
  const dotPane = preview.closest("aside");
  const grid = dotPane?.parentElement;
  const shell = grid?.parentElement;
  const formPanel = grid?.firstElementChild;
  const dotGrid = dotPane?.firstElementChild;

  // It fills #root's column (min-h-0 flex-1), not the viewport: under a title
  // strip (desktop, installed web app) a 100vh minimum pushed its bottom out.
  assert.ok(shell?.className.includes("flex-1"));
  assert.ok(!shell?.className.includes("min-h-screen"));
  assert.ok(shell?.className.includes("font-display"));
  assert.ok(grid?.className.includes("lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]"));
  // The form column scrolls in a raft-ui ScrollArea; the form centres with auto margins.
  assertScrollAreaRailsOn(formPanel, { ownContainer: false });
  assert.equal(formPanel.tagName, "SECTION");
  assert.ok(!formPanel.className.includes("justify-center"), "centred by the form's margins, not the column");
  assert.ok(formPanel.querySelector(":scope > div.m-auto"), "the form centres with auto margins");
  assert.ok(formPanel?.className.includes("bg-layer-canvas"));
  // The demo pane is the onboarding's frame with a halftone behind the tilted
  // preview sticker (DS ScreenOnboarding).
  assert.ok(dotPane?.className.includes("bg-layer-frame"));
  assert.ok(dotGrid?.className.includes("radial-gradient(var(--line-seam)_1.5px,transparent_1.5px)"));
  assert.ok(dotGrid?.className.includes("[background-size:14px_14px]"));
  assert.ok(screen.getByTestId("server-create-preview"));
  assert.ok(preview.className.includes("rotate-[-1deg]"));
  assert.ok(preview.className.includes("shadow-sticker"));
  assert.ok(screen.getByTestId("server-preview-sidebar-badge").className.includes("onboarding-preview-pop"));
  const channelsSection = screen.getByTestId("server-preview-section-channels");
  const dmsSection = screen.getByTestId("server-preview-section-dms");
  assert.equal(channelsSection.tagName, "BUTTON");
  assert.equal(dmsSection.tagName, "BUTTON");
  // DS section-title buttons: a focus ring and the pressed overlay, no
  // translate-on-hover.
  assert.ok(channelsSection.className.includes("focus-visible:shadow-focus"));
  assert.ok(dmsSection.className.includes("hover:bg-fill-medium"));
  assert.doesNotMatch(dmsSection.className, /translate/);
  assert.equal(channelsSection.getAttribute("aria-expanded"), "true");
  assert.equal(dmsSection.getAttribute("aria-expanded"), "true");
  assert.equal(channelsSection.getAttribute("aria-controls"), "server-preview-channel-rows");
  assert.equal(dmsSection.getAttribute("aria-controls"), "server-preview-dm-rows");
  // The preview mirrors the real first-server shape: exactly two channels
  // (onboarding-owner + all) and a single Cindy DM.
  assert.ok(within(channelsSection).getByText("2"));
  assert.ok(within(dmsSection).getByText("1"));
  // "Direct messages" -> "Direct messages": a DELIBERATE visible copy change, not
  // a test fixup. The preview now reuses the real sidebar's `layout.sidebar.*`
  // ids instead of minting preview-only duplicates (six ids already read
  // "Channels"). Reusing them surfaced that the preview and the thing it
  // previews had silently drifted apart on casing; the sidebar wins, because a
  // preview that disagrees with the real UI is the bug. Flagged for @AngLee.
  assert.ok(within(dmsSection).getByText("Direct messages"));
  assert.equal(
    screen.getByTestId("server-preview-address-slug").className,
    "min-w-0 truncate font-bold text-foreground ",
  );
  assert.ok(within(preview).getAllByText("Alex Chen Studio").length >= 1);
  assert.ok(within(preview).getByText("all"));
  assert.ok(within(preview).queryByText("pricing") === null);
  assert.ok(within(preview).queryByText("Scout") === null);
  assert.ok(within(preview).queryByText("Draft") === null);
  // Cindy is the onboarding agent, not an "official agent"; the system/Raft row is gone.
  assert.ok(within(preview).getByText("onboarding agent"));
  assert.ok(within(preview).queryByText("official agent") === null);
  assert.ok(within(preview).queryByText("system") === null);
  assert.ok(within(preview).queryByText("Computers") === null);
  assert.ok(within(preview).queryByText("Wenyi's MacBook Pro") === null);
  // The whole onboarding flow states the session the same way: display name
  // plus "Sign out" in the footer.
  const sessionFooter = screen.getByTestId("onboarding-session-footer");
  assert.match(sessionFooter.textContent ?? "", /Signed in as cindy@example\.com\./);
  assert.ok(within(sessionFooter).getByRole("button", { name: "Sign out" }));
  // The primary action is full-width on every onboarding page: the raft
  // pink sticker (`accent` → bg-attention-400) at the DS 52 call-to-action size.
  const createButton = screen.getByRole("button", { name: "Create server" });
  const createClasses = createButton.className.split(" ");
  assert.ok(createClasses.includes("bg-attention-400"));
  assert.ok(createClasses.includes("h-control-cta"));
  assert.ok(createClasses.includes("w-full"));

  fireEvent.click(channelsSection);
  assert.equal(channelsSection.getAttribute("aria-expanded"), "false");
  assert.ok(within(preview).queryByText("all") === null);
  fireEvent.click(channelsSection);
  assert.equal(channelsSection.getAttribute("aria-expanded"), "true");
  assert.ok(within(preview).getByText("all"));

  fireEvent.click(dmsSection);
  assert.equal(dmsSection.getAttribute("aria-expanded"), "false");
  assert.equal(within(preview).queryAllByText("Cindy").length, 1, "collapsing DMs leaves only the Cindy message author");
  fireEvent.click(dmsSection);
  assert.equal(dmsSection.getAttribute("aria-expanded"), "true");
  assert.equal(within(preview).queryAllByText("Cindy").length, 2, "expanded DMs show the Cindy row plus the message author");
});

// Task #686 (Artea 2026-09-28): the first-server intro copy was hardcoded
// `text-black*`, so on elegant-dark it rendered black-on-dark and nearly
// disappeared. The fix moved it onto the surface tokens; the Raft DS keeps it
// there (step label ink-3 in Space Mono, display title, ink-2 paragraph).
test("first-server title block follows the theme tokens", () => {
  resetStores();
  renderSelector();

  const eyebrow = screen.getByText("Create your first server");
  const heading = screen.getByRole("heading", { name: "Name the server where your agents will work." });
  const description = screen.getByText(
    "A server is the workspace for your people, agents, channels, and computers.",
  );

  assert.match(eyebrow.className, /(?:^|\s)text-foreground-hint(?:\s|$)/);
  assert.match(eyebrow.className, /(?:^|\s)font-mono(?:\s|$)/);
  assert.doesNotMatch(eyebrow.className, /uppercase/, "only a \"Step 1 of 3\" count may be all caps");
  assert.match(heading.className, /(?:^|\s)text-foreground(?:\s|$)/);
  assert.match(description.className, /(?:^|\s)text-foreground-muted(?:\s|$)/);

  // No bare black text left: a future edit must not silently regress these to
  // light-theme-only values again.
  for (const element of [eyebrow, heading, description]) {
    assert.doesNotMatch(
      element.className,
      /text-black/,
      `${element.tagName} keeps its copy on semantic tokens`,
    );
  }
});

test("Screen A preview reflects server name and slug before create", () => {
  resetStores();
  renderSelector();

  const preview = screen.getByTestId("server-create-preview");
  assert.equal((screen.getByLabelText("Server name") as HTMLInputElement).placeholder, "Alex Chen Studio");
  assert.equal((screen.getByLabelText("Slug") as HTMLInputElement).placeholder, "alex-chen-studio");
  assert.ok(within(preview).getAllByText("Alex Chen Studio").length >= 1);
  assert.ok(within(preview).getByText("alex-chen-studio"));
  assert.ok(within(preview).queryByText("Your setup progress will live here until the server is ready.") === null);
  assert.ok(within(preview).queryByText("Preview") === null);

  fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "Launch Lab" } });
  assert.ok(within(preview).getAllByText("Launch Lab").length >= 1);
  assert.ok(within(preview).getByText("launch-lab"));
  assert.ok(screen.getByTestId("server-preview-sidebar-badge").className.includes("onboarding-preview-pop"));
  const liveMessageBeforeSlugEdit = within(preview).getByText("I am getting Launch Lab ready.");
  assert.ok(liveMessageBeforeSlugEdit.className.includes("onboarding-live-message"));

  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "alpha beta" } });
  assert.ok(within(preview).getByText("alpha-beta"));
  assert.ok(screen.getByTestId("server-preview-address-slug").className.includes("onboarding-preview-pop"));
  assert.ok(within(preview).getByText("I am getting Launch Lab ready.") !== liveMessageBeforeSlugEdit);
});

test("Screen A creates the server with the edited values", async () => {
  resetStores();
  const view = renderSelector();

  fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "Launch Lab" } });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "launch-team" } });
  fireEvent.click(screen.getByRole("button", { name: "Create server" }));

  await waitFor(() => assert.equal(view.selected.length, 1));
  assert.deepEqual(view.selected, [server({ name: "Launch Lab", slug: "launch-team" })]);
});

test("creating a server refused at the Raft License's user limit says so with the mail link", async () => {
  resetStores();
  useServerStore.setState({
    createServer: async () => {
      throw Object.assign(new Error("http"), { response: { status: 403, data: { code: "deployment_user_limit_reached", error: "server sentence" } } });
    },
  } as never);
  const view = renderSelector();

  fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "Launch Lab" } });
  fireEvent.click(screen.getByRole("button", { name: "Create server" }));

  const link = await screen.findByRole("link", { name: "contact@raft.build" });
  assert.equal(link.getAttribute("href"), "mailto:contact@raft.build");
  assert.ok(screen.getByText(/This Raft Community Edition deployment already has 5 people, the Raft License limit\./));
  assert.ok(screen.queryByText("server sentence") === null, "the localized sentence, not the server's");
  assert.deepEqual(view.selected, []);
});

test("existing users keep the compact create-server flow", () => {
  resetStores({ servers: [server()] });
  renderSelector();

  fireEvent.click(screen.getByRole("button", { name: "+ Create new server" }));

  const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*"));

  assert.ok(screen.queryByTestId("server-create-preview") === null);
  assert.ok(document.body.querySelector("aside") === null);
  assert.equal(
    elements.some((element) => element.className.includes("lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]")),
    false,
  );
  assert.equal(
    elements.some((element) => element.className.includes("radial-gradient(#111_1px,transparent_1px)")),
    false,
  );
  assert.equal(
    elements.some((element) => element.className === ONBOARDING_CREATE_SHELL_CLASS),
    false,
  );
  // A heading, not a button: the Title Case rule covers controls, not page titles.
  assert.ok(screen.getByRole("heading", { name: "Create server" }));
  assert.ok(screen.getByRole("button", { name: "Cancel" }));
  assert.ok(screen.getByRole("button", { name: "Create server" }));
});

test("a server list that empties (logout, or arriving late) falls back to the first-server flow", () => {
  // stdrc, 2026-07-13: logging back in mid-onboarding showed "server not found" and then
  // an empty "Choose server" screen, instead of the create-your-first-server step they
  // had stopped on. The list arrives asynchronously and is cleared on logout, so the
  // mount-time guess ("I have servers → choose") goes stale.
  resetStores({ servers: [server()] });
  renderSelector();
  assert.ok(screen.getByRole("heading", { name: "Choose server" }));

  act(() => { useServerStore.setState({ servers: [] } as never); });

  assert.ok(screen.queryByRole("heading", { name: "Choose server" }) === null);
  assert.ok(screen.getByRole("button", { name: "Create server" }));
  assert.ok(screen.getByTestId("server-create-preview"));
});
