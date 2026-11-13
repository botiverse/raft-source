import type { ChangeEvent as ReactChangeEvent, CompositionEvent as ReactCompositionEvent, RefObject } from "react";
import { useIntl } from "react-intl";
import { Search, X } from "lucide-react";
import { Button, InputGroup, InputGroupAddon, InputGroupInput, Kbd } from "@botiverse/raft-ui";

/**
 * DS Search field (`rf-search`): one 44px ink-bordered control with the
 * search glyph inside it, the clear button and the Esc hint at its end.
 * Shared by every search page head (and the slim overlay header) so the
 * field behaves the same in each.
 */
export function SearchQueryField({
  inputRef,
  query,
  placeholder,
  onChange,
  onCompositionStart,
  onCompositionEnd,
  onClear,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  placeholder: string;
  onChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: ReactCompositionEvent<HTMLInputElement>) => void;
  onClear: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <InputGroup className="min-w-0 flex-1">
      <InputGroupAddon align="inline-start">
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        value={query}
        onChange={onChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid="message-search-input"
      />
      {/* The Esc hint comes before the clear button: on a phone the hint is
          hidden, and the button, last in the field, sits 6px from its end. */}
      <InputGroupAddon align="inline-end">
        <Kbd className="hidden sm:inline-flex">
          Esc
        </Kbd>
        {query ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            onClick={onClear}
            aria-label={formatMessage({ id: "search.clearSearch" })}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </InputGroupAddon>
    </InputGroup>
  );
}
