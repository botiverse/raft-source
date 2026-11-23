import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import { Pin } from "lucide-react";
import { Button, ListRowGroup } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { asChannelId } from "@botiverse/raft-shared";
import type { ArtifactCard } from "@botiverse/raft-shared";

import { artifactKindIcon, useConversationArtifacts } from "../../apps/artifacts";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { setChannelAnnouncement, useChannelAnnouncement } from "../../store/channelAnnouncementStore";
import ConfirmDialog from "../ConfirmDialog";
import SectionHeader from "../ui/SectionHeader";
import { CHANNEL_ANNOUNCEMENT_ROW_ID } from "./channelAnnouncementParts";
import { PinnedArtifactRow, PinnedEmptyRow } from "./PinnedArtifactRow";
import type { PinnedArtifactActions } from "./PinnedArtifactRow";

type Step =
  | { kind: "idle" }
  | { kind: "pick"; mode: "set" | "replace" }
  | { kind: "replace"; next: ArtifactCard }
  | { kind: "remove" };

/**
 * Channel details › Pinned content (the channel announcement, #proj-chat:#29, flag channel_announcement_v0; named
 * "Pinned content" / 「置顶内容」 in the UI since cindyz's review, #proj-chat:#35; raft-design channel.md "Setting,
 * replacing and removing"), under the members. A section heading with the pin, as Channel settings has, over one box:
 * - with pinned content: the Artifact as one row (PinnedArtifactRow) that opens it beside the channel; for who may
 *   change it (editChannelMetadata: the channel's owner, a server owner or admin), a ⋯ before the chevron whose
 *   menu offers Replace pin and Unpin (not coloured: the confirmation carries the consequence);
 * - without: for who may change it, a muted "Nothing pinned" and Pin an Artifact; no section at all for anyone else.
 * Pin and Replace choose among the channel's own Artifacts (a Dialog md with a ChoiceList); Replace and Unpin then
 * confirm in a Dialog sm whose confirm is `primary`, not `danger`: nothing is deleted, the Artifact stays in the
 * channel and can be pinned again.
 */
export function ChannelAnnouncementField({ channelId, channelName, channelType, canEdit, onOpened }: {
  channelId: string;
  channelName: string;
  channelType: string | undefined;
  canEdit: boolean;
  /** After the row opened the pinned Artifact beside the channel (on a phone the details page closes, to show it). */
  onOpened?: () => void;
}) {
  const { formatMessage } = useIntl();
  const headingId = useId();
  const announcement = useChannelAnnouncement(channelId, channelType);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const close = useCallback(() => setStep({ kind: "idle" }), []);
  const startRemove = useCallback(() => setStep({ kind: "remove" }), []);
  const startReplace = useCallback(() => setStep({ kind: "pick", mode: "replace" }), []);
  const startSet = useCallback(() => setStep({ kind: "pick", mode: "set" }), []);
  const pickMode = step.kind === "pick" ? step.mode : null;
  const replacement = step.kind === "replace" ? step.next.id : null;
  const handlePicked = useCallback((card: ArtifactCard) => (
    pickMode === "set" ? setChannelAnnouncement(channelId, card.id) : setStep({ kind: "replace", next: card })
  ), [channelId, pickMode]);
  const confirmReplace = useCallback(() => (replacement ? setChannelAnnouncement(channelId, replacement) : undefined), [channelId, replacement]);
  const confirmRemove = useCallback(() => setChannelAnnouncement(channelId, null), [channelId]);
  // The menu item that opened a dialog is gone once the menu closes, so the dialogs give focus back to ⋯.
  const actionsRef = useRef<HTMLButtonElement | null>(null);
  const actions = useMemo<PinnedArtifactActions | undefined>(
    () => (canEdit ? { onReplace: startReplace, onRemove: startRemove, triggerRef: actionsRef } : undefined),
    [canEdit, startReplace, startRemove],
  );

  // Not read yet, the flag off, or a channel that can't have one; and nothing to show someone who can't pin one.
  if (announcement === undefined || (announcement === null && !canEdit)) return null;

  return (
    <section id={CHANNEL_ANNOUNCEMENT_ROW_ID} className="stack-y-3" data-testid="channel-settings-announcement" aria-labelledby={headingId}>
      <SectionHeader
        icon={<Pin size={16} aria-hidden="true" />}
        label={<span id={headingId}>{formatMessage({ id: "channel.announcement.label" })}</span>}
      />
      <ListRowGroup>
        {announcement ? (
          <PinnedArtifactRow channelId={channelId} announcement={announcement} onOpened={onOpened} actions={actions} />
        ) : (
          <PinnedEmptyRow onPin={startSet} />
        )}
      </ListRowGroup>

      {step.kind === "pick" ? (
        <AnnouncementPicker
          channelId={channelId}
          channelName={channelName}
          mode={step.mode}
          currentId={announcement?.artifactId ?? null}
          onClose={close}
          onPicked={handlePicked}
          finalFocus={actionsRef}
        />
      ) : null}
      {step.kind === "replace" && announcement ? (
        <ConfirmDialog
          title={formatMessage({ id: "channel.announcement.replace.title" })}
          message={formatMessage({ id: "channel.announcement.replace.body" }, { next: step.next.title, current: announcement.title, channel: channelName })}
          confirmLabel={formatMessage({ id: "channel.announcement.details.replace" })}
          confirmVariant="primary"
          initialFocus="cancel"
          onConfirm={confirmReplace}
          onClose={close}
          finalFocus={actionsRef}
          confirmTestId="channel-settings-announcement-replace-confirm"
        />
      ) : null}
      {step.kind === "remove" && announcement ? (
        <ConfirmDialog
          title={formatMessage({ id: "channel.announcement.remove.title" })}
          message={formatMessage({ id: "channel.announcement.remove.body" }, { title: announcement.title, channel: channelName })}
          confirmLabel={formatMessage({ id: "channel.announcement.details.remove" })}
          confirmVariant="primary"
          initialFocus="cancel"
          onConfirm={confirmRemove}
          onClose={close}
          finalFocus={actionsRef}
          confirmTestId="channel-settings-announcement-remove-confirm"
        />
      ) : null}
    </section>
  );
}

