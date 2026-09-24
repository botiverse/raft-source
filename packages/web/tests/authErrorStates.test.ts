import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FormField from "../src/components/ui/FormField.js";
import { createIntl } from "react-intl";
import {
  AUTH_MESSAGE_IDS,
  authServerErrorMessage,
  isValidEmailFormat,
} from "../src/components/auth/authErrors.js";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

// AUTH_COPY held five English sentences shared by four auth pages, so each page
// could migrate, scan clean, and still show English the moment a field failed.
// It is now a table of MessageIds and the mapper takes formatMessage.
const enMessages = en as Record<string, string>;
const zhMessages = zhCn as Record<string, string>;
const intl = createIntl({ locale: "en", messages: enMessages });
const zhIntl = createIntl({ locale: "zh-cn", messages: zhMessages });
const fmt = intl.formatMessage;

test("auth email format validation trims input and rejects malformed addresses", () => {
  assert.equal(isValidEmailFormat(" user@example.com "), true);
  assert.equal(isValidEmailFormat("not-an-email"), false);
  assert.equal(isValidEmailFormat("missing-domain@"), false);
});

test("auth server error mapper uses safe copy for incorrect credentials", () => {
  const safe = enMessages[AUTH_MESSAGE_IDS.incorrectCredentials];
  assert.equal(safe, "Incorrect email or password.", "the rendered English changed");
  assert.equal(
    authServerErrorMessage({ response: { data: { code: "AUTH_INVALID_CREDENTIALS" } } }, "fallback", fmt),
    safe,
  );
  assert.equal(
    authServerErrorMessage({ response: { data: { error: "Invalid email or password" } } }, "fallback", fmt),
    safe,
  );
  // The generic-credentials substitution must be LOCALIZED, not just mapped —
  // this is the one branch that replaces the server's text with our own, so it
  // is the one that would silently stay English.
  assert.equal(
    authServerErrorMessage({ response: { data: { code: "AUTH_INVALID_CREDENTIALS" } } }, "fallback", zhIntl.formatMessage),
    "邮箱或密码不正确。",
  );
  // Server-provided text still wins, and is still passed through as-is. That
  // text is currently English — a known residue that needs the SERVER to emit
  // codes, recorded here rather than hidden by dropping the message.
  assert.equal(
    authServerErrorMessage({ response: { data: { error: "Email is already registered" } } }, "fallback", fmt),
    "Email is already registered",
  );
  assert.equal(authServerErrorMessage({}, "fallback", fmt), "fallback");
});

test("FormField renders inline red errors next to the input", () => {
  const html = renderToStaticMarkup(
    createElement(FormField, { label: "Email", error: fmt({ id: AUTH_MESSAGE_IDS.invalidEmail }) },
      createElement("input", { type: "email" }),
    ),
  );

  assert.match(html, /Email/);
  assert.match(html, /role="alert"/);
  assert.match(html, /text-brutal-red/);
  assert.match(html, /Invalid email format/);
});
