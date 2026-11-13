import { useCallback, useMemo, useRef, useState } from "react";
import type { MouseEvent, RefObject } from "react";
import { useIntl } from "react-intl";
import { ChevronRight, Ellipsis, Megaphone, Replace, X } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ListRow, ListRowBody, ListRowChevron, ListRowDescription, ListRowGroup, ListRowIcon, ListRowMeta, ListRowTitle } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { asChannelId } from "@botiverse/raft-shared";
import type { ArtifactCard, ChannelAnnouncementForPerson } from "@botiverse/raft-shared";

import { artifactKindIcon, artifactUrl, openChannelAnnouncement, useConversationArtifacts } from "../../apps/artifacts";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { setChannelAnnouncement, useChannelAnnouncement } from "../../store/channelAnnouncementStore";
import { formatRelativeTime } from "../../utils/relativeTime";
import ConfirmDialog from "../ConfirmDialog";
import { CHANNEL_ANNOUNCEMENT_ROW_ID, useAnnouncementAuthor } from "./channelAnnouncementParts";

type Step =
  | { kind: "idle" }
  | { kind: "pick"; mode: "set" | "replace" }
  | { kind: "replace"; next: ArtifactCard }
  | { kind: "remove" };

/**
 * Channel details › Announcement (#proj-chat:#29, flag channel_announcement_v0;
 * raft-design channel.md "Setting, replacing and removing"), after the
 * description:
 * - with an announcement: the Artifact itself, a row that opens it beside the
 *   channel (with a chevron); for who may change it (editChannelMetadata: the
 *   channel's owner, a server owner or admin), a ⋯ button in the chevron's
 *   place instead, on top of the row's end and never inside its link, whose
 *   menu offers Replace and Remove (not coloured: the confirmation carries
 *   the consequence); while the menu is open the row keeps its hover fill;
 * - without: for who may change it, a line on what it is for and Set
 *   announcement; nothing at all for everyone else.
 * Set and Replace choose among the channel's own Artifacts (a Dialog md with
 * a ChoiceList); Replace and Remove then confirm in a Dialog sm whose confirm
 * is `primary`, not `danger`: nothing is deleted, the Artifact stays in the
 * channel and can be set again.
 */
