import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Badge, Text } from "@botiverse/raft-ui";
import { cn } from "@botiverse/raft-ui/cn";
import { clearClockInterval, currentTimeMs, setClockInterval } from "@botiverse/raft-shared";
import { formatRelativeTime } from "../../utils/relativeTime";

/**
 * The element renderers Raft's two json-render catalogs share (shared
 * cardElements.ts): App link cards (LinkCardElements.tsx, in the hover card)
 * and first-party action cards (actions/ActionCardSpecRenderer.tsx, in the
 * message). Each catalog walks its own tree and picks its own containers (a
 * link card's row is the item card's details row, an action card's button row
 * is the card's actions row); the leaves look the same in both. Every string
 * is React text, never HTML. Callers pass their own `data-*` markers through.
 */

type DataAttributes = { [key: `data-${string}`]: string | undefined };

/**
 * The `·` between two details on a row's one line (DS PreviewCard › Item
 * card), for link cards and card messages alike. Punctuation, not words:
 * hidden from assistive technology.
 */
export function CardRowSeparator(data: DataAttributes) {
  return <span aria-hidden="true" className="shrink-0 text-foreground-muted" {...data}>·</span>;
}

/** A column of elements, spaced by the design system. */
export function CardColumn({ children, ...data }: { children: ReactNode } & DataAttributes) {
  return <div className="flex min-w-0 flex-col gap-1.5" {...data}>{children}</div>;
}

// Static class names so Tailwind sees them; `clamp` is 1-6 in both catalogs' schemas.
export const CLAMP_CLASS = ["", "line-clamp-1", "line-clamp-2", "line-clamp-3", "line-clamp-4", "line-clamp-5", "line-clamp-6"] as const;

/**
 * A text: on one line, truncated, in a row; wrapping anywhere in a column, or
 * clamped to `clamp` lines.
 */
export function CardText({ tone, mono, inRow, clamp, children, ...data }: {
  tone: "default" | "muted" | "warning";
  mono: boolean;
  inRow: boolean;
  clamp?: number;
  children: ReactNode;
} & DataAttributes) {
  const className = cn(
    inRow ? "min-w-0 truncate" : "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
    !inRow && clamp ? CLAMP_CLASS[clamp] : undefined,
    // Warning text reads in warning-strong, as raft-ui's own warning lines do.
    tone === "warning" && "text-warning-strong",
  );
  const variant = tone === "muted" ? "muted" : tone === "default" ? "default" : undefined;
  // mono is for branch names, SHAs and ids: Space Mono at the ids-and-times size (text-mono-meta).
  return mono
    ? <Text.Mono size="meta" variant={variant} className={className} {...data}>{children}</Text.Mono>
    : <Text.Sans size="small" variant={variant} className={className} {...data}>{children}</Text.Sans>;
}

/**
 * A state in the sender's words, in a neutral soft Badge: no status color (DS
 * PreviewCard › Item card); callers keep the element's tone on their data
 * marker. One line, truncated.
 */
export function CardBadge({ inRow, children, ...data }: { inRow: boolean; children: ReactNode } & DataAttributes) {
  return (
    <Badge appearance="soft" className={cn("max-w-full", !inRow && "self-start")} {...data}>
      <span className="min-w-0 truncate">{children}</span>
    </Badge>
  );
}

/** Re-renders every `ms` while mounted; null: never. */
function useTick(ms: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (ms === null) return;
    const interval = setClockInterval(() => setTick((tick) => tick + 1), ms);
    return () => clearClockInterval(interval);
  }, [ms]);
}

/** "5 minutes ago", ticking, in Space Mono like every time. */
export function CardRelativeTime({ at, ...data }: { at: string } & DataAttributes) {
  const { locale } = useIntl();
  useTick(30_000);
  return <Text.Mono size="meta" variant="muted" className="shrink-0" render={<time dateTime={at} />} {...data}>{formatRelativeTime(at, locale)}</Text.Mono>;
}

/** How long something took: ticking while it runs, frozen once it has an `end`. */
export function CardDuration({ start, end, ...data }: { start: string; end?: string } & DataAttributes) {
  const { formatMessage } = useIntl();
  useTick(end ? null : 1000);
  const ms = Math.max(0, (end ? Date.parse(end) : currentTimeMs()) - Date.parse(start));
  const seconds = Math.floor(ms / 1000);
  return (
    <Text.Mono size="meta" variant="muted" className="shrink-0" render={<time dateTime={`PT${seconds}S`} />} {...data}>
      {formatCardDuration(formatMessage, seconds)}
    </Text.Mono>
  );
}

export function formatCardDuration(formatMessage: IntlShape["formatMessage"], seconds: number): string {
  if (seconds < 60) return formatMessage({ id: "message.appLink.card.duration.seconds" }, { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatMessage({ id: "message.appLink.card.duration.minutes" }, { minutes, seconds: seconds % 60 });
  return formatMessage({ id: "message.appLink.card.duration.hours" }, { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

// One line that, too long for its place, loses its start and keeps its end:
// a domain's registrable end (`…review.attacker.example`) is what says where
// the link goes. The box runs right to left so the ellipsis lands at the
// start; the text inside is isolated left to right, so the box can never
// reorder the host's characters.
export const KEEP_END = "overflow-hidden text-ellipsis whitespace-nowrap text-left [direction:rtl]";
export function KeptEnd({ text }: { text: string }) {
  return <span dir="ltr" className="[unicode-bidi:isolate]">{text}</span>;
}
