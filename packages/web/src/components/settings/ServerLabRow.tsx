import { Switch } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { getServerLabDescriptionMessageId, getServerLabEnrollmentDisabledReasonMessageId, isServerLabEnrollmentEditable } from "../../utils/serverLabsSettings";
import type { ServerLabSettingsAuthority, ServerLabSettingsLab } from "../../utils/serverLabsSettings";

export function ServerLabRow({
  lab,
  authority,
  masterEnabled,
  mutationPending,
  saving,
  onEnrollmentChange,
}: {
  lab: ServerLabSettingsLab;
  authority: ServerLabSettingsAuthority;
  masterEnabled: boolean;
  mutationPending: boolean;
  saving: boolean;
  onEnrollmentChange: (labKey: string, enabled: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const handleCheckedChange = useCallback(
    (enabled: boolean) => onEnrollmentChange(lab.key, enabled),
    [lab.key, onEnrollmentChange],
  );
  const editable = isServerLabEnrollmentEditable(lab, authority, masterEnabled);
  const disabledReasonId = getServerLabEnrollmentDisabledReasonMessageId(lab, authority, masterEnabled);
  const disabledReason = disabledReasonId ? formatMessage({ id: disabledReasonId }) : "";
  const descriptionId = getServerLabDescriptionMessageId(lab.key);
  const description = descriptionId ? formatMessage({ id: descriptionId }) : lab.description;
  const checked = masterEnabled && lab.enrolled;

  return (
    <div
      data-testid="server-lab-row"
      className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-4 py-3 first:pt-0 last:pb-0"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={`min-w-0 truncate text-subhead font-semibold ${editable ? "text-foreground" : "text-foreground-disabled"}`}>{lab.name}</span>
        </div>
        <div className="mt-0.5 text-footnote text-foreground-muted">{description}</div>
        {disabledReason && (
          <div className="mt-1 text-caption text-foreground-hint">{disabledReason}</div>
        )}
      </div>
      {disabledReason ? (
        <Tooltip content={disabledReason}>
          <Switch
            checked={checked}
            disabled={!editable || mutationPending}
            onCheckedChange={handleCheckedChange}
            aria-label={formatMessage({ id: "settings.labs.enrollmentAria" }, { name: lab.name })}
            className="justify-self-end"
            data-slot="switch"
          />
        </Tooltip>
      ) : (
        <Switch
          checked={checked}
          disabled={!editable || mutationPending}
          onCheckedChange={handleCheckedChange}
          aria-label={formatMessage({ id: "settings.labs.enrollmentAria" }, { name: lab.name })}
          className="justify-self-end"
        />
      )}
      {saving && (
        <span className="sr-only">
          {formatMessage({ id: "settings.labs.savingEnrollment" }, { name: lab.name })}
        </span>
      )}
    </div>
  );
}
