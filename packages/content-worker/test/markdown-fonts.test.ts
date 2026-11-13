import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MARKDOWN_FONTS_DIR, MARKDOWN_FONT_FACES, pageLangOf, renderMarkdownToHtml } from "../src/markdown";

/**
 * A Markdown page sets its text in Raft's fonts, served from its own origin, with raft-ui's CJK
 * fallbacks and a `lang` from its words (#proj-workspace:#262). The page is checked as text; that
 * the files are served beside it, and under which CSP, is test/raft-content.test.ts.
 */
const ROOT = new URL("../../", import.meta.url);
const WEB_FONTS = new URL("web/src/assets/fonts/", ROOT);
const OWN_FONTS = new URL("../src/fonts/", import.meta.url);
const webFontsCss = readFileSync(new URL("web/src/fonts.css", ROOT), "utf8");

function styleOf(page: string): string {
  const match = /<style>([\s\S]*)<\/style>/.exec(page);
  assert.ok(match, "the page's style");
  return match[1]!;
}

/** The font variable rules of `css` (`:where(:root…) { … }`), whitespace collapsed, comments gone. */
function variableRules(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/:where\([^{]*\)\s*\{[^}]*\}/g)].map(([rule]) => rule.replace(/\s+/g, " ").trim());
}

const faceOf = (body: string) => ({
  family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
  weight: /font-weight:\s*([^;]+);/.exec(body)?.[1]!.trim(),
  display: /font-display:\s*([^;]+);/.exec(body)?.[1]!.trim(),
  src: /src:\s*url\(([^)]+)\)\s*format\('woff2'\)/.exec(body)?.[1],
  range: /unicode-range:\s*([^;]+);/.exec(body)?.[1]!.trim(),
});
const facesOf = (css: string) => [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => faceOf(body!));

test("the fonts are the web's files, byte for byte, with their hashes and OFL licences", () => {
  assert.equal(MARKDOWN_FONT_FACES.length, 6);
  for (const { file, sha256 } of MARKDOWN_FONT_FACES) {
    const own = readFileSync(new URL(file, OWN_FONTS));
    assert.equal(own.subarray(0, 4).toString(), "wOF2", file);
    assert.deepEqual(own, readFileSync(new URL(file, WEB_FONTS)), file);
    assert.equal(createHash("sha256").update(own).digest("hex"), sha256, file);
  }
  for (const licence of ["spacegrotesk-OFL.txt", "spacemono-OFL.txt"]) {
    const text = readFileSync(new URL(licence, OWN_FONTS), "utf8");
    assert.match(text, /SIL Open Font License, Version 1\.1/, licence);
    assert.equal(text, readFileSync(new URL(licence, WEB_FONTS), "utf8"), licence);
  }
  // Lean: latin and latin-ext only.
  const total = MARKDOWN_FONT_FACES.reduce((sum, { file }) => sum + readFileSync(new URL(file, OWN_FONTS)).byteLength, 0);
  assert.ok(total < 100_000, `${total} bytes`);
});

test("the page declares each face from its own origin, as the web does, by a path relative to the page", () => {
  const css = styleOf(renderMarkdownToHtml("# Notes", "Notes", "notes.md"));
  assert.doesNotMatch(css, /url\(\s*['"]?(?:https?:)?\/\//, "no font from another origin");
  const faces = facesOf(css);
  const web = facesOf(webFontsCss);
  assert.deepEqual(faces.map(({ src }) => src), MARKDOWN_FONT_FACES.map(({ file }) => `./${MARKDOWN_FONTS_DIR}${file}`));
  for (const face of faces) {
    const file = face.src!.slice(face.src!.lastIndexOf("/") + 1);
    const theWeb = web.find((each) => each.src === `./assets/fonts/${file}`);
    assert.ok(theWeb, file);
    assert.deepEqual({ ...face, src: file }, { ...theWeb, src: file }, file);
    assert.equal(face.display, "swap");
  }
  // A page in a directory reaches the version's root.
  const nested = facesOf(styleOf(renderMarkdownToHtml("# Notes", "Notes", "docs/2026/notes.md")));
  assert.ok(nested.every(({ src }) => src!.startsWith(`./../../${MARKDOWN_FONTS_DIR}`)), JSON.stringify(nested));
});

test("the page carries raft-ui's font variables, the CJK stacks by lang included", () => {
  const rules = variableRules(styleOf(renderMarkdownToHtml("# Notes", "Notes")));
  assert.equal(rules.length, 4, "default, Traditional Chinese, Japanese, Korean");
});

test("text, code and the page's controls are set in the variables at the body tier, no system stack left", () => {
  const css = styleOf(renderMarkdownToHtml("# Notes\n\n`code`", "Notes"));
  assert.ok(css.includes("font: 400 16px/1.5 var(--sans-font); }"), "body: 16/24 at 400, CJK too");
  assert.ok(css.includes("@media (min-width: 48rem) and (pointer: fine) { body { font-size: 14px; line-height: calc(22 / 14); } }"), "14/22 on a desktop");
  assert.ok(css.includes(".doc pre, .doc code { font-family: var(--mono-font); }"));
  assert.ok(css.includes("font-size: 13px; line-height: 20px; }"), "code blocks: text-mono-code, 13/20");
  assert.ok(css.includes("font: 600 12px/1.1 var(--sans-font); }"), "the diagram toolbar");
  assert.ok(css.includes("font: 12px/1.4 var(--mono-font); }"), "the diagram alert");
  assert.doesNotMatch(css, /-apple-system|Segoe UI|Roboto|SFMono-Regular|Consolas/);
});

test("lang comes from the words: zh-CN, zh-TW, ja, ko, else en", () => {
  const cases: [string, string][] = [
    ["", "en"],
    ["# Release notes\n\nThe fonts now load from the Artifact's own origin.", "en"],
    ["# 发布说明\n\n这个版本的字体从 Artifact 自己的源加载，不再依赖系统字体。", "zh-CN"],
    ["# 發佈說明\n\n這個版本的字體從 Artifact 自己的來源載入，不再依賴系統字體。", "zh-TW"],
    ["# リリースノート\n\nこのバージョンでは、フォントを Artifact 自身のオリジンから読み込みます。", "ja"],
    ["# 릴리스 노트\n\n이 버전에서는 글꼴을 Artifact 자체 출처에서 불러옵니다.", "ko"],
    // A Japanese text's kanji don't make it Chinese.
    ["# 設定\n\n設定画面で言語を選択してください。", "ja"],
    // A few CJK words in an English page leave it English.
    ["# Glossary\n\nThe word for document is 文档, and the word for font is 字体. Everything else here is written in English, at some length.", "en"],
    // Code, tags and link targets aren't the page's language.
    ["# 部署说明\n\n运行下面的命令：\n\n```bash\npnpm install --frozen-lockfile && pnpm run build && wrangler deploy --dry-run --outdir dist\n```\n\n参见 [文档](https://example.com/a/very/long/english/path/to/the/docs) 和 `some-long-english-identifier`。<span class=\"english-class-name\">完成</span>", "zh-CN"],
    // Simplified with a Traditional character or two stays Simplified.
    ["# 说明\n\n这个文档说明了如何配置，個别内容来自旧版。", "zh-CN"],
  ];
  for (const [markdown, lang] of cases) {
    assert.equal(pageLangOf(markdown), lang, markdown);
    assert.ok(renderMarkdownToHtml(markdown, "Doc").includes(`<html lang="${lang}">`), lang);
  }
});
