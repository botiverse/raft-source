import assert from "node:assert/strict";
import { forwardToast } from "../src/components/message/forwardToast";
import { setToastManager } from "../src/components/toastBridge";

// cindyz 2026-11-14: "You're on Raft Desktop 1.27.0 · What's new" (desktopNotice,
// which is forwardToast) showed at the top center over the search bar. Every
// toast is one of the app's toasts, at the bottom center (Raft DS › Toast ›
// Where it appears): forwardToast shows through the app's toast manager.
afterEach(() => setToastManager(null));

test("forwardToast shows the app's toast (bottom center), with its action, close and 8s timeout", () => {
  const added: Array<Record<string, unknown>> = [];
  setToastManager({ add: (toast) => { added.push(toast as never); return "t1"; } });
  let opened = 0;
  forwardToast.info("You're on Raft Desktop 1.27.0", { action: { label: "What's new", onClick: () => { opened += 1; } }, dismissible: true });
  forwardToast.error("Forward failed.");

  assert.equal(added.length, 2);
  const [info, error] = added as Array<{ title: string; type: string; timeout?: number; priority?: string; data: { hasClose: boolean }; actionProps?: { children: string; onClick: () => void } }>;
  assert.equal(info.title, "You're on Raft Desktop 1.27.0");
  assert.equal(info.type, "info");
  assert.equal(info.data.hasClose, true);
  assert.equal(info.timeout, 8_000);
  assert.equal(info.actionProps?.children, "What's new");
  info.actionProps?.onClick();
  assert.equal(opened, 1);
  assert.equal(error.type, "error");
  assert.equal(error.priority, "high");
  assert.equal(error.data.hasClose, false);
});
