import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getCreatableRuntimeOptions } from "@botiverse/raft-shared";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import {
  readCreateAgentLastConfig,
  writeCreateAgentLastConfig,
} from "../src/utils/createAgentLastConfig";
import type { Locale } from "../src/i18n/locale";
import { TestIntlProvider } from "./helpers/intl";

function render(
  ui: ReactElement,
  options: RenderOptions & { locale?: Locale } = {},
) {
  const { locale = "en", ...renderOptions } = options;
  return rtlRender(
    <TestIntlProvider locale={locale}>{ui}</TestIntlProvider>,
    renderOptions,
  );
}

const originalGet = api.get;
const originalPost = api.post;

function createRuntimeOption(runtimeId: string, available: boolean): RuntimeSelectionOption {
  return {
    runtimeId,
    capabilityStatus: available ? "available" : "not_installed",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: available,
  };
}

function stubCreateAgentGet(
  modelPayload: unknown,
  {
    grokEnabled = false,
    onModelRequest,
  }: { grokEnabled?: boolean; onModelRequest?: () => void } = {},
) {
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      const machineId = url.split("/").at(-2) ?? null;
      const installed = new Set(
        useMachineStore.getState().machines.find((machine) => machine.id === machineId)?.runtimes ?? [],
      );
      const options = getCreatableRuntimeOptions()
        .filter((runtime) => grokEnabled || runtime.id !== "grok")
        .map((runtime) => createRuntimeOption(runtime.id, installed.has(runtime.id)));
      return { data: { context: "new_agent", machineId, options } } as never;
    }
    onModelRequest?.();
    return { data: modelPayload } as never;
  }) as typeof api.get;
}

function makeAgent(): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    name: "Alice",
    displayName: "Alice",
    avatarUrl: "pixel:mug",
    description: null,
    status: "starting",
    model: "sonnet",
    runtime: "claude",
    serverRole: null,
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: "user",
    creatorId: "owner-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
  };
}

function seedStores() {
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
      createdAt: "2026-07-14T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: ["codex", "claude"],
      hostname: "mac.local",
      os: "darwin",
      daemonVersion: "0.72.6",
      lastHeartbeat: "2026-07-14T00:00:00.000Z",
      createdAt: "2026-07-14T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({ channels: [] } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

function hasSelectedValue(value: string): boolean {
  return screen.getAllByRole("combobox")
    .some((select) => select.textContent?.trim() === value);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("last create config is server-scoped, typed, and fails closed", () => {
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-1",
    runtime: "claude",
    model: "sonnet",
    customModelMode: false,
  });

  assert.deepEqual(readCreateAgentLastConfig("server-1"), {
    machineId: "machine-1",
    runtime: "claude",
    model: "sonnet",
    customModelMode: false,
  });
  assert.equal(readCreateAgentLastConfig("server-2"), null);

  localStorage.setItem(
    "raft:create-agent:last-config:v1:server-1",
    JSON.stringify({ machineId: "machine-1", runtime: "claude", model: "sonnet" }),
  );
  assert.equal(readCreateAgentLastConfig("server-1"), null);
});

test("regular Create Agent reopens with the last successful runtime and model", async () => {
  seedStores();
  stubCreateAgentGet({
    models: [
      { id: "opus", label: "Claude Opus" },
      { id: "sonnet", label: "Claude Sonnet" },
    ],
    default: "opus",
  });
  let createAttempts = 0;
  api.post = (async (url: string) => {
    assert.equal(url, "/agents");
    createAttempts += 1;
    if (createAttempts === 1) throw new Error("temporary failure");
    return { data: makeAgent() };
  }) as typeof api.post;

  const first = render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
  );

  const runtimeSelect = screen.getAllByRole("combobox")[1];
  assert.ok(runtimeSelect);
  fireEvent.click(runtimeSelect);
  const claudeRuntimeOption = await screen.findByRole("option", { name: "Claude Code" });
  fireEvent.pointerDown(claudeRuntimeOption);
  fireEvent.click(claudeRuntimeOption);
  await waitFor(() => assert.match(runtimeSelect.textContent ?? "", /Claude Code/));

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("Claude Opus"));
    assert.ok(select);
    return select;
  });
  fireEvent.click(modelSelect);
  const sonnetOption = await screen.findByRole("option", { name: "Claude Sonnet" });
  fireEvent.pointerDown(sonnetOption);
  fireEvent.click(sonnetOption);
  await waitFor(() => assert.match(modelSelect.textContent ?? "", /Claude Sonnet/));
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await screen.findByText("Failed to create agent");
  assert.equal(readCreateAgentLastConfig("server-1"), null);
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

  await waitFor(() => {
    assert.deepEqual(readCreateAgentLastConfig("server-1"), {
      machineId: "machine-1",
      runtime: "claude",
      model: "sonnet",
      customModelMode: false,
    });
  });

  first.unmount();
  useAgentStore.setState({ agents: [], loading: false } as never);
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog defaultMachineId="unavailable-machine" onClose={() => undefined} />
    </MemoryRouter>,
  );

  await waitFor(() => {
    assert.equal(hasSelectedValue("Claude Code"), true);
    assert.equal(hasSelectedValue("Claude Sonnet"), true);
  });
});

