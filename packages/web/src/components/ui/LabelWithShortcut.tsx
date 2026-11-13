import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import { KbdShortcut } from "@botiverse/raft-ui/wip";
import { keyboardPlatform, shortcutKeyNames, shortcutSpokenLabel } from "../../utils/keyboardShortcuts";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";

/**
 * A tooltip's content: its text, then its shortcut. Raft DS › Kbd: KbdShortcut
 * at `sm` inside TooltipContent after the text, a cap per key, drawn for the
 * platform the app's matchers read (`keyboardPlatform`). A fragment, not a
 * component of its own: raft-ui's TooltipContent lays out its direct children
 * (a leading element that isn't a Kbd or an inline part reads as an icon) and
 * sets the 6px before the caps itself. A screen reader hears the shortcut in
 * the reader's language (`shortcutSpokenLabel`).
 */
export function labelWithShortcut(label: ReactNode, shortcut: ShortcutCombo, formatMessage: IntlShape["formatMessage"]): ReactNode {
  return (
    <>
      {label}
      <KbdShortcut keys={shortcutKeyNames(shortcut)} platform={keyboardPlatform()} label={shortcutSpokenLabel(shortcut, formatMessage)} />
    </>
  );
}
