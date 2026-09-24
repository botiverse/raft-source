import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import { TestIntlProvider } from "./helpers/intl";
import { en } from "../src/i18n/messages/en";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

const EXPECTED_ADMIN_TITLE = "Update identity and admin role";
const EXPECTED_IDENTITY_TITLE = "Update official identity";
const EXPECTED_ADMIN_CONFIRM = "Update identity and role";
const EXPECTED_IDENTITY_CONFIRM = "Update identity";
const EXPECTED_ADMIN_WARNING = "This will grant the onboarding agent admin permissions.";
const EXPECTED_REVERSIBLE = "You can customize the agent again after updating its identity.";

const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState({ user: null } as never);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function agentFixture() {
  return {
    id: "agent-onboarding",
    name: "cindy",
    displayName: "Cindy",
    runtime: "claude",
    status: "idle",
    description: "Onboarding agent",
    serverRole: "member",
    deletedAt: null,
    createdAgents: [],
  };
}

function seedOnboardingAgent() {
  const agent = agentFixture();
  useAuthStore.setState({
    user: { id: "user-1", name: "Owner" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      slug: "playwright-server",
      name: "Playwright Server",
      role: "owner",
      onboardingAgentId: agent.id,
    },
    members: [],
  } as never);
  useMachineStore.setState({ machines: [] } as never);
  useChannelStore.setState({ openDM: () => undefined } as never);
  useAgentStore.setState({
    agents: [agent],
    activityLogs: {},
  } as never);
  return agent;
}

function stubAdoptionPreview(afterRole: "admin" | "member") {
  api.get = (async (url: string) => {
    if (url === `/agents/agent-onboarding/onboarding-identity-adoption`) {
      return {
        data: {
          canAdopt: true,
          changes: [
            {
              field: "serverRole",
              label: "Server role",
              before: "member",
              after: afterRole,
            },
          ],
          currentIdentity: {
            name: "cindy",
            displayName: "Cindy",
            role: "Onboarding agent",
            serverRole: "member",
            avatarUrl: null,
          },
          officialIdentity: {
            name: "cindy",
            displayName: "Cindy",
            role: "Onboarding agent",
            serverRole: afterRole,
            avatarUrl: null,
          },
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;
}

function renderAgent(agent: ReturnType<typeof agentFixture>) {
  return render(
    <MemoryRouter>
      <TestIntlProvider>
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("onboarding identity confirmation calls out an admin grant separately from the generic diff", async () => {
  assert.equal(en["agent.detail.updateIdentityAndAdminRole"], EXPECTED_ADMIN_TITLE);
  assert.equal(en["agent.detail.grantsAdminWarning"], EXPECTED_ADMIN_WARNING);
  assert.equal(en["agent.detail.updateIdentityAndRole"], EXPECTED_ADMIN_CONFIRM);
  assert.equal(en["agent.detail.customizeAfterIdentityUpdate"], EXPECTED_REVERSIBLE);

  const agent = seedOnboardingAgent();
  stubAdoptionPreview("admin");
  renderAgent(agent);

  const open = await screen.findByRole("button", { name: EXPECTED_IDENTITY_TITLE });
  fireEvent.click(open);

  await waitFor(() => {
    assert.ok(screen.getByRole("heading", { name: EXPECTED_ADMIN_TITLE }));
  });
  assert.ok(screen.getByText(EXPECTED_ADMIN_WARNING));
  assert.ok(screen.getByText(EXPECTED_REVERSIBLE));
  assert.ok(screen.getByRole("button", { name: EXPECTED_ADMIN_CONFIRM }));
  assert.ok(document.querySelector('[data-onboarding-identity-change="serverRole"]'));
});

test("identity-only onboarding confirmation does not frame a missing admin grant", async () => {
  assert.equal(en["agent.detail.updateIdentity"], EXPECTED_IDENTITY_CONFIRM);

  const agent = seedOnboardingAgent();
  stubAdoptionPreview("member");
  renderAgent(agent);

  const open = await screen.findByRole("button", { name: EXPECTED_IDENTITY_TITLE });
  fireEvent.click(open);

  await waitFor(() => {
    assert.ok(screen.getByRole("heading", { name: EXPECTED_IDENTITY_TITLE }));
  });
  assert.ok(
    screen.getByRole("button", { name: (accessibleName) => accessibleName === EXPECTED_IDENTITY_CONFIRM }),
    "identity-only confirm must keep the ordinary Update identity label",
  );
  assert.equal(screen.queryByRole("button", { name: EXPECTED_ADMIN_CONFIRM }), null);
  assert.equal(screen.queryByText(EXPECTED_ADMIN_WARNING), null);
  assert.equal(screen.queryByRole("heading", { name: EXPECTED_ADMIN_TITLE }), null);
});
