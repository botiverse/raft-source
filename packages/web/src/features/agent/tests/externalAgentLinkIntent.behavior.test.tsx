import "../../../../tests/helpers/domSetup";

// `?dialog=connect-external-agent` (an announcement's button) opens Connect an external agent on any page,
// once: the query is removed straight away, so a reload or Back doesn't open it again. Only whoever can
// create agents in the open Server gets it, as with the Members page's menu.
import assert from "node:assert/strict";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, test } from "vitest";
import { useServerStore } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { ExternalAgentLinkIntent } from "../ExternalAgentLinkIntent";

const TITLE = "Create external agent";

function Where() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</span>;
}

function setServer(role: string | null) {
  useServerStore.setState({ current: { id: "server-1", name: "Server", slug: "server", ownerId: "user-1", role, plan: "pro" }, members: [] } as never);
}

function renderAt(entry: string) {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[entry]}>
        <ExternalAgentLinkIntent />
        <Where />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => cleanup());

test("the link opens Connect an external agent and leaves the rest of the address alone", async () => {
  setServer("admin");
  renderAt("/s/server/channel/general?dialog=connect-external-agent&x=1#m-1");
  assert.ok(await screen.findByText(TITLE));
  assert.equal(screen.getByTestId("where").textContent, "/s/server/channel/general?x=1#m-1");
});

test("a member, who can't create agents, gets nothing, and the query is still removed", async () => {
  setServer("member");
  renderAt("/s/server/channel/general?dialog=connect-external-agent");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.ok(screen.queryByText(TITLE) === null, "no dialog for a member");
  assert.equal(screen.getByTestId("where").textContent, "/s/server/channel/general");
});

test("a role that arrives after the link still opens it", async () => {
  setServer(null);
  renderAt("/s/server/channel/general?dialog=connect-external-agent");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.ok(screen.queryByText(TITLE) === null, "not before the role is known");
  act(() => setServer("owner"));
  assert.ok(await screen.findByText(TITLE));
});

test("another dialog's link is left for its own intent", () => {
  setServer("owner");
  renderAt("/s/server/channel/general?dialog=create-joint-channel");
  assert.equal(screen.getByTestId("where").textContent, "/s/server/channel/general?dialog=create-joint-channel");
});
