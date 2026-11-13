import { PHONE_MEDIA_QUERY } from "../components/ui/NarrowDialog";
import { useMediaQuery } from "../hooks/effectPrimitives";
import { useServerStore } from "../store/serverStore";
import { isElectronDesktopShell, shareableWebOrigin } from "../utils/desktopShell";

/**
 * Where connecting WeChat can't finish, so no QR code is shown:
 *
 * - `desktop`: the desktop app. Its pages are served from app://raft and
 *   talk to the API on https://api.raft.build, another site, so the attempt's
 *   SameSite=Lax cookie is neither stored from the start's answer nor sent
 *   with a poll: every poll would be refused (403 wechat_attempt_unbound)
 *   after the person scanned. The dialog offers Open in Browser instead.
 * - `phone`: a phone-width screen. The code has to be scanned with WeChat on
 *   the person's phone, which is this screen (as MobileDownloadQr, a code
 *   shown on the device that must scan it is no use). Saving it to the photo
 *   album to scan from there would leave it in the album, where anyone who
 *   sees it could connect their WeChat instead: the dialog says to connect
 *   from a computer.
 *
 * Read before the first paint (useMediaQuery's first state), so the dialog
 * opens in its final shape. Disconnecting works everywhere.
 */
export type WeChatConnectBlock = "desktop" | "phone" | null;

export function useWeChatConnectBlock(): WeChatConnectBlock {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  if (isElectronDesktopShell()) return "desktop";
  return phone ? "phone" : null;
}

/**
 * The assistant page of the current server in the web app, for Open in
 * Browser in the desktop app: the browser-openable origin (VITE_FRONTEND_URL
 * there, not app://raft), where connecting works. Null without a server.
 */
export function useWeChatConnectWebUrl(): string | null {
  const slug = useServerStore((s) => s.current?.slug ?? null);
  return slug ? `${shareableWebOrigin()}/s/${encodeURIComponent(slug)}/assistant` : null;
}
