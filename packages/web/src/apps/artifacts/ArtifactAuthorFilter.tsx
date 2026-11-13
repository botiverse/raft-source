import { useCallback, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { UserRound } from "lucide-react";
import {
  ComboboxGroup,
  ComboboxItem,
  ComboboxItemIndicator,
} from "@botiverse/raft-ui";
import type { ArtifactDashboardAuthor, ArtifactShownActor } from "@botiverse/raft-shared";

import { ArtifactActorAvatar } from "./ArtifactActorParts";
import { ArtifactFilterCombobox, FilterChoicesFailed, FilterChoicesLoading } from "./ArtifactFilterCombobox";
import { authorValueOf, authorsOnScreen } from "./artifactDashboardAuthors";
import { CHOSEN_BOLD } from "./artifactDashboardParts";
import { artifactActorName } from "./artifactFacts";
import { artifactSource } from "./artifactSource";
import { useFilterChoices } from "./useFilterChoices";
import type { FilterChoicesSource } from "./useFilterChoices";

/**
 * The home page's author filter (#proj-workspace:#133, design D18;
 * #proj-workspace:#221, one value): the search over the people and agents who
 * wrote what the reader can see, the reader among them by name, searchable by
 * name and handle, each agent saying whose assistant it is ("Remy's assistant").
 * The control is the Conversation filter's (ArtifactFilterCombobox).
 *
 * The choices come from `dashboardAuthors` (#12881: most frequent first, `q`
 * asked once typing pauses, its answer shown as it is: the server matches
 * handles and names). A server without the route yet (404, an older one): the
 * authors of the cards on screen (`seen`), most frequent first, searched here by
 * name, handle and whose assistant. Any other failure says so in the list with
 * Try again. The route still takes several values, `me` and `my-agents` (other
 * clients use them); this page sends one person or agent.
 */

const AUTHORS: FilterChoicesSource<ArtifactShownActor> = {
  ask: (q) => artifactSource().dashboardAuthors({ q }).then(({ authors }) => authors),
  keyOf: (actor) => `${actor.type}:${actor.id}`,
  matches: ({ name, displayName }, words) => name.toLocaleLowerCase().includes(words) || displayName.toLocaleLowerCase().includes(words),
};

export function ArtifactAuthorFilter({ value, onChange, seen, readerId, testId }: {
  value: ArtifactDashboardAuthor | null;
  onChange: (value: ArtifactDashboardAuthor | null) => void;
  /** The authors of the cards on screen: names for the chosen one, and the stand-in choices. */
  seen: readonly ArtifactShownActor[];
  readerId: string | null;
  testId: string;
}) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { rows, phase, answer, retry } = useFilterChoices(open, query, AUTHORS);
  const missing = phase === "missing";
  const choices = useMemo(() => (missing ? authorsOnScreen(seen) : rows), [missing, seen, rows]);
  // Who a chosen value names, kept once seen, so the trigger names them when the list has moved on.
  const known = useRef(new Map<string, ArtifactShownActor>());
  for (const actor of [...choices, ...seen]) if (actor.id) known.current.set(authorValueOf({ type: actor.type, id: actor.id }), actor);

  const labelOf = useCallback((author: string) => {
    const actor = known.current.get(author);
    return actor ? artifactActorName(actor, formatMessage) : formatMessage({ id: "artifacts.dashboard.author.unknown" });
  }, [formatMessage]);
  const hintOf = useCallback((author: string): string | null => {
    const actor = known.current.get(author);
    if (!actor || actor.type !== "agent") return null;
    const behalf = actor.onBehalfOf;
    // An agent of no one: its face says it is an agent (#250: no "agent" beside it).
    if (!behalf) return null;
    return behalf.id === readerId
      ? formatMessage({ id: "artifacts.dashboard.author.yourAssistant" })
      : formatMessage({ id: "artifacts.dashboard.author.assistantOf" }, { name: behalf.displayName });
  }, [formatMessage, readerId]);

  const items = useMemo(() => choices.flatMap((actor) => (actor.id ? [authorValueOf({ type: actor.type, id: actor.id })] : [])), [choices]);
  const words = query.trim().toLocaleLowerCase();
  // The server's answer (handles and names) is shown as it is, and useFilterChoices filters what waits for one. The on-screen stand-in is searched here.
  const shown = useMemo(() => (!missing || words === "" ? items : items.filter((author) => {
    const handle = known.current.get(author)?.name ?? "";
    return [labelOf(author), handle, hintOf(author) ?? ""].some((text) => text.toLocaleLowerCase().includes(words));
  })), [missing, words, items, labelOf, hintOf]);

  // The picker's values are strings: only the values it offered go on.
  const change = useCallback((next: string | null) => {
    onChange(items.find((author) => author === next) ?? null);
  }, [onChange, items]);
  const chosen = value === null ? null : labelOf(value);
  const actorChosen = value === null ? undefined : known.current.get(value);
  const footer = phase === "failed" ? (
    <FilterChoicesFailed
      message={formatMessage({ id: "artifacts.dashboard.author.failed" })}
      retryLabel={formatMessage({ id: "artifacts.dashboard.retry" })}
      onRetry={retry}
      testId={`${testId}-failed`}
    />
  ) : phase === "pending" && shown.length === 0 ? (
    <FilterChoicesLoading label={formatMessage({ id: "common.loading" })} testId={`${testId}-loading`} />
  ) : (phase === "ok" || missing) && shown.length === 0 ? (
    <p className="px-3 py-2 text-callout text-foreground-muted">{formatMessage({ id: "artifacts.dashboard.author.noMatch" })}</p>
  ) : null;

  return (
    <ArtifactFilterCombobox
      testId={testId}
      icon={actorChosen ? <ArtifactActorAvatar actor={actorChosen} context="picker-trigger" /> : <UserRound aria-hidden className="size-3.5" />}
      name={formatMessage({ id: "artifacts.dashboard.author.label" })}
      value={value}
      valueLabel={chosen}
      appliedLabel={chosen === null ? null : formatMessage({ id: "artifacts.dashboard.author.applied" }, { authors: chosen })}
      clearLabel={formatMessage({ id: "artifacts.dashboard.author.clear" })}
      onValue={change}
      items={shown}
      answer={answer}
      labelOf={labelOf}
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQuery={setQuery}
      searchLabel={formatMessage({ id: "artifacts.dashboard.author.searchLabel" })}
      searchPlaceholder={formatMessage({ id: "artifacts.dashboard.author.searchPlaceholder" })}
      footer={footer}
    >
      {shown.length > 0 ? (
        <ComboboxGroup>
          {shown.map((author) => {
            const actor = known.current.get(author);
            const hint = hintOf(author);
            return (
              <ComboboxItem key={author} value={author} className={CHOSEN_BOLD} data-testid={`${testId}-item`} data-author={author}>
                <span className="flex min-w-0 items-center gap-1.5">
                  {/* The face is decoration: the option is named by the name (an initial would read as "PPat"). */}
                  <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                    {actor ? <ArtifactActorAvatar actor={actor} context="picker-trigger" /> : null}
                  </span>
                  <span className="truncate">{labelOf(author)}</span>
                  {hint ? <span className="truncate text-footnote text-foreground-hint">{hint}</span> : null}
                </span>
                <ComboboxItemIndicator />
              </ComboboxItem>
            );
          })}
        </ComboboxGroup>
      ) : null}
    </ArtifactFilterCombobox>
  );
}
