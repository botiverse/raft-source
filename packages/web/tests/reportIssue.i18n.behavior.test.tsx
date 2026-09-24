import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins report-issue title MessageId with ICU", () => {
  assert.equal(en["agent.reportIssue.titleForAgent"], "Issue report for {name}");
  assert.match(en["agent.reportIssue.titleForAgent"], /\{name\}/);
  assert.match(zh["agent.reportIssue.titleForAgent"], /\{name\}/);
  assert.match(zh["agent.reportIssue.titleForAgent"], /\p{Script=Han}/u);
});

test("catalog pins the default-includes disclosure word for word", () => {
  assert.equal(
    en["agent.reportIssue.defaultIncludedDisclosure"],
    "These are included by default — untick anything you don't want to send.",
  );
  assert.equal(
    zh["agent.reportIssue.defaultIncludedDisclosure"],
    "以上默认包含——不想发送的请取消勾选。",
  );
});

test("report-issue title formats under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(
    zhIntl.formatMessage({ id: "agent.reportIssue.titleForAgent" }, { name: "Ada" }),
    zh["agent.reportIssue.titleForAgent"].replace("{name}", "Ada"),
  );
});
