import { useCallback, useState } from "react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { PanelMeta, Popover, PopoverContent, PopoverTrigger } from "@botiverse/raft-ui";
import { PopoverBody } from "@botiverse/raft-ui/wip";
import type { ArtifactActor, ArtifactId, ArtifactPresence as Presence } from "@botiverse/raft-shared";

import { FaceStack } from "../../components/layout/FaceStack";
import { faceStackTriggerClass } from "../../components/layout/faceStackTrigger";
import Tooltip from "../../components/ui/Tooltip";
import { formatRelativeTime } from "../../utils/relativeTime";
import { ArtifactActorAvatar } from "./ArtifactActorParts";
import { actorKey } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { formatNameList } from "./artifactNameList";
import { artifactShareHost } from "./artifactShareHost";
import { artifactSource, useKeyedLoadWithError } from "./artifactSource";
import { isSelf, presenceModel, presenceViewer, someoneElse } from "./artifactPresenceModel";
import type { PresenceModel, PresenceRow } from "./artifactPresenceModel";

const MAX_FACES = 3;

/**
 * Who's here for the viewer of `id` (null: nothing open yet): one presence
 * read per opening, shown in the header's meta line under the title. Null
 * while it loads, undefined when it failed.
 *
 * TODO(S4 server): the first answer comes from the presence route; live
 * changes will come over the socket (`artifact:presence`).
 */
export function useArtifactPresence(id: ArtifactId | null): Presence | null | undefined {
  return useKeyedLoadWithError(id ?? "", () => (id === null ? Promise.reject(new Error("no Artifact")) : artifactSource().presence(id)), id !== null);
}

const HERE_IDS = {
  viewing: "artifacts.presence.viewing",
  reading: "artifacts.presence.reading",
  writing: "artifacts.presence.writing",
} as const;

const NOW_IDS = {
  viewing: "artifacts.presence.nowViewing",
  reading: "artifacts.presence.nowReading",
  writing: "artifacts.presence.nowWriting",
} as const;

/**
 * Who's here and who has seen it (I2, I8, I10), at the end of the header's
 * meta line under the title (ArtifactSurfaceMeta) where a head has one (a
 * phone's, the App's toolbar; a desktop head has the list in the details
 * behind its title instead, ArtifactDetailsTitle), the same at every width
 * (stdrc's option A, #proj-raft-ui:7531279d): the header itself holds only
 * actions (raft-design panel.md). Drawn like a header's member stack (the
 * thread header's followers, Working now): up to three 19px faces of who is
 * here now (people viewing, agents reading or writing, and the viewer), then
 * their count as the header stacks' mono count with its word ("2 viewing"),
 * no +N chip. Every face is in color, with no status light (those mean an
 * agent's overall state, Sage) and no grayscale (stdrc: no face is dimmed).
 *
 * The stack and its count are one button, the PopoverTrigger of the list,
 * drawn as Working now's (the shared FaceStack, raft-ui's AvatarGroup, still,
 * in Working now's trigger), with no tooltip: who is in it is in its name for a screen reader
 * and in the list it opens. It sits beside the meta line's truncating text
 * (ArtifactMetaRow), never in it, and never shrinks. The list: here now
 * first, then the rest by how recently they read it, each with the time,
 * and "updated since" on whoever stopped before the latest version (here
 * now too, beside "Viewing"). No lead line (#250): the rows mark who is
 * behind, and the header's version badge says which version is shown; the
 * button's name still counts who has and hasn't seen the latest.
 *
 * Each row opens that person or agent (artin: the app's rule for a person,
 * the host's useOpenPerson: the profile panel, as a message's avatar opens
 * it), the viewer's own "You" row too, and closes the list, as Working now's
 * rows do. A row is a button (Tab, Enter, Space) in the popover's dialog.
 * Nobody behind it (a deleted account or agent, Raft itself: `gone`), or a
 * host that opens no one, leaves the row plain text.
 *
 * `presence` is the viewer's one answer (useArtifactPresence). Shows nothing
 * while it loads, fails, or no one else is here or has read it.
 */
