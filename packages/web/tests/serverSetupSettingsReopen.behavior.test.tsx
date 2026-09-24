import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import { ADMINISTRATION_VISUAL_SECTIONS } from "../src/components/settings/SettingsPanel";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

const originalGet = api.get;
const originalPost = api.post;
const OnboardingSection = ADMINISTRATION_VISUAL_SECTIONS.onboarding;

function Harness() {
  const location = useLocation();
  return (
    <>
      <OnboardingSection />
      <output data-testid="route">{location.pathname}</output>
    </>
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
});

test("Finish setup durably starts deferred setup before returning to the server", async () => {
  useAuthStore.setState({
    user: { id: "owner-1" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      slug: "launch",
      role: "owner",
    },
    servers: [],
    members: [],
    loading: false,
  } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);

  api.get = (async (url: string) => {
    if (url === "/servers/server-1/settings") {
      return {
        data: {
          settings: {
            onboardSettings: { onboardingAgentId: null, agentAllChannelGreetingEnabled: true },
            feedbackSettings: { enabled: false },
          },
        },
      };
    }
    if (url === "/servers/server-1/setup-projection") {
      return {
        data: {
          surface: "computer_runtime",
          phase: "deferred",
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;

  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { surface: "computer_runtime", phase: "in_progress" } };
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/launch/settings/administration"]}>
        <Harness />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  fireEvent.click(await screen.findByTestId("finish-server-setup"));

  await waitFor(() => {
    assert.deepEqual(posts, [{
      url: "/servers/server-1/setup-transition",
      body: { action: "start" },
    }]);
    assert.equal(screen.getByTestId("route").textContent, "/s/launch");
  });
});
