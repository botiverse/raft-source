import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import { Check, Copy } from "lucide-react";
import { setClockTimeout } from "@botiverse/raft-shared";
import Tooltip from "../ui/Tooltip";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { migrationSupportRef } from "./presentation";
import type { AgentMigrationNotice } from "./realtime";

/** The reference and its copy button, for a row whose label sits elsewhere. */
export function MigrationReferenceValue({ notice }: { notice: AgentMigrationNotice }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const ref = migrationSupportRef(notice);
  const copy = useCallback(async () => {
    try {
      await copyTextToClipboard(ref);
      setCopied(true);
      setClockTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }, [ref]);
  const handleCopyClick = useCallback(() => {
    void copy();
  }, [copy]);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {/* Plain Space Mono text: a support reference, not a highlighted chip. */}
      <code className="min-w-0 break-all font-mono text-mono-meta text-foreground">{ref}</code>
      <Tooltip content={copied
          ? formatMessage({ id: "agent.migration.referenceCopied" })
          : formatMessage({ id: "agent.migration.referenceCopy" })}>
      <Button variant="ghost" size="icon-md"
        type="button"
        onClick={handleCopyClick}
        className="shrink-0"
        aria-label={copied
          ? formatMessage({ id: "agent.migration.referenceCopied" })
          : formatMessage({ id: "agent.migration.referenceCopyAria" }, { ref })}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </Button>
      </Tooltip>
    </span>
  );
}

export function MigrationReference({ notice }: { notice: AgentMigrationNotice }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption text-foreground-muted">
      <span className="font-semibold">{formatMessage({ id: "agent.migration.referenceLabel" })}</span>
      <MigrationReferenceValue notice={notice} />
    </div>
  );
}
