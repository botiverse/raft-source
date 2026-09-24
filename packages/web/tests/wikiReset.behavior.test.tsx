import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import WikiSettingsSection from "../src/components/settings/WikiSettingsSection";
import WikiPanel from "../src/components/wiki/WikiPanel";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

function seedWikiServer(role: "owner" | "member") {
  useServerStore.setState({
    current: {
      id: "server-1",
      slug: "wiki-reset-server",
      name: "Wiki Reset Server",
      role,
    },
  } as never);
  useChannelStore.setState({ openDM: async () => ({ id: "dm-1" }) } as never);
}

function stubActiveWiki() {
  api.get = (async (url: string) => {
    if (url === "/wiki/status") {
      return {
        data: {
          space: {
            status: "active" as const,
            wikiAgentId: "agent-1",
            wikiAgentName: "WikiAgent",
            wikiChannelId: "channel-1",
            wikiChannelName: "Wiki",
            lastIngestReceiptId: "receipt-1",
          },
          lastJob: null,
        },
      };
    }
    return { data: { pages: [], index: null, log: null } };
  }) as typeof api.get;
}

function renderWiki() {
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <WikiPanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function renderWikiSettings() {
  return render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <WikiSettingsSection />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useServerStore.setState({ current: null } as never);
});

test("Wiki reset lives in Settings and does not automatically start initialization", async () => {
  const posted: string[] = [];
  api.post = (async (url: string) => {
    posted.push(url);
    return { data: {} };
  }) as typeof api.post;

  const view = renderWikiSettings();
  fireEvent.click(view.getByRole("button", { name: "Reset Wiki" }));

  assert.ok(view.getByText(/Wiki channel, Wiki Agent, conversations/));
  assert.ok(view.getByText(/Old revisions remain stored but will no longer be referenced/));
  assert.ok(view.getByText(/Reset does not regenerate documents automatically/));
  fireEvent.click(view.getByTestId("wiki-reset-confirm"));

  await waitFor(() => assert.deepEqual(posted, ["/wiki/reset"]));
  assert.ok(await view.findByText(/Use Initialize Wiki when you are ready/));
});

test("the Wiki document surface no longer exposes Settings or Reset maintenance", async () => {
  seedWikiServer("owner");
  stubActiveWiki();
  const view = renderWiki();

  await view.findByText("Wiki");
  assert.equal(view.queryByTestId("wiki-settings-button"), null);
  assert.equal(view.queryByTestId("wiki-reset-open"), null);
});

test("global Settings owns the Wiki route and hides it without owner/admin authority", () => {
  const settingsPanel = readFileSync(resolve(import.meta.dirname, "../src/components/settings/SettingsPanel.tsx"), "utf8");
  const settingsModal = readFileSync(resolve(import.meta.dirname, "../src/components/settings/WorkspaceSettingsModal.tsx"), "utf8");
  const sidebar = readFileSync(resolve(import.meta.dirname, "../src/components/layout/Sidebar.tsx"), "utf8");

  assert.match(settingsPanel, /settingsTab === "wiki" && <WikiSettingsSection \/>/);
  assert.match(settingsPanel, /requestedSettingsTab === "wiki" && \(!wikiEnabled \|\| !capabilities\.editServerSettings\)/);
  assert.match(settingsModal, /!wikiEnabled \|\| !capabilities\.editServerSettings/);
  assert.match(sidebar, /wikiEnabled && canManageServer[\s\S]{0,240}settings\/wiki/);
});
