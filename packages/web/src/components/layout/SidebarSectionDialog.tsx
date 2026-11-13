import { InputGroup, InputGroupAddon, InputGroupInput, Button } from "@botiverse/raft-ui";
import { useCallback, useId, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import DialogCard from "../ui/DialogCard";
import SidebarSectionEmojiPicker from "./SidebarSectionEmojiPicker";
import { SectionConversationPicker, useSectionConversationSelection } from "./SidebarSectionAddConversationsDialog";
import type { SidebarSectionCandidate, SidebarSectionConversationChange } from "./SidebarSectionAddConversationsDialog";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";

/** The card pads the dialog already, so its footer adds no padding of its own. */

const NO_CANDIDATES: SidebarSectionCandidate[] = [];
const NO_KEYS: string[] = [];

/**
 * Create / rename a custom sidebar section (Raft Design System › Dialog): the
 * product's DialogCard shell (popover layer, 16px radius, headline title,
 * ghost close), one labelled field, then at most two actions — a ghost Cancel
 * on the left and the pink primary on the right, the dialog's one reason to
 * exist.
 */
export default function SidebarSectionDialog({
  title,
  initialName = "",
  initialEmoji = "",
  submitLabel,
  stepLabel,
  conversations,
  layer,
  onSubmit,
  onClose,
}: {
  title: string;
  initialName?: string;
  initialEmoji?: string;
  submitLabel: string;
  /** Shown before the actions when this dialog is one step of a flow (e.g. "Step 1 of 2"). */
  stepLabel?: string;
  /**
   * Edit only: the section's conversations in the same dialog (task #34), so
   * renaming and adding / removing conversations is one step.
   */
  conversations?: { candidates: SidebarSectionCandidate[]; initialSelectedKeys: string[] };
  /** Stacking tier (DialogCard): 1 when opened from inside another dialog or sheet, e.g. channel settings. */
  layer?: number;
  onSubmit: (value: { name: string; emoji: string | null; conversationChange?: SidebarSectionConversationChange }) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const [name, setName] = useState(initialName);
  const [emoji, setEmoji] = useState(initialEmoji);
  const trimmedName = name.trim();
  const handleNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => setName(event.target.value), []);
  const { selected, toggle, change } = useSectionConversationSelection(
    conversations?.candidates ?? NO_CANDIDATES,
    conversations?.initialSelectedKeys ?? NO_KEYS,
  );

  return (
    <DialogCard title={title} titleId={titleId} description={stepLabel} onClose={onClose} closeOnBackdrop layer={layer} maxWidthClass={conversations || stepLabel ? "max-w-[448px]" : "max-w-[400px]"}
      // On a phone: the name alone (new section, step 1) is the centred card
      // (it moves up with the keyboard); with the conversation picker (edit)
      // it is the sheet.
      narrow={conversations ? "sheet" : "centered"}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmedName) return;
          onSubmit({ name: trimmedName, emoji: emoji.trim() || null, ...(conversations ? { conversationChange: change } : {}) });
        }}
        className="flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1.5">
          <div className="font-sans text-footnote font-semibold text-foreground">
            {formatMessage({ id: "layout.sidebar.sectionName" })}
          </div>
          <InputGroup>
            <InputGroupAddon className="p-0">
            <SidebarSectionEmojiPicker value={emoji} onChange={setEmoji} />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              aria-label={formatMessage({ id: "layout.sidebar.sectionName" })}
              maxLength={80}
              value={name}
              onChange={handleNameChange}
              className="min-w-0 flex-1"
              placeholder={formatMessage({ id: "layout.sidebar.sectionNamePlaceholder" })}
            />
          </InputGroup>
        </div>
        {conversations ? (
          <div className="flex flex-col gap-1.5">
            <div className="font-sans text-footnote font-semibold text-foreground">
              {formatMessage({ id: "layout.sidebar.sectionConversations" })}
            </div>
            <SectionConversationPicker candidates={conversations.candidates} selected={selected} onToggle={toggle} />
          </div>
        ) : null}
        {/* raft-ui's dialog footer (dialog.md, "The footer"; stdrc and Jasper,
            2026-11-05): Cancel (ghost) then the commit, at the end, one row.
            The step is the dialog's description under the title (a footer
            note is for lg and wide dialogs); a step dialog is md (448px). */}
        <DialogCardFooter>
          <Button size="lg" variant="ghost" type="button" onClick={onClose}>
            {formatMessage({ id: "layout.sidebar.cancelSection" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} variant="primary" type="submit" disabled={!trimmedName}>
                {submitLabel}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </form>
    </DialogCard>
  );
}
