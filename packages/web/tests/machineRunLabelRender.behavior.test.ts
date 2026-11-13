import assert from "node:assert/strict";
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

test("zh: offline legacy machine renders 离线, not the .text fallback", () => {
  const html = zhRender({ status: "offline" });
  assert.match(html, /离线/);
  assert.doesNotMatch(html, /Offline/);
});

test("zh: online legacy machine with version renders 旧版 v{version}", () => {
  const html = zhRender({ status: "online", daemonVersion: "1.2.3" });
  assert.match(html, /旧版 v1\.2\.3/);
  assert.doesNotMatch(html, /legacy v1\.2\.3/);
});

test("zh: online computer without version renders 在线 (status, not version presence)", () => {
  const html = zhRender({ isComputer: true, status: "online", computerVersion: null, daemonVersion: "9.9.9" });
  assert.match(html, /在线/);
  assert.doesNotMatch(html, /9\.9\.9/);
});

test("zh: offline computer renders 离线", () => {
  const html = zhRender({ isComputer: true, status: "offline" });
  assert.match(html, /离线/);
  assert.doesNotMatch(html, /Offline/);
});

test("en: Online / Offline as the state, the bare version as a fact", () => {
  const en = (machine: Parameters<typeof MachineRunLabel>[0]["machine"]) => renderToStaticMarkup(
    createElement(TestIntlProvider, null, createElement(MachineRunLabel, { machine })),
  );
  assert.equal(en({ status: "offline" }), "Offline");
  assert.equal(en({ isComputer: true, status: "offline" }), "Offline");
  assert.equal(en({ isComputer: true, status: "online", computerVersion: "1.2.0" }), "v1.2.0");
  assert.equal(en({ isComputer: true, status: "online", computerVersion: null }), "Online");
});
