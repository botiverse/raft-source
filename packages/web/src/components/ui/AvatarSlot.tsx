import type { ReactElement, ReactNode } from "react";
import { useCallback, useState } from "react";
import { User } from "lucide-react";
import { Avatar, AvatarBadge, AvatarFallback } from "@botiverse/raft-ui";
import type { AvatarBadgeOffset, AvatarSize, Presence } from "@botiverse/raft-ui";
import { AgentAvatar } from "../agent/PixelAvatar";
import { PersonAvatar } from "../member/PersonAvatar";
import { useMediaQuery } from "../../hooks/effectPrimitives";

/**
 * Product identity adapter. A context names where an identity sits and maps
 * it to one step of raft-ui's Avatar scale; raft-ui owns everything else (the
 * sticker frame, its box, the initials' type and icon size, the badge corner).
 * Image loading and pixel artwork stay in their leaf renderers, which fill the
 * frame.
 *
 * Raft Design System › Avatar: 19 · 27 · 35 · 51 · 99 (8n + two 1.5px edges);
 * xl 99 carries the hard brand-art shadow. `preview-mini` keeps raft-ui's 14
 * for the one-line preview cards where 19 does not fit.
 */
const CONTEXT_SIZE = {
  /** An agent's or a person's own profile, and the onboarding hero: xl 99. */
  "profile-hero": "xl",
  /** Your own row in Settings, an avatar being edited: lg 51. */
  "profile-tile": "lg",
  "account-tile": "lg",
  /** The profile hover card: lg 51. */
  "mention-card": "lg",
  /** A panel head's avatar: 35 on a phone and a touch screen (a 56px head);
   *  27 with a mouse on a desktop, in a 44px head beside its 28px tiles
   *  (raft-design panel.md: a head's avatar is `sm`; stdrc, 2026-11-04). */
  "panel-header": "md",
  /** A row of the server switcher: 35 on a touch screen; with a mouse on a
   *  desktop 27, the size of the workspace avatar on the switcher's trigger
   *  (stdrc, 2026-11-04). */
  "switcher-row": "md",
  /** The message row's own avatar: raft-ui's `messageItem.avatarSlot` recipe
   *  sizes it (36, 24 on narrow viewports). */
  "message-row": "md",
  /** A row in a list — channel members, the people and agents on a profile
   *  or computer page, the workspace switcher: the DS ListRow avatar, 35. */
  "list-row": "md",
  /** A dense row — search results, forward targets, Working now: 27. */
  "compact-row": "sm",
  "creator-link": "xs",
  "sidebar-list": "2xs",
  "compact-list": "xs",
  /** A face in the stack of agents at work (DS AgentActivity): 19. */
  "face-stack": "xs",
  "preview-mini": "3xs",
  /** A leading identity in a picker trigger, at raft-ui PickerTriggerButton's
   *  14px leading-icon size: the Forward dialog's server switch. */
  "picker-trigger": "3xs",
  /** A leading identity in a menu item (raft-ui DropdownMenu): the Forward
   *  dialog's list of servers. 19px: raft-ui's Avatar has no 16px step to
   *  match the menu's 16px icons, and its 2xs is the smallest above 14. */
  "menu-item": "2xs",
  /** The author of a comment in a document's comment card (raft-ui
   *  CommentEntryHeader): 19. */
  "comment-entry": "xs",
  /** The authors on a comment marker beside a passage (raft-ui
   *  CommentMarker's AvatarGroup): 19. */
  "comment-marker": "2xs",
  /** The face of the assistant that sent a message for its owner, on the
   *  corner of the owner's message-row avatar (raft-ui
   *  MessageItemDelegatedAvatar; DS Identity and presence). */
  "delegated-face": "2xs",
} as const satisfies Record<string, AvatarSize>;

export type AvatarContext = keyof typeof CONTEXT_SIZE;

