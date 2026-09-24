import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  DEFAULT_APP_URL,
  getAppPermalinkHostnames,
  getAppUrl,
  getConfiguredAppUrl,
  getWebCorsOriginOption,
  getWebCorsOrigins,
  getWebFrameAncestorOrigins,
  normalizeAppUrl,
} from "./appUrl.js";

const ORIGINAL_ENV = {
  APP_URL: process.env.APP_URL,
  APP_PERMALINK_HOSTS: process.env.APP_PERMALINK_HOSTS,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
};

afterEach(() => {
  if (ORIGINAL_ENV.APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_ENV.APP_URL;
  if (ORIGINAL_ENV.APP_PERMALINK_HOSTS === undefined) delete process.env.APP_PERMALINK_HOSTS;
  else process.env.APP_PERMALINK_HOSTS = ORIGINAL_ENV.APP_PERMALINK_HOSTS;
  if (ORIGINAL_ENV.CORS_ORIGIN === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = ORIGINAL_ENV.CORS_ORIGIN;
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
  ]);
});

test("web CORS origins preserve explicit wildcard behavior", () => {
  process.env.APP_URL = "https://chat.example.com";
  process.env.CORS_ORIGIN = "*";

  assert.deepEqual(getWebCorsOrigins(), ["*"]);
});

test("socket CORS origin option includes APP_URL when CORS_ORIGIN is unset", () => {
  process.env.APP_URL = "https://chat.example.com";
  delete process.env.CORS_ORIGIN;

  assert.equal(getWebCorsOriginOption(), "https://chat.example.com");
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
