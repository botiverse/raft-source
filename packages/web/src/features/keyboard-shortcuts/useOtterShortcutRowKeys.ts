import { useMemo } from "react";
import { useMyAssistant } from "../../assistant/assistantClient";
import { useOtterVisibleSetting } from "../../assistant/assistantOtterState";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { keyboardPlatform } from "../../utils/keyboardShortcuts";
import { resolvedCombos, useShortcutOverrides } from "../shortcuts/overrides";
import { defaultCombos, getShortcutCommand } from "../shortcuts/registry";

/**
 * The otter row's keys (#proj-assistant:#21): where the otter's shortcut works (they have an assistant here with its
 * DM, and the "Show on every page" switch is on), the person's own keys, or its default while they left it without
 * one (the row then says Not set, so it can be set again here). Null otherwise, which drops the row. Asks the server
 * nothing: the shell's AssistantOtterLayer already loads the assistant.
 */
export function useOtterShortcutRowKeys(): ShortcutCombo | null {
  const mine = useMyAssistant({ ask: false });
  const assistant = mine.status === "ready" ? mine.assistant : null;
  const available = assistant !== null && assistant.dmChannelId !== null;
  const visible = useOtterVisibleSetting();
  const overrides = useShortcutOverrides();
  return useMemo(() => {
    if (!available || !visible) return null;
    const command = getShortcutCommand("assistant-otter");
    const platform = keyboardPlatform();
    return resolvedCombos(command, platform, overrides)[0] ?? defaultCombos(command, platform)[0] ?? null;
  }, [available, visible, overrides]);
}
