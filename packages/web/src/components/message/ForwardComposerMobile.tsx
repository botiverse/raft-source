import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, Dispatch, KeyboardEvent, ReactNode, SetStateAction } from "react";
import { ArrowLeft, Check, Search, Undo2, X } from "lucide-react";
import { useIntl } from "react-intl";
import { Field, FieldLabel, InputGroup, InputGroupAddon, InputGroupInput, Button, PanelAction, PanelActions, PanelHeader, ScrollArea, TextLink } from "@botiverse/raft-ui";
import type { ForwardSource, MobileForwardStep, SelectedDestination } from "./forwardComposerModel";
import { MessageInput } from "../../features/composer/MessageInput";
import { COMPOSER_DOCK_CLASS } from "./composerHost";
import SectionEyebrow from "../ui/SectionEyebrow";
import { useMediaQuery } from "../../hooks/effectPrimitives";

// DS NavBar for a pushed phone page is raft-ui's panel head: white bar, seam
// under it, a ghost Back whose icon box starts on the content margin,
// mirroring the last action (headEdges.ts).
const FORWARD_MOBILE_TITLE_CLASS = "truncate text-headline";
const FORWARD_MOBILE_SUBTITLE_CLASS = "truncate text-caption text-foreground-hint";

type Props = {
  mobileStep: MobileForwardStep;
  setMobileStep: Dispatch<SetStateAction<MobileForwardStep>>;
  source: ForwardSource;
  sending: boolean;
  joinInFlight: boolean;
  selectedDestinations: Map<string, SelectedDestination>;
  setSelectedDestinations: Dispatch<SetStateAction<Map<string, SelectedDestination>>>;
  mobileMultiSelect: boolean;
  setMobileMultiSelect: Dispatch<SetStateAction<boolean>>;
  hasSelection: boolean;
  noteMentionChannelId?: string;
  noteMentionScopeChannelType?: "channel" | "private" | "joint" | "dm" | "thread" | null;
  submitDisabled: boolean;
  submitDisabledReason: string | null;
  warnings: ReactNode;
  targetResults: ReactNode;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  search: (query: string) => void;
  resetSearch: () => void;
  openMobilePreview: () => void;
  openMobileDetail: () => boolean;
  sendForwardNote: (note: string) => Promise<void>;
  /** Above the search: the server the destinations are from, where there is a choice. */
  scope?: ReactNode;
  /** The list leads with its own "Threads & tasks" and "Recent" titles: the bar above names no section. */
  hasConversationGroup?: boolean;
  onClose: () => void;
};

