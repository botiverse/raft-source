import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup } from "@testing-library/react";
import { SavedNavCount } from "../src/components/layout/Sidebar";
import { renderWithIntl } from "./helpers/intl";

/**
 * Behavior: the sidebar "Saved" nav badge shows the true saved total, and is
 * HIDDEN when there is nothing saved (task #420). The badge value is the
 * server-provided total, not the loaded-page length that used to cap it at 20.
 *
 * Mutant-kill: the visibility guard `total <= 0 → return null` (equivalently the
 * old inline `savedTotal > 0 &&`). Mutating that guard so it always renders is
 * killed by the `total = 0 → renders nothing` case below — which the inline form
 * left uncovered (mutation survivor flagged by artin, #proj-uiux:f0f5f76a).
 *
 * Run: `pnpm --filter @botiverse/raft-web test:dom`.
 */

afterEach(cleanup);

test("renders nothing when nothing is saved (total = 0)", () => {
  const { container } = renderWithIntl(<SavedNavCount total={0} />);
  assert.equal(container.textContent, "", "no badge when total is 0");
  assert.equal(container.querySelector("span"), null);
});

test("renders nothing for a negative/invalid total", () => {
  const { container } = renderWithIntl(<SavedNavCount total={-1} />);
  assert.equal(container.querySelector("span"), null);
});

test("shows the exact total when there are saved items", () => {
  const { container } = renderWithIntl(<SavedNavCount total={42} />);
  assert.equal(container.querySelector("span")?.textContent, "42");
});

test("shows large totals verbatim (no 20-cap, no 99+ cap)", () => {
  const { container } = renderWithIntl(<SavedNavCount total={247} />);
  assert.equal(container.querySelector("span")?.textContent, "247");
});

test("shows the localized item unit in Chinese", () => {
  const { container } = renderWithIntl(<SavedNavCount total={33} />, { locale: "zh-cn" });
  assert.equal(container.querySelector("span")?.textContent, "33 项");
});
