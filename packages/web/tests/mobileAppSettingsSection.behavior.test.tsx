import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import { AboutSection } from "../src/components/settings/SettingsPanel";
import { REGISTERED_SERVER_FEATURE_FLAG_KEYS } from "../src/store/serverFeatureFlags";

/**
 * The mobile-download entry point.
 *
 * Both buttons must point at our own route rather than at a vendor URL. That is
 * what lets the QR code stay a stable target while the artifact URL underneath
 * is re-resolved per request — Hands issues signed URLs that expire, so a link
 * baked into the page is a download that breaks later.
 *
 * The platform split is not cosmetic: Android resolves to an installable APK
 * through Hands, while iOS must reach TestFlight, because stock iOS cannot
 * install the `.ipa` Hands holds. Pointing iOS at the artifact produces a
 * download that succeeds and installs nothing.
 */

afterEach(() => {
  cleanup();
});

function renderAbout(locale?: "en" | "zh-cn") {
  return render(
    <TestIntlProvider locale={locale}>
      <AboutSection />
    </TestIntlProvider>,
  );
}

test("both platforms link to our own download route, not to a vendor URL", () => {
  try {
    renderAbout();
    const android = screen.getByTestId("mobile-download-android");
    const ios = screen.getByTestId("mobile-download-ios");

    // Endpoint + platform only. The ORIGIN half is owned by
    // tests/mobileDownloadUrl.test.ts, which exercises a split-origin base this
    // jsdom process is not compiled with — asserting the origin here would just
    // re-state whatever the runtime happens to be, which is how the staging
    // bounce shipped green in the first place.
    assert.ok(
      android.getAttribute("href")?.endsWith("/mobile-download?platform=android"),
      `android must hit our endpoint: ${android.getAttribute("href")}`,
    );
    assert.ok(
      ios.getAttribute("href")?.endsWith("/mobile-download?platform=ios"),
      `ios must hit our endpoint: ${ios.getAttribute("href")}`,
    );

    // A signed artifact URL embedded here would expire; the indirection is the
    // whole point, so assert neither link reaches a vendor host directly.
    for (const el of [android, ios]) {
      const href = el.getAttribute("href") ?? "";
      assert.ok(!href.includes("hands.build"), `link must not embed a vendor URL: ${href}`);
      assert.ok(!href.includes("testflight.apple.com"), `link must not embed a vendor URL: ${href}`);
    }
  } finally {
    cleanup();
  }
});

/**
 * DELIBERATELY ABSENT: there is no assertion that the section names TestFlight.
 *
 * An earlier test required it, on the reasoning that an unexplained jump to
 * Apple's beta app reads as a broken link. @wenyi removed that line as part of
 * tightening the section's copy (2026-08-10, #wg-download-mobile), so the
 * requirement is retired by decision, not by accident — recorded here because a
 * silently deleted assertion is indistinguishable from one someone forgot.
 *
 * What still carries the signal is the button's own label ("Get the iOS beta"),
 * so "this is a beta" survives; only the word TestFlight is gone. If a future
 * change makes that jump surprising again, restore a copy assertion rather than
 * assuming this absence was considered.
 */

test("the iOS button routes through us, not to Apple directly", () => {
  try {
    renderAbout();
    const ios = screen.getByTestId("mobile-download-ios");
    assert.ok(ios.getAttribute("href")?.endsWith("/mobile-download?platform=ios"));
  } finally {
    cleanup();
  }
});

test("iOS opens in a new tab because it leaves Raft; Android does not", () => {
  // Our route 302s iOS to testflight.apple.com, so that click ends up on an
  // external site and belongs in its own tab (@wenyi). Android resolves to a
  // file download — a download launched into a fresh tab strands an empty tab,
  // so the asymmetry is deliberate and asserted in BOTH directions, or someone
  // will "fix the inconsistency" later.
  try {
    renderAbout();
    const ios = screen.getByTestId("mobile-download-ios");
    const android = screen.getByTestId("mobile-download-android");

    assert.equal(ios.getAttribute("target"), "_blank");
    // rel is not decoration: _blank without noopener hands the opened page a
    // window.opener handle back into ours.
    assert.match(ios.getAttribute("rel") ?? "", /noopener/);
    assert.match(ios.getAttribute("rel") ?? "", /noreferrer/);

    assert.equal(android.getAttribute("target"), null, "a download must not open a stray tab");
  } finally {
    cleanup();
  }
});

