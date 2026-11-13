import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { __setShellKeepFailedEmitterForTest, reportShellKeepFailed } from "../src/utils/shellKeepFailedTrace";

afterEach(() => __setShellKeepFailedEmitterForTest(null));

function capture() {
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setShellKeepFailedEmitterForTest(((name, attrs) => void events.push({ name, attrs: attrs ?? {} })) as Parameters<typeof __setShellKeepFailedEmitterForTest>[0]);
  return events;
}

const HARMONY_UA = "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile";

test("the worker's message is reported with its step, whether this page was the kept copy, and the browser", () => {
  const events = capture();
  reportShellKeepFailed({ type: "raft:shell-keep-failed", step: "asset_store", servedKept: true }, HARMONY_UA);
  assert.deepEqual(events, [{
    name: "slock.web.shell_keep_failed",
    attrs: { step: "asset_store", served_kept: true, browser_family: "chrome", harmonyos: true },
  }]);
});

test("an unknown step or a malformed message reports a closed value, never what was sent", () => {
  const events = capture();
  reportShellKeepFailed({ step: "/assets/secret-file.js", servedKept: "yes" }, "Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15");
  reportShellKeepFailed(null, null);
  assert.deepEqual(events.map((event) => event.attrs), [
    { step: "unknown", served_kept: false, browser_family: "safari", harmonyos: false },
    { step: "unknown", served_kept: false, browser_family: "unknown", harmonyos: false },
  ]);
});

test("HarmonyOS 2-4's Huawei Browser counts as HarmonyOS too", () => {
  const events = capture();
  reportShellKeepFailed({ step: "catalogs" }, "Mozilla/5.0 (Linux; Android 10; HarmonyOS; NOH-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0 HuaweiBrowser/14.0 Mobile Safari/537.36");
  assert.equal(events[0]!.attrs.harmonyos, true);
});
