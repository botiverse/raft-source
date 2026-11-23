import { Fragment, useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Popover, PopoverContent, PopoverTrigger, Separator } from "@botiverse/raft-ui";
import { PanelTitleTrigger, PopoverBody } from "@botiverse/raft-ui/wip";
import { artifactLinkId } from "@botiverse/raft-shared";

import ArtifactOriginLink from "./ArtifactOriginLink";
import { ArtifactPresenceRows } from "./ArtifactPresence";
import { othersHereNow, presenceModel, presenceViewer, someoneElse } from "./artifactPresenceModel";
import { useRecentArtifactsHere } from "./artifactRecentConversation";
import { RecentArtifactRecord } from "./ArtifactRecentRecord";
import { ArtifactRecentRows } from "./ArtifactRecentTitle";
import ArtifactScopeLabel, { artifactAudience } from "./ArtifactScopeLabel";
import { useArtifactServerName } from "./artifactServerName";
import { artifactShareHost } from "./artifactShareHost";
import { ArtifactShownFilePath } from "./ArtifactShownFilePath";
import { useArtifactSurface } from "./ArtifactSurface";
import { ArtifactVersionLine } from "./ArtifactVersionHistory";
import { settledShown } from "./artifactSettled";
import { ArtifactStatusSection } from "./ArtifactSettledParts";

/**
 * A desktop head's title (the side card, expanded, Activity's viewer, the Artifact's own page): the head is one line at
 * the row's shared height, the title and the version tag beside the buttons, nothing under it. What the line under
 * the title used to say is one press away instead: the title is raft-ui's PanelTitleTrigger (the title and a small
 * chevron, as the recent Artifacts' title was) opening the details, in the order a reader asks it:
 *
 * 0. Status (#334), where its server has Settled on: Settled, who settled it when, or Working (again since vN after a
 *    new version), and the same Settle / Unsettle as ⋯ for whoever may comment (ArtifactStatusSection).
 * 1. Who can see it: the scope chip (ArtifactScopeLabel: its options where the reader may change them, as in the head
 *    before) and who that is in words.
 * 2. Original message (ArtifactOriginLink), where the server knows it and the reader's channel list has it.
 * 3. Version: the one shown, Latest, and Version history › (ArtifactVersionLine).
 * 4. Who's seen it (ArtifactPresenceRows): here now first, then who has read it; none while the reader is alone.
 * 5. The Artifacts opened lately in this conversation (ArtifactRecentRows), from two on, beside a conversation.
 *
 * While someone else is here now, a small dot on the chevron says so, taking no width; the details say who, and the
 * trigger's name says how many. The viewer data has loaded, so this Artifact joins the conversation's recent list
 * (RecentArtifactRecord). On a phone the head keeps its two lines (ArtifactRecentTitle, the meta line).
 */
export function ArtifactDetailsTitle({ testId, pageHeading = false, replace = false, onOpenedMessage }: {
  /** The title's test id (`artifact-viewer-title`, `artifact-page-title`). */
  testId: string;
  /** The title is the page's h1 (the Artifact's own page). */
  pageHeading?: boolean;
  /** Opening the original message replaces this history entry. */
  replace?: boolean;
  /** After the original message opened (the side card closes where it covers its channel). */
  onOpenedMessage?: () => void;
}) {
  const intl = useIntl();
  const { data, presence } = useArtifactSurface();
  const { card } = data;
  const { place } = useRecentArtifactsHere();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const model = presence ? presenceModel(presence, presenceViewer(data)) : null;
  const others = model ? othersHereNow(model) : 0;
  const separator = intl.formatMessage({ id: "artifacts.presence.summarySeparator" });
  const detailsLabel = intl.formatMessage({ id: "artifacts.details.title" });
  // Its name starts with the title it shows (WCAG 2.5.3), then what it opens, then how many are here (the dot).
  const label = [
    card.title,
    detailsLabel,
    ...(model && others > 0 ? [intl.formatMessage({ id: "artifacts.presence.metaCount" }, { count: model.here.length, n: (chunks) => chunks.join("") })] : []),
  ].join(separator);
  const trigger = (
    <span className="relative inline-flex min-w-0 shrink">
      {/* max-w-none: the trigger pulls its start back by its inset (-ms), so this span, sized to the trigger's
          margin box, is that much narrower than the trigger; raft-ui's max-w-full would then cut the title's
          last letters while the row still has room. It still shrinks (min-w-0) when the row is full. */}
      <PopoverTrigger render={<PanelTitleTrigger className="max-w-none" />} aria-label={label} data-testid="artifact-details-trigger">
        <span data-testid={testId}>{card.title}</span>
      </PopoverTrigger>
      {/* On the chevron's top end, ringed in the head's ground so it reads apart from the chevron: no width of its own. */}
      {others > 0 ? (
        <span aria-hidden className="pointer-events-none absolute end-0.5 top-1 size-2 rounded-full bg-success ring-2 ring-layer-canvas" data-testid="artifact-details-presence-dot" />
      ) : null}
    </span>
  );
  return (
    <>
      {/* Loaded: this Artifact joins the conversation's recent list. */}
      {place ? <RecentArtifactRecord id={artifactLinkId(card.id)} title={card.title} version={card.version} /> : null}
      <Popover open={open} onOpenChange={setOpen}>
        {pageHeading ? <h1 className="m-0 flex min-w-0 shrink">{trigger}</h1> : trigger}
        <PopoverContent side="bottom" align="start" sideOffset={6} className="w-[320px] max-w-[calc(100vw-2rem)]" aria-label={detailsLabel} data-testid="artifact-details">
          <PopoverBody>
            <DetailsSections onDone={close} replace={replace} onOpenedMessage={onOpenedMessage} />
          </PopoverBody>
        </PopoverContent>
      </Popover>
      <ArtifactShownFilePath data={data} />
    </>
  );
}

