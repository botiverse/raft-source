import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { NavigateFunction } from "react-router-dom";
import { useMainLayoutRealtimeBridge } from "../src/store/socketBridge";
import type { MainLayoutRealtimeBridgeDriver } from "../src/store/socketBridge";

afterEach(() => {
  cleanup();
});

function Probe({
  driver,
  exposeNavigate,
}: {
  driver: MainLayoutRealtimeBridgeDriver;
  exposeNavigate: (navigate: NavigateFunction) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  exposeNavigate(navigate);
  useMainLayoutRealtimeBridge(driver);
  return (
    <div data-route-token={location.pathname}>
      <Outlet />
    </div>
  );
}

test("MainLayout realtime bridge stays installed across route-only rerenders", async () => {
  let bootstrapCount = 0;
  let installCount = 0;
  let cleanupCount = 0;
  let navigate!: NavigateFunction;
  const driver: MainLayoutRealtimeBridgeDriver = {
    bootstrap: () => {
      bootstrapCount += 1;
    },
    install: () => {
      installCount += 1;
      return () => {
        cleanupCount += 1;
      };
    },
  };

  const view = render(
    <MemoryRouter initialEntries={["/s/acme/channel/0"]}>
      <Routes>
        <Route element={<Probe driver={driver} exposeNavigate={(next) => { navigate = next; }} />}>
          <Route path="*" element={<div data-testid="route-leaf" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});

  for (let i = 1; i <= 30; i += 1) {
    await act(async () => {
      navigate(`/s/acme/channel/${i}`);
    });
  }

  assert.equal(view.container.querySelector("[data-route-token]")?.getAttribute("data-route-token"), "/s/acme/channel/30");
  assert.equal(bootstrapCount, 1);
  assert.equal(installCount, 1);
  assert.equal(cleanupCount, 0);

  cleanup();
  assert.equal(cleanupCount, 1);
});
