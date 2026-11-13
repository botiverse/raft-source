Raft's fonts, self-hosted by the web app (and, through `@web/index.css`, by
Raft Desktop on its `app://raft` origin). `src/fonts.css` declares them and is imported first by
`src/index.css` in place of `@botiverse/raft-ui/fonts.css`, which loads the same
families from Google Fonts.

- `space-grotesk-{latin,latin-ext,vietnamese}.woff2` (variable, 300..700) and
  `space-mono-{latin,latin-ext,vietnamese}-{400,700}.woff2`: the files the
  Google Fonts css2 request in raft-ui 0.52.2's fonts.css
  (`family=Space+Grotesk:wght@300..700&family=Space+Mono:wght@400;700&display=swap`)
  serves to Chrome, fetched 2026-10-30 (Space Grotesk v22, Space Mono v17), with
  Google's unicode ranges and `font-display: swap` unchanged.
- `hanken-grotesk-quotes.woff2`: Hanken Grotesk v12 latin, used only for U+0022
  by the `Raft Quote Glyphs` face.

All are licensed under the SIL Open Font License 1.1 (spacegrotesk-OFL.txt,
spacemono-OFL.txt, hankengrotesk-OFL.txt), which permits bundling and
redistribution with the app.

Updating: re-request the css2 URL raft-ui's fonts.css uses with a current Chrome
user agent, download every subset, keep the unicode ranges, and re-copy the font
variables from the raft-ui version this package depends on
(`tests/fontsCss.test.ts` fails when they drift).

Share images (`src/utils/selectScreenshotFonts.ts`) embed these faces as data
URLs, because the SVG image they are rasterized from cannot reach page fonts.
It embeds the families in its `SCREENSHOT_FONT_FAMILIES` list, from this origin
only: keep that list in step when a family is added or renamed here, and keep
the files small (all of them are fetched once per session, ~130 KB today).
