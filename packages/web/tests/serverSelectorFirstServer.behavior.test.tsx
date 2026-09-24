import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ServerSelector from "../src/components/auth/ServerSelector";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

const user: User = {
  id: "user-1",
  email: "cindy@example.com",
  gravatarHash: "hash",
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

test("hosted server selection emits the frozen switch intent, then times out to a retryable error", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
  act(() => t.mock.timers.tick(5000));
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

  assert.ok(shell?.className.includes("min-h-screen"));
  assert.ok(shell?.className.includes("font-display"));
  assert.ok(grid?.className.includes("lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]"));
  assert.ok(formPanel?.className.includes("overflow-y-auto"));
  assert.ok(formPanel?.className.includes("bg-white"));
  assert.ok(dotGrid?.className.includes("radial-gradient(#111_1px,transparent_1px)"));
  assert.ok(dotGrid?.className.includes("[background-size:16px_16px]"));
  assert.ok(screen.getByTestId("server-create-preview"));
  assert.ok(preview.className.includes("rotate-[-1deg]"));
  assert.ok(preview.className.includes("border-2"));
  assert.ok(preview.className.includes("shadow-brutal-lg"));
  assert.ok(screen.getByTestId("server-preview-sidebar-badge").className.includes("onboarding-preview-pop"));
  const channelsSection = screen.getByTestId("server-preview-section-channels");
  const dmsSection = screen.getByTestId("server-preview-section-dms");
  assert.equal(channelsSection.tagName, "BUTTON");
  assert.equal(dmsSection.tagName, "BUTTON");
  assert.ok(channelsSection.className.includes("focus-visible:outline"));
  assert.ok(dmsSection.className.includes("hover:-translate-y-px"));
  assert.equal(channelsSection.getAttribute("aria-expanded"), "true");
  assert.equal(dmsSection.getAttribute("aria-expanded"), "true");
  assert.equal(channelsSection.getAttribute("aria-controls"), "server-preview-channel-rows");
  assert.equal(dmsSection.getAttribute("aria-controls"), "server-preview-dm-rows");
  // The preview mirrors the real first-server shape: exactly two channels
  // (onboarding-owner + all) and a single Cindy DM.
  assert.ok(within(channelsSection).getByText("2"));
  assert.ok(within(dmsSection).getByText("1"));
  // "Direct messages" -> "Direct Messages": a DELIBERATE visible copy change, not
  // a test fixup. The preview now reuses the real sidebar's `layout.sidebar.*`
  // ids instead of minting preview-only duplicates (six ids already read
  // "Channels"). Reusing them surfaced that the preview and the thing it
  // previews had silently drifted apart on casing; the sidebar wins, because a
  // preview that disagrees with the real UI is the bug. Flagged for @AngLee.
  assert.ok(within(dmsSection).getByText("Direct Messages"));
  assert.equal(
    screen.getByTestId("server-preview-address-slug").className,
    "min-w-0 truncate font-bold text-black ",
  );
  assert.ok(within(preview).getAllByText("Alex Chen Studio").length >= 1);
  assert.ok(within(preview).getByText("all"));
  assert.equal(within(preview).queryByText("pricing"), null);
  assert.equal(within(preview).queryByText("Scout"), null);
  assert.equal(within(preview).queryByText("Draft"), null);
  // Cindy is the onboarding agent, not an "official agent"; the system/Raft row is gone.
  assert.ok(within(preview).getByText("onboarding agent"));
  assert.equal(within(preview).queryByText("official agent"), null);
  assert.equal(within(preview).queryByText("system"), null);
  assert.equal(within(preview).queryByText("Computers"), null);
  assert.equal(within(preview).queryByText("Wenyi's MacBook Pro"), null);
  assert.ok(screen.getByText("Name the server where your agents will work."));
  // The whole onboarding flow states the session the same way: display name
  // plus "Log out" in the footer.
  const sessionFooter = screen.getByTestId("onboarding-session-footer");
  assert.match(sessionFooter.textContent ?? "", /Signed in as cindy@example\.com\./);
  assert.ok(within(sessionFooter).getByRole("button", { name: "Log out" }));
  // The primary action is full-width on every onboarding page.
  const createButton = screen.getByRole("button", { name: "Create Server" });
  assert.ok(createButton.className.includes("bg-brutal-pink"));
  assert.ok(createButton.className.includes("w-full"));

  fireEvent.click(channelsSection);
  assert.equal(channelsSection.getAttribute("aria-expanded"), "false");
  assert.equal(within(preview).queryByText("all"), null);
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

test("Screen A preview reflects server name and slug before create", () => {
  resetStores();
  renderSelector();

  const preview = screen.getByTestId("server-create-preview");
  assert.ok(screen.getByText("Name the server where your agents will work."));
  assert.equal((screen.getByLabelText("Server name") as HTMLInputElement).placeholder, "Alex Chen Studio");
  assert.equal((screen.getByLabelText("Server URL") as HTMLInputElement).placeholder, "alex-chen-studio");
  assert.ok(within(preview).getAllByText("Alex Chen Studio").length >= 1);
  assert.ok(within(preview).getByText("alex-chen-studio"));
  assert.ok(within(preview).getByText("Once the server is created, I will help you connect a computer and create Cindy."));
  assert.equal(within(preview).queryByText("Your setup progress will live here until the server is ready."), null);
  assert.equal(within(preview).queryByText("Preview"), null);

  fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "Launch Lab" } });
  assert.ok(within(preview).getAllByText("Launch Lab").length >= 1);
  assert.ok(within(preview).getByText("launch-lab"));
  assert.ok(screen.getByTestId("server-preview-sidebar-badge").className.includes("onboarding-preview-pop"));
  const liveMessageBeforeSlugEdit = within(preview).getByText("I am getting Launch Lab ready.");
  assert.ok(liveMessageBeforeSlugEdit.className.includes("onboarding-live-message"));

  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "alpha beta" } });
  assert.ok(within(preview).getByText("alpha-beta"));
  assert.ok(screen.getByTestId("server-preview-address-slug").className.includes("onboarding-preview-pop"));
  assert.notEqual(within(preview).getByText("I am getting Launch Lab ready."), liveMessageBeforeSlugEdit);
});

