import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const strykerBackupSrc = () => {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
};
const readSource = (path: string) => {
  const backupSrc = strykerBackupSrc();
  const sourcePath = backupSrc && path.startsWith("src/") ? resolve(backupSrc, path.slice("src/".length)) : resolve(repoRoot, path);
  return readFileSync(sourcePath, "utf8");
};

test("ThreadPanel parent share enters thread-scoped select mode and can export the parent row", () => {
  const threadPanel = readSource("src/components/message/ThreadPanel.tsx");
  const shareHandlers = readSource("src/components/message/useSelectionShareHandlers.ts");

  assert.match(threadPanel, /const displayedParentMessageWithThreadId = useMemo<Message \| null>/);
  assert.match(threadPanel, /return \{ \.\.\.displayedParentMessage, threadId: threadChannelId \};/);
  assert.match(threadPanel, /const threadParentMessageRef = useRef<Message \| null>\(null\);/);
  assert.match(threadPanel, /useSelectionShareHandlers\(\{[\s\S]*threadReplyMessages: messages,[\s\S]*threadParentMessageRef,[\s\S]*onUnresolvedSelection: showUnresolvedSelectionToast,[\s\S]*\}\)/);
  assert.match(threadPanel, /threadParentMessageRef\.current = displayedParentMessageWithThreadId;/);
  assert.doesNotMatch(threadPanel, /message=\{displayedParentMessage\}/);

  assert.match(shareHandlers, /threadParentMessageRef\?: RefObject<Message \| null>;/);
  assert.match(shareHandlers, /opts\?\.threadParentMessageRef\?\.current/);
  assert.match(shareHandlers, /seen\.set\(threadParentMessage\.id, threadParentMessage\)/);
});

