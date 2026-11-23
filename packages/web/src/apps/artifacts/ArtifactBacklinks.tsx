import { useCallback, useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, Link2 } from "lucide-react";
import { Badge, Drawer, DrawerContent, DrawerHeader, DrawerTitle, ListRow, ScrollArea } from "@botiverse/raft-ui";

import { isInputMethodKey } from "./artifactInputMethodKey";
import { ArtifactBacklinksList } from "./ArtifactBacklinksList";
import { useArtifactBacklinksHere } from "./useArtifactBacklinks";

/**
 * "Linked from" in the viewer (#proj-workspace:#336 step 2, Kirby's design): what links to the
 * Artifact, for this reader (ArtifactBacklinksProvider), from two places only:
 *
 * - where the content scrolls inside a frame (HTML, Markdown, a PDF; and No preview), a strip at the
 *   foot of the content area, outside the frame (the page's scripts must never read it), as wide as
 *   the content (ArtifactBacklinksFoot). "Linked from N" and a chevron; pressed, on a desktop it opens
 *   in place as a section above the strip (at most 40% of the content's height, scrolling inside),
 *   on a phone a bottom sheet (the surface's sheets: raft-ui Drawer);
 * - where Raft draws the content itself (a csv, text, an image: the content scrolls in Raft), a block
 *   directly under it (ArtifactBacklinksBlock), no strip.
 *
 * And the title's chip (ArtifactBacklinksChip), "Linked from N" beside the version in the head,
 * which opens that same place: the strip's section or sheet, or the block, scrolled to and focused.
 * No second way in. Nothing at all while loading, on a failure, or when nothing links it.
 */

/** "Linked from N" ("999+" past 999): the strip's, the chip's, the block's and the sheet's title. */
function useBacklinksTitle(countText: string): string {
  const { formatMessage } = useIntl();
  return formatMessage({ id: "artifacts.backlinks.title" }, { count: countText });
}

/** The title's chip, beside the version tag (a desktop's one-line head) or in the meta line (a phone's, the App's toolbar). */
export function ArtifactBacklinksChip() {
  const here = useArtifactBacklinksHere();
  const title = useBacklinksTitle(here?.countText ?? "");
  if (!here) return null;
  const { place, phone, open, reveal } = here;
  // A desktop's strip opens a section in place (a disclosure); a phone's, a sheet (a dialog).
  const disclosure = place === "strip" && !phone;
  return (
    <Badge
      appearance="outline"
      variant="muted"
      render={<button type="button" />}
      onClick={reveal}
      aria-expanded={disclosure ? open : undefined}
      aria-haspopup={place === "strip" && phone ? "dialog" : undefined}
      className="shrink-0 cursor-pointer"
      data-testid="artifact-backlinks-chip"
    >
      <Link2 aria-hidden />
      {title}
    </Badge>
  );
}

/**
 * The strip at the content's foot and, on a desktop, its section above it while open; on a phone
 * its sheet. Only where the file shown is in a frame (`place` strip). The surface places it under
 * the content's box, in the column the comment list takes its width from (so it is as wide as the
 * content, and covered with it where the list is over a narrow card).
 */
