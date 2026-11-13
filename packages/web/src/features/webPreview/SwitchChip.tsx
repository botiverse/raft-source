import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Globe } from "lucide-react";
import { ArtifactIcon } from "@botiverse/ricons";
import { PanelAction, Separator } from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { useBrowserTabsStore } from "./browserTabsStore";

/**
 * The side window's switch chip (desktop_web_preview_view_v0, Raft Desktop):
 * the window holds the built-in browser or the conversation's Artifact, one
 * in front and the other open behind it, and while both are open the chip
 * leads the first row and names the one behind. Pressing it brings that one
 * to the front; nothing closes.
 *
 * A PanelAction (the head's own bar button) in the unselected tab's ink
 * (muted, callout semibold: a place that is not in front; it has no pressed
 * state), then a 16px vertical Separator. It never folds: it is already as
 * small as it gets (the Artifact's title goes first, browserHeadFit).
 */
const TOOLTIP_PLACE = { side: "bottom", align: "start" } as const;

function Chip({ kind, label, onClick, tight, children }: {
  kind: "artifact" | "browser";
  label: string;
  onClick: () => void;
  /** In a head whose parts are 12px apart (the Artifact's): the line keeps its 8px on each side. */
  tight?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <Tooltip content={label} contentProps={TOOLTIP_PLACE}>
        <PanelAction
          aria-label={label}
          onClick={onClick}
          className="gap-1.5 text-callout font-semibold text-foreground-muted"
          data-switch-chip={kind}
          data-testid="side-window-switch-chip"
        >
          {children}
        </PanelAction>
      </Tooltip>
      <Separator
        orientation="vertical"
        className={`${tight ? "-mx-1" : "mx-1"} h-4 data-[orientation=vertical]:self-center`}
        data-testid="side-window-switch-separator"
      />
    </>
  );
}

/** In the browser's tab row: the Artifact open behind it. `titleRoom` 0 leaves the icon alone. */
export function ArtifactSwitchChip({ conversationId, title, titleRoom }: { conversationId: string; title: string | null; titleRoom: number }) {
  const { formatMessage } = useIntl();
  const park = useBrowserTabsStore((s) => s.park);
  const toArtifact = useCallback(() => park(conversationId), [conversationId, park]);
  const label = title ? formatMessage({ id: "webPreview.backToArtifact" }, { title }) : formatMessage({ id: "webPreview.backToArtifactUntitled" });
  return (
    <Chip kind="artifact" label={label} onClick={toArtifact}>
      <ArtifactIcon aria-hidden />
      {title && titleRoom > 0 ? <span className="truncate" style={{ maxWidth: titleRoom }} data-testid="side-window-switch-title">{title}</span> : null}
    </Chip>
  );
}

/** In the Artifact's head: the browser open behind it, with how many tabs it holds. Nothing once it has closed. */
export function BrowserSwitchChip({ conversationId }: { conversationId: string }) {
  const { formatMessage } = useIntl();
  const count = useBrowserTabsStore((s) => s.browsers[conversationId]?.tabs.length ?? 0);
  const toFront = useBrowserTabsStore((s) => s.toFront);
  const toBrowser = useCallback(() => toFront(conversationId), [conversationId, toFront]);
  if (count === 0) return null;
  return (
    <Chip kind="browser" label={formatMessage({ id: "webPreview.backToBrowser" }, { count })} onClick={toBrowser} tight>
      <Globe aria-hidden />
      <span className="font-mono text-mono-meta font-normal" data-testid="side-window-switch-count">{count}</span>
    </Chip>
  );
}
