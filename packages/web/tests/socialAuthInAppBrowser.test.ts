import assert from "node:assert/strict";
import test from "node:test";
import {
  isEmbeddedBrowserUserAgent,
  isEmbeddedUserAgentProviderError,
  sanitizeReturnTo,
} from "../src/utils/socialAuth.js";

test("embedded browser detection covers common app webviews", () => {
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 MicroMessenger/8.0.49 Mobile/15E148"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 DingTalk/7.0 Mobile"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Lark/7.0 Mobile"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Feishu/7.0 Mobile"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 FBAN/FBIOS FBAV/1.0"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Instagram 300.0.0 Mobile"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Line/13.0 Mobile"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Weibo Mobile"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Twitter for iPhone"), true);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Linux; Android 13; wv) AppleWebKit/537.36"), true);
});

test("embedded browser detection leaves normal browsers alone", () => {
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36"), false);
  assert.equal(isEmbeddedBrowserUserAgent("Mozilla/5.0 Version/17.0 Mobile/15E148 Safari/604.1"), false);
  assert.equal(isEmbeddedBrowserUserAgent(null), false);
});

test("provider-side embedded user-agent errors use the browser guide", () => {
  assert.equal(isEmbeddedUserAgentProviderError("disallowed_useragent"), true);
  assert.equal(isEmbeddedUserAgentProviderError("access_denied"), false);
  assert.equal(sanitizeReturnTo("//evil.example/path"), "/");
  assert.equal(sanitizeReturnTo("/\\evil.example/path"), "/");
  assert.equal(sanitizeReturnTo("/%5cevil.example/path"), "/");
  assert.equal(sanitizeReturnTo("/%2e%2e//evil.example/path"), "/");
  assert.equal(sanitizeReturnTo("/a/..//evil.example/path"), "/");
  assert.equal(
    sanitizeReturnTo("/settings?tab=account#connected-apps"),
    "/settings?tab=account#connected-apps",
  );
});
