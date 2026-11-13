import type { Request, Response } from "express";
import { CURRENT_PRIVACY_VERSION } from "@botiverse/raft-shared";
import { evaluateFeatureFlag } from "./featureFlagService";
import { runtimeFormCopyLocale } from "./runtimeFormV2Copy";

/**
 * Old mobile apps (1.14.x and earlier) sign in and create accounts through the
 * native `POST /api/auth/mobile/oauth/start` + `/complete` pair and accept a
 * legal version they hard-code. Current apps sign in through the browser
 * (`/api/auth/app-login/*`), where the web shows the current terms. With this
 * flag on, the two native sign-in routes answer "update the app" instead.
 *
 * The same flag also gates `POST /api/auth/register` when it carries the privacy
 * version those apps hard-code ({@link LEGACY_APP_PRIVACY_VERSION}) and the server's
 * current version is newer; stale web tabs send it too, so that text also says
 * "refresh the page".
 *
 * Global, default off (a missing row is off). There is no user or server before
 * sign-in, so turn it on with a `platform` allow rule for `mobile`. Provider linking
 * (`/mobile/oauth/:provider/link/*`) and native Apple `start`/`authorize` are not
 * gated. See docs/operations/legacy-mobile-oauth-upgrade.md.
 */
export const LEGACY_MOBILE_OAUTH_UPGRADE_REQUIRED_FLAG = "legacy_mobile_oauth_upgrade_required_v0";

export const APP_UPDATE_REQUIRED_CODE = "APP_UPDATE_REQUIRED";

/** The privacy version the 1.14.x and older apps hard-code. Fixed: it names those apps, not "the previous version". */
export const LEGACY_APP_PRIVACY_VERSION = "2026-05-12";

type UpgradeMessages = { en: string; "zh-cn": string; ja: string };

const APP_UPDATE_REQUIRED_MESSAGES: UpgradeMessages = {
  en: "This version of Raft is no longer supported. Download the latest version at app.raft.build/download, then sign in.",
  "zh-cn": "当前版本过旧，请访问 app.raft.build/download 下载最新版 Raft 后再登录。",
  ja: "このバージョンの Raft はサポートが終了しました。app.raft.build/download から最新版をダウンロードしてログインしてください。",
};

const REGISTER_UPDATE_REQUIRED_MESSAGES: UpgradeMessages = {
  en: "Please refresh the page, or download the latest Raft at app.raft.build/download, to sign up.",
  "zh-cn": "请刷新页面，或访问 app.raft.build/download 下载最新版 Raft 后再注册。",
  ja: "ページを再読み込みするか、app.raft.build/download から最新版の Raft をダウンロードしてから登録してください。",
};

function localizedMessage(messages: UpgradeMessages, acceptLanguage: string | undefined): string {
  const locale = runtimeFormCopyLocale(acceptLanguage);
  return locale === "zh-cn" || locale === "ja" ? messages[locale] : messages.en;
}

/** The message for an `Accept-Language` header: zh-CN or Japanese when asked for, else English. */
export function appUpdateRequiredMessage(acceptLanguage: string | undefined): string {
  return localizedMessage(APP_UPDATE_REQUIRED_MESSAGES, acceptLanguage);
}

/** The register variant of {@link appUpdateRequiredMessage}: also tells a stale web tab to refresh. */
export function registerUpdateRequiredMessage(acceptLanguage: string | undefined): string {
  return localizedMessage(REGISTER_UPDATE_REQUIRED_MESSAGES, acceptLanguage);
}

/**
 * True when a sign-up's privacy version is the legacy apps' one and the server has
 * moved past it. While the server's current version is still the legacy one, the
 * current web sends it too, so nothing is blocked. Versions are ISO dates.
 */
export function isOutdatedLegacyPrivacyVersion(
  requested: unknown,
  currentPrivacyVersion: string = CURRENT_PRIVACY_VERSION,
): boolean {
  return requested === LEGACY_APP_PRIVACY_VERSION && currentPrivacyVersion > LEGACY_APP_PRIVACY_VERSION;
}

async function flagEnabled(evaluateFlag: typeof evaluateFeatureFlag): Promise<boolean> {
  const { enabled } = await evaluateFlag({ key: LEGACY_MOBILE_OAUTH_UPGRADE_REQUIRED_FLAG, platform: "mobile" });
  return enabled;
}

function answerUpdateRequired(res: Response, message: string) {
  res.vary("Accept-Language");
  res.status(426).json({ error: message, message, code: APP_UPDATE_REQUIRED_CODE });
}

/**
 * Answers 426 when the flag is on and returns true; otherwise leaves the request alone.
 * Old apps show `error` verbatim (they read `error` before `message`), so both carry the text.
 */
export async function rejectLegacyMobileOAuthLogin(
  req: Request,
  res: Response,
  evaluateFlag: typeof evaluateFeatureFlag = evaluateFeatureFlag,
): Promise<boolean> {
  if (!(await flagEnabled(evaluateFlag))) return false;
  answerUpdateRequired(res, appUpdateRequiredMessage(req.get("accept-language")));
  return true;
}

/**
 * Answers 426 when the flag is on and the register body carries the legacy privacy
 * version while the server's current one is newer; otherwise leaves the request alone.
 */
export async function rejectLegacyPrivacyVersionRegister(
  req: Request,
  res: Response,
  options: { evaluateFlag?: typeof evaluateFeatureFlag; currentPrivacyVersion?: string } = {},
): Promise<boolean> {
  const privacyVersion = (req.body as { privacyVersion?: unknown } | undefined)?.privacyVersion;
  if (!isOutdatedLegacyPrivacyVersion(privacyVersion, options.currentPrivacyVersion)) return false;
  if (!(await flagEnabled(options.evaluateFlag ?? evaluateFeatureFlag))) return false;
  answerUpdateRequired(res, registerUpdateRequiredMessage(req.get("accept-language")));
  return true;
}
