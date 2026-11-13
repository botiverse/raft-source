import { useCallback, useId, useState } from "react";
import type { ComponentProps, FocusEvent, MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Check, CircleArrowUp, History, TriangleAlert } from "lucide-react";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowTitle,
  ListRowValue,
  PanelNotice,
  PanelNoticeActions,
  PanelNoticeContent,
  ScrollArea,
} from "@botiverse/raft-ui";
import type { ArtifactCard, ArtifactId, ArtifactVersionSummary, ArtifactViewerData } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { formatRelativeTime } from "../../utils/relativeTime";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { readsInOwnServer } from "./artifactOwnServer";
import { useArtifactVersionSummary } from "./artifactSource";
import type { ArtifactNewerVersion } from "./artifactSource";
import { artifactActorName } from "./artifactFacts";

/**
 * An Artifact's version history in the viewer (task #proj-workspace:#62):
 * the versions the viewer data lists (newest first: number, publisher, when,
 * then its note, else the files it changed: useVersionNote), the latest marked,
 * and the one shown checked. Picking one shows it pinned
 * (`/v/<n>`, as a link that pins it, F10); picking the latest follows the
 * latest again, so a link to it never pins the newest.
 *
 * - Desktop: a submenu of the ⋯ menu, a radio item per version (DropdownMenu:
 *   a choice that applies at once).
 *   A pick closes the menu (raft-ui's default for radio items): it opens
 *   another version.
 * - Phone: the ⋯ menu's item opens a bottom sheet of rows (Drawer; its list
 *   rule: 52px rows, the current one with a check and bold), where a submenu
 *   beside the menu has no room.
 *
 * The header's version tag (task #proj-workspace:#105) is a second way in
 * where there is more than one version: the same tag, clickable, opening the same
 * list (a menu of its own on a desktop, the sheet on a phone).
 *
 * None of it for another server's reader (readsInOwnServer): they
 * read the current version only (the server lists only it and finds no
 * other), so ⋯ has no Version history (ArtifactViewerMenu) and the tag is
 * the plain tag.
 *
 * The pinned version's strip under the header says which version is shown,
 * with Back to Latest: PanelNotice's neutral `default` (being on an older
 * version is a state, not a problem to fix). A version that couldn't be
 * loaded is its `warning`, with Retry and Back to Latest, over the version
 * that was shown.
 *
 * A version published since it was opened (task #proj-workspace:#94) takes
 * the pinned strip's place: who published which one and its note, with View
 * latest (ArtifactNewVersionNotice, `info`: news, not a problem).
 */

/** What the viewer is asked to show: a version pinned, or null for the latest. */
export type PickVersion = (version: number | null) => void;

/** The version to pin for a pick: none for the latest. */
export function pinnedFor(version: number, latest: number): number | null {
  return version >= latest ? null : version;
}

function VersionWhen({ version }: { version: ArtifactVersionSummary }) {
  const { locale } = useIntl();
  return <time dateTime={version.createdAt}>{formatRelativeTime(version.createdAt, locale) ?? ""}</time>;
}

/** The most changed files a version's line and hover name: a first version changes every file it has. */
const CHANGED_FILES_SHOWN = 8;

/**
 * "Changed: a.html, b.css": the files a version added, changed or removed against the one before, the first
 * CHANGED_FILES_SHOWN of them and then how many more; null with none. The names are joined with one translated
 * separator (", "; "、" in zh-tw and ja; zh-cn keeps ", ", the Chinese its catalog already has for that English),
 * not Intl's list: its `unit` list glues file names together in Chinese and only spaces them in others, and its
 * "and" before the last one would read twice with "+3 more" (Kirby).
 */
function useChangedFiles(version: Pick<ArtifactVersionSummary, "changedPaths"> | null): string | null {
  const { formatMessage } = useIntl();
  if (!version || version.changedPaths.length === 0) return null;
  const files = version.changedPaths.slice(0, CHANGED_FILES_SHOWN).join(formatMessage({ id: "artifacts.versions.fileSeparator" }));
  const more = version.changedPaths.length - CHANGED_FILES_SHOWN;
  return more > 0
    ? formatMessage({ id: "artifacts.versions.changedFilesMore" }, { files, count: more })
    : formatMessage({ id: "artifacts.versions.changedFiles" }, { files });
}