test("Claude's static model choice stays labeled while runtime admission is pending", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({
      ...machine,
      runtimes: ["claude"],
    })),
  }));

  let releaseRuntimeOptions!: () => void;
  const runtimeOptionsHeld = new Promise<void>((resolve) => {
    releaseRuntimeOptions = resolve;
  });
  let releaseRuntimeModels!: () => void;
  const runtimeModelsHeld = new Promise<void>((resolve) => {
    releaseRuntimeModels = resolve;
  });
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      await runtimeOptionsHeld;
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [createRuntimeOption("claude", true)],
        },
      } as never;
    }
    assert.match(url, /\/runtime-models\/claude$/);
    await runtimeModelsHeld;
    return {
      data: {
        kind: "live",
        value: {
          models: [
            { id: "opus", label: "Claude Opus" },
            { id: "fable", label: "Claude Fable" },
          ],
          default: "opus",
        },
      },
    } as never;
  }) as typeof api.get;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog defaultMachineId="machine-1" onClose={() => undefined} />
    </MemoryRouter>,
  );

  const modelSelect = await waitFor(() => {
    const select = screen.getAllByRole("combobox")
      .find((candidate) => candidate.textContent?.includes("Claude Opus"));
    assert.ok(select, "the pending admission draft must render the static Claude label, not raw 'opus'");
    return select;
  });
  fireEvent.click(modelSelect);
  const fableOption = await screen.findByRole("option", { name: "Claude Fable" });
  fireEvent.pointerDown(fableOption);
  fireEvent.click(fableOption);
  await waitFor(() => assert.match(modelSelect.textContent ?? "", /Claude Fable/));
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });

  await act(async () => releaseRuntimeOptions());
  await waitFor(() => {
    assert.equal(hasSelectedValue("Claude Code"), true);
    assert.match(modelSelect.textContent ?? "", /Claude Fable/);
  });
  assert.equal(
    (screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled,
    true,
    "an admitted runtime cannot submit while its static model source is still confirming",
  );

  await act(async () => releaseRuntimeModels());
  await waitFor(() => {
    assert.match(modelSelect.textContent ?? "", /Claude Fable/);
    assert.equal(
      (screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled,
      false,
    );
  });
});

test("Create Agent hides deprecated runtimes even when the Computer reports them", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({
      ...machine,
      runtimes: [...machine.runtimes, "gemini", "kimi", "antigravity"],
    })),
  }));
  stubCreateAgentGet({ models: [] });

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog defaultMachineId="machine-1" onClose={() => undefined} />
    </MemoryRouter>,
  );

  const runtimeSelect = screen.getAllByRole("combobox")[1];
  fireEvent.click(runtimeSelect);

  assert.equal(screen.queryByRole("option", { name: "Antigravity CLI" }), null);
  assert.equal(screen.queryByRole("option", { name: /Gemini CLI/i }), null);
  assert.equal(screen.queryByRole("option", { name: /Kimi CLI/i }), null);
});

test("Create Agent omits Grok when rollout admission is off even if the Computer reports it", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({
      ...machine,
      runtimes: [...machine.runtimes, "grok"],
    })),
  }));
  stubCreateAgentGet({ models: [] });

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog defaultMachineId="machine-1" onClose={() => undefined} />
    </MemoryRouter>,
  );

  const runtimeSelect = screen.getAllByRole("combobox")[1];
  fireEvent.click(runtimeSelect);

  assert.ok(await screen.findByRole("option", { name: "Claude Code" }));
  assert.equal(screen.queryByRole("option", { name: /Grok Build/i }), null);
});

