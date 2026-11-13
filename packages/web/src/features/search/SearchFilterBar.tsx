import type { RefObject } from "react";
import { useIntl } from "react-intl";
import { ArrowDownUp, AtSign, CalendarRange, Hash, UserCircle2, X } from "lucide-react";
import { Badge, Combobox, ComboboxClear, ComboboxContent, ComboboxEmpty, ComboboxHeader, ComboboxInput, ComboboxInputGroup, ComboboxItem, ComboboxItemIndicator, ComboboxLabel, ComboboxList, ComboboxSeparator, ComboboxTrigger, SearchShellFilters, Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectSeparator, SelectTrigger } from "@botiverse/raft-ui";
import { FitToolbar, FitToolbarButton, FitToolbarGroup, FitToolbarPicker } from "@botiverse/raft-ui/wip";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { LIST_TOOLBAR_STEP } from "../../components/ui/listToolbar";
import { useOverflowTitle } from "../../hooks/useOverflowTitle";
import type { Channel } from "../../store/channelStore";
import type { SearchScope, SearchSort, SearchTimeRange } from "./searchGrouping";
import {
  getScopeChipLabel,
  getScopeOptionLabelId,
  getTimeRangeLabelId,
  SEARCH_SCOPE_OPTIONS,
  SEARCH_SORTS,
  SEARCH_TIME_RANGES,
} from "./searchLabels";
import type { SearchFilterControls } from "./useSearchFilters";

// An applied filter is the cyan-soft filter chip (DS `rf-filter.is-applied`):
// each trigger says it with `data-has-value`, and `data-active` keeps it in
// view in the scrolling strip (FitToolbar).

/** A chip naming a person or a channel is capped (a phone's strip shows it whole), its name cut short inside. */
const CHIP_MAX_WIDTH_CLASS = "max-w-60 **:data-[slot=fit-toolbar-button-label]:min-w-0 **:data-[slot=fit-toolbar-picker-label]:min-w-0";

/**
 * The search's filters, a toolbar over a list with no search field of its
 * own (Raft DS › Patterns › Responsive › The toolbar over a list): one line,
 * the filter strip (From, scope, channel or the page's own scope, time) filling
 * it and scrolling sideways, Clear all pinned at the strip's end, and the
 * sort pinned at the line's end.
 */
