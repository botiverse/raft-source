import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Paperclip } from "lucide-react";
import { ArtifactIcon } from "@botiverse/ricons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@botiverse/raft-ui";
import { PanelTitleTrigger } from "@botiverse/raft-ui/wip";
import { artifactLinkId, parseArtifactId } from "@botiverse/raft-shared";
import type { ArtifactId } from "@botiverse/raft-shared";

import { formatRelativeTime, formatShortRelativeTime } from "../../utils/relativeTime";
import { useRecentArtifactsHere } from "./artifactRecentConversation";
import type { ArtifactConversationPlace } from "./artifactRecentConversation";
import type { RecentArtifact } from "./artifactRecentStore";
import { useArtifactViewerStore } from "./artifactViewerStore";

/**
 * The side card's title (#proj-workspace:#291). With two or more Artifacts recently opened in this conversation
 * (artifactRecentStore: per person, per device) it is the trigger of their menu: raft-ui's PanelTitleTrigger, the title
 * and a small chevron after it, which stays when the title truncates. Picking one opens it in this card
 * as any in-app opening does (the viewer store: one Artifact in front, the page's `?artifact=` follows), at its
 * latest version. With fewer it is `plain`, the title as it always was. The version tag stays its own control
 * after it.
 *
 * `record`: the viewer data has loaded, so this Artifact (its title and the version shown) goes into the list;
 * not while the opener's card stands in for it.
 */
export function ArtifactRecentTitle({ card, record = false, plain, after }: {
  card: { id: ArtifactId; title: string; version: number };
  record?: boolean;
  /** The title as it is with no menu (the surface's, or the opener's card's). */
  plain: ReactNode;
  /** What follows the trigger in the heading (the file shown's path). */
  after?: ReactNode;
}) {
  const { place, items, trigger } = useRecentArtifactsHere();
  const current = artifactLinkId(card.id);
  const recorded = record && place ? <RecentArtifactRecord id={current} title={card.title} version={card.version} /> : null;
  if (!trigger || !place) return <>{recorded}{plain}</>;
  return (
    <>
      {recorded}
      {/* raft-ui's title trigger (DS Panel › A title that switches): the title's first letter stays where the plain
          title's is, and on a phone it is as tall as the title's line with a 44px tap target, so the two-line head
          keeps its height (a 44px trigger pushed the line under the title onto the head's edge: staging, 2026-11-14). */}
      <DropdownMenu>
        <DropdownMenuTrigger render={<PanelTitleTrigger />} data-testid="artifact-viewer-recent-trigger">
          <span data-testid="artifact-viewer-title">{card.title}</span>
        </DropdownMenuTrigger>
        <RecentArtifactsMenu place={place} items={items} current={current} />
      </DropdownMenu>
      {after}
    </>
  );
}

/**
 * Mounted while the loaded viewer shows this Artifact beside a conversation: keeps it in that conversation's list
 * (its title and the version shown; its time is the side card's opening, so the same opening is written once).
 */
function RecentArtifactRecord({ id, title, version }: { id: string; title: string; version: number }) {
  const { remember } = useRecentArtifactsHere();
  const opening = useArtifactViewerStore((s) => s.openedAt);
  const [mountedAt] = useState(() => Date.now());
  const openedAt = opening > 0 ? opening : mountedAt;
  useEffect(() => {
    remember({ id, title, version, openedAt });
  }, [id, openedAt, remember, title, version]);
  return null;
}

/**
 * The menu's rows (raft-design dropdown-menu): the Artifact icon, the title (truncated), then its version and how
 * long ago it was opened, as short as the Artifacts home's rows say it ("3m ago", "2d ago"), in Space Mono; the
 * current one is the checked radio item.
 * Then the conversation's Files card, where all its Artifacts are.
 */
function RecentArtifactsMenu({ place, items, current }: { place: ArtifactConversationPlace; items: readonly RecentArtifact[]; current: string }) {
  const { formatMessage, locale } = useIntl();
  const { conversationId } = place;
  const pick = useCallback((value: unknown) => {
    if (typeof value !== "string" || value === current) return;
    const id = parseArtifactId(value);
    if (id) useArtifactViewerStore.getState().openArtifact({ id, version: null, conversationId, source: "other" });
  }, [conversationId, current]);
  return (
    <DropdownMenuContent
      align="start"
      aria-label={formatMessage({ id: "artifacts.viewer.recent.menuLabel" }, { conversation: place.name })}
      className="w-88"
      data-testid="artifact-recent-menu"
    >
      <DropdownMenuRadioGroup value={current} onValueChange={pick}>
        {items.map((item) => {
          const opened = new Date(item.openedAt).toISOString();
          return (
            <DropdownMenuRadioItem
              key={item.id}
              value={item.id}
              aria-label={formatMessage({ id: "artifacts.viewer.recent.itemLabel" }, { title: item.title, version: item.version, time: formatRelativeTime(opened, locale) ?? "" })}
              data-testid="artifact-recent-row"
              data-artifact-recent={item.id}
            >
              <ArtifactIcon aria-hidden />
              <DropdownMenuItemLabel>{item.title}</DropdownMenuItemLabel>
              <span className="shrink-0 font-mono text-mono-meta font-normal whitespace-nowrap text-foreground-hint">
                {formatMessage({ id: "artifacts.viewer.recent.itemMeta" }, { version: item.version, time: formatShortRelativeTime(opened, locale) ?? "" })}
              </span>
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
      {place.onShowAll ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={place.onShowAll} data-testid="artifact-recent-all">
            <Paperclip aria-hidden />
            <DropdownMenuItemLabel>{formatMessage({ id: "artifacts.viewer.recent.all" }, { conversation: place.name })}</DropdownMenuItemLabel>
          </DropdownMenuItem>
        </>
      ) : null}
    </DropdownMenuContent>
  );
}
