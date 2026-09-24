import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const RESIDUE_IDS = [
  "wiki.title",
  "wiki.indexLabel",
  "wiki.logLabel",
  "wiki.agentLabel",
  "wiki.channelNameFallback",
] as const;

test("catalog pins wiki panel residue MessageIds", () => {
  assert.equal(en["wiki.title"], "Wiki");
  assert.equal(en["wiki.indexLabel"], "Index");
  assert.equal(en["wiki.logLabel"], "Log");
  assert.equal(en["wiki.agentLabel"], "Agent");
  assert.equal(en["wiki.channelNameFallback"], "Wiki");
  for (const id of RESIDUE_IDS) {
    assert.ok(zh[id], `zh-cn missing ${id}`);
    assert.equal(zh[id], en[id], `${id} is a product term kept identical in zh-cn`);
  }
});

test("wiki residue ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  assert.equal(zhIntl.formatMessage({ id: "wiki.title" }), "Wiki");
  assert.equal(zhIntl.formatMessage({ id: "wiki.indexLabel" }), "Index");
  assert.equal(zhIntl.formatMessage({ id: "wiki.logLabel" }), "Log");
  assert.equal(zhIntl.formatMessage({ id: "wiki.agentLabel" }), "Agent");
  assert.equal(zhIntl.formatMessage({ id: "wiki.channelNameFallback" }), "Wiki");
});
