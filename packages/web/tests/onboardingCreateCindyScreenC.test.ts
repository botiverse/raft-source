import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;

function seedStores(withComputer: boolean) {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "launch",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    billing: null,
  } as never);
  useMachineStore.setState({
    machines: withComputer
      ? [{
          id: "machine-1",
          name: "Mac",
          description: null,
          status: "online",
          statusVersion: 1,
          apiKeyPrefix: null,
          runtimes: ["claude"],
          hostname: "mac.local",
          os: "darwin",
          daemonVersion: "0.72.6",
          lastHeartbeat: "2026-07-11T00:00:00.000Z",
          createdAt: "2026-07-11T00:00:00.000Z",
        }]
      : [],
    showAddMachine: false,
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

function renderCindy(props: { onClose?: () => void; onLater?: () => void } = {}) {
  return render(createElement(
    TestIntlProvider,
    null,
    createElement(
      MemoryRouter,
      { initialEntries: ["/s/launch"] },
      createElement(CreateAgentDialog, {
        onboarding: true,
        onboardingShell: "step",
        onClose: props.onClose ?? (() => undefined),
        onOnboardingLater: props.onLater,
      }),
    ),
  ));
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("mounted Create Cindy step exposes the real runtime surface and supplied Later action", async () => {
  seedStores(true);
  let laterCalls = 0;
  api.get = (async (url: string) => url.endsWith("/runtime-options")
    ? {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [{
            runtimeId: "claude",
            capabilityStatus: "available",
            admissionStatus: "available_for_new",
            admissionReason: null,
            current: false,
            availableForNew: true,
            manageableForCurrentAgent: false,
            canSelectInThisContext: true,
          }],
        },
      }
    : {
        data: {
          kind: "live",
          value: { models: [{ id: "opus", label: "Claude Opus" }], default: "opus" },
        },
      }) as typeof api.get;

  renderCindy({ onLater: () => { laterCalls += 1; } });

  assert.ok(await screen.findByTestId("create-cindy-screen-c"));
  assert.ok(screen.getByRole("heading", { name: "Meet Cindy" }));
  await waitFor(() => assert.ok(screen.getAllByRole("combobox").length >= 2));
  assert.equal(screen.queryByRole("button", { name: "Close" }), null);
  assert.equal(screen.queryByRole("button", { name: "More" }), null);

  fireEvent.click(screen.getByRole("button", { name: "I'll set this up myself" }));
  assert.equal(laterCalls, 1);
});

test("mounted Create Cindy asks for a Computer before rendering dead runtime fields", () => {
  seedStores(false);
  let closeCalls = 0;
  renderCindy({ onClose: () => { closeCalls += 1; } });

  assert.ok(screen.getByTestId("create-cindy-needs-computer"));
  // Was `getByRole("heading", ...)`. The notice is a raft-ui Banner now, and
  // `BannerTitle` renders a div on purpose: a banner's title labels the banner,
  // it is not a section heading in the document outline (@cindyz, 2026-08-29 —
  // "Banner title 不需要 h3, not a bug"). Asserting the visible text keeps what
  // this test is actually for — the Computer prompt renders instead of dead
  // runtime fields — without pinning a semantic we deliberately do not want.
  assert.ok(screen.getByText("Connect a computer first"));
  assert.equal(screen.queryByRole("combobox"), null);

  fireEvent.click(screen.getByRole("button", { name: "Connect a Computer" }));
  assert.equal(closeCalls, 1);
  assert.equal(useMachineStore.getState().showAddMachine, true);
});