export default function ForwardComposerMobile({
  mobileStep,
  setMobileStep,
  source,
  sending,
  joinInFlight,
  selectedDestinations,
  setSelectedDestinations,
  mobileMultiSelect,
  setMobileMultiSelect,
  hasSelection,
  noteMentionChannelId,
  noteMentionScopeChannelType,
  submitDisabled,
  submitDisabledReason,
  warnings,
  targetResults,
  query,
  setQuery,
  search,
  resetSearch,
  openMobilePreview,
  openMobileDetail,
  sendForwardNote,
  scope,
  hasConversationGroup = false,
  onClose,
}: Props) {
  const { formatMessage } = useIntl();
  const [visualViewportStyle, setVisualViewportStyle] = useState<CSSProperties | undefined>(undefined);
  // A touch phone keeps the keyboard closed when the picker opens, so the
  // recent destinations stay in view; it opens when people tap the field
  // (raft-design navigation: Search). A narrow window with a mouse still
  // focuses the field, the same rule MessageInput's "desktop" autofocus uses.
  const autoFocusSearch = useMediaQuery("(hover: hover)");
  // Without the field, focus still moves onto the page (no keyboard): screen
  // readers land on it and Escape from a hardware keyboard reaches it. Only
  // from outside: a pointer change mid-typing must not blur the field.
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const page = pageRef.current;
    if (!autoFocusSearch && page && !page.contains(document.activeElement)) page.focus({ preventScroll: true });
  }, [autoFocusSearch]);
  const selectedLabels = [...selectedDestinations.values()].map((entry) => entry.label).join(", ");
  const { sendLabel, summary: selectedFrom, note } = source;

  const backToPreview = useCallback(() => setMobileStep("preview"), [setMobileStep]);
  const backToTargets = useCallback(() => setMobileStep("targets"), [setMobileStep]);
  const cancelMultiSelect = useCallback(() => {
    setSelectedDestinations(new Map());
    setMobileMultiSelect(false);
  }, [setSelectedDestinations, setMobileMultiSelect]);
  const clearSelectedDestinations = useCallback(() => setSelectedDestinations(new Map()), [setSelectedDestinations]);
  const startMultiSelect = useCallback(() => {
    setSelectedDestinations(new Map());
    setMobileMultiSelect(true);
  }, [setSelectedDestinations, setMobileMultiSelect]);
  const handleQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setQuery(value);
    const trimmed = value.trim();
    if (trimmed) search(trimmed); else resetSearch();
  }, [setQuery, search, resetSearch]);

  // Escape (a phone with a keyboard) is the dialog's, taken on its own page: the page is a portal,
  // so React would bubble the key on to what opened it (the Artifact viewer closes on Escape). A
  // child that took it first (the note's @ list) marked it.
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (!sending && !joinInFlight) onClose();
  }, [sending, joinInFlight, onClose]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateVisualViewport = () => {
      const activeElement = document.activeElement;
      const editableFocused = activeElement instanceof HTMLInputElement
        || activeElement instanceof HTMLTextAreaElement
        || (activeElement instanceof HTMLElement && activeElement.isContentEditable);
      const keyboardVisible = editableFocused && window.innerHeight - viewport.height > 100;
      const next: CSSProperties | undefined = keyboardVisible
        ? {
            top: `${Math.max(viewport.offsetTop, 0)}px`,
            bottom: "auto",
            height: `${viewport.height}px`,
          }
        : undefined;

      // iOS fires viewport scroll/resize while the page scrolls: keep the
      // previous object when nothing moved, so React skips the re-render.
      setVisualViewportStyle((previous) => (
        previous?.top === next?.top && previous?.height === next?.height ? previous : next
      ));
    };

    viewport.addEventListener("resize", updateVisualViewport);
    viewport.addEventListener("scroll", updateVisualViewport, { passive: true });
    window.addEventListener("resize", updateVisualViewport);
    document.addEventListener("focusin", updateVisualViewport);
    document.addEventListener("focusout", updateVisualViewport);
    return () => {
      viewport.removeEventListener("resize", updateVisualViewport);
      viewport.removeEventListener("scroll", updateVisualViewport);
      window.removeEventListener("resize", updateVisualViewport);
      document.removeEventListener("focusin", updateVisualViewport);
      document.removeEventListener("focusout", updateVisualViewport);
    };
  }, []);

  return (
    <div
      ref={pageRef}
      tabIndex={-1}
      className="fixed bottom-0 left-0 right-0 top-0 z-cover flex min-h-0 flex-col bg-layer-canvas text-foreground outline-none"
      style={visualViewportStyle}
      onKeyDown={handleKeyDown}
      data-testid={mobileStep === "detail"
        ? "forward-mobile-detail-page"
        : mobileStep === "preview"
          ? "forward-mobile-note-page"
          : "forward-mobile-target-page"}
    >
      {mobileStep === "detail" ? (
        <>
          <PanelHeader render={<header />}>
            <PanelAction onClick={backToPreview} aria-label={formatMessage({ id: "message.forwardComposer.backToPreview" })}>
              <ArrowLeft />
            </PanelAction>
            <div className="min-w-0">
              <h1 className={FORWARD_MOBILE_TITLE_CLASS}>{source.detailTitle}</h1>
              {selectedFrom ? <p className={FORWARD_MOBILE_SUBTITLE_CLASS}>{selectedFrom}</p> : null}
            </div>
          </PanelHeader>
          <ScrollArea
            render={<main />}
            aria-label={source.detailTitle ?? undefined}
            className="min-h-0 flex-1"
            contentClassName="p-3 pb-[max(12px,env(safe-area-inset-bottom))]"
          >
            {source.renderPreview("detail", openMobileDetail)}
          </ScrollArea>
        </>
      ) : mobileStep === "preview" ? (
        <>
          <PanelHeader render={<header />}>
            <PanelAction onClick={backToTargets} disabled={sending || joinInFlight} aria-label={formatMessage({ id: "message.forwardComposer.backToDestinations" })}>
              <ArrowLeft />
            </PanelAction>
            <div className="min-w-0 flex-1">
              <h1 className={FORWARD_MOBILE_TITLE_CLASS}>{formatMessage({ id: "message.forwardComposer.addNoteTitle" })}</h1>
              <p className={FORWARD_MOBILE_SUBTITLE_CLASS}>{formatMessage({ id: "message.forwardComposer.sendTo" }, { targets: selectedLabels })}</p>
            </div>
          </PanelHeader>
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="forward-mobile-note-layout">
            <ScrollArea
              role="region"
              aria-label={formatMessage({ id: "message.forwardComposer.messagePreview" })}
              overscroll="contain"
              className="min-h-0 flex-1"
              contentClassName="p-3"
              data-testid="forward-mobile-note-scroll"
            >
              {warnings}
              <div data-testid="forward-mobile-preview-content">
                <SectionEyebrow as="div" className="mb-2">{formatMessage({ id: "message.forwardComposer.messagePreview" })}</SectionEyebrow>
                {source.renderPreview("phone", openMobileDetail)}
              </div>
            </ScrollArea>
            <div
              className={`${COMPOSER_DOCK_CLASS} bg-layer-canvas pb-[max(12px,env(safe-area-inset-bottom))]`}
              data-testid="forward-mobile-preview-actions"
            >
              <Field>
                <FieldLabel size="sm" htmlFor="forward-mobile-note">{formatMessage({ id: "message.forwardComposer.optionalNote" })}</FieldLabel>
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
                  textareaId="forward-mobile-note"
                  maxLength={note.maxLength}
                  plainText={note.plainText}
                  autoFocus
                  autoFocusMode="always"
                />
              </Field>
            </div>
          </main>
        </>
      ) : (
        <>
          <PanelHeader render={<header />}>
            {mobileMultiSelect ? (
              <PanelAction onClick={cancelMultiSelect} disabled={sending || joinInFlight} aria-label={formatMessage({ id: "common.confirm.cancel" })}>
                <Undo2 />
              </PanelAction>
            ) : (
              // The forward ends in Send, so its first screen closes with ×, like
              // every phone full-screen dialog (NarrowDialog); ← stays for the
              // steps inside it.
              <PanelAction onClick={onClose} disabled={sending || joinInFlight} aria-label={formatMessage({ id: "message.forwardComposer.closeTargetSelection" })}>
                <X />
              </PanelAction>
            )}
            <div className="min-w-0 flex-1">
              <h1 className={FORWARD_MOBILE_TITLE_CLASS}>{formatMessage({ id: "message.forwardComposer.selectDestinations" })}</h1>
              {selectedFrom ? <p className={FORWARD_MOBILE_SUBTITLE_CLASS}>{selectedFrom}</p> : null}
            </div>
            {/* Done is filled, so its shape (not its glyph) ends on 16: it
                sits straight in the head. Select multiple is a ghost, so it
                joins the overhanging actions. */}
            {mobileMultiSelect ? (
              <Button type="button" variant="accent" size="icon-lg" onClick={openMobilePreview} disabled={!hasSelection || sending || joinInFlight} aria-label={formatMessage({ id: "message.forwardComposer.done" })}>
                <Check size={14} />
              </Button>
            ) : (
              <PanelActions>
                <Button size="md" type="button" variant="ghost" onClick={startMultiSelect} disabled={joinInFlight}>
                  {formatMessage({ id: "message.forwardComposer.selectMultiple" })}
                </Button>
              </PanelActions>
            )}
          </PanelHeader>
          <main className="flex min-h-0 flex-1 flex-col p-3">
            {scope ? <div className="mb-3 flex min-w-0 shrink-0">{scope}</div> : null}
            <InputGroup className="mb-3 shrink-0">
              <InputGroupAddon align="inline-start">
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={handleQueryChange}
                placeholder={formatMessage({ id: "message.forwardComposer.searchPlaceholder" })}
                autoFocus={autoFocusSearch}
              />
            </InputGroup>
            {mobileMultiSelect || !hasConversationGroup || query.trim() ? (
              <SectionEyebrow as="div" className="mb-1 flex h-6 shrink-0 items-center justify-between px-1">
                <span>{mobileMultiSelect
                  ? formatMessage({ id: "message.forwardComposer.selectedCount" }, { count: selectedDestinations.size })
                  : formatMessage({ id: "message.forwardComposer.recent" })}</span>
                {mobileMultiSelect && selectedDestinations.size > 0 && (
                  <TextLink onClick={clearSelectedDestinations} disabled={joinInFlight}>
                    {formatMessage({ id: "message.forwardComposer.clear" })}
                  </TextLink>
                )}
              </SectionEyebrow>
            ) : null}
            {/* Each target row takes focus itself, so the list is no tab stop. */}
            <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="stack-y-0.5 pb-2">{targetResults}</ScrollArea>
          </main>
        </>
      )}
    </div>
  );
}
