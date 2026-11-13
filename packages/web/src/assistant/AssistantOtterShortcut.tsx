// The shortcut that hides the assistant's otter for now and shows it again
// (#proj-assistant:#21). The account keeps which shortcut: the keyboard
// shortcuts panel changes it (the registry's "assistant-otter"; its
// Settings-era choice still counts, features/shortcuts/overridesState.ts);
// the hide lasts for this tab (assistantOtterState). It only works where the
// otter could show: the person has an assistant here and its switch in the
// assistant's settings is on; the switch is the permanent way to turn the
// otter off, the shortcut a "not now". Web only, while a Raft page has focus;
// a system-wide shortcut in the desktop app is a separate decision.
//
// Never while typing: not in a field or editable text (the registry's
// textField "never"), and not during IME composition (the dispatcher's guard),
// so it can't eat a keystroke someone meant for the text.

import { useEffect } from "react";
import { useIntl } from "react-intl";
import { showToast } from "../components/toastBridge";
import { useShortcut } from "../features/shortcuts/useShortcut";
import { useShortcutBinding } from "../features/shortcuts/useShortcutBinding";
import "../features/shortcuts/shortcutAccountBridge";
import { isTypingTarget } from "./assistantOtterKeys";
import { AssistantPageOtter } from "./AssistantOtter";
import { useMyAssistant } from "./assistantClient";
import { isOtterHiddenForNow, setOtterHiddenForNow, useOtterVisibleSetting } from "./assistantOtterState";

function AssistantOtterShortcut() {
  const { formatMessage } = useIntl();
  const mine = useMyAssistant();
  const assistant = mine.status === "ready" ? mine.assistant : null;
  const available = assistant !== null && assistant.dmChannelId !== null;
  const visible = useOtterVisibleSetting();
  const binding = useShortcutBinding("assistant-otter");
  const name = assistant?.name ?? "";

  useShortcut("assistant-otter", (event) => {
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return false;
    const hide = !isOtterHiddenForNow();
    setOtterHiddenForNow(hide);
    if (hide) {
      showToast({
        title: formatMessage({ id: "assistant.otter.hiddenToast" }, { name, shortcut: binding.menuText }),
      });
    }
  }, { enabled: available && visible });

  // Turning the switch off ends a hide-for-now, so turning it on again shows the otter at once.
  useEffect(() => {
    if (!visible) setOtterHiddenForNow(false);
  }, [visible]);

  return null;
}

/**
 * The otter's parts in the app shell: the page otter where a page has no
 * composer (`pageOtter`), and the shortcut, which works on every page.
 */
export function AssistantOtterLayer({ pageOtter }: { pageOtter: boolean }) {
  return (
    <>
      {pageOtter ? <AssistantPageOtter /> : null}
      <AssistantOtterShortcut />
    </>
  );
}
