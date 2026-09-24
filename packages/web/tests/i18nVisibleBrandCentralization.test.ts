/**
 * Task 7: visible brand findings leave the baseline via catalog IDs (labels /
 * aria) or a typed domain constant (URL fragment) — not broad lint exemptions.
 *
 * Brand product names may intentionally match across locales (en === zh-cn).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { RAFT_APP_SERVER_PATH_PREFIX } from "../src/brand/constants";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const SRC = resolve(WEB_ROOT, "src");

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

/** Visible brand labels/aria — catalog-backed; locales may match intentionally. */
const BRAND_LABEL_IDS = [
  "brand.productName",
  "brand.claudeCode",
  "brand.hermes",
  "brand.deepSeek",
  "brand.apple",
  "brand.github",
  "brand.google",
] as const;

const BRAND_LABEL_EN: Record<(typeof BRAND_LABEL_IDS)[number], string> = {
  "brand.productName": "Raft",
  "brand.claudeCode": "Claude Code",
  "brand.hermes": "Hermes",
  "brand.deepSeek": "DeepSeek",
  "brand.apple": "Apple",
  "brand.github": "GitHub",
  "brand.google": "Google",
};

/** Reviewed brand finding callsites (path relative to packages/web/src). */
const BRAND_CALLSITES: Array<{ path: string; forbidden: RegExp[] }> = [
  {
    path: "components/agent/ExternalSetupTabSegmentedControl.tsx",
    forbidden: [/"Claude Code"/, /"Hermes"/],
  },
  {
    path: "components/auth/ServerCreatePreview.tsx",
    forbidden: [/app\.raft\.build\/s\//],
  },
  {
    path: "components/brand/RaftBrandLockup.tsx",
    forbidden: [/aria-label=["']Raft["']/, />Raft</],
  },
  {
    path: "components/settings/ProviderConnectionsSettings.tsx",
    forbidden: [/"DeepSeek"/],
  },
  {
    path: "components/settings/SettingsPanel.tsx",
    // Connected-app publisher + About wordmark were bare JSX text "Raft".
    forbidden: [/>\s*Raft\s*</],
  },
  {
    path: "pages/AccountBootstrapPreviewPage.tsx",
    forbidden: [/"Apple"/, /"GitHub"/, /"Google"/],
  },
  {
    path: "pages/PaletteAuditPage.tsx",
    forbidden: [/>\s*Claude Code\s*</, /"Claude Code"/],
  },
];

function readSrc(relPath: string): string {
  return readFileSync(resolve(SRC, relPath), "utf8");
}

test("catalog pins brand label MessageIds; en and zh-cn may intentionally match", () => {
  for (const id of BRAND_LABEL_IDS) {
    assert.equal(en[id], BRAND_LABEL_EN[id], `${id} English source drifted`);
    assert.ok(zh[id], `${id} missing from zh-cn`);
    assert.equal(
      zh[id],
      en[id],
      `${id} zh-cn must match English brand spelling (intentional)`,
    );
  }
});

test("protocol/domain fragment app.raft.build/s/ is one typed constant", () => {
  assert.equal(RAFT_APP_SERVER_PATH_PREFIX, "app.raft.build/s/");
  const preview = readSrc("components/auth/ServerCreatePreview.tsx");
  assert.match(
    preview,
    /RAFT_APP_SERVER_PATH_PREFIX/,
    "ServerCreatePreview must render the centralized domain constant",
  );
  assert.doesNotMatch(
    preview,
    /["'`]app\.raft\.build\/s\/["'`]/,
    "ServerCreatePreview must not keep a string literal domain fragment",
  );
});

test("no reviewed brand literal remains at JSX/object callsites", () => {
  for (const { path, forbidden } of BRAND_CALLSITES) {
    const source = readSrc(path);
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `${path} still contains reviewed brand literal matching ${pattern}`,
      );
    }
  }
});

test("baseline has zero brand classification entries after centralization", () => {
  const baseline = JSON.parse(
    readFileSync(resolve(WEB_ROOT, "scripts/i18n-literal-baseline.json"), "utf8"),
  ) as Array<{ classification: string }>;
  const brand = baseline.filter((e) => e.classification === "brand");
  assert.equal(brand.length, 0, `expected 0 brand keys; got ${brand.length}`);
});
