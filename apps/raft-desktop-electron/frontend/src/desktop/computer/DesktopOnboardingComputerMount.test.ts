// Locks the fragile web-DOM targeting the desktop onboarding one-click mount
// relies on: it must find the connect step by its stable log node, tag the CLI
// command guide for hiding, and place its host at the top — without touching
// packages/web. If the web onboarding renames those test ids, these break loudly
// instead of the button silently never appearing.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { syncOnboardingEnableHost } from "./onboardingEnableDom.js";

// A representative connect-step subtree: the CLI guide (holding the platform
// toggle), the terminal instructions, and the always-present progress log —
// mirroring ServerSetupComputerRuntimeStep's connect branch order.
function connectStepDoc(): Document {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section id="step">
      <div id="guide">
        <button data-testid="computer-command-platform-mac-linux">macOS / Linux</button>
        <pre>curl -fsSL https://cdn.raft.build/computer/install.sh | sh</pre>
      </div>
      <div data-testid="onboarding-computer-instructions">run it in a terminal…</div>
      <ol data-testid="onboarding-connect-log"></ol>
    </section>
  </body></html>`);
  return dom.window.document;
}

test("injects host as the step container's first child and tags the CLI guide", () => {
  const doc = connectStepDoc();
  const host = syncOnboardingEnableHost(doc, null);

  assert.ok(host, "should return a host to portal into");
  const container = doc.querySelector('[data-testid="onboarding-connect-log"]')!.parentElement!;
  assert.equal(container.firstElementChild, host, "host must sit above the (hidden) guide");
  assert.ok(host!.hasAttribute("data-raft-desktop-onboarding-enable-host"));
  // The durable container is tagged (not the guide node), so the CSS rule hides
  // the CLI even across re-renders that re-create the guide.
  assert.equal(container.getAttribute("data-raft-desktop-onboarding-step"), "");
});

test("re-sync with the same host is idempotent (no duplicate hosts)", () => {
  const doc = connectStepDoc();
  const host = syncOnboardingEnableHost(doc, null)!;
  const again = syncOnboardingEnableHost(doc, host);

  assert.equal(again, host, "reuses the passed host");
  assert.equal(doc.querySelectorAll("[data-raft-desktop-onboarding-enable-host]").length, 1);
  const container = doc.querySelector('[data-testid="onboarding-connect-log"]')!.parentElement!;
  assert.equal(container.firstElementChild, host, "still first child after re-sync");
});

test("returns null when the connect step is not on screen", () => {
  const dom = new JSDOM(`<!doctype html><html><body><div>some other screen</div></body></html>`);
  assert.equal(syncOnboardingEnableHost(dom.window.document, null), null);
});

test("does not inject in the offline-recovery branch (no connect log)", () => {
  // Recovery renders onboarding-offline-recovery and NO onboarding-connect-log,
  // so the one-click enable must stay out of it.
  const dom = new JSDOM(`<!doctype html><html><body>
    <section><div data-testid="onboarding-offline-recovery">your machine is asleep…</div></section>
  </body></html>`);
  assert.equal(syncOnboardingEnableHost(dom.window.document, null), null);
});
