import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, test } from "vitest";

import { MentionSuggestionList } from "../src/components/mention/MentionSuggestionList";
import type { MentionPicker, MentionSuggestionGroup } from "../src/components/mention/useMentionPicker";
import { ChannelAutocompleteList } from "../src/components/message/ChannelAutocompleteList";
import { chatMentionGroups } from "../src/components/message/chatMentionGroups";
import type { MentionCandidate } from "../src/components/message/mentionCandidates";
import type { Channel } from "../src/store/channelStore";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

function person(name: string): MentionCandidate {
  return { id: `user-${name}`, name, displayName: name, type: "user", avatarUrl: null };
}

function group(key: string, names: string[], separated = false): MentionSuggestionGroup {
  return { key, ariaLabel: key, separated, items: names.map((name) => ({ candidate: person(name) })) };
}

// Three groups with rows, and an empty one between them that draws nothing.
const GROUPS = [
  group("here", ["ada", "bob"]),
  group("nobody", []),
  group("elsewhere", ["cy", "dee", "eve"], true),
  group("linked", ["fay"], true),
];
const FLAT = GROUPS.flatMap((g) => g.items.map((item) => item.candidate));

function picker(index: number): MentionPicker {
  return {
    show: true,
    visible: true,
    query: "",
    index,
    startPos: 0,
    popupRef: { current: null },
    detect: () => false,
    dismiss: () => {},
    buildInsert: () => null,
    handleKeyDown: () => false,
    groups: GROUPS,
    flat: FLAT,
    listbox: {
      label: "People",
      listId: "list",
      optionId: (flatIndex: number) => `list-option-${flatIndex}`,
      inputProps: { "aria-autocomplete": "list", "aria-controls": "list", "aria-activedescendant": `list-option-${index}` },
    },
  } as unknown as MentionPicker;
}

function renderList(index: number) {
  return render(
    <TestIntlProvider>
      <MentionSuggestionList picker={picker(index)} onSelect={() => {}} testId="list" optionTestId={(candidate) => `option-${candidate.name}`} />
    </TestIntlProvider>,
  );
}

function row(name: string): { acIndex: string | null; id: string; highlighted: boolean; selected: string | null } {
  const option = screen.getByTestId(`option-${name}`);
  return {
    acIndex: option.getAttribute("data-ac-index"),
    id: option.id,
    highlighted: option.getAttribute("data-highlighted") === "true",
    selected: option.getAttribute("aria-selected"),
  };
}

// The arrows move one index through the whole list (useMentionPicker's `flat`),
// so a row's number has to count the rows of every group before its own.
test("rows are numbered in list order across groups, an empty group taking no number", () => {
  renderList(0);
  const names = FLAT.map((candidate) => candidate.name);
  assert.deepEqual(names.map((name) => row(name).acIndex), ["0", "1", "2", "3", "4", "5"]);
  assert.deepEqual(names.map((name) => row(name).id), names.map((_, i) => `list-option-${i}`));
  // And they are drawn in that order.
  const drawn = [...screen.getByTestId("list").querySelectorAll("[data-ac-index]")].map((el) => el.getAttribute("data-testid"));
  assert.deepEqual(drawn, names.map((name) => `option-${name}`));
});

test("the highlight follows the index into a later group: exactly the row the keyboard would pick", () => {
  for (const [index, candidate] of FLAT.entries()) {
    const view = renderList(index);
    const highlighted = FLAT.filter((other) => row(other.name).highlighted).map((other) => other.name);
    assert.deepEqual(highlighted, [candidate.name], `index ${index}`);
    const selected = FLAT.filter((other) => row(other.name).selected === "true").map((other) => other.name);
    assert.deepEqual(selected, [candidate.name], `index ${index}`);
    view.unmount();
  }
});

test("MentionSuggestionList ArrowDown highlight step re-renders only the 2 affected rows (O(1), not O(N))", () => {
  const rowRenders = new Map<string, number>();
  const candidates: MentionCandidate[] = Array.from({ length: 20 }, (_, i) => {
    const name = `agent-${i}`;
    const candidate: MentionCandidate = {
      id: `id-${i}`,
      name,
      displayName: name,
      type: "agent",
      avatarUrl: null,
    };
    Object.defineProperty(candidate, "description", {
      enumerable: true,
      get() {
        rowRenders.set(name, (rowRenders.get(name) ?? 0) + 1);
        return `Role ${i}`;
      },
    });
    return candidate;
  });

  const onSelect = () => {};
  const formatMsg = (({ id }: { id: string }) => id) as never;
  const makePicker = (index: number): MentionPicker => {
    // Rebuild fresh wrapper items via chatMentionGroups on each render, matching MessageInput.
    const groups = chatMentionGroups(
      { inChannel: candidates.slice(0, 10), externals: [], notInChannel: candidates.slice(10), flat: candidates },
      formatMsg,
    );
    return {
      show: true,
      visible: true,
      query: "",
      index,
      startPos: 0,
      popupRef: { current: null },
      detect: () => false,
      dismiss: () => {},
      buildInsert: () => null,
      handleKeyDown: () => false,
      groups,
      flat: candidates,
      listbox: null,
    } as unknown as MentionPicker;
  };

  const view = render(
    <TestIntlProvider>
      <MentionSuggestionList picker={makePicker(0)} onSelect={onSelect} testId="perf-mention-list" />
    </TestIntlProvider>,
  );

  assert.equal(rowRenders.size, 20);
  rowRenders.clear();

  // Moving highlight from index 0 -> 1 must only re-render agent-0 and agent-1.
  view.rerender(
    <TestIntlProvider>
      <MentionSuggestionList picker={makePicker(1)} onSelect={onSelect} testId="perf-mention-list" />
    </TestIntlProvider>,
  );

  assert.deepEqual([...rowRenders.keys()].sort(), ["agent-0", "agent-1"]);
});

test("ChannelAutocompleteList ArrowDown highlight step re-renders only the 2 affected rows (O(1), not O(N))", () => {
  const rowRenders = new Map<string, number>();
  const channels: Channel[] = Array.from({ length: 25 }, (_, i) => {
    const id = `ch-${i}`;
    const channel: Channel = {
      id,
      name: `channel-${i}`,
      description: `Topic ${i}`,
      type: "channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      joined: true,
    };
    Object.defineProperty(channel, "description", {
      enumerable: true,
      get() {
        rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1);
        return `Topic ${i}`;
      },
    });
    return channel;
  });

  const onSelect = () => {};
  const popupRef = { current: null };

  const view = render(
    <TestIntlProvider>
      <ChannelAutocompleteList
        visible={true}
        channels={channels}
        highlightedIndex={0}
        popupRef={popupRef}
        onSelect={onSelect}
      />
    </TestIntlProvider>,
  );

  assert.equal(rowRenders.size, 25);
  rowRenders.clear();

  view.rerender(
    <TestIntlProvider>
      <ChannelAutocompleteList
        visible={true}
        channels={channels}
        highlightedIndex={1}
        popupRef={popupRef}
        onSelect={onSelect}
      />
    </TestIntlProvider>,
  );

  assert.deepEqual([...rowRenders.keys()].sort(), ["ch-0", "ch-1"]);
});
