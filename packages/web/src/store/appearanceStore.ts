import { create } from "zustand";
import {
  readHideEmptySidebarSections,
  writeHideEmptySidebarSections,
} from "../components/layout/sidebarEmptySectionVisibility";

export type MessageBodyFontSize = "sm" | "md" | "lg";

export const MESSAGE_BODY_FONT_SIZE_STORAGE_KEY = "slock_message_body_font_size";
export const SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY = "slock_show_live_agent_activity_bar";
export const SHOW_AGENT_MODEL_NAME_STORAGE_KEY = "slock_show_agent_model_name";
export const SHOW_SENDER_DESCRIPTION_STORAGE_KEY = "slock_show_sender_description";

// Size and line height together, as the named text-* styles set them: the
// line moves 4px a tier, so a phone reads 14/20, 16/24, 18/28 and a desktop
// 12/18, 14/22, 16/26.
const BODY_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: "text-[length:calc(var(--text-body)_-_2px)] leading-[calc(var(--text-body--line-height)_-_4px)]",
  md: "text-[length:var(--text-body)] leading-[var(--text-body--line-height)]",
  lg: "text-[length:calc(var(--text-body)_+_2px)] leading-[calc(var(--text-body--line-height)_+_4px)]",
};

export const MESSAGE_BODY_FONT_SIZE_OPTIONS: Array<{
  value: MessageBodyFontSize;
  className: string;
}> = [
  { value: "sm", className: BODY_SIZE_CLASSES.sm },
  { value: "md", className: BODY_SIZE_CLASSES.md },
  { value: "lg", className: BODY_SIZE_CLASSES.lg },
];

/**
 * Raft Design System › Message: message text is `text-body`, 14/22 on a
 * desktop (Feishu's PC scale) and 16/24 on a phone and a touch screen
 * (raft-design typography.md). The tiers are relative to it, so one stored
 * choice reads right on both: Medium is the body size, Small and Large sit
 * 2px either side. On a desktop that is 12/14/16, the sizes the tiers had
 * before the new Raft look moved message text to 16px (task #114).
 */
const MESSAGE_BODY_FONT_SIZE_CLASSES: Record<MessageBodyFontSize, string> = BODY_SIZE_CLASSES;

/**
 * RUI's MessageItemBody recipe intentionally provides a family default size
 * (`theme-*:text-sm`). The product preference is a user-owned override, so it
 * needs a terminal inline value at the shared message-body seam rather than a
 * class whose cascade position can be changed by a theme recipe.
 */
const MESSAGE_BODY_FONT_SIZE_VALUES: Record<MessageBodyFontSize, { fontSize: string; lineHeight: string }> = {
  sm: { fontSize: "calc(var(--text-body) - 2px)", lineHeight: "calc(var(--text-body--line-height) - 4px)" },
  md: { fontSize: "var(--text-body)", lineHeight: "var(--text-body--line-height)" },
  lg: { fontSize: "calc(var(--text-body) + 2px)", lineHeight: "calc(var(--text-body--line-height) + 4px)" },
};

function isMessageBodyFontSize(value: unknown): value is MessageBodyFontSize {
  return value === "sm" || value === "md" || value === "lg";
}

function normalizeMessageBodyFontSize(value: unknown): MessageBodyFontSize {
  return value === "sm" || value === "lg" ? value : "md";
}

function readStoredMessageBodyFontSize(): MessageBodyFontSize {
  if (typeof localStorage === "undefined") return "md";
  try {
    return normalizeMessageBodyFontSize(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY));
  } catch {
    return "md";
  }
}

function persistMessageBodyFontSize(size: MessageBodyFontSize) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY, size);
  } catch {
    // Keep the in-memory preference responsive even when storage is unavailable.
  }
}

function readStoredShowLiveAgentActivityBar(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function persistShowLiveAgentActivityBar(show: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY, String(show));
  } catch {
    // Keep the in-memory preference responsive even when storage is unavailable.
  }
}

