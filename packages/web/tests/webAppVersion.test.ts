import assert from "node:assert/strict";
import { version as packageVersion } from "../package.json";
import { resolveWebAppVersion, resolveWebRelease } from "../src/utils/webAppVersion";

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

test("Web release is the frontend release id, else the Web app version", () => {
  assert.equal(resolveWebRelease("2d5f9c0cb89af6250974d29aa598cae5e18607d3", { VITE_APP_VERSION: "1.21.54" }), "2d5f9c0cb89af6250974d29aa598cae5e18607d3");
  assert.equal(resolveWebRelease(null, { VITE_APP_VERSION: "1.21.54" }), "1.21.54");
  assert.equal(resolveWebRelease(null, undefined), packageVersion);
});
