import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import { useIntl } from "react-intl";
import { Download, FileX, RefreshCw } from "lucide-react";
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ScrollArea } from "@botiverse/raft-ui";
import { isArtifactFramedKind } from "@botiverse/raft-shared";
import type { ArtifactId, ArtifactKind, ArtifactViewerData } from "@botiverse/raft-shared";
import type { ComponentProps, ReactNode } from "react";

import { prefetchAfterFirstScreen } from "../../boot/appChunkLoading";
import EmptyState from "../../components/ui/EmptyState";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { artifactUrl } from "./artifactLinks";
import { ArtifactChunkBoundary, useRetryableLazy } from "./artifactLazyChunk";
import type { LazyChunkSlot } from "./artifactLazyChunk";
import { ArtifactLoadingArea, ArtifactLoadingSplash } from "./ArtifactLoadingSplash";
import { loadArtifactFrame } from "./artifactViewerChunk";
import ArtifactShellComments from "./ArtifactShellComments";
import { downloadArtifactFile } from "./artifactDownloads";
import { isArtifactDrawnKind, opensInFrame } from "./artifactDrawnKind";
import type { ArtifactDrawnKind } from "./artifactDrawnKind";
import { readsInOwnServer } from "./artifactOwnServer";
import { artifactFileUrl, useShownFile } from "./artifactShownFile";
import { artifactSource, useArtifactFileText } from "./artifactSource";
import { useArtifactImageSrc } from "./artifactImageSrc";
import type { ArtifactFileTarget } from "./artifactSource";

/**
 * How one version's entry file is shown (F37), and the security boundary
 * around it (Tenny):
 *
 * - The client never fetches an address from a payload with the user's auth.
 *   File bytes come from Raft's own API at an address built here from id,
 *   version and path (`ArtifactSource.readText` / `readBytes`).
 * - csv and text are drawn by Raft as TEXT (React text nodes), never as HTML.
 * - png, jpeg, gif, webp and svg (ARTIFACT_INLINE_IMAGE_TYPES) are drawn as
 *   `<img src=blob:>` of bytes Raft's API returned, only when both the
 *   path's type and the response type are on that list; the URL is revoked
 *   on unmount. SVG only ever so: never inlined, never in `<object>` or
 *   `<embed>` (an `<img>` runs no script).
 * - html, markdown and pdf (ARTIFACT_FRAMED_KINDS) never render in Raft's
 *   own page: they open in a sandboxed frame on the content origin with a
 *   one-time ticket from the frame route (ArtifactFrame, S2). The frame is
 *   the version's, opened at its entry, or at another page, Markdown file
 *   or PDF of it the reader opened from Files (the route's `path`;
 *   `opensInFrame`).
 */
// The frame and Porthole load off the first screen (artifactViewerChunk.ts):
// fetched once the first screen is done (prefetchAfterFirstScreen: queued with
// the lazyDeferred modules, safe at module top level), or at first render. Plain lazy, not
// lazyDeferred: PublicArtifactPage imports the frame statically, so it is a
// shared chunk the deferred-module check can't name.
const ArtifactFrame = lazy(loadArtifactFrame);
prefetchAfterFirstScreen(loadArtifactFrame);

const frameSlot: LazyChunkSlot<ComponentProps<typeof ArtifactFrame>> = { current: ArtifactFrame };

/**
 * The frame, with the loading splash while its code downloads and Try again
 * when that fails (not the app's RootErrorBoundary). Focus stays in the card
 * across a retry. Exported for its tests.
 */
export function DeferredArtifactFrame(props: ComponentProps<typeof ArtifactFrame>) {
  const { formatMessage } = useIntl();
  const { Chunk, attempt, retry } = useRetryableLazy(frameSlot, loadArtifactFrame);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const retryHere = useCallback(() => {
    boxRef.current?.focus();
    retry();
  }, [retry]);
  const failed = (
    <div role="status" className="flex flex-1 items-center justify-center p-6" data-testid="artifact-frame-chunk-failed">
      <EmptyState
        icon={<FileX size={36} />}
        title={formatMessage({ id: "artifacts.frame.failedTitle" })}
        action={(
          <Button variant="outline" size="md" onClick={retryHere} data-testid="artifact-frame-chunk-retry">
            <RefreshCw />
            {formatMessage({ id: "artifacts.frame.retry" })}
          </Button>
        )}
      />
    </div>
  );
  return (
    <div ref={boxRef} tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
      <ArtifactChunkBoundary resetKey={attempt} failed={failed}>
        <Suspense fallback={<ArtifactLoadingArea kind={props.kind} testId="artifact-viewer-frame-loading" />}>
          <Chunk {...props} />
        </Suspense>
      </ArtifactChunkBoundary>
    </div>
  );
}

