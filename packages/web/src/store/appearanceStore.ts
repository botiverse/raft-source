import { create } from "zustand";
import { isElectronDesktopShell } from "../utils/desktopShell";

export type MessageBodyFontSize = "sm" | "md" | "lg";

export const MESSAGE_BODY_FONT_SIZE_STORAGE_KEY = "slock_message_body_font_size";
export const SHOW_LIVE_AGENT_ACTIVITY_BAR_STORAGE_KEY = "slock_show_live_agent_activity_bar";
export const SHOW_AGENT_MODEL_NAME_STORAGE_KEY = "slock_show_agent_model_name";

export const MESSAGE_BODY_FONT_SIZE_OPTIONS: Array<{
  value: MessageBodyFontSize;
  sizeLabel: string;
  className: string;
}> = [
  { value: "sm", sizeLabel: "12px", className: "text-xs" },
  { value: "md", sizeLabel: "14px", className: "text-sm" },
  { value: "lg", sizeLabel: "16px", className: "text-base" },
];

const MESSAGE_BODY_FONT_SIZE_CLASSES: Record<MessageBodyFontSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
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

// Platform-aware default (@WAWQAQ): ON in the desktop shell, OFF on web/mobile —
// an explicit stored choice (either way) always wins. It adds a model label next
// to every agent name, which desktop wants by default but web keeps opt-in.
function readStoredShowAgentModelName(): boolean {
  const fallback = isElectronDesktopShell();
  if (typeof localStorage === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(SHOW_AGENT_MODEL_NAME_STORAGE_KEY);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
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

export function getMessageBodyFontSizeClass(size: MessageBodyFontSize): string {
  return MESSAGE_BODY_FONT_SIZE_CLASSES[size];
}

interface AppearanceState {
  messageBodyFontSize: MessageBodyFontSize;
  showLiveAgentActivityBar: boolean;
  showAgentModelName: boolean;
  setMessageBodyFontSize: (size: MessageBodyFontSize) => void;
  setShowLiveAgentActivityBar: (show: boolean) => void;
  setShowAgentModelName: (show: boolean) => void;
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  messageBodyFontSize: readStoredMessageBodyFontSize(),
  showLiveAgentActivityBar: readStoredShowLiveAgentActivityBar(),
  showAgentModelName: readStoredShowAgentModelName(),
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
