import assert from "node:assert/strict";
import { createResumeActivityReread, RESUME_REREAD_HIDDEN_MS } from "../src/store/resumeActivityReread";
import type { ClientPlatformHint } from "../src/utils/clientPlatformHint";

// #triage:#244: a frozen page owes no read (no socket events reached it), so
// coming back re-reads Activity once: after a freeze, a bfcache restore, or a
// hidden spell past its platform's floor.

function tracker(platform: ClientPlatformHint) {
  const rereads: string[] = [];
  return { rereads, t: createResumeActivityReread(() => platform, (cause) => rereads.push(cause)) };
}

test("an installed web app hidden past its short floor re-reads once on show", () => {
  const { rereads, t } = tracker("pwa");
  t.noteHidden(1_000);
  t.noteHidden(2_000);
  assert.equal(t.noteVisible(1_000 + RESUME_REREAD_HIDDEN_MS.pwa), "hidden");
  assert.equal(t.noteVisible(1_000 + RESUME_REREAD_HIDDEN_MS.pwa + 10), null, "the focus that follows the show reads nothing more");
  assert.deepEqual(rereads, ["hidden"]);
});

test("a quick switch reads nothing; a browser tab's floor is longer than an installed app's", () => {
  const pwa = tracker("pwa");
  pwa.t.noteHidden(0);
  assert.equal(pwa.t.noteVisible(RESUME_REREAD_HIDDEN_MS.pwa - 1), null);
  const browser = tracker("browser");
  browser.t.noteHidden(0);
  assert.equal(browser.t.noteVisible(RESUME_REREAD_HIDDEN_MS.pwa), null);
  browser.t.noteHidden(0);
  assert.equal(browser.t.noteVisible(RESUME_REREAD_HIDDEN_MS.browser), "hidden");
  assert.ok(RESUME_REREAD_HIDDEN_MS.pwa < RESUME_REREAD_HIDDEN_MS.browser);
});

test("a frozen page, or one restored from the back/forward cache, re-reads on show however short the spell", () => {
  const frozen = tracker("browser");
  frozen.t.noteHidden(0);
  frozen.t.noteFrozen(10);
  assert.equal(frozen.t.noteVisible(20), "frozen");
  const restored = tracker("desktop_app");
  restored.t.noteRestored();
  assert.equal(restored.t.noteVisible(0), "bfcache");
});

test("a system wake re-reads on the next show however short the spell, once", () => {
  const { rereads, t } = tracker("desktop_app");
  t.noteWoke(0);
  assert.equal(t.noteVisible(10), "wake");
  assert.equal(t.noteVisible(20), null);
  assert.deepEqual(rereads, ["wake"]);
});

test("a visible focus with no hidden spell reads nothing", () => {
  const { rereads, t } = tracker("pwa");
  assert.equal(t.noteVisible(1_000_000), null);
  assert.deepEqual(rereads, []);
});
