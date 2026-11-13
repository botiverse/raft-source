import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { Info } from "lucide-react";
import { TextLink } from "@botiverse/raft-ui";
import { useServerStore } from "../../store/serverStore";
import { formatShortcut } from "../../utils/keyboardShortcuts";
import { MOD_ENTER_SEND_SHORTCUT, useComposerSendKey } from "../composer/composerSendKey";

/**
 * The message box's send key in the panel (Artea's mock, frame 1): a Settings choice, not a shortcut to rebind
 * ("Enter / ⌘Enter to send" stays the two-way choice), so a note with a link to it in place of the send and new
 * line rows.
 */
export function ShortcutSendKeyNote() {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const mode = useComposerSendKey();
  const note = mode === "mod_enter"
    ? formatMessage({ id: "keyboardShortcuts.messageBox.noteModEnter" }, { modEnter: formatShortcut(MOD_ENTER_SEND_SHORTCUT, undefined, formatMessage) })
    : formatMessage({ id: "keyboardShortcuts.messageBox.noteEnter" });
  const open = useCallback(() => {
    if (serverSlug) navigate(`/s/${serverSlug}/settings/appearance#send-with`);
  }, [navigate, serverSlug]);
  return (
    <p className="flex items-start gap-1.5 py-1.5 text-footnote text-foreground-hint" data-testid="keyboard-shortcuts-send-note">
      <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {note}{" "}
        <TextLink render={<button type="button" />} onClick={open}>
          {formatMessage({ id: "keyboardShortcuts.messageBox.changeInSettings" })}
        </TextLink>
      </span>
    </p>
  );
}
