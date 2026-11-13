import type { Message } from "../store/messageStore";

/**
 * The connected notice: when WeChat is connected, the server writes a system
 * message into the owner's DM with their assistant, with randomId
 * `wechat-connected:<binding id>` (wechatBridgeService.confirmAttempt), so the
 * owner sees it even when someone else scanned the QR code. Web renders it as
 * a card with Disconnect WeChat (WeChatConnectedNotice) instead of an event line.
 */
export const WECHAT_CONNECTED_NOTICE_PREFIX = "wechat-connected:";

export function isWeChatConnectedNotice(message: Pick<Message, "messageType"> & Partial<Pick<Message, "randomId">>): boolean {
  return message.messageType === "system"
    && typeof message.randomId === "string"
    && message.randomId.startsWith(WECHAT_CONNECTED_NOTICE_PREFIX);
}

/** The binding a connected notice names (its randomId `wechat-connected:<binding id>`); null for any other message. */
export function weChatNoticeBindingId(randomId: string | null | undefined): string | null {
  if (typeof randomId !== "string" || !randomId.startsWith(WECHAT_CONNECTED_NOTICE_PREFIX)) return null;
  return randomId.slice(WECHAT_CONNECTED_NOTICE_PREFIX.length) || null;
}
