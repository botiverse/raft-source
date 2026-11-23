import { SidebarItemMetaIcon } from "@botiverse/raft-ui";
import type { DesktopWebPreviewMediaKind } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { Volume2, VolumeX } from "lucide-react";
import Tooltip from "../../../components/ui/Tooltip";
import { MediaInUseIcon } from "../../webPreview/BrowserSiteSettings";
import { mediaMessageId } from "../../webPreview/browserSitePermissions";

/**
 * What the built-in browser's kept pages of a conversation are doing while the
 * conversation is not on screen: a page uses the microphone or the camera, or
 * plays sound (muted: the person silenced it). Null or nothing in use: no mark.
 * The caller keeps the object stable (the rows are memo'd).
 */
export type SidebarBrowserInUse = {
  media: readonly DesktopWebPreviewMediaKind[];
  audible: boolean;
  muted: boolean;
};

/**
 * The mark after a row's name (and its @ sticker), before its count, dot or
 * draft pencil: the tab strip's icons (BrowserTabStrip). A device in use is the
 * red recording light (MediaInUseIcon), and wins over sound; sound is the
 * speaker in the pencil's hint ink (crossed out when muted). Only an image
 * with its name: the row stays the one control.
 */
export function SidebarBrowserInUseMark({ inUse, className }: { inUse: SidebarBrowserInUse | null | undefined; className?: string }) {
  const { formatMessage } = useIntl();
  if (!inUse) return null;
  const device = inUse.media.length > 0;
  if (!device && !inUse.audible && !inUse.muted) return null;
  const label = formatMessage({
    id: device
      ? mediaMessageId("layout.sidebar.browserInUse", inUse.media)
      : inUse.muted ? "layout.sidebar.browserMutedAria" : "layout.sidebar.browserAudibleAria",
  });
  const Speaker = inUse.muted ? VolumeX : Volume2;
  return (
    <Tooltip content={label}>
      <SidebarItemMetaIcon
        role="img"
        aria-label={label}
        className={className}
        data-testid="sidebar-browser-in-use"
        data-browser-in-use={device ? "media" : inUse.muted ? "muted" : "audible"}
      >
        {device ? <MediaInUseIcon media={inUse.media} className="text-danger-strong" /> : <Speaker aria-hidden />}
      </SidebarItemMetaIcon>
    </Tooltip>
  );
}