export function ArtifactPresence({ presence, facesOnly = false }: {
  presence: Presence | null | undefined;
  /** A phone's header (the surface's `phone`): the faces alone, no count, so the title and the place keep their room. */
  facesOnly?: boolean;
}) {
  const intl = useIntl();
  // The signed-in viewer and the version they're on, from the viewer data (null outside the viewer).
  const data = useArtifactComments()?.data;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!presence) return null;
  const model = presenceModel(presence, presenceViewer(data));
  // Alone, the viewer sees no presence at all.
  if (!someoneElse(model)) return null;
  const separator = intl.formatMessage({ id: "artifacts.presence.summarySeparator" });
  // Who is in the stack, in words.
  const hereLine = formatNameList(
    intl,
    model.here.map((r) => (r.self ? intl.formatMessage({ id: "artifacts.presence.youViewing" }) : intl.formatMessage({ id: HERE_IDS[r.here] }, { name: r.actor.displayName }))),
  );
  const latest = data?.card.latestVersion;
  const seen = [
    ...(model.seenLatest > 0 ? [intl.formatMessage({ id: "artifacts.presence.seenLatest" }, { count: model.seenLatest })] : []),
    ...(model.notSeenLatest > 0 && latest !== undefined ? [intl.formatMessage({ id: "artifacts.presence.notSeenLatest" }, { count: model.notSeenLatest, latest })] : []),
  ].join(separator);
  // The stack's name starts with its visible words ("2 viewing", WCAG 2.5.3), then who is in it and who has
  // seen the latest, so it says what the list it opens holds.
  const visible = intl.formatMessage({ id: "artifacts.presence.metaCount" }, { count: model.here.length, n: (chunks) => chunks.join("") });
  const label = [visible, hereLine, ...(seen ? [seen] : [])].join(separator);
  const faces = model.here.slice(0, MAX_FACES);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Working now's stack and trigger (stdrc: the same style, nothing flickers): the shared FaceStack
          (raft-ui's AvatarGroup), still (no entrance), keyed by who each face is, so a new presence answer
          keeps the same nodes. The trigger is a plain button, 27px like the meta row it sits in. */}
      <PopoverTrigger className={`${faceStackTriggerClass()} min-h-[27px]`} aria-label={label} data-testid="artifact-presence">
        <FaceStack still testId="artifact-presence-faces">
          {faces.map((r) => <ArtifactActorAvatar key={actorKey(r.actor)} actor={r.actor} context="face-stack" />)}
        </FaceStack>
        {/* Who is here now: the header stacks' mono count, then its word in the meta line's type (PanelMeta,
            so the phone header's color applies too). Never a number alone (Kirby, #12933: a lone "4" said
            nothing): on a phone, and in a head whose content is under 16rem (the head's PanelHeaderContent is the container), the
            faces alone, the button's name saying who and how many. */}
        {facesOnly ? null : (
          <PanelMeta render={<span />} className="@max-[16rem]:hidden" data-testid="artifact-presence-count-label">
            {intl.formatMessage(
              { id: "artifacts.presence.metaCount" },
              { count: model.here.length, n: (chunks) => <span key="n" className="font-mono text-mono-meta text-foreground" data-testid="artifact-presence-count">{chunks}</span> },
            )}
          </PanelMeta>
        )}
      </PopoverTrigger>
      {/* I10: one list, the same on every version: here now first, then who has read it, the most recent first. */}
      <PopoverContent side="bottom" align="start" sideOffset={6} className="w-[300px] max-w-[calc(100vw-2rem)]" aria-label={intl.formatMessage({ id: "artifacts.presence.listLabel" })} data-testid="artifact-presence-list">
        {/* DS Popover: the list sits 16px in (PopoverBody), not on the panel's edge. */}
        <PopoverBody>
          <ArtifactPresenceRows rows={model.rows} onOpened={close} />
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The list itself (I10): here now first, then who has read it, the most recent first, each with the time, and
 * "updated since" on whoever stopped before the latest version. The readers' popover above draws it, and so do the
 * details behind the head's title (ArtifactDetailsTitle). A row opens that person (the host's useOpenPerson), then
 * `onOpened` (the popover it is in closes).
 */
