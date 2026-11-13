import { Card } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import SectionEyebrow from "../../../components/ui/SectionEyebrow";
import { OAuthScopeList } from "./OAuthScopeList";

export function OAuthScopeSummaryPanel({
  title,
  description,
  scopes,
  compact = true,
  defaultToDeclared = true,
  defaultOpen = false,
}: {
  title: string;
  description?: string;
  scopes: readonly string[] | null | undefined;
  compact?: boolean;
  defaultToDeclared?: boolean;
  defaultOpen?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="stack-y-2">
      <SectionEyebrow as="div">{title}</SectionEyebrow>
      {description && <div className="mt-2 text-footnote text-foreground-muted">{description}</div>}
      <Card render={<details open={defaultOpen} />} className="block px-3 py-2">
        <summary className="text-footnote font-semibold text-foreground">{formatMessage({ id: "settings.connectedApps.detail.declaredAccess" })}</summary>
        <div className="mt-2">
          <OAuthScopeList scopes={scopes} compact={compact} defaultToDeclared={defaultToDeclared} />
        </div>
      </Card>
    </div>
  );
}
