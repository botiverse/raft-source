import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import type { Locale } from "../src/i18n/locale";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const CATALOGS: Record<Locale, Record<string, string>> = { en, "zh-cn": zh };

const CONFIRM_IDS = [
  "agent.detail.switchRuntimeActiveMessage",
  "agent.detail.switchRuntimeInactiveMessage",
  "agent.detail.switchModelResetMessage",
  "agent.detail.restartToApplyRuntimeConfigMessage",
] as const;

const LIVE_MODELS: Record<string, { id: string; label: string }[]> = {
  grok: [
    { id: "grok-4", label: "Grok 4" },
    { id: "composer-fast", label: "Composer Fast" },
  ],
  claude: [
    { id: "opus", label: "Claude Opus" },
    { id: "sonnet", label: "Claude Sonnet" },
  ],
  codex: [
    { id: "gpt-sol", label: "GPT Sol" },
    { id: "gpt-terra", label: "GPT Terra" },
  ],
};

function declaredPlaceholders(msg: string): string[] {
  const names = new Set<string>();
  for (const match of msg.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*(?:,|\})/g)) names.add(match[1]);
  return [...names];
}

function assertNoPlaceholderLeak(text: string, messageId: (typeof CONFIRM_IDS)[number], locale: Locale) {
  for (const placeholder of declaredPlaceholders(CATALOGS[locale][messageId])) {
    assert.equal(
      text.includes(`{${placeholder}}`),
      false,
      `${messageId} (${locale}) leaked {${placeholder}} in: ${text}`,
    );
  }
}