/** The size of a person's User placeholder icon at each step. */
const PERSON_PLACEHOLDER_ICON: Record<AvatarSize, number> = {
  xl: 48,
  lg: 24,
  md: 16,
  sm: 14,
  xs: 12,
  "2xs": 10,
  "3xs": 9,
};

export interface AvatarSlotProps {
  context: AvatarContext;
  /** Entity kind — controls which inner renderer is used. */
  type: "agent" | "human" | "server" | "app";
  /** Agent's avatarUrl (`pixel:*` key or uploaded image URL). Used when
   *  `type="agent"`. */
  agentAvatarUrl?: string | null;
  /** Human's avatar URL; only an avatar Raft stores is drawn, else the User
   *  placeholder. Used when `type="human"`. */
  humanAvatarUrl?: string | null;
  /** Server's uploaded avatar URL. Used when `type="server"`. */
  serverAvatarUrl?: string | null;
  /** Server initial placeholder. Used when `type="server"` has no avatar. */
  serverInitial?: string | null;
  /** App logo URL. Used when `type="app"`. */
  appAvatarUrl?: string | null;
  /** App initials placeholder. Used when `type="app"` has no logo. */
  appInitials?: string | null;
  /** When `type="human"`, render the static User-icon placeholder without
   *  looking at `humanAvatarUrl` (the person is not known here). */
  humanPlaceholder?: boolean;
  /** Optional corner indicator. When present, the identity frame is rendered
   *  by raft-ui Avatar and the indicator is mounted through AvatarBadge so
   *  size and bottom-right placement stay canonical across call sites. */
  badge?: ReactElement;
  /** Classes for the badge's own box when `badge` is set: a badge that is not
   *  a status light (an Agent Lounge's mark) sizes its box per avatar size
   *  with raft-ui's `group-data-[size=…]/avatar:` steps. */
  badgeClassName?: string;
  /** A fixed status light on the corner: raft-ui AvatarBadge's own dot
   *  (`presence`). For a light that subscribes to one agent's activity or
   *  carries a tooltip (AgentActivityDot), pass it as `badge` instead.
   *  Ignored when `badge` is set. */
  presence?: Presence;
  /** Where the badge's centre sits, from the avatar's top-left (raft-ui
   *  AvatarBadge `offset`). Omit for the theme's default bottom-right spot. */
  badgeOffset?: AvatarBadgeOffset;
  /** Another sticker in the avatar's corner, mounted as the Avatar's own
   *  child: raft-ui MessageItemDelegatedAvatar places itself bottom-right (a
   *  person has no presence light, so it never sits with `badge` or
   *  `presence`); another server's tile (AvatarOriginCorner) places itself
   *  top-left, clear of the light, and may sit with either. */
  corner?: ReactNode;
  /** Trusted preview content can supply an uncommitted upload without replacing the themed frame. */
  children?: ReactNode;
  /** Additional classes — appended to the outer container. Useful for
   *  callsite-specific tweaks (e.g. `grayscale opacity-60` for deactivated
   *  agents). Do not use this to add a background color or a size: the
   *  context owns the size. */
  className?: string;
}

interface AvatarImageWithFallbackProps {
  src?: string | null;
  fallback: ReactNode;
  alt?: string;
  className?: string;
}

export function AvatarImageWithFallback(props: AvatarImageWithFallbackProps) {
  // Loading/error state belongs to one URL, including when a previous URL is reused.
  return <AvatarImageContent key={props.src ?? ""} {...props} />;
}

function AvatarImageContent({
  src,
  fallback,
  alt = "",
  className = "h-full w-full object-cover",
}: AvatarImageWithFallbackProps) {
  const [loaded, setLoaded] = useState(false);
  const imageRef = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth > 0) setLoaded(true);
  }, []);
  return (
    <>
      {/* Transparent logos must not reveal the placeholder through their artwork. */}
      {!loaded && (
        <span className="pointer-events-none absolute inset-0 z-base flex items-center justify-center">
          {fallback}
        </span>
      )}
      {src ? (
        <img
          key={src}
          ref={imageRef}
          src={src}
          alt={alt}
          className={`relative z-raised ${className}`}
          onLoad={() => setLoaded(true)}
          onError={(event) => {
            event.currentTarget.hidden = true;
            setLoaded(false);
          }}
        />
      ) : null}
    </>
  );
}

