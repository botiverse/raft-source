import { useCallback, useId } from "react";
import type { ReactNode, Ref } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Globe, Hash, Lock, Users } from "lucide-react";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuFooter,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@botiverse/raft-ui";
import { DirectMessageIcon } from "@botiverse/ricons";
import { PopoverBody } from "@botiverse/raft-ui/wip";
import type { ArtifactHome, ArtifactViewerData, ChannelId } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { useOverflowTitle } from "../../hooks/useOverflowTitle";
import { artifactHomeWords, conversationLabel, conversationName } from "./artifactHomeWords";
import { artifactShareHost } from "./artifactShareHost";
import { useArtifactServerName } from "./artifactServerName";
import type { ArtifactServerName } from "./artifactServerName";

function homeIcon(home: ArtifactHome): ReactNode {
  if (home.kind === "server") return <Users aria-hidden />;
  if (home.kind === "public") return <Globe aria-hidden />;
  const type = home.conversation.type;
  if (type === "private") return <Lock aria-hidden />;
  if (type === "dm") return <DirectMessageIcon aria-hidden />;
  return <Hash aria-hidden />;
}

/**
 * The people in a DM besides the reader, named: "You and Judith"; a group
 * names up to three, then "You and 4 others".
 */
export function dmAudience(formatMessage: IntlShape["formatMessage"], others: readonly string[]): string {
  const [first = "", second = "", third = ""] = others;
  return formatMessage({ id: "artifacts.scope.whoDm" }, { count: others.length, first, second, third });
}

/**
 * Who can see an Artifact at a home, in words, wherever its scope is named
 * (the chip's popover, the visibility switcher): "You and Judith" for a DM,
 * "Members of #growth" for a channel ("Members of acme-partners" for a joint
 * one, by its bare name: conversationLabel), "Everyone in Northwind Labs" (the
 * server by its name, `server`), "Anyone with the link".
 */
export function artifactAudience(formatMessage: IntlShape["formatMessage"], home: ArtifactHome, server: ArtifactServerName): string {
  if (home.kind === "server") return formatMessage({ id: "artifacts.scope.whoServer" }, server);
  if (home.kind === "public") return formatMessage({ id: "artifacts.scope.whoPublic" });
  // A DM's home carries the one peer, by the name the reader's sidebar shows (dm identities are 1:1 today).
  // TODO(Remy): a self-DM's "peer" is the reader, so it reads "You and <own name>"; the home
  // would have to say it is a self-DM (a shared-contract field) for "Only you".
  if (home.conversation.type === "dm") return dmAudience(formatMessage, [conversationName(home.conversation)]);
  const id = home.conversation.type === "joint" ? "artifacts.scope.whoJoint" : "artifacts.scope.whoConversation";
  return formatMessage({ id }, { name: conversationLabel(home.conversation) });
}

type HomeKind = ArtifactHome["kind"];
const HOME_ORDER: HomeKind[] = ["conversation", "server", "public"];

/** What this viewer may move the Artifact to, and how (F13, D15). */
export interface ArtifactVisibility {
  home: ArtifactHome;
  /** The homes offered, narrowest first; the current one among them. */
  options: HomeKind[];
  /** The one conversation a narrowing may go back to (#75, `originalHome`), when `conversation` is offered from a larger home. */
  originalConversationId: ChannelId | null;
  change: (to: HomeKind) => void;
}

/** What choosing another home does: move it there, or (a smaller home) ask first. */
export interface ArtifactVisibilityActions {
  /** A larger home: the whole server at once (D15); anyone with the link after its confirmation. */
  onWiden: (to: "server" | "public") => void;
  /** Public back to the whole server through unpublish, for viewer data that has no `narrowHome`: after its confirmation. */
  onUnpublish: () => void;
  /** A smaller home (`capabilities.narrowHome`): the preview and its confirmation first; a conversation is the original one. */
  onNarrow: (to: "server" | "conversation") => void;
}

