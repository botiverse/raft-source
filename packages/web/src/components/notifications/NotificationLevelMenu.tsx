// The notification level picker (design §4.3, contract §1.1), as in Slack: a
// server's default level lives in Settings › Notifications; a channel can
// override it (Default / All new messages / Mentions) from its ⋯ sheet and the
// sidebar menu. Threads have no level, only Follow / Unfollow; DMs only Mute. Every write goes
// through PUT /api/notification-levels (useNotificationSettingsStore.setLevel);
// what `default` inherits is computed with the shared resolver, so the label
// says exactly what the server's policy will apply.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { Bell, BellMinus, BellRing, Check, ChevronRight } from "lucide-react";
import {
  ContextMenuLabel,
  ContextMenuPopup,
  Select,
  ScrollArea,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  toast,
} from "@botiverse/raft-ui";
import {
  NOTIFICATION_LEVELS,
  inheritedNotificationLevel,
  resolveEffectiveLevel,
} from "@botiverse/raft-shared";
import type { NotificationLevel, NotificationLevelSetting } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import {
  useExplicitNotificationLevel,
  useNotificationSettingsStore,
  useServerNotificationLevel,
} from "../../store/notificationSettingsStore";
import MenuItem from "../ui/MenuItem";
import { placeSidebarContextSubmenu } from "../layout/sidebarContextMenuPosition";

export const NOTIFICATION_LEVEL_LABEL_ID: Record<NotificationLevel, MessageId> = {
  all: "notifications.level.all",
  mentions: "notifications.level.mentions",
  none: "notifications.level.none",
};

/**
 * A channel's mute, shown as the picker's third choice (Slack): muting
 * silences the channel entirely, so it is one of the channel's levels to the
 * person, not a second switch.
 */
export interface NotificationMuteControl {
  muted: boolean;
  /** Resolves `false` when the change failed (the caller has already said so). */
  setMuted(next: boolean): Promise<boolean | void> | void;
}

export type NotificationLevelTarget =
  | { scope: "server"; serverId: string }
  | { scope: "channel"; serverId: string; channelId: string; mute?: NotificationMuteControl };

/** What a picker offers: a level, or (channels) Mute. */
export type NotificationLevelChoice = NotificationLevel | "mute";

export function isNotificationLevelChoice(value: unknown): value is NotificationLevelChoice {
  return value === "mute" || value === "all" || value === "mentions" || value === "none";
}

export interface NotificationLevelOption {
  value: NotificationLevelChoice;
  label: string;
}

export interface NotificationLevelModel {
  /**
   * The level the picker shows as chosen: a channel with nothing set shows the
   * server's level it inherits. There is no "Default" option (stdrc).
   */
  value: NotificationLevelChoice;
  /** What `default` inherits here (servers: their own level). */
  inherited: NotificationLevel;
  /** What applies: the most specific explicit setting; a muted channel pushes nothing. */
  effective: NotificationLevel;
  muted: boolean;
  options: NotificationLevelOption[];
  label(value: NotificationLevelSetting): string;
  set(choice: NotificationLevelChoice): Promise<boolean>;
}

/** Loads a server's explicit channel levels once, the first time a picker for it shows. */
function useEnsureServerLevels(serverId: string | null | undefined) {
  const loaded = useNotificationSettingsStore((s) => (serverId ? s.explicit[serverId]?.loaded === true : true));
  useEffect(() => {
    if (!serverId || loaded) return;
    void useNotificationSettingsStore.getState().loadServerLevels(serverId);
  }, [serverId, loaded]);
}

