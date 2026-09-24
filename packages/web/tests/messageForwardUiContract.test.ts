import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("forward entrypoints remain fail-closed behind the server feature gate", () => {
  const toolbar = read("src/components/message/SelectModeToolbar.tsx");
  const chatPanel = read("src/components/message/ChatPanel.tsx");
  const threadPanel = read("src/components/message/ThreadPanel.tsx");
  const messageItem = read("src/components/message/MessageItem.tsx");
  const forwardSelection = read("src/components/message/forwardSelectionUtils.ts");
  if ([toolbar, chatPanel, threadPanel, messageItem, forwardSelection].some((source) => source.includes("__stryker__"))) return;

  const gateCallStart = chatPanel.indexOf("/messages/forward/enabled");
  const gateCall = chatPanel.slice(Math.max(0, gateCallStart - 180), gateCallStart + 850);
  const gateCatchStart = chatPanel.indexOf(".catch", gateCallStart);
  const gateCatch = chatPanel.slice(gateCatchStart, gateCatchStart + 350);

  assert.match(toolbar, /data-testid="select-mode-forward"/);
  assert.match(toolbar, /data-testid="select-mode-copy-link"/);
  assert.match(chatPanel, /useState\(false\)/);
  assert.match(gateCall, /api\.get/);
  assert.match(gateCall, /setServerMessageForwardingEnabled/);
  assert.match(gateCall, /res\.data\.enabled/);
  assert.match(gateCatch, /\.catch/);
  assert.match(chatPanel, /messageForwardingEnabled/);
  assert.match(chatPanel, /onForward=\{showForwardAction \? openForwardComposer : undefined\}/);
  assert.match(threadPanel, /onForward=\{showForwardAction \? openForwardComposer : undefined\}/);
  assert.match(threadPanel, /canForwardFromSource\(parentChannel\)/);
  assert.match(forwardSelection, /meta\?\.kind === "forwarded-bundle"/);
  assert.match(forwardSelection, /nestedForwardCount \+= 1/);
  assert.doesNotMatch(messageItem, />\s*Forward\s*</);
});

