import { useCallback, useEffect, useRef } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { InputGroup, InputGroupInput, PanelAction } from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { useBrowserTabsStore } from "./browserTabsStore";
import type { BrowserFind } from "./browserTabsStore";
import { closeBrowserFind } from "./browserViews";

/** The newest `find.focus` a field took the keyboard for (the store hands them out in one growing sequence). */
let focusHandled = 0;

/**
 * Find in page, for the tab in front (#proj-workspace:#292): a row under the
 * address row, [field][3 of 12][Previous][Next][Close]. The page is the
 * shell's native view, which nothing of the app's page can be drawn over, so
 * the field takes a row of its own instead of floating over the page.
 *
 * Typing searches as you type, from the first match; Enter is the next match
 * and Shift+Enter the one before (as are the shell's keys for them, pressed
 * in the page); Escape or Close ends the search, clears its marks and gives
 * the keyboard back to the page. The field only says what to search for (the
 * list's `find`); browserViews.ts asks the shell. It is its tab's: mounted
 * per tab (keyed by the panel), it leaves with the tab and comes back with it.
 */
export function BrowserFindBar({ conversationId, find }: { conversationId: string; find: BrowserFind }) {
  const { formatMessage } = useIntl();
  const setFindText = useBrowserTabsStore((s) => s.setFindText);
  const stepFind = useBrowserTabsStore((s) => s.stepFind);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { tabId, text, found } = find;

  // Find was asked (again): the field takes the keyboard, its text selected to type over. Once per asking: a field
  // that only comes back with its tab takes the keyboard from nothing.
  useEffect(() => {
    if (focusHandled >= find.focus) return;
    focusHandled = find.focus;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [find.focus]);

  const type = useCallback((event: ChangeEvent<HTMLInputElement>) => setFindText(conversationId, event.target.value), [conversationId, setFindText]);
  const close = useCallback(() => closeBrowserFind(conversationId), [conversationId]);
  const previous = useCallback(() => stepFind(conversationId, tabId, false), [conversationId, stepFind, tabId]);
  const next = useCallback(() => stepFind(conversationId, tabId, true), [conversationId, stepFind, tabId]);
  const handleKey = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // The field's own Escape: the panel's (which closes the browser) doesn't run.
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      stepFind(conversationId, tabId, !event.shiftKey);
    }
  }, [close, conversationId, stepFind, tabId]);

  const label = formatMessage({ id: "webPreview.find.label" });
  const previousLabel = formatMessage({ id: "webPreview.find.previous" });
  const nextLabel = formatMessage({ id: "webPreview.find.next" });
  const closeLabel = formatMessage({ id: "webPreview.find.close" });
  const none = found === null || found.matches === 0;
  return (
    <div
      role="search"
      aria-label={label}
      className="flex h-(--shell-header-height,var(--header-height)) shrink-0 items-center justify-end gap-1 border-b border-line-seam bg-layer-canvas px-(--column-margin)"
      data-testid="web-preview-find"
    >
      <InputGroup size="md" className="mx-1 min-w-0 max-w-80 flex-1">
        <InputGroupInput
          ref={inputRef}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={label}
          placeholder={label}
          value={text}
          onChange={type}
          onKeyDown={handleKey}
          data-testid="web-preview-find-input"
        />
      </InputGroup>
      <span role="status" className="shrink-0 px-1 text-callout text-foreground-muted tabular-nums" data-testid="web-preview-find-count">
        {found === null ? null : found.matches === 0
          ? formatMessage({ id: "webPreview.find.none" })
          : formatMessage({ id: "webPreview.find.count" }, { active: found.active, total: found.matches })}
      </span>
      <Tooltip content={previousLabel}>
        <PanelAction aria-label={previousLabel} onClick={previous} disabled={none} data-testid="web-preview-find-previous">
          <ChevronUp />
        </PanelAction>
      </Tooltip>
      <Tooltip content={nextLabel}>
        <PanelAction aria-label={nextLabel} onClick={next} disabled={none} data-testid="web-preview-find-next">
          <ChevronDown />
        </PanelAction>
      </Tooltip>
      <Tooltip content={closeLabel}>
        <PanelAction aria-label={closeLabel} onClick={close} data-testid="web-preview-find-close">
          <X />
        </PanelAction>
      </Tooltip>
    </div>
  );
}
