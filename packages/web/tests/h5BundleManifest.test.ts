import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildH5BundleManifest,
  documentHeadersFromHeadersFile,
  isBundledPath,
  validateHosts,
} from "../scripts/build-h5-bundle";

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash("sha256").update(bytes(text)).digest("hex");

const HEADERS = [
  "/*",
  "  Cache-Control: no-cache",
  "  Content-Security-Policy: base-uri 'self'; object-src 'none'",
  "  X-Frame-Options: DENY",
  "  Referrer-Policy: no-referrer",
  "  X-Content-Type-Options: nosniff",
  "",
  "/assets/*",
  "  ! Cache-Control",
  "  Cache-Control: public, max-age=31536000, immutable",
  "  Referrer-Policy: origin",
].join("\n");

const input = (overrides: Record<string, unknown> = {}) => ({
  files: [
    { path: "index.html", bytes: bytes("<!doctype html>") },
    { path: "assets/app-AAAAAAAA.js", bytes: bytes("console.log(1)") },
    { path: "assets/app-BBBBBBBB.css", bytes: bytes("body{}") },
    { path: "sw.js", bytes: bytes("self") },
    { path: "_headers", bytes: bytes(HEADERS) },
    { path: "_worker.js", bytes: bytes("export default {}") },
    { path: ".vite/manifest.json", bytes: bytes("{}") },
  ],
  config: { runtimeId: "raft-embedded-web-v1", hosts: { android: { minVersionCode: 120, requiredCapabilities: ["offline-bundle"] } } },
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  committedAt: "2026-10-05T07:00:00.000Z",
  webVersion: "1.17.5",
  headersText: HEADERS,
  ...overrides,
});

test("the manifest lists every bundled file with its own digest, size and content type", () => {
  const manifest = buildH5BundleManifest(input());

  assert.deepEqual(manifest.files, [
    { path: "/assets/app-AAAAAAAA.js", sha256: sha("console.log(1)"), size: 14, contentType: "text/javascript; charset=utf-8" },
    { path: "/assets/app-BBBBBBBB.css", sha256: sha("body{}"), size: 6, contentType: "text/css; charset=utf-8" },
    { path: "/index.html", sha256: sha("<!doctype html>"), size: 15, contentType: "text/html; charset=utf-8" },
  ]);
  assert.equal(manifest.totalSize, 35);
  assert.equal(manifest.entry, "/index.html");
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.createdAt, "2026-10-05T07:00:00.000Z");
  assert.equal(manifest.runtimeId, "raft-embedded-web-v1");
  // Draft-contract fields a build must not emit: no download location, no mutable "latest" pointer.
  assert.equal(JSON.stringify(manifest).includes("\"url\""), false);
});

test("deployment plumbing and the service worker never enter the bundle", () => {
  for (const path of ["sw.js", "_headers", "_routes.json", "_worker.js", ".vite/manifest.json", "robots.txt", "assets/app-abcd1234.js.br"]) {
    assert.equal(isBundledPath(path), false, path);
  }
  assert.equal(isBundledPath("assets/sw.js-AAAAAAAA.js"), true);
  assert.ok(buildH5BundleManifest(input()).networkOnly.includes("/sw.js"));
});

test("the bundle identity follows the content, not only the commit", () => {
  const first = buildH5BundleManifest(input());
  const again = buildH5BundleManifest(input());
  assert.deepEqual(again, first, "same input reproduces the manifest byte for byte");

  const changed = input();
  (changed.files as Array<{ path: string; bytes: Uint8Array }>)[1]!.bytes = bytes("console.log(2)");
  assert.notEqual(buildH5BundleManifest(changed).buildId, first.buildId, "same commit, different bytes");
  assert.match(first.buildId, /^1\.17\.5-0123456789ab-[0-9a-f]{12}$/);
});

