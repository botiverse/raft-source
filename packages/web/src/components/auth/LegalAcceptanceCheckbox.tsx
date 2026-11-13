import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { useCallback } from "react";
import type { ReactNode } from "react";

import { Checkbox, MarkdownLink, TextLinkExternalIcon } from "@botiverse/raft-ui";

export default function LegalAcceptanceCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const handleCheckedChange = useCallback((event: boolean) => {
    onChange(event);
  }, [onChange]);
  return (
    <label className="flex items-start gap-2 text-callout font-semibold text-foreground">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleCheckedChange}
        className="shrink-0"
      />
      <span className="min-w-0">
        {formatMessage(
          { id: "auth.legalAcceptance.agreement" },
          {
            terms: (c: ReactNode) => (
              <MarkdownLink
                key="terms"
                href={CURRENT_LEGAL_ACCEPTANCE.termsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {c}
                <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
              </MarkdownLink>
            ),
            privacy: (c: ReactNode) => (
              <MarkdownLink
                key="privacy"
                href={CURRENT_LEGAL_ACCEPTANCE.privacyUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {c}
                <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
              </MarkdownLink>
            ),
          },
        )}
      </span>
    </label>
  );
}

// The usage-data line is a notice, not something to agree to (cindyz,
// 2026-10-21, after VS Code / GitHub Desktop). cindyz, 2026-11-05: it sits
// directly under the Continue button, not under the agreement. Every form that
// renders LegalAcceptanceCheckbox renders this under its Continue button, and
// points the button at it with aria-describedby so screen readers in forms mode
// still hear it (Tenny).
export function LegalAcceptanceUsageDataNotice({ id }: { id: string }) {
  const { formatMessage } = useIntl();
  return (
    <p id={id} className="text-center text-footnote text-foreground-muted" data-testid="legal-acceptance-usage-data-notice">
      {formatMessage({ id: "auth.legalAcceptance.usageDataNotice" })}
    </p>
  );
}
