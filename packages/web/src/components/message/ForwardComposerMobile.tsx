import { useEffect, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { ArrowLeft, Check, Search, Undo2 } from "lucide-react";
import { useIntl } from "react-intl";
import { Field, FieldLabel, Input } from "raft-ui";
import type { Message } from "../../store/messageStore";
import Button from "../ui/Button";
import ForwardedBundleCard from "./ForwardedBundleCard";
import type { ForwardedBundleAttachmentSnapshot, ForwardedBundleMetadata } from "./ForwardedBundleCard";
import type { MobileForwardStep, SelectedDestination } from "./forwardComposerModel";
import MessageInput from "./MessageInput";

type Props = {
  mobileStep: MobileForwardStep;
  setMobileStep: Dispatch<SetStateAction<MobileForwardStep>>;
  sourceMessages: Message[];
  sourceLabelText: string;
  previewMetadata: ForwardedBundleMetadata;
  sending: boolean;
  joinInFlight: boolean;
  selectedDestinations: Map<string, SelectedDestination>;
  setSelectedDestinations: Dispatch<SetStateAction<Map<string, SelectedDestination>>>;
  mobileMultiSelect: boolean;
  setMobileMultiSelect: Dispatch<SetStateAction<boolean>>;
  hasSelection: boolean;
  noteComposerChannelId: string;
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
  onOpenAttachment: (attachment: ForwardedBundleAttachmentSnapshot) => void;
  sendForwardNote: (note: string) => Promise<void>;
  onClose: () => void;
};

export default function ForwardComposerMobile({
  mobileStep,
  setMobileStep,
  sourceMessages,
  sourceLabelText,
  previewMetadata,
  sending,
  joinInFlight,
  selectedDestinations,
  setSelectedDestinations,
  mobileMultiSelect,
  setMobileMultiSelect,
  hasSelection,
  noteComposerChannelId,
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
  onOpenAttachment,
  sendForwardNote,
  onClose,
}: Props) {
  const { formatMessage } = useIntl();
  const [visualViewportStyle, setVisualViewportStyle] = useState<CSSProperties | undefined>(undefined);
  const selectedLabels = [...selectedDestinations.values()].map((entry) => entry.label).join(", ");
  const sendLabel = formatMessage({ id: "message.forwardComposer.sendForward" });
  const selectedFrom = formatMessage(
    { id: "message.forwardComposer.selectedFrom" },
    { count: sourceMessages.length, source: sourceLabelText },
  );

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateVisualViewport = () => {
      const activeElement = document.activeElement;
      const editableFocused = activeElement instanceof HTMLInputElement
        || activeElement instanceof HTMLTextAreaElement
        || (activeElement instanceof HTMLElement && activeElement.isContentEditable);
      const keyboardVisible = editableFocused && window.innerHeight - viewport.height > 100;

      setVisualViewportStyle(keyboardVisible
        ? {
            top: `${Math.max(viewport.offsetTop, 0)}px`,
            bottom: "auto",
            height: `${viewport.height}px`,
          }
        : undefined);
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
      className="fixed bottom-0 left-0 right-0 top-0 z-40 flex min-h-0 flex-col bg-white text-black"
      style={visualViewportStyle}
      data-testid={mobileStep === "detail"
        ? "forward-mobile-detail-page"
        : mobileStep === "preview"
          ? "forward-mobile-note-page"
          : "forward-mobile-target-page"}
    >
      {mobileStep === "detail" ? (
        <>
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b-2 border-black px-3 py-2">
            <Button type="button" shape="icon" tone="white" onClick={() => setMobileStep("preview")} aria-label={formatMessage({ id: "message.forwardComposer.backToPreview" })}>
              <ArrowLeft size={18} />
            </Button>
            <div className="min-w-0">
              <h1 className="text-base font-bold">{formatMessage({ id: "message.forwardComposer.forwardedMessages" })}</h1>
              <p className="truncate text-xs font-mono text-black/55">{selectedFrom}</p>
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            <ForwardedBundleCard metadata={previewMetadata} onOpenAttachment={onOpenAttachment} forceExpanded fullWidth />
          </main>
        </>
      ) : mobileStep === "preview" ? (
        <>
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b-2 border-black px-3 py-2">
            <Button type="button" shape="icon" tone="white" onClick={() => setMobileStep("targets")} disabled={sending || joinInFlight} aria-label={formatMessage({ id: "message.forwardComposer.backToDestinations" })}>
              <ArrowLeft size={18} />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-bold">{formatMessage({ id: "message.forwardComposer.addNoteTitle" })}</h1>
              <p className="truncate text-xs font-mono text-black/55">{formatMessage({ id: "message.forwardComposer.sendTo" }, { targets: selectedLabels })}</p>
            </div>
          </header>
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="forward-mobile-note-layout">
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
              data-testid="forward-mobile-note-scroll"
            >
              {warnings}
              <div data-testid="forward-mobile-preview-content">
                <div className="mb-2 text-xs font-bold">{formatMessage({ id: "message.forwardComposer.messagePreview" })}</div>
                <ForwardedBundleCard metadata={previewMetadata} onOpenAttachment={onOpenAttachment} onShowAll={openMobileDetail} fullWidth />
              </div>
            </div>
            <div
              className="shrink-0 border-t-2 border-black bg-white p-3 pb-[max(12px,env(safe-area-inset-bottom))]"
              data-testid="forward-mobile-preview-actions"
            >
              <Field>
                <FieldLabel size="sm" htmlFor="forward-mobile-note">{formatMessage({ id: "message.forwardComposer.optionalNote" })}</FieldLabel>
                <MessageInput
                  channelId={noteComposerChannelId}
                  channelName={formatMessage({ id: "message.forwardComposer.optionalNote" })}
                  placeholder={formatMessage({ id: "message.forwardComposer.addNotePlaceholder" })}
                  variant="compact"
                  mentionChannelId={noteMentionChannelId}
                  mentionScopeChannelType={noteMentionScopeChannelType}
                  loadMentionMembers={Boolean(noteMentionChannelId)}
                  onSendOverride={(note) => sendForwardNote(note)}
                  allowEmptySubmit
                  submitDisabled={submitDisabled}
                  submitBusy={sending}
                  submitDisabledReason={submitDisabledReason ?? undefined}
                  submitTitleOverride={sendLabel}
                  submitLabelOverride={sendLabel}
                  textareaId="forward-mobile-note"
                  maxLength={4000}
                  autoFocus
                  autoFocusMode="always"
                />
              </Field>
            </div>
          </main>
        </>
      ) : (
        <>
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b-2 border-black px-3 py-2">
            {mobileMultiSelect ? (
              <Button type="button" shape="icon" tone="white" onClick={() => { setSelectedDestinations(new Map()); setMobileMultiSelect(false); }} disabled={sending || joinInFlight} aria-label={formatMessage({ id: "common.confirm.cancel" })}>
                <Undo2 size={14} />
              </Button>
            ) : (
              <Button type="button" shape="icon" tone="white" onClick={onClose} disabled={sending || joinInFlight} aria-label={formatMessage({ id: "message.forwardComposer.closeTargetSelection" })}>
                <ArrowLeft size={18} />
              </Button>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-bold">{formatMessage({ id: "message.forwardComposer.selectDestinations" })}</h1>
              <p className="truncate text-xs font-mono text-black/55">{selectedFrom}</p>
            </div>
            {mobileMultiSelect ? (
              <Button type="button" tone="pink" size="sm" shape="icon" onClick={openMobilePreview} disabled={!hasSelection || sending || joinInFlight} aria-label={formatMessage({ id: "message.forwardComposer.done" })}>
                <Check size={14} />
              </Button>
            ) : (
              <Button type="button" tone="white" onClick={() => { setSelectedDestinations(new Map()); setMobileMultiSelect(true); }} disabled={joinInFlight}>
                {formatMessage({ id: "message.forwardComposer.selectMultiple" })}
              </Button>
            )}
          </header>
          <main className="flex min-h-0 flex-1 flex-col p-3">
            <div className="relative mb-3 w-full shrink-0">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-black/50" />
              <Input
                value={query}
                onChange={(event) => {
                  const value = event.target.value;
                  setQuery(value);
                  const trimmed = value.trim();
                  if (trimmed) search(trimmed); else resetSearch();
                }}
                placeholder={formatMessage({ id: "message.forwardComposer.searchPlaceholder" })}
                className="pl-9 placeholder:text-black/35"
                autoFocus
              />
            </div>
            <div className="mb-2 flex h-6 shrink-0 items-center justify-between text-xs font-bold">
              <span>{mobileMultiSelect
                ? formatMessage({ id: "message.forwardComposer.selectedCount" }, { count: selectedDestinations.size })
                : formatMessage({ id: "message.forwardComposer.recent" })}</span>
              {mobileMultiSelect && selectedDestinations.size > 0 && (
                <button type="button" onClick={() => setSelectedDestinations(new Map())} disabled={joinInFlight} className="underline underline-offset-2">
                  {formatMessage({ id: "message.forwardComposer.clear" })}
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pb-2">{targetResults}</div>
          </main>
        </>
      )}
    </div>
  );
}
