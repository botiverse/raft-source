import assert from "node:assert/strict";
import { compareComputerVersions, isComputerSemver } from "@botiverse/raft-shared";
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

const SHA = "2D5F9C0CB89AF6250974D29AA598CAE5E18607D3";

test("A staging build without VITE_APP_VERSION names its commit as build metadata", () => {
  assert.equal(
    resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "staging", VITE_COMMIT_SHA: ` ${SHA} ` }, "1.21.54"),
    "1.21.54-staging+2d5f9c0",
  );
  // An all-digit sha with a leading zero stays valid SemVer (build metadata, not a prerelease identifier).
  assert.equal(resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "staging", VITE_COMMIT_SHA: "0123456789" }, "1.21.54"), "1.21.54-staging+0123456");
});

test("A staging build without a usable commit sha keeps the package version", () => {
  assert.equal(resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "staging" }), packageVersion);
  assert.equal(resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "staging", VITE_COMMIT_SHA: "  " }), packageVersion);
  assert.equal(resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "staging", VITE_COMMIT_SHA: "local" }), packageVersion);
});

test("Production and other builds are unchanged: the override, else the package version", () => {
  assert.equal(resolveWebAppVersion({ VITE_APP_VERSION: "1.21.60", VITE_DEPLOYMENT_ENV: "production", VITE_COMMIT_SHA: SHA }), "1.21.60");
  assert.equal(resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "production", VITE_COMMIT_SHA: SHA }), packageVersion);
  assert.equal(resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "web-preview", VITE_COMMIT_SHA: SHA }), packageVersion);
  assert.equal(resolveWebAppVersion({ VITE_COMMIT_SHA: SHA }), packageVersion);
});

test("An explicit VITE_APP_VERSION wins on staging too", () => {
  assert.equal(resolveWebAppVersion({ VITE_APP_VERSION: " 1.21.60 ", VITE_DEPLOYMENT_ENV: "staging", VITE_COMMIT_SHA: SHA }), "1.21.60");
});

test("Staging versions parse on the server as the package release, so web floors see what they saw before", () => {
  const version = resolveWebAppVersion({ VITE_DEPLOYMENT_ENV: "staging", VITE_COMMIT_SHA: "0123456" }, "1.21.54");
  assert.equal(isComputerSemver(version), true);
  assert.equal(compareComputerVersions(version.split("+", 1)[0]!.split("-", 1)[0]!, "1.21.54"), 0);
});
