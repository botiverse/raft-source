import { DialogDescription, RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";

import { CancelButton, CommitButton, StepDialog } from "../../../components/settings/TwoStepVerificationSection";
import Banner from "../../../components/ui/Banner";
import type { MessageId } from "../../../i18n/messages/en";
import type { LostDeviceReach, MySessionRevokeReason } from "./mySessionsApi";

const COPY = {
  one: {
    signOutBody: "settings.account.signedInDevices.choiceSignOutBody",
    signOutHint: "settings.account.signedInDevices.choiceSignOutHint",
    lost: "settings.account.signedInDevices.choiceLost",
    lostBoth: "settings.account.signedInDevices.choiceLostBody",
    lostComputers: "settings.account.signedInDevices.choiceLostBodyComputers",
    lostKeys: "settings.account.signedInDevices.choiceLostBodyKeys",
    single: "settings.account.signedInDevices.singleBody",
  },
  others: {
    signOutBody: "settings.account.signedInDevices.choiceSignOutAllBody",
    signOutHint: "settings.account.signedInDevices.choiceSignOutAllHint",
    lost: "settings.account.signedInDevices.choiceLostAll",
    lostBoth: "settings.account.signedInDevices.choiceLostAllBody",
    lostComputers: "settings.account.signedInDevices.choiceLostAllBodyComputers",
    lostKeys: "settings.account.signedInDevices.choiceLostAllBodyKeys",
    single: "settings.account.signedInDevices.singleAllBody",
  },
} as const satisfies Record<"one" | "others", Record<string, MessageId>>;

const LEFTOVERS_COPY = {
  lostBoth: "settings.account.signedInDevices.leftoversBody",
  lostComputers: "settings.account.signedInDevices.leftoversBodyComputers",
  lostKeys: "settings.account.signedInDevices.leftoversBodyKeys",
} as const satisfies Record<string, MessageId>;

function lostBodyId(copy: { lostBoth: MessageId; lostComputers: MessageId; lostKeys: MessageId }, reach: LostDeviceReach): MessageId {
  if (reach.computers > 0 && reach.agentKeys > 0) return copy.lostBoth;
  return reach.computers > 0 ? copy.lostComputers : copy.lostKeys;
}

/**
 * Sign out one other sign-in (`scope="one"`) or all of them (`"others"`).
 * Two answers when signing out would leave something it approved working
 * (`reach`): Sign out (`sign_out`, the default: the least it changes) or I
 * no longer have it (`lost_device`, which says how many Computers and agent
 * keys go too). With nothing to disconnect it is one question, Sign out.
 * `"leftovers"`: no other sign-in is listed, but ones signed out earlier
 * still have Computers or agent keys working: one question that only
 * disconnects them (`lost_device`, red), never a `sign_out`.
 *
 * `onCommit` sends the choice, the proof it asks for included; a thrown
 * Error's message shows in the dialog, which stays open.
 */
export function SignOutDeviceDialog({ scope, title, summary, reach, onCommit, onClose }: {
  scope: "one" | "others" | "leftovers";
  title: string;
  /** Which sign-in this is: when it signed in, when it was last active. */
  summary?: string;
  reach: LostDeviceReach;
  onCommit: (reason: MySessionRevokeReason) => Promise<void>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const leftovers = scope === "leftovers";
  const copy = COPY[scope === "one" ? "one" : "others"];
  const choice = !leftovers && (reach.computers > 0 || reach.agentKeys > 0);
  const [reason, setReason] = useState<MySessionRevokeReason>("sign_out");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const groupLabelId = useId();

  const handleReasonChange = useCallback((value: unknown) => {
    if (value === "sign_out" || value === "lost_device") setReason(value);
  }, []);

  const submit = useCallback(async () => {
    setBusy(true);
    setFailure("");
    try {
      await onCommit(leftovers ? "lost_device" : choice ? reason : "sign_out");
    } catch (err) {
      setFailure(err instanceof Error && err.message ? err.message : formatMessage({ id: "settings.account.signedInDevices.failed" }));
    } finally {
      setBusy(false);
    }
  }, [choice, formatMessage, leftovers, onCommit, reason]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  const lost = leftovers || (choice && reason === "lost_device");
  const confirmId: MessageId = leftovers
    ? "settings.account.signedInDevices.confirmDisconnect"
    : lost ? "settings.account.signedInDevices.confirmLost" : "settings.account.signedInDevices.confirmSignOut";
  return (
    <StepDialog
      title={title}
      narrow="centered"
      size="md"
      busy={busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="sign-out-device-dialog"
      footer={(
        <>
          <CancelButton busy={busy} onClose={onClose} />
          <CommitButton
            label={formatMessage({ id: confirmId })}
            busy={busy}
            variant={lost ? "danger" : "warning"}
            testId="sign-out-device-confirm"
          />
        </>
      )}
    >
      {leftovers ? (
        <DialogDescription data-testid="sign-out-device-lost-reach">
          {formatMessage({ id: lostBodyId(LEFTOVERS_COPY, reach) }, { computers: reach.computers, agentKeys: reach.agentKeys })}
        </DialogDescription>
      ) : choice ? (
        <>
          {summary ? <DialogDescription>{summary}</DialogDescription> : null}
        <RadioGroup
          value={reason}
          onValueChange={handleReasonChange}
          aria-labelledby={groupLabelId}
          disabled={busy}
          className="gap-2"
          data-testid="sign-out-device-reasons"
        >
          <span id={groupLabelId} className="sr-only">{formatMessage({ id: "settings.account.signedInDevices.choiceLabel" })}</span>
          <label className="flex min-h-11 items-start gap-2 py-1">
            <RadioGroupItem value="sign_out" className="shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-subhead font-semibold text-foreground">{formatMessage({ id: "settings.account.signedInDevices.choiceSignOut" })}</span>
              <span className="text-footnote text-foreground-muted">{formatMessage({ id: copy.signOutBody })}</span>
              <span className="text-footnote text-foreground-muted">{formatMessage({ id: copy.signOutHint })}</span>
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-2 py-1">
            <RadioGroupItem value="lost_device" className="shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-subhead font-semibold text-foreground">{formatMessage({ id: copy.lost })}</span>
              <span className="text-footnote text-foreground-muted" data-testid="sign-out-device-lost-reach">
                {formatMessage({ id: lostBodyId(copy, reach) }, { computers: reach.computers, agentKeys: reach.agentKeys })}
              </span>
            </span>
          </label>
        </RadioGroup>
        </>
      ) : (
        <DialogDescription>
          {summary ? <span className="mb-2 block">{summary}</span> : null}
          <span className="block">{formatMessage({ id: copy.single })}</span>
        </DialogDescription>
      )}
      {failure ? <Banner intent="warning" density="sm">{failure}</Banner> : null}
    </StepDialog>
  );
}