export function useNotificationLevelModel(target: NotificationLevelTarget): NotificationLevelModel {
  const { formatMessage } = useIntl();
  const serverId = target.serverId;
  useEnsureServerLevels(target.scope === "server" ? null : serverId);
  const serverLevel = useServerNotificationLevel(serverId);
  const channelSetting = useExplicitNotificationLevel(serverId, "channel", target.scope === "channel" ? target.channelId : null);
  const mute = target.scope === "channel" ? target.mute : undefined;
  const muted = mute?.muted === true;

  const inherited = target.scope === "server"
    ? serverLevel
    : inheritedNotificationLevel({ scope: "channel", server: serverLevel, channel: channelSetting });
  const level: NotificationLevel = target.scope === "server" || channelSetting === "default" ? inherited : channelSetting;
  const value: NotificationLevelChoice = muted ? "mute" : level;
  const effective = target.scope === "server"
    ? serverLevel
    : muted ? "none" : resolveEffectiveLevel({ server: serverLevel, channel: channelSetting, thread: null, muted: false });

  const levelName = useCallback((level: NotificationLevel) => formatMessage({ id: NOTIFICATION_LEVEL_LABEL_ID[level] }), [formatMessage]);
  const label = useCallback((level: NotificationLevelSetting) => levelName(level === "default" ? inherited : level), [inherited, levelName]);

  // A server: All / Only what involves me / Nothing. A channel with a mute
  // control: All / Only what involves me / Mute (Mute is its off switch).
  const hasMute = mute !== undefined;
  const options = useMemo<NotificationLevelOption[]>(() => {
    if (!hasMute) return NOTIFICATION_LEVELS.map((choice) => ({ value: choice, label: levelName(choice) }));
    const choices: NotificationLevelChoice[] = ["all", "mentions", "mute"];
    // A channel set to Nothing before Mute took its place keeps showing it.
    if (level === "none" && !muted) choices.splice(2, 0, "none");
    return choices.map((choice) => ({
      value: choice,
      label: choice === "mute" ? formatMessage({ id: "notifications.level.mute" }) : levelName(choice),
    }));
  }, [formatMessage, hasMute, level, levelName, muted]);

  const scope = target.scope;
  const id = target.scope === "server" ? target.serverId : target.channelId;
  const set = useCallback(async (choice: NotificationLevelChoice) => {
    if (choice === "mute") {
      await mute?.setMuted(true);
      return true;
    }
    // Unmute first; a failed unmute (it reports itself) leaves the level as it is.
    if (muted && (await mute?.setMuted(false)) === false) return false;
    if (choice === level) return true;
    // Choosing the server's own level in a channel goes back to following the
    // server, so a later server change still reaches the channel.
    const stored = scope === "channel" && choice === inherited ? "default" : choice;
    const ok = await useNotificationSettingsStore.getState().setLevel({ scope, id, serverId, level: stored });
    if (!ok) {
      toast.error(formatMessage({ id: "notifications.level.saveFailed" }));
      return false;
    }
    return true;
  }, [formatMessage, id, inherited, level, mute, muted, scope, serverId]);

  return { value, inherited, effective, muted, options, label, set };
}

/** The note under a picker: what Mute means, while it is the choice. */
function useLevelNotes(model: Pick<NotificationLevelModel, "muted">): string[] {
  const { formatMessage } = useIntl();
  return model.muted ? [formatMessage({ id: "notifications.level.muteNote" })] : [];
}

export function NotificationLevelNotes({ model, className = "" }: { model: Pick<NotificationLevelModel, "muted">; className?: string }) {
  const notes = useLevelNotes(model);
  if (notes.length === 0) return null;
  return (
    <div className={`stack-y-1 text-footnote text-foreground-muted ${className}`} data-testid="notification-level-notes">
      {notes.map((note) => <p key={note}>{note}</p>)}
    </div>
  );
}

/**
 * The level's icon. "Nothing" is BellMinus, not BellOff: BellOff means the
 * Activity mute (icon audit v7), which is shown separately from the level.
 */
export function levelIcon(level: NotificationLevel, size = 14): ReactElement {
  if (level === "all") return <BellRing size={size} />;
  if (level === "none") return <BellMinus size={size} />;
  return <Bell size={size} />;
}

// ---------------------------------------------------------------------------
// Select (settings rows, the channel ⋯ sheet)
// ---------------------------------------------------------------------------