test("explicit Computer context wins while remembered runtime and model remain availability-gated", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: [
      state.machines[0],
      {
        ...state.machines[0],
        id: "machine-2",
        name: "Studio",
        hostname: "studio.local",
        runtimes: ["claude"],
      },
    ],
  }));
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-2",
    runtime: "claude",
    model: "sonnet",
    customModelMode: false,
  });
  stubCreateAgentGet({ kind: "no_models" });

  const first = render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog defaultMachineId="machine-1" onClose={() => undefined} />
    </MemoryRouter>,
  );

  assert.ok(await screen.findByText("Mac (mac.local)"));
  await waitFor(() => {
    assert.equal(hasSelectedValue("Claude Code"), true);
    assert.equal(hasSelectedValue("Claude Sonnet"), false);
  });
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  assert.equal((screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled, true);

  first.unmount();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => machine.id === "machine-1"
      ? { ...machine, runtimes: ["codex"] }
      : machine),
  }));
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog defaultMachineId="machine-1" onClose={() => undefined} />
    </MemoryRouter>,
  );
  await waitFor(() => {
    assert.equal(hasSelectedValue("Codex CLI"), true);
    assert.equal(hasSelectedValue("Claude Code"), false);
  });
});

test("remembered defaults apply when the Computer list arrives after the dialog opens", async () => {
  seedStores();
  const machines = useMachineStore.getState().machines;
  useMachineStore.setState({ machines: [] });
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-1",
    runtime: "claude",
    model: "sonnet",
    customModelMode: false,
  });
  stubCreateAgentGet({
    models: [
      { id: "opus", label: "Claude Opus" },
      { id: "sonnet", label: "Claude Sonnet" },
    ],
    default: "opus",
  });

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
  );
  act(() => useMachineStore.setState({ machines }));

  await waitFor(() => {
    assert.equal(hasSelectedValue("Claude Code"), true);
    assert.equal(hasSelectedValue("Claude Sonnet"), true);
  });
});

test("selected OpenCode cannot submit after the Computer probe removes it", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({
      ...machine,
      runtimes: [...machine.runtimes, "opencode"],
    })),
  }));
  stubCreateAgentGet({
    models: [{ id: "opencode/gpt-5-nano", label: "GPT 5 Nano" }],
    default: "opencode/gpt-5-nano",
  });
  let createAttempts = 0;
  api.post = (async () => {
    createAttempts += 1;
    return { data: makeAgent() };
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog defaultMachineId="machine-1" onClose={() => undefined} />
    </MemoryRouter>,
  );

  const runtimeSelect = screen.getAllByRole("combobox")[1];
  fireEvent.click(runtimeSelect);
  const openCodeRuntimeOption = await screen.findByRole("option", { name: "OpenCode" });
  fireEvent.pointerDown(openCodeRuntimeOption);
  fireEvent.click(openCodeRuntimeOption);
  await waitFor(() => assert.match(runtimeSelect.textContent ?? "", /OpenCode/));
  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });

  act(() => useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["codex", "claude"] })),
  })));

  const createButton = screen.getByRole("button", { name: "Create Agent" });
  assert.equal((createButton as HTMLButtonElement).disabled, true);
  const form = createButton.closest("form");
  assert.ok(form);
  fireEvent.submit(form);

  await screen.findByText("The selected runtime is not installed on this computer");
  assert.equal(createAttempts, 0);
});

test("Kimi missing config shows login recovery, no model options, and blocks create", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  let modelChecks = 0;
  stubCreateAgentGet(
    { kind: "missing_config", recovery: "kimi_login" },
    { onModelRequest: () => { modelChecks += 1; } },
  );
  let createAttempts = 0;
  api.post = (async () => {
    createAttempts += 1;
    return { data: makeAgent() };
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
  );

  await waitFor(() => {
    const selectedValues = screen.getAllByRole("combobox").map((select) => select.textContent?.trim());
    assert.ok(selectedValues.includes("Kimi Code"), `selected values: ${JSON.stringify(selectedValues)}`);
  });
  assert.ok(await screen.findByText(/Kimi is not signed in on this Computer/));
  assert.ok(screen.getByText("kimi login"));
  assert.equal(hasSelectedValue("Kimi for Coding (default)"), false);

  const modelSelect = screen.getAllByRole("combobox")[2];
  assert.ok(modelSelect, "empty model source must render an empty model control");
  fireEvent.click(modelSelect);
  assert.equal(screen.queryByRole("option", { name: /Kimi for Coding/ }), null);

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  assert.equal((screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement).disabled, true);
  assert.equal(createAttempts, 0);

  const checksBeforeRetry = modelChecks;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(modelChecks, checksBeforeRetry + 1));
  assert.equal(createAttempts, 0);
});

