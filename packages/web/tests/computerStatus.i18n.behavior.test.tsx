import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import {
  getComputerAttentionTitle,
  getComputerAttentionTitleDescriptor,
} from "../src/utils/computerUpgradeIndicator";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

test("catalog pins computer-status MessageIds with ICU version", () => {
  assert.equal(en["machine.attention.offline"], "Computer offline");
  assert.equal(en["machine.attention.status"], "Computer status");
  assert.equal(en["machine.attention.upgradeAvailable"], "Computer upgrade available");
  assert.equal(
    en["machine.attention.upgradeAvailableWithVersion"],
    "Computer upgrade available: v{version}",
  );
  assert.match(en["machine.attention.upgradeAvailableWithVersion"], /\{version\}/);
  assert.match(zh["machine.attention.upgradeAvailableWithVersion"], /\{version\}/);
  assert.match(zh["machine.attention.offline"], /\p{Script=Han}/u);
});

test("getComputerAttentionTitle falls back through English catalog", () => {
  assert.equal(getComputerAttentionTitle("offline"), en["machine.attention.offline"]);
  assert.equal(getComputerAttentionTitle("none"), en["machine.attention.status"]);
  assert.equal(getComputerAttentionTitle("upgrade"), en["machine.attention.upgradeAvailable"]);
  assert.equal(
    getComputerAttentionTitle("upgrade", "1.2.3"),
    "Computer upgrade available: v1.2.3",
  );
});

test("title descriptor formats through zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  const descriptor = getComputerAttentionTitleDescriptor("upgrade", "9.9.9");
  assert.equal(
    zhIntl.formatMessage({ id: descriptor.id }, descriptor.values),
    zh["machine.attention.upgradeAvailableWithVersion"].replace("{version}", "9.9.9"),
  );
  assert.equal(
    zhIntl.formatMessage({ id: getComputerAttentionTitleDescriptor("offline").id }),
    zh["machine.attention.offline"],
  );
});

test("computer attention decisions expose structured catalog descriptors", () => {
  assert.deepEqual(getComputerAttentionTitleDescriptor("upgrade"), {
    id: "machine.attention.upgradeAvailable",
  });
  assert.deepEqual(getComputerAttentionTitleDescriptor("upgrade", "1.2.3"), {
    id: "machine.attention.upgradeAvailableWithVersion",
    values: { version: "1.2.3" },
  });
  assert.deepEqual(getComputerAttentionTitleDescriptor("offline"), {
    id: "machine.attention.offline",
  });
  assert.deepEqual(getComputerAttentionTitleDescriptor("none"), {
    id: "machine.attention.status",
  });
});
