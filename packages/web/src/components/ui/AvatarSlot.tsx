import type { ReactElement, ReactNode } from "react";
import { User } from "lucide-react";
import { Avatar, AvatarBadge } from "raft-ui";
import type { AvatarSize } from "raft-ui";
import { AgentAvatar } from "../agent/PixelAvatar";
import GravatarAvatar from "../member/GravatarAvatar";

/**
 * Canonical avatar container — replaces inline avatar frame wrappers across
 * the app (panel headers, message rows, sidebar lists, member rows, machine
 * agent lists, dropdown items, etc).
 *
 * Avatar frames keep the Slock brutalist black border AND carry an
 * identity-keyed background color — `bg-brutal-cyan` (agent),
 * `bg-brutal-lavender` (human), `bg-soft-signal` (app), or black/yellow server
 * initials. The bg is only visible when the inner avatar content is a
 * placeholder (no image): the centered fallback `<User>` icon, app initials,
 * server initial, or the gravatar pre-load state then sits on top of the
 * identity-tinted surface.
 *
 * **Fill invariant** (both rules must hold simultaneously, stdrc 2026-05-20
 * #proj-uiux:d7e5c75b):
 * 1. The role bg color is always on the container so placeholder paths render
 *    on a tinted surface instead of showing the host surface (cream sidebar,
 *    etc.) through a transparent frame.
 * 2. Real avatar images (PixelAvatar / AgentAvatar / GravatarAvatar `<img>`)
 *    MUST cover the full inner area (`h-full w-full object-cover`, or the
 *    `!w-full !h-full` PixelAvatar override) so the role bg stays hidden
 *    behind the image and never leaks around it as an accidental second frame.
 *    (#1873 was the original mandate for the fill rule; this primitive
 *    re-introduces the bg color now that the fill rule is enforced.)
 *
 * | context        | container    | border    | agent pixel | gravatar size / icon | placeholder icon | server initial |
 * |----------------|--------------|-----------|-------------|----------------------|------------------|----------------|
 * | profile-tile   | size-16      | border-2  | 60          | 60 / 32              | 32               | text-2xl       |
 * | account-tile   | size-14      | border-2  | 52          | 52 / 24              | 24               | text-xl        |
 * | mention-card   | size-12      | border-2  | 44          | 44 / 24              | 24               | text-lg        |
 * | panel-header   | size-9       | border-2  | 32          | 32 / 16              | 18               | text-sm        |
 * | surface-list   | size-8       | border-2  | 28          | 28 / 16              | 16               | text-xs        |
 * | members-row    | size-7       | border    | 26          | 24 / 14              | 14               | text-xs        |
 * | creator-link   | size-[22px]  | border    | 20          | 20 / 12              | 12               | text-[10px]    |
 * | sidebar-list   | size-[18px]  | border    | 16          | 16 / 10              | 10               | text-[9px]     |
 * | compact-list   | size-5       | border    | 18          | 18 / 12              | 12               | text-[10px]    |
 * | preview-mini   | size-[14px]  | border    | 14          | 14 / 10              | 10               | text-[8px]     |
 *
 * Identity precedence (highest first):
 * 1. `agentAvatarUrl` for `type="agent"` — AgentAvatar handles `pixel:*` keys
 *    and uploaded image URLs uniformly.
 * 2. `humanPlaceholder` for `type="human"` — render User icon (no Gravatar
 *    fetch attempt). Use this when you know there is no gravatar identity
 *    (e.g. anonymous/missing user) and want a stable static placeholder.
 * 3. `humanAvatarUrl` for `type="human"` — uploaded human profile image.
 * 4. `appAvatarUrl` for `type="app"` — uploaded app logo image.
 * 5. `serverAvatarUrl` for `type="server"` — uploaded server profile image.
 * 6. `gravatarHash` / `email` — GravatarAvatar (with internal User-icon
 *    fallback when neither resolves to a hash).
 *
 * Caller responsibility:
 * - Wrapping the slot in a `<button>` for clickable surfaces. Click + hover
 *   styles (e.g. `hover:brightness-90 transition-colors`) live on the
 *   call site — different surfaces have different interactive targets.
 * - Passing `className` for callsite-specific tweaks (e.g. `grayscale
 *   opacity-60` for deactivated agents in MessageItem; `mt-0.5` for vertical
 *   nudges). Do not add background color through `className`.
 *
 * Do NOT inline new avatar containers — extend this primitive instead.
 */
export type AvatarContext =
  | "profile-tile"
  | "account-tile"
  | "mention-card"
  | "panel-header"
  | "surface-list"
  | "members-row"
  | "creator-link"
  | "sidebar-list"
  | "compact-list"
  | "preview-mini";

