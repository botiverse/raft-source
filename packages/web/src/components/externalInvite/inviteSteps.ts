import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiErrorStatus, getExternalInvite } from "./externalInviteAccept";
import type { ExternalInviteForInvitee } from "./externalInviteAccept";
import type { ChosenOutcome } from "./InviteProgress";

/** Where the accepted invite put them (GET `accepted`): the channel they open from "#channel is ready". */
type Landing = NonNullable<ExternalInviteForInvitee["accepted"]>;

/** The invite page's steps (ExternalInvitePage). */
export type InviteStep =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "loadFailed" }
  | { kind: "wrongAccount"; maskedEmail?: string }
  | { kind: "options" }
  | { kind: "guest" }
  | { kind: "connect" }
  | { kind: "newServer" }
  /** The chosen servers that need approval: an approver picked for each. */
  | { kind: "approval"; serverIds: string[] }
  | { kind: "waiting"; request: { serverId: string; serverName: string; approverName: string; expiresAt: string } | null }
  /** Several servers under way (or just chosen: `chosen`, each with what connect-servers answered and its name then). */
  | { kind: "progress"; chosen: ChosenOutcome[] }
  | { kind: "connecting"; serverId: string | null }
  | { kind: "connected"; serverId: string | null; landing: Landing | null };

/** A line about how the page got back to the ways in: a connection that didn't go through, of the server it was connecting when known. */
export type InviteNotice = { kind: "connectFailed"; serverId: string | null };

/** The invite as last read, the step it puts the page on, and a line about how it got there: one state, set together. */
export type InviteView = { invite: ExternalInviteForInvitee | null; step: InviteStep; notice: InviteNotice | null };

/**
 * The step an invite's status puts the page on. Several of this invite's
 * servers under way (the server lists only this invite's: connected with it,
 * being connected, or waiting): the progress list.
 */
export function stepForStatus(invite: ExternalInviteForInvitee, connectingServerId: string | null): InviteStep {
  if (invite.addressedToYou === false) return { kind: "wrongAccount", maskedEmail: invite.invitedEmailMasked };
  if (invite.status === "accepted") return { kind: "connected", serverId: invite.accepted?.serverId ?? null, landing: invite.accepted ?? null };
  if ((invite.status === "awaiting_approval" || invite.status === "connecting") && (invite.servers?.length ?? 0) > 1) return { kind: "progress", chosen: [] };
  const pending = invite.pendingRequest;
  if (invite.status === "awaiting_approval") return { kind: "waiting", request: pending ? { serverId: pending.serverId, serverName: pending.serverName, approverName: pending.approverName, expiresAt: pending.expiresAt } : null };
  if (invite.status === "connecting") return { kind: "connecting", serverId: connectingServerId ?? invite.connectServerId ?? null };
  return { kind: "options" };
}

/**
 * Asks again, every `pollMs`, while something is under way: a connection
 * (202, or opened while one is), a request waiting for its approver, or the
 * progress list while one of its servers connects or waits (each answer shown
 * as is). Connecting or waiting: once the invite is no longer so, the page
 * moves to the step it is on now; accepted answers the person who accepted it
 * with where they landed (`onAccepted`; a neutral 404 from an older server
 * reads as connected too); a connection back to pending didn't go through
 * (the server emails them too), a request back to pending was declined or
 * withdrawn (its own banner says so).
 */
export function useInvitePolling({ token, step, invite, pollMs, setView, onAccepted }: {
  token: string;
  step: InviteStep;
  invite: ExternalInviteForInvitee | null;
  pollMs: number;
  setView: Dispatch<SetStateAction<InviteView>>;
  onAccepted: (landing: Landing) => void;
}): void {
  const connectingServerId = step.kind === "connecting" ? step.serverId : null;
  const progressing = step.kind === "progress";
  const waiting = step.kind === "waiting";
  const polling = step.kind === "connecting" || waiting
    || (progressing && (invite?.status === "connecting" || invite?.status === "awaiting_approval"));
  // One read per tick; each answer sets the view once (the interval itself is not state).
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = setInterval(() => {
      getExternalInvite(token)
        .then((data) => {
          if (cancelled) return;
          if (progressing) {
            setView((current) => ({ ...current, invite: data }));
            return;
          }
          // Still as it was: nothing to show yet.
          if (data.status === (waiting ? "awaiting_approval" : "connecting")) return;
          setView({
            invite: data,
            step: stepForStatus(data, null),
            notice: data.status === "pending" && !waiting ? { kind: "connectFailed", serverId: connectingServerId } : null,
          });
          if (data.status === "accepted" && data.accepted) onAccepted(data.accepted);
        })
        .catch((err: unknown) => {
          if (cancelled || progressing || waiting || apiErrorStatus(err) !== 404) return;
          setView((current) => ({ ...current, step: { kind: "connected", serverId: connectingServerId, landing: null } }));
        });
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, progressing, waiting, connectingServerId, token, pollMs, setView, onAccepted]);
}
