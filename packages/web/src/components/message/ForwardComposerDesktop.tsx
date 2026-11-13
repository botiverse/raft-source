import { Dialog, DialogTitle, Field, FieldLabel, InputGroup, InputGroupAddon, InputGroupInput, ScrollArea, TextLink } from "@botiverse/raft-ui";
import type { DialogProps } from "@botiverse/raft-ui";
import CloseButton from "../ui/CloseButton";
import type { Dispatch, KeyboardEvent, ReactNode, SetStateAction } from "react";
import { useCallback, useRef } from "react";
import { Search, X } from "lucide-react";
import { useIntl } from "react-intl";
import { NarrowDialogContent } from "../ui/NarrowDialog";
import { isFromForeignLayer } from "../ui/useOverlayLayer";
import type { ForwardSource } from "./forwardComposerModel";
import { MessageInput } from "../../features/composer/MessageInput";
import { COMPOSER_DOCK_CLASS } from "./composerHost";
import SectionEyebrow from "../ui/SectionEyebrow";
import { ICON_BAR_END_PULL } from "../ui/headEdges";

type OpenChangeDetails = Parameters<NonNullable<DialogProps["onOpenChange"]>>[1];

type Props = {
  source: ForwardSource;
  onClose: () => void;
  sending: boolean;
  joinInFlight: boolean;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  search: (query: string) => void;
  resetSearch: () => void;
  selectedCount: number;
  clearSelection: () => void;
  targetResults: ReactNode;
  warnings: ReactNode;
  openDetail: () => boolean;
  noteMentionChannelId?: string;
  noteMentionScopeChannelType?: "channel" | "private" | "joint" | "dm" | "thread" | null;
  submitDisabled: boolean;
  submitDisabledReason: string | null;
  sendForwardNote: (note: string) => Promise<void>;
  /** Above the search: the server the destinations are from, where there is a choice. */
  scope?: ReactNode;
};