// Default ON everywhere (@WAWQAQ 2026-09-10): the model label next to each
// agent name now shows by default on web AND desktop — previously desktop-only.
// An explicit stored choice (either way) always wins.
function readStoredShowAgentModelName(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const stored = localStorage.getItem(SHOW_AGENT_MODEL_NAME_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function persistShowAgentModelName(show: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHOW_AGENT_MODEL_NAME_STORAGE_KEY, String(show));
  } catch {
    // Keep the in-memory preference responsive even when storage is unavailable.
  }
}

// The sender's description on a message's author row (#14629, cindyz): on by
// default; a person who finds it noisy turns it off here (Android feedback via
// Lagoon, #triage:4eb8046c). Humans and agents alike; the hover card keeps it.
function readStoredShowSenderDescription(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    const stored = localStorage.getItem(SHOW_SENDER_DESCRIPTION_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function persistShowSenderDescription(show: boolean) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SHOW_SENDER_DESCRIPTION_STORAGE_KEY, String(show));
  } catch {
    // Keep the in-memory preference responsive even when storage is unavailable.
  }
}

export function getMessageBodyFontSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_BODY_FONT_SIZE_CLASSES[size];
}

/**
 * Font-preference companions — 2026-10-11 (cindyz: the name, the name-line
 * notes, and the reply preview scale with the reader's message size). The
 * middle tier is the Raft Design System's: the name in `text-subhead` (15 on
 * a phone, 14 on a desktop), notes in `text-caption` (12), the time in
 * `text-mono-meta` (12), the reply preview in `text-footnote` (13 / 12) with
 * its time in `text-caption`. Like the body, they read the scale's variables,
 * so a desktop gets its sizes.
 * Sizes are arbitrary length values, so each utility sets the size alone.
 * tailwind-merge keeps one font size per element, so it drops the recipe's
 * named text-* style, and with it the line height (and, for caption, the
 * weight) that style carries: the name-line classes set both again from the
 * same style's tokens. A tier moves the line with the size,
 * keeping the style's own leading (line − size): name 12/20 · 14/22 · 16/24 on
 * a desktop and 13/18 · 15/20 · 17/22 on a phone; notes and time 11/17 ·
 * 12/18 · 13/19 and 11/15 · 12/16 · 13/17. The header lays them out on one
 * baseline (raft-design alignment.md, "Text of different sizes on one line"),
 * so the notes' smaller lines sit inside the name's and the line is the
 * name's height. Hard-coded `leading-5` / `leading-4` used to stand in for
 * these and missed the desktop's 22/18.
 */
const MESSAGE_NAME_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: "text-[length:calc(var(--text-subhead)_-_2px)] leading-[calc(var(--text-subhead--line-height)_-_2px)]",
  md: "text-[length:var(--text-subhead)] leading-[var(--text-subhead--line-height)]",
  lg: "text-[length:calc(var(--text-subhead)_+_2px)] leading-[calc(var(--text-subhead--line-height)_+_2px)]",
};

const MESSAGE_META_WEIGHT_CLASS = "font-[number:var(--text-caption--font-weight)]";

const MESSAGE_META_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: `text-[length:calc(var(--text-caption)_-_1px)] leading-[calc(var(--text-caption--line-height)_-_1px)] ${MESSAGE_META_WEIGHT_CLASS}`,
  md: `text-[length:var(--text-caption)] leading-[var(--text-caption--line-height)] ${MESSAGE_META_WEIGHT_CLASS}`,
  lg: `text-[length:calc(var(--text-caption)_+_1px)] leading-[calc(var(--text-caption--line-height)_+_1px)] ${MESSAGE_META_WEIGHT_CLASS}`,
};

const MESSAGE_TIME_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: "text-[length:calc(var(--text-mono-meta)_-_1px)] leading-[calc(var(--text-mono-meta--line-height)_-_1px)]",
  md: "text-[length:var(--text-mono-meta)] leading-[var(--text-mono-meta--line-height)]",
  lg: "text-[length:calc(var(--text-mono-meta)_+_1px)] leading-[calc(var(--text-mono-meta--line-height)_+_1px)]",
};

const MESSAGE_PREVIEW_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: "text-[length:calc(var(--text-footnote)_-_1px)]",
  md: "text-[length:var(--text-footnote)]",
  lg: "text-[length:calc(var(--text-footnote)_+_1px)]",
};