function clickSelectOption(trigger: HTMLElement, optionName: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  return screen.findByRole("listbox").then((listbox) => {
    const option = within(listbox).getByRole("option", { name: optionName });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

function seedAgent(overrides: {
  runtime: string;
  model: string;
  status: string;
  runtimes: string[];
}) {
  const agent = {
    id: "agent-1",
    name: "witty",
    runtime: overrides.runtime,
    model: overrides.model,
    status: overrides.status,
    machineId: "machine-1",
    runtimeConfig: {
      version: 1,
      runtime: overrides.runtime,
      model: { kind: "preset", id: overrides.model },
      mode: { kind: "default" },
      reasoningEffort: null,
    },
  };
  useAuthStore.setState({ user: { id: "user-1", name: "Owner" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "s", name: "S", role: "owner" },
    members: [],
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "m",
      status: "online",
      runtimes: overrides.runtimes,
    }],
  } as never);
  useChannelStore.setState({ openDM: () => undefined } as never);
  useAgentStore.setState({ agents: [agent], activityLogs: {}, agentActivities: {} } as never);

  api.post = (async (url: string) =>
    url === "/feature-flags/evaluate"
      ? { data: { evaluations: [] } }
      : { data: {} }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/agents/agent-1/runtime-options") {
      return {
        data: {
          options: overrides.runtimes.map((runtimeId) => ({
            runtimeId,
            canSelectInThisContext: true,
          })),
        },
      };
    }
    if (url === "/provider-connections") {
      return { data: { connections: [], providerOptions: [] } };
    }
    const runtimeModelsMatch = url.match(/\/runtime-models\/([^/?]+)$/);
    if (runtimeModelsMatch) {
      const models = LIVE_MODELS[runtimeModelsMatch[1]] ?? [];
      return {
        data: {
          kind: "live",
          value: { models, default: models[0]?.id },
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;

  return agent;
}

function renderPanel(agent: ReturnType<typeof seedAgent>, locale: Locale) {
  return render(
    <MemoryRouter>
      <TestIntlProvider locale={locale}>
        <AgentDetailPanel agent={agent as never} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

async function openRuntimeEditor(locale: Locale) {
  const catalog = CATALOGS[locale];
  const opener = await waitFor(() => {
    const el = document.querySelector(`[title="${catalog["agent.detail.editRuntimeConfig"]}"]`);
    assert.ok(el);
    return el as HTMLElement;
  });
  fireEvent.click(opener);
  return screen.findByRole("button", { name: catalog["agent.detail.saveRuntimeConfig"] }) as Promise<HTMLButtonElement>;
}

async function saveEnabledConfig(save: HTMLButtonElement) {
  await waitFor(() => assert.equal(save.disabled, false, "runtime change should enable save"));
  fireEvent.click(save);
}

function confirmDialog() {
  return screen.getByRole("dialog");
}

HTMLElement.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState({ agents: [], activityLogs: {}, agentActivities: {} } as never);
  useServerStore.setState({ current: null, members: [] } as never);
  useAuthStore.setState({ user: null } as never);
});

test("runtime confirmation catalogs never declare an unsupplied placeholder name", () => {
  for (const id of CONFIRM_IDS) {
    assert.ok(en[id], `${id} missing from en`);
    assert.ok(zh[id], `${id} missing from zh`);
  }
  assert.match(en["agent.detail.switchModelResetMessage"], /\{reasoning, select, none \{\}/);
  assert.match(zh["agent.detail.switchModelResetMessage"], /\{reasoning, select, none \{\}/);
});

for (const locale of ["en", "zh-cn"] as const) {
  const catalog = CATALOGS[locale];

  test(`switching runtime on an active agent interpolates the confirmation instead of leaking braces (${locale})`, async () => {
    const agent = seedAgent({
      runtime: "grok",
      model: "grok-4",
      status: "active",
      runtimes: ["grok", "claude"],
    });
    renderPanel(agent, locale);

    const save = await openRuntimeEditor(locale);
    const runtimeTrigger = screen.getAllByRole("combobox").find((el) => /Grok Build/i.test(el.textContent ?? ""));
    assert.ok(runtimeTrigger, "runtime selector should show Grok Build");
    const fromLabel = (runtimeTrigger.textContent ?? "").trim();
    runtimeTrigger.focus();
    fireEvent.keyDown(runtimeTrigger, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox).getAllByRole("option").find((el) => !/Grok Build/i.test(el.textContent ?? ""));
    assert.ok(option, "a non-Grok runtime option should exist");
    const toLabel = option.textContent?.trim() ?? "";
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => assert.match(runtimeTrigger.textContent ?? "", new RegExp(toLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
    await saveEnabledConfig(save);

    const dialog = confirmDialog();
    const text = dialog.textContent ?? "";
    assert.ok(text.includes(fromLabel.split("(")[0].trim()));
    assert.ok(text.includes(toLabel.split("(")[0].trim()));
    assertNoPlaceholderLeak(text, "agent.detail.switchRuntimeActiveMessage", locale);
    assert.ok(within(dialog).getByRole("button", { name: catalog["agent.detail.resetRuntimeSession"] }));
  });

  test(`switching runtime on an inactive agent interpolates the inactive confirmation (${locale})`, async () => {
    const agent = seedAgent({
      runtime: "grok",
      model: "grok-4",
      status: "inactive",
      runtimes: ["grok", "claude"],
    });
    renderPanel(agent, locale);

    const save = await openRuntimeEditor(locale);
    const runtimeTrigger = screen.getAllByRole("combobox").find((el) => /Grok Build/i.test(el.textContent ?? ""));
    assert.ok(runtimeTrigger, "runtime selector should show Grok Build");
    runtimeTrigger.focus();
    fireEvent.keyDown(runtimeTrigger, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox).getAllByRole("option").find((el) => !/Grok Build/i.test(el.textContent ?? ""));
    assert.ok(option);
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => assert.equal((runtimeTrigger.textContent ?? "").includes("Grok Build"), false));
    await saveEnabledConfig(save);

    const dialog = confirmDialog();
    const text = dialog.textContent ?? "";
    assertNoPlaceholderLeak(text, "agent.detail.switchRuntimeInactiveMessage", locale);
    assert.ok(within(dialog).getByRole("button", { name: catalog["agent.detail.saveRuntimeChange"] }));
  });

  test(`a same-runtime model change on an active agent interpolates the restart confirmation (${locale})`, async () => {
    const agent = seedAgent({
      runtime: "grok",
      model: "grok-4",
      status: "active",
      runtimes: ["grok"],
    });
    renderPanel(agent, locale);

    const save = await openRuntimeEditor(locale);
    const modelTrigger = await waitFor(() => {
      const select = screen.getAllByRole("combobox").find((el) => (el.textContent ?? "").includes("Grok 4"));
      assert.ok(select);
      return select;
    });
    await clickSelectOption(modelTrigger, "Composer Fast");
    await waitFor(() => assert.match(modelTrigger.textContent ?? "", /Composer Fast/));
    await saveEnabledConfig(save);

    const dialog = confirmDialog();
    const text = dialog.textContent ?? "";
    assertNoPlaceholderLeak(text, "agent.detail.restartToApplyRuntimeConfigMessage", locale);
    assert.ok(within(dialog).getByRole("button", { name: catalog["agent.detail.restartAgent"] }));
  });

  test(`a Codex model change interpolates the session-reset confirmation without leaking braces (${locale})`, async () => {
    const agent = seedAgent({
      runtime: "codex",
      model: "gpt-sol",
      status: "active",
      runtimes: ["codex"],
    });
    renderPanel(agent, locale);

    const save = await openRuntimeEditor(locale);
    const modelTrigger = await waitFor(() => {
      const select = screen.getAllByRole("combobox").find((el) => (el.textContent ?? "").includes("GPT Sol"));
      assert.ok(select);
      return select;
    });
    await clickSelectOption(modelTrigger, "GPT Terra");
    await waitFor(() => assert.match(modelTrigger.textContent ?? "", /GPT Terra/));
    await saveEnabledConfig(save);

    const dialog = confirmDialog();
    const text = dialog.textContent ?? "";
    assert.match(text, /gpt-terra/);
    assert.doesNotMatch(text, /\(\s*reasoning\)/);
    assertNoPlaceholderLeak(text, "agent.detail.switchModelResetMessage", locale);
    assert.ok(within(dialog).getByRole("button", { name: catalog["agent.detail.reset"] }));
  });
}
