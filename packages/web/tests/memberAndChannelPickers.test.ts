import assert from "node:assert/strict";
import "./helpers/domSetup";
import { createElement } from "react";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import MemberPicker, { useMemberPickerCandidates } from "../src/components/pickers/MemberPicker";
import type { MemberKind, MemberPickerCandidate } from "../src/components/pickers/MemberPicker";
import ChannelPicker, { useChannelPickerCandidates } from "../src/components/pickers/ChannelPicker";
import type { ChannelPickerScope } from "../src/components/pickers/ChannelPicker";
import type { Channel } from "../src/store/channelStore";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

const renderIntl = (element: ReactElement) =>
  render(createElement(TestIntlProvider, null, element));

afterEach(() => {
  cleanup();
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, channelLocalMembership: {} } as never);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

const candidates: MemberPickerCandidate[] = [
  { kind: "agent", id: "agent-wug", name: "Wug", secondary: null, avatarUrl: null },
  { kind: "agent", id: "agent-zed", name: "Zed", secondary: null, avatarUrl: null },
  { kind: "human", id: "user-mei", name: "Mei", secondary: null, avatarUrl: null },
];

function renderMemberPicker(options: {
  kinds?: MemberKind[];
  value: string[];
  multiple: boolean;
  maxItems?: number;
}) {
  const changes: string[][] = [];
  renderIntl(createElement(MemberPicker, {
    presentation: "selectable",
    candidates,
    kinds: options.kinds ?? ["human", "agent"],
    value: options.value,
    onChange: (next: string[]) => { changes.push(next); },
    multiple: options.multiple,
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  }));
  return changes;
}

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled")
    || element.getAttribute("aria-disabled") === "true"
    || element.hasAttribute("data-disabled");
}

test("MemberPicker kinds filter lists only the requested kinds", () => {
  renderMemberPicker({ kinds: ["agent"], value: [], multiple: true });
  assert.equal(screen.queryByText("Agents") !== null, true);
  assert.equal(screen.queryByText("Humans") === null, true);
  assert.equal(screen.queryByText("Wug") !== null, true);
  assert.equal(screen.queryByText("Mei") === null, true);

  cleanup();
  renderMemberPicker({ kinds: ["human"], value: [], multiple: true });
  assert.equal(screen.queryByText("Agents") === null, true);
  assert.equal(screen.queryByText("Mei") !== null, true);
  assert.equal(screen.queryByText("Wug") === null, true);
});