export default function ForwardComposerDesktop({
  source,
  onClose,
  sending,
  joinInFlight,
  query,
  setQuery,
  search,
  resetSearch,
  selectedCount,
  clearSelection,
  targetResults,
  warnings,
  openDetail,
  noteMentionChannelId,
  noteMentionScopeChannelType,
  submitDisabled,
  submitDisabledReason,
  sendForwardNote,
  scope,
}: Props) {
  const { formatMessage } = useIntl();
  const { sendLabel, note } = source;
  // Stable handler: the target search is a rui InputGroup control now, and an
  // inline arrow would be a new function prop on every render (react-perf gate).
  const handleSearchChange = useCallback((event: { target: { value: string } }) => {
    const value = event.target.value;
    setQuery(value);
    const trimmed = value.trim();
    if (trimmed) search(trimmed); else resetSearch();
  }, [setQuery, search, resetSearch]);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const busy = sending || joinInFlight;
  // Esc, × and a press on the scrim close it, except while a send or a join is out (they act on this dialog).
  const handleOpenChange = useCallback((open: boolean, details: OpenChangeDetails) => {
    if (open) return;
    // A lightbox opened from the preview (a forwarded image) is outside this dialog's tree: its Esc and presses are its own.
    if (busy || isFromForeignLayer(details.event, popupRef.current)) {
      details.cancel();
      return;
    }
    onClose();
  }, [busy, onClose]);
  // The dialog is a portal, so React would bubble its Escape on to what opened it (the Artifact viewer closes on
  // Escape): mark it handled here. Base UI still closes the dialog on it; an Escape a child took first (the note's
  // @ list) leaves it open (NarrowDialogContent).
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) event.preventDefault();
  }, []);
  const title = source.title;
  const closeLabel = formatMessage({ id: "message.forwardComposer.close" });
  return (
    <Dialog open onOpenChange={handleOpenChange}>
      {/* raft-ui Dialog, sized by hand: the two-column picker is wider than its sizes. Focus starts in the search
          (autoFocus), as before. */}
      <NarrowDialogContent
        ref={popupRef}
        narrow="centered"
        className="h-[min(42rem,calc(100dvh-1rem))] w-[min(48rem,calc(100vw-1rem))] max-w-none max-h-[calc(100dvh-1rem)] md:h-[min(clamp(30rem,72dvh,46rem),calc(100dvh-2rem))] md:w-[min(clamp(48rem,60vw,60rem),calc(100vw-2rem))]"
        testId="forward-composer-dialog"
        onKeyDown={handleKeyDown}
        header={null}
        title={title}
        closeLabel={closeLabel}
      >
        {/* A dialog's bar: with a mouse one line at the header height (raft-ui
            header-height, 44), the summary beside the title; on a touch screen
            the summary keeps its own line. */}
        <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line-seam px-(--surface-inset) py-2 md:pointer-fine:min-h-(--header-height) md:pointer-fine:py-0">
          <div className="min-w-0 md:pointer-fine:flex md:pointer-fine:items-baseline md:pointer-fine:gap-2">
            <DialogTitle className="text-headline md:pointer-fine:shrink-0">{title}</DialogTitle>
            {source.summary ? <p className="truncate text-caption text-foreground-hint" data-testid="forward-composer-summary">{source.summary}</p> : null}
          </div>
          <CloseButton type="button" className={ICON_BAR_END_PULL} onClick={onClose} disabled={busy} aria-label={closeLabel}><X size={16} /></CloseButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0 md:grid md:grid-cols-[clamp(19rem,24vw,22rem)_minmax(0,1fr)]">
          <div className="flex max-h-[min(34dvh,13rem)] shrink-0 flex-col border-b border-line-seam p-3 md:h-full md:max-h-none md:min-h-0 md:border-b-0 md:border-r">
            {scope ? <div className="mb-2 flex min-w-0 shrink-0">{scope}</div> : null}
            <InputGroup className="mb-2">
              <InputGroupAddon>
                <Search size={14} aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={handleSearchChange}
                placeholder={formatMessage({ id: "message.forwardComposer.searchPlaceholder" })}
                aria-label={formatMessage({ id: "message.forwardComposer.searchPlaceholder" })}
                className="min-w-0 flex-1"
                autoFocus
              />
            </InputGroup>
            <SectionEyebrow as="div" className="mb-1 flex h-6 shrink-0 items-center justify-between px-1">
              <span data-testid="forward-selected-count">{formatMessage({ id: "message.forwardComposer.selectedCount" }, { count: selectedCount })}</span>
              {selectedCount > 0 && <TextLink onClick={clearSelection} disabled={joinInFlight}>{formatMessage({ id: "message.forwardComposer.clear" })}</TextLink>}
            </SectionEyebrow>
            {/* Each target row takes focus itself, so the list is no tab stop. */}
            <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="stack-y-0.5">{targetResults}</ScrollArea>
          </div>
          <div className="flex min-w-0 min-h-0 flex-1 flex-col">
            <ScrollArea
              role="region"
              aria-label={formatMessage({ id: "message.forwardComposer.messagePreview" })}
              className="min-h-0 flex-1"
              contentClassName="p-3"
            >
              {warnings}
              <div className="mb-2">{source.renderPreview("desktop", openDetail)}</div>
            </ScrollArea>
            <div className={COMPOSER_DOCK_CLASS} data-testid="forward-desktop-note-actions">
              <Field>
                <FieldLabel size="sm" htmlFor="forward-desktop-note">{formatMessage({ id: "message.forwardComposer.optionalNote" })}</FieldLabel>
                <MessageInput
                  channelId={note.draftKey}
                  channelName={formatMessage({ id: "message.forwardComposer.optionalNote" })}
                  placeholder={formatMessage({ id: "message.forwardComposer.addNotePlaceholder" })}
                  variant="compact"
                  mentionChannelId={noteMentionChannelId}
                  mentionScopeChannelType={noteMentionScopeChannelType}
                  loadMentionMembers={Boolean(noteMentionChannelId)}
                  onSendOverride={sendForwardNote}
                  allowEmptySubmit
                  submitDisabled={submitDisabled}
                  submitBusy={sending}
                  submitDisabledReason={submitDisabledReason ?? undefined}
                  submitTitleOverride={sendLabel}
                  submitLabelOverride={sendLabel}
                  textareaId="forward-desktop-note"
                  maxLength={note.maxLength}
                  plainText={note.plainText}
                />
              </Field>
            </div>
          </div>
        </div>
      </NarrowDialogContent>
    </Dialog>
  );
}
