import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render } from "@testing-library/react";
import AgentActivityDot from "../src/components/agent/AgentActivityDot";
import StatusDot from "../src/components/ui/StatusDot";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";

afterEach(() => {
  cleanup();
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
});

test("StatusDot external prop forces bg-brutal-cyan regardless of activity", () => {
  const external = render(<StatusDot activity="online" external />);
  assert.match(
    external.container.firstElementChild?.className ?? "",
    /(^|\s)bg-brutal-cyan(\s|$)/,
    "external=true must produce bg-brutal-cyan, ignoring activity",
  );
  assert.doesNotMatch(
    external.container.firstElementChild?.className ?? "",
    /(^|\s)bg-brutal-lime(\s|$)/,
    "external tone must not keep the managed online lime",
  );
  cleanup();

  const managed = render(<StatusDot activity="online" />);
  assert.match(
    managed.container.firstElementChild?.className ?? "",
    /(^|\s)bg-brutal-lime(\s|$)/,
    "managed online remains lime so the external override is not vacuous",
  );
});

test("AgentActivityDot passes external agent identity through to StatusDot", () => {
  useAgentStore.setState({
    agents: [
      {
        id: "agent-external",
        name: "ext",
        displayName: "External",
        status: "active",
        avatarUrl: null,
        external: true,
        runtime: "external",
      },
      {
        id: "agent-managed",
        name: "local",
        displayName: "Local",
        status: "active",
        avatarUrl: null,
        external: false,
        runtime: "builtin",
      },
    ],
    agentActivities: {},
  } as never);

  const external = render(
    <TestIntlProvider>
      <AgentActivityDot agentId="agent-external" />
    </TestIntlProvider>,
  );
  assert.match(
    external.container.firstElementChild?.className ?? "",
    /(^|\s)bg-brutal-cyan(\s|$)/,
    "external agents must render the neutral cyan status dot",
  );
  cleanup();

  const managed = render(
    <TestIntlProvider>
      <AgentActivityDot agentId="agent-managed" />
    </TestIntlProvider>,
  );
  assert.match(
    managed.container.firstElementChild?.className ?? "",
    /(^|\s)bg-brutal-lime(\s|$)/,
    "managed online agents still use the lime liveness dot",
  );
});