test("multi-target composer is split into bounded modules and preserves batch semantics", () => {
  const dialog = read("src/components/message/ForwardComposerDialog.tsx");
  const model = read("src/components/message/forwardComposerModel.tsx");
  const targets = read("src/components/message/ForwardComposerTargetList.tsx");
  const mobile = read("src/components/message/ForwardComposerMobile.tsx");
  const desktop = read("src/components/message/ForwardComposerDesktop.tsx");
  const warnings = read("src/components/message/ForwardComposerWarnings.tsx");
  const composer = [dialog, model, targets, mobile, desktop, warnings].join("\n");
  if (composer.includes("__stryker__")) return;

  assert.ok(dialog.split("\n").length < 650, "orchestrator must stay below 650 lines");
  assert.match(dialog, /ForwardComposerTargetList/);
  assert.match(dialog, /ForwardComposerMobile/);
  assert.match(dialog, /ForwardComposerDesktop/);
  assert.match(dialog, /ForwardComposerWarnings/);
  assert.match(model, /MAX_FORWARD_DESTINATIONS = 10/);
  assert.match(model, /export function canForwardToTarget/);
  assert.match(model, /if \(channel\.archivedAt \|\| channel\.type === "thread"\) return false/);
  assert.match(model, /export function getForwardTargets/);
  assert.match(model, /useForwardSearch/);
  assert.match(dialog, /api\.post<ForwardBatchResponse>\("\/messages\/forward"/);
  assert.match(dialog, /destinationChannelIds: \[\.\.\.entriesByChannelId\.keys\(\)\]/);
  assert.match(dialog, /requestId: forwardRequestIdRef\.current/);
  assert.match(dialog, /sourceMessageIds: orderedSourceMessages\.map/);
  assert.match(dialog, /note: note\.trim\(\)/);
  assert.match(dialog, /id: attachment\.id/);
  assert.match(dialog, /width: attachment\.width/);
  assert.match(dialog, /height: attachment\.height/);
  assert.match(dialog, /attachmentPolicy: "projected"/);
  assert.match(dialog, /useImageLightboxStore\.getState\(\)\.open\(\[attachment\], 0\)/);
  // The download itself moved into the shared helper so the app-level preview
  // host and the composer share one implementation; assert the composer routes
  // to it, and that the helper is the thing hitting the disposition endpoint.
  assert.match(dialog, /downloadAttachmentById\(attachment\)/);
  assert.match(
    read("src/components/message/downloadAttachment.ts"),
    /\/attachments\/\$\{attachment\.id\}\/url\?disposition=attachment/,
  );
  assert.match(mobile, /window\.visualViewport/);
  assert.match(mobile, /window\.innerHeight - viewport\.height > 100/);
  assert.match(mobile, /top: `\$\{Math\.max\(viewport\.offsetTop, 0\)\}px`/);
  assert.match(mobile, /height: `\$\{viewport\.height\}px`/);
  assert.match(mobile, /data-testid="forward-mobile-note-layout"/);
  assert.match(mobile, /data-testid="forward-mobile-note-scroll"/);
  assert.match(mobile, /data-testid="forward-mobile-preview-actions"/);
  assert.match(mobile, /className="shrink-0 border-t-2/);
  assert.match(mobile, /onOpenAttachment=\{onOpenAttachment\}/);
  assert.match(desktop, /<MessageInput/);
  assert.match(mobile, /<MessageInput/);
  assert.match(desktop, /variant="compact"/);
  assert.match(mobile, /variant="compact"/);
  assert.match(desktop, /allowEmptySubmit/);
  assert.match(mobile, /allowEmptySubmit/);
  assert.match(desktop, /loadMentionMembers=\{Boolean\(noteMentionChannelId\)\}/);
  assert.match(mobile, /loadMentionMembers=\{Boolean\(noteMentionChannelId\)\}/);
  assert.match(desktop, /submitTitleOverride=\{sendLabel\}/);
  assert.match(mobile, /submitTitleOverride=\{sendLabel\}/);
  assert.doesNotMatch(desktop, /<Textarea/);
  assert.doesNotMatch(mobile, /<Textarea/);
  // Note: this assertion previously pinned the exact prop list, which locked in
  // the missing onOpenAttachment. Match the props individually so the shape can
  // gain a required prop without the contract test defending the old defect.
  const desktopSource = read("src/components/message/ForwardComposerDesktop.tsx");
  assert.match(desktopSource, /<ForwardedBundleCard[^>]*metadata=\{previewMetadata\}/);
  assert.match(desktopSource, /<ForwardedBundleCard[^>]*fullWidth/);
  assert.match(read("src/components/message/ForwardComposerMobile.tsx"), /ForwardedBundleCard metadata=\{previewMetadata\}[\s\S]*fullWidth/);
  assert.match(dialog, /Promise\.allSettled/);
  assert.match(dialog, /settledSuccessChannelIdsRef/);
  assert.match(composer, /message\.forwardComposer\.nestedForwardBlocked/);
  assert.match(composer, /message\.forwardComposer\.jointWarning/);
  assert.doesNotMatch(composer, /author consent|author-consent|notify original author/i);
});

test("forwarded bundle projection is display-safe and keeps attachment authority opaque", () => {
  const card = read("src/components/message/ForwardedBundleCard.tsx");
  const item = read("src/components/message/MessageItem.tsx");

  assert.match(card, /kind: "forwarded-bundle"/);
  assert.match(card, /sourceAuthorSnapshot/);
  assert.match(card, /sourceTargetSnapshot/);
  assert.match(card, /attachmentSnapshots/);
  assert.match(card, /attachmentPolicy === "projected"/);
  // Same move: the forward card's image tiles share the inline-URL cache
  // instead of each tile fetching its own signed URL.
  assert.match(card, /fetchInlineAttachmentUrls\(ids\)/);
  assert.match(card, /function forwardedTimestamp/);
  assert.match(card, /function sourceLabel/);
  assert.match(card, /target\.type === "thread"/);
  assert.match(card, /target\.label\.endsWith\(" · thread"\)/);
  assert.match(card, /message\.forwardedBundle\.fromThread/);
  assert.match(card, /message\.forwardedBundle\.fromSource/);
  assert.match(card, /return null/);
  assert.match(card, /sourceThreadId/);
  assert.match(card, /parentChannelId/);
  assert.doesNotMatch(card, /View original/);
  assert.doesNotMatch(card, /onOpenOriginal/);
  assert.match(card, /onOpenSource\?: \(item: ForwardedBundleItem\) => void/);
  assert.match(card, /function canOpenSourceLabel/);
  assert.match(card, /target\.type === "dm"/);
  assert.match(card, /target\.labelVisibility !== "public"/);
  assert.match(card, /message\.forward\.openSource/);
  assert.match(card, /sourceClickable =\s*!!label && !!onOpenSource && canOpenSourceLabel\(firstItem\)/);
  assert.match(card, /\) : label \? \(/);
  // Tailwind class strings are not behaviour: pinning them makes styling edits
  // fail as if they were regressions, and one such pin was actively defending
  // the forward card's divergent file chip. What matters is that the card uses
  // the SHARED attachment chip, so the two surfaces cannot drift again.
  assert.match(card, /<AttachmentChip/);
  assert.match(card, /data-testid="forwarded-bundle-source-label"/);
  assert.match(card, /data-testid="forwarded-bundle-toggle"/);
  assert.match(card, /message\.forwardedBundle\.viewAll/);
  assert.match(card, /message\.forwardedBundle\.collapse/);
  assert.match(card, /<MarkdownContent source=\{content\} density="compact" enableMermaid \/>/);
  assert.match(card, /max-h-\[144px\] overflow-clip/);
  assert.match(card, /data-testid="forwarded-bundle-toggle"/);
  assert.doesNotMatch(card, /storageKey|presigned|authorization/i);
  assert.match(item, /isForwardedBundleMetadata\(actionMetadata\)/);
  assert.match(item, /handleOpenForwardedSource/);
  assert.match(item, /<ForwardedBundleRouteCard/);
  assert.match(item, /metadata=\{forwardedBundleMetadata\}/);
});

// The forward preview's "open attachment" callback must be wired on BOTH the
// desktop and mobile composers. It was previously wired on mobile only, and the
// real-device acceptance also ran on mobile, so the desktop half stayed broken
// while every check that looked at it was green. Asserting both halves is what
// stops a one-sided fix from passing a one-sided review again.
test("forward composer wires onOpenAttachment on both desktop and mobile", () => {
  const dialog = read("src/components/message/ForwardComposerDialog.tsx");
  const desktop = read("src/components/message/ForwardComposerDesktop.tsx");
  const mobile = read("src/components/message/ForwardComposerMobile.tsx");

  // The dialog must hand the same handler to whichever composer it renders.
  assert.match(dialog, /<ForwardComposerMobile[\s\S]*?onOpenAttachment=\{openComposerAttachment\}/);
  assert.match(dialog, /<ForwardComposerDesktop[\s\S]*?onOpenAttachment=\{openComposerAttachment\}/);

  // Each composer must accept it and pass it down to the bundle card, or the
  // card renders no overlay button at all and the tiles become unclickable.
  for (const [name, source] of [["desktop", desktop], ["mobile", mobile]] as const) {
    assert.match(source, /onOpenAttachment: \(attachment: ForwardedBundleAttachmentSnapshot\) => void/, `${name} must declare the prop`);
    assert.match(source, /<ForwardedBundleCard[^>]*onOpenAttachment=\{onOpenAttachment\}/, `${name} must forward it to ForwardedBundleCard`);
  }
});