export function SearchFilterBar({
  filtersPortalRef,
  overlayChrome,
  filters,
  senderIdParam,
  scopes,
  scopeConversation,
  channelIdParam,
  channels,
  dmChannels,
  serverPublicPageLive,
  timeRange,
  sort,
  query,
  hasActiveFilters,
}: {
  filtersPortalRef: RefObject<HTMLDivElement | null>;
  overlayChrome: boolean;
  filters: SearchFilterControls;
  senderIdParam: string;
  scopes: SearchScope[];
  scopeConversation: string | null;
  channelIdParam: string;
  channels: Channel[];
  dmChannels: Channel[];
  serverPublicPageLive: boolean;
  timeRange: SearchTimeRange;
  sort: SearchSort;
  query: string;
  hasActiveFilters: boolean;
}) {
  const { formatMessage } = useIntl();
  // A name cut short (a long display name or channel) has its whole text as
  // its title while it is cut off (raft-ui forms.md, "Long values in fields").
  const senderChipTextRef = useOverflowTitle<HTMLSpanElement>();
  const channelChipTextRef = useOverflowTitle<HTMLSpanElement>();
  const {
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
  } = filters;

  return (
    // 49px by touch (8px air, the 32px controls, 8px air, the seam); SearchShellFilters keeps 44px with a mouse.
    <SearchShellFilters ref={filtersPortalRef} className={overlayChrome ? "px-3 py-2" : "py-2"}>
      <FitToolbar aria-label={formatMessage({ id: "search.filtersAria" })} className="gap-2">
        <FitToolbarGroup
          firstLine
          overflow="scroll"
          className="gap-2"
          data-testid="search-filter-strip"
          end={hasActiveFilters ? (
            <FitToolbarButton variant="ghost" collapsedIcon={<X />} labelOrder={LIST_TOOLBAR_STEP.filterLabels} onClick={clearAllFilters} data-testid="search-clear-all">
              {formatMessage({ id: "search.clearAll" })}
            </FitToolbarButton>
          ) : null}
        >
        <Combobox<string>
          autoHighlight
          open={openFilterMenu === "from"}
          onOpenChange={handleFromMenuOpenChange}
          inputValue={senderFilterQuery}
          items={senderItemIds}
          itemToStringLabel={senderItemLabel}
          value={senderIdParam || null}
          onInputValueChange={handleSenderInputChange}
          onValueChange={handleSenderChange}
        >
          <FitToolbarPicker
            trigger={<ComboboxTrigger />}
            icon={<UserCircle2 />}
            aria-label={formatMessage({ id: "search.from" })}
            data-has-value={senderIdParam ? "" : undefined}
            data-active={senderIdParam ? "" : undefined}
            className={CHIP_MAX_WIDTH_CLASS}
          >
            {/* Capped and cut short, so a long display name can't run a phone's strip past the screen. */}
            <span ref={senderChipTextRef} className="block truncate">
              {selectedSender
                ? formatMessage(
                    { id: "search.fromWithName" },
                    { name: selectedSender.isSelf ? formatMessage({ id: "search.fromMe" }) : selectedSender.label },
                  )
                : formatMessage({ id: "search.from" })}
            </span>
          </FitToolbarPicker>
          <ComboboxContent
            align="start"
            finalFocus={false}
            initialFocus={false}
            portalProps={filtersPortalProps}
          >
            <ComboboxHeader>
              <ComboboxLabel>{formatMessage({ id: "search.from" })}</ComboboxLabel>
              {senderIdParam && (
                <ComboboxClear onClick={clearSenderFilter}>
                  {formatMessage({ id: "ui.selectionPopover.clear" })}
                </ComboboxClear>
              )}
            </ComboboxHeader>
            <ComboboxSeparator />
            <ComboboxInputGroup>
              <ComboboxInput
                aria-label={formatMessage({ id: "search.from" })}
                placeholder={formatMessage({ id: "ui.selectionPopover.searchPlaceholder" })}
                suppressPasswordManager
              />
            </ComboboxInputGroup>
            <ComboboxList>
              {filteredSenderOptions.map((sender) => (
                <ComboboxItem key={sender.id} value={sender.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <AvatarSlot
                        context="compact-list"
                        type={sender.type === "agent" ? "agent" : "human"}
                        agentAvatarUrl={sender.type === "agent" ? sender.avatarUrl ?? null : null}
                        humanAvatarUrl={sender.type === "user" ? sender.avatarUrl ?? null : null}
                      />
                    </span>
                    <span className="truncate">{sender.isSelf ? formatMessage({ id: "search.fromMe" }) : sender.label}</span>
                  </span>
                  <ComboboxItemIndicator />
                </ComboboxItem>
              ))}
            </ComboboxList>
            <ComboboxEmpty>{formatMessage({ id: "ui.selectionPopover.emptyLabel" })}</ComboboxEmpty>
          </ComboboxContent>
        </Combobox>

        <Select<SearchScope, true>
          multiple
          open={openFilterMenu === "scope"}
          onOpenChange={handleScopeMenuOpenChange}
          items={scopeItems}
          value={scopeValue}
          onValueChange={setScopeFilters}
        >
          <FitToolbarPicker
            trigger={<SelectTrigger />}
            icon={<AtSign />}
            aria-label={formatMessage({ id: "search.scope" })}
            data-has-value={scopes.length > 0 ? "" : undefined}
            data-active={scopes.length > 0 ? "" : undefined}
          >
            {getScopeChipLabel(scopes, formatMessage)}
          </FitToolbarPicker>
          <SelectContent align="start" portalProps={filtersPortalProps}>
            <SelectList>
              <SelectGroup>
                <SelectGroupLabel>{formatMessage({ id: "search.scope" })}</SelectGroupLabel>
                <SelectSeparator />
                {SEARCH_SCOPE_OPTIONS.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    <SelectItemText>{formatMessage({ id: getScopeOptionLabelId(mode) })}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectList>
          </SelectContent>
        </Select>

        {scopeConversation ? (
          /* The page's scope, not a filter: it cannot be cleared here;
             "Search everywhere" below is the way out of it. */
          <Badge appearance="soft" variant="information" data-testid="search-scope-chip">
            {formatMessage({ id: "search.scoped.in" }, { conversation: scopeConversation })}
          </Badge>
        ) : channelIdParam ? (() => {
          const ch = channels.find((c) => c.id === channelIdParam) ?? dmChannels.find((c) => c.id === channelIdParam);
          const label = ch?.name ?? formatMessage({ id: "search.channel" });
          return (
            // One toolbar item (the toolbar's one Tab stop): pressing it clears the channel, its × says so.
            <FitToolbarButton
              variant="information"
              icon={ch && ch.type !== "dm" ? <ChannelIcon channel={ch} size={14} serverPublicPageLive={serverPublicPageLive} /> : <Hash aria-hidden size={14} />}
              onClick={clearChannelFilter}
              data-active=""
              data-testid="search-channel-chip"
              className={CHIP_MAX_WIDTH_CLASS}
            >
              <span className="flex min-w-0 items-center gap-1">
                <span ref={channelChipTextRef} className="min-w-0 truncate">{label}</span>
                <X aria-hidden size={14} className="shrink-0" />
              </span>
            </FitToolbarButton>
          );
        })() : (
          <Combobox<string>
            autoHighlight
            open={openFilterMenu === "channel"}
            onOpenChange={handleChannelMenuOpenChange}
            inputValue={channelFilterQuery}
            items={channelItemIds}
            itemToStringLabel={channelItemLabel}
            value={null}
            onInputValueChange={handleChannelInputChange}
            onValueChange={handleChannelChange}
          >
            <FitToolbarPicker
              trigger={<ComboboxTrigger />}
              icon={<Hash />}
              aria-label={formatMessage({ id: "search.openChannelFilter" })}
            >
              {formatMessage({ id: "search.channel" })}
            </FitToolbarPicker>
            <ComboboxContent
              align="start"
              finalFocus={false}
              initialFocus={false}
              portalProps={filtersPortalProps}
            >
              <ComboboxHeader>
                <ComboboxLabel>{formatMessage({ id: "search.channels" })}</ComboboxLabel>
              </ComboboxHeader>
              <ComboboxSeparator />
              <ComboboxInputGroup>
                <ComboboxInput
                  aria-label={formatMessage({ id: "search.channels" })}
                  placeholder={formatMessage({ id: "ui.selectionPopover.searchPlaceholder" })}
                  suppressPasswordManager
                />
              </ComboboxInputGroup>
              <ComboboxList>
                {filteredChannels.map((ch) => (
                  <ComboboxItem key={ch.id} value={ch.id}>
                    {/* Icon and name are one start-aligned group, as in the
                        sender list: as separate children the item spreads
                        them apart and the name ends up on the right (artin). */}
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center">
                        <ChannelIcon channel={ch} size={14} serverPublicPageLive={serverPublicPageLive} />
                      </span>
                      <span className="truncate">{ch.name}</span>
                    </span>
                    <ComboboxItemIndicator />
                  </ComboboxItem>
                ))}
              </ComboboxList>
              <ComboboxEmpty>{formatMessage({ id: "ui.selectionPopover.emptyLabel" })}</ComboboxEmpty>
            </ComboboxContent>
          </Combobox>
        )}

        <Select<SearchTimeRange>
          open={openFilterMenu === "time"}
          onOpenChange={handleTimeMenuOpenChange}
          items={timeRangeItems}
          value={timeRange}
          onValueChange={handleTimeRangeChange}
        >
          <FitToolbarPicker
            trigger={<SelectTrigger />}
            icon={<CalendarRange />}
            aria-label={formatMessage({ id: "search.time" })}
            data-has-value={timeRange !== "any" ? "" : undefined}
            data-active={timeRange !== "any" ? "" : undefined}
          >
            {formatMessage({ id: getTimeRangeLabelId(timeRange) })}
          </FitToolbarPicker>
          <SelectContent align="start" portalProps={filtersPortalProps}>
            <SelectList>
              <SelectGroup>
                <SelectGroupLabel>{formatMessage({ id: "search.time" })}</SelectGroupLabel>
                <SelectSeparator />
                {SEARCH_TIME_RANGES.map((range) => (
                  <SelectItem key={range} value={range}>
                    <SelectItemText>{formatMessage({ id: getTimeRangeLabelId(range) })}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectList>
          </SelectContent>
        </Select>

        </FitToolbarGroup>
        <FitToolbarGroup firstLine className="gap-2">
        {/* Sort chip — same shape as From / Channel / Time per stdrc
            #proj-uiux:c2313b1d msg=da1194bd (2026-05-26): replaces the
            prior Relevant/Recent segmented toggle with a Sort dropdown
            positioned after the existing filter chips. Chip reads as
            applied (cyan-soft) when sort != default (relevance), matching
            the time-chip pattern (applied when timeRange != "any"). Conceptually
            sort isn't a filter, so it's NOT included in `hasActiveFilters`
            and `clearAllFilters` does NOT reset it — only the visual
            treatment matches. */}
        <Select<SearchSort>
          disabled={!query.trim()}
          open={openFilterMenu === "sort"}
          onOpenChange={handleSortMenuOpenChange}
          items={sortItems}
          value={sort}
          onValueChange={handleSortChange}
        >
          <FitToolbarPicker
            trigger={<SelectTrigger />}
            icon={<ArrowDownUp />}
            labelOrder={LIST_TOOLBAR_STEP.displayLabels}
            aria-label={formatMessage({ id: "search.sort" })}
            data-has-value={sort !== "relevance" ? "" : undefined}
            data-testid="search-sort-chip"
          >
            {sort === "recent" ? formatMessage({ id: "search.sortRecent" }) : formatMessage({ id: "search.sortRelevant" })}
          </FitToolbarPicker>
          <SelectContent align="end" portalProps={filtersPortalProps}>
            <SelectList>
              <SelectGroup>
                <SelectGroupLabel>{formatMessage({ id: "search.sort" })}</SelectGroupLabel>
                <SelectSeparator />
                {SEARCH_SORTS.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    <SelectItemText>{mode === "relevance" ? formatMessage({ id: "search.sortRelevant" }) : formatMessage({ id: "search.sortRecent" })}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectList>
          </SelectContent>
        </Select>
        </FitToolbarGroup>
      </FitToolbar>
    </SearchShellFilters>
  );
}
