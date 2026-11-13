import { useCallback, useId, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { Info, Search, TriangleAlert, X } from "lucide-react";
import { Banner, BannerDescription, Button, InputGroup, InputGroupAddon, InputGroupInput } from "@botiverse/raft-ui";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { useTopBarHost } from "../../components/topbar/topBarHostContext";
import { formatShortcut, isApplePlatform, keyboardPlatform } from "../../utils/keyboardShortcuts";
import { isShortcutOverridden, resolvedCombos, useShortcutOverrides } from "../shortcuts/overrides";
import { SHORTCUT_COMMANDS, defaultCombos, getShortcutCommand } from "../shortcuts/registry";
import { visibleShortcutGroups } from "./keyboardShortcutList";
import type { ShortcutKeys, ShortcutRow } from "./keyboardShortcutList";
import { useOtterShortcutRowKeys } from "./useOtterShortcutRowKeys";
import { useComposerSendKey } from "../composer/composerSendKey";
import { ShortcutSendKeyNote } from "./ShortcutSendKeyNote";
import { ShortcutHelpRow } from "./ShortcutHelpRow";
import { ShortcutResetAllDialog } from "./ShortcutResetAllDialog";
import type { ShortcutResetItem } from "./ShortcutResetAllDialog";
import { useShortcutEditor } from "./useShortcutEditor";

/** The message box's rows the send key decides: the Settings choice, a note here, not rows (Artea's mock). */
const SEND_KEY_ROWS = new Set(["new-line", "send"]);

/** What a search matches in a row: its name, where it works, and its keys written both ways (⌘F, Ctrl+F, ctrlf). */
function rowMatches(row: ShortcutRow, keys: readonly ShortcutKeys[], query: string, words: (id: ShortcutRow["label"]) => string): boolean {
  const text = `${words(row.label)} ${row.where ? words(row.where) : ""}`.toLowerCase();
  if (text.includes(query)) return true;
  const squash = (value: string) => value.toLowerCase().replace(/[\s+]/g, "");
  const wanted = squash(query);
  if (!wanted) return false;
  return keys.some((entry) => {
    const combos = "from" in entry ? [entry.from, entry.to] : "keys" in entry ? entry.keys.map((key) => ({ ...entry, key })) : [entry];
    return combos.some((combo) => [formatShortcut(combo, "MacIntel"), formatShortcut(combo, "Win32")].some((written) => squash(written).includes(wanted)));
  });
}

/**
 * The shortcuts, grouped, for the side panel and the phone page: each row two lines (what it does, then where it
 * works) with its keys on the right, raft-ui's KbdShortcut at `md` drawn for this platform only (the platform the
 * app's matchers read, `keyboardPlatform`). The desktop app's own shortcuts show only in the desktop app: its host
 * hands the top bar a workspace shortcut modifier.
 *
 * `editable` (the panel on a computer, or a tablet with a keyboard): the search field and Reset all under the
 * header, and each shortcut a person may change is a button that records new keys (Artea's mock,
 * #proj-frontend:#37). Otherwise (a phone) the keys are plain caps under a note saying where to change them; the
 * person's changes show either way.
 */
export function ShortcutHelpList({ editable = false }: { editable?: boolean }) {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const desktopApp = Boolean(useTopBarHost()?.workspaceShortcutModifier);
  const navigatorPlatform = typeof navigator === "undefined" ? "" : navigator.platform;
  const platform = keyboardPlatform(navigatorPlatform);
  const assistantOtter = useOtterShortcutRowKeys();
  const composerSendKey = useComposerSendKey();
  const overrides = useShortcutOverrides();
  const editor = useShortcutEditor(platform);
  const [query, setQuery] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const changeQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), []);
  const clearQuery = useCallback(() => setQuery(""), []);
  const askResetAll = useCallback(() => setConfirmingReset(true), []);
  const { resetAll } = editor;
  const confirmResetAll = useCallback(() => {
    setConfirmingReset(false);
    resetAll();
  }, [resetAll]);
  const words = useCallback((id: ShortcutRow["label"]) => formatMessage({ id }), [formatMessage]);

  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return visibleShortcutGroups({ apple: isApplePlatform(navigatorPlatform), desktopApp, assistantOtter, composerSendKey })
      .map((group) => ({
        ...group,
        note: group.id === "message-box",
        rows: group.rows
          .filter((row) => !(group.id === "message-box" && SEND_KEY_ROWS.has(row.id)))
          .map((row) => {
            const command = getShortcutCommand(row.id);
            const combos = command.rebindable ? resolvedCombos(command, platform, overrides) : null;
            return { row, command, combos };
          })
          .filter(({ row, combos }) => !normalized || rowMatches(row, combos ?? row.keys, normalized, words)),
      }))
      .filter((group) => group.rows.length > 0);
  }, [query, navigatorPlatform, desktopApp, assistantOtter, composerSendKey, platform, overrides, words]);

  // The changes Reset all puts back: the commands this platform has that the person changed.
  const resetItems = useMemo<ShortcutResetItem[]>(() => SHORTCUT_COMMANDS
    .filter((command) => command.rebindable && isShortcutOverridden(command.id, overrides) && defaultCombos(command, platform).length > 0)
    .map((command) => ({
      id: command.id,
      label: formatMessage({ id: command.label }),
      now: resolvedCombos(command, platform, overrides),
      defaults: defaultCombos(command, platform),
    })), [overrides, platform, formatMessage]);

  const searchLabel = formatMessage({ id: "keyboardShortcuts.edit.searchPlaceholder" });

  return (
    <div className="flex flex-col gap-4" data-testid="keyboard-shortcut-list" data-editable={editable ? "" : undefined}>
      {editable ? null : (
        <Banner status="info" size="sm" data-testid="keyboard-shortcuts-read-only">
          <Info aria-hidden />
          <BannerDescription>{formatMessage({ id: "keyboardShortcuts.edit.readOnlyNote" })}</BannerDescription>
        </Banner>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon align="inline-start">
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              onChange={changeQuery}
              placeholder={searchLabel}
              aria-label={searchLabel}
              data-testid="keyboard-shortcuts-search"
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <Button type="button" variant="ghost" size="icon-md" onClick={clearQuery} aria-label={formatMessage({ id: "search.clearSearch" })}>
                  <X aria-hidden />
                </Button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          {editable ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={resetItems.length === 0}
              onClick={askResetAll}
              data-testid="keyboard-shortcuts-reset-all"
            >
              {formatMessage({ id: "keyboardShortcuts.edit.resetAll" })}
            </Button>
          ) : null}
        </div>
        {editable ? <p className="text-footnote text-foreground-hint">{formatMessage({ id: "keyboardShortcuts.edit.hint" })}</p> : null}
        {editor.saveFailed ? (
          <Banner status="warning" size="sm" role="alert" data-testid="keyboard-shortcuts-save-failed">
            <TriangleAlert aria-hidden />
            <BannerDescription>{formatMessage({ id: "keyboardShortcuts.edit.saveFailed" })}</BannerDescription>
          </Banner>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <p className="text-callout text-foreground-hint" data-testid="keyboard-shortcuts-no-results">
          {formatMessage({ id: "keyboardShortcuts.edit.noResults" }, { query: query.trim() })}
        </p>
      ) : null}
      {groups.map((group) => {
        const headingId = `${idPrefix}-${group.id}`;
        return (
          <section key={group.id} aria-labelledby={headingId} data-shortcut-group={group.id}>
            <h3 id={headingId} className="mb-0.5">
              <SectionEyebrow>{formatMessage({ id: group.title })}</SectionEyebrow>
            </h3>
            {group.note && editable ? <ShortcutSendKeyNote /> : null}
            <ul>
              {group.rows.map(({ row, command, combos }) => (
                <ShortcutHelpRow
                  key={row.id}
                  row={row}
                  command={command}
                  combos={combos}
                  defaults={defaultCombos(command, platform)}
                  changed={command.rebindable && isShortcutOverridden(command.id, overrides)}
                  editable={editable}
                  platform={platform}
                  editor={editor}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {editable ? (
        <ShortcutResetAllDialog
          open={confirmingReset}
          onOpenChange={setConfirmingReset}
          items={resetItems}
          platform={platform}
          onConfirm={confirmResetAll}
        />
      ) : null}
    </div>
  );
}
