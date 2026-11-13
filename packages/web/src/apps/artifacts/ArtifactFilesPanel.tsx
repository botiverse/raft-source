import { useCallback, useId, useLayoutEffect, useRef } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { Download, FolderDown, House, X } from "lucide-react";
import {
  FileAction,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelTitle,
  ScrollArea,
} from "@botiverse/raft-ui";
import { focusField } from "@botiverse/porthole";
import type { ArtifactFile, ArtifactViewerData } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import {
  COMPACT_LIST_BLEED,
  COMPACT_ROW,
  COMPACT_ROW_MONO,
  COMPACT_ROW_STRETCHED,
  COMPACT_ROW_TRAILING,
  COMPACT_ROW_WITH_ACTIONS,
} from "../../components/task/compactRow";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { artifactKindIcon } from "./ArtifactCardParts";
import { downloadArtifactFile, fileDownloadFailed } from "./artifactDownloads";
import { readsInOwnServer } from "./artifactOwnServer";
import { artifactFilePagePath, useShowFile, useShownFile } from "./artifactShownFile";
import { isPlainPrimaryClick } from "./openArtifactInPlace";
import { formatBytes } from "./artifactFacts";
import { useArmed } from "./useArmed";

/** A framed page's link to one of the files (ArtifactSurface `openFile`): `jump` is new on each link. */
export interface ArtifactFilesJump {
  path: string;
  jump: number;
}

/**
 * The Files panel (#proj-workspace:#239): every file of the version shown,
 * so a person sees what `raft artifact pull` gives an agent. It takes the
 * comment list's place (the side column, a bottom sheet on a phone;
 * ArtifactSurface), opened from ⋯'s Files or the page's `?panel=files`.
 *
 * - The rows are the viewer data's `files`, in its order (by path, as
 *   `raft artifact read --files` lists them), except the entry file (the one
 *   the viewer shows), which comes first and has a house for its icon (named
 *   "Entry" for a screen reader; #250: no badge): the folders are the path's
 *   prefix, muted before the name; the size right after it as the row's
 *   inline meta (formatBytes, in the reader's locale). Every other row's
 *   icon says its kind.
 * - A row is the compact list's (raft-design patterns/tasks.md, "Rows in a
 *   compact list"; FilesPanel's rule for a side section), with one action,
 *   Download File (the file's own route, as ⋯'s Download; a failure says so
 *   in a toast), for a member of the Artifact's own server only
 *   (readsInOwnServer: another server's reader sees the rows without it).
 *   The compact row is drawn with core's compactRow classes:
 *   raft-ui's FileRow has no compact variant yet.
 * - A row opens its file in the viewer (#proj-workspace:#272): the whole row is one link (its hit
 *   area and focus ring the row's, compactRow's stretched button), to that file's address on the
 *   Artifact's own page, so it opens in a new tab and copies as a link too; a plain click shows the
 *   file here (artifactShownFile). The file shown is the current one (`aria-current`, the DS's
 *   cyan-soft selection): the entry at first, whose row is also the way back. Download File is a
 *   control of its own after the link, so pressing it opens nothing.
 * - A framed page's link to a file of its set that isn't a page (#proj-workspace:#256) opens the
 *   panel at that file (`jump`): its row scrolled into view and selected (the same selection, in
 *   place of the shown file's while it lasts), until another link or the panel is opened from ⋯.
 *   The page's doing, so the panel is inert for PAGE_COMMENT_ARM_MS (useArmed, as a view the
 *   page's report brings: Porthole THREAT_MODEL §6); then focus moves to that row (Porthole's
 *   `focusField`: the frame holds it), so a keyboard reader lands where the file appeared, unless
 *   they went elsewhere in Raft meanwhile. The page can't open it at a file the version doesn't have.
 * - With more than one file the header has Download All (Zip), as ⋯ does
 *   (`onDownloadAll`).
 * - Opened, it takes focus (the region, as the comment list does), so Esc
 *   and Tab start here; ⋯'s Files leaves focus to it (a page's link: its row, above).
 */
