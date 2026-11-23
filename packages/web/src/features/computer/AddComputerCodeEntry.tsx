import { Button, Input, TextLink } from "@botiverse/raft-ui";
import { CircleCheck } from "lucide-react";
import { useIntl } from "react-intl";
import Banner from "../../components/ui/Banner";
import FormField from "../../components/ui/FormField";
import { normalizeUserCode } from "../../components/auth/deviceLoginApproval";
import { codeErrorOffersDevicePage } from "./addComputerCode";
import type { AddComputerCode } from "./useAddComputerCode";

/**
 * Under Add Computer's command: "The terminal shows a code? Enter it here."
 * Run over SSH (or anywhere without a browser), `raft-computer setup` shows a
 * code to approve; typing it here opens the device login page's confirm
 * screen in this window (AddComputerCodeReview). Closed until asked for, as
 * the guide's "Already have Raft Computer" is: most people never see a code.
 * Once approved, says so; the dialog keeps waiting for the computer.
 */
export function AddComputerCodeEntry({ entry, serverName, onOpenDevicePage }: {
  entry: AddComputerCode;
  serverName: string;
  onOpenDevicePage: () => void;
}) {
  const { formatMessage } = useIntl();
  const { approval, open, toggle, code, changeCode, submit, differentCode } = entry;
  const { step, submitting, error, errorCode } = approval;

  if (step.kind === "approved") {
    const outcome = step.outcome;
    const migrate = outcome?.kind === "computer_migrate";
    const machine = outcome?.requesterName ?? null;
    const server = outcome?.pickedName ?? serverName;
    return (
      <Banner
        intent="success"
        className="mb-4"
        icon={<CircleCheck size={20} aria-hidden="true" />}
        title={formatMessage({ id: migrate ? "pages.deviceLogin.migrateApprovedTitle" : "pages.deviceLogin.attachApprovedTitle" })}
        data-testid="add-machine-code-approved"
      >
        {migrate
          ? (machine
            ? formatMessage({ id: "machine.add.code.migrateApproved" }, { machine, server })
            : formatMessage({ id: "machine.add.code.migrateApprovedUnnamed" }, { server }))
          : (machine
            ? formatMessage({ id: "machine.add.code.attachApproved" }, { machine, server })
            : formatMessage({ id: "machine.add.code.attachApprovedUnnamed" }, { server }))}
      </Banner>
    );
  }

  if (step.kind === "denied") {
    return (
      <div className="mb-4" data-testid="add-machine-code-denied">
        <Banner intent="info" className="mb-2">
          {formatMessage({ id: "machine.add.code.denied" }, { server: serverName })}
        </Banner>
        <TextLink onClick={differentCode} className="text-footnote">
          {formatMessage({ id: "pages.deviceLogin.differentCode" })}
        </TextLink>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <TextLink
        aria-expanded={open}
        onClick={toggle}
        className="text-footnote"
        data-testid="add-machine-code-toggle"
      >
        {formatMessage({ id: "machine.add.code.toggle" })}
      </TextLink>
      {/* A request the window's pairing showed, refused on approve: why, with the field closed. */}
      {!open && error ? <Banner intent="warning" className="mt-2">{error}</Banner> : null}
      {open ? (
        // A section that submits on its own: its button under its field, at
        // the start (DS › Forms), outline beside the dialog's own Done.
        <form onSubmit={submit} className="stack-y-3 mt-2" data-testid="add-machine-code-entry">
          <FormField
            label={formatMessage({ id: "machine.add.code.label" })}
            hint={formatMessage({ id: "machine.add.code.hint" })}
          >
            {/* A device code is machine text: Space Mono, as on the device login page. */}
            <Input
              type="text"
              value={code}
              onChange={changeCode}
              placeholder={formatMessage({ id: "pages.deviceLogin.codePlaceholder" })}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              className="w-full font-mono"
            />
          </FormField>
          {error ? (
            <Banner intent="warning">
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
          <div>
            <Button
              type="submit"
              size="lg"
              variant="outline"
              disabled={submitting !== null || !normalizeUserCode(code)}
            >
              {formatMessage({ id: submitting === "describe" ? "pages.deviceLogin.checking" : "pages.deviceLogin.continue" })}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