test("the QR encodes the route with no platform, so one code serves both phones", async () => {
  // At scan time the phone is not this device, so the desktop cannot classify
  // it. The route's UA fallback does that instead. A `platform` baked in here
  // would mean two codes and asking the reader to identify their own device.
  const { encode } = await import("uqr");
  try {
    renderAbout();
    // Rendering is lazy, so wait for the import to land rather than asserting
    // on the first paint.
    const qr = await screen.findByTestId("mobile-download-qr");
    const painted = qr.querySelector("path")?.getAttribute("d");
    assert.ok(painted, "the QR must render its module path once the encoder loads");

    // Decode-free oracle: re-encode both candidate payloads with the same
    // library and rebuild the path exactly as the component does. Matching the
    // platformless URL — and NOT the platform-pinned one — pins the property.
    const origin = window.location.origin;
    const pathFor = (target: string) =>
      encode(target, { border: 1 })
        .data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x},${y}h1v1h-1z` : "")))
        .join("");
    // The QR encodes the WEB origin's /download, not the API entry: App Links
    // only fire for hosts publishing the association files, and those live on
    // the web origin — an API-origin QR could never open the app (@Mahua).
    const chooser = pathFor(`${origin}/download`);
    const apiEntry = pathFor(`${origin}/api/mobile-download`);
    const pinned = pathFor(`${origin}/download?platform=android`);

    assert.equal(painted, chooser, "QR must encode the public web chooser");
    assert.notEqual(painted, apiEntry, "QR must NOT encode the API entry — it can never open the app");
    assert.notEqual(painted, pinned, "QR must not pin a platform");
    // Sanity on the oracle itself: the two payloads must actually differ, or
    // the assertion above would pass for a trivial reason.
    assert.notEqual(chooser, apiEntry, "the candidate payloads must actually differ");
  } finally {
    cleanup();
  }
});

/**
 * The three visual contracts @wenyi set in the preview review. They are here
 * because @Aiden showed the previous exact could not defend them: reverting the
 * dot to `sm` and Android to pink left the web suite fully green.
 */

test("the two download buttons stay peers, neither styled as the recommended one", () => {
  // We cannot know which phone the reader owns — the device is not the one
  // rendering this page — so promoting either button states a recommendation we
  // have no basis for. Android was the pink CTA; an iPhone user then hunts for
  // the "real" button.
  try {
    renderAbout();
    const android = screen.getByTestId("mobile-download-android");
    const ios = screen.getByTestId("mobile-download-ios");
    for (const el of [android, ios]) {
      assert.ok(
        el.className.includes("bg-white"),
        `both buttons must share the neutral surface: ${el.className}`,
      );
      assert.ok(
        !el.className.includes("bg-brutal-pink"),
        `neither button may take the CTA fill: ${el.className}`,
      );
    }
  } finally {
    cleanup();
  }
});

test("the QR sits in the left content flow, not pinned to the far edge", async () => {
  // Pinned right on a wide settings panel it sat in a field of whitespace,
  // reading as decoration unrelated to the buttons it belongs to. Structural
  // assertion rather than geometry: jsdom has no layout, but "shares the
  // content column with the buttons" is exactly what moving it back out breaks.
  try {
    renderAbout();
    const qr = await screen.findByTestId("mobile-download-qr");
    const android = screen.getByTestId("mobile-download-android");
    const column = android.closest("div.space-y-3");
    assert.ok(column, "the buttons must live in the content column");
    assert.ok(
      column.contains(qr),
      "the QR must share the content column with the buttons, not be a right-hand sibling",
    );
  } finally {
    cleanup();
  }
});

test("the section copy stays short and drops the TestFlight line", () => {
  try {
    renderAbout();
    const text = document.body.textContent ?? "";
    assert.match(text, /Get the Raft mobile app\./);
    // The retired two-sentence pitch must not creep back.
    assert.ok(!text.includes("Take your agents with you"), "the long pitch was removed on purpose");
    assert.ok(!text.includes("TestFlight"), "the TestFlight caption was removed on purpose");
  } finally {
    cleanup();
  }
});

test("the section is localized, not English-only", () => {
  try {
    renderAbout("zh-cn");
    const text = document.body.textContent ?? "";
    assert.match(text, /手机 App/);
    assert.match(text, /下载 Android 版/);
    assert.ok(!text.includes("Download for Android"), "zh-cn must not fall back to the English label");
  } finally {
    cleanup();
  }
});

test("the mobile download entry is default-on and no longer registered as a server flag", () => {
  assert.equal(
    REGISTERED_SERVER_FEATURE_FLAG_KEYS.includes("mobile_download_v0" as never),
    false,
    "the retired mobile download flag must not be requested by the web client",
  );
  try {
    renderAbout();
    assert.ok(screen.getByTestId("mobile-download-android"));
    assert.ok(screen.getByTestId("mobile-download-ios"));
    assert.match(document.body.textContent ?? "", /Get the Raft mobile app/);
  } finally {
    cleanup();
  }
});
