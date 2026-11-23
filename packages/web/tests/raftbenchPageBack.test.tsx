import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import RaftBenchPage from "../src/raftbench/RaftBenchPage";
import { NavigationDepthTracker } from "../src/hooks/useAppNavigate";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import {
  RAFTBENCH_OVERVIEW_FLAG_KEY,
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

// Back-buttons rule a: RaftBench's Back (the phone's page head) steps back to
// the page before it in this app on this server; only with none (a link, a
// reload) does it go to Settings, the page it is listed in.

vi.mock("../src/raftbench/ManagerOverview", () => ({ default: () => null }));
vi.mock("../src/raftbench/HostedAnalysis", () => ({ default: () => null }));

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
const initialServerState = useServerStore.getState();
const initialChannelState = useChannelStore.getState();

afterEach(() => {
  cleanup();
  resetServerFeatureFlagsForTests();
  useServerStore.setState(initialServerState, true);
  useChannelStore.setState(initialChannelState, true);
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
  useServerStore.setState({ current: server });
  useAuthStore.setState({ user: { id: "user-1" } } as never);
  useChannelStore.setState({ channels: [], loadChannels: async () => {} } as never);
  setServerFeatureFlagForTests(server.id, RAFTBENCH_OVERVIEW_FLAG_KEY, true);
  return renderWithIntl(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <NavigationDepthTracker />
      <Routes>
        <Route path="/s/:slug/raftbench" element={<RaftBenchPage />} />
        <Route path="*" element={null} />
      </Routes>
      {go ? <GoTo to={go} /> : null}
      <LocationProbe />
    </MemoryRouter>,
  );
}

async function pressBack() {
  await screen.findByTestId("raftbench-page");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
}

test("from another page in the app (a channel), Back goes back there", async () => {
  mount(["/s/acme/channel/c1"], "/s/acme/raftbench");
  fireEvent.click(screen.getByTestId("go"));
  await pressBack();
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme/channel/c1"));
});

test("with nothing in the app before it (a link, a reload), Back goes to Settings", async () => {
  mount(["/s/acme/channel/c1", "/s/acme/raftbench"], null);
  await pressBack();
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme/settings"));
});
