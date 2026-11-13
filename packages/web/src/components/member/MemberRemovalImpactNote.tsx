import { Spinner } from "@botiverse/raft-ui";
import type { MemberRemovalImpact } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import Banner from "../ui/Banner";
import type { MemberRemovalImpactState } from "./useMemberRemovalImpact";

/**
 * The impact line of the confirmation, or nothing when nothing goes offline.
 * With `memberName` it is the Remove dialog's and names the member; without,
 * the Leave dialog's, which speaks of the Computers you attached.
 * `banner`: put a non-zero impact in its own warning Banner (the Leave dialog,
 * whose message has no frame); otherwise it is a paragraph inside the caller's
 * frame (the Remove dialog's danger banner, so the dialog keeps one banner).
 */
export function MemberRemovalImpactNote({
  state,
  memberName,
  banner = false,
}: {
  state: MemberRemovalImpactState;
  memberName?: string;
  banner?: boolean;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;

  if (state.kind === "none") return null;
  if (state.kind === "loading") {
    return (
      <p className="mt-2 flex items-center gap-2" data-testid="member-removal-impact-loading">
        <Spinner size="xs" aria-hidden="true" />
        {formatMessage({ id: "member.removalImpact.loading" })}
      </p>
    );
  }
  if (state.kind === "failed") {
    return (
      <p className="mt-2" data-testid="member-removal-impact-failed">
        {formatMessage({ id: "member.removalImpact.failed" })}
      </p>
    );
  }

  const { computers, othersAgents } = state.impact;
  if (computers <= 0) return null;
  const names = formatImpactComputerNames(intl, state.impact);
  const computersLine = memberName !== undefined
    ? formatMessage({ id: "member.removalImpact.remove" }, { name: memberName, computers, names })
    : formatMessage({ id: "member.removalImpact.leave" }, { computers, names });
  const text = othersAgents > 0
    ? formatMessage({ id: "member.removalImpact.withOthersAgents" }, {
      computersLine,
      othersLine: formatMessage({ id: "member.removalImpact.othersAgents" }, { count: othersAgents }),
    })
    : computersLine;

  // How they come back (Warden, 2026-11-09): the same for leaving and removing.
  const recover = formatMessage({ id: "member.removalImpact.recover" }, { computers });

  if (banner) {
    return (
      <Banner intent="warning" withIcon live={false} className="mt-3" data-testid="member-removal-impact">
        <p data-testid="member-removal-impact-line">{text}</p>
        <p className="mt-1" data-testid="member-removal-impact-recover">{recover}</p>
      </Banner>
    );
  }
  return (
    <>
      <p className="mt-2" data-testid="member-removal-impact">{text}</p>
      <p className="mt-1" data-testid="member-removal-impact-recover">{recover}</p>
    </>
  );
}

/**
 * The route names at most three Computers; any beyond read as "others"
 * rather than a count, since the counts may run slightly high.
 */
function formatImpactComputerNames(intl: IntlShape, impact: MemberRemovalImpact): string {
  const { computers, computerNames } = impact;
  return intl.formatList(
    computerNames.length < computers
      ? [...computerNames, intl.formatMessage({ id: "member.removalImpact.moreComputers" })]
      : computerNames,
    { type: "conjunction" },
  );
}

/**
 * Making someone else an owner, or stepping down from owner yourself: the
 * Computers you attached here stay online while you are a member, and would
 * go offline if you left later (#13527 revokes them with the membership).
 * `state` is your own removal impact. Nothing unless you attached some; a
 * read still going or failed says nothing either, as the change revokes
 * nothing.
 */
export function OwnComputersTransferNote({ state, className = "mt-3" }: { state: MemberRemovalImpactState; className?: string }) {
  const intl = useIntl();
  if (state.kind !== "ready" || state.impact.computers <= 0) return null;
  return (
    <Banner intent="info" withIcon live={false} className={className} data-testid="owner-transfer-computers">
      {intl.formatMessage(
        { id: "member.removalImpact.transfer" },
        { computers: state.impact.computers, names: formatImpactComputerNames(intl, state.impact) },
      )}
    </Banner>
  );
}