/** Pin / Replace pin: one of the channel's own Artifacts (the Files list), the one pinned now left out. */
function AnnouncementPicker({ channelId, channelName, mode, currentId, onClose, onPicked, finalFocus }: {
  channelId: string;
  channelName: string;
  mode: "set" | "replace";
  currentId: string | null;
  onClose: () => void;
  onPicked: (card: ArtifactCard) => Promise<void> | void;
  /** Where focus goes when it closes: ⋯, which opened it (Pin has none: the dialog's own default). */
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const { formatMessage } = useIntl();
  const { formatCompactDate } = useTimeFormatter();
  const { view, retry, showMore } = useConversationArtifacts(asChannelId(channelId));
  const [chosen, setChosen] = useState<string | null>(null);
  const cards = useMemo(() => (view.status === "ready" ? view.cards.filter((card) => card.id !== currentId) : []), [currentId, view]);
  const items = useMemo<ChoiceListItem[]>(() => cards.map((card) => ({
    value: card.id,
    label: card.title,
    searchText: card.title,
    meta: `${formatMessage({ id: "artifacts.card.version" }, { version: card.latestVersion })} · ${formatCompactDate(card.updatedAt)}`,
    media: <span aria-hidden="true" className="flex size-4 items-center justify-center text-foreground-muted [&>svg]:size-4">{artifactKindIcon(card.kind)}</span>,
    group: "here",
  })), [cards, formatCompactDate, formatMessage]);
  const chosenCard = cards.find((card) => card.id === chosen) ?? null;
  const groups = useMemo(() => [{ value: "here", label: formatMessage({ id: "channel.announcement.picker.group" }, { channel: channelName }) }], [channelName, formatMessage]);
  const handleConfirm = useCallback(() => (chosenCard ? onPicked(chosenCard) : undefined), [chosenCard, onPicked]);

  const body = (
    <div className="stack-y-3">
      <p className="text-subhead text-foreground-muted">{formatMessage({ id: "channel.announcement.picker.lead" }, { channel: channelName })}</p>
      {view.status === "loading" || view.status === "hidden" ? (
        <p className="text-callout text-foreground-hint" role="status">{formatMessage({ id: "channel.announcement.picker.loading" })}</p>
      ) : view.status === "failed" ? (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="text-callout text-foreground-muted">{formatMessage({ id: "channel.announcement.picker.failed" })}</p>
          <Button type="button" size="md" variant="outline" onClick={retry}>{formatMessage({ id: "channel.announcement.picker.retry" })}</Button>
        </div>
      ) : (
        <ChoiceList
          aria-label={formatMessage({ id: "channel.announcement.picker.label" }, { channel: channelName })}
          searchLabel={formatMessage({ id: "channel.announcement.picker.search" })}
          clearSearchLabel={formatMessage({ id: "channel.announcement.picker.clearSearch" })}
          noMatchLabel={formatMessage({ id: "channel.announcement.picker.noMatch" })}
          empty={formatMessage({ id: "channel.announcement.picker.empty" }, { channel: channelName })}
          groups={groups}
          items={items}
          value={chosen}
          onValueChange={setChosen}
          footer={view.nextCursor ? (
            <Button type="button" size="md" variant="ghost" onClick={showMore} disabled={view.more === "loading"}>
              {formatMessage({ id: "artifacts.filesTab.showMore" })}
            </Button>
          ) : undefined}
        />
      )}
    </div>
  );

  return (
    <ConfirmDialog
      size="md"
      plainMessage
      title={formatMessage({ id: mode === "set" ? "channel.announcement.picker.setTitle" : "channel.announcement.picker.replaceTitle" })}
      message={body}
      confirmLabel={formatMessage({ id: mode === "set" ? "channel.announcement.details.set" : "channel.announcement.picker.next" })}
      confirmVariant="primary"
      confirmDisabled={!chosenCard}
      // Replace goes on to its confirmation (the caller's next step replaces this dialog), so it doesn't close itself.
      closeOnConfirm={mode === "set"}
      onConfirm={handleConfirm}
      onClose={onClose}
      finalFocus={finalFocus}
      confirmTestId="channel-settings-announcement-picker-confirm"
    />
  );
}
