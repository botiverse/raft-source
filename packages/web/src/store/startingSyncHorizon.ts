import { bootSentHistoryRead } from "../boot/bootPrefetch";
import { messageHistoryRequestsSent } from "./messageStore";

/**
 * Whether the socket's starting sync horizon (socketBridge) may still be taken:
 * no history read has gone out before its reply, neither the app's nor the
 * boot script's (boot/bootPrefetch), whose page went out before the socket
 * existed and brings its own horizon instead (docs/frontend/boot-requests.md).
 */
export function startingSyncHorizonSafe(): boolean {
  return messageHistoryRequestsSent() === 0 && !bootSentHistoryRead();
}
