// A Markdown version's rich excerpt: the first blocks of its entry, as data
// (ArtifactPreview `excerpt`, its optional `blocks`; #proj-workspace:#220). The
// Server makes it (server apps/artifacts/excerptBlocks.ts) and stores it on the
// version's row; a card draws it with plain elements and text nodes. It is
// never HTML and never Markdown: every string in it is agent-made words, which
// a client shows as text. It has no URL of any kind, so drawing it fetches
// nothing and links nowhere.
//
// parseArtifactExcerptBlocks is the boundary, on both sides: the Server checks
// what it is about to store, a client what it is about to draw. A block type it
// doesn't know is left out, so a type added later costs a shipped App one block,
// not the card (Tenny, #13472). A block of a known type that isn't valid fails
// the whole list, and the client draws `text`: `text` is always there.
//
// The bounds are the largest frame's, a tile of up to about 495 by 309 px
// (minmax(248px, 1fr) in a grid: a tile is under twice its minimum) at 12/18:
// 15 lines of 78 Latin or 39 Chinese characters.
import { z } from "zod";
import { lazySchema } from "./lazySchema";

/** Lines of the frame: a block, a list item, a code line or a table row each take one. 16 lines overflow the largest frame. */
export const ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS = 16;
/** UTF-8 bytes of all the words: 1,170 Latin characters or 585 Chinese ones (1,755 bytes) fill the largest frame, so this always reaches the fade. Bytes, not characters, so Chinese and emoji can't make a card heavier than English. */
export const ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES = 2_048;
/** Styled runs in all: about one per word of a page full of inline code, and what a run's keys cost on the wire is bounded with it. */
export const ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS = 80;
/**
 * The whole list as JSON, in UTF-8 bytes: the hard bound, since escapes and
 * keys count too (trailing blocks are dropped to meet it). A home page of 50
 * Markdown tiles carries at most 300 KiB of it, before compression.
 */
export const ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES = 6_144;
/** A code block's first lines (Kirby's spec), each clipped: a line past the frame's width only clips there. */
export const ARTIFACT_EXCERPT_CODE_MAX_LINES = 4;
export const ARTIFACT_EXCERPT_CODE_LINE_MAX_CHARS = 100;
/** A table's rows under its header (Kirby's spec), and its columns: eight are past the width of any frame, which clips them. */
export const ARTIFACT_EXCERPT_TABLE_MAX_ROWS = 3;
export const ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS = 8;
/** An image's label: its alt text, on one line. */
export const ARTIFACT_EXCERPT_IMAGE_ALT_MAX_CHARS = 80;
/** Images counted on a line of them: more than the 64 KiB of an entry that is read can hold. */
export const ARTIFACT_EXCERPT_IMAGES_MAX_COUNT = 65_536;

/** Words with the inline styles that survive: bold, italic and code. A link is its words, a mention its characters. */
const spanSchema = lazySchema("artifactExcerptSpanSchema", () => z.object({
  text: z.string().min(1).max(ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES),
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  code: z.literal(true).optional(),
}));
const spansSchema = lazySchema("artifactExcerptSpansSchema", () => z.array(spanSchema).min(1).max(ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS));
/** A table's cell may be empty. */
const cellsSchema = lazySchema("artifactExcerptCellsSchema", () => z.array(z.array(spanSchema).max(ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS)).min(1).max(ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS));

const listItemSchema = lazySchema("artifactExcerptListItemSchema", () => z.object({
  /** 0, or 1 for anything nested: lists show at most two levels. */
  level: z.union([z.literal(0), z.literal(1)]),
  /** An ordered item's number, as written. */
  order: z.number().int().min(0).max(999_999_999).optional(),
  /** A task item's state, drawn as a static check. */
  checked: z.boolean().optional(),
  spans: spansSchema,
}));

const blockSchema = lazySchema("artifactExcerptBlockSchema", () => z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.number().int().min(1).max(6), spans: spansSchema }),
  z.object({ type: z.literal("paragraph"), spans: spansSchema }),
  z.object({ type: z.literal("quote"), spans: spansSchema }),
  z.object({ type: z.literal("list"), items: z.array(listItemSchema).min(1).max(ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS) }),
  z.object({
    type: z.literal("code"),
    lines: z.array(z.string().max(ARTIFACT_EXCERPT_CODE_LINE_MAX_CHARS * 2)).min(1).max(ARTIFACT_EXCERPT_CODE_MAX_LINES),
  }),
  z.object({ type: z.literal("table"), header: cellsSchema, rows: z.array(cellsSchema).max(ARTIFACT_EXCERPT_TABLE_MAX_ROWS) }),
  /** Not loaded: a label. `alt` may be empty. */
  z.object({ type: z.literal("image"), alt: z.string().max(ARTIFACT_EXCERPT_IMAGE_ALT_MAX_CHARS * 2) }),
  /**
   * A line of several images: one row with their count, and no alt text, so a row
   * of badges costs one row and a few bytes. Only the Server can tell these from
   * images on lines of their own, each of which is an `image`.
   */
  z.object({ type: z.literal("images"), count: z.number().int().min(2).max(ARTIFACT_EXCERPT_IMAGES_MAX_COUNT) }),
  /** A Mermaid or HTML block: a label, whatever it held. */
  z.object({ type: z.literal("diagram") }),
  z.object({ type: z.literal("rule") }),
]));

const blocksSchema = lazySchema("artifactExcerptBlocksSchema", () => z.array(blockSchema).min(1).max(ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS));

export type ArtifactExcerptSpan = z.infer<typeof spanSchema>;
export type ArtifactExcerptListItem = z.infer<typeof listItemSchema>;
export type ArtifactExcerptBlock = z.infer<typeof blockSchema>;

/** Every type above: adding a block without adding it here doesn't compile. */
const BLOCK_TYPES: Record<ArtifactExcerptBlock["type"], true> = {
  heading: true, paragraph: true, quote: true, list: true, code: true, table: true, image: true, images: true, diagram: true, rule: true,
};

/** An object naming a type this client doesn't know: a newer Server's. An object with no type is simply not a block. */
function isFromANewerServer(block: unknown): boolean {
  if (typeof block !== "object" || block === null || !("type" in block)) return false;
  return typeof block.type === "string" && !Object.hasOwn(BLOCK_TYPES, block.type);
}

/**
 * `value` as a block list without the blocks this client doesn't know, or null
 * when it isn't one a client may draw (null too when nothing is left: it would
 * draw nothing).
 */
export function parseArtifactExcerptBlocks(value: unknown): ArtifactExcerptBlock[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = blocksSchema.safeParse(value.filter((block) => !isFromANewerServer(block)));
  return parsed.success ? parsed.data : null;
}