export function NotificationLevelSelect({
  target,
  className = "w-full max-w-sm",
  fit = false,
  disabled = false,
  showNotes = true,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  testId,
}: {
  target: NotificationLevelTarget;
  className?: string;
  /** raft-ui's `SelectTrigger fit`: as wide as the longest level, for a select at a settings row's end. */
  fit?: boolean;
  disabled?: boolean;
  showNotes?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  testId?: string;
}) {
  const model = useNotificationLevelModel(target);
  const [busy, setBusy] = useState(false);
  const handleChange = useCallback((next: unknown) => {
    if (!isNotificationLevelChoice(next) || next === model.value) return;
    setBusy(true);
    void model.set(next).finally(() => setBusy(false));
  }, [model]);
  return (
    <div className="stack-y-1.5">
      <Select value={model.value} onValueChange={handleChange} disabled={disabled || busy} items={model.options}>
        <SelectTrigger fit={fit} className={className} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} data-testid={testId}>
          <SelectValue />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {model.options.map((option) => (
              <SelectItem key={option.value} value={option.value} data-testid={testId ? `${testId}-${option.value}` : undefined}>
                <SelectItemText>{option.label}</SelectItemText>
                <SelectItemIndicator />
              </SelectItem>
            ))}
          </SelectList>
        </SelectContent>
      </Select>
      {showNotes && <NotificationLevelNotes model={model} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar row context menu (hand-rolled MenuItem popups): Notifications ▸
// ---------------------------------------------------------------------------

/**
 * "Notifications ▸" in a hand-rolled context menu (the sidebar's row menu):
 * the trigger row, and on hover / click a submenu beside it with the levels.
 * Hovering another row of the menu closes it, as the sidebar's Move to
 * section ▸ does. `onDone` closes the whole menu after a choice.
 */
export function NotificationLevelSubmenu({
  target,
  onDone,
}: {
  target: Extract<NotificationLevelTarget, { scope: "channel" }>;
  onDone: () => void;
}) {
  const { formatMessage } = useIntl();
  const model = useNotificationLevelModel(target);
  const notes = useLevelNotes(model);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const label = formatMessage({ id: "notifications.level.menuLabel" });

  const openMenu = useCallback(() => setOpen(true), []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    setPosition(placeSidebarContextSubmenu({
      anchor: { left: triggerRect.left, right: triggerRect.right, top: triggerRect.top },
      menuWidth: menuRect.width,
      menuHeight: menuRect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }));
  }, [open]);

  // Another row of the parent menu hovered or focused: close, like Move to section ▸.
  useEffect(() => {
    if (!open) return;
    const closeFrom = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest('[role="menuitem"]');
      if (!row) return;
      if (triggerRef.current?.contains(row) || menuRef.current?.contains(row)) return;
      setOpen(false);
    };
    document.addEventListener("mouseover", closeFrom);
    document.addEventListener("focusin", closeFrom);
    return () => {
      document.removeEventListener("mouseover", closeFrom);
      document.removeEventListener("focusin", closeFrom);
    };
  }, [open]);

  const menuStyle = useMemo<CSSProperties>(() => ({
    left: position?.x ?? 0,
    top: position?.y ?? 0,
    visibility: position ? "visible" : "hidden",
  }), [position]);

  const choose = useCallback((choice: NotificationLevelChoice) => {
    if (choice !== model.value) void model.set(choice);
    setOpen(false);
    onDone();
  }, [model, onDone]);

  return (
    <>
      <div ref={triggerRef}>
        <MenuItem
          icon={levelIcon(model.effective)}
          aria-haspopup="menu"
          aria-expanded={open}
          trailing={<ChevronRight size={14} />}
          onMouseEnter={openMenu}
          onClick={openMenu}
          data-testid="sidebar-ctx-notification-level"
        >
          {label}
        </MenuItem>
      </div>
      {open && createPortal(
        <ContextMenuPopup
          ref={menuRef}
          role="menu"
          aria-label={label}
          className="fixed z-popup max-h-[calc(100vh-16px)] w-72 select-none p-0"
          style={menuStyle}
          onMouseDown={stopPropagation}
          onTouchStart={stopPropagation}
          data-testid="sidebar-ctx-notification-level-menu"
        >
          {/* The popup is the frame; the list scrolls in a raft-ui ScrollArea
              inside it, padded on its content (the popup's 4px). */}
          <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="flex flex-col p-1">
            {model.options.map((option) => (
              <LevelMenuItem key={option.value} option={option} current={option.value === model.value} onChoose={choose} />
            ))}
            {notes.map((note) => (
              <ContextMenuLabel key={note} className="whitespace-normal font-normal text-foreground-muted">{note}</ContextMenuLabel>
            ))}
          </ScrollArea>
        </ContextMenuPopup>,
        document.body,
      )}
    </>
  );
}

function stopPropagation(event: { stopPropagation(): void }) {
  event.stopPropagation();
}

function LevelMenuItem({ option, current, onChoose }: {
  option: NotificationLevelOption;
  current: boolean;
  onChoose: (choice: NotificationLevelChoice) => void;
}) {
  const choose = useCallback(() => onChoose(option.value), [onChoose, option.value]);
  return (
    <MenuItem
      role="menuitemradio"
      aria-checked={current}
      trailing={current ? <Check size={16} /> : null}
      onClick={choose}
      data-testid={`sidebar-ctx-notification-level-${option.value}`}
    >
      <span className="min-w-0 whitespace-normal">{option.label}</span>
    </MenuItem>
  );
}

/** A labelled settings row control: title + the select. */
export function NotificationLevelRow({
  title,
  description,
  target,
  testId,
  trailing,
}: {
  title: ReactNode;
  description?: ReactNode;
  target: NotificationLevelTarget;
  testId?: string;
  trailing?: ReactNode;
}) {
  const labelId = useMemo(() => `notification-level-${target.scope}-${target.scope === "server" ? target.serverId : target.channelId}`, [target]);
  return (
    <div className="stack-y-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div id={labelId} className="text-subhead font-semibold text-foreground">{title}</div>
          {description && <div className="mt-0.5 text-footnote text-foreground-muted">{description}</div>}
        </div>
        {trailing}
      </div>
      <NotificationLevelSelect target={target} aria-labelledby={labelId} testId={testId} />
    </div>
  );
}