test("Kimi missing config localizes recovery, rich command, and retry action in zh-cn", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  let modelChecks = 0;
  stubCreateAgentGet(
    { kind: "missing_config", recovery: "kimi_login" },
    { onModelRequest: () => { modelChecks += 1; } },
  );

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  await waitFor(() => assert.equal(hasSelectedValue("Kimi Code"), true));
  const recovery = await screen.findByTestId("runtime-model-source-status");
  assert.match(recovery.textContent ?? "", /此 Computer 尚未登录 Kimi/);
  const command = screen.getByText("kimi login");
  assert.equal(command.tagName, "CODE");

  const checksBeforeRetry = modelChecks;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => assert.equal(modelChecks, checksBeforeRetry + 1));
});

test("runtime model interpolation and rescan accessibility localize in zh-cn", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["kimi-sdk"] })),
  }));
  stubCreateAgentGet({ kind: "no_models" });

  const view = render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  assert.ok(await screen.findByText("Kimi Code 已配置，但此 Computer 未报告任何可用模型。"));

  view.unmount();
  stubCreateAgentGet({
    models: [{ id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" }],
    default: "kimi-code/kimi-for-coding",
  });
  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  const rescan = await screen.findByTitle("重新扫描此 Computer 上的模型");
  assert.equal(rescan.getAttribute("aria-label"), "重新扫描此 Computer 上的模型");
});

test("Cursor probe error cannot promote remembered bundled Auto into create options or submit", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({
      ...machine,
      runtimes: ["cursor"],
    })),
  }));
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-1",
    runtime: "cursor",
    model: "auto",
    customModelMode: false,
  });
  stubCreateAgentGet({ kind: "error", retryable: true });
  let createAttempts = 0;
  api.post = (async () => {
    createAttempts += 1;
    return { data: makeAgent() };
  }) as typeof api.post;

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
  );

  await waitFor(() => assert.equal(hasSelectedValue("Cursor CLI"), true));
  assert.equal(hasSelectedValue("Auto"), false);
  assert.ok(await screen.findByText("Could not load models from this Computer."));

  const modelSelect = screen.getAllByRole("combobox")[2];
  assert.ok(modelSelect, "Cursor error must render a model control without bundled presets");
  fireEvent.click(modelSelect);
  assert.equal(screen.queryByRole("option", { name: "Auto" }), null);

  fireEvent.change(screen.getByPlaceholderText("e.g. Alice"), { target: { value: "Alice" } });
  const createButton = screen.getByRole("button", { name: "Create Agent" });
  assert.equal((createButton as HTMLButtonElement).disabled, true);
  const form = createButton.closest("form");
  assert.ok(form);
  fireEvent.submit(form);
  assert.ok(await screen.findByText("Select a model reported by this computer, or enter an allowed custom model."));
  assert.equal(createAttempts, 0);
});

test("Cursor non-live model validation error is localized in zh-cn", async () => {
  seedStores();
  useMachineStore.setState((state) => ({
    machines: state.machines.map((machine) => ({ ...machine, runtimes: ["cursor"] })),
  }));
  writeCreateAgentLastConfig("server-1", {
    machineId: "machine-1",
    runtime: "cursor",
    model: "auto",
    customModelMode: false,
  });
  stubCreateAgentGet({ kind: "error", retryable: true });

  render(
    <MemoryRouter initialEntries={["/s/launch"]}>
      <CreateAgentDialog onClose={() => undefined} />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  await waitFor(() => assert.equal(hasSelectedValue("Cursor CLI"), true));
  assert.ok(await screen.findByText("无法从此 Computer 加载模型。"));
  fireEvent.change(screen.getByPlaceholderText("例如 Alice"), { target: { value: "Alice" } });
  const createButton = screen.getByRole("button", { name: "创建 Agent" });
  const form = createButton.closest("form");
  assert.ok(form);
  fireEvent.submit(form);
  assert.ok(await screen.findByText("请选择此 Computer 报告的模型，或输入允许的自定义模型。"));
});
