import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Image, Copy, Check, Send, MoreHorizontal } from "lucide-react";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import Button from "../ui/Button";
import MenuItem from "../ui/MenuItem";
import Spinner from "../ui/Spinner";

export interface SelectModeToolbarProps {
  /** Channel id this toolbar is mounted under. Renders only when select mode is scoped here. */
  channelId: string;
  /** Click handler for the Share preview button. Disabled when 0 selected. */
  onSavePic: () => void;
  /** Preserved for phase 3 platform share targets inside the lightbox. */
  onShareX: () => void;
  /** Click handler for the Copy-MD button. Disabled when 0 selected. */
  onCopyMd: () => void;
  /** Click handler for opening the message-forward composer. */
  onForward?: () => void;
  /** Optional reason to disable forward buttons for unsupported source surfaces. */
  forwardDisabledReason?: string | null;
  /** Click handler for copying permalinks for the current selection. */
  onCopyLinks?: () => void;
  /** Optional thread-mode affordance for selecting parent + all replies. */
  onSelectAll?: () => void;
  /** True while the screenshot is being rendered for the Share preview. */
  capturing?: boolean;
  /** True for ~1.5s after Copy MD succeeds, swaps the icon for a check. */
  copied?: boolean;
}

/**
 * Bottom sticky toolbar shown while multi-select mode is active in a channel.
 * Layout: [N selected] [Cancel] [Forward] [More]
 */
