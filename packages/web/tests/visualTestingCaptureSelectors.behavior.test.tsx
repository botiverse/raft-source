import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import RuntimeConfigFields from "../src/components/agent/RuntimeConfigFields";
import MessageInput from "../src/components/message/MessageInput";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function seedComposer() {
  api.get = (async () => ({ data: { agents: [], humans: [] } })) as typeof api.get;
  useAuthStore.setState({ user: { id: "visual-user" } } as never);
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { "visual-channel": [] },
    currentChannelId: "visual-channel",
    messages: [],
    sendMessage: async () => ({}),
  } as never);
}

test("the mounted composer capture exposes its stable interaction selectors", () => {
  seedComposer();
  render(
    <MemoryRouter>
      <TestIntlProvider locale="en">
        <MessageInput
          channelId="visual-channel"
          channelName="#visual"
          showTaskButton
          onSendOverride={async () => undefined}
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByTestId("composer-media-input"));
  assert.ok(screen.getByTestId("composer-as-task-toggle"));
});

test("the mounted Claude runtime fields expose their provider-mode selector", () => {
  const noop = () => undefined;
  render(
    <TestIntlProvider locale="en">
      <RuntimeConfigFields
        runtime="claude"
        onRuntimeChange={noop}
        runtimeOptions={[{ value: "claude", label: "Claude" }]}
        model="sonnet"
        onModelChange={noop}
        customModelMode={false}
        onCustomModelModeChange={noop}
        modelOptions={[{ value: "sonnet", label: "Claude Sonnet" }]}
        runtimeModels={{ source: { kind: "unsupported" }, models: [], loading: false, rescan: noop }}
        providerMode="custom"
        onProviderModeChange={noop}
        providerApiUrl="https://gateway.example.com"
        onProviderApiUrlChange={noop}
        providerApiKey="secret"
        onProviderApiKeyChange={noop}
        builtInProviderMode={"deepseek"}
        onBuiltInProviderModeChange={noop}
        piProviderMode="configured"
        onPiProviderModeChange={noop}
        piProviderApiKey=""
        onPiProviderApiKeyChange={noop}
        fastMode={false}
        onFastModeChange={noop}
        command="claude"
        onCommandChange={noop}
        reasoningEffort={null}
        onReasoningEffortChange={noop}
        envVarEntries={[]}
        onEnvVarEntriesChange={noop}
      />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByTestId("runtime-provider-mode-select"));
});
