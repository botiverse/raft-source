import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { ThisDevicePanel } from "../src/components/machine/localComputer/ThisDevicePanel";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { stubDesktopWidth } from "./helpers/desktopWidth";
import { renderWithIntl } from "./helpers/intl";

// cindyz (Raft Desktop, macOS): This Mac, while it is not one of the server's
// computers, is the standalone /computers/this-device page. No side panel
// hosts it, so on desktop it is a page of its own and needs Back to the
// Computers list there too (Raft DS › Navigation: a full page has only
// Back), not only on a phone. Assertions compare strings / booleans only.

vi.mock("../src/components/machine/localComputer/useLocalComputerHost", () => ({
  useLocalComputerHost: () => ({ ready: true, self: { deviceKind: "mac", machineId: null } }),
}));
vi.mock("../src/components/machine/localComputer/ThisDeviceSections", () => ({
  ThisDeviceSections: () => <div data-testid="this-device-sections" />,
}));

const initialServerState = useServerStore.getState();

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

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function mountThisDevicePage() {
  useServerStore.setState({ current: server, members: [] });
  return renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/computers/this-device"]}>
      <Routes>
        <Route path="/s/:slug/computers/this-device" element={<ThisDevicePanel />} />
        <Route path="/s/:slug/computers" element={<span data-testid="computers-page" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** Whether the Back is hidden from the md breakpoint on (shown on a phone only). */
function backHiddenOnDesktop(): boolean {
  return screen.getByTestId("machine-mobile-back").className.split(/\s+/).includes("md:hidden");
}

let restoreWidth: (() => void) | null = null;

afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = null;
  useServerStore.setState(initialServerState, true);
});

test("desktop: the This Mac page has Back, which goes to the Computers list when opened directly", async () => {
  restoreWidth = stubDesktopWidth();
  mountThisDevicePage();
  assert.equal(screen.getByTestId("machine-panel-header").querySelector("h2")?.textContent, "This Mac");
  assert.equal(backHiddenOnDesktop(), false);
  // No side panel: no ×.
  assert.equal(screen.queryByTestId("machine-panel-close") === null, true);
  fireEvent.click(screen.getByTestId("machine-mobile-back"));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme/computers"));
  assert.equal(screen.queryByTestId("computers-page") !== null, true);
});

test("phone: Back on the This Mac page, opened directly, still goes to the Computers list", async () => {
  mountThisDevicePage();
  fireEvent.click(screen.getByTestId("machine-mobile-back"));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme/computers"));
});
