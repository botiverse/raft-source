import { Badge, Popover, PopoverContent, ScrollArea, TaskStatusBadge } from "@botiverse/raft-ui";
import type { BadgeProps, PopoverProps, TaskStatusId } from "@botiverse/raft-ui";
import { useCallback, useMemo, useRef } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronDown } from "lucide-react";

import { InlineBadgeMenuItem } from "./InlineBadgeMenuItem";
import { SelectionPopoverPanel } from "./ui/SelectionPopover";
import Tooltip from "./ui/Tooltip";
import { dismissLayerProps } from "./ui/dismissLayer";

export type InlineBadgeOption = { id: string; label: string; avatar?: ReactNode };

function noop() {}

function stopPropagation(event: { stopPropagation(): void }) {
  event.stopPropagation();
}
// Esc goes on to the popover, which closes on it.
function stopPropagationUnlessEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") event.stopPropagation();
}

type PopoverRootChangeEventDetails = Parameters<NonNullable<PopoverProps["onOpenChange"]>>[1];

interface InlineBadgeEditorProps {
  /** Display label shown in the badge */
  displayValue: string;
  /** Currently selected option ID (for highlight) */
  selectedId: string;
  /** `avatar` is rendered in a reserved leading slot, so a list of people lines
   *  up whether or not every entry has a picture. Status passes none. */
  options: InlineBadgeOption[];
  onSelect: (id: string) => Promise<void> | void;
  open: boolean;
  onToggle: () => void;
  onRequestClose?: () => void;
  badgeClassName: string;
  badgeVariant?: BadgeProps["variant"];
  /**
   * When set, the trigger renders raft-ui's `TaskStatusBadge` for this status,
   * so the icon + colours come from the single task-status source instead of a
   * caller-supplied `badgeClassName`. Status callsites use this; other badges
   * (e.g. a non-status pill) keep the generic `badgeClassName` path.
   */
  badgeStatus?: TaskStatusId;
  capitalize?: boolean;
  dropdownMinWidth?: string;
  dropdownAlign?: "left" | "right";
  disabled?: boolean;
  buttonTestId?: string;
  buttonDataTaskStatus?: string;
  buttonTitle?: string;
  buttonAriaLabel?: string;
  dropdownTestId?: string;
  optionTestIdPrefix?: string;
  buttonClassName?: string;
  buttonChildren?: ReactNode;
  /** The trigger, for what hangs from it besides the option list. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /**
   * Swap the local option list for the real `SelectionPopover` — the same
   * control the search page's filters use.
   *
   * @stdrc msg=4c357cb1: "assignee 选择框得复用搜索里那个 filter 的选择框，这两个
   * 本质上是同一个东西". They are: pick one of a set of people, where the set is
   * long enough to need typing. The trigger stays this component's badge so the
   * property row still reads like Status, which is the other half of that note.
   *
   * Status does not pass this: four options, a closed set, nothing to search.
   */
  searchable?: boolean;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  popoverTitle?: string;
  emptyLabel?: string;
  /**
   * A step after choosing (searchable only): shown in the picker's popover in
   * place of the list, e.g. the reason a task is handed to someone with. The
   * caller owns its focus and Escape; null/undefined shows the list.
   */
  panel?: ReactNode;
}

