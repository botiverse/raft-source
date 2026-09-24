import assert from "node:assert/strict";
import test from "node:test";

import { formatAppConfig } from "./_format.js";

// Byte pin: expected string copied from the PRE-MOVE formatAppConfig in
// config.ts (print-seam S2). The move must not change a single output byte.
test("formatAppConfig matches pre-move config.ts bytes", () => {
  assert.equal(
    formatAppConfig({
      appId: "cleaner",
      revision: 4,
      schema: { intervalMinutes: { type: "number" }, enabled: { type: "boolean" } },
      defaults: { intervalMinutes: 30, enabled: true },
      overrides: { intervalMinutes: 15 },
      effective: { intervalMinutes: 15, enabled: true },
    } as never),
    "App: cleaner\n" +
      "Revision: 4\n" +
      "Config:\n" +
      "  enabled = true (default; default true)\n" +
      "  intervalMinutes = 15 (override; default 30)\n" +
      "Next action: raft app config --app cleaner",
  );
});