export default function SelectModeToolbar({
  channelId,
  onSavePic,
  onCopyMd,
  onForward,
  forwardDisabledReason,
  onCopyLinks,
  onSelectAll,
  capturing = false,
  copied = false,
}: SelectModeToolbarProps) {
  const { formatMessage } = useIntl();
  const isActive = useSelectionStore((s) => s.isActive);
  const selectionChannelId = useSelectionStore((s) => s.channelId);
  const count = useSelectionStore((s) => s.selectedIds.size);
  const exit = useSelectionStore((s) => s.exit);
  const [moreOpen, setMoreOpen] = useState(false);
  const [compactLevel, setCompactLevel] = useState(0);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const lastActionsWidthRef = useRef(0);

  useEffect(() => {
    if (!moreOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (moreRef.current?.contains(event.target as Node)) return;
      setMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    // keydown-global-exempt: Escape closes the already-open More menu without moving focus.
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreOpen]);

  const canAct = count > 0 && !capturing;
  const canForward = canAct && !!onForward && !forwardDisabledReason;
  const toolbarButtonClass = "box-border appearance-none whitespace-nowrap px-1 focus:outline-none focus-visible:outline-none";
  const toolbarIconButtonClass = `${toolbarButtonClass} min-w-7 gap-0 sm:min-w-0`;
  const maxCompactLevel = 1 + (onCopyLinks ? 1 : 0) + (onForward ? 1 : 0) + (onSelectAll ? 1 : 0);
  const compactCopyLink = compactLevel >= 1;
  const compactForward = compactLevel >= 1 + (onCopyLinks ? 1 : 0);
  const compactCancel = compactLevel >= 1 + (onCopyLinks ? 1 : 0) + (onForward ? 1 : 0);
  const compactSelectAll = compactLevel >= maxCompactLevel;
  const moreDisabled = count === 0;
  const selectAllLabel = formatMessage({ id: "message.selectModeToolbar.selectAll" });
  const cancelLabel = formatMessage({ id: "message.selectModeToolbar.cancel" });
  const forwardLabel = formatMessage({ id: "message.selectModeToolbar.forward" });
  const copyLinkLabel = formatMessage({ id: "message.selectModeToolbar.copyLink" });
  const copiedLabel = formatMessage({ id: "message.selectModeToolbar.copied" });
  const moreLabel = formatMessage({ id: "message.selectModeToolbar.more" });
  const moreActionsLabel = formatMessage({ id: "message.selectModeToolbar.moreActions" });
  const renderingLabel = formatMessage({ id: "message.selectModeToolbar.rendering" });
  const generateImageLabel = formatMessage({ id: "message.selectModeToolbar.generateImage" });
  const copyMdLabel = formatMessage({ id: "message.selectModeToolbar.copyMd" });
  const copiedMdLabel = formatMessage({ id: "message.selectModeToolbar.copiedMd" });
  const runMoreAction = (action: () => void) => {
    setMoreOpen(false);
    action();
  };

  useLayoutEffect(() => {
    const actions = actionsRef.current;
    if (!actions) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = actions.clientWidth;
        const gap = Number.parseFloat(getComputedStyle(actions).columnGap) || 0;
        const childrenWidth = Array.from(actions.children).reduce((total, child) => {
          return total + (child as HTMLElement).offsetWidth;
        }, 0);
        const requiredWidth = childrenWidth + Math.max(0, actions.children.length - 1) * gap;
        const overflow = requiredWidth > width + 1;
        setCompactLevel((current) => {
          if (width > lastActionsWidthRef.current + 8 && current > 0) {
            lastActionsWidthRef.current = width;
            return 0;
          }
          lastActionsWidthRef.current = width;
          if (overflow && current < maxCompactLevel) return current + 1;
          return current;
        });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(actions);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [capturing, copied, compactLevel, count, maxCompactLevel, onCopyLinks, onForward, onSelectAll]);

  if (!isActive || selectionChannelId !== channelId) return null;

  // Keep the default action row short: selection count, cancel, primary
  // forward, common copy-link, and a More menu for lower-frequency actions.
  return (
    <div
      className="border-t-2 border-black bg-soft-signal safe-bottom"
      data-testid="select-mode-toolbar"
    >
      <div className="flex items-center gap-1 px-2 py-2 sm:gap-1.5 sm:px-2">
        <span
          className="font-mono text-xs font-bold text-black/70 whitespace-nowrap"
          data-testid="select-mode-count"
        >
          {formatMessage({ id: "message.selectModeToolbar.selectedCount" }, { count })}
        </span>
        <div ref={actionsRef} className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 sm:gap-1.5">
          {onSelectAll && (
            <Button
              type="button"
              onClick={onSelectAll}
              disabled={capturing}
              size="sm"
              shape={compactSelectAll ? "icon" : "text"}
              tone="white"
              aria-label={selectAllLabel}
              title={selectAllLabel}
              className={toolbarButtonClass}
              data-testid="select-mode-select-all"
            >
              {compactSelectAll ? <Check size={14} /> : selectAllLabel}
            </Button>
          )}
          <Button
            type="button"
            onClick={exit}
            size="sm"
            shape={compactCancel ? "icon" : "iconText"}
            tone="white"
            aria-label={cancelLabel}
            title={cancelLabel}
            className={toolbarIconButtonClass}
            data-testid="select-mode-cancel"
          >
            <X size={14} />
            {!compactCancel && <span>{cancelLabel}</span>}
          </Button>
          {onForward && (
            <Button
              type="button"
              onClick={onForward}
              disabled={!canForward}
              size="sm"
              shape={compactForward ? "icon" : "iconText"}
              tone="pink"
              aria-label={forwardLabel}
              title={forwardDisabledReason || forwardLabel}
              className={toolbarIconButtonClass}
              data-testid="select-mode-forward"
            >
              <Send size={14} />
              {!compactForward && <span>{forwardLabel}</span>}
            </Button>
          )}
          {onCopyLinks && (
            <Button
              type="button"
              onClick={onCopyLinks}
              disabled={count === 0}
              size="sm"
              shape={compactCopyLink ? "icon" : "iconText"}
              tone="white"
              aria-label={copyLinkLabel}
              title={copyLinkLabel}
              className={toolbarIconButtonClass}
              data-testid="select-mode-copy-link"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {!compactCopyLink && <span>{copied ? copiedLabel : copyLinkLabel}</span>}
            </Button>
          )}
          <div ref={moreRef} className="relative">
            <Button
              type="button"
              onClick={() => setMoreOpen((current) => !current)}
              disabled={moreDisabled}
              size="sm"
              shape="icon"
              tone="white"
              aria-label={moreActionsLabel}
              title={moreLabel}
              className={toolbarIconButtonClass}
              data-testid="select-mode-more"
              aria-expanded={moreOpen}
            >
              <MoreHorizontal size={14} />
            </Button>
            {moreOpen && (
              <div
                className="absolute bottom-[calc(100%+8px)] right-0 z-20 min-w-44 border-2 border-black bg-white shadow-brutal"
                role="menu"
                data-testid="select-mode-more-menu"
              >
                <MenuItem
                  icon={capturing ? <Spinner size="sm" /> : <Image size={14} />}
                  onClick={() => runMoreAction(onSavePic)}
                  disabled={!canAct}
                  data-testid="select-mode-share-open"
                >
                  {capturing ? renderingLabel : generateImageLabel}
                </MenuItem>
                <MenuItem
                  icon={copied ? <Check size={14} /> : <Copy size={14} />}
                  onClick={() => runMoreAction(onCopyMd)}
                  disabled={count === 0}
                  data-testid="select-mode-copy-md"
                >
                  {copied ? copiedMdLabel : copyMdLabel}
                </MenuItem>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