test("Share preview lightbox owns image artifact actions and platform targets", () => {
  const toolbar = readSource("src/components/message/SelectModeToolbar.tsx");
  const lightbox = readSource("src/components/message/SelectShareLightbox.tsx");
  const shareHandlers = readSource("src/components/message/useSelectionShareHandlers.ts");
  const selectMarkdown = readSource("src/utils/selectMarkdown.ts");
  const selectScreenshot = readSource("src/utils/selectScreenshot.ts");
  const chatPanel = readSource("src/components/message/ChatPanel.tsx");
  const threadPanel = readSource("src/components/message/ThreadPanel.tsx");
  const toolbarSelectedCountIdIdx = toolbar.indexOf("message.selectModeToolbar.selectedCount");
  const toolbarRenderingIdIdx = toolbar.indexOf("message.selectModeToolbar.rendering");
  const toolbarGenerateImageIdIdx = toolbar.indexOf("message.selectModeToolbar.generateImage");

  assert.match(toolbar, /data-testid="select-mode-share-open"/);
  assert.match(toolbar, /data-testid="select-mode-more"/);
  assert.match(toolbar, /data-testid="select-mode-more-menu"/);
  assert.ok(toolbarRenderingIdIdx >= 0, "select toolbar rendering label id anchor not found");
  assert.ok(toolbarGenerateImageIdIdx >= 0, "select toolbar generate-image label id anchor not found");
  assert.match(toolbar, /<Image size=\{14\} \/>/);
  assert.match(toolbar, /import Button from "\.\.\/ui\/Button";/);
  assert.match(toolbar, /import MenuItem from "\.\.\/ui\/MenuItem";/);
  assert.match(toolbar, /const toolbarButtonClass = "box-border appearance-none whitespace-nowrap px-1 focus:outline-none focus-visible:outline-none";/);
  assert.match(toolbar, /const toolbarIconButtonClass = `\$\{toolbarButtonClass\} min-w-7 gap-0 sm:min-w-0`;/);
  assert.match(toolbar, /const compactForward = compactLevel >= 1 \+ \(onCopyLinks \? 1 : 0\);/);
  assert.match(toolbar, /shape=\{compactForward \? "icon" : "iconText"\}/);
  assert.ok(toolbarSelectedCountIdIdx >= 0, "select toolbar selected-count label id anchor not found");
  assert.match(toolbar, /<Button[\s\S]*data-testid="select-mode-select-all"/);
  assert.match(toolbar, /<Button[\s\S]*data-testid="select-mode-cancel"/);
  assert.match(toolbar, /<Button[\s\S]*data-testid="select-mode-forward"/);
  assert.match(toolbar, /<Button[\s\S]*data-testid="select-mode-copy-link"/);
  assert.match(toolbar, /<MenuItem[\s\S]*data-testid="select-mode-share-open"/);
  assert.match(toolbar, /<MenuItem[\s\S]*data-testid="select-mode-copy-md"/);
  assert.match(toolbar, /tone="pink"[\s\S]*data-testid="select-mode-forward"[\s\S]*\{!compactForward && <span>\{forwardLabel\}<\/span>\}/);
  assert.doesNotMatch(toolbar, /data-testid="select-mode-forward-as-one"/);
  assert.doesNotMatch(toolbar, /text-\[11px\]/);
  assert.doesNotMatch(toolbar, /h-10 min-h-10/);
  assert.doesNotMatch(toolbar, /data-testid="select-mode-share-x"/);
  assert.doesNotMatch(toolbar, /data-testid="select-mode-save-pic"/);
  assert.doesNotMatch(toolbar, /Share to X/);
  assert.doesNotMatch(toolbar, /Download as Image/);
  assert.doesNotMatch(toolbar, /VITE_ENABLE_SHARE_TO_X/);

  assert.match(lightbox, /message\.selectShare\.title/);
  assert.doesNotMatch(lightbox, /"Share preview"/);
  assert.doesNotMatch(lightbox, /SegmentedControl/);
  assert.doesNotMatch(lightbox, /ariaLabel="Share image width"/);
  assert.doesNotMatch(lightbox, /select-share-lightbox-width-/);
  assert.doesNotMatch(lightbox, /onWidthPresetChange/);
  assert.match(lightbox, /data-testid="select-share-lightbox-download"/);
  assert.match(lightbox, /data-testid="select-share-lightbox-copy-image"/);
  assert.match(lightbox, /copyPngDataUrlToClipboard\(dataUrl\)/);
  assert.match(lightbox, /resolvePngClipboardCapability\(\)/);
  assert.match(lightbox, /\{canCopyImage && \(/);
  assert.match(lightbox, /message\.selectShare\.copied/);
  assert.match(lightbox, /message\.selectShare\.copyImage/);
  assert.match(lightbox, /message\.selectShare\.saveImage/);
  assert.match(lightbox, /common\.lightbox\.download/);
  assert.match(lightbox, /import \{ Button \} from "raft-ui";/);
  assert.doesNotMatch(lightbox, /from "\.\.\/ui\/Button"/);
  assert.match(lightbox, /<Button[\s\S]*size="sm"[\s\S]*variant="default"[\s\S]*data-testid="select-share-lightbox-download"/);
  assert.match(lightbox, /canSavePngViaNativeShare\(dataUrl, filename\)/);
  assert.match(lightbox, /nav\.canShare\(\{ files: \[file\] \}\)/);
  assert.match(lightbox, /await nav\.share\?\.\(\{[\s\S]*files: \[file\],[\s\S]*message\.selectShare\.nativeShareTitle/);
  assert.match(lightbox, /if \(err instanceof DOMException && err\.name === "AbortError"\) return;/);
  assert.match(lightbox, /downloadDataUrl\(dataUrl, filename\);/);
  assert.match(lightbox, /flex shrink-0 flex-wrap/);
  assert.match(lightbox, /items-center justify-end/);
  assert.doesNotMatch(lightbox, /const footerButtonClass/);
  assert.doesNotMatch(lightbox, /data-testid="select-share-lightbox-system-share"/);
  assert.doesNotMatch(lightbox, /shareFile/);
  assert.match(lightbox, /data-testid="select-share-lightbox-share-x"/);
  assert.match(lightbox, /<Button[\s\S]*size="sm"[\s\S]*variant="accent"[\s\S]*data-testid="select-share-lightbox-share-x"/);
  assert.match(lightbox, /onShareToX\(dataUrl\)/);
  assert.match(lightbox, /message\.selectShare\.sharing/);
  assert.match(lightbox, /message\.selectShare\.shareToX/);
  assert.doesNotMatch(lightbox, /data-testid="select-share-lightbox-cancel"/);
  assert.doesNotMatch(lightbox, /data-testid="select-share-lightbox-save"/);
  assert.doesNotMatch(lightbox, /Share to Facebook/);

  assert.match(chatPanel, /onShareToX=\{onSharePreviewToX\}/);
  assert.doesNotMatch(chatPanel, /widthPreset=/);
  assert.doesNotMatch(chatPanel, /onWidthPresetChange=/);
  assert.match(threadPanel, /onShareToX=\{onSharePreviewToX\}/);
  assert.match(threadPanel, /filename=\{`raft-thread-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.png`\}/);
  assert.doesNotMatch(threadPanel, /widthPreset=/);
  assert.doesNotMatch(threadPanel, /onWidthPresetChange=/);

  // Platform targets live in the preview lightbox. The preserved toolbar
  // handler remains wired but invisible so phase 3 does not reintroduce a
  // platform button before the user reviews the rendered artifact.
  assert.match(shareHandlers, /onSharePreviewToX: \(dataUrl: string\) => Promise<void>;/);
  assert.doesNotMatch(shareHandlers, /sharePreviewWidth/);
  assert.doesNotMatch(shareHandlers, /onSharePreviewWidthChange/);
  assert.match(shareHandlers, /maxWidth: SHARE_PREVIEW_MAX_WIDTH/);
  assert.match(shareHandlers, /const createShareArtifactAndNavigateToX = useCallback\(async \(dataUrl: string\) => \{/);
  assert.match(shareHandlers, /const onSharePreviewToX = useCallback\(async \(dataUrl: string\) => \{/);
  assert.match(shareHandlers, /const dataUrl = await captureSharePreview\(\);/);
  assert.match(shareHandlers, /const file = await dataUrlToPngFile\(dataUrl, "raft-thread\.png"\);/);
  assert.match(shareHandlers, /const artifact = await createSelectedMessagesShareArtifact\(file, selectionChannelId\);/);
  assert.match(shareHandlers, /navigateShareArtifactToX\(artifact\.url, formatMessage\);/);
  assert.doesNotMatch(shareHandlers, /Share page created, but the browser blocked the X popup/);
  assert.doesNotMatch(shareHandlers, /window\.open/);
  assert.doesNotMatch(shareHandlers, /canSharePngFile/);
  assert.doesNotMatch(shareHandlers, /sharePngFileToNativeSheet/);
  assert.doesNotMatch(shareHandlers, /openShareToXIntent\(\);/);

  assert.match(selectMarkdown, /export async function dataUrlToPngFile/);
  assert.match(selectScreenshot, /export const SHARE_PREVIEW_MAX_WIDTH = 768;/);
  assert.match(selectMarkdown, /api\.post<ShareArtifactResponse>\("\/share-artifacts\/message-selection", form\)/);
  assert.match(selectMarkdown, /export function buildShareArtifactXIntentUrl/);
  assert.match(selectMarkdown, /twitter\.com\/intent\/tweet\?url=\$\{encodeURIComponent\(shareUrl\)\}/);
  assert.match(selectMarkdown, /message\.share\.viaRaft/);
  assert.doesNotMatch(selectMarkdown, /via slock\.ai/);
  assert.match(selectMarkdown, /function shouldOpenXIntentInNewTab/);
  assert.match(selectMarkdown, /window\.innerWidth < 768/);
  assert.match(selectMarkdown, /function openXIntentInNewTab\(intent: string\): boolean/);
  assert.match(selectMarkdown, /window\.open\(intent, "_blank"\)/);
  assert.match(selectMarkdown, /opened\.opener = null;/);
  assert.match(selectMarkdown, /if \(openXIntentInNewTab\(intent\)\) return;/);
  assert.doesNotMatch(selectMarkdown, /window\.open\(intent, "_blank", "noopener,noreferrer"\)/);
  assert.match(selectMarkdown, /window\.location\.assign\(intent\)/);
  assert.doesNotMatch(selectMarkdown, /canSharePngFile/);
  assert.doesNotMatch(selectMarkdown, /sharePngFileToNativeSheet/);
  assert.doesNotMatch(selectMarkdown, /navigator\.share/);
  assert.doesNotMatch(selectMarkdown, /navigator\.canShare/);
  assert.doesNotMatch(selectMarkdown, /openShareToXIntent/);
});
