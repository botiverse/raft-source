import { useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Image as ImageIcon, Workflow } from "lucide-react";
import { CheckboxIndicator, InlineCode, MarkdownBlockquote, Separator } from "@botiverse/raft-ui";
import { parseArtifactExcerptBlocks } from "@botiverse/raft-shared";
import type { ArtifactExcerptBlock, ArtifactExcerptListItem, ArtifactExcerptSpan } from "@botiverse/raft-shared";

// The thumbnail preview's own type scale (12/18, 15/20, 14/20, 11/16; Kirby,
// #13472), one for message cards and home tiles: a page drawn small. Fixed on
// purpose, so it doesn't follow the viewport as the UI's responsive tokens do.
// Move it into raft-design as tokens when a second use appears. Levels differ by
// size and weight, never by colour.
const BODY_TYPE = "text-[12px]/[18px]";
const CODE_TYPE = "font-mono text-[11px]/[16px]";
const HEADING_TYPE: Record<number, string> = { 1: "text-[15px]/[20px] font-semibold", 2: "text-[14px]/[20px] font-semibold" };
const SMALL_HEADING_TYPE = `${BODY_TYPE} font-semibold`;
/** 6px between blocks; the first has nothing above it. */
const BLOCK_GAP = "mt-1.5 first:mt-0";
/** 8px above a heading. */
const HEADING_GAP = "mt-2 first:mt-0";

function ExcerptWord({ span }: { span: ArtifactExcerptSpan }) {
  let word: ReactNode = span.text;
  if (span.code) word = <InlineCode className={`${CODE_TYPE} px-0.5 py-0`}>{word}</InlineCode>;
  if (span.italic) word = <em>{word}</em>;
  if (span.bold) word = <strong className="font-semibold">{word}</strong>;
  return word;
}

function ExcerptWords({ spans }: { spans: readonly ArtifactExcerptSpan[] }) {
  return spans.map((span, index) => <ExcerptWord key={index} span={span} />);
}

/** A check is drawn, not an input: nothing here takes focus. */
function ExcerptListMarker({ item }: { item: ArtifactExcerptListItem }) {
  if (item.checked !== undefined) return <CheckboxIndicator checked={item.checked} className="mt-[3px] size-3 [&_svg]:size-2.5" />;
  // The dot is the marker's, as a native list's is: drawn by CSS, not copy.
  if (item.order !== undefined) return <span className="shrink-0 tabular-nums after:content-['.']">{item.order}</span>;
  return <span className="mt-[7px] size-1 shrink-0 rounded-full bg-current" />;
}

function ExcerptList({ items }: { items: readonly ArtifactExcerptListItem[] }) {
  return (
    <ul className={BLOCK_GAP}>
      {items.map((item, index) => (
        <li key={index} className={`flex gap-1.5 ${item.level === 1 ? "pl-4" : ""}`}>
          <ExcerptListMarker item={item} />
          <span className="min-w-0"><ExcerptWords spans={item.spans} /></span>
        </li>
      ))}
    </ul>
  );
}

