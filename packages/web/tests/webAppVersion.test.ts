import assert from "node:assert/strict";
import test from "node:test";
import { version as packageVersion } from "../package.json";
import { resolveWebAppVersion } from "../src/utils/webAppVersion";

test("Web app version prefers a trimmed deployment override", () => {
  assert.equal(
    resolveWebAppVersion({ VITE_APP_VERSION: " 2026.08-preview " }),
    "2026.08-preview",
  );
});

test("Web app version falls back to package version when the override is absent or blank", () => {
  assert.equal(resolveWebAppVersion(undefined), packageVersion);
  assert.equal(resolveWebAppVersion({ VITE_APP_VERSION: "   " }), packageVersion);
});
