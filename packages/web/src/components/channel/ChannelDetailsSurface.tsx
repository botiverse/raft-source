import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { ArrowLeft } from "lucide-react";
import {
  Badge,
  Dialog,
  DialogContent,
  IconTile,
  PanelAction,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelTitle,
  ScrollArea,
} from "@botiverse/raft-ui";
import { Ellipsis, EllipsisToggle } from "@botiverse/raft-ui/wip";
import type { EllipsisState } from "@botiverse/raft-ui/wip";

import { usePhoneHistoryEntry } from "../../apps/artifacts";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import type { Channel } from "../../store/channelStore";
import ChannelSideCard from "../task/ChannelSideCard";
import { SideSectionPortal } from "../task/ChannelSideArea";
import { channelDetailsExternal } from "./channelDetails";
import { PHONE_MEDIA_QUERY } from "../ui/NarrowDialog";
import { useHostTitleBar } from "../topbar/overlayTitleBar";
import { ChannelIcon } from "./channelKindIcon";

/**
 * The phone page over the whole window: raft-ui's DialogContent with its centred card undone (tailwind-merge drops
 * the card's position, size, radius, ring and padding), on the canvas, inside the safe areas. The same page as the
 * context view's (AgentContextViewPanel).
 */
const PHONE_PAGE_CLASS = [
  "inset-0 left-0 top-0 h-dvh max-h-none w-full max-w-none translate-none",
  "flex flex-col gap-0 overflow-hidden rounded-none bg-layer-canvas p-0 shadow-none ring-0 outline-none",
  "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
].join(" ");

/** The details' body: scrolled, on the column's margin. */
function DetailsBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="px-(--surface-inset) py-4 safe-bottom">
      {children}
    </ScrollArea>
  );
}

/**
 * Where the channel details stand (raft-design channel.md, stdrc 2026-11-10, #proj-raft-ui:dae8db07):
 *
 * - On a desktop, a section of the conversation's row, like a thread or a profile (ChannelSideArea's "details",
 *   under the profile by default): no scrim and no shadow, so the conversation stays in reach; the column's seam,
 *   its saved width, its narrowing to a strip and its tabs are the row's. Its head is the side sections' head
 *   (ChannelSideCard): Details and Close, and no Expand, since settings rows gain nothing from the row's width.
 * - On a phone, a pushed page over the app, with Back and Details: the channel's name is the page's first line, so
 *   the head doesn't repeat it. It owns a history entry, so the system Back closes it.
 *
 * `page` replaces the body with a page of its own (the member list): on a desktop under the column's head, on a
 * phone in place of the whole page, since that page brings its own head with Back.
 */
