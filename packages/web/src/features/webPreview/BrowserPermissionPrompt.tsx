import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Camera, Mic } from "lucide-react";
import type { DesktopWebPreviewPermissionPrompt, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";
import { Banner, BannerAction, BannerDescription, Button } from "@botiverse/raft-ui";

import { mediaMessageId, siteName } from "./browserSitePermissions";

/**
 * A page of the tab asked to use the microphone and / or the camera, and its site has no answer yet: the bar under
 * the address row asks the person, as Chrome's permission prompt does. Allow and Block are kept for the site by the
 * shell; Dismiss (Chrome's ×) answers no this time only (the site asks again next time). Shown only for the tab the shell said it
 * waits in; the shell ends it (answered no) when the page navigates or the tab closes.
 */
export function BrowserPermissionPrompt({ bridge, tabId, prompt }: { bridge: DesktopWebPreviewTabsBridge; tabId: string; prompt: DesktopWebPreviewPermissionPrompt }) {
  const { formatMessage } = useIntl();
  const answer = useCallback((value: "allow" | "block" | "dismiss") => bridge.answerPermission?.(tabId, prompt.id, value), [bridge, prompt.id, tabId]);
  const allow = useCallback(() => answer("allow"), [answer]);
  const block = useCallback(() => answer("block"), [answer]);
  const dismiss = useCallback(() => answer("dismiss"), [answer]);
  const Icon = prompt.kinds.includes("camera") ? Camera : Mic;
  return (
    <div className="shrink-0 border-b border-line-seam bg-layer-canvas px-(--column-margin) py-2">
      <Banner status="info" size="sm" role="status" data-testid="web-preview-permission-prompt" data-kinds={prompt.kinds.join(" ")}>
        <Icon aria-hidden />
        <BannerDescription>
          <span data-testid="web-preview-permission-text">
            {formatMessage({ id: mediaMessageId("webPreview.permission.ask", prompt.kinds) }, { site: siteName(prompt.origin) })}
          </span>
        </BannerDescription>
        {/* A banner with buttons is closed by a ghost Dismiss among them (raft-ui: never BannerClose beside BannerAction). */}
        <BannerAction>
          <Button type="button" variant="ghost" size="md" onClick={dismiss} data-testid="web-preview-permission-dismiss">
            {formatMessage({ id: "webPreview.permission.dismiss" })}
          </Button>
          <Button type="button" variant="outline" size="md" onClick={block} data-testid="web-preview-permission-block">
            {formatMessage({ id: "webPreview.permission.block" })}
          </Button>
          <Button type="button" variant="outline" size="md" onClick={allow} data-testid="web-preview-permission-allow">
            {formatMessage({ id: "webPreview.permission.allow" })}
          </Button>
        </BannerAction>
      </Banner>
    </div>
  );
}
