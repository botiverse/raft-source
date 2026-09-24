import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, MoreHorizontal, X } from "lucide-react";
import {
  Button as RaftButton,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Switch,
} from "raft-ui";
import Button from "./Button";
import type { MessageId } from "../../i18n/messages";

/**
 * Topbar overflow primitives (task #187, gated by
 * `topbar_overflow_v0`). Shared shell for the channel and thread
 * overflow menus: one compact trigger + a right-side Drawer.
 * On phones `max-w-[min(100vw,34rem)]` resolves to full width, so the
 * sheet IS the mobile page; the mobile chevron in the header doubles as
 * the back affordance, the X is desktop-only — mirroring the design's
 * "desktop dialog / mobile page with back" split without a new route.
 */

export function OverflowMenuTrigger({
  labelId,
  onClick,
  icon,
  testId,
}: {
  labelId: MessageId;
  onClick: () => void;
  /** Defaults to the generic overflow glyph; semantic surfaces may provide a more precise icon. */
  icon?: ReactNode;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <Button
      onClick={onClick}
      shape="icon"
      title={formatMessage({ id: labelId })}
      aria-label={formatMessage({ id: labelId })}
      data-testid={testId}
    >
      {icon ?? <MoreHorizontal size={14} />}
    </Button>
  );
}