export function ChannelDetailsSurface({
  open,
  onClose,
  page,
  returnFocus,
  children,
}: {
  open: boolean;
  /** Close (×), Back on a phone: the caller's guarded close (the unsaved-changes prompt); false when it asked instead. */
  onClose: () => boolean | void;
  /** Where focus goes after Escape closes the column, when what opened it is gone (the header's gear). */
  returnFocus?: () => HTMLElement | null;
  page?: ReactNode;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  // MainLayout's row mounts its side area (its hidden `data-side-area` marker; a test id is for tests, not for this) with the app shell, before any channel.
  const [inRow] = useState(() => typeof document !== "undefined" && document.querySelector("[data-side-area]") !== null);
  const belowTitleBar = useHostTitleBar();
  const title = formatMessage({ id: "channel.details.title" });
  if (!open) return null;
  if (phone) return <ChannelDetailsPhonePage title={title} onBack={onClose} page={page}>{children}</ChannelDetailsPhonePage>;
  const column = (
    <ChannelSideCard
      title={title}
      closeLabelId="message.chatPanel.overflow.close"
      onClose={onClose}
      // Escape closes the column while focus is in it (raft-design panel.md); the phone's page is a dialog, closed by its own.
      closeOnEscape
      returnFocus={returnFocus}
      expandable={false}
      testId="channel-details"
    >
      {/* Both stay mounted: an unsaved draft in the root view survives the member list. */}
      {page ? <div className="flex min-h-0 flex-1 flex-col">{page}</div> : null}
      <div className={page ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <DetailsBody>{children}</DetailsBody>
      </div>
    </ChannelSideCard>
  );
  // In the row (MainLayout's side area places it, mounted with the app shell before any channel). Where no side area
  // is mounted (a conversation rendered without the shell, as the ChatPanel behavior tests do) the column stands at
  // the window's right edge instead, under a host title bar, still with no scrim.
  if (inRow) return <SideSectionPortal section="details" title={title}>{column}</SideSectionPortal>;
  return createPortal(
    <div className={`fixed bottom-0 right-0 z-cover flex w-[400px] max-w-full border-l border-line-seam bg-layer-canvas ${belowTitleBar ? "top-12" : "top-0"}`} data-testid="channel-details-standalone">
      {column}
    </div>,
    document.body,
  );
}

/** The page's history entry: the system or browser Back closes the page (PhoneHistoryEntry is keyed to re-arm it). */
function PhoneHistoryEntry({ onBack }: { onBack: () => void }) {
  usePhoneHistoryEntry(true, onBack);
  return null;
}

function ChannelDetailsPhonePage({ title, onBack, page, children }: { title: string; onBack: () => boolean | void; page?: ReactNode; children: ReactNode }) {
  const { formatMessage } = useIntl();
  const backRef = useRef<HTMLButtonElement>(null);
  // The browser has already taken the entry when the system Back arrives: where the unsaved prompt keeps the page
  // open, a new entry is pushed, so the next Back asks again instead of leaving the conversation.
  const [entry, setEntry] = useState(0);
  const onSystemBack = useCallback(() => {
    if (onBack() === false) setEntry((n) => n + 1);
  }, [onBack]);
  const onOpenChange = useCallback((next: boolean) => {
    if (!next) onBack();
  }, [onBack]);
  const back = formatMessage({ id: "channel.details.back" });
  const onBackClick = useCallback(() => {
    onBack();
  }, [onBack]);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <PhoneHistoryEntry key={entry} onBack={onSystemBack} />
      <DialogContent
        overlay={false}
        initialFocus={backRef}
        aria-label={title}
        data-testid="channel-details"
        data-phone-page=""
        className={PHONE_PAGE_CLASS}
      >
        {page ? <div className="flex min-h-0 flex-1 flex-col">{page}</div> : null}
        <div className={page ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
          <PanelHeader>
            <PanelAction ref={backRef} aria-label={back} onClick={onBackClick} data-testid="channel-details-back">
              <ArrowLeft />
            </PanelAction>
            <PanelHeaderContent>
              <PanelHeading>
                <PanelTitle render={<h2>{title}</h2>} />
              </PanelHeading>
            </PanelHeaderContent>
          </PanelHeader>
          <DetailsBody>{children}</DetailsBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The top of the channel details, read first: the channel's icon, name and tag (Public, Private or External; and
 * Archived), the description as body text folded after three lines with Show more. `action` goes at the end of the
 * name's line: Edit, for who may edit the channel.
 */
export function ChannelDetailsIdentity({
  channel,
  channelName,
  description,
  action,
}: {
  channel: Channel | null | undefined;
  channelName: string;
  description?: string | null;
  action?: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const external = channelDetailsExternal(channel);
  const tag = !channel?.type
    ? null
    : external
      ? formatMessage({ id: "channel.edit.jointChannelBadge" })
      : channel.type === "private"
        ? formatMessage({ id: "message.chatPanel.overflow.visibilityPrivate" })
        : formatMessage({ id: "message.chatPanel.overflow.visibilityPublic" });
  const text = description?.trim() ?? "";
  const showMore = formatMessage({ id: "channel.details.showMore" });
  const showLess = formatMessage({ id: "channel.details.showLess" });
  const renderToggle = useCallback((state: EllipsisState) => (
    <EllipsisToggle onClick={state.toggle}>{state.expanded ? showLess : showMore}</EllipsisToggle>
  ), [showLess, showMore]);
  return (
    <div className="stack-y-3" data-testid="channel-details-identity">
      <div className="flex min-w-0 items-center gap-3">
        <IconTile size="md" aria-hidden="true">
          <ChannelIcon channel={channel} type={channel?.type} size={18} />
        </IconTile>
        <h3 className="min-w-0 truncate text-headline font-bold text-foreground" data-testid="channel-overflow-title-text">
          {channelName}
        </h3>
        {tag ? <Badge appearance="outline" className="shrink-0" data-testid="channel-overflow-visibility-badge">{tag}</Badge> : null}
        {channel?.archivedAt ? (
          <Badge appearance="soft" variant="muted" className="shrink-0">{formatMessage({ id: "message.chatPanel.archived" })}</Badge>
        ) : null}
        <div className="flex-1" />
        {action}
      </div>
      {text !== "" ? (
        <p className="text-callout text-foreground" data-testid="channel-settings-description-readonly">
          <Ellipsis lines={3} className="whitespace-pre-wrap break-words" after={renderToggle}>
            {text}
          </Ellipsis>
        </p>
      ) : null}
    </div>
  );
}
