import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import AssistantConversation from "../src/assistant/AssistantConversation";
import { NavigationDepthTracker } from "../src/hooks/useAppNavigate";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { stubDesktopWidth } from "./helpers/desktopWidth";
import { renderWithIntl } from "./helpers/intl";

// Back-buttons rule a: the assistant page's "← Back" (desktop) with no
// conversation to go back to steps back to the page before it in this app on
// this server; only with none (a link, a reload) does it go Home.

vi.mock("../src/assistant/assistantClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/assistant/assistantClient")>()),
  getDmSetupRetryDelaysMs: () => [],
  refetchMyAssistant: async () => null,
}));

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-08-08T00:00:00.000Z",
};
const assistant = { id: "a1", name: "Ottie", agentId: "a1", dmChannelId: null };
const settings = { readsDms: false, sendAsOwner: false, ownerNotes: null };
const initialServerState = useServerStore.getState();
let restoreWidth: (() => void) | null = null;

afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = null;
  useServerStore.setState(initialServerState, true);
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" data-testid="go" onClick={() => navigate(to)} />;
}

function mount(initialEntries: string[], go: string | null) {
  restoreWidth = stubDesktopWidth();
  useServerStore.setState({ current: server });
  return renderWithIntl(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <NavigationDepthTracker />
      <Routes>
        <Route path="/s/:slug/assistant" element={<AssistantConversation assistant={assistant} settings={settings} />} />
        <Route path="*" element={null} />
      </Routes>
      {go ? <GoTo to={go} /> : null}
      <LocationProbe />
    </MemoryRouter>,
  );
}

test("from another page in the app (Settings), Back goes back there", async () => {
  mount(["/s/acme/settings"], "/s/acme/assistant");
  fireEvent.click(screen.getByTestId("go"));
  fireEvent.click(await screen.findByTestId("assistant-shrink"));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme/settings"));
});

test("with nothing in the app before it (a link, a reload), Back goes Home", async () => {
  mount(["/s/acme/settings", "/s/acme/assistant"], null);
  fireEvent.click(await screen.findByTestId("assistant-shrink"));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme"));
});