/** Where a panel-header or switcher-row avatar is `sm` (27): the desktop query of raft-ui's size chain. */
const DESKTOP_MOUSE_QUERY = "(width >= 48rem) and (pointer: fine)";

/** The contexts that step down to `sm` with a mouse on a desktop. */
const DESKTOP_SM_CONTEXTS: ReadonlySet<AvatarContext> = new Set(["panel-header", "switcher-row"]);

function DesktopSmAvatarSlot(props: AvatarSlotProps) {
  const desktop = useMediaQuery(DESKTOP_MOUSE_QUERY);
  return <AvatarSlotFrame {...props} size={desktop ? "sm" : CONTEXT_SIZE[props.context]} />;
}

export default function AvatarSlot(props: AvatarSlotProps) {
  // Only these follow the window, so only they listen to the query.
  return DESKTOP_SM_CONTEXTS.has(props.context)
    ? <DesktopSmAvatarSlot {...props} />
    : <AvatarSlotFrame {...props} size={CONTEXT_SIZE[props.context]} />;
}

function AvatarSlotFrame({
  size,
  context,
  type,
  agentAvatarUrl,
  humanAvatarUrl,
  serverAvatarUrl,
  serverInitial,
  appAvatarUrl,
  appInitials,
  humanPlaceholder,
  badge,
  badgeClassName,
  presence,
  badgeOffset,
  corner,
  children,
  className = "",
}: AvatarSlotProps & { size: AvatarSize }) {
  let content: ReactNode;
  if (children !== undefined) {
    content = children;
  } else if (type === "agent") {
    content = <AgentAvatar avatarUrl={agentAvatarUrl ?? null} />;
  } else if (type === "server" || type === "app") {
    const initials = type === "server" ? serverInitial || "S" : appInitials || "A";
    const fallback = initials.trim().slice(0, type === "server" ? 1 : 2).toUpperCase() || (type === "server" ? "S" : "A");
    content = <AvatarImageWithFallback src={type === "server" ? serverAvatarUrl : appAvatarUrl} fallback={fallback} />;
  } else if (humanPlaceholder) {
    content = <User />;
  } else {
    content = <PersonAvatar avatarUrl={humanAvatarUrl ?? null} iconSize={PERSON_PLACEHOLDER_ICON[size]} />;
  }

  // A workspace tile is the ink square with yellow initials ("your
  // workspace", the same tile as the rail and the phone's Home pill); an app
  // without a logo keeps the default identity sticker.
  const workspaceTile = type === "server";
  return (
    <Avatar
      size={size}
      type={type === "agent" ? "agent" : "human"}
      className={`${workspaceTile ? "bg-sticker-ink" : ""} ${className}`.trim()}
      data-avatar-context={context}
      data-avatar-type={type}
    >
      {/* The workspace tile paints its ink + yellow on the fallback layer too,
          so the raft recipe's ink initials do not win inside it. Loaded
          images still cover this background. */}
      <AvatarFallback className={`relative overflow-hidden ${workspaceTile ? "bg-sticker-ink text-brand" : ""}`.trim()}>
        {content}
      </AvatarFallback>
      {badge ? (
        <AvatarBadge render={<span />} offset={badgeOffset} className={["flex rounded-[2px] [&>span]:h-full [&>span]:w-full", badgeClassName].filter(Boolean).join(" ")}>
          {badge}
        </AvatarBadge>
      ) : presence ? (
        <AvatarBadge presence={presence} offset={badgeOffset} />
      ) : null}
      {corner}
    </Avatar>
  );
}