/** The hover's whole text: the note, then the files it changed, each its own paragraph. */
function NoteDetail({ note, changed }: { note: string | null; changed: string | null }) {
  return (
    <span className="flex max-w-80 flex-col gap-1 whitespace-pre-wrap break-words">
      {note ? <span>{note}</span> : null}
      {changed ? <span>{changed}</span> : null}
    </span>
  );
}

/**
 * A version's note (`raft artifact push --note`, up to 500 characters; the web writes one too), or
 * without one the files it changed: `line`, what a row shows (one line cut with an ellipsis in the
 * menu, at most two in the phone's sheet), and `detail`, the whole note and the files, for the menu's
 * tooltip. The line's text is whole in the page (only its box cuts it), and it is the row's
 * description (`aria-describedby`), never part of its name. Null with neither.
 */
function useVersionNote(version: ArtifactVersionSummary | null): { line: string; detail: ReactNode } | null {
  const changed = useChangedFiles(version);
  const note = version?.note?.trim() || null;
  const line = note ?? changed;
  return line === null ? null : { line, detail: <NoteDetail note={note} changed={changed} /> };
}

/** Beside the row, never over the rows above it; it flips where there is no room. */
const NOTE_TOOLTIP = { side: "left" } as const;

/**
 * Whether focus came by the keyboard, by raft-ui's own gate (its `keyboard:` variant: the root's
 * `data-input-modality`, anything but "pointer"). A hover also moves a menu's focus to the item under it; that
 * one is the pointer's, and the line's own hover opens the tooltip then.
 */
function focusedByKeyboard(element: HTMLElement): boolean {
  return element.ownerDocument.documentElement.getAttribute("data-input-modality") !== "pointer";
}

function LatestBadge() {
  const { formatMessage } = useIntl();
  return (
    <Badge appearance="soft" variant="muted" className="shrink-0" data-testid="artifact-version-latest">
      {formatMessage({ id: "artifacts.versions.latest" })}
    </Badge>
  );
}

/**
 * The ⋯ menu's Version history: the submenu of versions on a desktop; on a
 * phone an item that opens the sheet (`onOpenSheet`).
 */
export function ArtifactVersionHistoryMenuItem({ data, phone, onPick, onOpenSheet }: {
  data: ArtifactViewerData;
  phone: boolean;
  onPick: PickVersion;
  onOpenSheet: () => void;
}) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "artifacts.menu.versionHistory" });
  if (phone) {
    return (
      <DropdownMenuItem onClick={onOpenSheet} data-testid="artifact-viewer-menu-versions">
        <History />
        {label}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSubmenu>
      <DropdownMenuSubmenuTrigger data-testid="artifact-viewer-menu-versions">
        <History />
        {label}
      </DropdownMenuSubmenuTrigger>
      <DropdownMenuContent side="left" align="start" aria-label={label} className="p-0" data-testid="artifact-version-list">
        <VersionMenuScroll><VersionRadioItems data={data} onPick={onPick} /></VersionMenuScroll>
      </DropdownMenuContent>
    </DropdownMenuSubmenu>
  );
}

/**
 * The versions menu's scroller: the popup stays the frame (its available
 * height, rounded clip) and the items scroll in a raft-ui ScrollArea inside
 * it, with the popup's 4px padding on its content. The items take focus
 * themselves (the menu highlights and scrolls them), so it is no tab stop.
 */
function VersionMenuScroll({ children }: { children: ReactNode }) {
  return <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="flex flex-col p-1">{children}</ScrollArea>;
}

/** The versions as a menu's radio items, the shown one checked: the ⋯ submenu's and the version tag's menu. */
function VersionRadioItems({ data, onPick }: { data: ArtifactViewerData; onPick: PickVersion }) {
  const { card, versions } = data;
  const pick = useCallback((value: unknown) => {
    if (typeof value === "number") onPick(pinnedFor(value, card.latestVersion));
  }, [onPick, card.latestVersion]);
  return (
    <DropdownMenuRadioGroup value={card.version} onValueChange={pick}>
      {versions.map((version) => <VersionRadioItem key={version.number} version={version} latest={card.latestVersion} />)}
    </DropdownMenuRadioGroup>
  );
}

