import { LeaveChannelIcon, LeaveJointChannelIcon, LeavePrivateChannelIcon } from "@botiverse/ricons";
import type { ReactNode, SVGProps } from "react";
import { useIntl } from "react-intl";
import type { Channel } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useStoredChannel } from "../../store/useStoredChannel";
import { channelKindIconProps } from "./channelKind";
import type { ChannelKindSource } from "./channelKind";

export const CHANNEL_KIND_ICON_SIZE = 14;

/**
 * A channel's kind icon on any surface. Pass the channel when the surface has
 * it; else its id, looked up in the current server's channels; `type` is the
 * fallback for a channel that isn't loaded (another server's, or not in the
 * store yet), drawn from its type alone. The public page is the current
 * server's unless `serverPublicPageLive` is given.
 */
export function ChannelIcon({
  channel,
  channelId,
  type = "channel",
  serverPublicPageLive,
  size = CHANNEL_KIND_ICON_SIZE,
  className,
}: {
  channel?: ChannelKindSource | null;
  channelId?: string | null;
  type?: Channel["type"];
  serverPublicPageLive?: boolean;
  size?: number;
  className?: string;
}) {
  const stored = useStoredChannel(channel ? null : channelId);
  const currentPublicPageLive = useServerStore((s) => s.current?.publicPageLive === true);
  const source = channel ?? stored;
  if (!source) return <ChannelKindIcon type={type} size={size} className={className} />;
  // A partial row without its type (an optimistic or cached one) keeps the caller's.
  const withType = source.type ? source : { ...source, type };
  return <ChannelKindIcon {...channelKindIconProps(withType, serverPublicPageLive ?? currentPublicPageLive)} size={size} className={className} />;
}

export function ChannelKindIcon({
  type,
  size = CHANNEL_KIND_ICON_SIZE,
  className,
  onPublicPage = false,
  external = false,
}: {
  type: Channel["type"];
  size?: number;
  className?: string;
  /** Anyone can read this channel on the server's public page (server public
   *  and channel visible to Guests): the # carries a small globe, the same
   *  mark as Public access in settings (cindyz, #wg-rbac:cbca4ee7). */
  onPublicPage?: boolean;
  /** It has a guest, a guest server or an open invite (Q12 A: the sidebar's
   *  External section, isSidebarExternalSectionChannel): the lock + arrow out,
   *  for a public, private or joint channel alike. Without it a joint channel
   *  keeps the branch. Surfaces don't set it by hand: channelKindIconProps /
   *  ChannelIcon choose it from the channel. */
  external?: boolean;
}) {
  if (external && (type === "channel" || type === "private" || type === "joint")) return <ExternalChannelGlyph size={size} className={className} />;
  if (type === "private") return <SinglePathIcon name="lock" d={LOCK_PATH} size={size} className={className} />;
  if (type === "channel" && onPublicPage) return <PublicChannelGlyph size={size} className={className} />;
  if (type === "joint") return <SinglePathIcon name="git-branch" d={GIT_BRANCH_PATH} size={size} className={className} />;
  if (type === "channel") return <SinglePathIcon name="hash" d={HASH_PATH} size={size} className={className} />;
  return null;
}

// lucide's #, lock and git-branch (lucide-react 1.55), each drawn as one path:
// the same strokes on the same 24-unit grid, but an <svg> with one child
// instead of lucide's 3–5 (lines, rect, circles). The sidebar draws one per
// channel row, a few hundred on a large server (#proj-frontend:#8).
const HASH_PATH = "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18";
const LOCK_PATH = "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM7 11V7a5 5 0 0 1 10 0v4";
const GIT_BRANCH_PATH = "M15 6a9 9 0 0 0-9 9V3M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0";

/**
 * An external channel: one with Guests, guest servers or pending external
 * invites (cindyz 10-30, #wg-rbac:0829b5df, option A right; Q12 A): lucide's
 * lock, shrunk into the top-left cells, with an arrow pointing out of the
 * bottom-right corner, the same construction as the # + globe. One glyph, one
 * variant: external channels are always private.
 */
