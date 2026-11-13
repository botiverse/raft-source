import assert from "node:assert/strict";
import {
  createMobileAppEmailUnsubscribeToken,
  mobileAppEmailUnsubscribeUrl,
  verifyMobileAppEmailUnsubscribeToken,
} from "./mobileAppEmailUnsubscribeToken";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORIGINAL_ENV = {
  JWT_SECRET: process.env.JWT_SECRET,
  MOBILE_APP_EMAIL_UNSUBSCRIBE_SECRET: process.env.MOBILE_APP_EMAIL_UNSUBSCRIBE_SECRET,
  SERVER_URL: process.env.SERVER_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("mobile-app unsubscribe tokens are signed, purpose-bound, and do not expose email", () => {
  process.env.JWT_SECRET = "test-mobile-email-secret";
  delete process.env.MOBILE_APP_EMAIL_UNSUBSCRIBE_SECRET;

  const token = createMobileAppEmailUnsubscribeToken(USER_ID, "zh-CN");

  assert.deepEqual(verifyMobileAppEmailUnsubscribeToken(token), {
    userId: USER_ID,
    locale: "zh-cn",
  });
  assert.equal(verifyMobileAppEmailUnsubscribeToken(`${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`), null);
  assert.equal(verifyMobileAppEmailUnsubscribeToken(`${token}.extra`), null);
  assert.doesNotMatch(token, /@|example\.com/);
});

test("mobile-app unsubscribe URLs use the public server origin", () => {
  process.env.JWT_SECRET = "test-mobile-email-secret";
  process.env.SERVER_URL = "https://api.raft.test/internal/path";

  const url = new URL(mobileAppEmailUnsubscribeUrl(USER_ID));

  assert.equal(url.origin, "https://api.raft.test");
  assert.equal(url.pathname, "/api/email/mobile-app/unsubscribe");
  assert.deepEqual(verifyMobileAppEmailUnsubscribeToken(url.searchParams.get("token")), {
    userId: USER_ID,
    locale: "en",
  });
});
