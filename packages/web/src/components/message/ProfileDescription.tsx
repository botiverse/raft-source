import { useCallback, useMemo, useState } from "react";
import type { FocusEvent, PointerEvent, ReactElement, ReactNode } from "react";
import { useIntl } from "react-intl";
import { FileText } from "lucide-react";
import { MessageReferenceLabel, MessageReferencePending, MessageReferenceUnavailable } from "@botiverse/raft-ui";

import { artifactLinkOf, artifactObjectRefOf, useArtifactLinkSummaries, useArtifactLinkTargets } from "../../apps/artifacts";
import type { ArtifactLink, ArtifactLinkTarget } from "../../apps/artifacts";
import { objectRefKey } from "../../objects/objectSummaryLoader";
import Tooltip from "../ui/Tooltip";
import { DeletedObjectChip, ObjectLinkChip } from "./AppLinkChip";
import { descriptionPieces, descriptionUrls } from "./descriptionLinks";

type Shown = { kind: "text"; text: string } | { kind: "artifact"; url: string; link: ArtifactLink };

// A chip with its own hover card (not the deleted chip, which has none: over
// it the description's tooltip still shows).
const CHIP_SELECTOR = '[data-app-link-chip]:not([data-app-link-chip="deleted"])';
const inChip = (target: EventTarget | null | undefined) => target instanceof Element && target.closest(CHIP_SELECTOR) !== null;

/**
 * A profile description (an agent's or a member's) with its Artifact links
 * drawn as the chip a message body draws for them (ObjectLinkChip: the
 * kind's icon and the title, its hover card), never as the raw address
 * (artin). `children` draws the description's box from its content; it is
 * the trigger of the description's own tooltip (the whole description, for
 * a box that cuts it).
 *
 * - Titles come from core's object summaries (useArtifactLinkSummaries, as a
 *   message body's chips), asked when the row mounts (overscan rows of the
 *   virtual timeline included; unlike a body, not gated on being seen: a
 *   description is one reference per agent), batched across the mounted
 *   rows and kept by the page, so N rows of one agent are one reference in
 *   one request.
 * - Until it answers: a pending chip reading "Artifact". Unavailable to this
 *   viewer, or failed: the same words, gray (never the address, never a
 *   title they may not read). Deleted, to a viewer who could see it: the
 *   message body's deleted chip.
 * - The tooltip says the description with titles for addresses, and stays
 *   closed while the pointer or keyboard focus is on a chip, whose own hover
 *   card says more (over a deleted chip, which has none, it still shows).
 * - The chip is capped at 16em and sits on the line's baseline, so the row
 *   neither grows nor wraps.
 */
export function ProfileDescription({ text, children }: { text: string; children: (content: ReactNode) => ReactElement }) {
  const { formatMessage } = useIntl();
  const pieces = useMemo(() => descriptionPieces(text), [text]);
  const urls = useMemo(() => descriptionUrls(pieces), [pieces]);
  const targets = useArtifactLinkTargets(urls);
  const asked = useMemo(() => {
    const byRef = new Map<string, ArtifactLinkTarget>();
    for (const target of targets.values()) byRef.set(objectRefKey(artifactObjectRefOf(target)), target);
    return [...byRef.values()];
  }, [targets]);
  const summaries = useArtifactLinkSummaries(asked, asked.length > 0);
  const shown = useMemo(() => pieces.map((piece): Shown => {
    const target = piece.kind === "link" ? targets.get(piece.url) : undefined;
    if (piece.kind === "text") return piece;
    if (!target) return { kind: "text", text: piece.url };
    return { kind: "artifact", url: piece.url, link: artifactLinkOf(target, summaries?.get(objectRefKey(artifactObjectRefOf(target)))) };
  }), [pieces, targets, summaries]);
  const placeholder = formatMessage({ id: "artifacts.chip.placeholder" });
  const words = useMemo(() => shown.map((piece) => {
    if (piece.kind === "text") return piece.text;
    if (piece.link.state === "ok") return piece.link.data.summary.title;
    return piece.link.state === "deleted" ? piece.link.data.deleted.title : piece.url;
  }).join(""), [shown]);

  // The description's tooltip never stacks on a chip's hover card: it doesn't
  // open while the pointer or the focus is on a chip (both open the card),
  // and closes when either moves onto one.
  const [open, setOpen] = useState(false);
  const [onChip, setOnChip] = useState(false);
  const onOpenChange = useCallback((next: boolean, details?: { event?: Event }) => {
    setOpen(next && !onChip && !inChip(details?.event?.target));
  }, [onChip]);
  const onPointerOver = useCallback((event: PointerEvent<HTMLElement>) => {
    const chip = inChip(event.target);
    setOnChip(chip);
    if (chip) setOpen(false);
  }, []);
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (inChip(event.target)) setOpen(false);
  }, []);
  const triggerProps = useMemo(() => ({ onPointerOver, onFocus }), [onPointerOver, onFocus]);

  if (targets.size === 0) return <Tooltip content={text}>{children(text)}</Tooltip>;
  const content = shown.map((piece, index) => {
    if (piece.kind === "text") return piece.text;
    return <DescriptionArtifact key={index} url={piece.url} link={piece.link} placeholder={placeholder} />;
  });
  return (
    <Tooltip content={words} open={open} onOpenChange={onOpenChange} triggerProps={triggerProps}>
      {children(content)}
    </Tooltip>
  );
}

function DescriptionArtifact({ url, link, placeholder }: { url: string; link: ArtifactLink; placeholder: string }) {
  const chip = useMemo(() => (link.state === "ok" ? { kind: "object" as const, url, ...link } : null), [link, url]);
  let drawn: ReactNode;
  if (chip) drawn = <ObjectLinkChip link={chip} />;
  else if (link.state === "deleted") drawn = <DeletedObjectChip title={link.data.deleted.title} url={url} />;
  else if (link.state === "loading") {
    drawn = (
      <MessageReferencePending capped data-description-artifact="pending">
        <FileText aria-hidden />
        <MessageReferenceLabel>{placeholder}</MessageReferenceLabel>
      </MessageReferencePending>
    );
  } else {
    drawn = (
      <MessageReferenceUnavailable data-description-artifact="unavailable">
        <FileText aria-hidden />
        <MessageReferenceLabel>{placeholder}</MessageReferenceLabel>
      </MessageReferenceUnavailable>
    );
  }
  // 16em, not the message body's 24em: a description is the row's quietest
  // part. The chip takes the line's own height (raft-ui's --chip-line-height;
  // 1lh is the description's line), so a row of small meta text doesn't grow.
  return <span className="inline-flex min-w-0 max-w-[16em] align-baseline [--chip-line-height:1lh]">{drawn}</span>;
}
