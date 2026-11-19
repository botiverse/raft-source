import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Camera, Mic, MicOff, SlidersHorizontal, VideoOff } from "lucide-react";
import type { DesktopWebPreviewMediaKind, DesktopWebPreviewSiteSetting, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";
import {
  Button,
  Popover,
  PopoverHeader,
  PopoverSeparator,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
} from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import type { BrowserTab } from "./browserTabsStore";
import { mediaMessageId, NO_MEDIA, siteName } from "./browserSitePermissions";

const KINDS: readonly DesktopWebPreviewMediaKind[] = ["microphone", "camera"];
const SETTINGS: readonly DesktopWebPreviewSiteSetting[] = ["allow", "block", "ask"];

/** One device of the site: its name and Allow / Block / Ask. */
function SiteSettingRow({ kind, value, onChange }: { kind: DesktopWebPreviewMediaKind; value: DesktopWebPreviewSiteSetting; onChange: (kind: DesktopWebPreviewMediaKind, setting: DesktopWebPreviewSiteSetting) => void }) {
  const { formatMessage } = useIntl();
  const change = useCallback((setting: DesktopWebPreviewSiteSetting) => onChange(kind, setting), [kind, onChange]);
  const name = formatMessage({ id: kind === "microphone" ? "webPreview.siteSettings.microphone" : "webPreview.siteSettings.camera" });
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-callout">
        {kind === "microphone" ? <Mic aria-hidden size={16} /> : <Camera aria-hidden size={16} />}
        {name}
      </span>
      <SegmentedControl<DesktopWebPreviewSiteSetting> value={value} aria-label={name} onValueChange={change} data-testid={`web-preview-site-${kind}`}>
        {SETTINGS.map((setting) => (
          <SegmentedControlItem key={setting} value={setting} data-testid={`web-preview-site-${kind}-${setting}`}>
            <SegmentedControlLabel>{formatMessage({ id: `webPreview.siteSettings.${setting}` })}</SegmentedControlLabel>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

/** The tab's devices in use, as the indicator shows them: none, or the icon that says which. */
export function MediaInUseIcon({ media, className }: { media: readonly DesktopWebPreviewMediaKind[]; className?: string }) {
  if (media.length === 0) return null;
  const Icon = media.includes("camera") ? Camera : Mic;
  return <Icon aria-hidden className={className} />;
}

/**
 * The site settings at the start of the address field (where a site tells people to look for its permissions, as
 * in Chrome): one button for the tab's site, showing what it uses (the microphone or the camera, in red, as a
 * recording light, while the page was given one), what it is blocked from (crossed out), else the settings icon. It opens
 * the site's settings: Allow / Block / Ask for the microphone and the camera, and Stop and block while a device is
 * in use (the shell reloads the page so it lets go). Shown only for a page that may ask (a secure site) on a shell
 * with site permissions.
 */
export function BrowserSiteSettings({ bridge, tab }: { bridge: DesktopWebPreviewTabsBridge; tab: BrowserTab }) {
  const { formatMessage } = useIntl();
  const site = tab.site ?? null;
  const media = tab.media ?? NO_MEDIA;
  const setSitePermission = bridge.setSitePermission?.bind(bridge);
  const change = useCallback((kind: DesktopWebPreviewMediaKind, setting: DesktopWebPreviewSiteSetting) => setSitePermission?.(tab.id, kind, setting), [setSitePermission, tab.id]);
  const stop = useCallback(() => {
    for (const kind of media) setSitePermission?.(tab.id, kind, "block");
  }, [media, setSitePermission, tab.id]);
  if (!site || !setSitePermission) return null;
  const label = media.length > 0 ? formatMessage({ id: mediaMessageId("webPreview.siteSettings.inUse", media) }) : formatMessage({ id: "webPreview.siteSettings.label" });
  const Idle = site.microphone === "block" ? MicOff : site.camera === "block" ? VideoOff : SlidersHorizontal;
  return (
    <Popover>
      <Tooltip content={label}>
        <PopoverTrigger
          render={<Button type="button" size="icon-md" variant="ghost" aria-label={label} data-testid="web-preview-site-settings" data-in-use={media.join(" ") || undefined} />}
        >
          {media.length > 0 ? <MediaInUseIcon media={media} className="text-danger-strong" /> : <Idle aria-hidden />}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="bottom" align="start" className="w-80 max-w-[calc(100vw-2rem)]" data-testid="web-preview-site-settings-popover">
        <PopoverHeader>
          <PopoverTitle className="truncate">{siteName(site.origin)}</PopoverTitle>
        </PopoverHeader>
        <PopoverSeparator />
        <div className="flex flex-col gap-3 p-4">
          {KINDS.map((kind) => <SiteSettingRow key={kind} kind={kind} value={site[kind]} onChange={change} />)}
          {media.length > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-callout text-foreground-muted" data-testid="web-preview-site-in-use">
                {formatMessage({ id: mediaMessageId("webPreview.siteSettings.inUse", media) })}
              </span>
              <Button type="button" variant="outline" size="md" onClick={stop} data-testid="web-preview-site-stop">
                {formatMessage({ id: "webPreview.siteSettings.stop" })}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
