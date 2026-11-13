import { useCallback, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Text, TextLink } from "@botiverse/raft-ui";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { groupQuietFailures } from "./activityQuietFailures";
import type { QuietFailureTurn } from "./activityQuietFailures";

function QuietFailureRun<T extends QuietFailureTurn>({ turns, keyOf, Turn, Badges }: {
  turns: T[];
  keyOf: (turn: T) => string;
  Turn: ComponentType<{ turn: T; turnKey: string }>;
  Badges: ComponentType<{ turn: T }>;
}) {
  const intl = useIntl();
  const { formatClock, formatShortDateTime } = useTimeFormatter();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const first = turns[0]!;
  const last = turns.at(-1)!;
  // The latest report wins: a later retry may have heard a newer reset.
  const resetsAt = [...turns].reverse().find((turn) => turn.usageLimit?.resetsAt !== undefined)?.usageLimit?.resetsAt;
  const summary: ReactNode = last.usageLimit
    ? resetsAt !== undefined
      ? intl.formatMessage({ id: "activity.overview.retries.usageLimitUntil" }, {
        reset: formatShortDateTime(resetsAt),
        count: turns.length,
      })
      : intl.formatMessage({ id: "activity.overview.retries.usageLimit" }, { count: turns.length })
    : intl.formatMessage({ id: "activity.overview.retries.failed" }, { count: turns.length });
  return (
    <section className="flex flex-col gap-2" data-testid="activity-overview-retries" data-turn-key={keyOf(first)}>
      <div className="flex flex-wrap items-baseline gap-2">
        <Text.Heading className="font-mono text-mono-code font-bold tracking-normal text-foreground">
          {intl.formatMessage({ id: "activity.overview.turn.range" }, { start: formatClock(first.startedAt), end: formatClock(last.endedAt) })}
        </Text.Heading>
        <Badges turn={last} />
      </div>
      <span className="text-callout text-foreground-muted">{summary}</span>
      <TextLink className="self-start text-caption" onClick={toggle} aria-expanded={open}>
        {intl.formatMessage({ id: open ? "activity.overview.retries.hide" : "activity.overview.retries.show" }, { count: turns.length })}
      </TextLink>
      {open ? (
        <div className="flex flex-col gap-4 border-l border-border pl-4">
          {turns.map((turn) => <Turn key={keyOf(turn)} turnKey={keyOf(turn)} turn={turn} />)}
        </div>
      ) : null}
    </section>
  );
}

/** The overview's finished turns, oldest first, each run of retries that did nothing folded into one entry. */
export function TurnsWithQuietFailureRuns<T extends QuietFailureTurn>({ turns, keyOf, Turn, Badges }: {
  turns: readonly T[];
  keyOf: (turn: T) => string;
  Turn: ComponentType<{ turn: T; turnKey: string }>;
  Badges: ComponentType<{ turn: T }>;
}) {
  return (
    <>
      {groupQuietFailures(turns).map((item) => (item.kind === "turn"
        ? <Turn key={keyOf(item.turn)} turnKey={keyOf(item.turn)} turn={item.turn} />
        : <QuietFailureRun key={`run:${keyOf(item.turns[0]!)}`} turns={item.turns} keyOf={keyOf} Turn={Turn} Badges={Badges} />))}
    </>
  );
}
