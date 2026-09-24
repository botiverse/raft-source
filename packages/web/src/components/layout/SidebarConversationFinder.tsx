import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Hash, Lock, Search } from "lucide-react";

import AvatarSlot from "../ui/AvatarSlot";

import type { Channel } from "../../store/channelStore";
import type { Agent } from "../../store/agentStore";
import type { ServerMember } from "../../store/serverStore";
import {
  buildFinderResults,
  finderSearchEntries,
  rankFinderResults,
} from "./conversationFinderModel";
import type { FinderResult } from "./conversationFinderModel";

// "Find a conversation…" — a name-based jump box pinned above the sidebar
// scroll surface (Slack parity, #kabi-desktop). Fuzzy-matches channels, DMs,
// agents, and people over the stores already loaded in the Sidebar; NO
// message-content search and NO keyboard shortcut by design. Selecting a
// result jumps to that conversation (people/agents open their DM). The dedup
// and ranking live in `conversationFinderModel.ts` (unit tested).

interface SidebarConversationFinderProps {
  channels: Channel[];
  dmChannels: Channel[];
  agents: Agent[];
  members: ServerMember[];
  /** Current user id, excluded from people results (no self-DM). */
  currentUserId?: string | null;
  onOpenChannel: (channelId: string) => void;
  onOpenDm: (dmChannelId: string) => void;
  onOpenAgentDm: (agentId: string) => void;
  onOpenHumanDm: (userId: string) => void;
}

export function SidebarConversationFinder({
  channels,
  dmChannels,
  agents,
  members,
  currentUserId,
  onOpenChannel,
  onOpenDm,
  onOpenAgentDm,
  onOpenHumanDm,
}: SidebarConversationFinderProps) {
  const { formatMessage } = useIntl();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build the searchable universe once per store change. People/agents that
  // already have a DM channel are represented by that DM (dedup by peer id) so
  // each conversation appears once.
  const agentTag = formatMessage({ id: "sidebar.findConversationAgentTag" });
  const entries = useMemo(
    () =>
      finderSearchEntries(
        buildFinderResults({ channels, dmChannels, agents, members, currentUserId, agentTag }),
      ),
    [channels, dmChannels, agents, members, currentUserId, agentTag],
  );

  const trimmed = query.trim();
  const ranked = useMemo(() => rankFinderResults(trimmed, entries), [trimmed, entries]);

  const showDropdown = open && trimmed.length > 0;

  // Reset the highlighted row when the query changes. Done during render via a
  // ref (not a useEffect) so there's no derived-state effect or post-render
  // state-update chain; `activeRow` is the value to use for this render.
  const activeQueryRef = useRef(trimmed);
  let activeRow = activeIndex;
  if (activeQueryRef.current !== trimmed) {
    activeQueryRef.current = trimmed;
    activeRow = 0;
    setActiveIndex(0);
  }

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  const select = useCallback(
    (result: FinderResult | undefined) => {
      if (!result) return;
      switch (result.kind) {
        case "channel":
          onOpenChannel(result.channelId);
          break;
        case "dm":
          onOpenDm(result.dmChannelId);
          break;
        case "agent":
          onOpenAgentDm(result.agentId);
          break;
        case "human":
          onOpenHumanDm(result.userId);
          break;
      }
      close();
      inputRef.current?.blur();
    },
    [onOpenChannel, onOpenDm, onOpenAgentDm, onOpenHumanDm, close],
  );

  // Dismiss on outside click.
  useEffect(() => {
    if (!showDropdown) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showDropdown, close]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      inputRef.current?.blur();
      return;
    }
    if (!showDropdown || ranked.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % ranked.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + ranked.length) % ranked.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      select(ranked[activeRow]);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0 px-2 pt-2.5 pb-2">
      <div className="flex min-w-0 items-center gap-2 border-2 border-black bg-white px-2.5 py-1.5 shadow-brutal-sm focus-within:shadow-brutal">
        <Search size={15} className="shrink-0 text-black/50" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={(event) => {
            setIsComposing(false);
            setQuery(event.currentTarget.value);
          }}
          placeholder={formatMessage({ id: "sidebar.findConversationPlaceholder" })}
          aria-label={formatMessage({ id: "sidebar.findConversationPlaceholder" })}
          data-testid="sidebar-conversation-finder-input"
          className="min-w-0 flex-1 bg-transparent text-sm font-display font-medium outline-none placeholder:text-black/40"
        />
      </div>

      {showDropdown && (
        <div
          className="absolute inset-x-2 top-full z-30 mt-1 max-h-[min(60vh,22rem)] overflow-y-auto card-brutal"
          data-testid="sidebar-conversation-finder-results"
        >
          {ranked.length === 0 ? (
            <div className="px-3 py-2 text-xs text-black/50">
              {formatMessage({ id: "sidebar.findConversationEmpty" })}
            </div>
          ) : (
            ranked.map((result, index) => (
              <button
                key={result.key}
                type="button"
                // Use pointerdown so the click lands before the input's blur
                // tears the dropdown down.
                onPointerDown={(event) => {
                  event.preventDefault();
                  select(result);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium transition-colors ${
                  index === activeRow ? "bg-soft-signal font-bold" : "hover:bg-soft-signal/50"
                }`}
              >
                <FinderResultIcon result={result} />
                <span className="min-w-0 flex-1 truncate font-medium text-black">
                  {result.label}
                </span>
                {result.sublabel && (
                  <span className="max-w-[45%] shrink-0 truncate text-[11px] text-black/40">
                    {result.sublabel}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FinderResultIcon({ result }: { result: FinderResult }) {
  if (result.kind === "channel") {
    return result.private ? (
      <Lock size={14} className="shrink-0 text-black/50" />
    ) : (
      <Hash size={14} className="shrink-0 text-black/50" />
    );
  }
  // DMs / agents / people reuse the app's avatar primitive at the same size
  // the sidebar rows use, so results read exactly like the lists they open.
  if (result.kind === "agent" || (result.kind === "dm" && result.peerIsAgent)) {
    return <AvatarSlot context="sidebar-list" type="agent" agentAvatarUrl={result.avatarUrl} />;
  }
  return (
    <AvatarSlot
      context="sidebar-list"
      type="human"
      humanAvatarUrl={result.avatarUrl}
      gravatarHash={result.gravatarHash}
      humanPlaceholder={!result.avatarUrl && !result.gravatarHash}
    />
  );
}