export default function InlineBadgeEditor({
  displayValue,
  selectedId,
  options,
  onSelect,
  open,
  onToggle,
  onRequestClose,
  badgeClassName,
  badgeVariant = "muted",
  badgeStatus,
  capitalize,
  dropdownMinWidth = "min-w-[120px]",
  dropdownAlign,
  disabled,
  buttonTestId,
  buttonDataTaskStatus,
  buttonTitle,
  buttonAriaLabel,
  dropdownTestId,
  optionTestIdPrefix,
  buttonClassName,
  buttonChildren,
  triggerRef: givenTriggerRef,
  searchable,
  search = "",
  onSearchChange,
  searchPlaceholder,
  popoverTitle,
  emptyLabel,
  panel,
}: InlineBadgeEditorProps) {
  const hasPanel = panel != null;
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = givenTriggerRef ?? ownTriggerRef;

  // The badge is not a PopoverTrigger: its own click toggles (`onToggle`), so a
  // press on it is not the outside press that closes the popover. Esc and a
  // press anywhere else are.
  const handleOpenChange = useCallback((next: boolean, details: PopoverRootChangeEventDetails) => {
    if (next) return;
    const target = details.event?.target;
    if (target instanceof Node && triggerRef.current?.contains(target)) return;
    (onRequestClose ?? onToggle)();
  }, [onRequestClose, onToggle, triggerRef]);

  const selectionOptions = useMemo(() => {
    const reserveLeadingSlot = options.some((o) => o.avatar);
    return options.map((opt) => ({
      key: opt.id,
      label: opt.label,
      checked: opt.id === selectedId,
      avatar: opt.avatar,
      reserveLeadingSlot,
      onClick: () => { void onSelect(opt.id); },
    }));
  }, [options, selectedId, onSelect]);

  // Unset: under the trigger's start edge on a wide screen, its end edge on a
  // phone (where a chip sits at the right of a row more often than not).
  const align = dropdownAlign === "left" ? "start"
    : dropdownAlign === "right" ? "end"
    : open && window.matchMedia("(min-width: 640px)").matches ? "start" : "end";

  // raft-ui's Popover places it (portaled, so a dragged card's lift or a
  // panel's clip never holds it; flipped and shifted at the window's edge) on
  // the popup layer, and owns Esc and the outside press. Presses inside stop
  // here: the editor often sits in a clickable or draggable card, and React
  // bubbles portal events through it.
  // Focus on open goes to the current option (its check), as raft-ui's menus and the server popover do, so the
  // first option is never shown as if picked. A touch opens it without moving focus (no keyboard). The search
  // box keeps its own focus in search mode.
  const contentRef = useRef<HTMLDivElement>(null);
  const focusCurrent = useCallback((openType: string) => {
    if (openType === "touch") return false;
    return contentRef.current?.querySelector<HTMLElement>("[data-current]") ?? true;
  }, []);
  const popover = (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverContent
        ref={contentRef}
        initialFocus={searchable ? undefined : focusCurrent}
        anchor={triggerRef}
        side="bottom"
        align={align}
        sideOffset={4}
        collisionPadding={8}
        aria-label={popoverTitle ?? buttonAriaLabel ?? displayValue}
        data-testid={dropdownTestId}
        className={searchable
          ? `flex max-w-(--available-width) flex-col ${hasPanel ? "w-[280px]" : "w-[240px]"}`
          : `flex flex-col p-0 ${dropdownMinWidth}`}
        onPointerDown={stopPropagation}
        onMouseDown={stopPropagation}
        onTouchStart={stopPropagation}
        onClick={stopPropagation}
        onKeyDown={stopPropagationUnlessEscape}
        {...dismissLayerProps}
      >
        {searchable && hasPanel ? panel : searchable ? (
          // The search box takes focus as the popover opens, and again when it
          // comes back from a `panel` step (it mounts afresh).
          <SelectionPopoverPanel
            searchable
            title={popoverTitle ?? ""}
            showHeader={!!popoverTitle}
            search={search}
            onSearchChange={onSearchChange ?? noop}
            searchPlaceholder={searchPlaceholder}
            emptyLabel={emptyLabel}
            options={selectionOptions}
          />
        ) : (
          // The options scroll in a raft-ui ScrollArea inside the popup, with
          // a menu's 4px padding on its content. Each option takes focus: no
          // tab stop.
          <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="flex flex-col p-1">
            {options.map((opt) => (
              <InlineBadgeMenuItem
                key={opt.id}
                option={opt}
                selected={opt.id === selectedId}
                onSelect={onSelect}
                testId={optionTestIdPrefix ? `${optionTestIdPrefix}-${opt.id}` : undefined}
              />
            ))}
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );

  // Raft Design System › StatusChip: an editable chip is a 22px soft chip
  // with a trailing chevron. raft-ui's Badge draws the chip, its hover/press
  // overlay and its disabled state; this class only lays the trigger out and
  // carries the caller's tone class. No case transform: the copy
  // ("In progress") renders as written.
  const defaultButtonClassName = `mt-0.5 inline-flex items-center gap-1 ${badgeClassName} disabled:cursor-not-allowed${capitalize ? " capitalize" : ""}`;

  const badge = badgeStatus ? (
    <TaskStatusBadge
      status={badgeStatus}
      render={<button ref={triggerRef} type="button" disabled={disabled} />}
      onClick={onToggle}
      data-testid={buttonTestId}
      // Set as a prop (as the Badge branch does) so a wrapping Tooltip's
      // trigger forwards it instead of stamping `tooltip-trigger`; parents
      // such as DescriptionList direction="inline" select on this slot.
      data-slot="task-status-badge"
      data-task-status={buttonDataTaskStatus}
      aria-label={buttonAriaLabel}
      aria-expanded={open}
      className={`mt-0.5 ${buttonClassName ?? ""}`.trim()}
    >
      {displayValue}
      <ChevronDown size={12} aria-hidden="true" />
    </TaskStatusBadge>
  ) : (
    <Badge
      render={<button ref={triggerRef} type="button" disabled={disabled} />}
      appearance="soft"
      variant={badgeVariant}
      onClick={onToggle}
      data-testid={buttonTestId}
      data-task-status={buttonDataTaskStatus}
      data-slot="badge"
      aria-label={buttonAriaLabel}
      aria-expanded={open}
      className={buttonClassName ?? defaultButtonClassName}
    >
      {buttonChildren ?? (
        <>
          {displayValue}
          <ChevronDown size={12} aria-hidden="true" />
        </>
      )}
    </Badge>
  );

  return (
    <>
      {buttonTitle ? <Tooltip content={buttonTitle}>{badge}</Tooltip> : badge}
      {popover}
    </>
  );
}
