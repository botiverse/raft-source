// Settings › Appearance › Keyboard (#triage:#210): how the message box sends.
// A choice that stands alone, so it applies at once (DS Forms and settings): a
// settings row whose control is a SegmentedControl naming the keys for this
// platform (⌘Enter on a Mac, Ctrl+Enter elsewhere). Nothing is said once it is
// stored; a failure goes back to the stored key and says so on a SaveStatus
// line right under the title (the row has no description). Stored on the account, so it follows the person to every
// device. The section is Keyboard, not Message box: Keyboard shortcuts is its
// second row and isn't about the message box (cindyz, #proj-raft-ui:#220).

import { useCallback, useId, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Keyboard } from "lucide-react";
import { ListRow, ListRowBody, ListRowGroup, ListRowTitle, SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "@botiverse/raft-ui";
import { SaveStatus, SaveStatusError } from "@botiverse/raft-ui/wip";
import SectionHeader from "../../../components/ui/SectionHeader";
import { ShortcutSettingsEntry } from "../../keyboard-shortcuts/ShortcutSettingsEntry";
import { formatShortcut } from "../../../utils/keyboardShortcuts";
import { MOD_ENTER_SEND_SHORTCUT, saveComposerSendKey, useComposerSendKey } from "../../composer/composerSendKey";
import type { ComposerSendKey } from "../../composer/composerSendKey";

export function ComposerSendKeySetting() {
  const { formatMessage } = useIntl();
  const idPrefix = useId();
  const mode = useComposerSendKey();
  const [failed, setFailed] = useState(false);
  // Only the latest change reports: an earlier one failing late says nothing.
  const sequence = useRef(0);
  const modEnter = formatShortcut(MOD_ENTER_SEND_SHORTCUT, undefined, formatMessage);
  const enter = formatShortcut({ key: "Enter" });

  const handleChange = useCallback((next: ComposerSendKey) => {
    const id = ++sequence.current;
    setFailed(false);
    saveComposerSendKey(next).catch(() => {
      if (id === sequence.current) setFailed(true);
    });
  }, []);

  return (
    <section className="mt-6" data-testid="composer-send-key-setting">
      <SectionHeader className="mb-3" icon={<Keyboard size={16} />} label={formatMessage({ id: "settings.appearance.keyboardSection" })} />
      <ListRowGroup className="@container">
        <ListRow id="send-with" variant="plain" interactive={false} className="@max-lg:flex-wrap">
          <ListRowBody>
            <ListRowTitle id={`${idPrefix}-label`}>{formatMessage({ id: "settings.appearance.sendKeyTitle" })}</ListRowTitle>
            <SaveStatus id={`${idPrefix}-status`}>
              {failed ? (
                <SaveStatusError data-testid="composer-send-key-error">{formatMessage({ id: "settings.appearance.sendKeySaveFailed" })}</SaveStatusError>
              ) : null}
            </SaveStatus>
          </ListRowBody>
          {/* Where the row is narrow (under 32rem of its own width) the control would squeeze the text into a sliver: it goes under it. */}
          <div className="shrink-0 @max-lg:basis-full">
            <SegmentedControl
              value={mode}
              aria-labelledby={`${idPrefix}-label`}
              aria-describedby={`${idPrefix}-status`}
              onValueChange={handleChange}
            >
              <SegmentedControlItem value="enter" data-testid="composer-send-key-enter">
                <SegmentedControlLabel>{enter}</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="mod_enter" data-testid="composer-send-key-mod-enter">
                <SegmentedControlLabel>{modEnter}</SegmentedControlLabel>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
        </ListRow>
        <ShortcutSettingsEntry />
      </ListRowGroup>
    </section>
  );
}
