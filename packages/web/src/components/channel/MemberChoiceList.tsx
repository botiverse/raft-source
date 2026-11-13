import { useMemo } from "react";
import type { ReactNode } from "react";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { usePeopleSuggestionSearch } from "../../hooks/usePeopleSuggestionSearch";
import type { PeopleSuggestionCandidate } from "../../utils/peopleSuggestionSearch";

/** A person or agent to pick: the shared people-search fields, plus how its row looks. */
export interface MemberChoice<T> extends PeopleSuggestionCandidate<T> {
  /** The avatar before the name. */
  media: ReactNode;
  /** A mark after the name, such as an App's App badge. */
  badge?: ReactNode;
  /** Up to two lines under the name, such as the description, or that adding failed. */
  lines?: ReactNode[];
}

/** A choice's value in the list: kind and id, as an agent and a person may share an id. */
export function memberChoiceKey(kind: "agent" | "human", id: string): string {
  return `${kind}:${id}`;
}

/**
 * The people search @mentions use (handle, display name, description, server;
 * ranked, in a worker for long lists), run over the choices: the keys it
 * matched, in its order, for `MemberChoiceList`'s `matchedValues`, or
 * undefined while there is no search text or a worker is still ranking the
 * first one. Then ChoiceList matches each row's `searchText` (name, handle,
 * description) itself, so the list never flashes "No match" while it waits;
 * later queries keep the previous ranking until the next arrives.
 */
export function useMemberChoiceSearch<T>(query: string, choices: PeopleSuggestionCandidate<T>[]) {
  const { ranked } = usePeopleSuggestionSearch(query, choices);
  return useMemo(
    () => (query.trim() && ranked ? ranked.map((choice) => memberChoiceKey(choice.kind, choice.id)) : undefined),
    [query, ranked],
  );
}

/**
 * The member pickers (a new channel's members, a joint channel's, the members
 * panel's Add) are raft-ui's ChoiceList: an open list of checkbox rows under
 * an Agents and a People heading, with a search box at any count, since people
 * look for someone they know by name (DS › ChoiceList, search "always").
 *
 * The search is the people search @mentions use (`useMemberChoiceSearch`), so
 * a person is found the same way wherever they are picked; the caller runs it
 * and passes its matches. The caller owns the search text, for its no-match
 * line and its footer ("Create an agent named …").
 */
export function MemberChoiceList<T>({
  choices,
  value,
  onValueChange,
  query,
  onQueryChange,
  matchedValues,
  ariaLabel,
  groupLabels,
  searchLabel,
  searchPlaceholder,
  clearSearchLabel,
  noMatchLabel,
  empty,
  footer,
  fill,
  disabled,
}: {
  choices: MemberChoice<T>[];
  /** The chosen choices' `memberChoiceKey`s. */
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** `useMemberChoiceSearch(query, choices)`. */
  matchedValues: readonly string[] | undefined;
  ariaLabel: string;
  groupLabels: { agent: ReactNode; human: ReactNode };
  searchLabel: string;
  /** Defaults to `searchLabel`. */
  searchPlaceholder?: string;
  clearSearchLabel: string;
  noMatchLabel: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  fill?: boolean;
  disabled?: boolean;
}) {
  const items = useMemo<ChoiceListItem[]>(() => choices.map((choice) => ({
    value: memberChoiceKey(choice.kind, choice.id),
    // With a badge the name truncates and the badge stays visible.
    label: choice.badge ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate">{choice.displayName || choice.handle}</span>
        {choice.badge}
      </span>
    ) : choice.displayName || choice.handle,
    // ChoiceList's own match, used only until the people search answers.
    searchText: [choice.displayName, choice.handle, choice.description].filter(Boolean).join(" "),
    media: choice.media,
    description: choice.lines,
    group: choice.kind,
  })), [choices]);
  const groups = useMemo(() => [
    { value: "agent", label: groupLabels.agent },
    { value: "human", label: groupLabels.human },
  ], [groupLabels.agent, groupLabels.human]);

  return (
    <ChoiceList
      multiple
      search="always"
      aria-label={ariaLabel}
      searchLabel={searchLabel}
      searchPlaceholder={searchPlaceholder ?? searchLabel}
      clearSearchLabel={clearSearchLabel}
      noMatchLabel={noMatchLabel}
      empty={empty}
      searchValue={query}
      onSearchValueChange={onQueryChange}
      matchedValues={matchedValues}
      groups={groups}
      items={items}
      value={value}
      onValueChange={onValueChange}
      footer={footer}
      fill={fill}
      disabled={disabled}
    />
  );
}
