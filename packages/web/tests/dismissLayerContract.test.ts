import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Every surface that closes on an outside press must declare itself with the
// dismiss-layer marker (src/components/ui/dismissLayer.ts), so hosts that own
// native chrome — the desktop shell's draggable title bar — can tell a layer is
// open. This scan catches the hand-rolled pattern (a document / window
// mousedown or pointerdown listener) landing in a file that declares nothing.
// It proves presence, not placement; behaviour tests cover the real elements.

const SRC = path.resolve(__dirname, "../src");
const OUTSIDE_PRESS = /(document|window)\.addEventListener\(\s*["'](mousedown|pointerdown)["']/;
// Files whose listener is NOT an outside-press dismissal (state each reason).
const NOT_A_LAYER = new Map<string, string>([
  ["components/message/MessageSelectionShortcut.tsx", "selection gesture tracking"],
  ["store/messageStore.ts", "auto-read tab claim on user activity"],
  ["features/shortcuts/dispatcher.ts", "the shortcut registry's last press / focus, so a key on <body> goes to the scope last used (what ChatPanel's, the thread's and an Artifact's ⌘F tracked before); dismisses nothing"],
  ["features/keyboard-shortcuts/useShortcutEditor.ts", "a press outside the shortcuts panel's row being changed cancels its recording; the row is part of the docked panel, not a popup layer"],
  ["hooks/useRowSwipe.ts", "disarms the swallowed click on the next press; dismisses nothing (the open swipe row's close is ThreadsInbox's, marked with dismissLayerProps)"],
  ["utils/sidebarDndE2eProbe.tsx", "E2E-only pointer event recording; never dismisses a layer"],
  ["components/message/useMessageTouchTaps.ts", "swallows the click of the touch that closed a quick-reaction bar and ignores that touch in message rows; dismisses nothing (the bar's close is MessageItem's)"],
  ["features/sidebar/hooks/useSidebarSync.ts", "the Sidebar's leftover user-menu close: nothing sets showUserMenu (the account menu is the LeftRail's), so no layer opens; the Sidebar's own menus render DismissBackdrop (features/sidebar/menus)"],
  ["components/task/ChannelSideArea.tsx", "tracks which side section holds the focus, so the cover's tabs keep it when they move the section; dismisses nothing"],
  ["hooks/useFocusRestore.ts", "a press of the person's own cancels the restores still waiting to give focus back after a surface closed; dismisses nothing"],
  ["utils/focusRequest.ts", "a press of the person's own cancels the focus request still waiting for its target (requestFocus, rule 3); dismisses nothing"],
  ["assistant/assistantOtterLayers.ts", "notes whether a layer above the otter's panel is open as a press begins, so the panel stays open for that press; dismisses nothing (the panel is AssistantOtter's, marked with dismissLayerProps)"],
  ["apps/artifacts/useThreadResolution.ts", "a press of the person's own ends the focus hold after a resolve toast's Undo (the reopened card takes the focus back from other moves until then); dismisses nothing"],
]);
// A file satisfies the contract by spreading the marker itself or by rendering
// a shared component that carries it.
const CARRIERS = [/dismissLayerProps/, /<SelectionPopover\b/, /<DismissBackdrop\b/, /<Lightbox\b/];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

test("every outside-press dismissal lives in a file that declares the dismiss-layer marker", () => {
  const offenders: string[] = [];
  const seen: string[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!OUTSIDE_PRESS.test(source)) continue;
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    seen.push(rel);
    if (NOT_A_LAYER.has(rel)) continue;
    if (CARRIERS.some((re) => re.test(source))) continue;
    offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `outside-press listeners without a dismiss-layer marker (mark the popup element with dismissLayerProps, or list the file in NOT_A_LAYER with its reason):\n  ${offenders.join("\n  ")}`);
  // Allowlist hygiene: an entry that no longer has a listener is stale.
  for (const rel of NOT_A_LAYER.keys()) assert.ok(seen.includes(rel), `NOT_A_LAYER entry is stale (no outside-press listener any more): ${rel}`);
});
