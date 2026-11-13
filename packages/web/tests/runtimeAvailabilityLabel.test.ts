import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { isRuntimeDeprecated } from "@botiverse/raft-shared";

import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { en as enMessages } from "../src/i18n/messages/en";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelBesideBadge, formatRuntimeLabelWithStatus, runtimeShowsExperimentalBadge } from "../src/utils/runtimeAvailabilityLabel";

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
    "（需要更新）",
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
    " (update required)",
  );
});

// Qwen Code and Qoder have not run end to end on a real account in Raft yet:
// wherever a runtime is named, they say so (#proj-runtime:a5762001).
test("experimental runtimes are labelled wherever a runtime is named; others are not", () => {
  const enLabel = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  assert.equal(formatRuntimeLabelWithStatus("qoder", enLabel.formatMessage, isRuntimeDeprecated("qoder")), "Qoder (experimental)");
  assert.equal(formatRuntimeLabelWithStatus("qwen", enLabel.formatMessage, isRuntimeDeprecated("qwen")), "Qwen Code (experimental)");
  assert.equal(formatRuntimeLabelWithStatus("qoder", zhIntl.formatMessage, isRuntimeDeprecated("qoder")), "Qoder（实验性）");
  assert.equal(formatRuntimeLabelWithStatus("claude", enLabel.formatMessage, isRuntimeDeprecated("claude")), "Claude Code");
  assert.equal(formatRuntimeLabelWithStatus("gemini", enLabel.formatMessage, isRuntimeDeprecated("gemini")), "Gemini CLI (deprecated)");
});

// Runtime pickers draw raft-ui's Badge.Experimental (the Computer page chips keep the text)
// instead of the "(experimental)" text; deprecated still says so in text.
test("beside a badge, an experimental runtime is its bare name; a deprecated one keeps its suffix", () => {
  const enLabel = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  assert.equal(formatRuntimeLabelBesideBadge("qoder", enLabel.formatMessage, isRuntimeDeprecated("qoder")), "Qoder");
  assert.equal(runtimeShowsExperimentalBadge("qoder", isRuntimeDeprecated("qoder")), true);
  assert.equal(runtimeShowsExperimentalBadge("qwen", isRuntimeDeprecated("qwen")), true);
  assert.equal(runtimeShowsExperimentalBadge("claude", isRuntimeDeprecated("claude")), false);
  assert.equal(formatRuntimeLabelBesideBadge("gemini", enLabel.formatMessage, isRuntimeDeprecated("gemini")), "Gemini CLI (deprecated)");
  assert.equal(runtimeShowsExperimentalBadge("gemini", isRuntimeDeprecated("gemini")), false);
});

// The server's answer wins: a runtime it offers again (Antigravity on OAR) is its plain name.
test("a bundled-deprecated runtime the server does not call deprecated has no deprecated suffix", () => {
  const enLabel = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  assert.equal(isRuntimeDeprecated("antigravity"), true, "bundled catalog still deprecates it");
  assert.equal(formatRuntimeLabelWithStatus("antigravity", enLabel.formatMessage, false), "Antigravity CLI");
  assert.equal(formatRuntimeLabelWithStatus("antigravity", enLabel.formatMessage, true), "Antigravity CLI (deprecated)");
  assert.equal(formatRuntimeLabelBesideBadge("antigravity", enLabel.formatMessage, false), "Antigravity CLI");
});
