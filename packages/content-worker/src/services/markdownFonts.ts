/**
 * Raft's fonts for a Markdown page (markdown.ts, `MARKDOWN_FONT_FACES`), carried in the Worker's
 * bundle (wrangler.jsonc's `*.woff2` rule) and served beside the page under the version as
 * `_raft-fonts/<file>`, as the PDF viewer's files are (pdfViewer.ts): from the page's own origin,
 * under the frame's CSP as it is (its `font-src` is open to the version's own files), with
 * Porthole's headers for a version's file (`font/woff2`, its ETag, `immutable` once sealed).
 *
 * The files are the web's (packages/web/src/assets/fonts, Google Fonts' Space Grotesk v22 and Space
 * Mono v17), byte for byte (test/markdown-fonts.test.ts). Both are under the SIL Open Font License
 * 1.1 (../fonts/spacegrotesk-OFL.txt, ../fonts/spacemono-OFL.txt), which permits bundling them.
 */
import spaceGroteskLatinExt from "../fonts/space-grotesk-latin-ext.woff2";
import spaceGroteskLatin from "../fonts/space-grotesk-latin.woff2";
import spaceMonoLatinExt400 from "../fonts/space-mono-latin-ext-400.woff2";
import spaceMonoLatin400 from "../fonts/space-mono-latin-400.woff2";
import spaceMonoLatinExt700 from "../fonts/space-mono-latin-ext-700.woff2";
import spaceMonoLatin700 from "../fonts/space-mono-latin-700.woff2";
import { MARKDOWN_FONTS_DIR, MARKDOWN_FONT_FACES } from "../markdown";

const BYTES: Record<(typeof MARKDOWN_FONT_FACES)[number]["file"], ArrayBuffer> = {
  "space-grotesk-latin-ext.woff2": spaceGroteskLatinExt,
  "space-grotesk-latin.woff2": spaceGroteskLatin,
  "space-mono-latin-ext-400.woff2": spaceMonoLatinExt400,
  "space-mono-latin-400.woff2": spaceMonoLatin400,
  "space-mono-latin-ext-700.woff2": spaceMonoLatinExt700,
  "space-mono-latin-700.woff2": spaceMonoLatin700,
};

type Asset = { readonly bytes: Uint8Array; readonly sha256: string };
let assets: ReadonlyMap<string, Asset> | null = null;

/** The fonts by their path in the version (made once per isolate, when a Markdown page is first served). */
export function markdownFontFiles(): ReadonlyMap<string, Asset> {
  if (assets === null) {
    assets = new Map(
      MARKDOWN_FONT_FACES.map(({ file, sha256 }) => [`${MARKDOWN_FONTS_DIR}${file}`, { bytes: new Uint8Array(BYTES[file]), sha256 }]),
    );
  }
  return assets;
}