export default function ArtifactContent({ data, onOpenFile }: {
  data: ArtifactViewerData;
  /** A framed page's link to a file of its set that isn't a page opens it here (ArtifactFrame `onOpenFile`). */
  onOpenFile?: (path: string) => void;
}) {
  const { formatMessage } = useIntl();
  const { card } = data;
  // The file shown: the entry, or another the reader opened from the Files panel (artifactShownFile).
  const shown = useShownFile(data);
  const shownPath = shown.file?.path ?? null;
  const file = useMemo<ArtifactFileTarget | null>(
    () => (shownPath ? { id: card.id, version: card.version, path: shownPath } : null),
    [card.id, card.version, shownPath],
  );
  const downloadFile = useCallback(() => {
    trackArtifactViewerAction("download");
    if (file) void downloadArtifactFile(file).catch(() => {});
  }, [file]);
  // Downloads are the Artifact's own server's: another server's reader is offered none (readsInOwnServer).
  const download = file && readsInOwnServer(card) ? downloadFile : undefined;
  // The frame of another page than the entry: asked of the frame route with that page's path, on
  // every load (the viewer's answer carried a ticket for the entry alone).
  const locatePage = useCallback(
    (id: ArtifactId, version: number) => artifactSource().frame(id, shownPath === null ? { version } : { version, path: shownPath }),
    [shownPath],
  );

  // Another file than the entry is drawn by its own kind, where Raft draws that kind itself (an
  // image, a csv, text); another page, Markdown file or PDF of a framed version opens in the
  // version's frame, at its page (`opensInFrame`); anything else shows as a kind with no preview.
  if (!shown.entry && shown.file && file) {
    if (isArtifactDrawnKind(shown.file.kind)) {
      return <ArtifactDrawnContent key={shown.file.path} kind={shown.file.kind} file={file} title={shown.file.path} onDownload={download} />;
    }
    if (opensInFrame(card.kind, shown.file.kind)) {
      return (
        <DeferredArtifactFrame
          // Another page, like another version, is a new frame, with its own ticket.
          key={`${card.id}@${card.version}:${shown.file.path}`}
          id={card.id}
          version={card.version}
          kind={shown.file.kind}
          title={shown.file.path}
          pageUrl={artifactFileUrl(card.id, card.pinned ? card.version : null, shown.file.path)}
          onDownload={download}
          locate={locatePage}
          files={data.files}
          onOpenFile={onOpenFile}
        />
      );
    }
    return <NoPreview onDownload={download} label={formatMessage({ id: "artifacts.viewer.noPreview" })} />;
  }
  if (isArtifactFramedKind(card.kind)) {
    // Comments in the page (annotation anchors): Porthole draws anonymous
    // markers and reports which one was clicked and what was selected (P104);
    // Raft draws the card beside a marker (ArtifactCommentBubble) and the list.
    return (
      <DeferredArtifactFrame
        // A version switch is a new frame, with its own ticket.
        key={`${card.id}@${card.version}`}
        id={card.id}
        version={card.version}
        kind={card.kind}
        title={card.title}
        pageUrl={artifactUrl(card.id, card.pinned ? card.version : null)}
        onDownload={download}
        files={data.files}
        onOpenFile={onOpenFile}
      />
    );
  }
  if (file && isArtifactDrawnKind(card.kind)) return <ArtifactDrawnContent kind={card.kind} file={file} title={card.title} onDownload={download} />;
  return <NoPreview onDownload={download} label={formatMessage({ id: "artifacts.viewer.noPreview" })} />;
}

/**
 * A kind Raft draws itself, from `file`: an image, a csv as a table, text by its lines. The bytes
 * come from the reader around it (ArtifactFileReaderContext: the signed-in source in the viewer,
 * the signed-out file route on the public page). `fallback`: what shows when the file can't be
 * read or isn't what its name says, in place of the viewer's own No preview.
 */
export function ArtifactDrawnContent({ kind, file, title, onDownload, fallback }: {
  kind: ArtifactDrawnKind;
  file: ArtifactFileTarget;
  title: string;
  onDownload?: () => void;
  fallback?: ReactNode;
}) {
  if (kind === "image") return <ImageContent file={file} alt={title} onDownload={onDownload} fallback={fallback} />;
  if (kind === "csv") return <CsvContent file={file} fallback={fallback} />;
  return <TextContent file={file} fallback={fallback} />;
}

function NoPreview({ onDownload, label }: { onDownload?: () => void; label?: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-1 items-center justify-center p-6" data-testid="artifact-viewer-no-preview">
      <EmptyState
        icon={<FileX size={36} />}
        title={label ?? formatMessage({ id: "artifacts.viewer.noPreview" })}
        action={onDownload ? (
          <Button variant="outline" size="md" onClick={onDownload}>
            <Download />
            {formatMessage({ id: "artifacts.menu.download" })}
          </Button>
        ) : undefined}
      />
    </div>
  );
}