export function OverflowSheet({
  open,
  onOpenChange,
  title,
  descriptionId,
  closeLabelId = "message.channelSettings.close",
  closeGuardRef,
  onCloseGuarded,
  hideDesktopClose = false,
  bare = false,
  testId,
  headerExtras,
  subtitle,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visible sheet title (e.g. `#general`, `Thread — #general`). */
  title: ReactNode;
  /** sr-only DrawerDescription text for assistive tech. */
  descriptionId: MessageId;
  /** aria-label for the mobile chevron / desktop X close buttons.
   *  Callers pass a sheet-specific key; the legacy channel-settings
   *  default only keeps hypothetical unupdated callers intact. */
  closeLabelId?: MessageId;
  /** Unsaved-draft guard (final6): while the ref reads true, EVERY
   *  dismissal (X / chevron / outside-press / swipe / escape) is
   *  cancelled and `onCloseGuarded` fires instead, so the host can
   *  prompt save-or-discard. Read at event time so dirtiness never
   *  re-renders this sheet. */
  closeGuardRef?: { current: boolean };
  onCloseGuarded?: () => void;
  /** Hide the explicit close affordances when the host wants the drawer to
   *  be dismissed only through outside press, swipe, or Escape. */
  hideDesktopClose?: boolean;
  /** Bare mode (drawer-internal page navigation, task #187): skips the
   *  built-in header and the padded scroll wrapper so the child page
   *  owns the full-bleed layout (own header / pinned footer). The
   *  DrawerContent classes — and therefore the sheet SIZE — are
   *  untouched; title/description stay mounted sr-only for a11y. */
  bare?: boolean;
  testId?: string;
  /** v2「重量随风险」 (Artea 2026-08-06): the yellow header IS the
   *  identity surface — extras (search icon, muted pill) render on the
   *  title row before the close affordance, subtitle (channel
   *  description) renders under it. Omit both for the plain header. */
  headerExtras?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const headerClassName = "flex h-panel-header shrink-0 items-center border-b-2 border-black bg-soft-signal px-4";
  return (
    <Drawer
      open={open}
      modal
      swipeDirection="right"
      onOpenChange={(nextOpen, eventDetails) => {
        if (!nextOpen && closeGuardRef?.current) {
          eventDetails.cancel();
          onCloseGuarded?.();
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DrawerContent
        data-testid={testId}
        className="inset-y-0 right-0 h-dvh w-full max-w-[min(100vw,34rem)] [--drawer-content-height:100dvh] [--drawer-inset:0px] flex-col rounded-none border-y-0 border-r-0 border-l-2 bg-brutal-cream"
      >
        {/* Bare mode HIDES the header instead of unmounting it and keeps
            the body wrapper as the same element at the same position —
            only its className changes — so children keep their React
            identity and a dirty settings draft survives root → page →
            back navigation. Title/description swap to sr-only copies so
            exactly one of each is mounted at a time. */}
        <div
          className={bare ? "hidden" : headerClassName}
          data-testid={bare ? undefined : "overflow-sheet-header"}
        >
          {/* Mobile has Back / identity / actions columns; desktop removes
              Back from layout and resolves to identity / actions. The
              subtitle starts in the SAME identity column as the title, so a
              channel description aligns with the #channel label at both
              breakpoints instead of falling back to the sheet's left edge. */}
          <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <DrawerClose
              render={(
                <Button
                  shape="icon"
                  className="md:hidden"
                  aria-label={formatMessage({ id: closeLabelId })}
                />
              )}
            >
              <ArrowLeft size={16} />
            </DrawerClose>
            <div className="min-w-0">
              <DrawerTitle
                className="truncate text-base font-bold leading-tight"
                data-testid="overflow-sheet-title"
              >
                {title}
              </DrawerTitle>
              <DrawerDescription className="sr-only">
                {formatMessage({ id: descriptionId })}
              </DrawerDescription>
              {subtitle && (
                <div className="min-w-0" data-testid="overflow-sheet-subtitle-row">
                  {subtitle}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerExtras}
              {!hideDesktopClose && (
                <DrawerClose
                  render={(
                    <Button
                      shape="icon"
                      className="max-md:hidden"
                      aria-label={formatMessage({ id: closeLabelId })}
                    />
                  )}
                >
                  <X size={16} />
                </DrawerClose>
              )}
            </div>
          </div>
        </div>
        {bare && (
          <>
            <DrawerTitle className="sr-only">{title}</DrawerTitle>
            <DrawerDescription className="sr-only">
              {formatMessage({ id: descriptionId })}
            </DrawerDescription>
          </>
        )}

        <div className={bare ? "flex min-h-0 flex-1 flex-col" : "min-h-0 flex-1 overflow-y-auto py-2"}>
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function OverflowActionRow({
  icon,
  label,
  onClick,
  trailing,
  danger = false,
  disabled = false,
  testId,
  className,
  ariaLabel,
}: {
  icon: ReactNode;
  label: ReactNode;
  onClick: () => void;
  /** Right-aligned auxiliary content (e.g. a count summary). */
  trailing?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  /** Keep the visual label terse without losing the full action scope. */
  ariaLabel?: string;
  /** Extra classes appended to the row — v2 uses it for the filled
   *  destructive block (Delete = the only filled action). */
  className?: string;
}) {
  return (
    <RaftButton
      variant={danger ? "danger" : "default"}
      size="lg"
      nativeButton
      type="button"
      className={`h-auto w-full justify-start gap-3 px-4 py-3 text-left [&_[data-slot=button-content]]:w-full [&_[data-slot=button-content]]:justify-start ${className ?? ""}`}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      <span data-icon="inline-start" className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
      {trailing && (
        <span className="ml-auto shrink-0 font-mono text-xs font-normal text-black/55">
          {trailing}
        </span>
      )}
    </RaftButton>
  );
}

/** Lightweight utility command for overflow sheets. Unlike
    OverflowActionRow, this carries no standalone box or shadow: low-risk
    navigation and subscription commands read as one flat list. */
export function OverflowCommandRow({
  icon,
  label,
  onClick,
  disabled = false,
  testId,
}: {
  icon: ReactNode;
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <RaftButton
      variant="ghost"
      size="md"
      nativeButton
      type="button"
      className="h-11 w-full justify-start gap-3 border-0 px-4 py-0 text-left font-medium shadow-none hover:translate-y-0 hover:border-0 hover:bg-black/5 hover:shadow-none active:translate-x-0 active:translate-y-0 active:shadow-none [&_[data-slot=button-content]]:w-full [&_[data-slot=button-content]]:justify-start"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      <span data-icon="inline-start" className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </RaftButton>
  );
}

export function OverflowSwitchRow({
  labelId,
  icon,
  label,
  checked,
  disabled = false,
  onCheckedChange,
  testId,
}: {
  /** Stable id anchor wiring the Switch's aria-labelledby. */
  labelId: string;
  icon: ReactNode;
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  testId?: string;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 px-4 py-3">
      <span id={labelId} className="flex min-w-0 items-center gap-3 text-sm font-bold text-black">
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <Switch
        size="md"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={labelId}
        data-testid={testId}
      />
    </div>
  );
}

/** Visual separator before a danger-zone group, with an optional group
    header (final4: groups are labeled by the state they mutate). */
export function OverflowDangerZone({
  children,
  labelId,
}: {
  children: ReactNode;
  labelId?: MessageId;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="mt-2 border-t-2 border-black pt-2">
      {labelId && (
        <div className="px-4 pb-1 text-xs font-bold tracking-wide text-black/65">
          {formatMessage({ id: labelId })}
        </div>
      )}
      {children}
    </div>
  );
}