function DetailsSections({ onDone, replace, onOpenedMessage }: { onDone: () => void; replace: boolean; onOpenedMessage?: () => void }) {
  const { formatMessage } = useIntl();
  const { data, actions, chipRef, presence, pickVersion } = useArtifactSurface();
  const { card, origin } = data;
  const server = useArtifactServerName();
  // ArtifactOriginLink draws nothing without a conversation of the reader's to name: no section then either.
  const conversation = artifactShareHost().useConversation(origin?.conversationId ?? null);
  const { place, trigger: recent } = useRecentArtifactsHere();
  const model = presence ? presenceModel(presence, presenceViewer(data)) : null;
  const opened = useCallback(() => {
    onDone();
    onOpenedMessage?.();
  }, [onDone, onOpenedMessage]);
  const sections: { key: string; title: string; body: ReactNode }[] = [
    ...(settledShown(card) ? [{
      key: "status",
      title: formatMessage({ id: "artifacts.settled.status" }),
      body: <ArtifactStatusSection card={card} settle={actions.settle} />,
    }] : []),
    {
      key: "scope",
      title: formatMessage({ id: "artifacts.scope.whoTitle" }),
      body: (
        <div className="flex min-w-0 items-center gap-2">
          {/* A narrowing dialog gives focus back to the chip. */}
          <ArtifactScopeLabel home={card.home} fromAnotherServer={card.fromAnotherServer} visibility={actions.visibility} triggerRef={chipRef} />
          {/* Who that is, where the chip names a conversation ("Members of #design"); any other chip says it itself. */}
          {card.home.kind === "conversation" ? <span className="min-w-0 truncate text-caption text-foreground-muted">{artifactAudience(formatMessage, card.home, server)}</span> : null}
        </div>
      ),
    },
    ...(origin && conversation ? [{
      key: "origin",
      title: formatMessage({ id: "artifacts.details.origin" }),
      body: <div className="flex min-w-0"><ArtifactOriginLink origin={origin} replace={replace} onOpened={opened} /></div>,
    }] : []),
    { key: "version", title: formatMessage({ id: "artifacts.details.version" }), body: <ArtifactVersionLine data={data} onPick={pickVersion} /> },
    ...(model && someoneElse(model) ? [{
      key: "presence",
      title: formatMessage({ id: "artifacts.presence.listLabel" }),
      body: <ArtifactPresenceRows rows={model.rows} onOpened={onDone} />,
    }] : []),
    ...(recent && place ? [{
      key: "recent",
      title: place.name
        ? formatMessage({ id: "artifacts.viewer.recent.menuLabel" }, { conversation: place.name })
        : formatMessage({ id: "artifacts.viewer.recent.menuLabelPlain" }),
      body: <ArtifactRecentRows current={card.id} onPicked={onDone} />,
    }] : []),
  ];
  return (
    <div className="flex flex-col gap-2.5 text-callout text-foreground">
      {sections.map((section, index) => (
        <Fragment key={section.key}>
          {index > 0 ? <Separator /> : null}
          <section aria-label={section.title} className="flex flex-col gap-1.5" data-testid={`artifact-details-${section.key}`}>
            <div aria-hidden className="text-caption font-semibold text-foreground-hint">{section.title}</div>
            {section.body}
          </section>
        </Fragment>
      ))}
    </div>
  );
}