/**
 * The visibility choices, for the ⋯ menu's Visibility and for the chip a
 * manager clicks: one set of rules for both, all from the server's
 * capabilities. Null: this viewer may not change it (the read-only "Who can
 * see it" instead).
 *
 * - A larger home while `changeHome` (conversation → server → public).
 * - A smaller one while `narrowHome` (the home is the server or public):
 *   public → the whole server, and the server or public → its original
 *   conversation (`originalHome`, #75: the only one; none without it),
 *   each previewed and confirmed (onNarrow).
 * - Without `narrowHome`, public goes back to the whole server through its
 *   own route (unpublish) while the server says this viewer may.
 */
export function artifactVisibility(data: ArtifactViewerData, actions: ArtifactVisibilityActions): ArtifactVisibility | null {
  const { home } = data.card;
  const { changeHome, narrowHome } = data.capabilities;
  const unpublishable = home.kind === "public" && data.capabilities.unpublish;
  const at = HOME_ORDER.indexOf(home.kind);
  const originalConversationId = narrowHome ? data.originalHome?.conversationId ?? null : null;
  const options = HOME_ORDER.filter((kind, index) => index === at
    || (index > at && changeHome)
    || (index < at && (kind === "conversation" ? originalConversationId !== null : narrowHome || unpublishable)));
  // Nowhere else to move it: nothing to choose.
  if (options.length < 2) return null;
  const change = (to: HomeKind) => {
    const index = HOME_ORDER.indexOf(to);
    if (index === at || !options.includes(to)) return;
    if (index > at) actions.onWiden(to === "public" ? "public" : "server");
    else if (narrowHome) actions.onNarrow(to === "conversation" ? "conversation" : "server");
    else actions.onUnpublish();
  };
  return { home, options, originalConversationId, change };
}

/**
 * The visibility choices as radio items, inside a raft-ui DropdownMenu.
 * `closeOnChoose`: the chip's menu is only this choice, so choosing closes it.
 * A smaller home and anyone with the link open their confirmation, so choosing
 * either always closes the menu.
 */