interface ContextSpec {
  /** `h-X w-X` Tailwind classes — fixes container box. */
  size: string;
  /** `border` (1px) for ≤ h-7, `border-2` (2px) for ≥ h-8. */
  border: string;
  /** PixelAvatar `size` prop (used for agents). */
  agentPixel: number;
  /** GravatarAvatar `size` prop (used for humans). */
  gravatarSize: number;
  /** GravatarAvatar `iconSize` prop (used for humans, controls internal User
   *  icon fallback). */
  gravatarIcon: number;
  /** Lucide `<User size={...}>` for explicit `humanPlaceholder` path. */
  placeholderIcon: number;
  /** Text size for server initial placeholders. */
  serverInitialText: string;
}

const SPEC: Record<AvatarContext, ContextSpec> = {
  "profile-tile": {
    size: "size-16",
    border: "border-2",
    agentPixel: 60,
    gravatarSize: 60,
    gravatarIcon: 32,
    placeholderIcon: 32,
    serverInitialText: "text-2xl",
  },
  "account-tile": {
    size: "size-14",
    border: "border-2",
    agentPixel: 52,
    gravatarSize: 52,
    gravatarIcon: 24,
    placeholderIcon: 24,
    serverInitialText: "text-xl",
  },
  "mention-card": {
    size: "size-12",
    border: "border-2",
    agentPixel: 44,
    gravatarSize: 44,
    gravatarIcon: 24,
    placeholderIcon: 24,
    serverInitialText: "text-lg",
  },
  "panel-header": {
    size: "size-9",
    border: "border-2",
    agentPixel: 32,
    gravatarSize: 32,
    gravatarIcon: 16,
    placeholderIcon: 18,
    serverInitialText: "text-sm",
  },
  "surface-list": {
    size: "size-8",
    border: "border-2",
    agentPixel: 28,
    gravatarSize: 28,
    gravatarIcon: 16,
    placeholderIcon: 16,
    serverInitialText: "text-xs",
  },
  "members-row": {
    size: "size-7",
    border: "border",
    agentPixel: 26,
    gravatarSize: 24,
    gravatarIcon: 14,
    placeholderIcon: 14,
    serverInitialText: "text-xs",
  },
  "creator-link": {
    size: "size-[22px]",
    border: "border",
    agentPixel: 20,
    gravatarSize: 20,
    gravatarIcon: 12,
    placeholderIcon: 12,
    serverInitialText: "text-[10px]",
  },
  "sidebar-list": {
    size: "size-[18px]",
    border: "border",
    agentPixel: 16,
    gravatarSize: 16,
    gravatarIcon: 10,
    placeholderIcon: 10,
    serverInitialText: "text-[9px]",
  },
  "compact-list": {
    size: "size-5",
    border: "border",
    agentPixel: 18,
    gravatarSize: 18,
    gravatarIcon: 12,
    placeholderIcon: 12,
    serverInitialText: "text-[10px]",
  },
  "preview-mini": {
    size: "size-[14px]",
    border: "border",
    agentPixel: 14,
    gravatarSize: 14,
    gravatarIcon: 10,
    placeholderIcon: 10,
    serverInitialText: "text-[8px]",
  },
};

/**
 * Keep the legacy AvatarSlot box and border explicit even when the matching
 * raft-ui public size is identical. Presence chrome must not make an identity
 * surface silently inherit a future Avatar scale change.
 */
const RAFT_AVATAR_SPEC: Record<AvatarContext, { size: AvatarSize; className: string }> = {
  "profile-tile": { size: "xl", className: "!size-16 !border-2" },
  "account-tile": { size: "xl", className: "!size-14 !border-2" },
  "mention-card": { size: "lg", className: "!size-12 !border-2" },
  "panel-header": { size: "md", className: "!size-9 !border-2" },
  "surface-list": { size: "sm", className: "!size-8 !border-2" },
  "members-row": { size: "sm", className: "!size-7 !border" },
  "creator-link": { size: "xs", className: "!size-[22px] !border" },
  "sidebar-list": { size: "2xs", className: "!size-[18px] !border" },
  "compact-list": { size: "xs", className: "!size-5 !border" },
  "preview-mini": { size: "3xs", className: "!size-[14px] !border" },
};