test("MemberPicker multiple appends and removes ids", () => {
  const changes = renderMemberPicker({ value: ["agent-wug"], multiple: true });
  fireEvent.click(screen.getByRole("checkbox", { name: "Mei" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Wug" }));
  assert.deepEqual(changes, [["agent-wug", "user-mei"], []]);
});

test("MemberPicker single is a radio group: one value, replaced, never capped", () => {
  const changes = renderMemberPicker({ value: ["agent-wug"], multiple: false });
  assert.equal(screen.queryByRole("checkbox") === null, true);
  assert.equal(screen.getByRole("radio", { name: "Wug" }).getAttribute("aria-checked"), "true");
  // A single picker has no cap: every other row stays choosable.
  assert.equal(isDisabled(screen.getByRole("radio", { name: "Mei" })), false);
  fireEvent.click(screen.getByRole("radio", { name: "Mei" }));
  assert.deepEqual(changes, [["user-mei"]]);
});

test("MemberPicker maxItems blocks unselected candidates at the cap", () => {
  const changes = renderMemberPicker({ value: ["agent-wug"], multiple: true, maxItems: 1 });
  assert.equal(isDisabled(screen.getByRole("checkbox", { name: "Mei" })), true);
  assert.equal(isDisabled(screen.getByRole("checkbox", { name: "Wug" })), false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Mei" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Wug" }));
  assert.deepEqual(changes, [[]]);
});

test("MemberPicker removable lists only selected candidates", () => {
  const changes: string[][] = [];
  renderIntl(createElement(MemberPicker, {
    presentation: "removable",
    removeLabel: (name: string) => `Remove ${name}`,
    candidates,
    kinds: ["human", "agent"],
    value: ["agent-zed", "user-mei"],
    onChange: (next: string[]) => { changes.push(next); },
    multiple: true,
  }));
  assert.equal(screen.queryByText("Wug") === null, true);
  assert.equal(screen.queryByText("Zed") !== null, true);
  fireEvent.click(screen.getByRole("button", { name: "Remove Mei" }));
  assert.deepEqual(changes, [["agent-zed"]]);
});

test("useMemberPickerCandidates server scope reads the local directory", () => {
  useServerStore.setState({
    members: [{ userId: "user-mei", name: "mei", displayName: "Mei", description: null, avatarUrl: null }],
  } as never);
  useAgentStore.setState({
    agents: [
      { id: "agent-wug", name: "wug", displayName: "Wug", avatarUrl: null, description: null, deletedAt: null },
      { id: "agent-gone", name: "gone", displayName: "Gone", avatarUrl: null, description: null, deletedAt: "2026-10-01T00:00:00.000Z" },
    ],
  } as never);
  function Harness() {
    const serverCandidates = useMemberPickerCandidates({ scope: "server" });
    return createElement(MemberPicker, {
      presentation: "selectable",
      candidates: serverCandidates,
      kinds: ["human", "agent"],
      value: [],
      onChange: () => {},
      multiple: true,
    });
  }
  renderIntl(createElement(Harness));
  assert.equal(screen.queryByText("Wug") !== null, true);
  assert.equal(screen.queryByText("Mei") !== null, true);
  assert.equal(screen.queryByText("Gone") === null, true);
});

function channel(overrides: Partial<Channel> & { id: string; name: string }): Channel {
  return {
    description: null,
    type: "channel",
    createdAt: "2026-10-01T00:00:00.000Z",
    joined: true,
    ...overrides,
  } as Channel;
}

const channels = [
  channel({ id: "c-general", name: "general" }),
  channel({ id: "c-design", name: "design" }),
];

function renderChannelPicker(options: { value: string[]; multiple: boolean; single?: "choose" | "radio"; maxItems?: number; disabled?: boolean }) {
  const changes: Array<{ next: string[]; toggled: string }> = [];
  renderIntl(createElement(ChannelPicker, {
    channels,
    value: options.value,
    onChange: (next: string[], toggled: Channel) => { changes.push({ next, toggled: toggled.id }); },
    ...(options.multiple
      ? { multiple: true as const, ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}) }
      : options.single === "radio"
        ? { multiple: false as const, single: "radio" as const, onChange: (next: string[]) => { changes.push({ next, toggled: next[0] ?? "" }); } }
        : { multiple: false as const, single: "choose" as const }),
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
  }));
  return changes;
}

test("ChannelPicker multiple toggles checkbox rows", () => {
  const changes = renderChannelPicker({ value: ["c-general"], multiple: true });
  const general = screen.getByRole("checkbox", { name: "#general" });
  assert.equal(general.getAttribute("aria-checked"), "true");
  fireEvent.click(screen.getByRole("checkbox", { name: "#design" }));
  fireEvent.click(general);
  assert.deepEqual(changes, [
    { next: ["c-general", "c-design"], toggled: "c-design" },
    { next: [], toggled: "c-general" },
  ]);
});

test("ChannelPicker single rows are buttons that choose one channel", () => {
  const changes = renderChannelPicker({ value: ["c-general"], multiple: false, single: "choose" });
  assert.equal(screen.queryByRole("checkbox") === null, true);
  fireEvent.keyDown(screen.getByRole("button", { name: "#design" }), { key: "Enter" });
  assert.deepEqual(changes, [{ next: ["c-design"], toggled: "c-design" }]);
});

test("ChannelPicker single radio holds one channel in a form", () => {
  const changes = renderChannelPicker({ value: ["c-general"], multiple: false, single: "radio" });
  assert.equal(screen.queryByRole("button") === null, true);
  assert.equal(screen.getByRole("radio", { name: "general" }).getAttribute("aria-checked"), "true");
  assert.equal(screen.getByRole("radio", { name: "design" }).getAttribute("aria-checked"), "false");
  fireEvent.click(screen.getByText("design"));
  assert.deepEqual(changes, [{ next: ["c-design"], toggled: "c-design" }]);
});