test("Screen A creates the server with the edited values", async () => {
  resetStores();
  const view = renderSelector();

  fireEvent.change(screen.getByLabelText("Server name"), { target: { value: "Launch Lab" } });
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "launch-team" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Server" }));

  await waitFor(() => assert.equal(view.selected.length, 1));
  assert.deepEqual(view.selected, [server({ name: "Launch Lab", slug: "launch-team" })]);
});

test("existing users keep the compact create-server flow", () => {
  resetStores({ servers: [server()] });
  renderSelector();

  fireEvent.click(screen.getByRole("button", { name: "+ Create New Server" }));

  const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*"));

  assert.equal(screen.queryByTestId("server-create-preview"), null);
  assert.equal(document.body.querySelector("aside"), null);
  assert.equal(
    elements.some((element) => element.className.includes("lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]")),
    false,
  );
  assert.equal(
    elements.some((element) => element.className.includes("radial-gradient(#111_1px,transparent_1px)")),
    false,
  );
  assert.equal(
    elements.some((element) => element.className.includes("min-h-screen") && element.className.includes("font-display")),
    false,
  );
  // A heading, not a button: the Title Case rule covers controls, not page titles.
  assert.ok(screen.getByRole("heading", { name: "Create server" }));
  assert.ok(screen.getByRole("button", { name: "Cancel" }));
  assert.ok(screen.getByRole("button", { name: "Create Server" }));
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

  assert.equal(screen.queryByRole("heading", { name: "Choose server" }), null);
  assert.ok(screen.getByRole("button", { name: "Create Server" }));
  assert.ok(screen.getByTestId("server-create-preview"));
});
