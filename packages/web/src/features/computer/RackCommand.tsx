import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { CopyableCode, CopyableCodeAction, CopyableCodeRoot } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";

/** A command on one line with its copy button (raft-ui CopyableCode), as on the Computer page. */
export function RackCommand({ command, testId, className }: { command: string; testId: string; className?: string }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);
  return (
    <CopyableCodeRoot copied={copied} onCopy={handleCopy} className={className}>
      <CopyableCode className="min-w-0 flex-1 truncate" data-testid={testId}>{command}</CopyableCode>
      <Tooltip content={formatMessage({ id: "machine.detail.copyCommand" })}>
        <CopyableCodeAction aria-label={formatMessage({ id: "machine.detail.copyCommand" })} className="shrink-0" />
      </Tooltip>
    </CopyableCodeRoot>
  );
}
