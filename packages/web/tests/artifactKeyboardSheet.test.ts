import assert from "node:assert/strict";
import { keyboardSheetStyle } from "../src/apps/artifacts/artifactSoftKeyboard";

// A phone's comment sheet with the on-screen keyboard up (xxchan, #proj-mobile msg=9e51cd9d): on
// the keyboard's top edge, and no taller than what the keyboard leaves of the screen.
test("keyboardSheetStyle leaves raft-ui's place alone while the keyboard is down", () => {
  assert.equal(keyboardSheetStyle(null), undefined);
});

test("keyboardSheetStyle sits the sheet on the keyboard and fits it in what is left", () => {
  assert.deepEqual(keyboardSheetStyle({ bottom: 442, inset: 402, height: 430 }), {
    bottom: "402px",
    maxHeight: "387px",
    minHeight: "min(16rem, 387px)",
    paddingBottom: 0,
  });
});
