import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShareArtifactXIntentUrl,
  navigateShareArtifactToX,
} from "../src/utils/selectMarkdown";

type FakeWindow = {
  innerWidth: number;
  open: (url: string, target: string) => Window | null;
  location: {
    assign: (url: string) => void;
  };
};

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installBrowserGlobals(windowValue: FakeWindow, userAgent = "Chrome Desktop") {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowValue,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent },
  });
}

function restoreBrowserGlobals() {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
}

test.afterEach(() => {
  restoreBrowserGlobals();
});

test("desktop Share to X opens one new tab without navigating Slock when popup opens", () => {
  const openedWindow = { opener: "slock" } as unknown as Window;
  const openedUrls: Array<{ url: string; target: string }> = [];
  const assignedUrls: string[] = [];
  installBrowserGlobals({
    innerWidth: 1280,
    open: (url, target) => {
      openedUrls.push({ url, target });
      return openedWindow;
    },
    location: {
      assign: (url) => assignedUrls.push(url),
    },
  });

  const shareUrl = "https://slock.ai/share/76c83ab9-b4fc-4872-92d9-381a1f4ff811";
  const expectedIntent = buildShareArtifactXIntentUrl(shareUrl);
  navigateShareArtifactToX(shareUrl);

  assert.deepEqual(openedUrls, [{ url: expectedIntent, target: "_blank" }]);
  assert.deepEqual(assignedUrls, []);
  assert.equal(openedWindow.opener, null);
});

test("desktop Share to X falls back to current-tab navigation only when popup is blocked", () => {
  const openedUrls: Array<{ url: string; target: string }> = [];
  const assignedUrls: string[] = [];
  installBrowserGlobals({
    innerWidth: 1280,
    open: (url, target) => {
      openedUrls.push({ url, target });
      return null;
    },
    location: {
      assign: (url) => assignedUrls.push(url),
    },
  });

  const shareUrl = "https://slock.ai/share/76c83ab9-b4fc-4872-92d9-381a1f4ff811";
  const expectedIntent = buildShareArtifactXIntentUrl(shareUrl);
  navigateShareArtifactToX(shareUrl);

  assert.deepEqual(openedUrls, [{ url: expectedIntent, target: "_blank" }]);
  assert.deepEqual(assignedUrls, [expectedIntent]);
});
