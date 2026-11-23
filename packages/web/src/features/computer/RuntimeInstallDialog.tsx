import { CodeBlock, CodeBlockBody, CodeBlockPre, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../components/ConfirmDialog";
import { opensInNewTabAriaLabel } from "../../components/ui/LeavingRaftMark";
import { runtimeInstallUnsupportedCopyId } from "./runtimeInstallCopy";
import type { RuntimeInstallManualPlan, RuntimeInstallRunnablePlan } from "./runtimeInstallCopy";

/**
 * Install's confirmation (docs/contracts/runtime-auth.md §6e): before
 * anything runs, the person reads the exact commands the Computer would run
 * (OAR's plan, as the vendor documents them) and the vendor's page, then
 * presses Install or Cancel. Where OAR will not run them here (it needs
 * administrator rights, a missing tool, an unknown location), the same
 * steps are shown for the person to run on the Computer themselves, with
 * no Install. Raft DS Dialog (ConfirmDialog) with a raft-ui CodeBlock: the
 * confirm is pink (`primary`, it does a thing), never red.
 */
export function RuntimeInstallDialog({
  runtimeId,
  machineName,
  plan,
  onConfirm,
  onClose,
}: {
  /** The Raft runtime the chip names, for its name. */
  runtimeId: string;
  machineName: string;
  plan: RuntimeInstallRunnablePlan | RuntimeInstallManualPlan;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const runtime = getRuntimeDisplayName(runtimeId);
  const manual = plan.kind === "unsupported";
  const sourceLabel = formatMessage({ id: "machine.runtimeInstall.source" });
  return (
    <ConfirmDialog
      title={formatMessage({ id: manual ? "machine.runtimeInstall.manual.title" : "machine.runtimeInstall.confirm.title" }, { runtime })}
      plainMessage
      message={(
        <div className="grid gap-3 text-subhead text-foreground-muted" data-testid="runtime-install-dialog">
          <p>
            {manual
              ? formatMessage({ id: runtimeInstallUnsupportedCopyId(plan.reason) }, { runtime })
              : formatMessage({ id: "machine.runtimeInstall.confirm.description" }, { runtime, computer: machineName })}
          </p>
          {manual && plan.detail ? <p data-testid="runtime-install-detail">{plan.detail}</p> : null}
          {manual ? <p>{formatMessage({ id: "machine.runtimeInstall.manual.steps" }, { computer: machineName })}</p> : null}
          <CodeBlock className="flex min-w-0 max-w-full flex-col">
            <CodeBlockBody>
              <CodeBlockPre className="whitespace-pre-wrap wrap-break-word" data-testid="runtime-install-steps">
                {plan.steps.join("\n")}
              </CodeBlockPre>
            </CodeBlockBody>
          </CodeBlock>
          {plan.source ? (
            <span className="text-footnote">
              <TextLink
                render={<a href={plan.source} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, sourceLabel)} />}
                data-testid="runtime-install-source"
              >
                {sourceLabel}
                <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
              </TextLink>
            </span>
          ) : null}
        </div>
      )}
      confirmLabel={formatMessage({ id: manual ? "machine.runtimeInstall.manual.close" : "machine.runtimeInstall.action" })}
      confirmVariant={manual ? "outline" : "primary"}
      confirmTestId="runtime-install-confirm"
      hideCancel={manual}
      maxWidthClass="max-w-md"
      onConfirm={manual ? onClose : onConfirm}
      onClose={onClose}
    />
  );
}
