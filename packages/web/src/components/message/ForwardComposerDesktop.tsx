import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Search, X } from "lucide-react";
import { useIntl } from "react-intl";
import { Field, FieldLabel } from "raft-ui";
import Modal from "../Modal";
import Button from "../ui/Button";
import ForwardedBundleCard from "./ForwardedBundleCard";
import type { ForwardedBundleAttachmentSnapshot, ForwardedBundleMetadata } from "./ForwardedBundleCard";
import MessageInput from "./MessageInput";

type Props = {
  sourceMessageCount: number;
  sourceLabelText: string;
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
  previewMetadata: ForwardedBundleMetadata;
  onOpenAttachment: (attachment: ForwardedBundleAttachmentSnapshot) => void;
  noteComposerChannelId: string;
  noteMentionChannelId?: string;
  noteMentionScopeChannelType?: "channel" | "private" | "joint" | "dm" | "thread" | null;
  submitDisabled: boolean;
  submitDisabledReason: string | null;
  sendForwardNote: (note: string) => Promise<void>;
};

export default function ForwardComposerDesktop({
  sourceMessageCount,
  sourceLabelText,
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
  previewMetadata,
  onOpenAttachment,
  noteComposerChannelId,
  noteMentionChannelId,
  noteMentionScopeChannelType,
  submitDisabled,
  submitDisabledReason,
  sendForwardNote,
}: Props) {
  const { formatMessage } = useIntl();
  const sendLabel = formatMessage({ id: "message.forwardComposer.sendForward" });
  return (
    <Modal onClose={sending || joinInFlight ? () => {} : onClose} closeOnBackdrop>
      <div className="flex h-[min(42rem,calc(100dvh-1rem))] w-[min(48rem,calc(100vw-1rem))] max-h-[calc(100dvh-1rem)] flex-col card-brutal bg-white md:h-[min(clamp(30rem,72dvh,46rem),calc(100dvh-2rem))] md:w-[min(clamp(48rem,60vw,60rem),calc(100vw-2rem))]" data-testid="forward-composer-dialog">
        <div className="flex items-center justify-between border-b-2 border-black px-4 py-3">
          <div>
            <h2 className="text-base font-bold">{formatMessage({ id: "message.forwardComposer.title" })}</h2>
            <p className="text-xs font-mono text-black/55">{formatMessage({ id: "message.forwardComposer.selectedFrom" }, { count: sourceMessageCount, source: sourceLabelText })}</p>
          </div>
          <Button type="button" shape="icon" tone="white" onClick={onClose} disabled={sending || joinInFlight} aria-label={formatMessage({ id: "message.forwardComposer.close" })}><X size={16} /></Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0 md:grid md:grid-cols-[clamp(19rem,24vw,22rem)_minmax(0,1fr)]">
          <div className="flex max-h-[min(34dvh,13rem)] shrink-0 flex-col border-b-2 border-black p-3 md:h-full md:max-h-none md:min-h-0 md:border-b-0 md:border-r-2">
            <label className="mb-2 flex w-full items-center gap-2 border-2 border-black bg-white px-2 py-2 shadow-brutal-sm focus-within:shadow-brutal">
              <Search size={14} className="shrink-0 text-black/50" />
              <input
                value={query}
                onChange={(event) => {
                  const value = event.target.value;
                  setQuery(value);
                  const trimmed = value.trim();
                  if (trimmed) search(trimmed); else resetSearch();
                }}
                placeholder={formatMessage({ id: "message.forwardComposer.searchPlaceholder" })}
                className="min-w-0 flex-1 bg-transparent text-sm font-bold outline-none placeholder:text-black/35"
                autoFocus
              />
            </label>
            <div className="mb-2 flex h-6 shrink-0 items-center justify-between text-xs font-bold">
              <span data-testid="forward-selected-count">{formatMessage({ id: "message.forwardComposer.selectedCount" }, { count: selectedCount })}</span>
              {selectedCount > 0 && <button type="button" onClick={clearSelection} disabled={joinInFlight} className="underline underline-offset-2">{formatMessage({ id: "message.forwardComposer.clear" })}</button>}
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">{targetResults}</div>
          </div>
          <div className="flex min-w-0 min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {warnings}
              <div className="mb-2"><ForwardedBundleCard metadata={previewMetadata} onOpenAttachment={onOpenAttachment} fullWidth /></div>
            </div>
            <div className="border-t-2 border-black bg-white p-3" data-testid="forward-desktop-note-actions">
              <Field>
                <FieldLabel size="sm" htmlFor="forward-desktop-note">{formatMessage({ id: "message.forwardComposer.optionalNote" })}</FieldLabel>
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
                  textareaId="forward-desktop-note"
                  maxLength={4000}
                />
              </Field>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
