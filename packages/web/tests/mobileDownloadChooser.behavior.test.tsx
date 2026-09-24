// @ts-nocheck
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import MobileDownloadChooserPage, { isTouchCapableMac } from "../src/pages/MobileDownloadChooserPage";
import { TestIntlProvider } from "./helpers/intl";

/**
 * The chooser that makes iPad a supported target.
 *
 * The server cannot identify a modern iPad — iPadOS Safari sends a UA
 * byte-identical to macOS — so anything unclassifiable is redirected here and
 * the person picks. Two things must hold: the page is reachable and complete
 * without a session, and both options route back through our own endpoint
 * rather than at a vendor URL that expires.
 */

function renderChooser(locale?: "en" | "zh-cn") {
  return render(
    <TestIntlProvider locale={locale}>
      <MobileDownloadChooserPage />
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
});

test("both platforms are offered, each through our own endpoint", () => {
  try {
    renderChooser();
    const ios = screen.getByTestId("mobile-download-chooser-ios");
    const android = screen.getByTestId("mobile-download-chooser-android");

    // Endpoint + platform; the origin half is covered by mobileDownloadUrl.test.ts.
    assert.ok(ios.getAttribute("href")?.endsWith("/mobile-download?platform=ios"));
    assert.ok(android.getAttribute("href")?.endsWith("/mobile-download?platform=android"));

    // Explicit platforms are also what stops this page bouncing back to itself:
    // a platform-less link here would redirect straight back to the chooser.
    for (const el of [ios, android]) {
      const href = el.getAttribute("href") ?? "";
      assert.ok(href.includes("platform="), `each choice must pin a platform: ${href}`);
      assert.ok(!href.includes("hands.build"), `must not embed a vendor URL: ${href}`);
      assert.ok(!href.includes("testflight.apple.com"), `must not embed a vendor URL: ${href}`);
    }
  } finally {
    cleanup();
  }
});

test("the chooser's iOS option also opens in a new tab", async () => {
  try {
    renderChooser();
    const ios = screen.getByTestId("mobile-download-chooser-ios");
    const android = screen.getByTestId("mobile-download-chooser-android");
    assert.equal(ios.getAttribute("target"), "_blank");
    assert.match(ios.getAttribute("rel") ?? "", /noopener/);
    assert.equal(android.getAttribute("target"), null);
  } finally {
    cleanup();
  }
});

test("neither option is styled as the recommended one", () => {
  // Same reason as the settings section: we do not know the reader's device, so
  // promoting one states a recommendation we cannot support — and here we know
  // even less, since this page exists precisely because detection failed.
  try {
    renderChooser();
    for (const id of ["mobile-download-chooser-ios", "mobile-download-chooser-android"]) {
      const el = screen.getByTestId(id);
      assert.ok(el.className.includes("bg-white"), `${id} must use the neutral surface`);
      assert.ok(!el.className.includes("bg-brutal-pink"), `${id} must not take the CTA fill`);
    }
  } finally {
    cleanup();
  }
});

test("the page is localized, not English-only", () => {
  try {
    renderChooser("zh-cn");
    const text = document.body.textContent ?? "";
    assert.match(text, /获取 Raft 手机 App/);
    assert.ok(!text.includes("Get the Raft mobile app"), "zh-cn must not fall back to English");
  } finally {
    cleanup();
  }
});

/**
 * The iPad discriminator itself.
 *
 * This is the one piece of knowledge the server provably cannot have, so it is
 * tested directly rather than only through the rendered page.
 */
test("a touch-capable Mac is treated as an iPad; a real Mac is not", () => {
  const iPadOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

  assert.equal(isTouchCapableMac({ userAgent: iPadOS, maxTouchPoints: 5 }), true, "iPadOS reports touch points");
  assert.equal(isTouchCapableMac({ userAgent: iPadOS, maxTouchPoints: 0 }), false, "desktop Safari reports none");
  // A touchscreen Windows laptop is not a Mac and must not be mistaken for one.
  assert.equal(
    isTouchCapableMac({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", maxTouchPoints: 10 }),
    false,
  );
  // Must not throw where the field is absent (older browsers, non-browser render).
  assert.equal(isTouchCapableMac({ userAgent: iPadOS }), false);
  assert.equal(isTouchCapableMac(undefined), false);
});

/**
 * NOT GATED HERE: that `/download` is registered on the PUBLIC router.
 *
 * The risk is real — declared inside the authenticated shell the page would
 * still render perfectly in isolation (every test above would pass) while
 * putting a login wall in front of every QR scan. That is the same "tooth one
 * layer below production" shape @Aiden caught in the server mount, and the
 * honest position is that this half is currently unguarded.
 *
 * I tried to drive the real `App` router here. It cannot run under this suite:
 * `App` reads `import.meta.env.DEV`, which is undefined outside Vite, and every
 * other test in the repo imports NAMED exports from `App` (`ServerResolver`,
 * `AuthBootstrapStatus`) rather than rendering the default component —
 * presumably for the same reason. Faking `import.meta` to force it would make
 * the test pass by simulating a browser this suite does not have.
 *
 * Verified manually instead, on the preview at the exact head, signed out.
 * Recorded rather than left silent: an absent assertion nobody mentions is
 * indistinguishable from one somebody forgot.
 */
