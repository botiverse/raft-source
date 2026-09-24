import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { User } from "../../store/authStore";

interface SignedInAsProps {
  user: User | null | undefined;
  className?: string;
  nameClassName?: string;
  suffix?: ReactNode;
  /**
   * Localized "Signed in as" lead-in. Defaults to
   * `pages.humanLogin.signedInAsPrefix`; callers may pass a different resolved
   * prefix (e.g. device-login).
   */
  prefix?: ReactNode;
}

/**
 * Always the email, deliberately (@cindyz, 2026-07-22).
 *
 * Every surface that renders this asks the same question — "is this the right ACCOUNT?":
 * approve a device login, authorize a service, choose a first server, log out. Email is the
 * one identifier that answers it: `users.email` is NOT NULL and unique, while a display name
 * is user-editable and two people may share one.
 *
 * It also removes a whole class of bug rather than patching it. The old chain was
 * `displayName || name || email`, and before identity setup `displayName` is null and `name`
 * still holds the server's internal `pending_<hex>` reservation — so the line rendered
 * "Signed in as pending_a1b2…" back to the person we were asking to choose a handle. Reading
 * only the email means there is no placeholder to leak in the first place.
 */
function authDisplayName(
  user: User | null | undefined,
  unknownUserLabel: string,
) {
  // No user at all (nobody authenticated yet, or the session still loading) is the only case
  // without an email.
  return user?.email || unknownUserLabel;
}

export default function SignedInAs({
  user,
  className,
  nameClassName = "font-bold",
  suffix,
  prefix,
}: SignedInAsProps) {
  const { formatMessage } = useIntl();
  const resolvedPrefix = prefix ?? formatMessage({ id: "pages.humanLogin.signedInAsPrefix" });
  const displayName = authDisplayName(user, formatMessage({ id: "auth.signedInAs.unknownUser" }));

  return (
    <span className={className}>
      {resolvedPrefix} <strong className={nameClassName}>{displayName}</strong>{suffix}
    </span>
  );
}