export function ArtifactBacklinksFoot() {
  const here = useArtifactBacklinksHere();
  const title = useBacklinksTitle(here?.countText ?? "");
  const sectionId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  const setOpen = here?.setOpen;
  const open = here?.open ?? false;
  const phone = here?.phone ?? false;
  const revealed = here?.revealed ?? 0;
  const setStrip = here?.setStrip;
  const toggle = useCallback(() => setOpen?.(!open), [setOpen, open]);
  // The chip opened it: the section takes focus, so the next Tab is in it (the strip keeps it when pressed itself).
  // Esc in it closes it, focus back on the strip (useArtifactSurfaceKeyDown), not the viewer around it.
  useEffect(() => {
    if (revealed > 0 && open && !phone) sectionRef.current?.focus();
  }, [revealed, open, phone]);
  if (!here || here.place !== "strip") return null;
  const { backlinks } = here;
  const shownHere = open && !phone;
  return (
    <>
      {shownHere ? (
        // Above the strip, at most 40% of the content's height (the column this sits in), scrolling inside.
        <section
          ref={sectionRef}
          id={sectionId}
          tabIndex={-1}
          aria-label={title}
          className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-line-seam bg-layer-canvas outline-none"
          data-testid="artifact-backlinks-section"
        >
          <ScrollArea overscroll="auto" className="min-h-0 flex-1" contentClassName="px-4 py-3">
            <ArtifactBacklinksList documents={backlinks.documents.items} discussions={here.discussions} />
          </ScrollArea>
        </section>
      ) : null}
      {/* raft-ui's ListRow, one slim line as wide as the content: its hover, press and focus ring. */}
      <ListRow
        ref={setStrip}
        variant="entry"
        tone="muted"
        onClick={toggle}
        aria-expanded={phone ? undefined : open}
        aria-controls={shownHere ? sectionId : undefined}
        aria-haspopup={phone ? "dialog" : undefined}
        className="h-9 shrink-0 gap-1.5 border-t border-line-seam bg-layer-canvas py-0 text-callout [&_svg]:size-4 [&_svg]:shrink-0"
        data-testid="artifact-backlinks-strip"
      >
        <Link2 aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
        {open && !phone ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
      </ListRow>
      {phone ? <BacklinksSheet title={title} /> : null}
    </>
  );
}

/** A phone's "Linked from": a bottom sheet over the viewer, as its comment list and Files are there. */
function BacklinksSheet({ title }: { title: string }) {
  const here = useArtifactBacklinksHere();
  const setOpen = here?.setOpen;
  const strip = here?.strip;
  const change = useCallback((next: boolean) => {
    if (!next) setOpen?.(false);
  }, [setOpen]);
  const close = useCallback(() => setOpen?.(false), [setOpen]);
  // A row in the sheet (a portal) opens an Artifact where the strip is: in this viewer.
  const from = useCallback(() => strip?.() ?? null, [strip]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || isInputMethodKey(event)) return;
    // Esc closes the sheet only, not the viewer behind it (as the comment sheet's).
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    close();
  }, [close]);
  if (!here) return null;
  return (
    <Drawer open={here.open} onOpenChange={change}>
      <DrawerContent aria-label={title} onKeyDown={onKeyDown} data-testid="artifact-backlinks-sheet">
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>
        <ScrollArea overscroll="auto" className="max-h-[60dvh]" contentClassName="px-4 pb-4">
          <ArtifactBacklinksList documents={here.backlinks.documents.items} discussions={here.discussions} from={from} onOpened={close} />
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Directly under content Raft draws (a csv, text, an image), in its scrolling area: the heading and
 * the list, no strip. The chip scrolls to it and focuses it (`setBlock`). Nowhere else (the public
 * page draws the same content with no surface around it: nothing). `inset`: its side padding, to
 * line up with the content above it.
 */
export function ArtifactBacklinksBlock({ inset = "" }: { inset?: string }) {
  const here = useArtifactBacklinksHere();
  const title = useBacklinksTitle(here?.countText ?? "");
  const headingId = useId();
  const setBlock = here?.setBlock;
  if (!here || here.place !== "below") return null;
  return (
    <section
      ref={setBlock}
      tabIndex={-1}
      aria-labelledby={headingId}
      className={`mt-4 flex min-w-0 flex-col gap-3 border-t border-line-seam pt-4 pb-2 outline-none ${inset}`}
      data-testid="artifact-backlinks-block"
    >
      <h2 id={headingId} className="m-0 flex items-center gap-1.5 text-callout font-semibold text-foreground [&_svg]:size-4 [&_svg]:text-foreground-muted">
        <Link2 aria-hidden />
        {title}
      </h2>
      <ArtifactBacklinksList documents={here.backlinks.documents.items} discussions={here.discussions} />
    </section>
  );
}
