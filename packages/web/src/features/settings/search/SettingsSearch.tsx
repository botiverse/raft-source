import { useCallback, useMemo, useRef } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  SidebarItem,
  SidebarItemContent,
  SidebarItemSubtitle,
  SidebarItemTitle,
} from "@botiverse/raft-ui";
import type { SettingsSidebarGroup } from "../../../components/settings/SettingsSidebarList";
import AppEmptyState from "../../../components/ui/EmptyState";
import { SearchHighlight } from "../../search/SearchHighlight";
import { useAppNavigate } from "../../../hooks/useAppNavigate";
import { useServerStore } from "../../../store/serverStore";
import { useShortcut } from "../../shortcuts/useShortcut";
import { searchSettings } from "./settingsSearchMatch";
import type { SearchableSetting, SettingsSearchResult } from "./settingsSearchMatch";
import { settingsJumpState } from "../shared/useScrollToSettingsSection";
import { isSettingsPath, useSettingsSearchLifetime, useSettingsSearching, useSettingsSearchQuery, useSettingsSearchStore } from "./settingsSearchStore";
import { useSettingsSearchSettings } from "./useSettingsSearchSettings";

const RESULT_SELECTOR = "[data-settings-search-result]";

/**
 * Settings' list with its search field on top (raft-design
 * settings.md#searching-settings): on desktop in the sidebar, on a phone on the
 * Settings page. While there is text the results take the groups' place; a
 * result opens its page at the setting (/settings/<page>#<id>, which
 * useScrollToSettingsSection scrolls to and marks located). ⌘F / Ctrl+F in
 * Settings focuses the field; pressed in the field it is the browser's find.
 * The field stays put above the list as it scrolls.
 */
