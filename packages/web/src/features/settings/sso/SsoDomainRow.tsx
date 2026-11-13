import { Badge, Button } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import type { SsoDomainView } from "./ssoApi";
import { SsoCopyValue } from "./SsoCopyValue";

/**
 * One of the Server's email domains: whether DNS proves it now, when it was
 * last checked and what that check found, and, until it is verified, the TXT
 * record to publish.
 */
export function SsoDomainRow({ domain, verifying, canManage, onVerify, onRequestRemove }: {
  domain: SsoDomainView;
  verifying: boolean;
  canManage: boolean;
  onVerify: (domain: SsoDomainView) => void;
  onRequestRemove: (domain: SsoDomainView) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const handleVerify = useCallback(() => onVerify(domain), [domain, onVerify]);
  const handleRemove = useCallback(() => onRequestRemove(domain), [domain, onRequestRemove]);

  // What the last check found when it did not find the record.
  const failure = domain.lastCheckResult === "absent"
    ? formatMessage({ id: "settings.sso.domainCheckAbsent" })
    : domain.lastCheckResult === "lookup_failed"
      ? formatMessage({ id: "settings.sso.domainCheckLookupFailed" })
      : null;

  return (
    <div className="stack-y-3 py-3" data-testid={`sso-domain-${domain.domain}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-subhead font-semibold text-foreground break-all">{domain.domain}</span>
            {domain.verified ? (
              <Badge appearance="soft" variant="success">{formatMessage({ id: "settings.sso.domainVerified" })}</Badge>
            ) : (
              <Badge appearance="soft" variant="warning">{formatMessage({ id: "settings.sso.domainUnverified" })}</Badge>
            )}
          </div>
          <p className="mt-1 text-footnote text-foreground-muted">
            {domain.lastCheckedAt
              ? formatMessage({ id: "settings.sso.domainLastChecked" }, { when: formatShortDateTime(domain.lastCheckedAt) })
              : formatMessage({ id: "settings.sso.domainNeverChecked" })}
          </p>
          {failure && <p className="mt-0.5 text-footnote text-warning-strong">{failure}</p>}
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline" size="md"
              type="button"
              onClick={handleVerify}
              loading={verifying}
              loadingLabel={formatMessage({ id: "settings.sso.domainChecking" })}
              data-testid={`sso-domain-verify-${domain.domain}`}
            >
              {domain.verified
                ? formatMessage({ id: "settings.sso.domainCheckAgain" })
                : formatMessage({ id: "settings.sso.domainVerify" })}
            </Button>
            <Button
              variant="ghost" size="md"
              type="button"
              onClick={handleRemove}
              data-testid={`sso-domain-remove-${domain.domain}`}
            >
              {formatMessage({ id: "settings.sso.domainRemove" })}
            </Button>
          </div>
        )}
      </div>
      {!domain.verified && (
        <div className="stack-y-3 rounded-container border border-line-hairline bg-layer-canvas p-3">
          <p className="text-footnote text-foreground-muted">
            {formatMessage({ id: "settings.sso.domainRecordInstructions" }, { type: domain.record.type })}
          </p>
          <SsoCopyValue label={formatMessage({ id: "settings.sso.domainRecordName" })} value={domain.record.name} />
          <SsoCopyValue label={formatMessage({ id: "settings.sso.domainRecordValue" })} value={domain.record.value} />
        </div>
      )}
    </div>
  );
}