test("a single radio picker's None row clears it; the radio sits at the row's end", () => {
  const changes: Array<{ next: string[] }> = [];
  renderIntl(createElement(ChannelPicker, {
    channels, value: ["c-general"], multiple: false, single: "radio", noneLabel: "None",
    onChange: (next: string[]) => { changes.push({ next }); },
  }));
  const rows = screen.getAllByRole("radio");
  assert.equal(rows[0]?.getAttribute("aria-checked"), "false");
  assert.equal(rows[0]?.closest("label")?.textContent, "None");
  // The radio comes after the name, at the row's end, as a checkbox does.
  const general = screen.getByRole("radio", { name: "general" });
  const name = screen.getByText("general");
  assert.equal(Boolean(name.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING), true);
  fireEvent.click(screen.getByText("None"));
  assert.deepEqual(changes, [{ next: [] }]);

  cleanup();
  const memberChanges: string[][] = [];
  renderIntl(createElement(MemberPicker, {
    presentation: "selectable", candidates, kinds: ["human", "agent"], value: ["agent-wug"], multiple: false, noneLabel: "None",
    onChange: (next: string[]) => { memberChanges.push(next); },
  }));
  assert.equal(screen.getAllByRole("radio")[0]?.closest("label")?.textContent, "None");
  fireEvent.click(screen.getByText("None"));
  assert.deepEqual(memberChanges, [[]]);
});

test("ChannelPicker maxItems and disabled block rows", () => {
  const changes = renderChannelPicker({ value: ["c-general"], multiple: true, maxItems: 1 });
  const design = screen.getByRole("checkbox", { name: "#design" });
  assert.equal(design.getAttribute("aria-disabled"), "true");
  assert.equal(design.getAttribute("tabindex"), "-1");
  fireEvent.click(design);
  assert.deepEqual(changes, []);

  cleanup();
  const disabledChanges = renderChannelPicker({ value: [], multiple: true, disabled: true });
  fireEvent.click(screen.getByRole("checkbox", { name: "#general" }));
  assert.deepEqual(disabledChanges, []);
});

test("useChannelPickerCandidates scopes joined and visible channels", () => {
  useChannelStore.setState({
    channels: [
      channel({ id: "c-joined", name: "joined" }),
      channel({ id: "c-open", name: "open", joined: false }),
      channel({ id: "c-archived", name: "archived", archivedAt: "2026-10-02T00:00:00.000Z" }),
      channel({ id: "c-thread", name: "thread", type: "thread" }),
    ],
  } as never);
  function Harness({ scope }: { scope: ChannelPickerScope }) {
    const scoped = useChannelPickerCandidates(scope);
    return createElement(ChannelPicker, { channels: scoped, value: [], onChange: () => {}, multiple: true });
  }
  const optionIds = () => screen.queryAllByRole("checkbox")
    .map((row) => row.getAttribute("data-testid") ?? "")
    .join(",");

  renderIntl(createElement(Harness, { scope: "joined" }));
  assert.equal(optionIds(), "channel-picker-option-c-joined");

  cleanup();
  renderIntl(createElement(Harness, { scope: "visible" }));
  assert.equal(optionIds(), "channel-picker-option-c-joined,channel-picker-option-c-open");
});

test("forward list: destinations picked from search count toward the 10-destination cap", async () => {
  const { default: ForwardComposerTargetList } = await import("../src/components/message/ForwardComposerTargetList");
  const { localSelectionKey } = await import("../src/components/message/forwardComposerModel");
  const targets = Array.from({ length: 12 }, (_, i) => channel({ id: `c-${i}`, name: `room-${i}` }));
  const selected = new Map<string, { key: string; label: string }>();
  // Three destinations picked from search (not in the local list) …
  for (const id of ["s-1", "s-2", "s-3"]) selected.set(`search:${id}`, { key: `search:${id}`, label: id });
  // … and seven local rows: 10 in all, so every other local row is blocked.
  for (const target of targets.slice(0, 7)) {
    const key = localSelectionKey("server-1", target.id);
    selected.set(key, { key, label: target.name });
  }
  renderIntl(createElement(ForwardComposerTargetList, {
    currentServerId: "server-1",
    isSearchMode: false,
    lowerQuery: "",
    searchResults: [],
    searchLoading: false,
    searchFailed: false,
    filteredTargets: targets,
    channelTargets: targets,
    dmTargets: [],
    channelLocalMembership: {},
    selectedDestinations: selected as never,
    joinInFlight: false,
    isMobile: false,
    mobileMultiSelect: false,
    chooseDestination: () => {},
    retrySearch: () => {},
  }));
  assert.equal(screen.getByTestId("forward-target-c-6").getAttribute("aria-disabled"), "false");
  assert.equal(screen.getByTestId("forward-target-c-7").getAttribute("aria-disabled"), "true");
  assert.equal(screen.getByTestId("forward-target-c-11").getAttribute("aria-disabled"), "true");
});
