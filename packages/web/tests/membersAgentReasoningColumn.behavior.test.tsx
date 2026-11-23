import "./helpers/domSetup";

import assert from "node:assert/strict";
import { RUNTIME_CONFIG_VERSION } from "@botiverse/raft-shared";
import { cleanup, screen } from "@testing-library/react";
import { createIntl } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { MembersAgentGroup } from "../src/features/members/MembersAgentList";
import type { MemberEntry } from "../src/features/members/membersPageModel";
import { mergedMessages } from "../src/i18n/messages";
import type { Agent } from "../src/store/agentStore";
import { reasoningEffortDisplayLabel } from "../src/utils/reasoningEffortOptions";
import { renderWithIntl } from "./helpers/intl";

// The Members › Agents list's Reasoning column: its heading between Model and
// Computer, and each agent's level as its profile's Reasoning row shows it (the
// same hydration and labels): a shared level's label, a runtime's own level
// as-is, "Default" when none is set, or a dash for a runtime that takes no
// reasoning effort. The row's description says the level is the reasoning.

afterEach(cleanup);

function agentEntry(id: string, fields: Partial<Agent>): MemberEntry {
  const agent = {
    id,
    name: id,
    displayName: id,
    description: null,
    status: "active",
    runtime: "claude",
    model: "sonnet",
    reasoningEffort: null,
    machineId: null,
    envVars: null,
    executionMode: "byoc",
    serverRole: null,
    ...fields,
  } as Agent;
  return { kind: "agent", id, name: id, handle: id, agent };
}

function show(entries: MemberEntry[], locale?: "zh-cn") {
  renderWithIntl(
    <MemoryRouter>
      <MembersAgentGroup
        heading={null}
        entries={entries}
        machinesById={new Map()}
        showComputer
        showColumnHeadings
        openKey={null}
        onOpen={() => {}}
      />
    </MemoryRouter>,
    { locale },
  );
}

/** The heading row's column labels, in order: each heading cell's own visible
 *  label (Status's cell also holds its invisible sizer words). */
function headings(): string[] {
  const line = screen.getByTestId("members-agent-group").firstElementChild!;
  return [...line.children].flatMap((cell) => {
    const label = cell.querySelector<HTMLElement>("[data-status-sizer]")
      ? cell.firstElementChild
      : cell;
    const text = label?.textContent ?? "";
    return text ? [text] : [];
  });
}

function config(fields: Record<string, unknown>): Agent["runtimeConfig"] {
  return { version: RUNTIME_CONFIG_VERSION, ...fields } as Agent["runtimeConfig"];
}

function reasoningCell(id: string): string | null {
  return screen.getByTestId(`members-agent-reasoning-${id}`).textContent;
}

function description(id: string): string {
  const ids = screen.getByTestId(`members-agent-row-${id}`).getAttribute("aria-describedby") ?? "";
  return ids.split(" ").map((part) => document.getElementById(part)?.textContent ?? "").join(" | ");
}

test("Reasoning sits between Model and Computer", () => {
  show([agentEntry("a1", {})]);
  assert.deepEqual(headings(), ["Status", "Runtime", "Model", "Reasoning", "Computer"]);
});

test("its heading says it as the agent profile does, in zh-cn too", () => {
  show([agentEntry("a1", {})], "zh-cn");
  assert.deepEqual(headings(), ["状态", "运行时", "模型", "推理强度", "计算机"]);
});

test("a set level shows its label; the stored runtime config's level wins", () => {
  show([
    agentEntry("high", { runtime: "codex", model: "gpt-5.5", reasoningEffort: "high" }),
    agentEntry("xhigh", {
      runtime: "claude",
      reasoningEffort: "low",
      runtimeConfig: config({ runtime: "claude", reasoningEffort: "xhigh" }),
    }),
  ]);
  assert.equal(reasoningCell("high"), "High");
  assert.equal(reasoningCell("xhigh"), "Extra high");
});

test("a dash for a runtime without reasoning effort or an App's identity; Default when none is set", () => {
  show([
    agentEntry("unsupported", { runtime: "gemini", model: "gemini-2.5-pro", reasoningEffort: "high" }),
    agentEntry("app", { runtime: "claude", reasoningEffort: "high", managedByAppInstallId: "install-1" }),
    agentEntry("unset", { runtime: "claude", reasoningEffort: null }),
  ]);
  for (const id of ["unsupported", "app"]) {
    assert.equal(screen.getByTestId(`members-agent-reasoning-${id}`).textContent, "—", id);
  }
  assert.equal(screen.getByTestId("members-agent-reasoning-unset").textContent, "Default");
});

test("a runtime's own level (Kimi Code's) reads as-is, as in the profile, not as Default", () => {
  show([
    agentEntry("kimi", {
      runtime: "kimi-sdk",
      model: "kimi-k2",
      runtimeConfig: config({ runtime: "kimi-sdk", model: { kind: "default" }, reasoningEffort: "thinking-max" }),
    }),
  ]);
  assert.equal(reasoningCell("kimi"), "thinking-max");
});

test("the profile's Reasoning row and the hover card label a level with the same helper", () => {
  const { formatMessage } = createIntl({ locale: "en", messages: mergedMessages("en") });
  const label = (runtime: string, reasoningEffort: string | null) => reasoningEffortDisplayLabel({ runtime, reasoningEffort }, formatMessage);
  assert.equal(label("kimi-sdk", "thinking-max"), "thinking-max");
  assert.equal(label("claude", "toString"), "toString");
  assert.equal(label("codex", "xhigh"), "Extra high");
  assert.equal(label("codex", null), "Default");
  assert.equal(label("gemini", "high"), null);
});

test("the runtime config decides as the profile hydrates it", () => {
  show([
    // The saved config's runtime wins over the agent's own: no effort on Gemini.
    agentEntry("saved-gemini", {
      runtime: "claude",
      reasoningEffort: "high",
      runtimeConfig: config({ runtime: "gemini", model: { kind: "default" } }),
    }),
    // A saved config with no level falls back to the agent's own.
    agentEntry("saved-unset", {
      runtime: "codex",
      model: "gpt-5.5",
      reasoningEffort: "low",
      runtimeConfig: config({ runtime: "codex", model: { kind: "default" }, reasoningEffort: null }),
    }),
    // A saved config of another version is ignored: the agent's fields decide.
    agentEntry("other-version", {
      runtime: "claude",
      reasoningEffort: "medium",
      runtimeConfig: { version: RUNTIME_CONFIG_VERSION + 1, runtime: "gemini", reasoningEffort: "high" } as unknown as Agent["runtimeConfig"],
    }),
  ]);
  assert.equal(reasoningCell("saved-gemini"), "—");
  assert.equal(reasoningCell("saved-unset"), "Low");
  assert.equal(reasoningCell("other-version"), "Medium");
});

test("the row's description says the level is its reasoning, and leaves out a dash", () => {
  show([
    agentEntry("high", { runtime: "codex", model: "gpt-5.5", reasoningEffort: "high" }),
    agentEntry("unsupported", { runtime: "gemini", model: "gemini-2.5-pro" }),
  ]);
  assert.match(description("high"), /\| Reasoning: High \|/);
  assert.doesNotMatch(description("unsupported"), /Reasoning/);
  // The cell itself shows the bare level.
  assert.equal(reasoningCell("high"), "High");
});