export function SettingsSearch({
  groups,
  activeId,
  mobileInline = false,
}: {
  groups: SettingsSidebarGroup[];
  activeId: string | null;
  /** The phone's Settings page, on paper; the desktop sidebar is cream. */
  mobileInline?: boolean;
}) {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const query = useSettingsSearchQuery(serverSlug);
  const storeQuery = useSettingsSearchStore((s) => s.setQuery);
  const setQuery = useCallback((next: string) => storeQuery(next, serverSlug), [serverSlug, storeQuery]);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { hash, pathname } = useLocation();
  const nav = useAppNavigate();
  useSettingsSearchLifetime(serverSlug);
  // Release notes, RaftBench and the phone's Computers show this list too, but aren't Settings.
  const inSettings = isSettingsPath(pathname);

  // The pages the list shows this person, in its order: the search finds only their settings.
  const visiblePages = useMemo(() => groups.flatMap((group) => group.items.map((item) => item.id)), [groups]);
  const searching = useSettingsSearching(serverSlug);
  const settings = useSettingsSearchSettings(visiblePages, searching);
  const results = useMemo(() => searchSettings(settings, query), [settings, query]);
  // Marks compare case-insensitively; NFKC makes a full-width query mark half-width words.
  const markQuery = query.normalize("NFKC");

  // ⌘F / Ctrl+F (or the person's keys) anywhere in Settings focuses Search settings (registry "search-settings",
  // offered wherever the focus is while Settings shows). Pressed again in the field it is the browser's own find, for
  // the page's text; a field that can't take focus (the sidebar collapsed and inert, or hidden in a narrow window)
  // leaves the key to the browser's find too.
  useShortcut("search-settings", () => {
    const input = inputRef.current;
    if (!input || document.activeElement === input) return false;
    input.focus();
    if (document.activeElement !== input) return false;
    input.select();
  }, { enabled: inSettings, ambient: true });

  // A jump from the keyboard also moves focus to the setting (states.md#located);
  // the page can't tell Enter in this field from typing, so it is told.
  const openSetting = useCallback((setting: SearchableSetting, fromKeyboard: boolean) => {
    if (serverSlug) navigate(`/s/${serverSlug}/settings/${setting.page}#${setting.id}`, { state: settingsJumpState(fromKeyboard) });
  }, [navigate, serverSlug]);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), [setQuery]);
  const handleClear = useCallback(() => {
    setQuery("");
    inputRef.current?.focus();
  }, [setQuery]);

  const handleFieldKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      const first = resultsRef.current?.querySelector<HTMLElement>(RESULT_SELECTOR);
      if (!first) return;
      event.preventDefault();
      first.focus();
    } else if (event.key === "Enter") {
      // Enter in the field opens the first result: the field has no
      // highlight of its own yet (Down moves focus into the results).
      const first = results[0];
      if (!first) return;
      event.preventDefault();
      openSetting(first.setting, true);
    } else if (event.key === "Escape") {
      // Escape clears the query; with an empty field it leaves the field.
      if (!query) {
        event.currentTarget.blur();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  }, [openSetting, query, results, setQuery]);

  // Up and Down move through the results; Up from the first, or Escape, goes back to the field.
  const handleResultsKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") return;
    const rows = Array.from(resultsRef.current?.querySelectorAll<HTMLElement>(RESULT_SELECTOR) ?? []);
    const at = rows.findIndex((row) => row === document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === "Escape") {
      event.stopPropagation();
      inputRef.current?.focus();
      return;
    }
    const next = event.key === "ArrowDown" ? rows[at + 1] : at === 0 ? inputRef.current : rows[at - 1];
    next?.focus();
  }, []);

  const handleSearchEverywhere = useCallback(() => nav.toSearch(query.trim()), [nav, query]);

  const placeholder = formatMessage({ id: "settings.search.placeholder" });
  return (
    <>
      {/* Pinned above the list as it scrolls, on the list's own surface. Its
          height (8px + the field + 4px) is where the Sidebar's scrollbar
          starts (Sidebar, the rail inset in Settings).
          select-text: the sidebar is select-none, the query is text to edit. */}
      <div
        role="search"
        aria-label={placeholder}
        className={`sticky top-0 z-chrome select-text px-2 pt-2 pb-1 ${mobileInline ? "bg-layer-canvas" : "bg-layer-sidebar"}`}
      >
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            // A searchbox, with our clear button only: the browser's own × is hidden.
            type="search"
            className="[&::-webkit-search-cancel-button]:appearance-none"
            value={query}
            onChange={handleChange}
            onKeyDown={handleFieldKeyDown}
            placeholder={placeholder}
            aria-label={placeholder}
            autoComplete="off"
            enterKeyHint="search"
            data-testid="settings-search-input"
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                onClick={handleClear}
                aria-label={formatMessage({ id: "search.clearSearch" })}
                data-testid="settings-search-clear"
              >
                <X aria-hidden />
              </Button>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      {/* Without a query the list of pages shows here, drawn by DeferredSettingsSearch outside the deferred chunk. */}
      {!searching ? null : results.length > 0 ? (
        // A list of cells, as the groups' rows: 2px apart, 8px at its ends.
        // A list for a screen reader, which says how many results there are.
        <div
          ref={resultsRef}
          role="list"
          aria-label={placeholder}
          className="flex flex-col gap-0.5 py-2"
          onKeyDown={handleResultsKeyDown}
          data-testid="settings-search-results"
        >
          {results.map((result) => (
            <div key={result.setting.id} role="listitem">
              <SettingsSearchResultRow
                result={result}
                markQuery={markQuery}
                // The open one stays selected, so the next can be opened from here.
                selected={activeId === result.setting.page && hash === `#${result.setting.id}`}
                onOpen={openSetting}
              />
            </div>
          ))}
        </div>
      ) : (
        <AppEmptyState
          className="px-4 py-12"
          icon={<Search size={36} aria-hidden="true" />}
          title={formatMessage({ id: "settings.search.noMatch" }, { query: query.trim() })}
          description={formatMessage({ id: "settings.search.noMatchDescription" })}
          action={(
            <Button type="button" variant="outline" size="md" onClick={handleSearchEverywhere} data-testid="settings-search-everywhere">
              {formatMessage({ id: "search.scoped.everywhere" })}
            </Button>
          )}
          data-testid="settings-search-empty"
        />
      )}
    </>
  );
}

/**
 * One result: the setting's name over where it is ("Appearance ·
 * Keyboard"), and the other word it was found by when that was the match; the
 * matched words marked as in search (SearchHighlight).
 */
function SettingsSearchResultRow({
  result,
  markQuery,
  selected,
  onOpen,
}: {
  result: SettingsSearchResult;
  markQuery: string;
  selected: boolean;
  onOpen: (setting: SearchableSetting, fromKeyboard: boolean) => void;
}) {
  const { setting, alias } = result;
  const where = setting.sectionLabel ? `${setting.pageLabel} · ${setting.sectionLabel}` : setting.pageLabel;
  const subtitle = alias ? `${where} · ${alias}` : where;
  // A click from Enter or Space on the button has no pointer press (detail 0).
  const handleClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => onOpen(setting, event.detail === 0), [onOpen, setting]);
  return (
    <SidebarItem
      wrap
      active={selected}
      render={<button type="button" onClick={handleClick} aria-current={selected ? "true" : undefined} />}
      data-settings-search-result=""
      data-testid={`settings-search-result-${setting.id}`}
    >
      <SidebarItemContent stacked>
        <SidebarItemTitle><SearchHighlight text={setting.name} query={markQuery} /></SidebarItemTitle>
        <SidebarItemSubtitle><SearchHighlight text={subtitle} query={markQuery} /></SidebarItemSubtitle>
      </SidebarItemContent>
    </SidebarItem>
  );
}
