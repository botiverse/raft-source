import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("download-as-image uses protected attachment bytes for message images", () => {
  // MessageItem rendering the data-select-screenshot-attachment-* dataset is
  // asserted against DOM in tests/messageScreenshotAttributes.behavior.test.tsx
  // (artin 铁律1; MessageItem.tsx is instrumented by the mutation-diff gate, so
  // scanning its source crashes the Stryker dry-run). Here we only pin the
  // consumer side in the NON-instrumented selectScreenshot.ts.
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /img\.dataset\.selectScreenshotAttachmentId/);
  assert.match(screenshot, /\/attachments\/\$\{encodeURIComponent\(attachmentId\)\}\?disposition=inline&selectScreenshot=1/);
  assert.match(screenshot, /img\.dataset\.selectScreenshotAttachmentWidth/);
  assert.match(screenshot, /img\.dataset\.selectScreenshotAttachmentHeight/);
  assert.match(screenshot, /headers: getAuthHeaders\(\)/);
  assert.match(screenshot, /const liveHeight = container\.offsetHeight;/);

  const inlineBeforeHeight = screenshot.indexOf("await Promise.all(imgs.map((img) => inlineImageForScreenshot(img)));");
  const heightAfterInline = screenshot.indexOf("const liveHeight = container.offsetHeight;");
  assert.ok(inlineBeforeHeight >= 0, "image inlining must be explicit");
  assert.ok(heightAfterInline > inlineBeforeHeight, "export height must be measured after images are inlined/decoded");
});

test("download-as-image strips reaction picker affordance but preserves reaction chips", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");
  // Task #44 extracted the hover toolbar (the strippable reaction button lives
  // there now) into MessageHoverToolbar (NON-instrumented, safe to scan).
  const hoverToolbar = readFileSync(resolve(repoRoot, "src/components/message/MessageHoverToolbar.tsx"), "utf8");

  // Screenshot strips every [data-message-affordance] control before rasterizing.
  assert.match(screenshot, /\[data-message-affordance\]/);
  // The hover reaction affordance the screenshot strips is now in the toolbar.
  assert.match(hoverToolbar, /data-message-affordance="reaction"/);
  // That the persisted reaction chips render WITHOUT a data-message-affordance
  // ancestor (so they survive stripping) while the mobile add button IS tagged
  // (so it is stripped) is asserted against DOM in
  // tests/messageScreenshotAttributes.behavior.test.tsx (artin 铁律1;
  // MessageItem.tsx is instrumented by the mutation-diff gate).
});

test("download-as-image expands cloned long messages before rasterizing", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /function expandClonedMessageContentForScreenshot/);
  assert.match(screenshot, /data-message-collapsible-content/);
  assert.match(screenshot, /content\.dataset\.messageCollapsed = "false"/);
  assert.match(screenshot, /content\.style\.removeProperty\("max-height"\)/);
  assert.match(screenshot, /data-message-content-toggle/);
  assert.match(screenshot, /data-message-collapse-fade/);

  const cloneIndex = screenshot.indexOf("const clone = node.cloneNode(true) as HTMLElement;");
  const expandIndex = screenshot.indexOf("expandClonedMessageContentForScreenshot(clone);");
  const appendIndex = screenshot.indexOf("contentArea.appendChild(clone);");
  assert.ok(cloneIndex >= 0, "message rows must be cloned before export normalization");
  assert.ok(expandIndex > cloneIndex, "the cloned row must be expanded after cloning");
  assert.ok(appendIndex > expandIndex, "the expanded clone must enter the rasterized content tree");
});

test("download-as-image freezes thread reply chip box from the live message", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /FREEZE_RENDERED_BOX_SELECTORS/);
  assert.match(screenshot, /data-testid="message-thread-replies-badge"/);
  assert.match(screenshot, /function freezeCloneRenderedBoxes/);
  assert.match(screenshot, /sourceEl\.getBoundingClientRect\(\)/);
  assert.match(screenshot, /cloneEl\.style\.width = width/);
  assert.match(screenshot, /cloneEl\.style\.minWidth = width/);
  assert.match(screenshot, /cloneEl\.style\.maxWidth = width/);
  assert.match(screenshot, /freezeCloneRenderedBoxes\(node, clone\)/);
});