export function ArtifactVisibilityOptions({ visibility, closeOnChoose = false }: { visibility: ArtifactVisibility; closeOnChoose?: boolean }) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  const { home, options, originalConversationId, change } = visibility;
  const at = HOME_ORDER.indexOf(home.kind);
  // The original conversation as the reader's own channel list names it; not there: "A conversation".
  const original = artifactShareHost().useConversation(home.kind === "conversation" ? null : originalConversationId);
  // The radio group hands back its value untyped: only an offered home goes on.
  const choose = useCallback((value: unknown) => {
    const to = options.find((kind) => kind === value);
    if (to) change(to);
  }, [options, change]);
  return (
    <DropdownMenuRadioGroup value={home.kind} onValueChange={choose} aria-label={formatMessage({ id: "artifacts.scope.whoTitle" })}>
      {options.map((kind) => (
        <DropdownMenuRadioItem
          key={kind}
          value={kind}
          closeOnClick={closeOnChoose || HOME_ORDER.indexOf(kind) < at || kind === "public"}
          data-testid={`artifact-viewer-visibility-${kind}`}
        >
          {kind === "conversation"
            ? home.kind === "conversation"
              ? artifactAudience(formatMessage, home, server)
              : original
                ? artifactAudience(formatMessage, { kind: "conversation", conversation: { id: original.id, name: original.name, type: original.type } }, server)
                : formatMessage({ id: "artifacts.scope.pickConversation" })
            : formatMessage({ id: kind === "server" ? "artifacts.scope.server" : "artifacts.scope.public" }, server)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

const CHIP_CLASS = "relative z-raised max-w-full cursor-pointer [&_svg]:size-3";
// On an Artifact card, where raft-ui gives a button badge its 44px touch
// target (coarse pointer, anchor-scope), the chip stays static so that target
// isn't clipped: it comes after the card's stretched link, so its own anchored
// ::after paints above the link and takes the tap. Elsewhere (a viewer header,
// right under the version tag) it keeps its own box, so it can't cover its neighbours.
// In a header's meta line the chip gives way too (raft-ui Badge is shrink-0): it truncates with
// the original message, so who read it, beside them (ArtifactMetaRow), stays whole.
const HEADER_CHIP_CLASS = `${CHIP_CLASS} shrink`;
// A chip that opens nothing (#250: any home but a DM's, read only) is a plain label: no pointer, and on a card no
// layer of its own, so the card's stretched link covers it.
const STATIC_CHIP_CLASS = "max-w-full [&_svg]:size-3";
const CARD_CHIP_CLASS = `${CHIP_CLASS} supports-[anchor-scope:all]:pointer-coarse:static supports-[anchor-scope:all]:pointer-coarse:z-auto`;
// Another server's chip says a fixed, short label, never cut (Raft DS writing.md: a label wraps or the layout makes
// room): it doesn't shrink in a header's meta line and isn't held to the line's width (raft-ui Badge clips at
// max-w-full), so its neighbours give way instead.
const OUTSIDER_CHIP_CLASS = "max-w-none shrink-0";

/**
 * Where an Artifact lives (D15: one home, F31 option A): the conversation,
 * everyone in the server (by its name), or anyone with the link. For a DM,
 * hover on desktop, tap on touch, names who that is ("You and Judith"), as
 * for an icon-only chip (a tile's), which says it in no words; any other
 * chip says it itself, so it opens nothing (#250: no popover restating it,
 * nor a "Who can see it" heading). For a viewer who
 * may change it (`visibility`), a click opens the visibility choices
 * instead. Only drawn for viewers who can see the Artifact; an unavailable
 * reference has no label (F11).
 *
 * Another server's public Artifact, read here as an outsider (the card's
 * `fromAnotherServer`, #proj-workspace:#128): "From another server" with the
 * globe, naming no server and never cut (#proj-workspace:#244: the longer
 * "Anyone with the link · from another server" truncated in a header's chip
 * and pushed the author and time out of a row), and on hover or focus a
 * tooltip of two lines: who can see it ("Anyone with the link"), then the
 * public page's own line ("User-generated, not verified by Raft"). Nothing to
 * change and no one to name, so no popover or menu.
 */
/** The chip's words: the server, "Anyone with the link", or the conversation's bare name. */
function scopeText(formatMessage: IntlShape["formatMessage"], home: ArtifactHome, server: ArtifactServerName): string {
  return home.kind === "server"
    ? formatMessage({ id: "artifacts.scope.server" }, server)
    : home.kind === "public"
      ? formatMessage({ id: "artifacts.scope.public" })
      // The icon says the kind of conversation; the name goes bare (no "#"), a DM by its peer's display name.
      : conversationName(home.conversation);
}

/**
 * The chip folded into the viewer's ⋯ where its head has no room (#189 rule 6), for a reader who can't change who
 * sees it (one who can has ⋯'s Visibility): where it lives, and who can see it in its submenu, as the chip's popover.
 */
export function ArtifactScopeMenuItem({ home, fromAnotherServer = false }: { home: ArtifactHome; fromAnotherServer?: boolean }) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  const outsider = fromAnotherServer && home.kind === "public";
  return (
    <DropdownMenuSubmenu>
      <DropdownMenuSubmenuTrigger data-testid="artifact-viewer-menu-scope">
        {homeIcon(home)}
        {outsider ? formatMessage({ id: "artifacts.scope.publicFromAnotherServer" }) : scopeText(formatMessage, home, server)}
      </DropdownMenuSubmenuTrigger>
      <DropdownMenuContent side="left" align="start">
        <DropdownMenuFooter>{outsider ? formatMessage({ id: "artifacts.public.unverified" }) : artifactAudience(formatMessage, home, server)}</DropdownMenuFooter>
      </DropdownMenuContent>
    </DropdownMenuSubmenu>
  );
}

export default function ArtifactScopeLabel({ home, fromAnotherServer = false, visibility = null, triggerRef, onCard = false, iconOnly = false, className }: {
  home: ArtifactHome;
  /**
   * The icon alone, at the end of a home page tile's author line (design D7; #proj-workspace:#177: the tile no
   * longer says where it lives in words). Its name is the place in words ("Direct message with cindyz",
   * artifactHomeWords: the hidden icon can't say the kind of conversation), the popover says who can see it;
   * another server's public one has both lines in its tooltip. Only for the read-only chip; a chip that changes
   * the home always says it.
   */
  iconOnly?: boolean;
  /** The card's `fromAnotherServer`: another server's public Artifact, read as an outsider. */
  fromAnotherServer?: boolean;
  /** On an Artifact card, under its stretched link (see CARD_CHIP_CLASS). */
  onCard?: boolean;
  /** Added to the chip's own classes: where it sits shapes its touch target (a home page tile's, ArtifactTile). */
  className?: string;
  visibility?: ArtifactVisibility | null;
  /** The chip's button (either kind), for returning focus to it (the viewer's narrowing dialogs). */
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  const whoId = useId();
  const chipBase = onCard ? CARD_CHIP_CLASS : HEADER_CHIP_CLASS;
  const chipClass = className ? `${chipBase} ${className}` : chipBase;
  // A long server name is cut off in the chip: its whole text as the title, while it is (a DM's
  // popover says who in full on hover already, so every other chip takes it).
  const overflowTitle = useOverflowTitle<HTMLSpanElement>();
  if (fromAnotherServer && home.kind === "public") {
    const name = formatMessage({ id: "artifacts.scope.publicFromAnotherServer" });
    const who = formatMessage({ id: "artifacts.scope.whoPublic" });
    const unverified = formatMessage({ id: "artifacts.public.unverified" });
    // The tooltip says who can see it, then why to be careful (DS Tooltip: a second line in on-hud-muted, 4px under).
    const tip = <><span className="block">{who}</span><span className="mt-1 block text-foreground-on-hud-muted">{unverified}</span></>;
    return (
      <Tooltip content={tip}>
        <Badge
          appearance="outline"
          variant="muted"
          render={<button type="button" />}
          className={`${chipClass} ${OUTSIDER_CHIP_CLASS}`}
          data-testid="artifact-scope-label"
          data-from-another-server=""
        >
          {homeIcon(home)}
          <span className={iconOnly ? "sr-only" : undefined}>{name}</span>
        </Badge>
      </Tooltip>
    );
  }
  const text = iconOnly && !visibility ? artifactHomeWords(formatMessage, home, server) : scopeText(formatMessage, home, server);
  // The popover says what the chip doesn't: a DM's people, or where an icon-only chip lives.
  const opens = iconOnly || (home.kind === "conversation" && home.conversation.type === "dm");
  const chip = (
    <>
      {homeIcon(home)}
      <span ref={visibility || !opens ? overflowTitle : undefined} className={iconOnly && !visibility ? "sr-only" : "truncate"}>{text}</span>
    </>
  );
  if (visibility) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          render={<Badge appearance="outline" variant="muted" render={<button type="button" />} className={chipClass} />}
          aria-label={formatMessage({ id: "artifacts.scope.changeLabel" }, { scope: text })}
          data-testid="artifact-scope-label"
        >
          {chip}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" data-testid="artifact-scope-visibility">
          <ArtifactVisibilityOptions visibility={visibility} closeOnChoose />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (!opens) {
    // Nothing to open: a plain label (no button, no pointer), which a card's stretched link covers.
    return (
      <Badge appearance="outline" variant="muted" className={`${STATIC_CHIP_CLASS} ${onCard ? "" : "shrink"} ${className ?? ""}`} data-testid="artifact-scope-label">
        {chip}
      </Badge>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        ref={triggerRef}
        openOnHover
        render={<Badge appearance="outline" variant="muted" render={<button type="button" />} className={chipClass} />}
        aria-label={formatMessage({ id: "artifacts.scope.label" }, { scope: text })}
        data-testid="artifact-scope-label"
      >
        {chip}
      </PopoverTrigger>
      {/* DS Popover: 300px wide, its text 16px in (PopoverBody). Who can see it is a value, not helper text:
          a line in ink, not PopoverDescription, still the popover's description for assistive tech. */}
      <PopoverContent className="w-[300px] max-w-[calc(100vw-2rem)]" aria-describedby={whoId} data-testid="artifact-scope-who">
        <PopoverBody>
          <p id={whoId} className="m-0 flex items-center gap-2 font-sans text-callout text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
            {homeIcon(home)}
            {artifactAudience(formatMessage, home, server)}
          </p>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
