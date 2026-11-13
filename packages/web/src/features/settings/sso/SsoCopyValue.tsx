import { CopyableCode, CopyableCodeAction, CopyableCodeRoot } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";

/** One value the other side pastes (a redirect URI, a TXT record), with its label and a copy button. */
export function SsoCopyValue({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className="grid gap-1.5">
      <p className="text-footnote font-semibold text-foreground">{label}</p>
      <CopyableCodeRoot size="sm">
        <CopyableCode truncate data-testid={testId}>{value}</CopyableCode>
        <CopyableCodeAction aria-label={formatMessage({ id: "settings.sso.copyValueAria" }, { label })} />
      </CopyableCodeRoot>
    </div>
  );
}