export function ArtifactPresenceRows({ rows, onOpened }: { rows: PresenceModel["rows"]; onOpened: () => void }) {
  const intl = useIntl();
  const openPerson = artifactShareHost().useOpenPerson();
  // One handler for every row: the person is on the row (its data attributes), so no row gets a closure of its own.
  const openRow = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const { personType, personId } = event.currentTarget.dataset;
    if (!openPerson || !personId || (personType !== "user" && personType !== "agent")) return;
    onOpened();
    openPerson({ type: personType, id: personId });
  }, [openPerson, onOpened]);
  const nameOf = (r: PresenceRow) => (isSelf(r) ? intl.formatMessage({ id: "artifacts.presence.you" }) : r.actor.displayName);
  return (
    // -mx: a row's hover and focus reach past its text, which stays in line with the panel's inset.
    <ul className="-mx-1.5 flex flex-col gap-0.5">
      {rows.map((r) => (
        <li key={actorKey(r.actor)} className="text-callout text-foreground" data-testid="artifact-presence-row">
          <PresenceRowTarget actor={r.actor} onOpen={openPerson ? openRow : null}>
            <ArtifactActorAvatar actor={r.actor} context="compact-list" />
            <span className="min-w-0 truncate" data-testid="artifact-presence-name">{nameOf(r)}</span>
            {r.updatedSince ? (
              <span className="shrink-0 whitespace-nowrap text-footnote text-foreground-muted" data-testid="artifact-presence-updated-since">
                {intl.formatMessage({ id: "artifacts.presence.updatedSince" })}
              </span>
            ) : null}
            <span className="ms-auto shrink-0 whitespace-nowrap ps-4 text-footnote tabular-nums text-foreground-muted" data-testid="artifact-presence-when">
              {r.here !== null ? intl.formatMessage({ id: NOW_IDS[r.here] }) : (
                // The exact date on hover: the app's raft-ui Tooltip, not a native title.
                <Tooltip content={intl.formatDate(r.at, { dateStyle: "medium", timeStyle: "short" })}>
                  <time dateTime={r.at}>{formatRelativeTime(r.at, intl.locale)}</time>
                </Tooltip>
              )}
            </span>
          </PresenceRowTarget>
        </li>
      ))}
    </ul>
  );
}

const ROW_CLASS = "flex w-full min-w-0 items-center gap-2 rounded-chip px-1.5 py-0.5";

/**
 * A row's content in the person's button, or as plain text when nobody can be opened (`gone`, or no `onOpen`).
 */
function PresenceRowTarget({ actor, onOpen, children }: {
  actor: ArtifactActor;
  onOpen: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  children: ReactNode;
}) {
  if (!onOpen || actor.gone) return <div className={ROW_CLASS}>{children}</div>;
  return (
    <ArtifactPopoverRowButton onClick={onOpen} data-person-type={actor.type} data-person-id={actor.id} data-testid="artifact-presence-open">
      {children}
    </ArtifactPopoverRowButton>
  );
}

/**
 * A compact clickable row in a popover (ComputerOwnerField's owner chip: the subtle wash on hover, the focus ring after
 * keyboard input; raft-ui's ListRow is 64px): a person in the list above, and an Artifact opened lately in the details
 * behind the head's title (ArtifactRecentRows). `current`: the row is the one shown (`aria-current`), on the wash.
 */
export function ArtifactPopoverRowButton({ current = false, className, children, ...props }: ComponentProps<"button"> & { current?: boolean }) {
  return (
    <button
      {...props}
      type="button"
      aria-current={current || undefined}
      className={`${ROW_CLASS} text-start outline-none hover:bg-fill-subtle focus-visible:shadow-focus ${current ? "bg-fill-subtle" : ""} ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
