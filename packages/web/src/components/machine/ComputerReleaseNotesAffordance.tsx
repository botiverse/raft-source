import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { normalizeDisplayLocale, pickComputerReleaseNotesText } from "@botiverse/raft-shared";
import type { ComputerReleaseNotes } from "@botiverse/raft-shared";
import DialogCard from "../ui/DialogCard";
import MarkdownContent from "../markdown/MarkdownContent";
import { ScrollArea, TextLink } from "@botiverse/raft-ui";

/**
 * "View what's new" link beside a Computer's "update available" hint. Opens the
 * latest Computer version's release notes (from Hands, via the machines
 * payload) in the UI language. Display only: no upgrade or other action.
 * Renders nothing when there is no text to show.
 */
export default function ComputerReleaseNotesAffordance({ notes }: { notes: ComputerReleaseNotes }) {
  const { formatMessage, locale } = useIntl();
  const [open, setOpen] = useState(false);
  const openNotes = useCallback(() => setOpen(true), []);
  const closeNotes = useCallback(() => setOpen(false), []);
  const text = pickComputerReleaseNotesText(notes, normalizeDisplayLocale(locale) ?? "en");
  if (!text) return null;

  return (
    <>
      <TextLink
        variant="strong"
        className="text-footnote"
        aria-haspopup="dialog"
        data-testid="computer-release-notes-open"
        onClick={openNotes}
      >
        {formatMessage({ id: "machine.detail.releaseNotesOpen" })}
      </TextLink>
      {open && (
        <DialogCard
          title={formatMessage({ id: "machine.detail.releaseNotesTitle" }, { version: notes.version })}
          onClose={closeNotes}
          maxWidthClass="max-w-lg"
          testId="computer-release-notes-dialog"
          closeOnBackdrop
        >
          {/* Text to read: a named region (a tab stop once it overflows). On a
              phone the sheet body scrolls too, so a scroll at its end carries on. */}
          <ScrollArea
            role="region"
            aria-label={formatMessage({ id: "machine.detail.releaseNotesTitle" }, { version: notes.version })}
            overscroll="auto"
            className="max-h-[60vh] text-callout text-foreground"
          >
            <MarkdownContent source={text} />
          </ScrollArea>
        </DialogCard>
      )}
    </>
  );
}