/**
 * One version of the menu: its number (the latest marked), who published it and when, then its note or the files it
 * changed (useVersionNote) on a third line.
 *
 * - The item's name is the first two lines only ("v4 Latest, Niko · 3 hours ago", `aria-labelledby`); the third is its
 *   description (`aria-describedby`), so a long note isn't every item's name (Kirby).
 * - The third line is one line, at most 16rem wide: a menu is as wide as its widest item (raft-ui's popup has no
 *   most width), so a long note would stretch it. The whole note and the files are a tooltip beside the row, shown
 *   on hover over the line and while the item has the keyboard's focus (the menu moves real focus to its items), so
 *   a keyboard reader gets it too; the line itself is no tab stop.
 */
function VersionRadioItem({ version, latest }: { version: ArtifactVersionSummary; latest: number }) {
  const { formatMessage } = useIntl();
  const id = useId();
  const note = useVersionNote(version);
  const [hovered, setHovered] = useState(false);
  const [keyboardOn, setKeyboardOn] = useState(false);
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => setKeyboardOn(focusedByKeyboard(event.currentTarget)), []);
  const onBlur = useCallback(() => setKeyboardOn(false), []);
  return (
    <DropdownMenuRadioItem
      value={version.number}
      aria-labelledby={`${id}-name ${id}-by`}
      aria-describedby={note ? `${id}-note` : undefined}
      onFocus={note ? onFocus : undefined}
      onBlur={note ? onBlur : undefined}
      data-testid="artifact-version-row"
      data-version={version.number}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-name`} className="flex min-w-0 items-center gap-2">
          <span className="truncate">{formatMessage({ id: "artifacts.card.version" }, { version: version.number })}</span>
          {version.number === latest ? <LatestBadge /> : null}
        </span>
        <span id={`${id}-by`} className="truncate text-caption font-normal text-foreground-hint">
          {formatMessage({ id: "artifacts.versions.published" }, { name: artifactActorName(version.publisher, formatMessage), time: <VersionWhen key="when" version={version} /> })}
        </span>
        {note ? (
          <Tooltip open={hovered || keyboardOn} onOpenChange={setHovered} content={note.detail} contentProps={NOTE_TOOLTIP}>
            <span id={`${id}-note`} className="max-w-64 truncate text-caption font-normal text-foreground-muted" data-testid="artifact-version-note">{note.line}</span>
          </Tooltip>
        ) : null}
      </span>
    </DropdownMenuRadioItem>
  );
}

/**
 * raft-ui's Badge as a button: the version tag's exact look (ArtifactVersionBadge), no ▾; the
 * Badge's own hover and pressed fill (outline, `enabled:`) and a pointer say it is clickable.
 */
function VersionTagButton({ className, ...props }: ComponentProps<"button">) {
  return <Badge {...props} appearance="outline" variant="muted" render={<button type="button" />} className={`cursor-pointer ${className ?? ""}`} />;
}

/**
 * The header's version tag ("v2"). With more than one version it is a button
 * (the same tag, clickable): on a desktop it opens the versions as a menu (the ⋯ submenu's
 * items), on a phone the version sheet (`onOpenSheet`). With one version, or
 * for another server's reader (the current version only), it is the plain tag.
 */
export function ArtifactVersionTag({ data, phone, onPick, onOpenSheet }: {
  data: ArtifactViewerData;
  phone: boolean;
  onPick: PickVersion;
  onOpenSheet: () => void;
}) {
  const { formatMessage } = useIntl();
  const { card, versions } = data;
  if (versions.length < 2 || !readsInOwnServer(card)) return <ArtifactVersionBadge version={card.version} />;
  const label = formatMessage({ id: "artifacts.versions.switchLabel" }, { version: card.version });
  const content = formatMessage({ id: "artifacts.card.version" }, { version: card.version });
  if (phone) {
    return (
      <VersionTagButton aria-label={label} aria-haspopup="dialog" onClick={onOpenSheet} data-testid="artifact-version-badge">
        {content}
      </VersionTagButton>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<VersionTagButton />} aria-label={label} data-testid="artifact-version-badge">
        {content}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={formatMessage({ id: "artifacts.menu.versionHistory" })}
        className="p-0"
        data-testid="artifact-version-list"
      >
        <VersionMenuScroll><VersionRadioItems data={data} onPick={onPick} /></VersionMenuScroll>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The phone's version list: a bottom sheet of rows, the shown one selected; picking one closes it. */
export function ArtifactVersionHistorySheet({ data, open, onOpenChange, onPick }: {
  data: ArtifactViewerData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: PickVersion;
}) {
  const { formatMessage } = useIntl();
  const { card, versions } = data;
  const label = formatMessage({ id: "artifacts.menu.versionHistory" });
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="artifact-version-sheet">
        <DrawerHeader>
          <DrawerTitle>{label}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="px-0">
          <div role="list" className="flex flex-col gap-0.5" data-testid="artifact-version-list">
            {versions.map((version) => (
              <SheetRow
                key={version.number}
                version={version}
                shown={version.number === card.version}
                latest={card.latestVersion}
                onClose={onOpenChange}
                onPick={onPick}
              />
            ))}
          </div>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * One version of the phone's sheet. Its note (or the files it changed) is under the number, on at most two lines:
 * a touch screen has no hover, so there is no tooltip here, and a row is too short for all of a long note (the
 * whole text is in the page for a screen reader, the row's description as in the menu, not part of its name).
 */
function SheetRow({ version, shown, latest, onClose, onPick }: {
  version: ArtifactVersionSummary;
  shown: boolean;
  latest: number;
  onClose: (open: boolean) => void;
  onPick: PickVersion;
}) {
  const { formatMessage } = useIntl();
  const id = useId();
  const note = useVersionNote(version);
  const choose = useCallback(() => {
    onClose(false);
    if (!shown) onPick(pinnedFor(version.number, latest));
  }, [onClose, onPick, shown, version.number, latest]);
  return (
    <div role="listitem">
      <ListRow
        variant="plain"
        aria-current={shown || undefined}
        aria-labelledby={`${id}-name ${id}-by`}
        aria-describedby={note ? `${id}-note` : undefined}
        onClick={choose}
        className="min-h-13"
        data-testid="artifact-version-row"
        data-version={version.number}
      >
        <ListRowBody>
          <span id={`${id}-name`} className="flex min-w-0 items-center gap-2">
            <ListRowTitle className={shown ? "flex-none font-bold" : "flex-none font-medium"}>
              {formatMessage({ id: "artifacts.card.version" }, { version: version.number })}
            </ListRowTitle>
            {version.number === latest ? <LatestBadge /> : null}
          </span>
          {note ? <ListRowDescription id={`${id}-note`} wrap className="line-clamp-2" data-testid="artifact-version-note">{note.line}</ListRowDescription> : null}
        </ListRowBody>
        <ListRowValue id={`${id}-by`}>
          {formatMessage({ id: "artifacts.versions.published" }, { name: artifactActorName(version.publisher, formatMessage), time: <VersionWhen key="when" version={version} /> })}
        </ListRowValue>
        <span className="flex size-5 shrink-0 items-center justify-center text-foreground" aria-hidden>
          {shown ? <Check className="size-5" data-testid="artifact-version-current" /> : null}
        </span>
      </ListRow>
    </div>
  );
}

/**
 * The strip under the header: while a version is pinned, which one, and Back
 * to Latest; when the version asked for
 * couldn't be loaded (`failedVersion`), that, with Retry. Its buttons go with
 * it, so focus moves to the viewer.
 */
export function ArtifactPinnedVersionNotice({ card, failedVersion = null, onBackToLatest, onRetry }: {
  card: ArtifactCard;
  /** The version that couldn't be loaded, with Retry (`onRetry`); a page that can't fail one leaves both out. */
  failedVersion?: number | "latest" | null;
  onBackToLatest: () => void;
  onRetry?: () => void;
}) {
  const { formatMessage } = useIntl();
  // Its buttons go with it: focus moves to the surface (the viewer, or the Artifact's own page's
  // panel), the element that handles Esc, so the next Esc still works.
  const focusViewer = (event: MouseEvent<HTMLElement>) => event.currentTarget.closest<HTMLElement>("[data-artifact-focus]")?.focus();
  const backToLatest = useCallback((event: MouseEvent<HTMLElement>) => {
    focusViewer(event);
    onBackToLatest();
  }, [onBackToLatest]);
  const retry = useCallback((event: MouseEvent<HTMLElement>) => {
    focusViewer(event);
    onRetry?.();
  }, [onRetry]);
  const backButton = (
    <Button variant="ghost" size="md" onClick={backToLatest} data-testid="artifact-viewer-back-to-latest">
      {formatMessage({ id: "artifacts.versions.backToLatest" })}
    </Button>
  );
  if (failedVersion !== null) {
    return (
      <PanelNotice status="warning" data-testid="artifact-viewer-version-failed">
        <TriangleAlert aria-hidden />
        <PanelNoticeContent>
          {failedVersion === "latest"
            ? formatMessage({ id: "artifacts.versions.latestFailed" })
            : formatMessage({ id: "artifacts.versions.failed" }, { version: failedVersion })}
        </PanelNoticeContent>
        <PanelNoticeActions>
          <Button variant="ghost" size="md" onClick={retry} data-testid="artifact-viewer-version-retry">
            {formatMessage({ id: "artifacts.dashboard.retry" })}
          </Button>
          {failedVersion === "latest" ? null : backButton}
        </PanelNoticeActions>
      </PanelNotice>
    );
  }
  if (!card.pinned) return null;
  return (
    <PanelNotice status="default" data-testid="artifact-viewer-pinned">
      <History aria-hidden />
      <PanelNoticeContent>
        {formatMessage({ id: "artifacts.versions.viewing" }, { version: card.version })}
      </PanelNoticeContent>
      <PanelNoticeActions>{backButton}</PanelNoticeActions>
    </PanelNotice>
  );
}

/**
 * The strip under the header once a newer version is out than the one the
 * surface loaded as the latest (useArtifactNewerVersion): "Remy published
 * v12", or "v12 is available" where the publisher isn't known, with View
 * latest. Shown on a pinned version too, in the pinned strip's place (the
 * header's version badge says which one is on screen). Its button goes with
 * it: focus moves to the surface, as the pinned strip's.
 *
 * With the version's note (read once, useArtifactVersionSummary): "Remy published v12: Fixed the
 * chart", one line cut with an ellipsis. The strip is a status, so its words are said once and never
 * change: until the note's read answers (at most VERSION_NOTE_WAIT_MS) it isn't drawn, and `waiting`
 * (the strip it takes the place of) stays; a note that comes later is left out.
 *
 * On hover, the whole note and the files it changed. Hover only, on purpose: the strip's text is
 * whole in the page for a screen reader (only its box cuts it), the text is no control to give a
 * tab stop, and View latest leads to the versions menu, where the note's tooltip opens on the
 * keyboard's focus too (VersionRadioItem).
 */
export function ArtifactNewVersionNotice({ id, newer, onViewLatest, waiting = null }: {
  id: ArtifactId;
  newer: ArtifactNewerVersion;
  onViewLatest: () => void;
  /** What stays in its place while it waits for the note. */
  waiting?: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const summary = useArtifactVersionSummary(id, newer.version);
  const note = summary?.note?.trim() || null;
  const changed = useChangedFiles(summary ?? null);
  const values = { name: newer.publisher, version: newer.version, note };
  const messageId = newer.publisher
    ? (note ? "artifacts.versions.newerPublishedNote" : "artifacts.versions.newerPublished")
    : (note ? "artifacts.versions.newerAvailableNote" : "artifacts.versions.newerAvailable");
  const viewLatest = useCallback((event: MouseEvent<HTMLElement>) => {
    event.currentTarget.closest<HTMLElement>("[data-artifact-focus]")?.focus();
    onViewLatest();
  }, [onViewLatest]);
  if (summary === undefined) return <>{waiting}</>;
  const text = <PanelNoticeContent className="min-w-0 truncate" data-testid="artifact-new-version-text">{formatMessage({ id: messageId }, values)}</PanelNoticeContent>;
  return (
    <PanelNotice status="info" role="status" data-testid="artifact-new-version" data-version={newer.version}>
      <CircleArrowUp aria-hidden />
      {note ? <Tooltip content={<NoteDetail note={note} changed={changed} />}>{text}</Tooltip> : text}
      <PanelNoticeActions>
        <Button variant="ghost" size="md" onClick={viewLatest} data-testid="artifact-new-version-view">
          {formatMessage({ id: "artifacts.versions.viewLatest" })}
        </Button>
      </PanelNoticeActions>
    </PanelNotice>
  );
}
