import { useIntl } from "react-intl";
import { KbdShortcut } from "@botiverse/raft-ui/wip";
import { keyboardPlatform, shortcutKeyNames, shortcutSpokenLabel } from "../../utils/keyboardShortcuts";
import { MOD_ENTER_SEND_SHORTCUT } from "./composerSendKey";

/**
 * "⌘Enter to send" (Ctrl+Enter elsewhere) in the toolbar while the person
 * types, when their account sends with ⌘/Ctrl+Enter (#triage:#210), so a
 * plain Enter that adds a line isn't a surprise. Quiet metadata in the hint
 * color (DS Kbd: a shortcut in running text, KbdShortcut at `sm`); only with a
 * fine pointer, where a keyboard is likely.
 */
export function ComposerSendKeyHint() {
  const { formatMessage } = useIntl();
  return (
    <span
      className="hidden items-center gap-1 text-caption text-foreground-hint pointer-fine:inline-flex"
      data-testid="composer-send-key-hint"
    >
      {formatMessage(
        { id: "message.composer.sendKeyHint" },
        {
          shortcut: (
            <KbdShortcut
              key="shortcut"
              keys={shortcutKeyNames(MOD_ENTER_SEND_SHORTCUT)}
              platform={keyboardPlatform()}
              label={shortcutSpokenLabel(MOD_ENTER_SEND_SHORTCUT, formatMessage)}
            />
          ),
        },
      )}
    </span>
  );
}
