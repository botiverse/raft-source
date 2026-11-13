import type { ReactNode } from "react";
import { originServerNames } from "../../utils/memberOrigin";
import type { MemberOrigin } from "../../utils/memberOrigin";

/**
 * A channel member row's name line (#wg-rbac:#46). Someone from another
 * server: the name, then every server they are from in quiet text ("Acme
 * Corp, Lumen Labs"), the same wording as the @ list; the row's avatar carries
 * the server's tile. When the line runs out of room the server names give way
 * first and the name stays whole. Anyone else: the name and `localTags` (a
 * member of the viewed server who is also in another keeps those tags).
 */
export function MemberRowName({ name, origin, localTags }: { name: string; origin: MemberOrigin; localTags?: ReactNode }) {
  const serverNames = origin.external ? originServerNames(origin) : "";
  if (serverNames) {
    return (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 shrink truncate">{name}</span>
        <span
          data-testid="member-row-origin-servers"
          className="min-w-0 shrink-[999] truncate text-caption font-normal text-foreground-hint"
        >
          {serverNames}
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">{name}</span>
      {origin.external ? null : localTags}
    </span>
  );
}
