import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { lazy } from "react";
import type { ComponentType } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { LazyAboutFeedbackPanel } from "../src/components/settings/LazyAboutFeedbackDialog";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

test("a slow first-open loader renders localized pending content inside the settings panel", async () => {
  let resolvePanel!: (value: { default: ComponentType }) => void;
  const DeferredPanel = lazy(() => new Promise((resolve) => {
    resolvePanel = resolve;
  }));

  render(
    <TestIntlProvider>
      <LazyAboutFeedbackPanel panel={DeferredPanel} />
    </TestIntlProvider>,
  );

  const pending = screen.getByRole("status", { name: "Loading feedback…" }).parentElement?.parentElement;
  assert.equal(pending?.getAttribute("aria-busy"), "true");
  assert.ok(screen.getByRole("status", { name: "Loading feedback…" }));
  assert.equal(screen.queryByRole("dialog"), null);

  await act(async () => {
    resolvePanel({
      default: () => <section aria-label="Loaded feedback" />,
    });
  });
  assert.ok(screen.getByRole("region", { name: "Loaded feedback" }));
});
