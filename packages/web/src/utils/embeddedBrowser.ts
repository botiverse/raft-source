/**
 * In-app browsers (WeChat, QQ, DingTalk, Feishu, ...): OAuth providers refuse
 * them, and their "share" menus copy the page title into the shared card.
 */
const EMBEDDED_BROWSER_USER_AGENT_PATTERNS = [
  /MicroMessenger/i,
  /DingTalk/i,
  /Lark|Feishu/i,
  /FBAN|FBAV|FB_IAB/i,
  /Instagram/i,
  /Line\//i,
  // QQ's in-app browser ("QQ/8.9"). Not MQQBrowser: that is also the
  // standalone QQ Browser, a full browser people sign in with normally.
  /\bQQ\//,
  /Weibo/i,
  /Twitter/i,
  /;\s*wv\)/i,
];

export function isEmbeddedBrowserUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return EMBEDDED_BROWSER_USER_AGENT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

export function isEmbeddedBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return isEmbeddedBrowserUserAgent(navigator.userAgent);
}
