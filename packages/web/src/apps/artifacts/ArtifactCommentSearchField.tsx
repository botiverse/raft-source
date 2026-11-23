import { useCallback } from "react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import { useIntl } from "react-intl";
import { Search, X } from "lucide-react";
import { Button, InputGroup, InputGroupAddon, InputGroupInput } from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { isInputMethodKey } from "./artifactInputMethodKey";

/**
 * The comment list's search field (#proj-workspace:#341), in a row of the panel's head under its
 * title (as a thread's search and the Artifact's find bar sit under theirs): raft-ui's InputGroup
 * with the search glyph and, while it holds words, a × that clears them. Its first Esc clears the
 * words and keeps the focus in it; with nothing in it, Esc goes on to the panel (the surface's key
 * handler closes the list). An input method's Esc is the input method's. `fieldRef`: the panel's, so
 * an Esc elsewhere in the list that clears the words brings the focus here.
 */
export function ArtifactCommentSearchField({ query, onQuery, onClear, fieldRef }: {
  query: string;
  onQuery: (query: string) => void;
  onClear: () => void;
  fieldRef: RefObject<HTMLInputElement | null>;
}) {
  const { formatMessage } = useIntl();
  const change = useCallback((event: ChangeEvent<HTMLInputElement>) => onQuery(event.target.value), [onQuery]);
  const keyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || query === "" || isInputMethodKey(event)) return;
    // The field's, so the surface's Esc doesn't close the list too (isEscapeTakenElsewhere).
    event.preventDefault();
    onClear();
  }, [query, onClear]);
  // The × goes with the words: the focus stays in the field, as after Esc.
  const clear = useCallback(() => {
    onClear();
    fieldRef.current?.focus();
  }, [onClear, fieldRef]);
  const label = formatMessage({ id: "artifacts.comments.search" });
  const clearLabel = formatMessage({ id: "artifacts.find.clear" });
  return (
    <div role="search" className="shrink-0 border-b border-line-seam px-3 py-2" data-testid="artifact-comments-search">
      <InputGroup size="md">
        <InputGroupAddon>
          <Search aria-hidden size={14} />
        </InputGroupAddon>
        <InputGroupInput
          ref={fieldRef}
          // A searchbox, with our × only: the browser's own is hidden.
          type="search"
          className="[&::-webkit-search-cancel-button]:appearance-none"
          value={query}
          onChange={change}
          onKeyDown={keyDown}
          placeholder={label}
          aria-label={label}
          autoComplete="off"
          enterKeyHint="search"
          suppressPasswordManager
          data-testid="artifact-comments-search-input"
        />
        {query !== "" ? (
          <InputGroupAddon align="inline-end">
            <Tooltip content={clearLabel}>
              <Button type="button" size="icon-md" variant="ghost" onClick={clear} aria-label={clearLabel} data-testid="artifact-comments-search-clear">
                <X size={12} />
              </Button>
            </Tooltip>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  );
}