export function ChannelAnnouncementField({ channelId, channelName, channelType, canEdit, onOpened }: {
  channelId: string;
  channelName: string;
  channelType: string | undefined;
  canEdit: boolean;
  /** After the row opened the announcement beside the channel: the drawer closes. */
  onOpened?: () => void;
}) {
  const { formatMessage } = useIntl();
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
  const actions = useMemo(
    () => (canEdit ? { onReplace: startReplace, onRemove: startRemove, triggerRef: actionsRef } : undefined),
    [canEdit, startReplace, startRemove],
  );

  // Not read yet, the flag off, or a channel that can't have one; and nothing to show someone who can't set one.
  if (announcement === undefined || (announcement === null && !canEdit)) return null;

  // One card of its own in the channel details (raft-design channel.md): the announcement as a row that opens it,
  // and for who may change it a ⋯ menu with Replace and Remove at the row's end.
  return (
    <section id={CHANNEL_ANNOUNCEMENT_ROW_ID} data-testid="channel-settings-announcement" aria-label={formatMessage({ id: "channel.announcement.label" })}>
      <ListRowGroup>
        {announcement ? (
          <AnnouncementItem
            channelId={channelId}
            announcement={announcement}
            onOpened={onOpened}
            actions={actions}
          />
        ) : (
          <ListRow variant="plain" interactive={false} data-testid="channel-settings-announcement-empty">
            <ListRowIcon><Megaphone aria-hidden="true" /></ListRowIcon>
            <ListRowBody>
              <ListRowTitle>{formatMessage({ id: "channel.announcement.details.emptyTitle" })}</ListRowTitle>
              <ListRowDescription wrap>{formatMessage({ id: "channel.announcement.details.emptyBody" })}</ListRowDescription>
            </ListRowBody>
            <Button type="button" size="md" variant="outline" className="shrink-0" onClick={startSet} data-testid="channel-settings-announcement-set">
              {formatMessage({ id: "channel.announcement.details.set" })}
            </Button>
          </ListRow>
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

/**
 * The current announcement as a row of its own: the whole row opens it beside the channel. With `actions`
 * (who may change it), ⋯ takes the chevron's place, on top of the row's end as the link's sibling (raft-ui
 * InboxItem's pattern): the row keeps room for it, and shows its hover fill while the pointer is on ⋯ or its menu is
 * open (ListRow draws `data-popup-open` as hover).
 */
type AnnouncementActions = { onReplace: () => void; onRemove: () => void; triggerRef: RefObject<HTMLButtonElement | null> };

function AnnouncementItem({ channelId, announcement, onOpened, actions }: {
  channelId: string;
  announcement: ChannelAnnouncementForPerson;
  onOpened?: () => void;
  /** For who may change it: ⋯ with Replace and Remove. */
  actions?: AnnouncementActions;
}) {
  const { formatMessage, locale } = useIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const editable = actions !== undefined;
  const author = useAnnouncementAuthor(announcement.updatedBy);
  const handleOpen = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (openChannelAnnouncement(announcement.artifactId, event.currentTarget, channelId)) {
      event.preventDefault();
      onOpened?.();
    }
  }, [announcement.artifactId, channelId, onOpened]);
  const meta = formatMessage({ id: "channel.announcement.details.meta" }, {
    version: announcement.version,
    name: author.name ?? formatMessage({ id: "channel.announcement.someone" }),
    time: formatRelativeTime(announcement.updatedAt, locale) ?? "",
  });
  const row = (
    <ListRow
      variant="plain"
      // The row's title is the link's text (the anchor gets it through ListRow's children).
      render={<a href={artifactUrl(announcement.artifactId)} onClick={handleOpen} aria-label={announcement.title} />}
      // Room for ⋯ (end-2, 32 to 34px wide) so the text never runs under it.
      className={editable ? "pe-14 group-hover/announcement-row:overlay-subtle" : undefined}
      data-popup-open={menuOpen ? "" : undefined}
      data-testid="channel-settings-announcement-item"
    >
      <ListRowIcon><Megaphone aria-hidden="true" /></ListRowIcon>
      <ListRowBody>
        <ListRowTitle>{announcement.title}</ListRowTitle>
        <ListRowMeta className="block">{meta}</ListRowMeta>
      </ListRowBody>
      {editable ? null : <ListRowChevron><ChevronRight aria-hidden="true" /></ListRowChevron>}
    </ListRow>
  );
  if (!actions) return row;

  const actionsLabel = formatMessage({ id: "channel.announcement.details.actions" });
  return (
    <div className="group/announcement-row relative">
      {row}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={(
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              ref={actions.triggerRef}
              aria-label={actionsLabel}
              className="absolute end-2 top-1/2 z-raised -translate-y-1/2"
              data-testid="channel-settings-announcement-actions"
            />
          )}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" sideOffset={4} aria-label={actionsLabel} data-testid="channel-settings-announcement-menu">
          <DropdownMenuItem onClick={actions.onReplace} data-testid="channel-settings-announcement-replace">
            <Replace />
            {formatMessage({ id: "channel.announcement.details.replace" })}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={actions.onRemove} data-testid="channel-settings-announcement-remove">
            <X />
            {formatMessage({ id: "channel.announcement.details.remove" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Set / Replace: one of the channel's own Artifacts (the Files list), the current announcement left out. */
function AnnouncementPicker({ channelId, channelName, mode, currentId, onClose, onPicked, finalFocus }: {
  channelId: string;
  channelName: string;
  mode: "set" | "replace";
  currentId: string | null;
  onClose: () => void;
  onPicked: (card: ArtifactCard) => Promise<void> | void;
  /** Where focus goes when it closes: ⋯, which opened it (Set has none: the dialog's own default). */
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
