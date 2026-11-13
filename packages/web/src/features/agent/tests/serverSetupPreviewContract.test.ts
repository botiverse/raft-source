import "../../../../tests/helpers/domSetup";

import assert from "node:assert/strict";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { projectionAfterRefreshFailure } from "../../../components/onboarding/serverSetupProjection";
import {
  readServerSetupPreviewView,
  serverSetupPreviewFixture,
} from "../../../dev/serverSetupPreviewFixtures";
import ServerSetupComputerRuntimePreviewPage from "../../../pages/ServerSetupComputerRuntimePreviewPage";
import { useMachineStore } from "../../../store/machineStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";

beforeAll(async () => {
  await import("../CreateAgentDialog");
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  useMachineStore.setState(useMachineStore.getInitialState(), true);
});

test("preview query values and runtime catalogs come from the executable fixture", () => {
  assert.equal(readServerSetupPreviewView("?view=not-ready"), "not-ready");
  assert.equal(readServerSetupPreviewView("?view=create-agent"), "create-agent");
  assert.equal(readServerSetupPreviewView("?view=unknown"), "ready");

  const ready = serverSetupPreviewFixture("ready");
  assert.equal(ready.runtimeStatus, "ready_recommended");
  assert.equal(
    ready.runtimeOptions.find((option) => option.runtimeId === "claude")?.canSelectInThisContext,
    true,
  );
  assert.equal(ready.runtimeOptions.some((option) => option.runtimeId === "grok"), false);

  const createAgent = serverSetupPreviewFixture("create-agent");
  assert.equal(
    createAgent.createRuntimeOptions?.find((option) => option.runtimeId === "claude")?.canSelectInThisContext,
    true,
  );
  assert.equal(createAgent.createRuntimeOptions?.some((option) => option.runtimeId === "grok"), false);
});

test("production Screen B consumes the frozen projection contract without client-derived readiness", async () => {
  window.history.replaceState({}, "", "/dev/server-setup?view=ready");
  const view = render(createElement(
    TestIntlProvider,
    null,
    createElement(
      MemoryRouter,
      { initialEntries: ["/dev/server-setup?view=ready"] },
      createElement(ServerSetupComputerRuntimePreviewPage),
    ),
  ));

  const dimmer = Array.from(view.container.querySelectorAll<HTMLElement>("[aria-hidden='true']"))
    .find((element) => element.getAttribute("class")?.includes("bg-layer-backdrop"));
  assert.ok(dimmer);
  // The preview's dimmer is the DS scrim token, not a hard-coded black wash.
  assert.match(dimmer.className, /(?:^|\s)bg-layer-backdrop(?:\s|$)/);
  assert.ok(screen.getByTestId("onboarding-computer-connected"));

  const next = screen.getByRole("button", { name: "Next" });
  assert.equal(next.hasAttribute("disabled"), false);
  fireEvent.click(next);

  // Create agent is deferred UI (boot/deferredUi): it renders once its module is in.
  assert.ok(await screen.findByTestId("create-cindy-screen-c"));
  assert.ok(screen.getByRole("heading", { name: "Meet Cindy" }));
  assert.deepEqual(useMachineStore.getState().machines[0]?.runtimes, ["claude", "builtin", "pi"]);
});

test("a failed refetch preserves the last authoritative setup projection", () => {
  const known = {
    surface: "computer_runtime",
    phase: "in_progress",
    currentStep: "computer_runtime",
    blocksChat: true,
    allowedExits: ["defer", "return_to_server"],
    sideEffectState: { transitions: "enabled", completion: "disabled" },
    gateReason: "runtime_checking",
    runtimeStatus: "checking",
    computerStatus: "online",
    postSetup: { surveyPending: false, handoffPending: false },
  } as const;

  assert.deepEqual(projectionAfterRefreshFailure(known as never), known as never);
  assert.equal(projectionAfterRefreshFailure(null), null);
});
