import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MachineRunLabel } from "../src/components/machine/MachineRunLabel";
import { TestIntlProvider } from "./helpers/intl";

// Zh render pins for the run-label seam (DOM sweep 2026-08-04: Sidebar /
// Agent profile rendered the classifier's English `.text` fallback — "daemon
// offline" in zh UI — instead of the catalog). Reverting the seam to `.text`
// makes these RED without reading source.

function zhRender(machine: Parameters<typeof MachineRunLabel>[0]["machine"]): string {
  return renderToStaticMarkup(
    createElement(TestIntlProvider, { locale: "zh-cn" },
      createElement(MachineRunLabel, { machine }),
    ),
  );
}

test("zh: offline daemon machine renders 守护进程离线, not the .text fallback", () => {
  const html = zhRender({ status: "offline" });
  assert.match(html, /守护进程离线/);
  assert.doesNotMatch(html, /daemon offline/);
});

test("zh: online daemon with version renders 守护进程 v{version}", () => {
  const html = zhRender({ status: "online", daemonVersion: "1.2.3" });
  assert.match(html, /守护进程 v1\.2\.3/);
  assert.doesNotMatch(html, /daemon v1\.2\.3/);
});

test("zh: online computer without version renders Computer 在线 (status, not version presence)", () => {
  const html = zhRender({ isComputer: true, status: "online", computerVersion: null, daemonVersion: "9.9.9" });
  assert.match(html, /Computer 在线/);
  assert.doesNotMatch(html, /computer v9\.9\.9/);
});

test("zh: offline computer renders Computer 离线", () => {
  const html = zhRender({ isComputer: true, status: "offline" });
  assert.match(html, /Computer 离线/);
  assert.doesNotMatch(html, /computer offline/);
});

test("en output is unchanged", () => {
  const html = renderToStaticMarkup(
    createElement(TestIntlProvider, null,
      createElement(MachineRunLabel, { machine: { status: "offline" } }),
    ),
  );
  assert.match(html, /daemon offline/);
});