export interface AvatarSlotProps {
  context: AvatarContext;
  /** Entity kind — controls which inner renderer is used. */
  type: "agent" | "human" | "server" | "app";
  /** Agent's avatarUrl (`pixel:*` key or uploaded image URL). Used when
   *  `type="agent"`. */
  agentAvatarUrl?: string | null;
  /** Human's gravatar hash. Used when `type="human"`. */
  gravatarHash?: string | null;
  /** Human's uploaded avatar URL. Used before Gravatar when `type="human"`. */
  humanAvatarUrl?: string | null;
  /** Server's uploaded avatar URL. Used when `type="server"`. */
  serverAvatarUrl?: string | null;
  /** Server initial placeholder. Used when `type="server"` has no avatar. */
  serverInitial?: string | null;
  /** App logo URL. Used when `type="app"`. */
  appAvatarUrl?: string | null;
  /** App initials placeholder. Used when `type="app"` has no logo. */
  appInitials?: string | null;
  /** Optional email — GravatarAvatar derives a hash client-side when
   *  `gravatarHash` is missing. Used when `type="human"`. */
  email?: string | null;
  /** When `type="human"`, render a static User-icon placeholder instead of
   *  attempting a Gravatar lookup. Use when no gravatar identity is known. */
  humanPlaceholder?: boolean;
  /** Optional corner indicator. When present, the identity frame is rendered
   *  by raft-ui Avatar and the indicator is mounted through AvatarBadge so
   *  size and bottom-right placement stay canonical across call sites. */
  badge?: ReactElement;
  /** Additional classes — appended to the outer container. Useful for
   *  callsite-specific tweaks (e.g. `grayscale opacity-60` for deactivated
   *  agents). Do not use this to add a background color. */
  className?: string;
}

export function AvatarImageWithFallback({
  src,
  fallback,
  alt = "",
  className = "h-full w-full object-cover",
}: {
  src?: string | null;
  fallback: ReactNode;
  alt?: string;
  className?: string;
}) {
  return (
    <>
      {/* Positioned fallbacks paint above ordinary in-flow children. Give both
          layers an explicit stack order so a valid avatar always covers its
          placeholder; hiding the broken image reveals the fallback again. */}
      <span className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
        {fallback}
      </span>
      {src ? (
        <img
          key={src}
          src={src}
          alt={alt}
          className={`relative z-[1] ${className}`}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
    </>
  );
}

export default function AvatarSlot({
  context,
  type,
  agentAvatarUrl,
  gravatarHash,
  humanAvatarUrl,
  serverAvatarUrl,
  serverInitial,
  appAvatarUrl,
  appInitials,
  email,
  humanPlaceholder,
  badge,
  className = "",
}: AvatarSlotProps) {
  const spec = SPEC[context];
  // Identity-keyed placeholder bg: only visible when the inner content is a
  // fallback icon (placeholder branches + gravatar pre-load). Real avatar
  // images cover this bg edge-to-edge via the fill invariant documented above.
  const fallbackBg = type === "agent"
    ? "bg-brutal-cyan"
    : type === "human"
      ? "bg-brutal-lavender"
      : type === "app"
        ? "bg-soft-signal text-black font-display font-black"
        : "bg-black text-soft-signal font-display font-bold";
  const baseClass = `relative flex shrink-0 items-center justify-center overflow-hidden ${spec.size} ${spec.border} border-black ${fallbackBg}`;

  if (type === "agent") {
    // Agent path: stretch to fill the full inner area instead of relying on a
    // fixed pixel size. Custom uploaded images already use object-cover.
    if (badge) {
      const raftSpec = RAFT_AVATAR_SPEC[context];
      return (
        <Avatar
          size={raftSpec.size}
          type="agent"
          className={`${raftSpec.className} ${className}`.trim()}
        >
          <AgentAvatar avatarUrl={agentAvatarUrl ?? null} size={spec.agentPixel} className="!h-full !w-full" />
          <AvatarBadge render={badge} />
        </Avatar>
      );
    }
    return (
      <div className={`${baseClass} ${className}`.trim()}>
        <AgentAvatar avatarUrl={agentAvatarUrl ?? null} size={spec.agentPixel} className="!w-full !h-full" />
      </div>
    );
  }

  if (type === "server") {
    const fallback = (serverInitial || "S").trim().charAt(0).toUpperCase() || "S";
    return (
      <div className={`${baseClass} ${spec.serverInitialText} ${className}`.trim()}>
        <AvatarImageWithFallback src={serverAvatarUrl} fallback={fallback} />
      </div>
    );
  }

  if (type === "app") {
    const fallback = (appInitials || "A").trim().slice(0, 2).toUpperCase() || "A";
    return (
      <div className={`${baseClass} ${spec.serverInitialText} ${className}`.trim()}>
        <AvatarImageWithFallback src={appAvatarUrl} fallback={fallback} />
      </div>
    );
  }

  // Human path. Staging adds `text-black` on human containers (controls the
  // User-icon fallback color); preserve it.
  const humanBase = `${baseClass} text-black`;

  if (humanPlaceholder) {
    return (
      <div className={`${humanBase} ${className}`.trim()}>
        <User size={spec.placeholderIcon} />
      </div>
    );
  }

  return (
    <div className={`${humanBase} ${className}`.trim()}>
      <GravatarAvatar
        avatarUrl={humanAvatarUrl ?? null}
        gravatarHash={gravatarHash ?? null}
        email={email ?? undefined}
        size={spec.gravatarSize}
        iconSize={spec.gravatarIcon}
      />
    </div>
  );
}
