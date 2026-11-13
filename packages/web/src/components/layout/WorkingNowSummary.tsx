import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Popover, PopoverContent, PopoverTrigger, ScrollArea } from "@botiverse/raft-ui";
import { nextLiveAgentActivityExpiry } from "../../utils/liveAgentActivity";
import type { LiveAgentActivityItem } from "../../utils/liveAgentActivity";
import { useLiveAgentActivityStore } from "../../store/liveAgentActivityStore";
import { useAgentTypingStore } from "../../store/agentTypingStore";
import { useAppearanceStore } from "../../store/appearanceStore";
import { formatActivityTextDescriptor } from "../../utils/activity";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import AvatarSlot from "../ui/AvatarSlot";
import AgentActivitySubscription from "../agent/AgentActivitySubscription";
import { FaceStack } from "./FaceStack";
import { faceStackTriggerClass } from "./faceStackTrigger";

const MAX_FACES = 3;

/** Live activity (and who is typing) belongs to one workspace: start over when it changes. */
export function useClearLiveAgentActivityOnServerChange(serverId: string | undefined) {
  useLayoutEffect(() => {
    useLiveAgentActivityStore.getState().clear();
    useAgentTypingStore.getState().clear();
  }, [serverId]);
}

/**
 * Who is working right now (Raft Design System › AgentActivity): a summary in
 * the header of the place you are looking at — a stack of up to three agent
 * faces and a count. It opens "Working now": one row per working agent, what
 * it is doing, and a way to its profile. Nothing blinks.
 *
 * An agent is listed while the live-activity store has it thinking or working;
 * the "Live agent activity" appearance setting hides the summary. With nobody
 * working it takes no space.
 */
export function WorkingNowSummary({
  variant = "count",
  onFrame = false,
  className = "",
}: {
  /** `count`: faces + a number (sidebar head, phone home bar). `full`: faces + "2 agents working" + chevron (under a large title). */
  variant?: "count" | "full";
  /** Sitting on the frame (the phone Home bar): on-frame ink and the frame's pressed wash. */
  onFrame?: boolean;
  className?: string;
}) {
  const items = useLiveAgentActivityStore((state) => state.items);
  const visible = useAppearanceStore((state) => state.showLiveAgentActivityBar);
  const { formatMessage } = useIntl();
  usePruneExpiredLiveActivity(items);

  if (!visible || items.length === 0) {
    return null;
  }

  const summary = formatMessage({ id: "layout.workingNow.summary" }, { count: items.length });

  return (
    <WorkingNowPopover
      items={items}
      label={summary}
      align="end"
      testId="working-now-summary"
      className={[
        faceStackTriggerClass({ onFrame }),
        "min-h-8",
        "after:absolute after:inset-x-0 after:-inset-y-1.5",
        variant === "full" ? "gap-2 pr-2 text-footnote font-semibold" : "font-mono text-mono-meta",
        className,
      ].join(" ")}
    >
      <WorkingFaces items={items} />
      {variant === "full" ? summary : items.length}
      {variant === "full" ? <ChevronRight size={14} aria-hidden="true" className="text-foreground-hint" /> : null}
    </WorkingNowPopover>
  );
}

/**
 * "Working now" opened from a trigger: one row per agent, what it is doing,
 * and a way to its profile. The workspace summary opens it for everyone at
 * work; a channel's line above the composer (AgentTypingLine) for the agents
 * working there, where an agent about to post reads "Typing…" instead.
 */
export function WorkingNowPopover({
  items,
  typingAgentIds,
  label,
  side = "bottom",
  align,
  testId,
  className,
  children,
}: {
  items: readonly LiveAgentActivityItem[];
  /** Agents about to post where the list was opened: their row says so. */
  typingAgentIds?: ReadonlySet<string>;
  /** The trigger's accessible name. */
  label: string;
  side?: "top" | "bottom";
  align: "start" | "end";
  testId: string;
  className: string;
  /** The trigger's content. */
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger data-testid={testId} aria-label={label} className={className}>
        {children}
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          side={side}
          align={align}
          role="dialog"
          aria-label={formatMessage({ id: "layout.workingNow.title" })}
          className="w-[300px] p-0"
          data-testid="working-now-list"
        >
          {/* What each of them is doing: their detail while the list is open. */}
          <AgentActivitySubscription agentIdKey={items.map((item) => item.agentId).join(",")} />
          <WorkingNowList items={items} typingAgentIds={typingAgentIds} onNavigate={close} />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function WorkingNowList({ items, typingAgentIds, onNavigate }: {
  items: readonly LiveAgentActivityItem[];
  typingAgentIds: ReadonlySet<string> | undefined;
  onNavigate: () => void;
}) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const openAgent = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const agentId = event.currentTarget.dataset.agentId;
    if (!agentId) return;
    onNavigate();
    nav.toAgent(agentId);
  }, [nav, onNavigate]);
  return (
    <div className="flex flex-col">
      <div className="flex min-h-11 items-center border-b border-line-seam px-4 text-headline">
        {formatMessage({ id: "layout.workingNow.title" })}
      </div>
      {/* Every row is a button that takes focus, so the area is no tab stop. */}
      <ScrollArea tabIndex={-1} className="max-h-[min(60vh,420px)]">
      <ul className="flex flex-col py-1.5">
        {items.map((item) => {
          const text = typingAgentIds?.has(item.agentId)
            ? formatMessage({ id: "message.agentTyping.typingRow" })
            : item.textDescriptor
              ? formatActivityTextDescriptor(formatMessage, item.textDescriptor)
              : item.text;
          return (
            <li key={item.agentId}>
              <button
                type="button"
                data-agent-id={item.agentId}
                onClick={openAgent}
                className="flex w-full items-start gap-3 px-4 py-2 text-left outline-none hover:bg-brand-soft focus-visible:bg-brand-soft"
              >
                <AvatarSlot
                  context="compact-row"
                  type="agent"
                  agentAvatarUrl={item.agentAvatarUrl}
                  presence={item.activity === "error" ? "error" : "busy"}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-callout font-bold text-foreground">{item.agentName}</span>
                  <span className="line-clamp-2 text-footnote text-foreground-muted">{text}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      </ScrollArea>
    </div>
  );
}

/**
 * The stack of agents at work: the shared FaceStack, up to three agents in
 * the order they started (the store keeps that order), so the stack changes
 * only when someone starts or stops. `still`: no entrance (the typing line).
 */
export function WorkingFaces({
  items,
  still = false,
  testId = "working-faces",
}: {
  items: readonly Pick<LiveAgentActivityItem, "agentId" | "agentAvatarUrl">[];
  still?: boolean;
  testId?: string;
}) {
  return (
    <FaceStack still={still} testId={testId}>
      {items.slice(0, MAX_FACES).map((item) => (
        <AvatarSlot key={item.agentId} context="face-stack" type="agent" agentAvatarUrl={item.agentAvatarUrl} />
      ))}
    </FaceStack>
  );
}

/**
 * Rows leave on their own: an idle agent after its grace, a silent one after
 * the safety window. Prune at the earliest of those moments.
 */
function usePruneExpiredLiveActivity(items: readonly LiveAgentActivityItem[]) {
  const prune = useCallback(() => useLiveAgentActivityStore.getState().pruneExpired(), []);
  const nextExpiry = nextLiveAgentActivityExpiry(items);
  useEffect(() => {
    if (nextExpiry === null) return;
    const timeout = window.setTimeout(prune, Math.max(0, nextExpiry - Date.now()) + 50);
    return () => window.clearTimeout(timeout);
  }, [nextExpiry, prune]);
}

export default WorkingNowSummary;