/**
 * A file Raft draws itself, with the loading splash over it until it arrives (stage 1 of the same
 * opening: one stage, no sandbox to start); its ending plays over the content.
 */
function SplashedContent({ kind, loaded, children = null }: { kind: ArtifactKind; loaded: boolean; children?: ReactNode }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={loaded ? undefined : true}>
      {children}
      <ArtifactLoadingSplash stage="getting" kind={kind} done={loaded} />
    </div>
  );
}

function ImageContent({ file, alt, onDownload, fallback }: { file: ArtifactFileTarget; alt: string; onDownload?: () => void; fallback?: ReactNode }) {
  const src = useArtifactImageSrc(file);
  if (src === false) return fallback ?? <NoPreview onDownload={onDownload} />;
  return (
    <SplashedContent kind="image" loaded={src !== null}>
      {src ? (
        // A raft-ui ScrollArea, the centring and the padding on its content, which is
        // as tall as the area: the image is fitted to it, so it scrolls only if the
        // padding alone outgrows a very short area.
        <ScrollArea className="min-h-0 flex-1 bg-fill-muted" contentClassName="flex h-full items-center justify-center p-4" data-testid="artifact-viewer-image-area">
          <img src={src} alt={alt} className="max-h-full max-w-full object-contain" data-testid="artifact-viewer-image" />
        </ScrollArea>
      ) : null}
    </SplashedContent>
  );
}

/** A small CSV reader: quoted fields are not handled yet. Cells are text. */
function parseCsv(text: string): string[][] {
  return text.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(","));
}

function CsvContent({ file, fallback }: { file: ArtifactFileTarget; fallback?: ReactNode }) {
  const text = useArtifactFileText(file);
  const rows = useMemo(() => (typeof text === "string" ? parseCsv(text) : null), [text]);
  // Data rows, 1-based without the header (as attachment comments count them).
  const units = useMemo(() => (rows ? rows.slice(1).map((row) => row.join(",")) : []), [rows]);
  if (text === null) return <SplashedContent kind="csv" loaded={false} />;
  if (text === undefined || !rows) return fallback ?? <NoPreview />;
  const [head = [], ...body] = rows;
  return (
    <SplashedContent kind="csv" loaded>
      {/* Scrolls both ways (wide rows) in a raft-ui ScrollArea, the padding
          kept on it: a region named after the file, a tab stop once it overflows. */}
      <ScrollArea
        role="region"
        aria-label={file.path}
        orientation="both"
        className="min-h-0 flex-1 px-2 py-2"
        data-testid="artifact-viewer-csv"
      >
        <ArtifactShellComments kind="csv-rows" path={file.path} units={units}>
          <Table>
            <TableHeader>
              <TableRow>
                {head.map((cell, index) => <TableHead key={index} className="whitespace-nowrap">{cell}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {body.map((row, rowIndex) => (
                <TableRow key={rowIndex} data-anchor-row={rowIndex + 1}>
                  {row.map((cell, index) => (
                    <TableCell key={index} className={`whitespace-nowrap ${index ? "font-mono tabular-nums" : ""}`}>{cell}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ArtifactShellComments>
      </ScrollArea>
    </SplashedContent>
  );
}

/** A text file's lines (a final newline ends the last line; it doesn't start another). */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function TextContent({ file, fallback }: { file: ArtifactFileTarget; fallback?: ReactNode }) {
  const text = useArtifactFileText(file);
  const lines = useMemo(() => (typeof text === "string" ? linesOf(text) : []), [text]);
  if (text === null) return <SplashedContent kind="text" loaded={false} />;
  if (text === undefined) return fallback ?? <NoPreview />;
  return (
    <SplashedContent kind="text" loaded>
      {/* A raft-ui ScrollArea on both axes, as the native box was, the padding
          kept on it: a region named after the file, a tab stop once it overflows. */}
      <ScrollArea
        role="region"
        aria-label={file.path}
        orientation="both"
        className="min-h-0 flex-1 p-4"
        data-testid="artifact-viewer-text"
      >
        <ArtifactShellComments kind="lines" path={file.path} units={lines}>
          <div className="font-mono text-footnote whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {lines.map((line, index) => (
              // One element per line, so comments can point at lines (and text stays text).
              <div key={index} data-anchor-line={index + 1}>{line.length > 0 ? line : <br />}</div>
            ))}
          </div>
        </ArtifactShellComments>
      </ScrollArea>
    </SplashedContent>
  );
}

