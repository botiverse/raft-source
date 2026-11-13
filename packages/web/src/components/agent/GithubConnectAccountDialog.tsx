import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";
import { Info } from "lucide-react";
import { InlineCode, RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import ConfirmDialog from "../ConfirmDialog";

const ACCESS_OPTIONS = [
  { value: "public", labelId: "agent.detail.connections.accessPublic", descId: "agent.detail.connections.accessPublicDesc", scope: "public_repo" },
  { value: "private", labelId: "agent.detail.connections.accessPrivate", descId: "agent.detail.connections.accessPrivateDesc", scope: "repo" },
] as const;

/** One access choice: named by its title, described (not named) by its scope line. */
function AccessOption({ option }: { option: (typeof ACCESS_OPTIONS)[number] }) {
  const { formatMessage } = useIntl();
  const id = useId();
  return (
    <label className="flex min-h-11 items-start gap-3 py-2">
      <RadioGroupItem
        value={option.value}
        className="mt-0.5 shrink-0"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-desc`}
        data-testid={`agent-connection-access-${option.value}`}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span id={`${id}-label`} className="text-callout font-semibold text-foreground">{formatMessage({ id: option.labelId })}</span>
        <span id={`${id}-desc`} className="text-footnote font-normal text-foreground-muted">
          {formatMessage({ id: option.descId })} <InlineCode>{option.scope}</InlineCode>
        </span>
      </span>
    </label>
  );
}

/**
 * "Connect New Account": pick the repository access (GitHub's `public_repo` or
 * `repo` scope), then leave for GitHub. Also the Reconnect path; a new
 * connection is the only way to replace refused credentials today.
 */
export function ConnectAccountDialog({
  agentName,
  title,
  initialAccess = "public",
  onContinue,
  onClose,
}: {
  /** Null where the agent's name is not at hand (the callback page). */
  agentName: string | null;
  title: string;
  initialAccess?: "public" | "private";
  /** Resolves true when the browser is leaving for GitHub. */
  onContinue: (access: "public" | "private") => Promise<boolean>;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [access, setAccess] = useState<"public" | "private">(initialAccess);
  // Stays disabled from a successful start until the page is gone: no second start.
  const [leaving, setLeaving] = useState(false);

  const handleAccessChange = useCallback((value: unknown) => {
    if (value === "public" || value === "private") setAccess(value);
  }, []);

  const handleContinue = useCallback(async () => {
    if (await onContinue(access)) setLeaving(true);
  }, [onContinue, access]);

  return (
    <ConfirmDialog
      title={title}
      maxWidthClass="max-w-md"
      plainMessage
      message={(
        <div className="stack-y-3" data-testid="agent-connection-connect-dialog">
          <p className="text-callout font-normal text-foreground-muted">
            {agentName
              ? formatMessage({ id: "agent.detail.connections.connectLead" }, { agent: agentName })
              : formatMessage({ id: "agent.detail.connections.connectLeadNoAgent" })}
          </p>
          <RadioGroup
            value={access}
            onValueChange={handleAccessChange}
            aria-label={formatMessage({ id: "agent.detail.connections.accessLabel" })}
            className="gap-0"
          >
            {ACCESS_OPTIONS.map((option) => (
              <AccessOption key={option.value} option={option} />
            ))}
          </RadioGroup>
          <p className="flex items-start gap-1.5 text-footnote font-normal text-foreground-hint">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {formatMessage({ id: "agent.detail.connections.tokenNote" })}
          </p>
        </div>
      )}
      confirmLabel={formatMessage({ id: "agent.detail.connections.continue" })}
      confirmVariant="primary"
      confirmDisabled={leaving}
      confirmTestId="agent-connection-connect-continue"
      closeOnConfirm={false}
      onConfirm={handleContinue}
      onClose={onClose}
    />
  );
}
