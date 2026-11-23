import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { isRuntimeDeprecated, isRuntimeExperimental, RUNTIMES, SERVER_RUNTIME_CATALOG_VERSION } from "@botiverse/raft-shared";
import type { ServerRuntimeCatalog } from "@botiverse/raft-shared";

import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { en as enMessages } from "../src/i18n/messages/en";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../src/utils/runtimeAvailabilityLabel";
import { isRuntimeDeprecatedOnServer } from "../src/hooks/useServerRuntimeCatalog";

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

// The catalog's experimental flag is not shown anywhere (cindyz, #triage:#524):
// an experimental runtime is its plain name; deprecated still says so.
test("an experimental runtime is its plain name; a deprecated one keeps its suffix", () => {
  const enLabel = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  assert.equal(isRuntimeExperimental("qoder"), true, "the bundled flag is kept");
  assert.equal(formatRuntimeLabelWithStatus("qoder", enLabel.formatMessage, isRuntimeDeprecated("qoder")), "Qoder");
  assert.equal(formatRuntimeLabelWithStatus("qwen", enLabel.formatMessage, isRuntimeDeprecated("qwen")), "Qwen Code");
  assert.equal(formatRuntimeLabelWithStatus("qoder", zhIntl.formatMessage, isRuntimeDeprecated("qoder")), "Qoder");
  assert.equal(formatRuntimeLabelWithStatus("claude", enLabel.formatMessage, isRuntimeDeprecated("claude")), "Claude Code");
  assert.equal(formatRuntimeLabelWithStatus("gemini", enLabel.formatMessage, isRuntimeDeprecated("gemini")), "Gemini CLI (deprecated)");
});

test("Antigravity is not deprecated in the bundled catalog", () => {
  const enLabel = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  assert.equal(isRuntimeDeprecated("antigravity"), false);
  assert.equal(formatRuntimeLabelWithStatus("antigravity", enLabel.formatMessage, isRuntimeDeprecated("antigravity")), "Antigravity CLI");
});

/** A server catalog that lists every bundled runtime, with `overrides` as that server answers them. */
function serverCatalog(overrides: Record<string, { deprecated?: boolean; experimental?: boolean }>): ServerRuntimeCatalog {
  return {
    catalogVersion: SERVER_RUNTIME_CATALOG_VERSION,
    runtimes: RUNTIMES.map((runtime) => ({
      id: runtime.id,
      displayName: runtime.displayName,
      abbreviation: runtime.abbreviation,
      binary: runtime.binary,
      supported: runtime.supported,
      deprecated: overrides[runtime.id]?.deprecated ?? Boolean(runtime.deprecated),
      experimental: overrides[runtime.id]?.experimental ?? Boolean(runtime.experimental),
      oarOnly: false,
      models: [],
      modelsSource: "fallback",
      forms: [{ kind: "generic" }],
    })),
  };
}

test("a server's deprecated answer wins; its experimental answer is not shown", () => {
  const enLabel = createIntl({ locale: "en", messages: enMessages as Record<string, string> });
  const catalog = serverCatalog({ antigravity: { deprecated: true, experimental: true }, claude: { experimental: true } });
  assert.equal(formatRuntimeLabelWithStatus("antigravity", enLabel.formatMessage, isRuntimeDeprecatedOnServer("antigravity", catalog)), "Antigravity CLI (deprecated)");
  assert.equal(formatRuntimeLabelWithStatus("claude", enLabel.formatMessage, isRuntimeDeprecatedOnServer("claude", catalog)), "Claude Code");
});
