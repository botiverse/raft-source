import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { en as enMessages } from "../src/i18n/messages/en";
import { formatRuntimeAvailabilitySuffix } from "../src/utils/runtimeAvailabilityLabel";

// Behavior guard for the shared-classifier → catalog bridge (PR #5967):
// runtimeAvailabilitySuffix returns a KIND (locale-free); this bridge maps it
// to the catalog id and formats. Before the fix the suffixes were English
// literals in @botiverse/raft-shared ("(not installed)"/"(update computer)") that
// leaked into the zh DOM (verified in the browser sweep). A swapped or missing
// mapping now goes RED here.

const zhIntl = createIntl({ locale: "zh-cn", messages: zhMessages as Record<string, string> });

test("zh runtime availability suffixes render the ruled catalog text", () => {
  assert.equal(
    formatRuntimeAvailabilitySuffix({ kind: "notInstalled" }, zhIntl.formatMessage),
    "（未安装）",
  );
  assert.equal(
    formatRuntimeAvailabilitySuffix({ kind: "updateComputer" }, zhIntl.formatMessage),
    "（需更新计算机）",
  );
  assert.equal(
    formatRuntimeAvailabilitySuffix({ kind: "comingSoon" }, zhIntl.formatMessage),
    "（即将推出）",
  );
  assert.equal(
    formatRuntimeAvailabilitySuffix({ kind: "none" }, zhIntl.formatMessage),
    "",
  );
});

test("en runtime availability suffixes render the English catalog text", () => {
  const enIntl = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  assert.equal(
    formatRuntimeAvailabilitySuffix({ kind: "notInstalled" }, enIntl.formatMessage),
    " (not installed)",
  );
  assert.equal(
    formatRuntimeAvailabilitySuffix({ kind: "updateComputer" }, enIntl.formatMessage),
    " (update computer)",
  );
});
