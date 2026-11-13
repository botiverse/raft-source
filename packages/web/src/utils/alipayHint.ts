/**
 * Whether the upgrade dialog offers paying once with Alipay (task #19; cindyz,
 * #proj-commercial:1d784041): only for someone who is likely a Chinese reader,
 * so nobody else sees a payment method they have no use for. Any one hint is
 * enough: Raft in Chinese, a Chinese language in the browser, or a time zone in
 * mainland China, Hong Kong, Macau or Taiwan. A prepaid server always renews
 * with Alipay, whatever these say (the dialog decides that, not this).
 */

// IANA zones and the legacy aliases browsers may still resolve to.
const CHINESE_TIME_ZONES = new Set([
  "Asia/Shanghai", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar", "PRC",
  "Asia/Hong_Kong", "Hongkong",
  "Asia/Macau", "Asia/Macao",
  "Asia/Taipei", "ROC",
]);

function isChineseLanguage(tag: string | undefined | null): boolean {
  return typeof tag === "string" && /^zh(?:-|$)/i.test(tag);
}

export interface AlipayHintSources {
  uiLocale: string;
  browserLanguages?: readonly string[];
  timeZone?: string;
}

export function readAlipayHintSources(uiLocale: string): AlipayHintSources {
  let browserLanguages: readonly string[] = [];
  let timeZone: string | undefined;
  try {
    // Some WebViews leave `languages` empty or undefined but set `language`.
    browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language];
  } catch {
    // No navigator: the UI locale still counts.
  }
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // No time zone: the other hints still count.
  }
  return { uiLocale, browserLanguages, timeZone };
}

export function showsAlipayOption({ uiLocale, browserLanguages = [], timeZone }: AlipayHintSources): boolean {
  return isChineseLanguage(uiLocale)
    || browserLanguages.some(isChineseLanguage)
    || (timeZone !== undefined && CHINESE_TIME_ZONES.has(timeZone));
}