const EXTERNAL_CHANNEL_PATH = "M3 9.5h9a1.5 1.5 0 0 1 1.5 1.5v0M3 9.5a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 3 17.5h5.5M4.5 9.5V6.5a3.5 3.5 0 0 1 7 0v3M13 21 21 13M15.5 13H21v5.5";

export function ExternalChannelIcon({ size = CHANNEL_KIND_ICON_SIZE, className }: { size?: number; className?: string }) {
  return <SinglePathIcon name="external-channel" d={EXTERNAL_CHANNEL_PATH} size={size} className={className} />;
}

/** A lucide-style stroke icon in one path; keeps lucide's classes, which tests and styles select. */
function SinglePathIcon({ name, d, size, className }: { name: string; d: string; size: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`lucide lucide-${name}${className ? ` ${className}` : ""}`}
    >
      <path d={d} />
    </svg>
  );
}

/** The external glyph with its meaning as text, like the # + globe (one glyph, a native tooltip, a screen-reader phrase). */
function ExternalChannelGlyph({ size, className }: { size: number; className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <MeaningfulGlyph label={formatMessage({ id: "channel.externalMembers" })}>
      <ExternalChannelIcon size={size} className={className} />
    </MeaningfulGlyph>
  );
}

/**
 * Leave, drawn on the channel's own kind glyph with a minus (raft-ui action
 * icons): # for a public channel, the lock for a private one, the branch for
 * a joint one. Icon audit v7: one meaning, one icon, so Leave is not LogOut
 * (that is signing out of Raft).
 */
export function LeaveChannelKindIcon({
  type,
  size,
  className,
}: {
  type: Channel["type"] | undefined;
  size: number;
  className?: string;
}) {
  const Icon = type === "private" ? LeavePrivateChannelIcon : type === "joint" ? LeaveJointChannelIcon : LeaveChannelIcon;
  return <Icon width={size} height={size} className={className} />;
}

/**
 * The glyph carries meaning, so screen readers get it as text and pointer
 * users as a native tooltip (cindyz: "顺手加一下"), like the server-name globe.
 */
function PublicChannelGlyph({ size, className }: { size: number; className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <MeaningfulGlyph label={formatMessage({ id: "channel.publicPageReadable" })}>
      <HashGlobeIcon size={size} className={className} />
    </MeaningfulGlyph>
  );
}

/** A glyph that carries meaning: the label as a native tooltip and as text for screen readers. */
function MeaningfulGlyph({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center" title={label}>
      {children}
      {/* The comma keeps it a separate phrase before the channel name. */}
      <span className="sr-only">{`${label}, `}</span>
    </span>
  );
}

/**
 * One glyph, not two stacked icons (cindyz): lucide's # with its bottom-right
 * cell given over to a larger Globe (circle, meridian, equator); the hash
 * strokes stop short of it, so the two read as one mark at 14px. Every stroke
 * is 2 units, like lucide's own #: a thinner globe stroke rendered as grey
 * partial pixels with solid dots where lines cross (cindyz: crossings looked
 * darker).
 */
function HashGlobeIcon({ size, ...props }: { size: number } & Omit<SVGProps<SVGSVGElement>, "ref">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-on-public-page=""
      {...props}
    >
      <line x1="2.5" x2="15" y1="8" y2="8" />
      <line x1="2.5" x2="8" y1="14" y2="14" />
      <line x1="8.5" x2="7" y1="2.5" y2="17" />
      <line x1="13.5" x2="13" y1="2.5" y2="8" />
      <circle cx="16.5" cy="16.5" r="6.5" />
      <path d="M16.5 10a9 9 0 0 0 0 13 9 9 0 0 0 0-13" />
      <path d="M10 16.5h13" />
    </svg>
  );
}
