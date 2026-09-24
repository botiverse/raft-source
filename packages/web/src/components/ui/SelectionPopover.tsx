import type { KeyboardEvent, ReactNode } from "react";
import { Check } from "lucide-react";
import { useIntl } from "react-intl";

export interface SelectionPopoverOption {
  key: string;
  checked: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  italic?: boolean;
  avatar?: ReactNode;
  reserveLeadingSlot?: boolean;
  leading?: ReactNode;
}

interface SelectionPopoverBaseProps {
  title: string;
  options: SelectionPopoverOption[];
  showClear?: boolean;
  onClear?: () => void;
  showHeader?: boolean;
  emptyLabel?: string;
  className?: string;
  width?: "content" | "trigger";
}

interface SearchableSelectionPopoverProps extends SelectionPopoverBaseProps {
  searchable: true;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>, options: SelectionPopoverOption[]) => void;
}

interface PlainSelectionPopoverProps extends SelectionPopoverBaseProps {
  searchable?: false;
  search?: never;
  onSearchChange?: never;
  searchPlaceholder?: never;
  onInputKeyDown?: never;
}

type SelectionPopoverProps = SearchableSelectionPopoverProps | PlainSelectionPopoverProps;

/**
 * Shared option row for selection popovers.
 *
 * Origin: stdrc 2026-05-19 #proj-task:572c5ba6 msg=665751bc found filter
 * items with inconsistent heights. Avatar rows were taller than label-only
 * rows because row height was content-driven, and label-only sentinel/channel
 * rows did not reserve the avatar column.
 *
 * The row therefore uses a fixed `h-9` and can reserve a `size-5` leading
 * slot when the caller needs avatar/list baseline alignment. Search channel
 * rows pass a real leading icon instead, while Tasks channel rows intentionally
 * stay label-only so they match the existing Tasks list style.
 */
function SelectionPopoverOptionRow({
  checked,
  onClick,
  label,
  disabled = false,
  italic = false,
  avatar = null,
  reserveLeadingSlot = false,
  leading = null,
}: SelectionPopoverOption) {
  const leadingContent = leading ?? avatar;
  const labelClassName = italic
    ? "-mx-1 px-1 whitespace-nowrap leading-6 italic text-black/70"
    : "truncate leading-6";
  // Selection family contract (stdrc #proj-theme:ac79cf20 msg=32e323aa
  // + msg=832c2c02 + msg=b0b92c1c 2026-05-25): hover = bg-soft-signal/30
  // (shared with SegmentedControl unselected hover and the MenuItem
  // pure-action row), selected = no special bg — the trailing ✓ is the
  // canonical selected indicator. Drops the older yellow-fill "colored"
  // tone so Select / SelectionPopover / InlineBadgeEditor dropdowns +
  // sidebar action menus + right-click context menus all share one
  // hover token.
  const rowTone = disabled
    ? "cursor-not-allowed bg-white text-black/30"
    : "bg-white text-black hover:bg-soft-signal/30";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-full items-center justify-between gap-2 overflow-hidden border-b border-black/10 px-3 text-left text-xs font-bold last:border-b-0 ${rowTone}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {(reserveLeadingSlot || leadingContent) && (
          <span className="flex size-5 shrink-0 items-center justify-center">
            {leadingContent}
          </span>
        )}
        <span className={labelClassName}>
          {label}
        </span>
      </span>
      {checked && <Check size={12} className="shrink-0" />}
    </button>
  );
}

export default function SelectionPopover(props: SelectionPopoverProps) {
  const { formatMessage } = useIntl();
  const {
    title,
    options,
    showClear = false,
    onClear,
    showHeader = true,
    emptyLabel,
    width = "content",
    className = `absolute left-0 top-[calc(100%+8px)] z-20 ${width === "trigger" ? "w-full" : "min-w-[220px]"} border-2 border-black bg-white shadow-brutal`,
  } = props;
  const emptyLabelText = emptyLabel ?? formatMessage({ id: "ui.selectionPopover.emptyLabel" });

  return (
    <div className={className}>
      {showHeader && (
        <div className="flex items-center justify-between border-b border-black px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-black/60">
            {title}
          </span>
          {showClear && onClear && (
            <button
              type="button"
              onClick={onClear}
              className="text-[10px] font-bold tracking-wide text-black/50 hover:text-black"
            >
              {formatMessage({ id: "ui.selectionPopover.clear" })}
            </button>
          )}
        </div>
      )}
      {props.searchable && (
        <div className="border-b border-black px-2 py-2">
          <input
            type="text"
            autoFocus
            value={props.search}
            onChange={(event) => props.onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              props.onInputKeyDown?.(event, options);
            }}
            placeholder={props.searchPlaceholder ?? formatMessage({ id: "ui.selectionPopover.searchPlaceholder" })}
            className="input-brutal w-full px-2 py-1 text-xs font-mono"
          />
        </div>
      )}
      <div className="max-h-64 overflow-y-auto">
        {options.length === 0 ? (
          <div className="px-3 py-3 text-center text-[11px] font-mono text-black/40">
            {emptyLabelText}
          </div>
        ) : (
          options.map(({ key, ...option }) => (
            <SelectionPopoverOptionRow key={key} {...option} />
          ))
        )}
      </div>
    </div>
  );
}