const MESSAGE_PREVIEW_TIME_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: "text-[length:calc(var(--text-caption)_-_1px)]",
  md: "text-[length:var(--text-caption)]",
  lg: "text-[length:calc(var(--text-caption)_+_1px)]",
};

export function getMessageNameSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_NAME_SIZE_CLASSES[size];
}

export function getMessageMetaSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_META_SIZE_CLASSES[size];
}

export function getMessageTimeSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_TIME_SIZE_CLASSES[size];
}

export function getMessagePreviewSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_PREVIEW_SIZE_CLASSES[size];
}

export function getMessagePreviewTimeSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_PREVIEW_TIME_SIZE_CLASSES[size];
}

export function getMessageBodyFontSizeStyle(size: MessageBodyFontSize): { fontSize: string; lineHeight: string } {
  return { ...MESSAGE_BODY_FONT_SIZE_VALUES[size] };
}

/**
 * The sender avatar's size at the reader's message size: Large draws it at
 * 34px over raft-ui MessageItem's `--mi-avatar`; the other tiers keep the
 * recipe's. Shared by MessageItem and the message skeleton (bootSkeletons),
 * so a placeholder row is the loaded row's size at every tier.
 */
export function getMessageAvatarSizeClass(size: MessageBodyFontSize): string {
  return size === "lg" ? "[--mi-avatar:2.125rem]" : "";
}

/**
 * The composer's text at the reader's message size, 1.5 lines high: its one
 * empty line sets the composer's height. Shared by MessageInput and the
 * composer's placeholder (bootSkeletons ComposerBox).
 */
export function getComposerFontStyle(size: MessageBodyFontSize): { fontSize: string; lineHeight: number } {
  return { fontSize: MESSAGE_BODY_FONT_SIZE_VALUES[size].fontSize, lineHeight: 1.5 };
}

interface AppearanceState {
  messageBodyFontSize: MessageBodyFontSize;
  showLiveAgentActivityBar: boolean;
  showAgentModelName: boolean;
  showSenderDescription: boolean;
  hideEmptySidebarSections: boolean;
  setMessageBodyFontSize: (size: MessageBodyFontSize) => void;
  setShowLiveAgentActivityBar: (show: boolean) => void;
  setShowAgentModelName: (show: boolean) => void;
  setShowSenderDescription: (show: boolean) => void;
  setHideEmptySidebarSections: (hide: boolean) => void;
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  messageBodyFontSize: readStoredMessageBodyFontSize(),
  showLiveAgentActivityBar: readStoredShowLiveAgentActivityBar(),
  showAgentModelName: readStoredShowAgentModelName(),
  showSenderDescription: readStoredShowSenderDescription(),
  // Shared with the sidebar section context menu; both read/write this store so
  // Settings ⇄ right-click stay in sync. Default + storage live in
  // sidebarEmptySectionVisibility (default off; stored choice wins).
  hideEmptySidebarSections: readHideEmptySidebarSections(),
  setMessageBodyFontSize: (size) => {
    const next = normalizeMessageBodyFontSize(size);
    persistMessageBodyFontSize(next);
    set({ messageBodyFontSize: next });
  },
  setShowLiveAgentActivityBar: (show) => {
    persistShowLiveAgentActivityBar(show);
    set({ showLiveAgentActivityBar: show });
  },
  setShowAgentModelName: (show) => {
    persistShowAgentModelName(show);
    set({ showAgentModelName: show });
  },
  setShowSenderDescription: (show) => {
    persistShowSenderDescription(show);
    set({ showSenderDescription: show });
  },
  setHideEmptySidebarSections: (hide) => {
    writeHideEmptySidebarSections(hide);
    set({ hideEmptySidebarSections: hide });
  },
}));

export function seedMessageBodyFontSizeFromProfile(
  size: MessageBodyFontSize | null | undefined,
) {
  if (!isMessageBodyFontSize(size) || typeof localStorage === "undefined") return;
  try {
    if (isMessageBodyFontSize(localStorage.getItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY))) {
      return;
    }
    localStorage.setItem(MESSAGE_BODY_FONT_SIZE_STORAGE_KEY, size);
    useAppearanceStore.setState({ messageBodyFontSize: size });
  } catch {
    // Profile migration is best-effort; the local in-memory default still works.
  }
}
