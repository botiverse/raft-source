// Member labels (#wg-rbac:#46): the three marks raft-ui has no part for yet.
// Candidates for raft-ui, kept in this one file until they move there:
//
// - AvatarOriginCorner: another server's tile on an avatar's top-left corner
//   (raft-ui Avatar has one corner, the bottom-right, for the presence light);
// - ExternalOriginRibbon: the band across the top of the profile hover card
//   (raft-ui PreviewCard has a header, a separator and a description);
// - RoleCornerTag: the folded tag in the hover card's top-right corner (a
//   raft-ui Badge is an inline chip, not a corner of its card).
//
// A server's tile is the product's own workspace tile (AvatarSlot
// `type="server"`, as in the forward and invite pickers); what is drawn here
// is only where it sits: the corner placement and its size, the ribbon and
// the tag. They use raft-ui's tokens and sit inside raft-ui's Avatar and
// PreviewCard.
import { useIntl } from "react-intl";
import AvatarSlot from "../ui/AvatarSlot";
import Tooltip from "../ui/Tooltip";
import { useServerStore } from "../../store/serverStore";
import { originServerNames } from "../../utils/memberOrigin";
import type { MemberOrigin, OriginServer } from "../../utils/memberOrigin";

/**
 * A server's own tile at the pickers' 14px: its logo when this client has it
 * (the servers the viewer belongs to), else its initial. Decoration: the name
 * is always written or spoken beside it. `className` resizes it.
 */
function ServerOriginTile({ server, className }: { server: OriginServer; className?: string }) {
  // The API names another server but sends no logo for it; only a server the
  // viewer is also a member of has one here.
  const logoUrl = useServerStore((state) => state.servers.find((candidate) => candidate.id === server.id)?.avatarUrl ?? null);
  return (
    <span aria-hidden="true" data-origin-tile={logoUrl ? "logo" : "initial"} className="inline-flex size-full shrink-0">
      <AvatarSlot context="picker-trigger" type="server" serverAvatarUrl={logoUrl} serverInitial={server.name} className={className} />
    </span>
  );
}

/**
 * The mark of someone from another server, on their avatar's top-left corner
 * (the bottom-right stays the presence light or the delegated face). Pass it
 * as AvatarSlot's `corner`. It is decoration: every place that shows it says
 * where the person is from in words too (the server's name beside it, or the
 * author row's "From …" after the name), so it is hidden from assistive tech
 * and never names the avatar's button. A tooltip names the servers on hover.
 *
 * It sizes itself from the avatar as drawn, not from its size name: the
 * message row shrinks an `md` avatar with `--mi-avatar`. A query container
 * over the avatar gives the tile a share of the face, with a floor and a cap;
 * on a small face (a narrow row) the tile is a plain dot, as it always is
 * with `dot` (the @ list's xs faces), where an initial cannot be read.
 */
export function AvatarOriginCorner({ origin, dot = false }: { origin: MemberOrigin; dot?: boolean }) {
  const first = origin.servers[0];
  if (!origin.external || !first) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="avatar-origin-corner"
      data-origin-mark={dot ? "dot" : "tile"}
      className="pointer-events-none absolute inset-0 z-raised @container/origin"
    >
      <Tooltip content={originServerNames(origin)}>
        <span className="pointer-events-auto absolute -top-[clamp(3px,9cqw,5px)] -left-[clamp(3px,9cqw,5px)] flex size-[clamp(7px,42cqw,19px)]">
          {dot ? (
            <span
              data-origin-tile="dot"
              className="size-full rounded-full border border-sticker-ink bg-sticker-ink shadow-[0_0_0_1.5px_var(--sticker-edge)]"
            />
          ) : (
            <ServerOriginTile
              server={first}
              className="size-full! text-[length:clamp(8px,23cqw,11px)]! [&_*]:text-[length:inherit]! @max-[26px]/origin:rounded-full! @max-[26px]/origin:[&>*]:invisible"
            />
          )}
        </span>
      </Tooltip>
    </span>
  );
}

/**
 * The hover card's mark of someone from another server: a band across the
 * card's top with every server (tile and name) and "External" at its end.
 * Read out as one sentence, "External: Acme Corp, Lumen Labs".
 */
export function ExternalOriginRibbon({ origin }: { origin: MemberOrigin }) {
  const { formatMessage } = useIntl();
  if (!origin.external) return null;
  const external = formatMessage({ id: "message.profilePreview.external" });
  return (
    <div
      data-testid="profile-card-external-ribbon"
      className="flex h-7 items-center gap-1.5 bg-info-soft px-4 text-caption font-medium text-foreground"
    >
      <span className="sr-only">
        {origin.servers.length > 0
          ? formatMessage({ id: "message.profilePreview.externalFrom" }, { servers: originServerNames(origin) })
          : external}
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-1.5">
        {origin.servers.map((server) => (
          <span key={server.id} className="inline-flex size-3.5 shrink-0"><ServerOriginTile server={server} /></span>
        ))}
        <span className="min-w-0 truncate" data-testid="profile-card-external-servers">
          {origin.servers.map((server) => server.name).join(" · ")}
        </span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-foreground-muted">{external}</span>
    </div>
  );
}

/**
 * A server role (Owner, Admin, Guest) as the folded tag in the hover card's
 * top-right corner. It lies over the corner and takes no row of its own: the
 * card's header starts at its usual padding. Its nearest positioned ancestor
 * must be the card. Neutral grey: cyan means "from another server" here.
 * Put a RoleCornerTagSpacer at the end of the card's name line.
 */
export function RoleCornerTag({ label }: { label: string }) {
  return (
    <div
      data-testid="profile-card-role-tag"
      className="absolute top-0 right-0 flex h-6 items-center rounded-bl-[10px] bg-fill-medium pr-3 pl-2.5 text-caption font-medium text-foreground"
    >
      {label}
    </div>
  );
}

/**
 * Keeps the name line clear of the RoleCornerTag: an invisible, zero-height
 * copy of the tag's text at the end of the line, so a long name truncates
 * before the tag instead of running under it. No row, no height.
 */
export function RoleCornerTagSpacer({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="profile-card-role-tag-spacer"
      className="invisible h-0 shrink-0 overflow-hidden pl-2.5 text-caption font-medium whitespace-nowrap"
    >
      {label}
    </span>
  );
}
