/**
 * Settings › Account › Delete Account (/s/<slug>/settings/account/delete;
 * #triage:c3d9bd7c, #triage:d10ace06), a level-2 Settings page: content that
 * doesn't fit a dialog is a page (DS: Dialog).
 *
 * 1. The list (AccountDeletionChecklist, v7) from GET. Delete Account sends
 *    the request with no proof first: the server answers with what it wants
 *    (403 `reauth_required` with `methods`), or schedules at once after a
 *    recent sign-in.
 * 2. The proof the server asked for, in a small dialog over the page
 *    (DeleteAccountVerifyDialog).
 * 3. 409 `sole_owner_servers` (the server checks again; the only check on an
 *    older server): those servers join the page's Needs action rows, and the
 *    list is read again. Then 409 `others_agents_on_computers`: other
 *    members' agents still on the person's computers; the 409's list stands
 *    for that group until the read it starts lands. The person's own agents
 *    don't hold it up (#12468). 403 `session_family_required`: Sign In Again.
 *
 *    Force Unbind and Request Deletion (ForceUnbindAgentsDialog) sends the same
 *    request, every step of it, with `forceAgentIds`, the agents the person
 *    confirmed; a 409 `others_agents_on_computers` then means more arrived:
 *    the group is redrawn from it and a line asks to confirm again.
 *
 * The list is read again after every action and whenever the page gets focus
 * again (an owner moves their agent elsewhere, so its row goes).
 * 4. Scheduled: every sign-in is already gone. The confirmation
 *    (pages/AccountDeletionRequestedPage) stands in for the whole shell, so
 *    nothing keeps asking; it says when, and OK signs out.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useSearchParams } from "react-router-dom";

import { disconnectSocket } from "../../../api/socket";
import Banner from "../../../components/ui/Banner";
import { markAccountDeletionRequested } from "../../../store/accountDeletionPending";
import { accountDeletionRefusalOf, fetchAccountDeletionStatus, requestAccountDeletion } from "./accountDeletionApi";
import type {
  AccountDeletionChecklist as Checklist,
  AccountDeletionProof,
  AccountDeletionReauth,
  OthersAgentOnComputer,
  SoleOwnerServer,
} from "./accountDeletionApi";
import { AccountDeletionChecklist } from "./AccountDeletionChecklist";
import { MOVE_AGENT_PARAM } from "./accountDeletionMove";
import { DeleteAccountSignInAgainBanner } from "./DeleteAccountSignInAgainBanner";
import { DeleteAccountVerifyDialog } from "./DeleteAccountVerifyDialog";
import { useStepFailure } from "./deleteAccountFlow";
import type { Outcome } from "./deleteAccountFlow";
import type { FailureCopy } from "../../../components/settings/secondFactorAnswer";

type Phase =
  | { kind: "checklist" }
  | { kind: "verify"; reauth: AccountDeletionReauth };

export function DeleteAccountPage() {
  const describe = useStepFailure();
  const [phase, setPhase] = useState<Phase>({ kind: "checklist" });
  // Each move remounts the verify dialog, even to the same proof (a refused
  // answer starts that step afresh, never stuck busy).
  const [revision, setRevision] = useState(0);
  const [reads, setReads] = useState(0);
  // What the last settled GET answered (`checklist` stays as it was when one fails).
  const [lastRead, setLastRead] = useState<{ checklist: Checklist | null; loaded: boolean }>({ checklist: null, loaded: false });
  const { checklist, loaded } = lastRead;
  const [refusedSoleOwners, setRefusedSoleOwners] = useState<SoleOwnerServer[]>([]);
  // The 409's others' agents, until a read lands after it (an older read is dropped as it lands).
  const [refusedOthersAgents, setRefusedOthersAgents] = useState<OthersAgentOnComputer[] | null>(null);
  // The confirmed force list, sent with every step of this request (the proof dialog's too).
  const forceAgentIds = useRef<readonly string[] | null>(null);
  const [forceConflict, setForceConflict] = useState(false);
  const { formatMessage } = useIntl();
  // Move to Another Computer from another server's row lands here with `?move=<agentId>`.
  const [searchParams, setSearchParams] = useSearchParams();
  const autoMoveAgentId = searchParams.get(MOVE_AGENT_PARAM);
  const clearAutoMove = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(MOVE_AGENT_PARAM);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureCopy>({});
  const [signInAgain, setSignInAgain] = useState(false);
  const reload = useCallback(() => setReads((current) => current + 1), []);

  useEffect(() => {
    let live = true;
    // A failed read leaves the fixed facts; the 409 at submit time still guards.
    fetchAccountDeletionStatus().then((status): Checklist | null => status, () => null).then((status) => {
      if (!live) return;
      setLastRead((previous) => ({ checklist: status ?? previous.checklist, loaded: true }));
      if (status) setRefusedOthersAgents(null);
    });
    return () => { live = false; };
  }, [reads]);

  // Others' agents leave when their owners move them, elsewhere: read again on coming back.
  useEffect(() => {
    const onFocus = () => reload();
    const onVisible = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const moveTo = useCallback((next: Phase) => {
    setPhase(next);
    setRevision((current) => current + 1);
  }, []);

  /** To the proof the server named; sends nothing. */
  const moveToReauth = useCallback((reauth: AccountDeletionReauth) => moveTo({ kind: "verify", reauth }), [moveTo]);
  const backToChecklist = useCallback(() => {
    forceAgentIds.current = null;
    moveTo({ kind: "checklist" });
  }, [moveTo]);

  /** Sends the request. Scheduled: the page says so; the sign-in is already gone, so the socket stops asking. */
  const submit = useCallback(async (proof: AccountDeletionProof): Promise<Outcome> => {
    let scheduledFor: string | null = null;
    try {
      const status = await requestAccountDeletion(proof, forceAgentIds.current ?? undefined);
      scheduledFor = status.status === "scheduled" ? status.scheduledFor : null;
    } catch (err) {
      const refusal = accountDeletionRefusalOf(err);
      const forced = forceAgentIds.current !== null;
      if (refusal?.kind !== "reauth") forceAgentIds.current = null;
      if (refusal?.kind === "sole_owner") {
        setRefusedSoleOwners(refusal.servers);
        moveTo({ kind: "checklist" });
        reload();
        return { kind: "moved" };
      }
      if (refusal?.kind === "others_agents") {
        // Forced: more agents arrived since the dialog; nothing was unbound.
        setForceConflict(forced);
        setRefusedOthersAgents(refusal.agents);
        moveTo({ kind: "checklist" });
        reload();
        return { kind: "moved" };
      }
      if (refusal?.kind === "sign_in_again") return { kind: "sign_in_again" };
      if (refusal?.kind === "reauth") {
        moveToReauth(refusal.reauth);
        return { kind: "moved" };
      }
      return { kind: "failed", err };
    }
    // The confirmation stands in for the whole shell (AccountDeletionGate), so
    // nothing in it keeps asking with the revoked session before OK.
    disconnectSocket();
    markAccountDeletionRequested(scheduledFor);
    return { kind: "moved" };
  }, [moveTo, moveToReauth, reload]);

  const start = useCallback((force: readonly string[] | null) => {
    forceAgentIds.current = force;
    setForceConflict(false);
    setBusy(true);
    setFailure({});
    setSignInAgain(false);
    void submit({}).then((outcome) => {
      setBusy(false);
      const shown = describe(outcome, "password");
      setFailure(shown.failure);
      setSignInAgain(shown.signInAgain);
    });
  }, [describe, submit]);
  const handleDelete = useCallback(() => start(null), [start]);
  const handleForceUnbind = useCallback((agentIds: readonly string[]) => start(agentIds), [start]);

  return (
    <>
      <AccountDeletionChecklist
        checklist={checklist}
        loaded={loaded}
        refusedSoleOwners={refusedSoleOwners}
        refusedOthersAgents={refusedOthersAgents}
        autoMoveAgentId={autoMoveAgentId}
        onAutoMoveHandled={clearAutoMove}
        onReload={reload}
        onDelete={handleDelete}
        onForceUnbind={handleForceUnbind}
        busy={busy}
        notice={(
          <>
            {forceConflict ? (
              <Banner intent="warning" density="sm" data-testid="account-deletion-force-conflict">
                {formatMessage({ id: "accountDeletion.forceConflict" })}
              </Banner>
            ) : null}
            {failure.banner ? <Banner intent="warning" density="sm">{failure.banner}</Banner> : null}
            {signInAgain ? <DeleteAccountSignInAgainBanner /> : null}
          </>
        )}
      />
      {phase.kind === "verify" ? (
        <DeleteAccountVerifyDialog
          key={revision}
          reauth={phase.reauth}
          submit={submit}
          moveToReauth={moveToReauth}
          onClose={backToChecklist}
        />
      ) : null}
    </>
  );
}
