import { useCallback, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { ComboboxProps } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import type { Location, SetURLSearchParams } from "react-router-dom";
import { normalizeSearchScopes } from "./searchGrouping";
import type { SearchScope, SearchSort, SearchTimeRange } from "./searchGrouping";
import type { SearchEntitySourceParams } from "./searchEntities";
import {
  getExclusiveSenderTypeScope,
  getScopeOptionLabelId,
  getTimeRangeLabelId,
  SEARCH_SCOPE_OPTIONS,
  SEARCH_SORTS,
  SEARCH_TIME_RANGES,
} from "./searchLabels";
import type { SenderFilterOption } from "./searchResultTypes";
import { isSearchableAgent } from "../../store/searchableAgent";

export type SearchFilterMenu = "from" | "scope" | "channel" | "time" | "sort";

/**
 * The filter bar's state and URL writers: sender / scope / channel / time /
 * sort, each committed to the URL (the source of truth), plus which filter
 * menu is open and what is typed in the sender and channel pickers.
 */
export function useSearchFilters({
  location,
  setSearchParams,
  skipNextSearchStateRestoreRef,
  channels,
  members,
  agents,
  currentUser,
  senderIdParam,
  scopes,
  formatMessage,
  filtersPortalRef,
}: Pick<SearchEntitySourceParams, "channels" | "members" | "agents" | "currentUser"> & {
  location: Location;
  setSearchParams: SetURLSearchParams;
  skipNextSearchStateRestoreRef: RefObject<boolean>;
  senderIdParam: string;
  scopes: SearchScope[];
  formatMessage: IntlShape["formatMessage"];
  filtersPortalRef: RefObject<HTMLDivElement | null>;
}) {
  const [openFilterMenu, setOpenFilterMenu] = useState<SearchFilterMenu | null>(null);
  const [channelFilterQuery, setChannelFilterQuery] = useState("");
  const [senderFilterQuery, setSenderFilterQuery] = useState("");

  const updateSearchParam = useCallback((key: string, value?: string | null) => {
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, setSearchParams, skipNextSearchStateRestoreRef]);

  const clearAllFilters = useCallback(() => {
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("senderId");
      next.delete("scope");
      next.delete("range");
      next.delete("channelId");
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, setSearchParams, skipNextSearchStateRestoreRef]);

  const filteredChannels = useMemo(() => {
    const normalizedQuery = channelFilterQuery.trim().toLowerCase();
    if (!normalizedQuery) return channels;
    return channels.filter((channel) => {
      const haystack = `${channel.name} ${channel.description ?? ""}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [channelFilterQuery, channels]);

  const senderOptions = useMemo<SenderFilterOption[]>(() => {
    const humans = members.map<SenderFilterOption>((member) => ({
      key: `user:${member.userId}`,
      id: member.userId,
      type: "user",
      label: member.displayName || member.name,
      handle: member.name,
      isSelf: currentUser?.id === member.userId,
      avatarUrl: member.avatarUrl,
      email: member.email,
    }));
    const hasCurrentUser = Boolean(currentUser?.id && humans.some((option) => option.id === currentUser.id));
    const withCurrentUser = currentUser?.id && !hasCurrentUser
      ? [
          {
            key: `user:${currentUser.id}`,
            id: currentUser.id,
            type: "user" as const,
            label: currentUser.displayName || currentUser.name || currentUser.email,
            handle: currentUser.name || currentUser.email,
            isSelf: true,
            avatarUrl: currentUser.avatarUrl,
            email: currentUser.email,
          },
          ...humans,
        ]
      : humans;
    const agentOptions = agents
      .filter((agent) => isSearchableAgent(agent, currentUser?.id))
      .map<SenderFilterOption>((agent) => ({
        key: `agent:${agent.id}`,
        id: agent.id,
        type: "agent",
        label: agent.displayName || agent.name,
        handle: agent.name,
        avatarUrl: agent.avatarUrl,
      }));
    return [...withCurrentUser, ...agentOptions].sort((a, b) => {
      if (a.isSelf && !b.isSelf) return -1;
      if (!a.isSelf && b.isSelf) return 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
  }, [agents, currentUser, members]);

  const filteredSenderOptions = useMemo(() => {
    const needle = senderFilterQuery.trim().toLowerCase();
    if (!needle) return senderOptions;
    return senderOptions.filter((option) => {
      const haystack = `${option.label} ${option.handle}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [senderFilterQuery, senderOptions]);

  const selectedSender = useMemo(
    () => senderOptions.find((option) => option.id === senderIdParam) ?? null,
    [senderIdParam, senderOptions],
  );

  const setSenderFilter = useCallback((sender: SenderFilterOption | null) => {
    skipNextSearchStateRestoreRef.current = true;
    if (!sender) {
      updateSearchParam("senderId", null);
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("senderId", sender.id);
      const currentScopes = normalizeSearchScopes(next.getAll("scope"));
      const exclusiveSenderTypeScope = getExclusiveSenderTypeScope(currentScopes);
      if (exclusiveSenderTypeScope && sender.type !== exclusiveSenderTypeScope) {
        next.delete("scope");
        for (const mode of currentScopes) {
          if (mode === "mentioned" || (mode === "humans" && sender.type === "user") || (mode === "agents" && sender.type === "agent")) {
            next.append("scope", mode);
          }
        }
      }
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, setSearchParams, skipNextSearchStateRestoreRef, updateSearchParam]);

  const setScopeFilters = useCallback((nextScopes: SearchScope[]) => {
    skipNextSearchStateRestoreRef.current = true;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("scope");
      const normalizedScopes = SEARCH_SCOPE_OPTIONS.filter((mode) => nextScopes.includes(mode));
      for (const mode of normalizedScopes) next.append("scope", mode);
      const currentSenderId = next.get("senderId");
      const currentSender = currentSenderId ? senderOptions.find((option) => option.id === currentSenderId) : null;
      const exclusiveSenderTypeScope = getExclusiveSenderTypeScope(normalizedScopes);
      if (currentSender && exclusiveSenderTypeScope && currentSender.type !== exclusiveSenderTypeScope) {
        next.delete("senderId");
      }
      return next;
    }, { replace: true, state: location.state });
  }, [location.state, senderOptions, setSearchParams, skipNextSearchStateRestoreRef]);

  // Filter menus render into the filters bar so they stay inside the overlay.
  const filtersPortalProps = useMemo(() => ({ container: filtersPortalRef }), [filtersPortalRef]);
  const handleFromMenuOpenChange = useCallback((open: boolean) => setOpenFilterMenu(open ? "from" : null), []);
  const handleScopeMenuOpenChange = useCallback((open: boolean) => setOpenFilterMenu(open ? "scope" : null), []);
  const handleChannelMenuOpenChange = useCallback((open: boolean) => setOpenFilterMenu(open ? "channel" : null), []);
  const handleTimeMenuOpenChange = useCallback((open: boolean) => setOpenFilterMenu(open ? "time" : null), []);
  const handleSortMenuOpenChange = useCallback((open: boolean) => setOpenFilterMenu(open ? "sort" : null), []);

  const senderItemIds = useMemo(() => filteredSenderOptions.map((item) => item.id), [filteredSenderOptions]);
  const senderItemLabel = useCallback(
    (id: string) => senderOptions.find((item) => item.id === id)?.label ?? id,
    [senderOptions],
  );
  const handleSenderInputChange: NonNullable<ComboboxProps<string>["onInputValueChange"]> = useCallback((nextValue, details) => {
    if (details.reason !== "item-press") setSenderFilterQuery(nextValue);
  }, []);
  const handleSenderChange = useCallback((nextValue: string | null) => {
    const sender = senderOptions.find((item) => item.id === nextValue) ?? null;
    setSenderFilter(sender);
  }, [senderOptions, setSenderFilter]);
  const clearSenderFilter = useCallback(() => updateSearchParam("senderId", null), [updateSearchParam]);

  const scopeItems = useMemo(
    () => SEARCH_SCOPE_OPTIONS.map((mode) => ({
      label: formatMessage({ id: getScopeOptionLabelId(mode) }),
      value: mode,
    })),
    [formatMessage],
  );
  const scopeValue = useMemo(() => [...scopes], [scopes]);

  const clearChannelFilter = useCallback(() => updateSearchParam("channelId", null), [updateSearchParam]);
  const channelItemIds = useMemo(() => filteredChannels.map((ch) => ch.id), [filteredChannels]);
  const channelItemLabel = useCallback(
    (id: string) => channels.find((ch) => ch.id === id)?.name ?? id,
    [channels],
  );
  const handleChannelInputChange: NonNullable<ComboboxProps<string>["onInputValueChange"]> = useCallback((nextValue, details) => {
    if (details.reason !== "item-press") setChannelFilterQuery(nextValue);
  }, []);
  const handleChannelChange = useCallback((nextValue: string | null) => {
    if (nextValue) updateSearchParam("channelId", nextValue);
  }, [updateSearchParam]);

  const timeRangeItems = useMemo(
    () => SEARCH_TIME_RANGES.map((range) => ({
      label: formatMessage({ id: getTimeRangeLabelId(range) }),
      value: range,
    })),
    [formatMessage],
  );
  const handleTimeRangeChange = useCallback((nextValue: SearchTimeRange | null) => {
    if (nextValue) {
      updateSearchParam("range", nextValue === "any" ? null : nextValue);
    }
  }, [updateSearchParam]);

  const sortItems = useMemo(
    () => SEARCH_SORTS.map((mode) => ({
      label: mode === "relevance" ? formatMessage({ id: "search.sortRelevant" }) : formatMessage({ id: "search.sortRecent" }),
      value: mode,
    })),
    [formatMessage],
  );
  const handleSortChange = useCallback((nextValue: SearchSort | null) => {
    if (nextValue) {
      updateSearchParam("sort", nextValue === "relevance" ? null : nextValue);
    }
  }, [updateSearchParam]);
  const sortByRecent = useCallback(() => updateSearchParam("sort", "recent"), [updateSearchParam]);

  return {
    openFilterMenu,
    channelFilterQuery,
    senderFilterQuery,
    clearAllFilters,
    filteredChannels,
    filteredSenderOptions,
    selectedSender,
    setScopeFilters,
    filtersPortalProps,
    handleFromMenuOpenChange,
    handleScopeMenuOpenChange,
    handleChannelMenuOpenChange,
    handleTimeMenuOpenChange,
    handleSortMenuOpenChange,
    senderItemIds,
    senderItemLabel,
    handleSenderInputChange,
    handleSenderChange,
    clearSenderFilter,
    scopeItems,
    scopeValue,
    clearChannelFilter,
    channelItemIds,
    channelItemLabel,
    handleChannelInputChange,
    handleChannelChange,
    timeRangeItems,
    handleTimeRangeChange,
    sortItems,
    handleSortChange,
    sortByRecent,
  };
}

export type SearchFilterControls = ReturnType<typeof useSearchFilters>;
