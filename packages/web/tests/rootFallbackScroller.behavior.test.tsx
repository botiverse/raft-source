import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import { AppRefreshRequiredScreen } from "../src/components/errors/AppUpdateGate";
import RootErrorFallback from "../src/components/errors/RootErrorFallback";
import RootFallbackScroller from "../src/components/errors/RootFallbackScroller";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, "..");

afterEach(() => cleanup());

test("root fallback owns bounded vertical scrolling without unlocking the normal app root", () => {
  render(
    <RootFallbackScroller
      data-testid="fallback"
      style={{ background: "rgb(255, 248, 225)" }}
    >
      <pre>
        {Array.from({ length: 100 }, (_, index) => `stack ${index}`).join("\n")}
      </pre>
      <button type="button">Reload app</button>
    </RootFallbackScroller>,
  );

  const fallback = screen.getByTestId("fallback");
  assert.equal(fallback.style.width, "100%");
  assert.equal(fallback.style.height, "100%");
  assert.equal(fallback.style.minHeight, "0px");
  assert.equal(fallback.style.flex, "1 1 auto");
  assert.equal(fallback.style.boxSizing, "border-box");
  assert.equal(fallback.style.overflowY, "auto");
  assert.equal(fallback.style.overflowX, "hidden");
  assert.equal(fallback.style.overscrollBehaviorY, "contain");
  assert.equal(fallback.style.background, "rgb(255, 248, 225)");
  assert.ok(
    fallback.contains(screen.getByRole("button", { name: "Reload app" })),
  );

  const rootCss = readFileSync(resolve(webRoot, "src/index.css"), "utf8");
  assert.match(rootCss, /#root\s*\{[\s\S]*?overflow:\s*hidden;/);
});

test("both root fallback screens render inside the bounded scroller", () => {
  const { rerender } = render(
    <TestIntlProvider>
      <RootErrorFallback error={new Error("fatal probe")} />
    </TestIntlProvider>,
  );

  const errorScroller = document.querySelector<HTMLElement>("[data-root-fallback-scroller]");
  assert.ok(errorScroller);
  assert.equal(errorScroller.style.overflowY, "auto");
  assert.ok(errorScroller.contains(screen.getByText("fatal probe")));

  rerender(
    <TestIntlProvider>
      <AppRefreshRequiredScreen onContinueAnyway={() => {}} onRecoverAndRefresh={() => {}} />
    </TestIntlProvider>,
  );

  const refreshScroller = document.querySelector<HTMLElement>("[data-root-fallback-scroller]");
  assert.ok(refreshScroller);
  assert.equal(refreshScroller.style.overflowY, "auto");
  assert.ok(refreshScroller.contains(screen.getByRole("alert")));
});
