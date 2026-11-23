import { Button, TextLink } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import Banner from "../../components/ui/Banner";
import { DialogCardFooter, DialogCommit } from "../../components/ui/NarrowDialog";
import { DeviceLoginRequestDetails } from "../../components/auth/DeviceLoginRequestDetails";
import { StepUpBeforeApproval } from "../../components/auth/SecondFactorCodeEntry";
import { deviceLoginApproveLabel } from "../../components/auth/deviceLoginApproval";
import { codeErrorOffersDevicePage, codeTargetServer } from "./addComputerCode";
import type { AddComputerCode } from "./useAddComputerCode";

/**
 * Add Computer's confirm screen for a typed code: the device login page's
 * (DeviceLoginRequestDetails: the warning, the computer by the name it gave,
 * its hostname and OS, when and from where), for the server this window is
 * for and no other, so there is nothing to pick: the Server row says which,
 * and pressing Add to server is the consent. A code for anything else (a
 * sign-in, an agent key, a server the person can't add computers to) is not
 * approved here: it says so and offers the device login page, where the code
 * is typed again (never carried in its address). Two-step verification, when
 * the approval asks for it, steps up here and then approves the same request.
 * A request that came through the window's pairing (useComputerPairing: the
 * command was run, no code typed) gets the same screen, without Enter a
 * different code: there was none.
 */
export function AddComputerCodeReview({ entry, serverId, onOpenDevicePage }: {
  entry: AddComputerCode;
  serverId: string | null;
  onOpenDevicePage: () => void;
}) {
  const { formatMessage } = useIntl();
  const { approval, differentCode } = entry;
  const { step, submitting, error, errorCode, approve, deny, steppedUp, cancelStepUp } = approval;
  const paired = (step.kind === "confirm" || step.kind === "stepUp") && step.request.pairingId !== undefined;
  const target = step.kind === "confirm" ? codeTargetServer(step.request, serverId) : null;
  const targetId = target?.id ?? null;
  const handleApprove = useCallback(() => {
    if (targetId) approve(targetId);
  }, [approve, targetId]);

  const backButton = paired ? null : (
    <Button size="lg" variant="ghost" type="button" onClick={differentCode} disabled={submitting !== null}>
      {formatMessage({ id: "pages.deviceLogin.differentCode" })}
    </Button>
  );

  if (step.kind === "stepUp") {
    return (
      <div data-testid="add-machine-code-step-up">
        <StepUpBeforeApproval
          notice={formatMessage({ id: "pages.deviceLogin.stepUpNotice" })}
          methods={step.methods}
          onVerified={steppedUp}
        />
        <DialogCardFooter>
          {backButton ?? (
            <Button size="lg" variant="ghost" type="button" onClick={cancelStepUp}>
              {formatMessage({ id: "common.announcement.back" })}
            </Button>
          )}
        </DialogCardFooter>
      </div>
    );
  }
  if (step.kind !== "confirm") return null;

  const { request } = step;
  if (!target) {
    const grant = request.grant;
    const forComputer = grant?.kind === "computer_attach" || grant?.kind === "computer_migrate";
    return (
      <div data-testid="add-machine-code-elsewhere">
        <Banner intent="info" withIcon className="mb-4">
          {formatMessage({ id: forComputer ? "machine.add.code.otherServer" : "machine.add.code.notForComputer" })}
          {" "}
          <TextLink variant="strong" onClick={onOpenDevicePage}>
            {formatMessage({ id: "machine.add.code.openDevicePage" })}
          </TextLink>
        </Banner>
        <DialogCardFooter>{backButton}</DialogCardFooter>
      </div>
    );
  }

  return (
    <div data-testid="add-machine-code-confirm">
      <DeviceLoginRequestDetails
        request={request}
        extraFacts={(
          <div>
            <dt className="text-caption text-foreground-hint">{formatMessage({ id: "pages.deviceLogin.serverPickerLabel" })}</dt>
            <dd>
              {target.name} <span className="font-mono text-foreground-muted">/{target.slug}</span>
            </dd>
          </div>
        )}
      />
      {error ? (
        <Banner intent="warning" className="mb-4">
          {error}
          {codeErrorOffersDevicePage(errorCode) ? (
            <>
              {" "}
              <TextLink variant="strong" onClick={onOpenDevicePage}>
                {formatMessage({ id: "machine.add.code.openDevicePage" })}
              </TextLink>
            </>
          ) : null}
        </Banner>
      ) : null}
      <DialogCardFooter>
        {backButton}
        <Button size="lg" variant="outline" type="button" onClick={deny} disabled={submitting !== null}>
          {formatMessage({ id: submitting === "deny" ? "pages.deviceLogin.denying" : "pages.deviceLogin.deny" })}
        </Button>
        <DialogCommit>
          {(inHead) => (
            <Button
              size={inHead ? "md" : "lg"}
              variant="primary"
              type="button"
              onClick={handleApprove}
              disabled={submitting !== null}
            >
              {deviceLoginApproveLabel(formatMessage, request.grant, submitting === "approve")}
            </Button>
          )}
        </DialogCommit>
      </DialogCardFooter>
    </div>
  );
}