test("download-as-image uses a tablet-width cap without lowering pixel ratio", () => {
  // Anchor the share-screenshot container width to the live row's own
  // rendered box, then allow callers to cap it to a target reading width.
  // Measuring
  // `parentElement` (the chat column) lets the container become wider than
  // where the row actually sits, and html-to-image's <foreignObject> re-lays
  // out inline-block children like `<MSG_REF_CHIP>` (`#proj-growth`) →
  // overflow. Letting a wide desktop row through uncapped makes single-message
  // shares look flat once scaled into the preview lightbox.
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /export const SHARE_PREVIEW_MAX_WIDTH = 768;/);
  assert.match(screenshot, /maxWidth\?: number;/);
  assert.match(screenshot, /const rowWidth = nodes\[0\]\?\.getBoundingClientRect\(\)\.width \?\? SHARE_PREVIEW_MAX_WIDTH;/);
  assert.match(screenshot, /const liveWidth = typeof maxWidth === "number"[\s\S]*Math\.min\(rowWidth, maxWidth\)[\s\S]*: rowWidth;/);
  assert.match(screenshot, /pixelRatio: resolveCapturePixelRatio\(options\.pixelRatio\)/);
  // Negative: must not regress to parentElement-based measurement.
  assert.doesNotMatch(
    screenshot,
    /const liveWidth =\s*nodes\[0\]\?\.parentElement\?\.getBoundingClientRect\(\)\.width/,
  );
});

test("download-as-image uses Raft share screenshot branding", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /lockupIcon\.src = "\/brand\/raft-logo\.svg";/);
  assert.match(screenshot, /headerBar\.style\.padding = "8px 16px 8px 24px";/);
  assert.match(screenshot, /lockupIcon\.style\.height = "22\.68px";/);
  assert.match(screenshot, /domain\.textContent = "raft\.build";/);
  assert.doesNotMatch(screenshot, /lockupIcon\.src = "\/brand\/raft-icon.svg";/);
  assert.doesNotMatch(screenshot, /domain\.textContent = "slock\.ai";/);
});

test("download-as-image freezes markdown text metrics before rasterizing", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /function freezeTextLineBoxesForScreenshot/);
  assert.match(screenshot, /\[data-message-selectable\] p/);
  assert.match(screenshot, /\[data-message-selectable\] li/);
  assert.match(screenshot, /\[data-message-selectable\] code/);
  assert.match(screenshot, /window\.getComputedStyle\(node\)/);
  assert.match(screenshot, /node\.style\.fontSize = fontSize/);
  assert.match(screenshot, /node\.style\.lineHeight = lineHeight/);

  const fontsReadyIndex = screenshot.indexOf("await waitForDocumentFontsForScreenshot();");
  const freezeIndex = screenshot.indexOf("freezeTextLineBoxesForScreenshot(container);");
  const rasterizeIndex = screenshot.indexOf("return await toPng(container");
  assert.ok(fontsReadyIndex >= 0, "font readiness wait should be explicit");
  assert.ok(freezeIndex > fontsReadyIndex, "line boxes must be frozen after fonts are ready");
  assert.ok(rasterizeIndex > freezeIndex, "line boxes must be frozen before html-to-image rasterizes");
  assert.match(screenshot, /skipFonts: true/);
});

test("download-as-image constrains wide markdown content before rasterizing", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /const WIDE_CONTENT_SELECTORS = \[/);
  assert.match(screenshot, /\[data-message-selectable\] pre/);
  assert.match(screenshot, /\[data-message-selectable\] table/);
  assert.match(screenshot, /\[data-message-selectable\] a/);
  assert.match(screenshot, /function constrainWideContentForScreenshot/);
  assert.match(screenshot, /node\.style\.maxWidth = "100%"/);
  assert.match(screenshot, /node\.style\.overflowWrap = "anywhere"/);
  assert.match(screenshot, /node\.style\.whiteSpace = "pre-wrap"/);
  assert.match(screenshot, /tableWrapper\.style\.overflowX = "hidden"/);
  assert.match(screenshot, /node\.style\.whiteSpace = "normal"/);
  assert.match(screenshot, /node\.style\.wordBreak = "break-word"/);
  assert.match(screenshot, /node\.style\.tableLayout = "fixed"/);

  const constrainIndex = screenshot.indexOf("constrainWideContentForScreenshot(container);");
  const freezeIndex = screenshot.indexOf("freezeTextLineBoxesForScreenshot(container);");
  const rasterizeIndex = screenshot.indexOf("return await toPng(container");
  assert.ok(constrainIndex >= 0, "wide content constraint must be explicit");
  assert.ok(freezeIndex > constrainIndex, "wide content should be constrained before text metrics are frozen");
  assert.ok(rasterizeIndex > constrainIndex, "wide content must be constrained before rasterization");
});