export function ArtifactFilesPanel({ data, onClose, onDownloadAll, jump = null, closeOnOpen = false }: {
  data: ArtifactViewerData;
  onClose: () => void;
  /** A row that shows its file also closes the panel: the phone's sheet lies over the content, so the file would be behind it. */
  closeOnOpen?: boolean;
  /** Every file in one zip; null with one file (its own Download is it). */
  onDownloadAll: (() => void) | null;
  /** The file a page's link opened the panel at, or null. */
  jump?: ArtifactFilesJump | null;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const headingId = useId();
  // Opened: focus the region, so Esc and Tab start here (as the comment list does); not when a page's link
  // opened it. The region's ref, made once, runs as it mounts: a later link never moves focus.
  const openedFrom = useRef({ jump });
  const regionRef = useRef<HTMLElement | null>(null);
  const region = useCallback((node: HTMLElement | null) => {
    regionRef.current = node;
    if (node && !openedFrom.current.jump) node.focus({ preventScroll: true });
  }, []);
  // A page's link, once armed: focus on its row, if the reader is still where the link was (the
  // frame, nowhere, or this panel or the sheet holding it), never taken from what they went to.
  const jumpPath = jump?.path ?? null;
  const focusJumped = useCallback(() => {
    const node = regionRef.current;
    if (!node || jumpPath === null) return;
    const active = document.activeElement;
    const stayed = active === null || active === document.body || active instanceof HTMLIFrameElement || node.contains(active) || active.contains(node);
    const row = [...node.querySelectorAll<HTMLElement>("[data-testid='artifact-files-row']")].find((r) => r.dataset.path === jumpPath);
    if (stayed && row) focusField(row);
  }, [jumpPath]);
  const armed = useArmed(jump?.jump ?? null, focusJumped);
  const { files } = data;
  const rows = [...files.filter((file) => file.entry), ...files.filter((file) => !file.entry)];
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const closeLabel = formatMessage({ id: "artifacts.files.close" });
  const downloadAllLabel = formatMessage({ id: "artifacts.menu.downloadAll" });
  return (
    <section
      ref={region}
      aria-labelledby={headingId}
      tabIndex={-1}
      inert={armed || undefined}
      className="flex size-full min-h-0 flex-col bg-layer-card outline-none"
      data-testid="artifact-files-panel"
    >
      <PanelHeader>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle id={headingId} render={<h2>{formatMessage({ id: "artifacts.files.title" })}</h2>} />
          </PanelHeading>
          <PanelMeta data-testid="artifact-files-summary">
            {formatMessage({ id: "artifacts.files.summary" }, { count: files.length, size: formatBytes(total, intl) })}
          </PanelMeta>
        </PanelHeaderContent>
        <PanelActions>
          {onDownloadAll ? (
            <Tooltip content={downloadAllLabel}>
              <PanelAction aria-label={downloadAllLabel} onClick={onDownloadAll} data-testid="artifact-files-download-all">
                <FolderDown />
              </PanelAction>
            </Tooltip>
          ) : null}
          <Tooltip content={closeLabel}>
            <PanelAction aria-label={closeLabel} onClick={onClose} data-testid="artifact-files-close">
              <X />
            </PanelAction>
          </Tooltip>
        </PanelActions>
      </PanelHeader>
      <ScrollArea className="min-h-0 flex-1" contentClassName="py-1">
        <ul className={COMPACT_LIST_BLEED} aria-labelledby={headingId} data-testid="artifact-files-list">
          {rows.map((file) => <FileRowItem key={file.path} data={data} file={file} jump={jump?.path === file.path ? jump.jump : null} jumping={jump !== null} onOpened={closeOnOpen ? onClose : undefined} />)}
        </ul>
      </ScrollArea>
    </section>
  );
}

function FileRowItem({ data, file, jump, jumping, onOpened }: { data: ArtifactViewerData; file: ArtifactFile; jump: number | null; jumping: boolean; onOpened?: () => void }) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { id, version, pinned } = data.card;
  const slash = file.path.lastIndexOf("/");
  const folder = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);
  const downloadLabel = formatMessage({ id: "artifacts.files.download" }, { name });
  // Downloads are the Artifact's own server's: another server's reader sees the row without one.
  const downloads = readsInOwnServer(data.card);
  const download = useCallback(() => {
    trackArtifactViewerAction("download");
    void downloadArtifactFile({ id, version, path: file.path }).catch(() => fileDownloadFailed(formatMessage));
  }, [id, version, file.path, formatMessage]);
  // The row opens its file (the entry: back to it). A plain click shows it here; anything else
  // (a new tab, Copy Link) is the link's own, to the file's address on the Artifact's page.
  const shown = useShownFile(data);
  const show = useShowFile();
  const asked = file.entry ? null : file.path;
  const open = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    show(asked);
    onOpened?.();
  }, [show, asked, onOpened]);
  // A page's link to this file: into view, and selected (the DS's selection, with its reason for a
  // screen reader); focusable, so focus can land on it (ArtifactFilesPanel).
  const rowRef = useRef<HTMLLIElement | null>(null);
  useLayoutEffect(() => {
    if (jump !== null) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [jump]);
  const selected = jump !== null;
  // One row is the current one: the file a page's link just named, else the file shown.
  const current = selected || (!jumping && shown.file?.path === file.path);
  return (
    <li
      ref={rowRef}
      tabIndex={selected ? -1 : undefined}
      aria-current={current || undefined}
      className={current ? `group ${COMPACT_ROW} bg-info-soft outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ink` : COMPACT_ROW_WITH_ACTIONS}
      data-testid="artifact-files-row"
      data-path={file.path}
      data-entry={file.entry || undefined}
      data-selected={selected || undefined}
    >
      <a href={artifactFilePagePath(id, pinned ? version : null, asked)} onClick={open} aria-current={current || undefined} className={COMPACT_ROW_STRETCHED} data-testid="artifact-files-open">
        {file.entry ? (
          // Its word on hover too (Kirby, #13758): a mouse reader sees what the house means.
          <Tooltip content={formatMessage({ id: "artifacts.files.entry" })}>
            <span data-row-mark role="img" aria-label={formatMessage({ id: "artifacts.files.entry" })} className="flex size-5 shrink-0 items-center justify-center text-foreground-hint [&_svg]:size-4" data-testid="artifact-files-entry">
              <House aria-hidden />
            </span>
          </Tooltip>
        ) : (
          <span data-row-mark aria-hidden className="flex size-5 shrink-0 items-center justify-center text-foreground-hint [&_svg]:size-4">
            {artifactKindIcon(file.kind)}
          </span>
        )}
        {/* The whole path on hover, where the row cuts it. */}
        <Tooltip content={file.path}>
          <span className="flex min-w-0 text-callout text-foreground" data-testid="artifact-files-path">
            {/* A long path gives up its folders first (cut at their end), so the name stays; then the name's own end. */}
            {folder ? <span className="min-w-[4ch] shrink-[1000] truncate text-foreground-hint">{folder}</span> : null}
            <span className="min-w-0 truncate">{name}</span>
          </span>
        </Tooltip>
        {/* The size right after the name (or its ellipsis), the row's inline meta (raft-design tasks.md). */}
        <span className={COMPACT_ROW_MONO} data-testid="artifact-files-size">{formatBytes(file.sizeBytes, intl)}</span>
      </a>
      {downloads ? (
        <span className={COMPACT_ROW_TRAILING}>
          {/* The last icon box ends on the row's margin, as the conversation's Files rows do (ChannelFilesPanelFileRow). */}
          <span data-row-mark className="relative -my-[calc((2rem-var(--text-callout--line-height))/2)] -mr-[9px] md:pointer-fine:-my-[calc((var(--bar-button-size)-var(--text-callout--line-height))/2)] md:pointer-fine:-mr-[7px] md:pointer-fine:**:data-[slot=button]:size-(--bar-button-size) md:pointer-fine:**:data-[slot=button]:rounded-(--bar-button-radius)">
            <Tooltip content={formatMessage({ id: "artifacts.files.downloadTooltip" })}>
              <FileAction aria-label={downloadLabel} onClick={download} data-testid="artifact-files-download">
                <Download size={14} />
              </FileAction>
            </Tooltip>
          </span>
        </span>
      ) : null}
    </li>
  );
}
