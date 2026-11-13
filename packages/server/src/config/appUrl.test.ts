import assert from "node:assert/strict";
import {
  DEFAULT_APP_URL,
  getAppPermalinkHostnames,
  getAppUrl,
  getConfiguredAppUrl,
  getFramedByOrigins,
  getWebCorsOriginOption,
  getWebCorsOrigins,
  getWebFrameAncestorOrigins,
  normalizeAppUrl,
  RAFT_DESKTOP_APP_ORIGIN,
} from "./appUrl";

const ORIGINAL_ENV = {
  APP_URL: process.env.APP_URL,
  APP_PERMALINK_HOSTS: process.env.APP_PERMALINK_HOSTS,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  FRAMED_BY_ORIGINS: process.env.FRAMED_BY_ORIGINS,
};

afterEach(() => {
  if (ORIGINAL_ENV.APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_ENV.APP_URL;
  if (ORIGINAL_ENV.APP_PERMALINK_HOSTS === undefined) delete process.env.APP_PERMALINK_HOSTS;
  else process.env.APP_PERMALINK_HOSTS = ORIGINAL_ENV.APP_PERMALINK_HOSTS;
  if (ORIGINAL_ENV.CORS_ORIGIN === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = ORIGINAL_ENV.CORS_ORIGIN;
  if (ORIGINAL_ENV.FRAMED_BY_ORIGINS === undefined) delete process.env.FRAMED_BY_ORIGINS;
  else process.env.FRAMED_BY_ORIGINS = ORIGINAL_ENV.FRAMED_BY_ORIGINS;
});

test("app URL config defaults locally and normalizes configured origins", () => {
  delete process.env.APP_URL;

  assert.equal(getConfiguredAppUrl(), null);
  assert.equal(getAppUrl(), DEFAULT_APP_URL);
  assert.equal(normalizeAppUrl("https://chat.example.com/path?ignored=true"), "https://chat.example.com");
});

test("web CORS origins include configured APP_URL without changing API/CDN hosts", () => {
  process.env.APP_URL = "https://chat.example.com";
  process.env.CORS_ORIGIN = "https://old.example.com, https://chat.example.com";

  assert.deepEqual(getWebCorsOrigins(), [
    "https://old.example.com",
    "https://chat.example.com",
    "app://raft",
  ]);
});

test("web CORS origins add exactly Raft Desktop's app://raft origin, once", () => {
  assert.equal(RAFT_DESKTOP_APP_ORIGIN, "app://raft");
  delete process.env.APP_URL;
  delete process.env.CORS_ORIGIN;
  assert.deepEqual(getWebCorsOrigins(), [DEFAULT_APP_URL, "app://raft"]);
  process.env.CORS_ORIGIN = "https://app.raft.build, app://raft";
  assert.deepEqual(getWebCorsOrigins(), ["https://app.raft.build", "app://raft"]);
  // An exact origin: no other app:// host, no wildcard.
  const origins = getWebCorsOrigins();
  assert.equal(origins.filter((origin) => origin.startsWith("app:")).length, 1);
  assert.ok(!origins.includes("*"));
});

test("web CORS origins preserve explicit wildcard behavior", () => {
  process.env.APP_URL = "https://chat.example.com";
  process.env.CORS_ORIGIN = "*";

  assert.deepEqual(getWebCorsOrigins(), ["*"]);
});

test("socket CORS origin option includes APP_URL and the desktop origin when CORS_ORIGIN is unset", () => {
  process.env.APP_URL = "https://chat.example.com";
  delete process.env.CORS_ORIGIN;

  assert.deepEqual(getWebCorsOriginOption(), ["https://chat.example.com", "app://raft"]);
});

test("web frame ancestor origins ignore non-origin CORS entries but keep APP_URL", () => {
  process.env.APP_URL = "https://chat.example.com";
  process.env.CORS_ORIGIN = "*, https://old.example.com";

  assert.deepEqual(getWebFrameAncestorOrigins(), [
    "https://old.example.com",
    "https://chat.example.com",
  ]);
});

test("permalink hosts keep legacy Slock hosts plus configured app hosts", () => {
  process.env.APP_URL = "https://chat.example.com";
  process.env.APP_PERMALINK_HOSTS = "https://www.example.com, alt.example.com";

  assert.deepEqual(getAppPermalinkHostnames(), [
    "app.slock.ai",
    "staging.slock.ai",
    "chat.example.com",
    "www.example.com",
    "alt.example.com",
  ]);
});

test("FRAMED_BY_ORIGINS takes exact https origins, comma or space separated, in order without repeats; unset is none", () => {
  delete process.env.FRAMED_BY_ORIGINS;
  assert.deepEqual(getFramedByOrigins(), []);
  assert.deepEqual(getFramedByOrigins(""), []);
  assert.deepEqual(getFramedByOrigins(" https://deck.raft.build,  https://deck-staging.example.com https://deck.raft.build "), [
    "https://deck.raft.build",
    "https://deck-staging.example.com",
  ]);
  for (const junk of [
    "*",
    "'self'",
    "https://*.raft.build",
    "https://deck.raft.build/",
    "https://deck.raft.build/app",
    "https://Deck.raft.build",
    "http://deck.raft.build",
    "app://raft",
    "https://user@deck.raft.build",
    "https://deck.raft.build;script-src",
    "deck.raft.build",
  ]) {
    assert.throws(() => getFramedByOrigins(`https://deck.raft.build,${junk}`), /FRAMED_BY_ORIGINS/, junk);
  }
});

test("FRAMED_BY_ORIGINS widens no CORS origin and no redirect target (frame ancestors of previews only)", () => {
  process.env.APP_URL = "https://app.raft.build";
  process.env.CORS_ORIGIN = "https://app.raft.build";
  delete process.env.FRAMED_BY_ORIGINS;
  const cors = getWebCorsOrigins();
  const ancestors = getWebFrameAncestorOrigins();
  process.env.FRAMED_BY_ORIGINS = "https://deck.raft.build";
  assert.deepEqual(getWebCorsOrigins(), cors);
  assert.deepEqual(getWebCorsOriginOption(), cors.length === 1 ? cors[0] : cors);
  assert.deepEqual(getWebFrameAncestorOrigins(), ancestors);
  assert.ok(!getWebCorsOrigins().includes("https://deck.raft.build"));
});
