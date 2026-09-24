// Server member role → catalog id. The role arrives from the server as a raw
// enum ("owner"/"admin"/"member"); rendering it verbatim showed English badges
// in the zh UI (DOM sweep, 2026-08-04). @AngLee ruled owner→所有者 (consistent
// with settings.admins.owner), admin→管理员, member→成员.
import type { MessageId } from "../i18n/messages/en";

export function memberRoleLabelId(role: string): MessageId | null {
  switch (role) {
    case "owner":
      return "member.role.owner";
    case "admin":
      return "member.role.admin";
    case "member":
      return "member.role.member";
    default:
      return null;
  }
}

/** Render the role via the app catalog, or null when the role is unknown. */
export function formatMemberRole(
  role: string,
  formatMessage: (m: { id: MessageId }) => string,
): string | null {
  const id = memberRoleLabelId(role);
  return id ? formatMessage({ id }) : null;
}
