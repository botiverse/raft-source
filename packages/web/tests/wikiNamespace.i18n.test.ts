import assert from "node:assert/strict";
import test from "node:test";
import { createIntl, createIntlCache } from "react-intl";
import { en } from "../src/i18n/messages/en";
import type { MessageId } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

const cache = createIntlCache();
const wikiMessageIds = [
  "wiki.ingest.completed",
  "wiki.ingest.receiptTimeout",
  "wiki.ingest.alreadyUpToDate",
  "wiki.initialize.flowDescription",
  "wiki.init.requestedAt",
  "wiki.status.nextIngest",
  "wiki.status.nextLint",
  "wiki.status.pendingSetup",
  "wiki.settings",
  "wiki.settings.maintenance",
  "wiki.reset.title",
  "wiki.reset.action",
  "wiki.reset.description",
  "wiki.reset.confirmation",
  "wiki.reset.loading",
  "wiki.reset.completed",
  "wiki.reset.failed",
  "wiki.reset.failedReminders",
] as const satisfies readonly MessageId[];

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([a-zA-Z][\w]*)\}/g)]
    .map((match) => match[1]!)
    .sort();
}

test("Wiki message keys are complete in en and zh-cn with matching placeholders", () => {
  for (const id of wikiMessageIds) {
    assert.ok(en[id], `en is missing ${id}`);
    assert.ok(zhCn[id], `zh-cn is missing ${id}`);
    assert.deepEqual(
      placeholders(zhCn[id]),
      placeholders(en[id]),
      `${id} placeholders differ between en and zh-cn`,
    );
  }
});

test("Wiki status copy formats in the default and Chinese locales", () => {
  const enIntl = createIntl({ locale: "en", defaultLocale: "en", messages: en }, cache);
  const zhIntl = createIntl({ locale: "zh-cn", defaultLocale: "en", messages: zhCn }, cache);

  assert.equal(
    enIntl.formatMessage({ id: "wiki.status.nextIngest" }, { date: "Sunday 02:30" }),
    "Next ingest Sunday 02:30",
  );
  assert.equal(
    zhIntl.formatMessage({ id: "wiki.status.nextIngest" }, { date: "周日 02:30" }),
    "下次摄取：周日 02:30",
  );
  assert.equal(
    zhIntl.formatMessage({ id: "wiki.ingest.completed" }),
    "Wiki 摄取已完成。",
  );
  assert.doesNotMatch(
    zhIntl.formatMessage({ id: "wiki.initialize.flowDescription" }),
    /\bDaily ingest\b|\bmanual Refresh\b|\bweekly Lint audits\b/u,
  );
});
