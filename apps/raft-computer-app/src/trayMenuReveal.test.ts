import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// REGRESSION pin for #wg-raft-computer:f2a02081 — "Option-click showed nothing".
//
// We originally tried to reveal the "Sync diagnostics" power/debug item only on
// an Option-click of the tray icon: NO setContextMenu, and every click driven
// through `popUpContextMenu(buildTrayMenu(event.altKey))`. That does NOT work on
// macOS — the tray `click` event's modifier flags (`event.altKey`) are not
// reliably populated for a mouse click (the KeyboardEvent modifier contract is
// accelerator-oriented), so a real checkout-and-run revealed nothing extra.
//
// The reliable fix: go back to the canonical macOS tray pattern —
// `tray.setContextMenu(buildTrayMenu())` and let the OS open the menu — and put
// "Sync diagnostics" in an always-present "Advanced" submenu (menuModel) instead
// of gating it behind the flaky modifier. So main.ts must:
//   - use setContextMenu (NOT popUpContextMenu)
//   - NOT depend on event.altKey for the menu variant
//
// Source-grep is the right guard here: this is top-level Electron tray wiring
// (not unit-testable DSL), and the failure mode was OS-input-level (only a real
// macOS click exposed it). The "Advanced submenu contains diagnostics" property
// is unit-tested in menuModel.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_SRC = join(__dirname, "main.ts");

test("main.ts attaches the tray menu via setContextMenu and does NOT depend on the flaky tray-click altKey modifier", async () => {
  const src = await readFile(MAIN_SRC, "utf8");
  // Strip block + line comments so doc-comments (which name the rejected
  // popUpContextMenu / altKey approach to explain why we avoid it) do not count
  // as usage.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  assert.match(
    codeOnly,
    /\.setContextMenu\s*\(/,
    "tray menu must be attached via setContextMenu — the canonical reliable macOS pattern",
  );
  assert.doesNotMatch(
    codeOnly,
    /\.popUpContextMenu\s*\(/,
    "must NOT drive clicks through popUpContextMenu — that path existed only to read the tray-click altKey modifier, which is unreliable on macOS",
  );
  assert.doesNotMatch(
    codeOnly,
    /event\.altKey/,
    "must NOT gate the menu on event.altKey — the tray-click Option modifier is not reliably reported on macOS, so Option-reveal never fired",
  );
});

test("main.ts maps affordance unavailable reasons to native menu tooltips", async () => {
  const src = await readFile(MAIN_SRC, "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  assert.match(
    codeOnly,
    /item\.toolTip\s*=\s*node\.unavailableReason/,
    "disabled affordance-backed rows must explain why they are unavailable",
  );
});
