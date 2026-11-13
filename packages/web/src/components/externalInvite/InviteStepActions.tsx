import { Button, TextLink } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";

/**
 * The foot of an invite page step: its one primary action, full width, and
 * Back under it as a small link (DS feedback › one primary action per view).
 */
export function InviteStepActions({ label, loadingLabel, onCommit, onBack, busy, disabled = false, testId }: {
  label: string;
  loadingLabel: string;
  onCommit: () => void;
  onBack: () => void;
  busy: boolean;
  disabled?: boolean;
  testId: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <>
      <div className="stack-y-3">
        <Button size="xl" variant="accent" className="w-full" onClick={onCommit} disabled={disabled} loading={busy} loadingLabel={loadingLabel} data-testid={testId}>
          {label}
        </Button>
      </div>
      <div className="mt-3 text-center">
        <TextLink className="text-footnote" onClick={onBack} disabled={busy}>
          {formatMessage({ id: "externalInvite.back" })}
        </TextLink>
      </div>
    </>
  );
}