test("download-as-image bounds broken attachment image fetches before placeholder fallback", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /const IMAGE_INLINE_TIMEOUT_MS = 1_000;/);
  assert.match(screenshot, /class SelectScreenshotImageInlineTimeoutError extends Error/);
  assert.match(screenshot, /function fetchImageForScreenshot/);
  assert.match(screenshot, /new AbortController\(\)/);
  assert.match(screenshot, /controller\.abort\(\)/);
  assert.match(screenshot, /fetch\(url, \{\s*\.\.\.init,\s*signal: controller\.signal,\s*\}\)/);
  assert.match(screenshot, /const response = await fetchImageForScreenshot\(target\.url, target\.init\);/);

  const timeoutIndex = screenshot.indexOf("fetchImageForScreenshot(target.url, target.init)");
  const placeholderIndex = screenshot.indexOf("img.src = TRANSPARENT_GIF;");
  assert.ok(timeoutIndex >= 0, "image inlining should use the bounded fetch helper");
  assert.ok(placeholderIndex > timeoutIndex, "timed-out image fetches should fall back to the placeholder path");
});

test("download-as-image materializes pixel avatars before rasterization", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /function inlinePixelAvatarsForScreenshot/);
  assert.match(screenshot, /\[data-agent-pixel-avatar\]/);
  assert.match(screenshot, /data:image\/svg\+xml;charset=utf-8/);
  assert.match(screenshot, /shape-rendering="crispEdges"/);
  assert.match(screenshot, /img\.style\.imageRendering = "pixelated"/);

  const pixelInlineIndex = screenshot.indexOf("inlinePixelAvatarsForScreenshot(container);");
  const imageQueryIndex = screenshot.indexOf('container.querySelectorAll("img")');
  const rasterizeIndex = screenshot.indexOf("return await toPng(container");
  assert.ok(pixelInlineIndex >= 0, "pixel avatar inlining should be explicit");
  assert.ok(imageQueryIndex > pixelInlineIndex, "pixel avatars should become data-url images before generic image inlining");
  assert.ok(rasterizeIndex > pixelInlineIndex, "pixel avatars must be inlined before html-to-image rasterizes");
});

test("download-as-image uses a public no-auth fetch for uploaded avatar URLs", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /function getPublicAvatarFetchInit\(\): RequestInit/);
  assert.match(screenshot, /cache: "no-cache",\s*mode: "cors",\s*credentials: "omit"/);
  assert.match(screenshot, /init: getPublicAvatarFetchInit\(\)/);
  assert.match(screenshot, /preserveOriginalOnFailure: true/);
  assert.match(screenshot, /function canRasterizeOriginalImage/);
  assert.match(screenshot, /origin === window\.location\.origin/);
  assert.match(screenshot, /target\.preserveOriginalOnFailure && canRasterizeOriginalImage\(originalSrc\)/);
});

test("download-as-image degrades failed avatar images to visible default avatars", () => {
  const screenshot = readFileSync(resolve(repoRoot, "src/utils/selectScreenshot.ts"), "utf8");

  assert.match(screenshot, /DEFAULT_HUMAN_AVATAR_SVG/);
  assert.match(screenshot, /DEFAULT_AGENT_AVATAR_DATA_URL/);
  assert.match(screenshot, /getDefaultAvatarDataUrl\(kind\)/);
  assert.match(screenshot, /img\.hidden = false/);
  assert.match(screenshot, /img\.style\.opacity = "1"/);
  assert.match(screenshot, /if \(target\.avatarFallbackKind\) \{[\s\S]*inlineDefaultAvatarForScreenshot\(img\);[\s\S]*\} else \{[\s\S]*img\.src = TRANSPARENT_GIF;/);

  // Attachment failures retain the transparent placeholder path; only the
  // avatar-marked image branch receives the visible human/agent fallback.
  assert.match(screenshot, /const avatarFallbackKind = img\.closest<HTMLElement>\("\[data-avatar-kind\]"\)\?\.dataset\.avatarKind;/);
  assert.match(screenshot, /avatarFallbackKind\?: string;/);
  assert.match(screenshot, /preserveOriginalOnFailure: Boolean\(avatarFallbackKind\)/);
});
