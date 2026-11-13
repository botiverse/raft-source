import { useIntl } from "react-intl";
import { Button, ListRow, ListRowBody, ListRowDescription, ListRowTitle } from "@botiverse/raft-ui";
import { PHONE_MEDIA_QUERY } from "../../components/ui/NarrowDialog";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { isShortcutOverridden, useShortcutOverrides } from "../shortcuts/overrides";
import { SHORTCUT_COMMANDS } from "../shortcuts/registry";
import { openShortcutsToCustomize } from "./shortcutHelpStore";
import "../shortcuts/shortcutAccountBridge";

/**
 * Settings › Appearance › Keyboard, the row under the send key (Artea's mock, frame 9): "Keyboard shortcuts · N changed ·
 * Customize". A settings row in the section's ListRowGroup, like every other setting (cindyz, #proj-raft-ui:#220). Settings never changes shortcuts itself; Customize opens the panel, where they change. The count tells
 * someone they changed something. Not on a phone: Settings › Resources has the (read-only) shortcuts page there.
 */
export function ShortcutSettingsEntry() {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const overrides = useShortcutOverrides();
  if (phone) return null;
  const changed = SHORTCUT_COMMANDS.filter((command) => command.rebindable && isShortcutOverridden(command.id, overrides)).length;
  return (
    <ListRow variant="plain" interactive={false} data-testid="keyboard-shortcuts-settings-entry">
      <ListRowBody>
        <ListRowTitle id="keyboard-shortcuts-setting-label">{formatMessage({ id: "keyboardShortcuts.title" })}</ListRowTitle>
        <ListRowDescription wrap data-testid="keyboard-shortcuts-settings-changed">
          {formatMessage({ id: "keyboardShortcuts.settings.changed" }, { count: changed })}
        </ListRowDescription>
      </ListRowBody>
      <Button type="button" variant="outline" size="md" className="shrink-0" onClick={openShortcutsToCustomize}
        aria-describedby="keyboard-shortcuts-setting-label" data-testid="keyboard-shortcuts-customize">
        {formatMessage({ id: "keyboardShortcuts.settings.customize" })}
      </Button>
    </ListRow>
  );
}
