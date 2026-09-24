import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ManagedMcpServerView } from "@botiverse/raft-shared";
import type { Locale } from "../src/i18n/locale";

import api from "../src/api/client";
import { AgentMcpTab } from "../src/components/agent/AgentMcpTab";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";

function server(input: {
  id: string;
  name: string;
  usage: ManagedMcpServerView["usage"];
}): ManagedMcpServerView {
  return {
    id: input.id,
    name: input.name,
    description: `${input.name} description`,
    provider: "custom",
    authMode: "none",
    oauthStatus: "disconnected",
    transport: "streamable_http",
    endpointUrl: `https://${input.id}.example.com/mcp`,
    enabled: true,
    configVersion: 1,
    catalogVersion: 1,
    toolCatalog: [{
      name: "search",
      title: "Search",
      inputSchema: { type: "object" },
    }],
    lastCheckedAt: null,
    lastCheckError: null,
    credentialHeaderNames: [],
    hasCredentials: false,
    assignment: null,
    usage: input.usage,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

afterEach(cleanup);

test("Agent MCP catalog does not refetch when only the locale changes", async (t) => {
  let catalogRequests = 0;
  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/mcp/agents/agent-1");
    catalogRequests += 1;
    return {
      data: {
        servers: [],
        recommendations: [],
      },
    };
  });

  function TabWithLocale({ locale }: { locale: Locale }) {
    return (
      <TestIntlProvider locale={locale}>
        <AgentMcpTab agentId="agent-1" canManageServer={false} />
      </TestIntlProvider>
    );
  }

  const view = render(<TabWithLocale locale="en" />);

  await waitFor(() => assert.equal(catalogRequests, 1));

  view.rerender(<TabWithLocale locale="zh-cn" />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(catalogRequests, 1);
});

test("Agent MCP renders only actual usage and exposes no assignment controls", async (t) => {
  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/mcp/agents/agent-1");
    return {
      data: {
        servers: [
          server({
            id: "used-docs",
            name: "Used docs",
            usage: {
              invocationCount: 3,
              lastInvokedAt: "2026-07-27T01:02:03.000Z",
              lastToolName: "search",
            },
          }),
          server({ id: "unused-linear", name: "Unused Linear", usage: null }),
        ],
        recommendations: [],
      },
    };
  });

  renderWithIntl(<AgentMcpTab agentId="agent-1" canManageServer={false} />);

  assert.ok(await screen.findByText("Used docs"));
  assert.ok(screen.getByText("3 calls"));
  assert.ok(screen.getByText("search"));
  assert.equal(screen.queryByText("Unused Linear"), null);
  assert.equal(screen.queryByRole("checkbox"), null);
  assert.equal(screen.queryByRole("button", { name: /apply/i }), null);
});

test("Agent MCP explains automatic availability before first use", async (t) => {
  t.mock.method(api, "get", async () => ({
    data: {
      servers: [server({ id: "unused-docs", name: "Unused docs", usage: null })],
      recommendations: [],
    },
  }));

  renderWithIntl(<AgentMcpTab agentId="agent-1" canManageServer={false} />);

  assert.ok(await screen.findByText("No MCP usage yet"));
  assert.ok(screen.getByText(
    "Enabled MCP servers are available automatically and appear here after this Agent calls one.",
  ));
});

test("Server MCP renders accessible shared actions and opens the shared delete confirmation", async (t) => {
  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/mcp/servers");
    return {
      data: {
        servers: [server({ id: "docs", name: "Docs", usage: null })],
        recommendations: [],
      },
    };
  });

  renderWithIntl(<AgentMcpTab scope="server" canManageServer />);

  assert.ok(await screen.findByText("Docs"));
  assert.ok(screen.getByRole("button", { name: "Add server" }));
  assert.ok(screen.getByRole("button", { name: "Test Docs" }));
  assert.ok(screen.getByRole("button", { name: "Edit Docs" }));

  fireEvent.click(screen.getByRole("button", { name: "Delete Docs" }));
  assert.ok(await screen.findByRole("dialog"));
  assert.ok(screen.getByText("Delete MCP server"));
  assert.ok(screen.getByText("Delete Docs? This removes it from every Agent runtime and usage view."));
});
