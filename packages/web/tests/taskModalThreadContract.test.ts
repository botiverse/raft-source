import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const strykerBackupRoot = () => {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup) : null;
};

function readSource(path: string): string {
  const backupPath = resolve(strykerBackupRoot() ?? repoRoot, path);
  return readFileSync(backupPath, "utf8");
}

test("tasks route opens task threads in a centered modal instead of the side panel", () => {
  const layoutSource = readSource("src/components/layout/MainLayout.tsx");
  const threadSource = readSource("src/components/message/ThreadPanel.tsx");

  assert.match(layoutSource, /import Modal from "\.\.\/Modal";/);
  assert.match(layoutSource, /const isTasksRoute = \/\\\/tasks\\\/\?\$\/\.test\(location\.pathname\);/);
  // The INVARIANT is unchanged: a task's thread opens as a centered modal with a
  // backdrop. Only its PREDICATE broadened — it used to be `isTasksRoute`, which
  // was a proxy for "this is a task" and meant the same task opened centered
  // from the Tasks page and as a side panel from its own channel. One object
  // must not get two containers based on where you clicked (@stdrc).
  assert.match(layoutSource, /const renderTaskThreadPanel = \(\) => \{[\s\S]*<Modal onClose=\{closeThread\} closeOnBackdrop>[\s\S]*<ThreadPanelWrapper presentation="modal" \/>/);
  assert.match(layoutSource, /threadIsTop && \(isTasksRoute \|\| openedAsTask\)[\s\S]*return renderTaskThreadPanel\(\);/);
  // Teeth for the broadening itself: the route must no longer be the sole gate.
  // Teeth for the broadening: the surface follows the caller's declared INTENT.
  // Inferring "is the parent a task" conflated two actions on one message — the
  // thread icon (replies, side panel) and the badge (open the task, modal) —
  // so the thread icon started opening a modal. @stdrc msg=ef2492f5.
  assert.match(layoutSource, /const openedAsTask = useThreadStore\(\(s\) => s\.openIntent === "task"\)/);
  assert.doesNotMatch(layoutSource, /threadParentIsTask/);
  const messageItemSource = readSource("src/components/message/MessageItem.tsx");
  assert.match(messageItemSource, /openThread\(\{[\s\S]*?intent: "task",[\s\S]*?\}\)/,
    "only the task badge may declare the task intent");
  assert.match(messageItemSource, /api\.get\(`\/tasks\/channel\/\$\{taskContextChannelId\}\/number\/\$\{taskNumber\}`\)[\s\S]*?openThread\(\{ parentChannelId: task\.channelId, parentMessageId: task\.messageId, intent: "task" \}\)/,
    "inline task references must declare task intent after resolving their host task");
  assert.match(threadSource, /presentation = "side"/);
  // Column-layout (modal card sizing + task-thread-modal testid for
  // detail-panel-layout / focus contracts) lives on the ThreadPanelWrapper
  // in MainLayout, not on ThreadPanel — page-object stays column-agnostic per
  // stdrc 2026-05-28 #proj-uiux msg=138867ba.
  assert.match(layoutSource, /presentation === "modal"[\s\S]*h-\[min\(86vh,900px\)\][\s\S]*w-\[min\(960px,calc\(100vw-2rem\)\)\][\s\S]*data-testid="task-thread-modal"[\s\S]*<ThreadPanel[\s\S]*presentation="modal"/);
});

test("tasks route opens legacy tasks in the same centered modal pattern", () => {
  const layoutSource = readSource("src/components/layout/MainLayout.tsx");
  const legacyTaskSource = readSource("src/components/task/LegacyTaskPanel.tsx");

  assert.match(layoutSource, /const closeLegacyTask = useLegacyTaskPanelStore\(\(s\) => s\.closeLegacyTask\);/);
  assert.match(layoutSource, /isTasksRoute && legacyTaskOpen[\s\S]*<Modal onClose=\{closeLegacyTask\} closeOnBackdrop>[\s\S]*<LegacyTaskPanelWrapper presentation="modal" \/>/);
  assert.match(legacyTaskSource, /presentation = "side"/);
  assert.match(legacyTaskSource, /presentation === "modal"[\s\S]*h-\[min\(78vh,720px\)\][\s\S]*w-\[min\(760px,calc\(100vw-2rem\)\)\]/);
  assert.match(legacyTaskSource, /const showResizeHandle = presentation === "side";/);
});

// Mobile (no Rail, <md): panel renders directly without a Modal wrapper so
// it behaves like a regular full-screen thread overlay. Per stdrc 2026-05-21
// #proj-task:287f18ce msg=59d4256c — "只要显示 Rail，就应该显示为中间弹窗" —
// the rail-visible threshold is the md breakpoint (matches LeftRail's own
// `hidden md:flex`). At <md the back chevron is the close affordance; at md+
// it's the backdrop click + ESC.
test("tasks route uses rail-visible (md) breakpoint and mobile-modal at <md (no Modal wrap)", () => {
  const layoutSource = readSource("src/components/layout/MainLayout.tsx");
  const legacyTaskSource = readSource("src/components/task/LegacyTaskPanel.tsx");

  // RightPanel tracks the md breakpoint (Rail visible) and only wraps in
  // <Modal> at md+; <md renders the panel directly as mobile-modal.
  assert.match(layoutSource, /matchMedia\("\(min-width: 768px\)"\)/);
  assert.match(layoutSource, /const renderTaskThreadPanel = \(\) => \{[\s\S]*if \(railVisible\)[\s\S]*<Modal onClose=\{closeThread\} closeOnBackdrop>[\s\S]*<ThreadPanelWrapper presentation="modal" \/>[\s\S]*return <ThreadPanelWrapper presentation="mobile-modal" \/>[\s\S]*\};/);
  assert.match(layoutSource, /if \(isContentRoute\) \{[\s\S]*if \(threadIsTop && openedAsTask\) \{[\s\S]*return renderTaskThreadPanel\(\);[\s\S]*if \(threadIsTop && searchSlotKind && searchSlotKind !== "thread"\)/,
    "content master/detail routes must still open task-intent threads as task modals");
  assert.match(layoutSource, /threadIsTop && \(isTasksRoute \|\| openedAsTask\)[\s\S]*return renderTaskThreadPanel\(\);/);
  assert.match(layoutSource, /isTasksRoute && legacyTaskOpen[\s\S]*if \(railVisible\)[\s\S]*<Modal onClose=\{closeLegacyTask\} closeOnBackdrop>[\s\S]*<LegacyTaskPanelWrapper presentation="modal" \/>[\s\S]*return <LegacyTaskPanelWrapper presentation="mobile-modal" \/>/);

  // mobile-modal CSS: absolute full-screen sheet (no Modal wrapper) with a
  // persistent task-owned back bar. ThreadPanel's own header stays suppressed.
  // Lives on the ThreadPanelWrapper in MainLayout post-2026-05-28 column /
  // surface split; LegacyTaskPanel still owns its own per-presentation
  // panelClassName ternary (parallel refactor not in this PR's scope).
  assert.match(layoutSource, /presentation === "mobile-modal"[\s\S]*"absolute inset-0 z-30 flex flex-col bg-white"[\s\S]*data-testid="task-thread-modal"[\s\S]*<TaskModalBar task=\{hostTask\} onClose=\{mobileTaskBack\} mobile \/>[\s\S]*<ThreadPanel[\s\S]*presentation="mobile-modal"/);
  assert.match(layoutSource, /const mobileTaskBack = useMobileBack\(closeThread, closeThread\)/,
    "mobile task Back must close synchronously before consuming its history PUSH");
  assert.match(layoutSource, /data-testid="task-modal-mobile-back"[\s\S]*<ArrowLeft size=\{14\}/,
    "the full-height task sheet needs an explicit visible back affordance");
  assert.match(legacyTaskSource, /presentation === "mobile-modal"\s*\?\s*"absolute inset-0 z-30 flex flex-col bg-white"/);
});

// X close button visibility per stdrc 2026-05-21 #proj-task:287f18ce
// msg=804c045d: "它作为弹窗就需要叉；如果它是直接覆盖整个页面，就是返回."
//   modal        — X visible (centered dialog needs an explicit close)
//   mobile-modal — NO X (full-screen overlay; back chevron is the close)
//   side         — X on desktop only (`hidden lg:flex`)
//
// Also pins the flag-off View-in-channel fallback to the same size-7 icon
// shape used by the flag-on thread action menu, plus the back-chevron
// breakpoint flip between side (lg) and modal / mobile-modal (md).
test("X close visibility is modal-only / non-mobile-modal, View-in-channel stays a size-7 icon fallback", () => {
  const threadSource = readSource("src/components/message/ThreadPanel.tsx");
  const legacyTaskSource = readSource("src/components/task/LegacyTaskPanel.tsx");

  // X close button skipped only in mobile-modal — modal and side both render it.
  // Click handler is `handleClose` (= onClose ?? closeThread) so embedding
  // hosts (e.g. /search col-3) can layer extra teardown on top of closeThread.
  assert.match(threadSource, /const showCloseButton = presentation !== "mobile-modal";[\s\S]*\{showCloseButton && \(\s*<button[\s\S]*onClick=\{handleClose\}[\s\S]*<X size=\{14\}/);
  assert.match(legacyTaskSource, /\{presentation !== "mobile-modal" && \([\s\S]*onClick=\{handleClose\}[\s\S]*<X size=\{14\}/);

  // closeButtonClassName: modal → always flex; side → hidden lg:flex.
  assert.match(threadSource, /const closeButtonClassName = presentation === "modal"\s*\?\s*"btn-brutal-sm flex size-7 items-center justify-center bg-white"\s*:\s*"btn-brutal-sm hidden size-7 items-center justify-center bg-white lg:flex"/);
  assert.match(legacyTaskSource, /const closeButtonClassName = presentation === "modal"\s*\?\s*"btn-brutal-sm flex size-7 items-center justify-center bg-white"\s*:\s*"btn-brutal-sm hidden size-7 items-center justify-center bg-white lg:flex"/);

  // task #187 moves View-in-channel into the ellipsis menu when the flag is
  // on; the flag-off fallback therefore stays a compact icon at every width.
  assert.match(threadSource, /className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-white"[\s\S]*data-testid="thread-view-in-channel"/);
  assert.doesNotMatch(threadSource, /data-testid="thread-view-in-channel"[\s\S]{0,240}sm:w-auto/);

  // Back chevron breakpoint: side → lg, modal / mobile-modal → md.
  assert.match(threadSource, /mobileBreakpoint=\{presentation === "side" \? "lg" : "md"\}/);
  assert.match(legacyTaskSource, /className=\{presentation === "side" \? "lg:hidden" : "md:hidden"\}/);
});

/**
 * Replacement teeth for the shape this file used to pin implicitly.
 *
 * The old assertions matched `<ThreadPanel ... />` as one self-closing tag, so
 * they incidentally guaranteed the modal had no head. Now that a task modal
 * carries one, the geometry pins above stay but they no longer say *how* the
 * task surface differs from an ordinary thread — that has to be asserted
 * directly or the repin would be a net loss of coverage.
 */
test("a task modal suppresses the thread's own header and anchor, and mounts the head inside the scroller", () => {
  const layoutSource = readSource("src/components/layout/MainLayout.tsx");

  // Both are conditional on there being a host task: an ordinary thread must
  // keep its header and its anchor message.
  assert.match(layoutSource, /hideHeader=\{!!hostTask\}/,
    "the thread header must be suppressed only for a task, not unconditionally");
  assert.match(layoutSource, /hideParentMessage=\{!!hostTask\}/,
    "the anchor message must be suppressed only for a task, not unconditionally");

  assert.match(layoutSource, /<ThreadPanel[\s\S]*parentSlot=\{hostTask \? <Suspense[\s\S]*TaskModalHead task=\{hostTask\}/,
    "the task head must render through ThreadPanel's timeline parent slot");
  const threadSource = readSource("src/components/message/ThreadPanel.tsx");
  assert.match(threadSource, /\{parentSlot\}/,
    "ThreadPanel must place the task head inside the timeline header");
});