/** Its natural width, cut by the frame when wider: nothing here scrolls. */
function ExcerptTable({ block }: { block: Extract<ArtifactExcerptBlock, { type: "table" }> }) {
  const cellClass = "border border-line-hairline px-1.5 text-left align-top whitespace-nowrap";
  return (
    <table className={`${BLOCK_GAP} border-collapse`}>
      <thead>
        <tr>{block.header.map((cell, index) => <th key={index} className={`${cellClass} font-semibold`}><ExcerptWords spans={cell} /></th>)}</tr>
      </thead>
      <tbody>
        {block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, index) => <td key={index} className={cellClass}><ExcerptWords spans={cell} /></td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

/** What stands in for something not drawn: an icon and the hint colour, so it doesn't read as the document's own words. */
function ExcerptLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className={`${BLOCK_GAP} flex gap-1 text-foreground-hint [&_svg]:mt-[3px] [&_svg]:size-3 [&_svg]:shrink-0`}>
      {icon}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function ExcerptBlock({ block }: { block: ArtifactExcerptBlock }) {
  const { formatMessage } = useIntl();
  switch (block.type) {
    case "heading":
      return <p className={`${HEADING_GAP} ${HEADING_TYPE[block.level] ?? SMALL_HEADING_TYPE}`}><ExcerptWords spans={block.spans} /></p>;
    case "paragraph":
      return <p className={BLOCK_GAP}><ExcerptWords spans={block.spans} /></p>;
    case "quote":
      return <MarkdownBlockquote className={`my-0 ${BLOCK_GAP}`}><ExcerptWords spans={block.spans} /></MarkdownBlockquote>;
    case "list":
      return <ExcerptList items={block.items} />;
    case "code":
      return <pre className={`${BLOCK_GAP} ${CODE_TYPE} overflow-clip rounded-sticker bg-fill-muted px-2 py-1`}>{block.lines.join("\n")}</pre>;
    case "table":
      return <ExcerptTable block={block} />;
    case "image":
      return <ExcerptLabel icon={<ImageIcon />}>{block.alt === "" ? formatMessage({ id: "artifacts.card.excerptImage" }) : formatMessage({ id: "artifacts.card.excerptImageNamed" }, { alt: block.alt })}</ExcerptLabel>;
    case "images":
      return <ExcerptLabel icon={<ImageIcon />}>{formatMessage({ id: "artifacts.card.excerptImages" }, { count: block.count })}</ExcerptLabel>;
    case "diagram":
      return <ExcerptLabel icon={<Workflow />}>{formatMessage({ id: "artifacts.card.excerptDiagram" })}</ExcerptLabel>;
    case "rule":
      return <Separator className={BLOCK_GAP} />;
  }
}

/**
 * A Markdown version's excerpt where a card's picture goes (ArtifactPreview
 * `excerpt`, #proj-workspace:#217, #220), on home tiles and in messages alike,
 * on the card's own surface, so it reads as the page's start. A tile keeps the
 * same 16:10 frame as a screenshot, so a row of tiles stays even (`fit="frame"`).
 * In a message the height follows the words (`fit="content"`, Kirby, #13472): at
 * least 96 px (four lines; about the smallest preview there is, a phone's tile),
 * at most 192 px (the picture's frame there). CSS alone decides it, so the height
 * is right on first paint and nothing moves. Its first blocks, small,
 * with their hierarchy (`blocks`), or its plain `text` for a version from before
 * them, or blocks this client can't read: parseArtifactExcerptBlocks is the
 * boundary, and either is agent-made words.
 *
 * Those words are only ever text nodes in plain elements, never parsed as
 * Markdown or HTML here and never set as HTML. There is no anchor, image or
 * input in it, however the Artifact was written: an image is a label, a link is
 * its words (the whole card is one target), and nothing is fetched. Cut by the
 * frame, it fades out at its foot (DS Spacing, Edges fade: the edge's length, as
 * a phone's tile is too short to give the content's 48px); a table
 * wider than the frame is cut, with no scrollbar. Decoration, as a screenshot's
 * `alt=""`: hidden from assistive technology, which would read it all before
 * the title. Nothing in it takes focus.
 */
export function ArtifactCardExcerpt({ text, blocks, fit = "frame", testId }: { text: string; blocks?: readonly ArtifactExcerptBlock[] | undefined; fit?: "frame" | "content"; testId: string }) {
  const drawn = useMemo(() => parseArtifactExcerptBlocks(blocks), [blocks]);
  const height = fit === "frame" ? "aspect-[16/10]" : "min-h-24 max-h-48";
  // A fixed frame fills up and always ends in the fade; one that follows its words fades only once they reach its max (index.css).
  const box = fit === "frame" ? "mask-fade-b-edge flex-1" : "mask-fade-b-edge-at-max";
  return (
    <div aria-hidden className={`flex ${height} w-full flex-col border-b border-line-hairline bg-layer-card p-3`} data-testid={testId}>
      {drawn ? (
        <div className={`${box} min-h-0 overflow-clip break-words text-foreground ${BODY_TYPE}`}>
          {drawn.map((block, index) => <ExcerptBlock key={index} block={block} />)}
        </div>
      ) : (
        <p className={`${box} min-h-0 overflow-clip break-words whitespace-pre-line text-foreground ${BODY_TYPE}`}>{text}</p>
      )}
    </div>
  );
}