test("document headers come from the site-wide block and only the ones a host must reproduce", () => {
  assert.deepEqual(documentHeadersFromHeadersFile(HEADERS), {
    "Content-Security-Policy": "base-uri 'self'; object-src 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
});

test("a host is listed only with real values from its owner; there is no default", () => {
  assert.throws(() => buildH5BundleManifest(input({ config: { runtimeId: "r", hosts: {} } })), /lists no host/);
  assert.throws(() => validateHosts({ android: { minVersionCode: null, requiredCapabilities: [] } }), /minVersionCode/);
  assert.throws(() => validateHosts({ android: { minVersionCode: 1 } }), /requiredCapabilities/);
  assert.throws(() => validateHosts({ android: { minVersionCode: 5, maxVersionCode: 0, requiredCapabilities: [] } }), /maxVersionCode/);
  assert.throws(() => validateHosts({ android: { minVersionCode: 5, maxVersionCode: 4, requiredCapabilities: [] } }), /below minVersionCode/);
  assert.throws(() => validateHosts({ android: { minVersionCode: 5, requiredCapabilities: ["a", "a"] } }), /distinct/);
  assert.throws(() => validateHosts({ windows: { minVersionCode: 1, requiredCapabilities: [] } }), /Unknown host/);
  assert.throws(() => buildH5BundleManifest(input({ config: { runtimeId: "", hosts: { android: { minVersionCode: 1, requiredCapabilities: [] } } } })), /runtimeId/);
});

test("each platform states its minimum in its own version form", () => {
  const capabilities = { requiredCapabilities: [] };
  const hosts = {
    android: { minVersionCode: 120, ...capabilities },
    ohos: { minVersionCode: 7, maxVersionCode: 9, ...capabilities },
    ios: { minBuildVersion: "412.3", ...capabilities },
    electron: { minAppVersion: "0.1.40", ...capabilities },
  };
  assert.equal(validateHosts(hosts), hosts);
  assert.deepEqual(buildH5BundleManifest(input({ config: { runtimeId: "r", hosts } })).hosts, hosts);

  // iOS build numbers are not integers and are not squeezed into one.
  assert.throws(() => validateHosts({ ios: { minBuildVersion: 412, ...capabilities } }), /minBuildVersion/);
  assert.throws(() => validateHosts({ ios: { minBuildVersion: "1.2.3.4", ...capabilities } }), /minBuildVersion/);
  assert.throws(() => validateHosts({ ios: { minVersionCode: 412, ...capabilities } }), /does not use: minVersionCode/);
  assert.throws(() => validateHosts({ electron: { minAppVersion: "0.1", ...capabilities } }), /minAppVersion/);
  assert.throws(() => validateHosts({ android: { minVersionCode: "120", ...capabilities } }), /minVersionCode/);
});

test("a version range that no host can satisfy is rejected, by each platform's own comparison", () => {
  const capabilities = { requiredCapabilities: [] };
  const range = (name: string, min: unknown, max: unknown) => {
    const field = name === "ios" ? "BuildVersion" : name === "electron" ? "AppVersion" : "VersionCode";
    return { [name]: { [`min${field}`]: min, [`max${field}`]: max, ...capabilities } };
  };

  for (const [name, min, max] of [
    ["android", 5, 4],
    ["ohos", 9, 8],
    ["ios", "10.2", "10.1"],
    ["ios", "10.10", "10.2"], // numeric parts: 10.10 is above 10.2
    ["ios", "10.0.1", "10"], // a missing part counts as zero
    ["electron", "2.0.0", "1.0.0"],
    ["electron", "0.10.0", "0.9.9"],
  ] as const) {
    assert.throws(() => validateHosts(range(name, min, max)), /below min/, `${name} ${min}..${max}`);
  }

  for (const [name, min, max] of [
    ["android", 5, 5],
    ["android", 5, 6],
    ["ios", "10.2", "10.2"],
    ["ios", "10", "10.0.0"], // equal once the missing parts are zero
    ["ios", "10.2", "10.10"],
    ["electron", "1.0.0", "1.0.0"],
    ["electron", "0.9.9", "0.10.0"],
  ] as const) {
    assert.doesNotThrow(() => validateHosts(range(name, min, max)), `${name} ${min}..${max}`);
  }
});

test("unsafe paths, unknown file types, a short commit id and a missing entry stop the build", () => {
  const withFile = (path: string) => input({ files: [{ path: "index.html", bytes: bytes("x") }, { path, bytes: bytes("x") }] });
  assert.throws(() => buildH5BundleManifest(withFile("assets/a b.js")), /not allowed/);
  assert.throws(() => buildH5BundleManifest(withFile("assets/%2e%2e/a.js")), /not allowed/);
  assert.throws(() => buildH5BundleManifest(withFile("assets/../a.js")), /not allowed/);
  assert.throws(() => buildH5BundleManifest(withFile("assets/tool.exe")), /No content type/);
  assert.throws(() => buildH5BundleManifest(input({ gitSha: "0123456" })), /40-character/);
  assert.throws(() => buildH5BundleManifest(input({ files: [{ path: "assets/a.js", bytes: bytes("x") }] })), /index\.html/);
});

test("the checked-in config names a runtime and has not been given placeholder host versions", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(new URL("../h5-bundle.config.json", import.meta.url), "utf8"));
  assert.equal(typeof config.runtimeId, "string");
  // Throws while no host is listed; once an owner adds one it must carry valid values.
  if (Object.keys(config.hosts).length > 0) validateHosts(config.hosts);
});
