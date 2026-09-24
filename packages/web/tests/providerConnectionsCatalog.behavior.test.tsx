import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProviderConnectionProviderOption, ProviderConnectionSummary } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { __testInternals } from "../src/components/settings/ProviderConnectionsSettings";
import { TestIntlProvider } from "./helpers/intl";

const { ConnectionRow, CreateProviderConnectionModal, ProviderConnectionTestModal } = __testInternals;

afterEach(cleanup);

test("create-provider picker renders the complete server-projected builtin schema catalog", () => {
  const providerOptions: ProviderConnectionProviderOption[] = [
    { id: "deepseek", label: "DeepSeek", providerKind: "preset" },
    { id: "minimax", label: "MiniMax", providerKind: "preset" },
    { id: "openrouter", label: "OpenRouter", providerKind: "preset" },
    { id: "google", label: "Google", providerKind: "preset" },
    { id: "openai-compatible", label: "OpenAI Compatible", providerKind: "gateway" },
    { id: "anthropic-compatible", label: "Anthropic Compatible", providerKind: "gateway" },
  ];

  render(
    <TestIntlProvider>
      <CreateProviderConnectionModal
        providerOptions={providerOptions}
        onClose={() => undefined}
        onCreated={async () => undefined}
      />
    </TestIntlProvider>,
  );

  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);

  for (const provider of providerOptions) {
    assert.ok(screen.getAllByText(provider.label).length > 0);
  }
});

test("connection test keeps manual model entry available when discovery fails and sends the selected request", async (t) => {
  const connection: ProviderConnectionSummary = {
    id: "736b2dc6-dbe6-4733-b1ec-8b52daf25e27",
    name: "OpenAI Compatible",
    providerId: "openai-compatible",
    authMethod: "api_key",
    endpointUrl: "https://gateway.example.test/v1",
    supportsImageInput: false,
    enabled: true,
    status: "unchecked",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 0,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
  let submitted: unknown;
  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, `/provider-connections/${connection.id}/models`);
    throw new Error("catalog unavailable");
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    assert.equal(url, `/provider-connections/${connection.id}/test`);
    submitted = body;
    return { data: { ...connection, status: "ready" } };
  });

  render(
    <TestIntlProvider>
      <ProviderConnectionTestModal
        connection={connection}
        onClose={() => undefined}
        onCompleted={async () => undefined}
      />
    </TestIntlProvider>,
  );

  await screen.findByText("Models could not be refreshed. You can still enter a model ID.");
  fireEvent.change(screen.getByLabelText("Test model"), { target: { value: "custom-model-v2" } });
  fireEvent.change(screen.getByLabelText("Test message"), { target: { value: "Return compatible-ok." } });
  fireEvent.click(screen.getByRole("button", { name: "Send test" }));

  await waitFor(() => {
    assert.deepEqual(submitted, { model: "custom-model-v2", message: "Return compatible-ok." });
  });
});

test("assigned connections explain why delete is disabled and how to unblock it", () => {
  const connection: ProviderConnectionSummary = {
    id: "736b2dc6-dbe6-4733-b1ec-8b52daf25e27",
    name: "Shared DeepSeek",
    providerId: "deepseek",
    authMethod: "api_key",
    endpointUrl: null,
    supportsImageInput: false,
    enabled: true,
    status: "ready",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 1,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };

  render(
    <TestIntlProvider>
      <ConnectionRow
        connection={connection}
        providerOptions={[{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }]}
        canManage
        busy={false}
        onTest={() => undefined}
        onRename={() => undefined}
        onRotate={() => undefined}
        onToggle={() => undefined}
        onDelete={() => assert.fail("disabled delete must not run")}
      />
    </TestIntlProvider>,
  );

  const deleteButton = screen.getByRole("button", { name: "Delete connection" });
  assert.equal(deleteButton.getAttribute("aria-description"), "1 Agent uses this connection. Reassign it before deleting.");
  assert.equal(deleteButton.getAttribute("title"), "1 Agent uses this connection. Reassign it before deleting.");
  assert.equal(deleteButton.getAttribute("aria-disabled"), "true");
  assert.equal(deleteButton.hasAttribute("disabled"), false);
  fireEvent.click(deleteButton);
});
